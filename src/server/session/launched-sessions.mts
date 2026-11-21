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
  type ArchiveMark,
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
  readResultMarks,
  noResultGates,
  writeResultMarks,
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
import { isNoResultGate, noResultContext, noResultQuestion, runHasResult } from "./run-result.mjs";

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

const refuse = (code: string, message: string) => new LaunchError(code, message);
const runningMessage = (initiative: string) => `A launched session of ${initiative} is running on this machine.`;

async function initiativeExists(projectRoot: string, initiative: string) {
  if (typeof initiative !== "string" || !SLUG_PATTERN.test(initiative)) return false;
  const { loaded } = await readRoadmap(projectRoot).catch(() => ({ loaded: null }));
  if (Array.isArray(loaded?.record?.initiatives) && loaded.record.initiatives.some((item: any) => item?.id === initiative)) return true;
  const recorded: string[] = await listInitiatives(projectRoot).catch(() => []);
  return recorded.includes(initiative);
}

// Serializes every start and resume of this machine's launches, so two requests never both pass the running check.
async function withLaunchLock<T>(env: NodeJS.ProcessEnv, action: () => Promise<T>, timeoutMs = LOCK_TIMEOUT_MS): Promise<T> {
  await prepareLaunchesDirectory(env);
  return withFileLock(path.join(launchesDirectory(env), "launches"), action, (code, message) => refuse(code === "lock_timeout" ? "launch_failed" : code, message), { timeoutMs });
}

async function otherRunning(env: NodeJS.ProcessEnv, { initiative, store, except = null }: { initiative: string; store: string; except?: any }) {
  const now = Date.now();
  for (const { record } of await listLaunchRecords(env)) {
    if (!record || record.id === except) continue;
    if (record.initiative === initiative && record.store === store && launchRunning(record, now)) return true;
  }
  return false;
}

// Starts the supervisor of the next run and waits until it has started the host or reported why it could not.
async function startRun({ folder, record, env, cause }: { folder: string; record: any; env: NodeJS.ProcessEnv; cause: any }) {
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
  const startedView = (current: any, run: any) => {
    const started = { ...current, runs: current.runs.map((entry: any) => (entry === run ? { ...entry, endedAt: null, exit: null, heartbeatAt: run.startedAt, supervisorPid: process.pid } : entry)) };
    return launchView(started, { now: Date.parse(run.startedAt) });
  };
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await readLaunchRecord(folder);
    const run = current?.runs.find((entry: any) => entry.token === token);
    // The host counts as started once it has written its first output or ended, or a few seconds after its process started.
    if (run && (run.outputAt || run.endedAt || Date.now() - Date.parse(run.startedAt) >= FIRST_OUTPUT_WAIT_MS)) return startedView(current, run);
    if (current?.startFailure?.token === token) throw refuse("launch_failed", current.startFailure.message);
    if (gone) {
      const last = await readLaunchRecord(folder);
      if (last?.startFailure?.token === token) throw refuse("launch_failed", last.startFailure.message);
      if (!last?.runs.some((entry: any) => entry.token === token)) throw refuse("launch_failed", `${hostDefinition(record.host)!.label} could not be started: ${gone}.`);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  // Giving up voids the token under the lock that the supervisor holds while it starts the host, so a late supervisor starts none;
  // a host it started before that still counts as started.
  const late = await withRunStartLock(folder, async () => {
    const current = await readLaunchRecord(folder);
    const run = current?.runs.find((entry: any) => entry.token === token);
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
  throw refuse("launch_failed", `${hostDefinition(record.host)!.label} could not be started: the supervisor did not start it within ${START_TIMEOUT_MS / 1000} seconds.`);
}

const INVALID_CHOICE = "The coordinator's choice is not one Prism can pass to a host: each of its provider, model, and effort is a name that keeps its rule, or null for the host default.";
const RECORDED_CHOICE_INVALID = "The session's recorded model choice is not one Prism can pass to a host, so it cannot be resumed.";

/**
 * Starts a launched session's first run with the coordinator's choice { provider, model, effort, typed }, each part null for the
 * host default: { launch }, its view in state running. The launch record keeps the choice, and every resume runs with it.
 */
export async function startLaunch({ projectRoot, initiative, host, coordinator = null, env = process.env }: { projectRoot: string; initiative: string; host: string; coordinator?: unknown; env?: NodeJS.ProcessEnv }) {
  const definition = hostDefinition(host, env);
  if (!definition) throw refuse("unknown_host", `Prism cannot launch ${String(host)}: the hosts are claude-code, codex, and the ACP agents that this computer offers.`);
  const choice = checkedCoordinator(coordinator);
  if (!choice) throw refuse("invalid_choice", INVALID_CHOICE);
  const checkout = await realpath(projectRoot);
  if (!(await initiativeExists(checkout, initiative))) throw refuse("unknown_initiative", `No initiative ${String(initiative)} exists in this checkout.`);
  const resolved = await resolveHost(host, env);
  if (!resolved!.available) throw refuse("host_unavailable", resolved!.reason!);
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

const unknownLaunch = (id: string) => refuse("unknown_launch", `No launched session ${String(id)} exists on this machine.`);

// The checks and the start of a resume; the caller holds the launch lock.
async function resumeLocked(env: NodeJS.ProcessEnv, folder: string, id: string, cause: any) {
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

/** Starts the next run of a launched session with the resume arguments and the recorded coordinator choice, and answers its view in state running. */
export async function resumeLaunch({ id, env = process.env, cause = "person" }: { id: string; env?: NodeJS.ProcessEnv; cause?: string }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) throw unknownLaunch(id);
  const folder = launchFolder(env, id);
  if (!(await readLaunchRecord(folder))) throw unknownLaunch(id);
  return withLaunchLock(env, () => resumeLocked(env, folder, id, cause));
}

/**
 * Why a resume of the launch would be refused now, as clause 17 orders the refusals, or null when it would start:
 * the reason of an unavailable resume action. It starts nothing.
 */
export async function resumeRefusal({ id, env = process.env }: { id: string; env?: NodeJS.ProcessEnv }) {
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

/** How the last run of a launch stands: "none", "running", "lost", or "ended", or null for an id that names no launch folder. */
export async function launchRunStatus({ id, env = process.env }: { id: string; env?: NodeJS.ProcessEnv }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return null;
  const record = await readLaunchRecord(launchFolder(env, id));
  return record ? lastRunStatus(record) : null;
}

/** Whether a run of a launched session of the initiative, in the record store of projectRoot, runs on this machine. */
export async function initiativeRunning({ projectRoot, initiative, env = process.env }: { projectRoot: string; initiative: string; env?: NodeJS.ProcessEnv }) {
  const store = await storeLocation(await realpath(projectRoot));
  return otherRunning(env, { initiative, store });
}

/** The message that a launch refused for a running session of the initiative carries. */
export { runningMessage as launchRunningMessage };

// The launch that PRISM_LAUNCH names, when its folder exists on this machine for the initiative in the record store of projectRoot.
async function launchOf(env: NodeJS.ProcessEnv, id: string, { projectRoot, initiative }: { projectRoot: string; initiative: string }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return null;
  const folder = launchFolder(env, id);
  const record = await readLaunchRecord(folder);
  if (!record || record.initiative !== initiative) return null;
  if (record.store !== (await storeLocation(await realpath(projectRoot)))) return null;
  return { folder, record };
}

/**
 * Marks gates as asked by the launched session that env.PRISM_LAUNCH names, in that launch folder only, when the launch is of this
 * machine, of the same initiative, and in the record store of projectRoot; otherwise it marks nothing. It never changes the gate record.
 */
export async function markLaunchGates({ projectRoot, initiative, gates, env = process.env }: { projectRoot: string; initiative: string; gates: any; env?: NodeJS.ProcessEnv }) {
  const ids = (Array.isArray(gates) ? gates : []).filter((gate) => typeof gate === "string" && GATE_ID_PATTERN.test(gate));
  if (!ids.length) return false;
  const found = await launchOf(env, env.PRISM_LAUNCH!, { projectRoot, initiative });
  if (!found) return false;
  return withLaunchLock(env, async () => {
    if (!(await readLaunchRecord(found.folder))) return false;
    const current = await readGateRecord(found.folder);
    const at = new Date().toISOString();
    const known = new Set(current.marks.map((mark) => mark.gate));
    await writeGateRecord(found.folder, { ...current, marks: [...current.marks, ...ids.filter((gate) => !known.has(gate)).map((gate) => ({ gate, at }))] });
    return true;
  });
}

/**
 * Marks a pause that the launched run that env.PRISM_LAUNCH names recorded, in that launch folder only, when the launch is of this
 * machine, of the same initiative, and in the record store of projectRoot; otherwise it marks nothing. A pause is a result of the run.
 */
export async function markLaunchPause({ projectRoot, initiative, env = process.env }: { projectRoot: string; initiative: string; env?: NodeJS.ProcessEnv }) {
  const found = await launchOf(env, env.PRISM_LAUNCH!, { projectRoot, initiative });
  if (!found) return false;
  return withLaunchLock(env, async () => {
    if (!(await readLaunchRecord(found.folder))) return false;
    const marks = await readResultMarks(found.folder);
    await writeResultMarks(found.folder, { ...marks, pauses: [...marks.pauses, { at: new Date().toISOString() }] });
    return true;
  });
}

/** Marks that this process checks whether the run with this token ended with a result, so the run shows as running until the check ends. */
export async function markResultCheck({ id, token, env = process.env }: { id: string; token: string; env?: NodeJS.ProcessEnv }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return;
  const folder = launchFolder(env, id);
  await withLaunchLock(env, async () => {
    const marks = await readResultMarks(folder);
    await writeResultMarks(folder, { ...marks, checks: [...marks.checks.filter((check) => check.run !== token), { run: token, pid: process.pid, at: new Date().toISOString() }] });
  });
}

const NEWER_RUN = "A newer run of this launched session ended without a result.";

// Records the no-result gate of a run in the initiative's coordination state, first resolving the launch's earlier unanswered one:
// { gate } with the new gate's id, or { failure } with why it could not be recorded.
async function askNoResultGate(record: any, earlier: string[], lastMessage: string | null, env: NodeJS.ProcessEnv) {
  const { readCoordinationState: read, updateCoordinationState } = await import("../workflow/state.mjs");
  const label = hostDefinition(record.host, env)?.label ?? record.host;
  const ask = { op: "ask", kind: "assistance", question: noResultQuestion(label, record.initiative), context: noResultContext(lastMessage), artifacts: [] };
  let failure = "The coordination state kept changing.";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const current: any = await read({ projectRoot: record.checkout, initiative: record.initiative });
      const pending = current.valid && Array.isArray(current.state?.pending) ? current.state.pending : [];
      const resolve = pending.filter((gate: any) => gate && earlier.includes(gate.id) && !gate.answer && isNoResultGate(gate)).map((gate: any) => ({ op: "resolve", id: gate.id, reason: NEWER_RUN }));
      const result: any = await updateCoordinationState({ projectRoot: record.checkout, initiative: record.initiative, expectedRevision: current.revision ?? null, changes: { gateOperations: [...resolve, ask] } });
      const gate = result.openedGates?.at(-1)?.id;
      return typeof gate === "string" && GATE_ID_PATTERN.test(gate) ? { gate } : { failure: "The coordination state named no new gate." };
    } catch (error: any) {
      failure = typeof error?.message === "string" && error.message ? error.message : String(error);
      if (error?.code !== "revision_conflict") break;
    }
  }
  return { failure };
}

/**
 * After a run of a launched session ended, checks whether it ended with a result, then removes this process's check mark. A run that ended
 * normally, that no answer resumed, and that has no result gets one no-result gate, marked as asked by the launch and, for Claude Code
 * and Codex, by its host session, and a no-result mark that names the gate, or why Prism could not record it.
 * normal says whether the host ended normally by its own facts, such as an ACP agent's stop reason; the record decides the rest.
 */
export async function settleRunResult({ id, token, normal, resumed, lastMessage, env = process.env }: { id: string; token: string; normal: boolean; resumed: boolean; lastMessage: string | null; env?: NodeJS.ProcessEnv }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return;
  const folder = launchFolder(env, id);
  let mark: { run: string; gate: string | null; failure: string | null; at: string } | null = null;
  try {
    const record = await readLaunchRecord(folder);
    const run = record?.runs.find((entry: any) => entry.token === token);
    const ended = run && run === record.runs.at(-1) && run.endedAt && !run.stopRequestedAt && run.exit?.code === 0 && !run.exit?.signal
      && typeof run.failure !== "string" && typeof run.hostError !== "string" && !(Array.isArray(run.refusals) && run.refusals.length) && !(run.refusalCount > 0);
    if (!normal || resumed || !ended || (await readStopRequest(folder))?.token === token) return;
    const marks = await readResultMarks(folder);
    if (await runHasResult({ checkout: record.checkout, initiative: record.initiative, since: run.startedAt, pauses: marks.pauses })) return;
    const asked = await askNoResultGate(record, noResultGates(marks), lastMessage, env);
    if ("gate" in asked) {
      await markLaunchGates({ projectRoot: record.checkout, initiative: record.initiative, gates: [asked.gate], env: { ...env, PRISM_LAUNCH: id } }).catch(() => false);
      if ((record.host === "claude-code" || record.host === "codex") && validHostSessionId(record.hostSessionId)) {
        const { noticeDirectory, rememberAskedGates } = await import("../workflow/change-notices.mjs");
        const { holderOf } = await import("../workflow/slice-claims.mjs");
        await rememberAskedGates({ projectRoot: record.checkout, initiative: record.initiative, gateIds: [asked.gate], session: holderOf(record.hostSessionId), directory: noticeDirectory(env) }).catch(() => {});
      }
    }
    mark = { run: token, gate: "gate" in asked ? asked.gate! : null, failure: "failure" in asked ? asked.failure! : null, at: new Date().toISOString() };
  } finally {
    await withLaunchLock(env, async () => {
      const marks = await readResultMarks(folder);
      await writeResultMarks(folder, { ...marks, checks: marks.checks.filter((check) => check.run !== token), noResult: mark ? [...marks.noResult.filter((item) => item.run !== token), mark] : marks.noResult });
    }).catch(() => {});
  }
}

// The launch of this machine, in the record store of projectRoot, that marked the gate of the initiative: { folder, record }, or null.
async function markingLaunch(env: NodeJS.ProcessEnv, { projectRoot, initiative, gate }: { projectRoot: string; initiative: string; gate: any }) {
  const store = await storeLocation(await realpath(projectRoot));
  for (const { folder, record } of await listLaunchRecords(env)) {
    if (!record || record.initiative !== initiative || record.store !== store) continue;
    if ((await readGateRecord(folder)).marks.some((mark) => mark.gate === gate)) return { folder, record };
  }
  return null;
}

/**
 * Records the person's answer to a gate on this machine in the launch folder of the session that marked it, and resumes that session
 * when none of its runs and no other launched session of the initiative runs: { id, resumed, reason }, or null for an unmarked gate.
 * While one of its runs runs, the answer is kept for that run, whose supervisor resumes the session once if the run ends with the gate pending.
 */
export async function answerLaunchGate({ projectRoot, initiative, gate, entry, env = process.env }: { projectRoot: string; initiative: string; gate: any; entry: any; env?: NodeJS.ProcessEnv }) {
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

/**
 * After a run that exited 0, resumes the session once with cause gate when an answer recorded for that run on this machine names a gate
 * that is still pending in the initiative's coordination state; each recorded answer causes at most one resume. Answers whether it resumed.
 */
export async function resumeForAnswers({ id, token, env = process.env }: { id: string; token: string; env?: NodeJS.ProcessEnv }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return false;
  const folder = launchFolder(env, id);
  return withLaunchLock(env, async () => {
    const record = await readLaunchRecord(folder);
    const run = record?.runs.find((entry: any) => entry.token === token);
    if (!run?.endedAt || run !== record.runs.at(-1) || run.stopRequestedAt || run.exit?.code !== 0 || run.exit?.signal) return false;
    // A stop request for this run counts even when the supervisor did not act on it, such as one written while it drained the output.
    if ((await readStopRequest(folder))?.token === token) return false;
    const current = await readGateRecord(folder);
    const due = current.answers.filter((answer) => answer.run === token && !answer.resumed);
    if (!due.length) return false;
    const read = await readCoordinationState({ projectRoot: record.checkout, initiative: record.initiative }).catch(() => null);
    const pending = new Set((read?.valid ? read.state?.pending ?? [] : []).filter((gate: any) => gate && typeof gate === "object").map((gate: any) => gate.id));
    // Every answer of the run is spent here, so none causes a second resume, whether or not this one starts.
    await writeGateRecord(folder, { ...current, answers: current.answers.map((answer) => (answer.run === token ? { ...answer, resumed: true } : answer)) });
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

// A run whose host ended on its own after the stop request was written, before its supervisor read it, still ended after a stop request:
// the request's time is recorded in the run, so every view shows it stopped. The supervisor writes nothing more once it recorded the end.
// A run whose host ended before the request was written, while its supervisor still drained the output, keeps the state of its own end.
async function markStopped(env: NodeJS.ProcessEnv, folder: string, token: string) {
  return withLaunchLock(env, async () => {
    const record = await readLaunchRecord(folder);
    const run = record?.runs.find((entry: any) => entry.token === token);
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

/**
 * Asks a launched session's supervisor to stop through its launch folder, so any process on this machine can ask,
 * and answers the launch view in state stopped once the supervisor has recorded the run's end.
 */
export async function stopLaunch({ id, env = process.env }: { id: string; env?: NodeJS.ProcessEnv }) {
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
    const current = record.runs.find((entry: any) => entry.token === run.token);
    if (current?.endedAt) return launchView(current.stopRequestedAt ? record : await markStopped(env, folder, run.token) ?? record);
    if (lastRunStatus(record) === "lost") throw refuse("supervision_lost", SUPERVISION_LOST);
    if (Date.now() >= deadline) throw refuse("stop_timeout", `The session did not stop within ${Math.ceil((grace + STOP_SETTLE_MS) / 1000)} seconds; its supervisor keeps ending it.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
  }
}

// The record store of the page's checkout and the launch view of a record as that checkout reads its initiative's pending gates,
// each initiative's coordination state read once.
async function pageViewer(projectRoot: string, at: number) {
  const checkout = await realpath(projectRoot);
  const store = await storeLocation(checkout);
  const pendingOf = new Map();
  const pending = (initiative: string) => {
    if (!pendingOf.has(initiative)) {
      pendingOf.set(initiative, readCoordinationState({ projectRoot: checkout, initiative }).then((read) => (read.valid ? read.state?.pending ?? [] : [])).catch(() => []));
    }
    return pendingOf.get(initiative);
  };
  const viewOf = async (folder: string, record: any) => {
    const results = await readResultMarks(folder);
    return launchView(record, { now: at, gates: gateFacts(await readGateRecord(folder), await pending(record.initiative), noResultGates(results)), permission: (await launchRequests(folder, record, at))[0] ?? null, results });
  };
  return { checkout, store, viewOf };
}

type PageViewer = Awaited<ReturnType<typeof pageViewer>>;

const byLaunch = (left: any, right: any) => (right.launchedAt ?? "").localeCompare(left.launchedAt ?? "") || right.id.localeCompare(left.id);

/** Every launched session of this machine whose checkout shares the record store of projectRoot, the most recently launched first. */
export async function listLaunches({ projectRoot, env = process.env, now = Date.now() }: { projectRoot: string; env?: NodeJS.ProcessEnv; now?: number }) {
  const at = typeof now === "number" ? now : Date.parse(now);
  const { store, viewOf } = await pageViewer(projectRoot, at);
  const launches: any[] = [];
  const candidates: { folder: string; record: any }[] = [];
  for (const { folder, record } of await listLaunchRecords(env)) {
    if (!record) continue;
    if (expired(record, at)) {
      candidates.push({ folder, record });
      continue;
    }
    if (record.store !== store || !record.runs.length) continue;
    launches.push(await viewOf(folder, record));
  }
  // Removal re-reads each record under the lock that starts and resumes hold, so a run that a resume is starting keeps its folder.
  // When the lock stays busy, the expired folders wait for the next list.
  const kept = candidates.length ? await withLaunchLock(env, async () => {
    const still: { folder: string; record: any }[] = [];
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

// Archiving: a mark beside the record of an ended launched session, written and removed only under the launch lock, so no resume
// starts between the state check and the write. A mark whose session ran or waited again is stale, and a listing removes it.
const STALE_MARK_LOCK_MS = 2000;
const notEnded = () => refuse("launch_not_ended", "Only a finished, failed, stopped, or blocked session can be archived.");
const sameMark = (left: ArchiveMark | null, right: ArchiveMark | null) => left !== null && right !== null && left.archivedAt === right.archivedAt && left.runs === right.runs;

interface PageLaunch {
  folder: string;
  record: any;
  view: any;
}

// The launch that the page lists, as listLaunches lists it for the checkout: { folder, record, view }, or null. The caller holds the launch lock.
async function pageLaunch(env: NodeJS.ProcessEnv, id: unknown, viewer: PageViewer, at: number): Promise<PageLaunch | null> {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return null;
  const folder = launchFolder(env, id);
  const info = await lstat(folder).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return null;
  const record = await readLaunchRecord(folder);
  if (!record || record.id !== id || record.store !== viewer.store || !record.runs.length || expired(record, at)) return null;
  return { folder, record, view: await viewer.viewOf(folder, record) };
}

async function archiveLocked(found: PageLaunch, at: number) {
  const mark = await readArchiveMark(found.folder);
  if (archivedNow(mark, found.record, found.view.state)) return false;
  await writeArchiveMark(found.folder, { archivedAt: new Date(at).toISOString(), runs: found.record.runs.length });
  return true;
}

/** Archives a launched session that the page lists and that ended: { archived: [id] }, or { archived: [] } when it is already archived. */
export async function archiveLaunch({ projectRoot, id, env = process.env }: { projectRoot: string; id: string; env?: NodeJS.ProcessEnv }) {
  const viewer = await pageViewer(projectRoot, Date.now());
  return withLaunchLock(env, async () => {
    const at = Date.now();
    const found = await pageLaunch(env, id, viewer, at);
    if (!found) throw unknownLaunch(id);
    if (!launchEnded(found.view.state)) throw notEnded();
    return { archived: (await archiveLocked(found, at)) ? [id] : [] };
  });
}

/** Removes the archive mark of a launched session that the page lists: { unarchived: [id] }, or { unarchived: [] } when it was not archived. */
export async function unarchiveLaunch({ projectRoot, id, env = process.env }: { projectRoot: string; id: string; env?: NodeJS.ProcessEnv }) {
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

/**
 * Archives every launched session that the page lists, that ended, and that is not archived: { archived: [ids] }, failed ones first and
 * then the latest launched first, the order the agents list gives them.
 */
export async function archiveEndedLaunches({ projectRoot, env = process.env }: { projectRoot: string; env?: NodeJS.ProcessEnv }) {
  const viewer = await pageViewer(projectRoot, Date.now());
  return withLaunchLock(env, async () => {
    const at = Date.now();
    const found: PageLaunch[] = [];
    for (const { record } of await listLaunchRecords(env)) {
      const launch = record ? await pageLaunch(env, record.id, viewer, at) : null;
      if (launch && launchEnded(launch.view.state)) found.push(launch);
    }
    found.sort((left, right) => (left.view.state === "failed" ? 0 : 1) - (right.view.state === "failed" ? 0 : 1) || byLaunch(left.view, right.view));
    const archived: string[] = [];
    for (const launch of found) if (await archiveLocked(launch, at)) archived.push(launch.record.id);
    return { archived };
  });
}

/**
 * The ids of the listed launch views that are archived now. A mark whose session ran or waited again, or ran again and ended, is removed
 * under the launch lock unless it changed meanwhile; when the lock stays busy it waits for the next read.
 */
export async function archivedLaunches({ launches, env = process.env }: { launches: any[]; env?: NodeJS.ProcessEnv }) {
  const archived = new Set<string>();
  const stale: { folder: string; mark: ArchiveMark }[] = [];
  for (const view of Array.isArray(launches) ? launches : []) {
    if (typeof view?.id !== "string" || !LAUNCH_ID_PATTERN.test(view.id)) continue;
    const folder = launchFolder(env, view.id);
    const mark = await readArchiveMark(folder);
    if (!mark) continue;
    const record = await readLaunchRecord(folder);
    // A record that changed since the view was read is judged by the next read.
    if (!record || record.runs.length !== view.runs) continue;
    if (archivedNow(mark, record, view.state)) archived.add(view.id);
    else stale.push({ folder, mark });
  }
  if (stale.length) {
    await withLaunchLock(env, async () => {
      for (const { folder, mark } of stale) if (sameMark(await readArchiveMark(folder), mark)) await removeArchiveMark(folder);
    }, STALE_MARK_LOCK_MS).catch(() => {});
  }
  return archived;
}
