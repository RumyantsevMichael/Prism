// Generated from src/server/session/launch-records.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { describeRecordStore } from "../workflow/record-store.mjs";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { checkedCoordinator, hostDefinition, redactSessionId, resumeCommandOf } from "./launch-hosts.mjs";
import { isAgentModel } from "./agent-models.mjs";
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
async function writeGateRecord(folder, { marks, answers }) {
  const value = { marks: marks.slice(-GATES_KEPT), answers: answers.slice(-GATES_KEPT) };
  await writeAtomically(path.join(folder, GATES_FILE), `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
}
function gateFacts(gates, pending) {
  const byId = /* @__PURE__ */ new Map();
  for (const gate of Array.isArray(pending) ? pending : []) {
    if (gate && typeof gate === "object" && typeof gate.id === "string") byId.set(gate.id, gate);
  }
  const recorded = new Set(gates.answers.map((answer) => answer.entry));
  let waitingGate = null;
  let elsewhere = false;
  for (const id of new Set(gates.marks.map((mark) => mark.gate))) {
    const gate = byId.get(id);
    if (!gate) continue;
    if (!gate.answer) waitingGate ??= id;
    else if (!(typeof gate.answer.entry === "string" && recorded.has(gate.answer.entry))) elsewhere = true;
  }
  return { waiting: waitingGate !== null, waitingGate, answerWaits: elsewhere };
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
function launchRunning(record, now = Date.now()) {
  return lastRunStatus(record, now) === "running";
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
function stateOf(record, status, label, gates) {
  const run = record.runs.at(-1);
  if (status === "running") return { state: gates.waiting ? "waiting" : "running", reason: null };
  if (status === "lost") return { state: "failed", reason: SUPERVISION_LOST };
  if (run.stopRequestedAt) return { state: "stopped", reason: null };
  if (typeof run.hostError === "string") return { state: "failed", reason: `${label} reported an error: ${run.hostError}` };
  const stderr = lastErrorLine(run.stderr);
  const tail = stderr ? ` ${stderr}` : "";
  if (run.exit?.signal) return { state: "failed", reason: `${label} ended by signal ${run.exit.signal}.${tail}` };
  if (run.exit && run.exit.code !== 0) return { state: "failed", reason: `${label} ended with exit code ${run.exit.code}.${tail}` };
  if (gates.waiting) return { state: "waiting", reason: null };
  const refusals = Array.isArray(run.refusals) ? run.refusals : [];
  if (refusals.length) {
    const [first] = refusals;
    const count = Number.isSafeInteger(run.refusalCount) && run.refusalCount > refusals.length ? run.refusalCount : refusals.length;
    const more = count > 1 ? ` (and ${count - 1} more)` : "";
    return { state: "blocked", reason: gates.answerWaits ? ANSWER_WAITS : `${label} refused ${first.tool}: ${first.reason}${more}` };
  }
  return { state: "finished", reason: gates.answerWaits ? ANSWER_WAITS : null };
}
function launchView(record, { now = Date.now(), gates = null } = {}) {
  const status = lastRunStatus(record, now);
  const label = hostDefinition(record.host)?.label ?? record.host;
  const facts = { waiting: gates?.waiting === true, answerWaits: status !== "running" && gates?.answerWaits === true };
  const { state, reason: hostText } = stateOf(record, status, label, facts);
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
    initiative: record.initiative,
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
    answerWaits: facts.answerWaits
  };
}
function expired(record, now = Date.now()) {
  const status = lastRunStatus(record, now);
  if (status === "running") return false;
  const end = lastEnd(record, status);
  if (status === "none") return !Number.isFinite(end) || now - end > UNSTARTED_STALE_MS;
  return Number.isFinite(end) && now - end > RETENTION_MS;
}
const ARCHIVE_FILE = "archive.json";
const ENDED_STATES = /* @__PURE__ */ new Set(["finished", "failed", "stopped", "blocked"]);
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
async function removeLaunchFolder(folder) {
  await rm(folder, { recursive: true, force: true });
}
export {
  ANSWER_WAITS,
  DEFAULT_STOP_GRACE_MS,
  GATES_KEPT,
  GATE_ID_PATTERN,
  HEARTBEAT_MS,
  HEARTBEAT_STALE_MS,
  LAUNCH_ID_PATTERN,
  LaunchError,
  RETENTION_MS,
  SUPERVISION_LOST,
  archivedNow,
  createLaunchFolder,
  expired,
  gateFacts,
  lastRunStatus,
  launchCoordinator,
  launchEnded,
  launchFolder,
  launchRunning,
  launchView,
  launchesDirectory,
  listLaunchRecords,
  newLaunchId,
  prepareLaunchesDirectory,
  processAlive,
  readArchiveMark,
  readGateRecord,
  readLaunchRecord,
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
  writeStopRequest
};
