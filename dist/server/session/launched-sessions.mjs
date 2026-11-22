// Generated from src/server/session/launched-sessions.mts by scripts/native-build/compile.mjs.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLock } from "../workflow/artifact-store.mjs";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { listInitiatives } from "../workflow/record-store.mjs";
import { readRoadmap } from "../workflow/roadmap.mjs";
import { readCoordinationState } from "../workflow/state.mjs";
import { checkedCoordinator, hostAvailability, hostDefinition, hostEnvironment, resolveHost, validHostSessionId } from "./launch-hosts.mjs";
import {
  LAUNCH_ID_PATTERN,
  LaunchError,
  archivedNow,
  launchEnded,
  readArchiveMark,
  removeArchiveMark,
  writeArchiveMark,
  SUPERVISION_LOST,
  createLaunchFolder,
  expired,
  GATE_ID_PATTERN,
  gateFacts,
  lastRunStatus,
  launchCoordinator,
  launchFolder,
  launchRunning,
  launchView,
  launchesDirectory,
  listLaunchRecords,
  newLaunchId,
  readGateRecord,
  readStopRequest,
  prepareLaunchesDirectory,
  readLaunchRecord,
  removeLaunchFolder,
  stopGraceMs,
  storeLocation,
  voidToken,
  withRunStartLock,
  writeGateRecord,
  writeLaunchRecord,
  writeStopRequest
} from "./launch-records.mjs";
import { launchRequests } from "./permission-requests.mjs";
const SUPERVISOR = fileURLToPath(new URL("./launch-supervisor.mjs", import.meta.url));
const START_TIMEOUT_MS = 15e3;
const LOCK_TIMEOUT_MS = 3e4;
const POLL_MS = 25;
const FIRST_OUTPUT_WAIT_MS = 5e3;
const STOP_SETTLE_MS = 5e3;
const refuse = (code, message) => new LaunchError(code, message);
const runningMessage = (initiative) => `A launched session of ${initiative} is running on this machine.`;
async function initiativeExists(projectRoot, initiative) {
  if (typeof initiative !== "string" || !SLUG_PATTERN.test(initiative)) return false;
  const { loaded } = await readRoadmap(projectRoot).catch(() => ({ loaded: null }));
  if (Array.isArray(loaded?.record?.initiatives) && loaded.record.initiatives.some((item) => item?.id === initiative)) return true;
  const recorded = await listInitiatives(projectRoot).catch(() => []);
  return recorded.includes(initiative);
}
async function withLaunchLock(env, action, timeoutMs = LOCK_TIMEOUT_MS) {
  await prepareLaunchesDirectory(env);
  return withFileLock(path.join(launchesDirectory(env), "launches"), action, (code, message) => refuse(code === "lock_timeout" ? "launch_failed" : code, message), { timeoutMs });
}
async function otherRunning(env, { initiative, store, except = null }) {
  const now = Date.now();
  for (const { record } of await listLaunchRecords(env)) {
    if (!record || record.id === except) continue;
    if (record.initiative === initiative && record.store === store && launchRunning(record, now)) return true;
  }
  return false;
}
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
  supervisor.once("error", (error) => {
    gone = `the supervisor could not be started: ${error.message}`;
  });
  supervisor.once("exit", (code, signal) => {
    gone = `the supervisor ended with ${signal ?? `exit code ${code}`} before the host started`;
  });
  supervisor.unref();
  const startedView = (current, run) => {
    const started = { ...current, runs: current.runs.map((entry) => entry === run ? { ...entry, endedAt: null, exit: null, heartbeatAt: run.startedAt, supervisorPid: process.pid } : entry) };
    return launchView(started, { now: Date.parse(run.startedAt) });
  };
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await readLaunchRecord(folder);
    const run = current?.runs.find((entry) => entry.token === token);
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
    try {
      process.kill(supervisor.pid, "SIGTERM");
    } catch {
    }
  }
  throw refuse("launch_failed", `${hostDefinition(record.host).label} could not be started: the supervisor did not start it within ${START_TIMEOUT_MS / 1e3} seconds.`);
}
const INVALID_CHOICE = "The coordinator's choice is not one Prism can pass to a host: each of its provider, model, and effort is a name that keeps its rule, or null for the host default.";
const RECORDED_CHOICE_INVALID = "The session's recorded model choice is not one Prism can pass to a host, so it cannot be resumed.";
async function startLaunch({ projectRoot, initiative, host, coordinator = null, env = process.env }) {
  const definition = hostDefinition(host, env);
  if (!definition) throw refuse("unknown_host", `Prism cannot launch ${String(host)}: the hosts are claude-code, codex, and the ACP agents that this computer offers.`);
  const choice = checkedCoordinator(coordinator);
  if (!choice) throw refuse("invalid_choice", INVALID_CHOICE);
  const checkout = await realpath(projectRoot);
  if (!await initiativeExists(checkout, initiative)) throw refuse("unknown_initiative", `No initiative ${String(initiative)} exists in this checkout.`);
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
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      hostSessionId: host === "claude-code" ? randomUUID() : null,
      coordinator: choice,
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
const unknownLaunch = (id) => refuse("unknown_launch", `No launched session ${String(id)} exists on this machine.`);
async function resumeLocked(env, folder, id, cause) {
  const record = await readLaunchRecord(folder);
  if (!record) throw unknownLaunch(id);
  if (launchRunning(record)) throw refuse("launch_running", "The session is running.");
  if (await otherRunning(env, { initiative: record.initiative, store: record.store, except: id })) throw refuse("launch_running", runningMessage(record.initiative));
  if (!validHostSessionId(record.hostSessionId)) throw refuse("no_host_session", "The session never reported its host session id, so it cannot be resumed.");
  if (!launchCoordinator(record)) throw refuse("invalid_choice", RECORDED_CHOICE_INVALID);
  const resolved = await resolveHost(record.host, env);
  if (!resolved?.available) throw refuse("host_unavailable", resolved?.reason ?? `Unknown host ${record.host}.`);
  return startRun({ folder, record, env, cause: cause === "gate" ? "gate" : "person" });
}
async function resumeLaunch({ id, env = process.env, cause = "person" }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) throw unknownLaunch(id);
  const folder = launchFolder(env, id);
  if (!await readLaunchRecord(folder)) throw unknownLaunch(id);
  return withLaunchLock(env, () => resumeLocked(env, folder, id, cause));
}
async function resumeRefusal({ id, env = process.env }) {
  const folder = typeof id === "string" && LAUNCH_ID_PATTERN.test(id) ? launchFolder(env, id) : null;
  const record = folder ? await readLaunchRecord(folder) : null;
  if (!record) return unknownLaunch(id).message;
  if (launchRunning(record)) return "The session is running.";
  if (await otherRunning(env, { initiative: record.initiative, store: record.store, except: id })) return runningMessage(record.initiative);
  if (!validHostSessionId(record.hostSessionId)) return "The session never reported its host session id, so it cannot be resumed.";
  if (!launchCoordinator(record)) return RECORDED_CHOICE_INVALID;
  const resolved = await resolveHost(record.host, env);
  return resolved?.available ? null : resolved?.reason ?? `Unknown host ${record.host}.`;
}
async function launchRunStatus({ id, env = process.env }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return null;
  const record = await readLaunchRecord(launchFolder(env, id));
  return record ? lastRunStatus(record) : null;
}
async function initiativeRunning({ projectRoot, initiative, env = process.env }) {
  const store = await storeLocation(await realpath(projectRoot));
  return otherRunning(env, { initiative, store });
}
async function launchOf(env, id, { projectRoot, initiative }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return null;
  const folder = launchFolder(env, id);
  const record = await readLaunchRecord(folder);
  if (!record || record.initiative !== initiative) return null;
  if (record.store !== await storeLocation(await realpath(projectRoot))) return null;
  return { folder, record };
}
async function markLaunchGates({ projectRoot, initiative, gates, env = process.env }) {
  const ids = (Array.isArray(gates) ? gates : []).filter((gate) => typeof gate === "string" && GATE_ID_PATTERN.test(gate));
  if (!ids.length) return false;
  const found = await launchOf(env, env.PRISM_LAUNCH, { projectRoot, initiative });
  if (!found) return false;
  return withLaunchLock(env, async () => {
    if (!await readLaunchRecord(found.folder)) return false;
    const current = await readGateRecord(found.folder);
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const known = new Set(current.marks.map((mark) => mark.gate));
    await writeGateRecord(found.folder, { ...current, marks: [...current.marks, ...ids.filter((gate) => !known.has(gate)).map((gate) => ({ gate, at }))] });
    return true;
  });
}
async function markingLaunch(env, { projectRoot, initiative, gate }) {
  const store = await storeLocation(await realpath(projectRoot));
  for (const { folder, record } of await listLaunchRecords(env)) {
    if (!record || record.initiative !== initiative || record.store !== store) continue;
    if ((await readGateRecord(folder)).marks.some((mark) => mark.gate === gate)) return { folder, record };
  }
  return null;
}
async function answerLaunchGate({ projectRoot, initiative, gate, entry, env = process.env }) {
  if (typeof gate !== "string" || !GATE_ID_PATTERN.test(gate)) return null;
  const found = await markingLaunch(env, { projectRoot, initiative, gate });
  if (!found) return null;
  const { id } = found.record;
  try {
    return await withLaunchLock(env, async () => {
      const record = await readLaunchRecord(found.folder);
      if (!record) return { id, resumed: false, reason: unknownLaunch(id).message };
      const running = launchRunning(record);
      const current = await readGateRecord(found.folder);
      const answer = { entry, gate, run: running ? record.runs.at(-1).token : null, resumed: false };
      await writeGateRecord(found.folder, { ...current, answers: [...current.answers.filter((item) => item.entry !== entry), answer] });
      if (running) return { id, resumed: false, reason: "The session is running and receives the answer there." };
      if (await otherRunning(env, { initiative: record.initiative, store: record.store, except: id })) return { id, resumed: false, reason: `Another launched session of ${record.initiative} is running on this machine.` };
      try {
        await resumeLocked(env, found.folder, id, "gate");
        return { id, resumed: true, reason: null };
      } catch (error) {
        if (!(error instanceof LaunchError)) throw error;
        return { id, resumed: false, reason: error.message };
      }
    });
  } catch (error) {
    return { id, resumed: false, reason: error instanceof LaunchError ? error.message : "Prism could not record the answer for the launched session." };
  }
}
async function resumeForAnswers({ id, token, env = process.env }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return false;
  const folder = launchFolder(env, id);
  return withLaunchLock(env, async () => {
    const record = await readLaunchRecord(folder);
    const run = record?.runs.find((entry) => entry.token === token);
    if (!run?.endedAt || run !== record.runs.at(-1) || run.stopRequestedAt || run.exit?.code !== 0 || run.exit?.signal) return false;
    if ((await readStopRequest(folder))?.token === token) return false;
    const current = await readGateRecord(folder);
    const due = current.answers.filter((answer) => answer.run === token && !answer.resumed);
    if (!due.length) return false;
    const read = await readCoordinationState({ projectRoot: record.checkout, initiative: record.initiative }).catch(() => null);
    const pending = new Set((read?.valid ? read.state?.pending ?? [] : []).filter((gate) => gate && typeof gate === "object").map((gate) => gate.id));
    await writeGateRecord(folder, { ...current, answers: current.answers.map((answer) => answer.run === token ? { ...answer, resumed: true } : answer) });
    if (!due.some((answer) => pending.has(answer.gate))) return false;
    try {
      await resumeLocked(env, folder, id, "gate");
      return true;
    } catch (error) {
      if (error instanceof LaunchError) return false;
      throw error;
    }
  });
}
async function markStopped(env, folder, token) {
  return withLaunchLock(env, async () => {
    const record = await readLaunchRecord(folder);
    const run = record?.runs.find((entry) => entry.token === token);
    if (!run?.endedAt) return null;
    if (run.stopRequestedAt) return record;
    const request = await readStopRequest(folder);
    if (request?.token !== token) return record;
    const parsed = Date.parse(request.requestedAt ?? "");
    const at = Number.isFinite(parsed) ? parsed : Date.now();
    if (at > Date.parse(run.endedAt)) return record;
    run.stopRequestedAt = new Date(at).toISOString();
    await writeLaunchRecord(folder, record);
    return record;
  });
}
async function stopLaunch({ id, env = process.env }) {
  const unknown = () => refuse("unknown_launch", `No launched session ${String(id)} exists on this machine.`);
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) throw unknown();
  const folder = launchFolder(env, id);
  if (!await readLaunchRecord(folder)) throw unknown();
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
  for (; ; ) {
    const record = await readLaunchRecord(folder);
    if (!record) throw unknown();
    const current = record.runs.find((entry) => entry.token === run.token);
    if (current?.endedAt) return launchView(current.stopRequestedAt ? record : await markStopped(env, folder, run.token) ?? record);
    if (lastRunStatus(record) === "lost") throw refuse("supervision_lost", SUPERVISION_LOST);
    if (Date.now() >= deadline) throw refuse("stop_timeout", `The session did not stop within ${Math.ceil((grace + STOP_SETTLE_MS) / 1e3)} seconds; its supervisor keeps ending it.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
  }
}
async function pageViewer(projectRoot, at) {
  const checkout = await realpath(projectRoot);
  const store = await storeLocation(checkout);
  const pendingOf = /* @__PURE__ */ new Map();
  const pending = (initiative) => {
    if (!pendingOf.has(initiative)) {
      pendingOf.set(initiative, readCoordinationState({ projectRoot: checkout, initiative }).then((read) => read.valid ? read.state?.pending ?? [] : []).catch(() => []));
    }
    return pendingOf.get(initiative);
  };
  const viewOf = async (folder, record) => launchView(record, { now: at, gates: gateFacts(await readGateRecord(folder), await pending(record.initiative)), permission: (await launchRequests(folder, record, at))[0] ?? null });
  return { checkout, store, viewOf };
}
const byLaunch = (left, right) => (right.launchedAt ?? "").localeCompare(left.launchedAt ?? "") || right.id.localeCompare(left.id);
async function listLaunches({ projectRoot, env = process.env, now = Date.now() }) {
  const at = typeof now === "number" ? now : Date.parse(now);
  const { store, viewOf } = await pageViewer(projectRoot, at);
  const launches = [];
  const candidates = [];
  for (const { folder, record } of await listLaunchRecords(env)) {
    if (!record) continue;
    if (expired(record, at)) {
      candidates.push({ folder, record });
      continue;
    }
    if (record.store !== store || !record.runs.length) continue;
    launches.push(await viewOf(folder, record));
  }
  const kept = candidates.length ? await withLaunchLock(env, async () => {
    const still = [];
    for (const { folder } of candidates) {
      const current = await readLaunchRecord(folder);
      if (!current) continue;
      if (expired(current, at)) await removeLaunchFolder(folder);
      else still.push({ folder, record: current });
    }
    return still;
  }).catch(() => []) : [];
  for (const { folder, record } of kept) {
    if (record.store === store && record.runs.length) launches.push(await viewOf(folder, record));
  }
  return { launches: launches.sort(byLaunch) };
}
const STALE_MARK_LOCK_MS = 2e3;
const notEnded = () => refuse("launch_not_ended", "Only a finished, failed, stopped, or blocked session can be archived.");
const sameMark = (left, right) => left !== null && right !== null && left.archivedAt === right.archivedAt && left.runs === right.runs;
async function pageLaunch(env, id, viewer, at) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return null;
  const folder = launchFolder(env, id);
  const info = await lstat(folder).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return null;
  const record = await readLaunchRecord(folder);
  if (!record || record.id !== id || record.store !== viewer.store || !record.runs.length || expired(record, at)) return null;
  return { folder, record, view: await viewer.viewOf(folder, record) };
}
async function archiveLocked(found, at) {
  const mark = await readArchiveMark(found.folder);
  if (archivedNow(mark, found.record, found.view.state)) return false;
  await writeArchiveMark(found.folder, { archivedAt: new Date(at).toISOString(), runs: found.record.runs.length });
  return true;
}
async function archiveLaunch({ projectRoot, id, env = process.env }) {
  const viewer = await pageViewer(projectRoot, Date.now());
  return withLaunchLock(env, async () => {
    const at = Date.now();
    const found = await pageLaunch(env, id, viewer, at);
    if (!found) throw unknownLaunch(id);
    if (!launchEnded(found.view.state)) throw notEnded();
    return { archived: await archiveLocked(found, at) ? [id] : [] };
  });
}
async function unarchiveLaunch({ projectRoot, id, env = process.env }) {
  const viewer = await pageViewer(projectRoot, Date.now());
  return withLaunchLock(env, async () => {
    const found = await pageLaunch(env, id, viewer, Date.now());
    if (!found) throw unknownLaunch(id);
    const mark = await readArchiveMark(found.folder);
    if (!mark) return { unarchived: [] };
    await removeArchiveMark(found.folder);
    return { unarchived: archivedNow(mark, found.record, found.view.state) ? [id] : [] };
  });
}
async function archiveEndedLaunches({ projectRoot, env = process.env }) {
  const viewer = await pageViewer(projectRoot, Date.now());
  return withLaunchLock(env, async () => {
    const at = Date.now();
    const found = [];
    for (const { record } of await listLaunchRecords(env)) {
      const launch = record ? await pageLaunch(env, record.id, viewer, at) : null;
      if (launch && launchEnded(launch.view.state)) found.push(launch);
    }
    found.sort((left, right) => (left.view.state === "failed" ? 0 : 1) - (right.view.state === "failed" ? 0 : 1) || byLaunch(left.view, right.view));
    const archived = [];
    for (const launch of found) if (await archiveLocked(launch, at)) archived.push(launch.record.id);
    return { archived };
  });
}
async function archivedLaunches({ launches, env = process.env }) {
  const archived = /* @__PURE__ */ new Set();
  const stale = [];
  for (const view of Array.isArray(launches) ? launches : []) {
    if (typeof view?.id !== "string" || !LAUNCH_ID_PATTERN.test(view.id)) continue;
    const folder = launchFolder(env, view.id);
    const mark = await readArchiveMark(folder);
    if (!mark) continue;
    const record = await readLaunchRecord(folder);
    if (!record || record.runs.length !== view.runs) continue;
    if (archivedNow(mark, record, view.state)) archived.add(view.id);
    else stale.push({ folder, mark });
  }
  if (stale.length) {
    await withLaunchLock(env, async () => {
      for (const { folder, mark } of stale) if (sameMark(await readArchiveMark(folder), mark)) await removeArchiveMark(folder);
    }, STALE_MARK_LOCK_MS).catch(() => {
    });
  }
  return archived;
}
export {
  LaunchError,
  answerLaunchGate,
  archiveEndedLaunches,
  archiveLaunch,
  archivedLaunches,
  hostAvailability,
  initiativeRunning,
  launchRunStatus,
  runningMessage as launchRunningMessage,
  listLaunches,
  markLaunchGates,
  resumeForAnswers,
  resumeLaunch,
  resumeRefusal,
  startLaunch,
  stopLaunch,
  unarchiveLaunch
};
