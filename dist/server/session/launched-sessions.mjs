// Generated from src/server/session/launched-sessions.mts by scripts/native-build/compile.mjs.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLock } from "../workflow/artifact-store.mjs";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { listInitiatives } from "../workflow/record-store.mjs";
import { readRoadmap } from "../workflow/roadmap.mjs";
import { readCoordinationState } from "../workflow/state.mjs";
import { askerResumeOf, checkedCoordinator, hostAvailability, hostDefinition, hostEnvironment, resolveHost, validHostSessionId } from "./launch-hosts.mjs";
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
  createLaunchWorkFolder,
  expired,
  GATE_ID_PATTERN,
  gateFacts,
  lastRunStatus,
  launchCoordinator,
  launchFolder,
  launchRunning,
  ANSWERED_GATE_PATTERN,
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
const SUPERVISOR = fileURLToPath(new URL("./launch-supervisor.mjs", import.meta.url));
const START_TIMEOUT_MS = 15e3;
const LOCK_TIMEOUT_MS = 3e4;
const POLL_MS = 25;
const FIRST_OUTPUT_WAIT_MS = 5e3;
const STOP_SETTLE_MS = 5e3;
const refuse = (code, message) => new LaunchError(code, message);
const runningMessage = (initiative) => `A launched session of ${initiative} is running on this machine.`;
const runRunningMessage = (run) => `A session of the format migration run ${run} is running on this machine.`;
const subjectOf = (record) => ({ initiative: record.initiative ?? null, migrationRun: typeof record.migrationRun === "string" ? record.migrationRun : null });
const subjectRunningMessage = (subject) => subject.migrationRun ? runRunningMessage(subject.migrationRun) : runningMessage(subject.initiative);
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
async function otherRunning(env, { initiative = null, migrationRun = null, store, except = null }) {
  if (initiative === null && migrationRun === null) return false;
  const now = Date.now();
  for (const { record } of await listLaunchRecords(env)) {
    if (!record || record.id === except) continue;
    const subject = subjectOf(record);
    if (subject.initiative === initiative && subject.migrationRun === migrationRun && record.store === store && launchRunning(record, now)) return true;
  }
  return false;
}
async function startRun({ folder, record, env, cause }) {
  const token = randomBytes(8).toString("hex");
  const supervisor = spawn(process.execPath, [SUPERVISOR, folder, cause, token], {
    cwd: record.workdir ?? record.checkout,
    env: hostEnvironment(env, record.id, record.migrationRun ?? null, record.migrationRun ? record.checkout : null),
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
async function startLaunch({ projectRoot, initiative, host, coordinator = null, answeredGate = null, env = process.env }) {
  if (answeredGate !== null && !ANSWERED_GATE_PATTERN.test(answeredGate)) throw refuse("invalid_gate", "The answered gate is not a gate id that Prism records.");
  const definition = hostDefinition(host, env);
  if (!definition) throw refuse("unknown_host", `Prism cannot launch ${String(host)}: the hosts are claude-code, codex, and the ACP agents that this computer offers.`);
  const choice = checkedCoordinator(coordinator);
  if (!choice) throw refuse("invalid_choice", INVALID_CHOICE);
  const checkout = await realpath(projectRoot);
  if (!await initiativeExists(checkout, initiative)) throw refuse("unknown_initiative", `No initiative ${String(initiative)} exists in this checkout.`);
  return launchSession({ checkout, subject: { initiative, migrationRun: null }, host, coordinator: choice, answeredGate, env });
}
async function startMigrationLaunch({ projectRoot, migrationRun, host, coordinator = null, access = "read-only", env = process.env }) {
  if (!hostDefinition(host)) throw refuse("unknown_host", `Prism cannot launch ${String(host)}: the hosts are claude-code and codex.`);
  const choice = checkedCoordinator(coordinator);
  if (!choice) throw refuse("invalid_choice", INVALID_CHOICE);
  if (typeof migrationRun !== "string" || !/^run-[0-9a-f]{16}$/.test(migrationRun)) throw refuse("unknown_migration_run", `No format migration run ${String(migrationRun)} exists.`);
  const checkout = await realpath(projectRoot);
  return launchSession({ checkout, subject: { initiative: null, migrationRun }, host, coordinator: choice, access: access === "full" ? "full" : "read-only", readRoots: host === "codex" ? await migrationReadRoots(checkout, host, env, (await resolveHost(host, env))?.executable ?? null) : [], env });
}
const PRISM_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
async function migrationReadRoots(checkout, host, env = process.env, executable = null) {
  const home = os.homedir();
  const hostHome = host === "codex" ? env.CODEX_HOME || path.join(home, ".codex") : env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const roots = [];
  const install = executable && path.isAbsolute(executable) ? await installFolders(executable) : [];
  for (const candidate of [PRISM_ROOT, path.join(hostHome, "plugins", "cache"), ...install]) {
    let real;
    try {
      real = await realpath(candidate);
      if (!(await stat(real)).isDirectory()) continue;
    } catch {
      continue;
    }
    const inside = (folder) => real === folder || real.startsWith(`${folder}${path.sep}`);
    const holds = (folder) => folder.startsWith(`${real}${path.sep}`);
    if (!inside(checkout) && !holds(checkout) && !roots.some(inside)) roots.push(real);
  }
  return roots;
}
async function installFolders(executable) {
  const folders = /* @__PURE__ */ new Set();
  let current = path.resolve(executable);
  for (let hops = 0; hops < 40; hops += 1) {
    const parts2 = current.split(path.sep);
    let link = -1;
    for (let index = 1; index < parts2.length && link < 0; index += 1) {
      const prefix = parts2.slice(0, index + 1).join(path.sep) || path.sep;
      if ((await lstat(prefix).catch(() => null))?.isSymbolicLink()) link = index;
    }
    if (link < 0) break;
    const holder = parts2.slice(0, link).join(path.sep) || path.sep;
    folders.add(holder);
    const target = await readlink(parts2.slice(0, link + 1).join(path.sep)).catch(() => null);
    if (target === null) return [];
    current = path.resolve(holder, target, ...parts2.slice(link + 1));
  }
  let real;
  try {
    real = await realpath(executable);
  } catch {
    return [];
  }
  const parts = real.split(path.sep);
  const modules = parts.lastIndexOf("node_modules");
  folders.add(modules >= 0 && parts[modules + 1]?.startsWith("@") ? parts.slice(0, modules + 2).join(path.sep) : path.dirname(real));
  return [...folders];
}
async function launchSession({ checkout, subject, host, coordinator, access = "full", readRoots = [], answeredGate = null, env }) {
  const resolved = await resolveHost(host, env);
  if (!resolved.available) throw refuse("host_unavailable", resolved.reason);
  const store = await storeLocation(checkout);
  return withLaunchLock(env, async () => {
    if (await otherRunning(env, { ...subject, store })) throw refuse("launch_running", subjectRunningMessage(subject));
    const id = newLaunchId();
    const folder = await createLaunchFolder(env, id);
    let workdir = null;
    try {
      if (subject.migrationRun) workdir = await createLaunchWorkFolder(env, id, checkout);
    } catch (error) {
      await removeLaunchFolder(folder);
      throw error;
    }
    const record = {
      id,
      initiative: subject.initiative,
      ...subject.migrationRun ? { migrationRun: subject.migrationRun, access, readRoots, workdir } : {},
      host,
      checkout,
      store,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      hostSessionId: host === "claude-code" ? randomUUID() : null,
      coordinator,
      // A launch that continues an answered gate names it in its first run's start, so the orchestrate skill acts on that answer first.
      ...answeredGate === null ? {} : { answeredGate },
      runs: []
    };
    await writeLaunchRecord(folder, record);
    try {
      return { launch: await startRun({ folder, record, env, cause: "launch" }) };
    } catch (error) {
      await removeLaunchFolder(folder, record);
      throw error;
    }
  });
}
const ASKER_RUNNING = "The session is open, so a resume would run beside it.";
async function hostSessionRunning(env, hostSessionId, except = null) {
  const now = Date.now();
  return (await listLaunchRecords(env)).some(({ record }) => record && record.id !== except && record.hostSessionId === hostSessionId && launchRunning(record, now));
}
async function startAskerResume({ checkout: kept, host, hostSessionId, resume, env = process.env }) {
  if (host !== "claude-code" && host !== "codex") throw refuse("unknown_host", `${hostDefinition(host, env)?.label ?? String(host)} does not let Prism resume a session by its id.`);
  if (!validHostSessionId(hostSessionId)) throw refuse("no_host_session", "Prism kept no session id for it.");
  const asker = askerResumeOf(resume);
  if (!asker) throw refuse("invalid_gate", "The answered gate is not a gate id that Prism records.");
  const checkout = await realpath(kept).catch(() => null);
  if (!checkout) throw refuse("launch_failed", `The checkout ${kept} of the session that asked no longer exists.`);
  const resolved = await resolveHost(host, env);
  if (!resolved.available) throw refuse("host_unavailable", resolved.reason);
  const store = await storeLocation(checkout);
  return withLaunchLock(env, async () => {
    if (await otherRunning(env, { initiative: asker.initiative, store })) throw refuse("launch_running", runningMessage(asker.initiative));
    if (await hostSessionRunning(env, hostSessionId)) throw refuse("launch_running", ASKER_RUNNING);
    const id = newLaunchId();
    const folder = await createLaunchFolder(env, id);
    const record = {
      id,
      initiative: asker.initiative,
      host,
      checkout,
      store,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      hostSessionId,
      coordinator: checkedCoordinator(null),
      // Every run of a resumed asker continues its own session under the kept id; only its first tells it that its gate has an answer.
      askerResume: asker,
      runs: []
    };
    await writeLaunchRecord(folder, record);
    try {
      return { launch: await startRun({ folder, record, env, cause: "launch" }) };
    } catch (error) {
      await removeLaunchFolder(folder, record);
      throw error;
    }
  });
}
const unknownLaunch = (id) => refuse("unknown_launch", `No launched session ${String(id)} exists on this machine.`);
async function resumeLocked(env, folder, id, cause) {
  const record = await readLaunchRecord(folder);
  if (!record) throw unknownLaunch(id);
  if (launchRunning(record)) throw refuse("launch_running", "The session is running.");
  if (await otherRunning(env, { ...subjectOf(record), store: record.store, except: id })) throw refuse("launch_running", subjectRunningMessage(subjectOf(record)));
  if (!validHostSessionId(record.hostSessionId)) throw refuse("no_host_session", "The session never reported its host session id, so it cannot be resumed.");
  if (await hostSessionRunning(env, record.hostSessionId, id)) throw refuse("launch_running", ASKER_RUNNING);
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
  if (await otherRunning(env, { ...subjectOf(record), store: record.store, except: id })) return subjectRunningMessage(subjectOf(record));
  if (!validHostSessionId(record.hostSessionId)) return "The session never reported its host session id, so it cannot be resumed.";
  if (await hostSessionRunning(env, record.hostSessionId, id)) return ASKER_RUNNING;
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
async function launchEndReason({ id, env = process.env }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return null;
  const record = await readLaunchRecord(launchFolder(env, id));
  if (!record) return null;
  const status = lastRunStatus(record);
  if (status === "lost") return SUPERVISION_LOST;
  if (status !== "ended") return null;
  const view = launchView(record);
  const run = record.runs.at(-1);
  const exit = run.exit?.signal ? `signal ${run.exit.signal}` : `exit code ${run.exit?.code ?? "unknown"}`;
  return view.reason ?? (view.state === "stopped" ? `${view.hostLabel} was stopped.` : `${view.hostLabel} ended with ${exit}.`);
}
async function migrationRunRunning({ projectRoot, migrationRun, env = process.env }) {
  const store = await storeLocation(await realpath(projectRoot));
  return otherRunning(env, { migrationRun, store });
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
    await addGateMarks(found.folder, ids);
    return true;
  });
}
async function addGateMarks(folder, ids) {
  const current = await readGateRecord(folder);
  const at = (/* @__PURE__ */ new Date()).toISOString();
  const known = new Set(current.marks.map((mark) => mark.gate));
  await writeGateRecord(folder, { ...current, marks: [...current.marks, ...ids.filter((gate) => !known.has(gate)).map((gate) => ({ gate, at }))] });
}
async function markLaunchPause({ projectRoot, initiative, env = process.env }) {
  const found = await launchOf(env, env.PRISM_LAUNCH, { projectRoot, initiative });
  if (!found) return false;
  return withLaunchLock(env, async () => {
    if (!await readLaunchRecord(found.folder)) return false;
    const marks = await readResultMarks(found.folder);
    await writeResultMarks(found.folder, { ...marks, pauses: [...marks.pauses, { at: (/* @__PURE__ */ new Date()).toISOString() }] });
    return true;
  });
}
async function markResultCheck({ id, token, env = process.env }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return;
  const folder = launchFolder(env, id);
  await withLaunchLock(env, async () => {
    const marks = await readResultMarks(folder);
    await writeResultMarks(folder, { ...marks, checks: [...marks.checks.filter((check) => check.run !== token), { run: token, pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() }] });
  });
}
const NEWER_RUN = "A newer run of this launched session ended without a result.";
const SUPERSEDED = "A newer run of this launched session started before Prism recorded this question.";
async function changeGates(record, operationsOf) {
  const { readCoordinationState: read, updateCoordinationState } = await import("../workflow/state.mjs");
  let failure = "The coordination state kept changing.";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const current = await read({ projectRoot: record.checkout, initiative: record.initiative });
      const pending = current.valid && Array.isArray(current.state?.pending) ? current.state.pending : [];
      const result = await updateCoordinationState({ projectRoot: record.checkout, initiative: record.initiative, expectedRevision: current.revision ?? null, changes: { gateOperations: operationsOf(pending) } });
      return { opened: Array.isArray(result.openedGates) ? result.openedGates : [] };
    } catch (error) {
      failure = typeof error?.message === "string" && error.message ? error.message : String(error);
      if (error?.code !== "revision_conflict") break;
    }
  }
  return { failure };
}
async function askNoResultGate(record, earlier, lastMessage, env) {
  const label = hostDefinition(record.host, env)?.label ?? record.host;
  const ask = { op: "ask", kind: "assistance", question: noResultQuestion(label, record.initiative), context: noResultContext(lastMessage), artifacts: [] };
  const changed = await changeGates(record, (pending) => [
    ...pending.filter((gate2) => gate2 && earlier.includes(gate2.id) && !gate2.answer && isNoResultGate(gate2)).map((gate2) => ({ op: "resolve", id: gate2.id, reason: NEWER_RUN })),
    ask
  ]);
  if ("failure" in changed) return { failure: changed.failure };
  const gate = changed.opened.at(-1)?.id;
  return typeof gate === "string" && GATE_ID_PATTERN.test(gate) ? { gate } : { failure: "The coordination state named no new gate." };
}
const ARCHIVED = "The person archived the launched session.";
const RUNS_AGAIN = "The launched session runs again.";
async function withdrawNoResultGates(folder, record, reason) {
  const gates = new Set(noResultGates(await readResultMarks(folder)));
  if (!gates.size) return;
  const unanswered = (pending) => pending.filter((gate) => gate && gates.has(gate.id) && !gate.answer);
  const read = await readCoordinationState({ projectRoot: record.checkout, initiative: record.initiative }).catch(() => null);
  if (!unanswered(read?.valid && Array.isArray(read.state?.pending) ? read.state.pending : []).length) return;
  await changeGates(record, (pending) => unanswered(pending).map((gate) => ({ op: "resolve", id: gate.id, reason })));
}
async function withdrawRunQuestions({ id, env = process.env }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return;
  const folder = launchFolder(env, id);
  const record = await readLaunchRecord(folder);
  if (record) await withdrawNoResultGates(folder, record, RUNS_AGAIN);
}
async function withdrawSessionQuestions({ sessionId, env = process.env }) {
  if (!validHostSessionId(sessionId)) return false;
  let found = false;
  for (const { folder, record } of await listLaunchRecords(env)) {
    if (!record || record.host !== "claude-code" && record.host !== "codex" || record.hostSessionId !== sessionId) continue;
    found = true;
    await withdrawNoResultGates(folder, record, RUNS_AGAIN);
  }
  return found;
}
async function rememberHostGate(record, gate, env) {
  if (record.host !== "claude-code" && record.host !== "codex" || !validHostSessionId(record.hostSessionId)) return;
  const { noticeDirectory, rememberAskedGates } = await import("../workflow/change-notices.mjs");
  const { holderOf } = await import("../workflow/slice-claims.mjs");
  await rememberAskedGates({ projectRoot: record.checkout, initiative: record.initiative, gateIds: [gate], session: holderOf(record.hostSessionId), directory: noticeDirectory(env) }).catch(() => {
  });
}
async function stillLastRun(folder, token) {
  const record = await readLaunchRecord(folder);
  const last = record?.runs.at(-1);
  return Boolean(last && last.token === token && !last.stopRequestedAt) && (await readStopRequest(folder))?.token !== token;
}
async function settleRunResult({ id, token, normal, resumed, lastMessage, env = process.env }) {
  if (typeof id !== "string" || !LAUNCH_ID_PATTERN.test(id)) return;
  const folder = launchFolder(env, id);
  let mark = null;
  let settled = false;
  try {
    const record = await readLaunchRecord(folder);
    const run = record?.runs.find((entry) => entry.token === token);
    const ended = run && run === record.runs.at(-1) && run.endedAt && !run.stopRequestedAt && run.exit?.code === 0 && !run.exit?.signal && typeof run.failure !== "string" && typeof run.hostError !== "string" && !(Array.isArray(run.refusals) && run.refusals.length) && !(run.refusalCount > 0);
    if (!normal || resumed || !ended || (await readStopRequest(folder))?.token === token) return;
    const marks = await readResultMarks(folder);
    if (await runHasResult({ checkout: record.checkout, initiative: record.initiative, since: run.startedAt, until: run.endedAt, pauses: marks.pauses })) return;
    const asked = await askNoResultGate(record, noResultGates(marks), lastMessage, env);
    if (!("gate" in asked)) {
      mark = { run: token, gate: null, failure: asked.failure, at: (/* @__PURE__ */ new Date()).toISOString() };
      return;
    }
    const gate = asked.gate;
    const current = await withLaunchLock(env, async () => {
      const latest = await readResultMarks(folder);
      const checks = latest.checks.filter((check) => check.run !== token);
      if (!await stillLastRun(folder, token)) {
        await writeResultMarks(folder, { ...latest, checks });
        return false;
      }
      await rememberHostGate(record, gate, env);
      const noResult = [...latest.noResult.filter((item) => item.run !== token), { run: token, gate, failure: null, at: (/* @__PURE__ */ new Date()).toISOString() }];
      await writeResultMarks(folder, { ...latest, checks, noResult });
      await addGateMarks(folder, [gate]);
      return true;
    });
    settled = true;
    if (!current) {
      await changeGates(record, (pending) => pending.some((item) => item?.id === gate && !item.answer) ? [{ op: "resolve", id: gate, reason: SUPERSEDED }] : []);
    }
  } finally {
    if (!settled) {
      await withLaunchLock(env, async () => {
        const marks = await readResultMarks(folder);
        await writeResultMarks(folder, { ...marks, checks: marks.checks.filter((check) => check.run !== token), noResult: mark ? [...marks.noResult.filter((item) => item.run !== token), mark] : marks.noResult });
      }).catch(() => {
      });
    }
  }
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
    if (typeof initiative !== "string") return Promise.resolve([]);
    if (!pendingOf.has(initiative)) {
      pendingOf.set(initiative, readCoordinationState({ projectRoot: checkout, initiative }).then((read) => read.valid ? read.state?.pending ?? [] : []).catch(() => []));
    }
    return pendingOf.get(initiative);
  };
  const viewOf = async (folder, record) => {
    const gates = await readGateRecord(folder);
    const results = await readResultMarks(folder);
    return launchView(record, { now: at, gates: gateFacts(gates, await pending(record.initiative), noResultGates(results)), permission: (await launchRequests(folder, record, at))[0] ?? null, results });
  };
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
      if (expired(current, at)) await removeLaunchFolder(folder, current);
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
  const archived = await withLaunchLock(env, async () => {
    const at = Date.now();
    const found = await pageLaunch(env, id, viewer, at);
    if (!found) throw unknownLaunch(id);
    if (!launchEnded(found.view.state)) throw notEnded();
    return await archiveLocked(found, at) ? found : null;
  });
  if (!archived) return { archived: [] };
  await withdrawNoResultGates(archived.folder, archived.record, ARCHIVED).catch(() => {
  });
  return { archived: [id] };
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
  const archived = await withLaunchLock(env, async () => {
    const at = Date.now();
    const found = [];
    for (const { record } of await listLaunchRecords(env)) {
      const launch = record ? await pageLaunch(env, record.id, viewer, at) : null;
      if (launch && launchEnded(launch.view.state)) found.push(launch);
    }
    found.sort((left, right) => (left.view.state === "failed" ? 0 : 1) - (right.view.state === "failed" ? 0 : 1) || byLaunch(left.view, right.view));
    const archived2 = [];
    for (const launch of found) if (await archiveLocked(launch, at)) archived2.push(launch);
    return archived2;
  });
  for (const launch of archived) await withdrawNoResultGates(launch.folder, launch.record, ARCHIVED).catch(() => {
  });
  return { archived: archived.map((launch) => launch.record.id) };
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
  hostSessionRunning,
  initiativeRunning,
  launchEndReason,
  launchRunStatus,
  runningMessage as launchRunningMessage,
  listLaunches,
  markLaunchGates,
  markLaunchPause,
  markResultCheck,
  migrationReadRoots,
  migrationRunRunning,
  resumeForAnswers,
  resumeLaunch,
  resumeRefusal,
  settleRunResult,
  startAskerResume,
  startLaunch,
  startMigrationLaunch,
  stopLaunch,
  unarchiveLaunch,
  withdrawRunQuestions,
  withdrawSessionQuestions
};
