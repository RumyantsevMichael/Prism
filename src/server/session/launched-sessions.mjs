import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLock } from "../workflow/artifact-store.mjs";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { listInitiatives } from "../workflow/record-store.mjs";
import { readRoadmap } from "../workflow/roadmap.mjs";
import { hostAvailability, hostDefinition, hostEnvironment, resolveHost } from "./launch-hosts.mjs";
import {
  LAUNCH_ID_PATTERN,
  LaunchError,
  createLaunchFolder,
  expired,
  launchFolder,
  launchRunning,
  launchView,
  launchesDirectory,
  listLaunchRecords,
  newLaunchId,
  prepareLaunchesDirectory,
  readLaunchRecord,
  removeLaunchFolder,
  storeLocation,
  writeLaunchRecord
} from "./launch-records.mjs";

// Starting, listing, and resuming launched sessions: headless host sessions that Prism runs for one initiative on this machine.
// Each run runs under a detached supervisor, so the session outlives the process that started it.

export { hostAvailability, LaunchError };

const SUPERVISOR = fileURLToPath(new URL("./launch-supervisor.mjs", import.meta.url));
const START_TIMEOUT_MS = 15000;
const LOCK_TIMEOUT_MS = 30000;
const POLL_MS = 25;
const FIRST_OUTPUT_WAIT_MS = 5000;

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
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await readLaunchRecord(folder);
    const run = current?.runs.find((entry) => entry.token === token);
    // The host counts as started once it has written its first output or ended, or a few seconds after its process started.
    if (run && (run.outputAt || run.endedAt || Date.now() - Date.parse(run.startedAt) >= FIRST_OUTPUT_WAIT_MS)) {
      // The view as of the host's start, so a run that already ended still answers as the running session it was.
      const started = { ...current, runs: current.runs.map((entry) => (entry === run ? { ...entry, endedAt: null, exit: null, heartbeatAt: run.startedAt, supervisorPid: process.pid } : entry)) };
      return launchView(started, { now: Date.parse(run.startedAt) });
    }
    if (current?.startFailure?.token === token) throw refuse("launch_failed", current.startFailure.message);
    if (gone) {
      const last = await readLaunchRecord(folder);
      if (last?.startFailure?.token === token) throw refuse("launch_failed", last.startFailure.message);
      if (!last?.runs.some((entry) => entry.token === token)) throw refuse("launch_failed", `${hostDefinition(record.host).label} could not be started: ${gone}.`);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
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
    if (!record.hostSessionId) throw refuse("no_host_session", "The session never reported its host session id, so it cannot be resumed.");
    const resolved = await resolveHost(record.host, env);
    if (!resolved?.available) throw refuse("host_unavailable", resolved?.reason ?? `Unknown host ${record.host}.`);
    return startRun({ folder, record, env, cause: cause === "gate" ? "gate" : "person" });
  });
}

/** Every launched session of this machine whose checkout shares the record store of projectRoot, the most recently launched first. */
export async function listLaunches({ projectRoot, env = process.env, now = Date.now() }) {
  const at = typeof now === "number" ? now : Date.parse(now);
  const store = await storeLocation(await realpath(projectRoot));
  const launches = [];
  for (const { folder, record } of await listLaunchRecords(env)) {
    if (!record) continue;
    if (expired(record, at)) {
      await removeLaunchFolder(folder);
      continue;
    }
    if (record.store !== store || !record.runs.length) continue;
    launches.push(launchView(record, { now: at }));
  }
  return { launches: launches.sort((left, right) => (right.launchedAt ?? "").localeCompare(left.launchedAt ?? "") || right.id.localeCompare(left.id)) };
}
