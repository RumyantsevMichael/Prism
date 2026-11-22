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
import { sessionHolder } from "../workflow/slice-claims.mjs";

// The record of each launched session lives in <review app folder>/launches/<launch id>/launch.json, private to the user.
// The host session id lives only there, and a launch view carries it only in its resumeCommand: host text in its reason has the id replaced.
// While a run runs, its supervisor is the only writer of the record.

export const LAUNCH_ID_PATTERN = /^launch-[0-9a-f]{16}$/;
const RECORD_FILE = "launch.json";
// A stop request names the token of the run it stops, so a request never reaches a later run.
const STOP_FILE = "stop.json";
export const HEARTBEAT_MS = 5000;
export const HEARTBEAT_STALE_MS = 60000;
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
// A launch folder whose supervisor never recorded a run is abandoned after this long.
const UNSTARTED_STALE_MS = 60000;
const STDERR_LINE_MAX = 300;
export const SUPERVISION_LOST = "Prism stopped supervising this session; its host process may still run.";
export const ANSWER_WAITS = "An answer given on another machine waits; resume this session here to continue.";
// The gates a launched session asked and the answers given to them on this machine, kept beside the record and written only under the launch lock.
const GATES_FILE = "gates.json";
export const GATE_ID_PATTERN = /^gate-[0-9a-f]{8,32}$/;
const ENTRY_ID_PATTERN = /^[0-9a-f]{32}$/;
const TOKEN_PATTERN = /^[0-9a-f]{16}$/;
// The marks and answers kept, the newest last; an older one gives way, so the file stays bounded whatever an agent asks.
export const GATES_KEPT = 100;
export const DEFAULT_STOP_GRACE_MS = 10000;

/** The grace period of a stop: PRISM_LAUNCH_STOP_GRACE_MS milliseconds, and 10000 without a valid value. */
export function stopGraceMs(env = process.env) {
  const value = typeof env?.PRISM_LAUNCH_STOP_GRACE_MS === "string" ? env.PRISM_LAUNCH_STOP_GRACE_MS.trim() : "";
  return /^\d{1,9}$/.test(value) ? Number(value) : DEFAULT_STOP_GRACE_MS;
}

export class LaunchError extends Error {
  declare code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function newLaunchId() {
  return `launch-${randomBytes(8).toString("hex")}`;
}

export function launchesDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), "launches");
}

export function launchFolder(env: NodeJS.ProcessEnv, id: string) {
  return path.join(launchesDirectory(env), id);
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new LaunchError("launch_failed", `${directory} is not a folder Prism can keep launches in.`);
  if (process.platform !== "win32") {
    if (info.uid !== process.getuid!()) throw new LaunchError("launch_failed", `${directory} belongs to another user.`);
    if ((info.mode & 0o077) !== 0) await chmod(directory, 0o700);
  }
}

/** Creates the private review app folder and the private launches folder in it. */
export async function prepareLaunchesDirectory(env: NodeJS.ProcessEnv) {
  await privateDirectory(reviewAppDirectory(env));
  await privateDirectory(launchesDirectory(env));
}

/** Creates one private launch folder in the launches folder. */
export async function createLaunchFolder(env: NodeJS.ProcessEnv, id: string) {
  await prepareLaunchesDirectory(env);
  const folder = launchFolder(env, id);
  await mkdir(folder, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(folder, 0o700);
  return folder;
}

// A supervisor starts its host only under this lock, after checking that its starter has not given up on its token,
// and a starter that gives up voids the token under the same lock, so a supervisor it gave up on never starts a host.
const RUN_START_LOCK = "run-start";
const RUN_START_LOCK_TIMEOUT_MS = 10000;
const VOIDED_TOKENS_KEPT = 16;

export function withRunStartLock(folder: string, action: any) {
  return withFileLock(path.join(folder, RUN_START_LOCK), action, (code, message) => new LaunchError(code === "lock_timeout" ? "launch_failed" : code, message), { timeoutMs: RUN_START_LOCK_TIMEOUT_MS });
}

export function tokenVoided(record: any, token: string) {
  return Array.isArray(record?.voidedTokens) && record.voidedTokens.includes(token);
}

export function voidToken(record: any, token: string) {
  record.voidedTokens = [...(Array.isArray(record.voidedTokens) ? record.voidedTokens : []), token].slice(-VOIDED_TOKENS_KEPT);
}

export async function readLaunchRecord(folder: string) {
  try {
    const info = await lstat(path.join(folder, RECORD_FILE));
    if (!info.isFile()) return null;
    const value = JSON.parse(await readFile(path.join(folder, RECORD_FILE), "utf8"));
    return value && typeof value === "object" && LAUNCH_ID_PATTERN.test(value.id) && Array.isArray(value.runs) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The coordinator's choice that a launch record keeps, { provider, model, effort, typed }, which every run of the launch passes to
 * its host; an earlier record without one reads as host defaults, and one that breaks the name rules reads as null and runs nothing.
 */
export function launchCoordinator(record: any) {
  return checkedCoordinator(record?.coordinator);
}

export async function writeLaunchRecord(folder: string, record: any) {
  await writeAtomically(path.join(folder, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Asks the supervisor of the run with this token to stop; the caller holds the launch lock. */
export async function writeStopRequest(folder: string, token: string) {
  await writeAtomically(path.join(folder, STOP_FILE), `${JSON.stringify({ token, requestedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
}

/** The stop request of the launch folder: { token, requestedAt }, or null. */
export async function readStopRequest(folder: string) {
  try {
    const info = await lstat(path.join(folder, STOP_FILE));
    if (!info.isFile()) return null;
    const value = JSON.parse(await readFile(path.join(folder, STOP_FILE), "utf8"));
    return value && typeof value.token === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The gate record of a launch folder: { marks: [{ gate, at }], answers: [{ entry, gate, run, resumed }] }, empty when absent,
 * keeping only well-formed entries, so nothing else that a file holds reaches a decision.
 */
export async function readGateRecord(folder: string) {
  let value = null;
  try {
    const info = await lstat(path.join(folder, GATES_FILE));
    if (info.isFile() && info.size <= 1024 * 1024) value = JSON.parse(await readFile(path.join(folder, GATES_FILE), "utf8"));
  } catch {
    value = null;
  }
  const list = (items: any) => (Array.isArray(items) ? items : []).slice(-GATES_KEPT);
  const marks = list(value?.marks)
    .filter((mark) => mark && typeof mark.gate === "string" && GATE_ID_PATTERN.test(mark.gate) && typeof mark.at === "string" && mark.at.length <= 40)
    .map((mark) => ({ gate: mark.gate, at: mark.at }));
  const answers = list(value?.answers)
    .filter((answer) => answer && typeof answer.entry === "string" && ENTRY_ID_PATTERN.test(answer.entry) && typeof answer.gate === "string" && GATE_ID_PATTERN.test(answer.gate)
      && (answer.run === null || (typeof answer.run === "string" && TOKEN_PATTERN.test(answer.run))))
    .map((answer) => ({ entry: answer.entry, gate: answer.gate, run: answer.run, resumed: answer.resumed === true }));
  return { marks, answers };
}

// The result marks of a launched session, kept beside its record on this machine only and written only under the launch lock:
// { pauses: [{ at }], checks: [{ run, pid, at }], noResult: [{ run, gate, failure, at }] }. A pause is one that a run of the launch
// recorded; a check is a supervisor that checks whether its run ended with a result; a no-result mark is a run that ended normally
// without a result, with the id of its no-result gate, or null and why Prism could not record it.
const RESULTS_FILE = "results.json";
const FAILURE_MAX = 1000;
// A check whose supervisor started it this long ago no longer counts, so a reused process id never holds the run as running.
const CHECK_STALE_MS = 10 * 60 * 1000;
export const NO_RESULT_UNRECORDED = (message: string) => `Prism could not record a question for this run: ${message}`;

export interface ResultMarks {
  pauses: { at: string }[];
  checks: { run: string; pid: number; at: string }[];
  noResult: { run: string; gate: string | null; failure: string | null; at: string }[];
}

export const NO_RESULT_MARKS: ResultMarks = Object.freeze({ pauses: [], checks: [], noResult: [] }) as ResultMarks;

/** The result marks of a launch folder, empty when absent, keeping only well-formed entries, so nothing else that a file holds reaches a decision. */
export async function readResultMarks(folder: string): Promise<ResultMarks> {
  let value = null;
  try {
    const info = await lstat(path.join(folder, RESULTS_FILE));
    if (info.isFile() && info.size <= 1024 * 1024) value = JSON.parse(await readFile(path.join(folder, RESULTS_FILE), "utf8"));
  } catch {
    value = null;
  }
  const list = (items: any) => (Array.isArray(items) ? items : []).slice(-GATES_KEPT);
  const at = (item: any) => typeof item?.at === "string" && item.at.length <= 40;
  const pauses = list(value?.pauses).filter(at).map((item) => ({ at: item.at }));
  const checks = list(value?.checks).filter((item) => at(item) && typeof item.run === "string" && TOKEN_PATTERN.test(item.run) && validPid(item.pid))
    .map((item) => ({ run: item.run, pid: item.pid, at: item.at }));
  const noResult = list(value?.noResult)
    .filter((item) => at(item) && typeof item.run === "string" && TOKEN_PATTERN.test(item.run) && (item.gate === null || (typeof item.gate === "string" && GATE_ID_PATTERN.test(item.gate)))
      && (item.failure === null || typeof item.failure === "string"))
    .map((item) => ({ run: item.run, gate: item.gate, failure: item.failure === null ? null : String(item.failure).slice(0, FAILURE_MAX), at: item.at }));
  return { pauses, checks, noResult };
}

/** Writes the result marks of a launch folder, keeping the newest of each kind; the caller holds the launch lock. */
export async function writeResultMarks(folder: string, { pauses, checks, noResult }: ResultMarks) {
  const value = { pauses: pauses.slice(-GATES_KEPT), checks: checks.slice(-GATES_KEPT), noResult: noResult.slice(-GATES_KEPT) };
  await writeAtomically(path.join(folder, RESULTS_FILE), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** The no-result gate ids that a launch's marks name. */
export const noResultGates = (marks: ResultMarks | null) => (marks?.noResult ?? []).map((mark) => mark.gate).filter((gate): gate is string => gate !== null);

/** Writes the gate record of a launch folder, keeping the newest marks and answers; the caller holds the launch lock. */
export async function writeGateRecord(folder: string, { marks, answers }: { marks: any[]; answers: any[] }) {
  const value = { marks: marks.slice(-GATES_KEPT), answers: answers.slice(-GATES_KEPT) };
  await writeAtomically(path.join(folder, GATES_FILE), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * What the coordination state says about the gates a launch marked: { waiting, waitingGate, answerWaits, questionGate }.
 * A gate counts as marked while its mark exists and it is pending; it waits while it has no answer, and an answer whose history entry
 * this machine did not record came through the record store from another machine. waitingGate is the id of the first gate, in the
 * order the launch marked them, that waits, or null. A no-result gate of the launch, named in noResult, never makes it wait:
 * questionGate is the id of the launch's latest no-result gate while that gate is pending without an answer, or null.
 */
export function gateFacts(gates: any, pending: any, noResult: string[] = []) {
  const byId = new Map<string, any>();
  for (const gate of Array.isArray(pending) ? pending : []) {
    if (gate && typeof gate === "object" && typeof gate.id === "string") byId.set(gate.id, gate);
  }
  const recorded = new Set(gates.answers.map((answer: any) => answer.entry));
  const questions = new Set(noResult);
  let waitingGate: string | null = null as string | null;
  let elsewhere = false;
  for (const id of new Set<string>(gates.marks.map((mark: any) => mark.gate))) {
    const gate = byId.get(id);
    if (!gate) continue;
    if (!gate.answer) {
      if (!questions.has(id)) waitingGate ??= id;
    } else if (!(typeof gate.answer.entry === "string" && recorded.has(gate.answer.entry))) elsewhere = true;
  }
  const latest = noResult.at(-1) ?? null;
  const questionGate = latest !== null && byId.has(latest) && !byId.get(latest).answer ? latest : null;
  return { waiting: waitingGate !== null, waitingGate, answerWaits: elsewhere, questionGate };
}

/** Every launch folder on this machine with its record: [{ folder, record }], skipping unreadable ones. */
export async function listLaunchRecords(env: NodeJS.ProcessEnv) {
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

/** The store location that decides which checkouts share launched sessions. */
export async function storeLocation(projectRoot: string) {
  const described = await describeRecordStore(projectRoot);
  if (!described.location) return `${described.kind}:${described.label}`;
  try {
    return await realpath(described.location);
  } catch {
    return path.resolve(described.location);
  }
}

export function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) : Number.NaN);

/** How the last run of a record stands: "none", "running", "lost", or "ended". */
export function lastRunStatus(record: any, now = Date.now()) {
  const run = record.runs.at(-1);
  if (!run) return "none";
  if (run.endedAt) return "ended";
  const heartbeat = time(run.heartbeatAt);
  if (!processAlive(run.supervisorPid) || !(now - heartbeat <= HEARTBEAT_STALE_MS)) return "lost";
  return "running";
}

// A supervisor that marked a start this long ago no longer counts as starting, so a reused process id never holds a start forever.
const STARTING_STALE_MS = 10 * 60 * 1000;

/**
 * Whether a live supervisor is starting a run of the record that it has not recorded yet: it marked the start in `starting` before it
 * read which host or agent version to start, and the run record that names its token replaces the mark.
 */
export function launchStarting(record: any, now = Date.now()) {
  const mark = record?.starting;
  if (typeof mark?.token !== "string" || tokenVoided(record, mark.token)) return false;
  if (record.runs.some((run: any) => run?.token === mark.token)) return false;
  return processAlive(mark.supervisorPid) && now - time(mark.at) <= STARTING_STALE_MS;
}

/** Whether one of the record's runs runs under a live supervisor. */
export function launchRunning(record: any, now = Date.now()) {
  return lastRunStatus(record, now) === "running";
}

const validPid = (pid: unknown) => Number.isSafeInteger(pid) && (pid as number) > 0;

/**
 * Whether the record's last run still runs for the purpose of keeping the files it runs from: it has not ended and its supervisor or
 * host process is alive, whatever its heartbeat age, since a late heartbeat, as right after the computer wakes from sleep, does not
 * end a run; only when neither process can be checked does a heartbeat older than the stale age count it as ended.
 * A run whose last heartbeat came before the computer last started ended with it, so a process that later took its supervisor's or
 * host's process id never keeps it; the computer's uptime counts time asleep, so waking does not end a run.
 */
export function launchRunInUse(record: any, now = Date.now()) {
  const run = record?.runs?.at(-1);
  if (!run || run.endedAt) return false;
  const signs = [time(run.heartbeatAt), time(run.startedAt)].filter(Number.isFinite);
  if (signs.length && Math.max(...signs) < now - os.uptime() * 1000) return false;
  if (validPid(run.supervisorPid) || validPid(run.hostPid)) return processAlive(run.supervisorPid) || processAlive(run.hostPid);
  return now - time(run.heartbeatAt) <= HEARTBEAT_STALE_MS;
}

function lastErrorLine(text: string) {
  if (typeof text !== "string") return null;
  const line = text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1);
  return line ? line.slice(0, STDERR_LINE_MAX) : null;
}

/** The end of the last run as a time, or null while it runs or was never recorded and its supervisor's last sign of life otherwise. */
function lastEnd(record: any, status: string): number | null {
  const run = record.runs.at(-1);
  if (!run) return time(record.createdAt);
  if (status === "ended") return time(run.endedAt);
  if (status === "lost") return time(run.heartbeatAt) || time(run.startedAt);
  return null;
}

export const asksToAllow = (action: string) => `Asks you to allow: ${action}.`;

function stateOf(record: any, status: any, label: string, gates: any, permission: { action: string } | null, results: ResultMarks, now: number) {
  const run = record.runs.at(-1);
  // A run that waits on a permission request waits on the person before any gate.
  if (status === "running" && permission) return { state: "waiting", reason: asksToAllow(permission.action) };
  if (status === "running") return { state: gates.waiting ? "waiting" : "running", reason: null };
  if (status === "lost") return { state: "failed", reason: SUPERVISION_LOST };
  if (run.stopRequestedAt) return { state: "stopped", reason: null };
  // A failure Prism found in the run, such as an ACP agent's stop reason or an option it does not offer, is already a sentence.
  if (typeof run.failure === "string") return { state: "failed", reason: run.failure };
  // A reported host error comes before the exit code, since Claude Code exits 1 after an error result.
  if (typeof run.hostError === "string") return { state: "failed", reason: `${label} reported an error: ${run.hostError}` };
  const stderr = lastErrorLine(run.stderr);
  const tail = stderr ? ` ${stderr}` : "";
  if (run.exit?.signal) return { state: "failed", reason: `${label} ended by signal ${run.exit.signal}.${tail}` };
  // An ACP run that never settled, as when its agent exits before its prompt answers, fails with its exit status even when that is 0.
  if (run.exit && (run.exit.code !== 0 || run.settled === false)) return { state: "failed", reason: `${label} ended with exit code ${run.exit.code}.${tail}` };
  if (gates.waiting) return { state: "waiting", reason: null };
  const refusals = Array.isArray(run.refusals) ? run.refusals : [];
  if (refusals.length) {
    const [first] = refusals;
    // A run records only its first refusals, with the number of all of them; a record without that number counts those it holds.
    const count = Number.isSafeInteger(run.refusalCount) && run.refusalCount > refusals.length ? run.refusalCount : refusals.length;
    const more = count > 1 ? ` (and ${count - 1} more)` : "";
    return { state: "blocked", reason: gates.answerWaits ? ANSWER_WAITS : `${label} refused ${first.tool}: ${first.reason}${more}` };
  }
  // A run whose supervisor still checks whether it ended with a result shows as running until the check is done.
  if (results.checks.some((check) => check.run === run.token && processAlive(check.pid) && now - time(check.at) <= CHECK_STALE_MS)) return { state: "running", reason: null };
  const noResult = results.noResult.find((mark) => mark.run === run.token);
  if (noResult) return { state: "ended-without-result", reason: noResult.failure !== null ? NO_RESULT_UNRECORDED(noResult.failure) : gates.answerWaits ? ANSWER_WAITS : null, question: noResult.gate };
  return { state: "finished", reason: gates.answerWaits ? ANSWER_WAITS : null };
}

/**
 * The launch view of a record: { id, initiative, host, hostLabel, model, holder, checkout, launchedAt, runningMs, runs, endedAt, state,
 * reason, exit, resumeCommand, waitingGate, answerWaits, questionGate }, and for an ACP agent's launch usage, the last run's { tokens, context, cost },
 * each null when the agent did not report it.
 * model is the last run's recorded model, holder the claim holder that the host session takes claims as, and only resumeCommand
 * names the host session id.
 * gates is gateFacts of the launch as the page's checkout reads its initiative's coordination state; without it no gate is counted.
 * permission is the oldest permission request that waits in the running run, which makes the launch waiting on it.
 * results is the launch's result marks; without them no run ended without a result.
 */
export function launchView(record: any, { now = Date.now(), gates = null, permission = null, results = null }: { now?: number; gates?: { waiting?: boolean; answerWaits?: boolean; waitingGate?: string | null; questionGate?: string | null } | null; permission?: { action: string } | null; results?: ResultMarks | null } = {}) {
  const status = lastRunStatus(record, now);
  const label = hostDefinition(record.host)?.label ?? record.host;
  const facts = { waiting: gates?.waiting === true, answerWaits: status !== "running" && gates?.answerWaits === true };
  const { state, reason: hostText, question = null } = stateOf(record, status, label, facts, permission, results ?? NO_RESULT_MARKS, now);
  const reason = redactSessionId(hostText, record.hostSessionId);
  const runningMs = record.runs.reduce((sum: any, run: any, index: number) => {
    const start = time(run.startedAt);
    if (!Number.isFinite(start)) return sum;
    let end = time(run.endedAt);
    if (!Number.isFinite(end)) end = index === record.runs.length - 1 && status === "running" ? now : time(run.heartbeatAt);
    return Number.isFinite(end) ? sum + Math.max(0, end - start) : sum;
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
    endedAt: Number.isFinite(end) ? new Date(end!).toISOString() : null,
    state,
    reason,
    exit,
    resumeCommand,
    waitingGate: state === "waiting" && typeof gates?.waitingGate === "string" ? gates.waitingGate : null,
    answerWaits: facts.answerWaits,
    questionGate: question !== null && gates?.questionGate === question ? question : null,
    ...(isAcpHost(record.host) ? { usage: runUsage(last) } : {})
  };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const USAGE_TOKENS = ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"];

/** A run's recorded usage, keeping only well-formed values, so nothing else that a record holds reaches the page. */
function runUsage(run: any) {
  const usage = run?.usage && typeof run.usage === "object" ? run.usage : {};
  const tokens = usage.tokens && typeof usage.tokens === "object" ? Object.fromEntries(USAGE_TOKENS.filter((key) => finite(usage.tokens[key])).map((key) => [key, usage.tokens[key]])) : {};
  const context = finite(usage.context?.used) && finite(usage.context?.size) ? { used: usage.context.used, size: usage.context.size } : null;
  const cost = finite(usage.cost?.amount) && typeof usage.cost?.currency === "string" ? { amount: usage.cost.amount, currency: usage.cost.currency } : null;
  return { tokens: Object.keys(tokens).length ? tokens : null, context, cost };
}

/** Whether a launch folder may be removed: its last run ended, or its supervision was lost, more than 14 days before now, or it never started a run. */
export function expired(record: any, now = Date.now()) {
  const status = lastRunStatus(record, now);
  if (status === "running") return false;
  const end = lastEnd(record, status);
  if (status === "none") return !Number.isFinite(end) || now - end! > UNSTARTED_STALE_MS;
  return Number.isFinite(end) && now - end! > RETENTION_MS;
}

// The archive mark of a launched session, kept beside its record on this machine only and written only under the launch lock:
// { archivedAt, runs }, the time of the archive and the record's run count then.
const ARCHIVE_FILE = "archive.json";
const ENDED_STATES = new Set(["finished", "ended-without-result", "failed", "stopped", "blocked"]);

export interface ArchiveMark {
  archivedAt: string;
  runs: number;
}

/** Whether a launch view's state is one that can be archived: finished, ended without a result, failed, stopped, or blocked. */
export function launchEnded(state: unknown): boolean {
  return typeof state === "string" && ENDED_STATES.has(state);
}

/** The archive mark of a launch folder, { archivedAt, runs }, or null when it is absent or malformed. */
export async function readArchiveMark(folder: string): Promise<ArchiveMark | null> {
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

/** Writes the archive mark of a launch folder, private to the user; the caller holds the launch lock. */
export async function writeArchiveMark(folder: string, { archivedAt, runs }: ArchiveMark) {
  const file = path.join(folder, ARCHIVE_FILE);
  await writeAtomically(file, `${JSON.stringify({ archivedAt, runs }, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600);
}

/** Removes the archive mark of a launch folder, and only that file; the caller holds the launch lock. */
export async function removeArchiveMark(folder: string) {
  await rm(path.join(folder, ARCHIVE_FILE), { force: true });
}

/**
 * Whether a launched session is archived now: its mark exists, its record holds as many runs as the mark names, and its state is
 * finished, failed, stopped, or blocked. A session that ran or waited again is not, whatever its mark says.
 */
export function archivedNow(mark: ArchiveMark | null, record: any, state: unknown): boolean {
  return mark !== null && Array.isArray(record?.runs) && record.runs.length === mark.runs && launchEnded(state);
}

export async function removeLaunchFolder(folder: string) {
  await rm(folder, { recursive: true, force: true });
}
