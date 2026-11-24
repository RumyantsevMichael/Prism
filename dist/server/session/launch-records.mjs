// Generated from src/server/session/launch-records.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { describeRecordStore } from "../workflow/record-store.mjs";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { checkedCoordinator, hostDefinition, redactSessionId, resumeCommandOf } from "./launch-hosts.mjs";
import { isAgentModel } from "./agent-models.mjs";
import { isAcpHost } from "./acp-agents.mjs";
import { isNoResultGate } from "./run-result.mjs";
import { sessionHolder } from "../workflow/slice-claims.mjs";
const LAUNCH_ID_PATTERN = /^launch-[0-9a-f]{16}$/;
const RECORD_FILE = "launch.json";
const STOP_FILE = "stop.json";
const HEARTBEAT_MS = 5e3;
const HEARTBEAT_STALE_MS = 6e4;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1e3;
const UNSTARTED_STALE_MS = 6e4;
const STDERR_LINE_MAX = 300;
const SUPERVISION_LOST = "Prism stopped supervising this session; its host process may still run.";
const ANSWER_WAITS = "An answer given on another machine waits; resume this session here to continue.";
const GATES_FILE = "gates.json";
const GATE_ID_PATTERN = /^gate-[0-9a-f]{8,32}$/;
const ENTRY_ID_PATTERN = /^[0-9a-f]{32}$/;
const TOKEN_PATTERN = /^[0-9a-f]{16}$/;
const GATES_KEPT = 100;
const DEFAULT_STOP_GRACE_MS = 1e4;
function stopGraceMs(env = process.env) {
  const value = typeof env?.PRISM_LAUNCH_STOP_GRACE_MS === "string" ? env.PRISM_LAUNCH_STOP_GRACE_MS.trim() : "";
  return /^\d{1,9}$/.test(value) ? Number(value) : DEFAULT_STOP_GRACE_MS;
}
class LaunchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function newLaunchId() {
  return `launch-${randomBytes(8).toString("hex")}`;
}
function launchesDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), "launches");
}
function launchFolder(env, id) {
  return path.join(launchesDirectory(env), id);
}
const WORK_FOLDERS = "launch-work";
function launchWorkDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), WORK_FOLDERS);
}
const touches = (folder, other) => {
  const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
  return inside(folder, other) || inside(other, folder);
};
async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 448 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new LaunchError("launch_failed", `${directory} is not a folder Prism can keep launches in.`);
  if (process.platform !== "win32") {
    if (info.uid !== process.getuid()) throw new LaunchError("launch_failed", `${directory} belongs to another user.`);
    if ((info.mode & 63) !== 0) await chmod(directory, 448);
  }
}
async function prepareLaunchesDirectory(env) {
  await privateDirectory(reviewAppDirectory(env));
  await privateDirectory(launchesDirectory(env));
}
async function createLaunchFolder(env, id) {
  await prepareLaunchesDirectory(env);
  const folder = launchFolder(env, id);
  await mkdir(folder, { mode: 448 });
  if (process.platform !== "win32") await chmod(folder, 448);
  return folder;
}
async function createLaunchWorkFolder(env, id, checkout) {
  await prepareLaunchesDirectory(env);
  await privateDirectory(launchWorkDirectory(env));
  const created = path.join(launchWorkDirectory(env), id);
  await mkdir(created, { mode: 448 });
  if (process.platform !== "win32") await chmod(created, 448);
  const folder = await realpath(created);
  if (touches(folder, checkout)) {
    await rm(created, { recursive: true, force: true });
    throw new LaunchError("launch_failed", `The working folder ${folder} of a format migration run's session would reach the checkout ${checkout}; keep the review app folder outside the project.`);
  }
  return folder;
}
const RUN_START_LOCK = "run-start";
const RUN_START_LOCK_TIMEOUT_MS = 1e4;
const VOIDED_TOKENS_KEPT = 16;
function withRunStartLock(folder, action) {
  return withFileLock(path.join(folder, RUN_START_LOCK), action, (code, message) => new LaunchError(code === "lock_timeout" ? "launch_failed" : code, message), { timeoutMs: RUN_START_LOCK_TIMEOUT_MS });
}
function tokenVoided(record, token) {
  return Array.isArray(record?.voidedTokens) && record.voidedTokens.includes(token);
}
function voidToken(record, token) {
  record.voidedTokens = [...Array.isArray(record.voidedTokens) ? record.voidedTokens : [], token].slice(-VOIDED_TOKENS_KEPT);
}
const ANSWERED_GATE_PATTERN = /^(gate|approval)-[0-9a-f]{8,32}$/;
async function readLaunchRecord(folder) {
  try {
    const info = await lstat(path.join(folder, RECORD_FILE));
    if (!info.isFile()) return null;
    const value = JSON.parse(await readFile(path.join(folder, RECORD_FILE), "utf8"));
    return value && typeof value === "object" && LAUNCH_ID_PATTERN.test(value.id) && Array.isArray(value.runs) ? value : null;
  } catch {
    return null;
  }
}
function launchCoordinator(record) {
  return checkedCoordinator(record?.coordinator);
}
async function writeLaunchRecord(folder, record) {
  await writeAtomically(path.join(folder, RECORD_FILE), `${JSON.stringify(record, null, 2)}
`, { mode: 384 });
}
async function writeStopRequest(folder, token) {
  await writeAtomically(path.join(folder, STOP_FILE), `${JSON.stringify({ token, requestedAt: (/* @__PURE__ */ new Date()).toISOString() })}
`, { mode: 384 });
}
async function readStopRequest(folder) {
  try {
    const info = await lstat(path.join(folder, STOP_FILE));
    if (!info.isFile()) return null;
    const value = JSON.parse(await readFile(path.join(folder, STOP_FILE), "utf8"));
    return value && typeof value.token === "string" ? value : null;
  } catch {
    return null;
  }
}
async function readGateRecord(folder) {
  let value = null;
  try {
    const info = await lstat(path.join(folder, GATES_FILE));
    if (info.isFile() && info.size <= 1024 * 1024) value = JSON.parse(await readFile(path.join(folder, GATES_FILE), "utf8"));
  } catch {
    value = null;
  }
  const list = (items) => (Array.isArray(items) ? items : []).slice(-GATES_KEPT);
  const marks = list(value?.marks).filter((mark) => mark && typeof mark.gate === "string" && GATE_ID_PATTERN.test(mark.gate) && typeof mark.at === "string" && mark.at.length <= 40).map((mark) => ({ gate: mark.gate, at: mark.at }));
  const answers = list(value?.answers).filter((answer) => answer && typeof answer.entry === "string" && ENTRY_ID_PATTERN.test(answer.entry) && typeof answer.gate === "string" && GATE_ID_PATTERN.test(answer.gate) && (answer.run === null || typeof answer.run === "string" && TOKEN_PATTERN.test(answer.run))).map((answer) => ({ entry: answer.entry, gate: answer.gate, run: answer.run, resumed: answer.resumed === true }));
  return { marks, answers };
}
const RESULTS_FILE = "results.json";
const FAILURE_MAX = 1e3;
const CHECK_STALE_MS = 10 * 60 * 1e3;
const NO_RESULT_UNRECORDED = (message) => `Prism could not record a question for this run: ${message}`;
const NO_RESULT_MARKS = Object.freeze({ pauses: [], checks: [], noResult: [] });
async function readResultMarks(folder) {
  let value = null;
  try {
    const info = await lstat(path.join(folder, RESULTS_FILE));
    if (info.isFile() && info.size <= 1024 * 1024) value = JSON.parse(await readFile(path.join(folder, RESULTS_FILE), "utf8"));
  } catch {
    value = null;
  }
  const list = (items) => (Array.isArray(items) ? items : []).slice(-GATES_KEPT);
  const at = (item) => typeof item?.at === "string" && item.at.length <= 40;
  const pauses = list(value?.pauses).filter(at).map((item) => ({ at: item.at }));
  const checks = list(value?.checks).filter((item) => at(item) && typeof item.run === "string" && TOKEN_PATTERN.test(item.run) && validPid(item.pid)).map((item) => ({ run: item.run, pid: item.pid, at: item.at }));
  const noResult = list(value?.noResult).filter((item) => at(item) && typeof item.run === "string" && TOKEN_PATTERN.test(item.run) && (item.gate === null || typeof item.gate === "string" && GATE_ID_PATTERN.test(item.gate)) && (item.failure === null || typeof item.failure === "string")).map((item) => ({ run: item.run, gate: item.gate, failure: item.failure === null ? null : String(item.failure).slice(0, FAILURE_MAX), at: item.at }));
  return { pauses, checks, noResult };
}
async function writeResultMarks(folder, { pauses, checks, noResult }) {
  const value = { pauses: pauses.slice(-GATES_KEPT), checks: checks.slice(-GATES_KEPT), noResult: noResult.slice(-GATES_KEPT) };
  await writeAtomically(path.join(folder, RESULTS_FILE), `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
}
const noResultGates = (marks) => (marks?.noResult ?? []).map((mark) => mark.gate).filter((gate) => gate !== null);
async function writeGateRecord(folder, { marks, answers }) {
  const value = { marks: marks.slice(-GATES_KEPT), answers: answers.slice(-GATES_KEPT) };
  await writeAtomically(path.join(folder, GATES_FILE), `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
}
function gateFacts(gates, pending, noResult = []) {
  const byId = /* @__PURE__ */ new Map();
  for (const gate of Array.isArray(pending) ? pending : []) {
    if (gate && typeof gate === "object" && typeof gate.id === "string") byId.set(gate.id, gate);
  }
  const recorded = new Set(gates.answers.map((answer) => answer.entry));
  const questions = new Set(noResult);
  let waitingGate = null;
  let elsewhere = false;
  for (const id of new Set(gates.marks.map((mark) => mark.gate))) {
    const gate = byId.get(id);
    if (!gate) continue;
    if (!gate.answer) {
      if (!questions.has(id) && !isNoResultGate(gate)) waitingGate ??= id;
    } else if (!(typeof gate.answer.entry === "string" && recorded.has(gate.answer.entry))) elsewhere = true;
  }
  const latest = noResult.at(-1) ?? null;
  const questionGate = latest !== null && byId.has(latest) && !byId.get(latest).answer ? latest : null;
  return { waiting: waitingGate !== null, waitingGate, answerWaits: elsewhere, questionGate };
}
async function listLaunchRecords(env) {
  const directory = launchesDirectory(env);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !LAUNCH_ID_PATTERN.test(entry.name)) continue;
    const folder = path.join(directory, entry.name);
    const record = await readLaunchRecord(folder);
    if (record && record.id === entry.name) found.push({ folder, record });
    else if (!record) found.push({ folder, record: null });
  }
  return found;
}
async function storeLocation(projectRoot) {
  const described = await describeRecordStore(projectRoot);
  if (!described.location) return `${described.kind}:${described.label}`;
  try {
    return await realpath(described.location);
  } catch {
    return path.resolve(described.location);
  }
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
const time = (value) => typeof value === "string" ? Date.parse(value) : Number.NaN;
function lastRunStatus(record, now = Date.now()) {
  const run = record.runs.at(-1);
  if (!run) return "none";
  if (run.endedAt) return "ended";
  const heartbeat = time(run.heartbeatAt);
  if (!processAlive(run.supervisorPid) || !(now - heartbeat <= HEARTBEAT_STALE_MS)) return "lost";
  return "running";
}
const STARTING_STALE_MS = 10 * 60 * 1e3;
function launchStarting(record, now = Date.now()) {
  const mark = record?.starting;
  if (typeof mark?.token !== "string" || tokenVoided(record, mark.token)) return false;
  if (record.runs.some((run) => run?.token === mark.token)) return false;
  return processAlive(mark.supervisorPid) && now - time(mark.at) <= STARTING_STALE_MS;
}
function launchRunning(record, now = Date.now()) {
  return lastRunStatus(record, now) === "running";
}
const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0;
function launchRunInUse(record, now = Date.now()) {
  const run = record?.runs?.at(-1);
  if (!run || run.endedAt) return false;
  const signs = [time(run.heartbeatAt), time(run.startedAt)].filter(Number.isFinite);
  if (signs.length && Math.max(...signs) < now - os.uptime() * 1e3) return false;
  if (validPid(run.supervisorPid) || validPid(run.hostPid)) return processAlive(run.supervisorPid) || processAlive(run.hostPid);
  return now - time(run.heartbeatAt) <= HEARTBEAT_STALE_MS;
}
function lastErrorLine(text) {
  if (typeof text !== "string") return null;
  const line = text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1);
  return line ? line.slice(0, STDERR_LINE_MAX) : null;
}
function lastEnd(record, status) {
  const run = record.runs.at(-1);
  if (!run) return time(record.createdAt);
  if (status === "ended") return time(run.endedAt);
  if (status === "lost") return time(run.heartbeatAt) || time(run.startedAt);
  return null;
}
const asksToAllow = (action) => `Asks you to allow: ${action}.`;
function stateOf(record, status, label, gates, permission, results, now) {
  const run = record.runs.at(-1);
  if (status === "running" && permission) return { state: "waiting", reason: asksToAllow(permission.action) };
  if (status === "running") return { state: gates.waiting ? "waiting" : "running", reason: null };
  if (status === "lost") return { state: "failed", reason: SUPERVISION_LOST };
  if (run.stopRequestedAt) return { state: "stopped", reason: null };
  if (typeof run.failure === "string") return { state: "failed", reason: run.failure };
  if (typeof run.hostError === "string") return { state: "failed", reason: `${label} reported an error: ${run.hostError}` };
  const stderr = lastErrorLine(run.stderr);
  const tail = stderr ? ` ${stderr}` : "";
  if (run.exit?.signal) return { state: "failed", reason: `${label} ended by signal ${run.exit.signal}.${tail}` };
  if (run.exit && (run.exit.code !== 0 || run.settled === false)) return { state: "failed", reason: `${label} ended with exit code ${run.exit.code}.${tail}` };
  if (gates.waiting) return { state: "waiting", reason: null };
  const refusals = Array.isArray(run.refusals) ? run.refusals : [];
  if (refusals.length) {
    const [first] = refusals;
    const count = Number.isSafeInteger(run.refusalCount) && run.refusalCount > refusals.length ? run.refusalCount : refusals.length;
    const more = count > 1 ? ` (and ${count - 1} more)` : "";
    return { state: "blocked", reason: gates.answerWaits ? ANSWER_WAITS : `${label} refused ${first.tool}: ${first.reason}${more}` };
  }
  if (results.checks.some((check) => check.run === run.token && processAlive(check.pid) && now - time(check.at) <= CHECK_STALE_MS)) return { state: "running", reason: null };
  const noResult = results.noResult.find((mark) => mark.run === run.token);
  if (noResult) return { state: "ended-without-result", reason: noResult.failure !== null ? NO_RESULT_UNRECORDED(noResult.failure) : gates.answerWaits ? ANSWER_WAITS : null, question: noResult.gate };
  return { state: "finished", reason: gates.answerWaits ? ANSWER_WAITS : null };
}
function launchView(record, { now = Date.now(), gates = null, permission = null, results = null } = {}) {
  const status = lastRunStatus(record, now);
  const label = hostDefinition(record.host)?.label ?? record.host;
  const facts = { waiting: gates?.waiting === true, answerWaits: status !== "running" && gates?.answerWaits === true };
  const { state, reason: hostText, question = null } = stateOf(record, status, label, facts, permission, results ?? NO_RESULT_MARKS, now);
  const reason = redactSessionId(hostText, record.hostSessionId);
  const runningMs = record.runs.reduce((sum, run, index) => {
    const start = time(run.startedAt);
    if (!Number.isFinite(start)) return sum;
    let end2 = time(run.endedAt);
    if (!Number.isFinite(end2)) end2 = index === record.runs.length - 1 && status === "running" ? now : time(run.heartbeatAt);
    return Number.isFinite(end2) ? sum + Math.max(0, end2 - start) : sum;
  }, 0);
  const ended = [...record.runs].reverse().find((run) => run.endedAt);
  const exit = status === "lost" ? null : ended?.exit ? { code: ended.exit.code ?? null, signal: ended.exit.signal ?? null } : null;
  const command = status === "running" ? null : resumeCommandOf(record.host, record.hostSessionId);
  const last = record.runs.at(-1);
  const end = status === "ended" || status === "lost" ? lastEnd(record, status) : Number.NaN;
  const holder = typeof record.hostSessionId === "string" ? sessionHolder({ CLAUDE_CODE_SESSION_ID: record.hostSessionId }) : null;
  const resumeCommand = command ? { command, cwd: record.checkout } : null;
  return {
    id: record.id,
    initiative: record.initiative ?? null,
    // Only a format migration run's session names its run, so an initiative's view keeps its fields.
    ...typeof record.migrationRun === "string" ? { migrationRun: record.migrationRun } : {},
    host: record.host,
    hostLabel: label,
    model: isAgentModel(last?.model) ? last.model : null,
    holder,
    checkout: record.checkout,
    launchedAt: record.runs[0]?.startedAt ?? null,
    runningMs,
    runs: record.runs.length,
    endedAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
    state,
    reason,
    exit,
    resumeCommand,
    waitingGate: state === "waiting" && typeof gates?.waitingGate === "string" ? gates.waitingGate : null,
    answerWaits: facts.answerWaits,
    questionGate: question !== null && gates?.questionGate === question ? question : null,
    ...isAcpHost(record.host) ? { usage: runUsage(last) } : {}
  };
}
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const USAGE_TOKENS = ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"];
function runUsage(run) {
  const usage = run?.usage && typeof run.usage === "object" ? run.usage : {};
  const tokens = usage.tokens && typeof usage.tokens === "object" ? Object.fromEntries(USAGE_TOKENS.filter((key) => finite(usage.tokens[key])).map((key) => [key, usage.tokens[key]])) : {};
  const context = finite(usage.context?.used) && finite(usage.context?.size) ? { used: usage.context.used, size: usage.context.size } : null;
  const cost = finite(usage.cost?.amount) && typeof usage.cost?.currency === "string" ? { amount: usage.cost.amount, currency: usage.cost.currency } : null;
  return { tokens: Object.keys(tokens).length ? tokens : null, context, cost };
}
function expired(record, now = Date.now()) {
  const status = lastRunStatus(record, now);
  if (status === "running") return false;
  const end = lastEnd(record, status);
  if (status === "none") return !Number.isFinite(end) || now - end > UNSTARTED_STALE_MS;
  return Number.isFinite(end) && now - end > RETENTION_MS;
}
const ARCHIVE_FILE = "archive.json";
const ENDED_STATES = /* @__PURE__ */ new Set(["finished", "ended-without-result", "failed", "stopped", "blocked"]);
function launchEnded(state) {
  return typeof state === "string" && ENDED_STATES.has(state);
}
async function readArchiveMark(folder) {
  try {
    const info = await lstat(path.join(folder, ARCHIVE_FILE));
    if (!info.isFile() || info.size > 4096) return null;
    const value = JSON.parse(await readFile(path.join(folder, ARCHIVE_FILE), "utf8"));
    if (!value || typeof value !== "object" || typeof value.archivedAt !== "string" || !Number.isFinite(Date.parse(value.archivedAt))) return null;
    if (!Number.isSafeInteger(value.runs) || value.runs < 1) return null;
    return { archivedAt: value.archivedAt, runs: value.runs };
  } catch {
    return null;
  }
}
async function writeArchiveMark(folder, { archivedAt, runs }) {
  const file = path.join(folder, ARCHIVE_FILE);
  await writeAtomically(file, `${JSON.stringify({ archivedAt, runs }, null, 2)}
`, { mode: 384 });
  if (process.platform !== "win32") await chmod(file, 384);
}
async function removeArchiveMark(folder) {
  await rm(path.join(folder, ARCHIVE_FILE), { force: true });
}
function archivedNow(mark, record, state) {
  return mark !== null && Array.isArray(record?.runs) && record.runs.length === mark.runs && launchEnded(state);
}
async function removeLaunchFolder(folder, record = null) {
  const work = record?.workdir;
  if (typeof work === "string" && path.isAbsolute(work) && path.basename(work) === record.id && path.basename(path.dirname(work)) === WORK_FOLDERS) await rm(work, { recursive: true, force: true });
  await rm(folder, { recursive: true, force: true });
}
export {
  ANSWERED_GATE_PATTERN,
  ANSWER_WAITS,
  DEFAULT_STOP_GRACE_MS,
  GATES_KEPT,
  GATE_ID_PATTERN,
  HEARTBEAT_MS,
  HEARTBEAT_STALE_MS,
  LAUNCH_ID_PATTERN,
  LaunchError,
  NO_RESULT_MARKS,
  NO_RESULT_UNRECORDED,
  RETENTION_MS,
  SUPERVISION_LOST,
  archivedNow,
  asksToAllow,
  createLaunchFolder,
  createLaunchWorkFolder,
  expired,
  gateFacts,
  lastRunStatus,
  launchCoordinator,
  launchEnded,
  launchFolder,
  launchRunInUse,
  launchRunning,
  launchStarting,
  launchView,
  launchWorkDirectory,
  launchesDirectory,
  listLaunchRecords,
  newLaunchId,
  noResultGates,
  prepareLaunchesDirectory,
  processAlive,
  readArchiveMark,
  readGateRecord,
  readLaunchRecord,
  readResultMarks,
  readStopRequest,
  removeArchiveMark,
  removeLaunchFolder,
  stopGraceMs,
  storeLocation,
  tokenVoided,
  voidToken,
  withRunStartLock,
  writeArchiveMark,
  writeGateRecord,
  writeLaunchRecord,
  writeResultMarks,
  writeStopRequest
};
