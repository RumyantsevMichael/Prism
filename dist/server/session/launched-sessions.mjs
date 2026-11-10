import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLock } from "../workflow/artifact-store.mjs";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { listInitiatives } from "../workflow/record-store.mjs";
import { readRoadmap } from "../workflow/roadmap.mjs";
import { hostAvailability, hostDefinition, hostEnvironment, resolveHost, validHostSessionId } from "./launch-hosts.mjs";
import { stopGraceMs } from "./process-tree.mjs";
import {
  LAUNCH_ID_PATTERN,
  LaunchError,
  SUPERVISION_LOST,
  createLaunchFolder,
  expired,
  lastRunStatus,
  launchFolder,
  launchRunning,
  launchView,
  launchesDirectory,
  listLaunchRecords,
  newLaunchId,
  readStopRequest,
  prepareLaunchesDirectory,
  readLaunchRecord,
  removeLaunchFolder,
  storeLocation,
  voidToken,
  withRunStartLock,
  writeLaunchRecord,
  writeStopRequest
} from "./launch-records.mjs";

// Starting, listing, resuming, and stopping launched sessions: headless host sessions that Prism runs for one initiative on this machine.
// Each run runs under a detached supervisor, so the session outlives the process that started it.

export { hostAvailability, LaunchError };

const SUPERVISOR = fileURLToPath(new URL("./launch-supervisor.mjs", import.meta.url));
const START_TIMEOUT_MS = 15000;
const LOCK_TIMEOUT_MS = 30000;
const POLL_MS = 25;
const FIRST_OUTPUT_WAIT_MS = 5000;
// A stop resolves at most this long after the grace period, once the run's end is recorded.
const STOP_SETTLE_MS = 5000;

const refuse = (code, message) => new LaunchError(code, message);
const runningMessage = (initiative) => `A launched session of ${initiative} is running on this machine.`;

async function initiativeExists(projectRoot, initiative) {
  if (typeof initiative !== "string" || !SLUG_PATTERN.test(initiative)) return false;
  const { loaded } = await readRoadmap(projectRoot).catch(() => ({ loaded: null }));
  if (Array.isArray(loaded?.record?.initiatives) && loaded.record.initiatives.some((item) => item?.id === initiative)) return true;
  const recorded = await listInitiatives(projectRoot).catch(() => []);
  return recorded.includes(initiative);
}

// Serializes every start and resume of this machine's launches, so two requests never both pass the running check.
async function withLaunchLock(env, action) {
  await prepareLaunchesDirectory(env);
  return withFileLock(path.join(launchesDirectory(env), "launches"), action, (code, message) => refuse(code === "lock_timeout" ? "launch_failed" : code, message), { timeoutMs: LOCK_TIMEOUT_MS });
}

async function otherRunning(env, { initiative, store, except = null }) {
  const now = Date.now();
  for (const { record } of await listLaunchRecords(env)) {
    if (!record || record.id === except) continue;
    if (record.initiative === initiative && record.store === store && launchRunning(record, now)) return true;
  }
  return false;
}

// Starts the supervisor of the next run and waits until it has started the host or reported why it could not.
async function startRun({ folder, record, env, cause }) {
  const token = randomBytes(8).toString("hex");
  const supervisor = spawn(process.execPath, [SUPERVISOR, folder, cause, token], {
    cwd: record.checkout,
    env: hostEnvironment(env, record.id),
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  let gone = null;
  supervisor.once("error", (error) => { gone = `the supervisor could not be started: ${error.message}`; });
  supervisor.once("exit", (code, signal) => { gone = `the supervisor ended with ${signal ?? `exit code ${code}`} before the host started`; });
  supervisor.unref();
  // The view as of the host's start, so a run that already ended still answers as the running session it was.
  const startedView = (current, run) => {
    const started = { ...current, runs: current.runs.map((entry) => (entry === run ? { ...entry, endedAt: null, exit: null, heartbeatAt: run.startedAt, supervisorPid: process.pid } : entry)) };
    return launchView(started, { now: Date.parse(run.startedAt) });
  };
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await readLaunchRecord(folder);
    const run = current?.runs.find((entry) => entry.token === token);
    // The host counts as started once it has written its first output or ended, or a few seconds after its process started.
    if (run && (run.outputAt || run.endedAt || Date.now() - Date.parse(run.startedAt) >= FIRST_OUTPUT_WAIT_MS)) return startedView(current, run);
    if (current?.startFailure?.token === token) throw refuse("launch_failed", current.startFailure.message);
    if (gone) {
      const last = await readLaunchRecord(folder);
      if (last?.startFailure?.token === token) throw refuse("launch_failed", last.startFailure.message);
      if (!last?.runs.some((entry) => entry.token === token)) throw refuse("launch_failed", `${hostDefinition(record.host).label} could not be started: ${gone}.`);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  // Giving up voids the token under the lock that the supervisor holds while it starts the host, so a late supervisor starts none;
  // a host it started before that still counts as started.
  const late = await withRunStartLock(folder, async () => {
    const current = await readLaunchRecord(folder);
    const run = current?.runs.find((entry) => entry.token === token);
    if (run) return startedView(current, run);
    if (current) {
      voidToken(current, token);
      await writeLaunchRecord(folder, current);
    }
    return null;
  }).catch(() => null);
  if (late) return late;
  if (!gone && supervisor.pid) {
    try { process.kill(supervisor.pid, "SIGTERM"); } catch {}
  }
  throw refuse("launch_failed", `${hostDefinition(record.host).label} could not be started: the supervisor did not start it within ${START_TIMEOUT_MS / 1000} seconds.`);
}

/** Starts a launched session's first run: { launch }, its view in state running. */
export async function startLaunch({ projectRoot, initiative, host, env = process.env }) {
  const definition = hostDefinition(host);
  if (!definition) throw refuse("unknown_host", `Prism cannot launch ${String(host)}: the hosts are claude-code and codex.`);
  const checkout = await realpath(projectRoot);
  if (!(await initiativeExists(checkout, initiative))) throw refuse("unknown_initiative", `No initiative ${String(initiative)} exists in this checkout.`);
  const resolved = await resolveHost(host, env);
  if (!resolved.available) throw refuse("host_unavailable", resolved.reason);
  const store = await storeLocation(checkout);
  return withLaunchLock(env, async () => {
    if (await otherRunning(env, { initiative, store })) throw refuse("launch_running", runningMessage(initiative));
    const id = newLaunchId();
    const folder = await createLaunchFolder(env, id);
    const record = {
      id,
      initiative,
      host,
      checkout,
      store,
      createdAt: new Date().toISOString(),
      hostSessionId: host === "claude-code" ? randomUUID() : null,
      runs: []
    };
    await writeLaunchRecord(folder, record);
    try {
      return { launch: await startRun({ folder, record, env, cause: "launch" }) };
    } catch (error) {
      await removeLaunchFolder(folder);
      throw error;
    }
  });
}

/** Starts the next run of a launched session with the resume arguments, and answers its view in state running. */
export async function resumeLaunch({ id, env = process.env, cause = "person" }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) throw refuse("unknown_launch", `No launched session ${String(id)} exists on this machine.`);
  const folder = launchFolder(env, id);
  if (!(await readLaunchRecord(folder))) throw refuse("unknown_launch", `No launched session ${id} exists on this machine.`);
  return withLaunchLock(env, async () => {
    const record = await readLaunchRecord(folder);
    if (!record) throw refuse("unknown_launch", `No launched session ${id} exists on this machine.`);
    if (launchRunning(record)) throw refuse("launch_running", "The session is running.");
    if (await otherRunning(env, { initiative: record.initiative, store: record.store, except: id })) throw refuse("launch_running", runningMessage(record.initiative));
    if (!validHostSessionId(record.hostSessionId)) throw refuse("no_host_session", "The session never reported its host session id, so it cannot be resumed.");
    const resolved = await resolveHost(record.host, env);
    if (!resolved?.available) throw refuse("host_unavailable", resolved?.reason ?? `Unknown host ${record.host}.`);
    return startRun({ folder, record, env, cause: cause === "gate" ? "gate" : "person" });
  });
}

// A run whose host ended on its own after the stop request was written, before its supervisor read it, still ended after a stop request:
// the request's time is recorded in the run, so every view shows it stopped. The supervisor writes nothing more once it recorded the end.
async function markStopped(env, folder, token) {
  return withLaunchLock(env, async () => {
    const record = await readLaunchRecord(folder);
    const run = record?.runs.find((entry) => entry.token === token);
    if (!run?.endedAt) return null;
    if (run.stopRequestedAt) return record;
    const request = await readStopRequest(folder);
    if (request?.token !== token) return record;
    const at = Date.parse(request.requestedAt ?? "");
    run.stopRequestedAt = new Date(Number.isFinite(at) ? at : Date.now()).toISOString();
    await writeLaunchRecord(folder, record);
    return record;
  });
}

/**
 * Asks a launched session's supervisor to stop through its launch folder, so any process on this machine can ask,
 * and answers the launch view in state stopped once the supervisor has recorded the run's end.
 */
export async function stopLaunch({ id, env = process.env }) {
  const unknown = () => refuse("unknown_launch", `No launched session ${String(id)} exists on this machine.`);
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) throw unknown();
  const folder = launchFolder(env, id);
  if (!(await readLaunchRecord(folder))) throw unknown();
  const run = await withLaunchLock(env, async () => {
    const record = await readLaunchRecord(folder);
    if (!record) throw unknown();
    const status = lastRunStatus(record);
    if (status === "lost") throw refuse("supervision_lost", SUPERVISION_LOST);
    if (status !== "running") throw refuse("launch_not_running", "The session is not running.");
    const last = record.runs.at(-1);
    if ((await readStopRequest(folder))?.token !== last.token) await writeStopRequest(folder, last.token);
    return last;
  });
  const grace = Number.isSafeInteger(run.stopGraceMs) && run.stopGraceMs >= 0 ? run.stopGraceMs : stopGraceMs(env);
  const deadline = Date.now() + grace + STOP_SETTLE_MS;
  for (;;) {
    const record = await readLaunchRecord(folder);
    if (!record) throw unknown();
    const current = record.runs.find((entry) => entry.token === run.token);
    if (current?.endedAt) return launchView(current.stopRequestedAt ? record : await markStopped(env, folder, run.token) ?? record);
    if (lastRunStatus(record) === "lost") throw refuse("supervision_lost", SUPERVISION_LOST);
    if (Date.now() >= deadline) throw refuse("stop_timeout", `The session did not stop within ${Math.ceil((grace + STOP_SETTLE_MS) / 1000)} seconds; its supervisor keeps ending it.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
  }
}

/** Every launched session of this machine whose checkout shares the record store of projectRoot, the most recently launched first. */
export async function listLaunches({ projectRoot, env = process.env, now = Date.now() }) {
  const at = typeof now === "number" ? now : Date.parse(now);
  const store = await storeLocation(await realpath(projectRoot));
  const launches = [];
  const candidates = [];
  for (const { folder, record } of await listLaunchRecords(env)) {
    if (!record) continue;
    if (expired(record, at)) {
      candidates.push({ folder, record });
      continue;
    }
    if (record.store !== store || !record.runs.length) continue;
    launches.push(launchView(record, { now: at }));
  }
  // Removal re-reads each record under the lock that starts and resumes hold, so a run that a resume is starting keeps its folder.
  // When the lock stays busy, the expired folders wait for the next list.
  const kept = candidates.length ? await withLaunchLock(env, async () => {
    const still = [];
    for (const { folder } of candidates) {
      const current = await readLaunchRecord(folder);
      if (!current) continue;
      if (expired(current, at)) await removeLaunchFolder(folder);
      else still.push(current);
    }
    return still;
  }).catch(() => []) : [];
  for (const record of kept) {
    if (record.store === store && record.runs.length) launches.push(launchView(record, { now: at }));
  }
  return { launches: launches.sort((left, right) => (right.launchedAt ?? "").localeCompare(left.launchedAt ?? "") || right.id.localeCompare(left.id)) };
}
