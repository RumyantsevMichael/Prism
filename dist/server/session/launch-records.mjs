import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { describeRecordStore } from "../workflow/record-store.mjs";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { hostDefinition, redactSessionId, resumeCommandOf } from "./launch-hosts.mjs";

// The record of each launched session lives in <review app folder>/launches/<launch id>/launch.json, private to the user.
// The host session id lives only there, and a launch view carries it only in its resumeCommand: host text in its reason has the id replaced.
// While a run runs, its supervisor is the only writer of the record.

export const LAUNCH_ID_PATTERN = /^launch-[0-9a-f]{16}$/;
const RECORD_FILE = "launch.json";
export const HEARTBEAT_MS = 5000;
export const HEARTBEAT_STALE_MS = 60000;
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
// A launch folder whose supervisor never recorded a run is abandoned after this long.
const UNSTARTED_STALE_MS = 60000;
const STDERR_LINE_MAX = 300;
export const SUPERVISION_LOST = "Prism stopped supervising this session; its host process may still run.";

export class LaunchError extends Error {
  constructor(code, message) {
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

export function launchFolder(env, id) {
  return path.join(launchesDirectory(env), id);
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new LaunchError("launch_failed", `${directory} is not a folder Prism can keep launches in.`);
  if (process.platform !== "win32") {
    if (info.uid !== process.getuid()) throw new LaunchError("launch_failed", `${directory} belongs to another user.`);
    if ((info.mode & 0o077) !== 0) await chmod(directory, 0o700);
  }
}

/** Creates the private review app folder and the private launches folder in it. */
export async function prepareLaunchesDirectory(env) {
  await privateDirectory(reviewAppDirectory(env));
  await privateDirectory(launchesDirectory(env));
}

/** Creates one private launch folder in the launches folder. */
export async function createLaunchFolder(env, id) {
  await prepareLaunchesDirectory(env);
  const folder = launchFolder(env, id);
  await mkdir(folder, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(folder, 0o700);
  return folder;
}

export async function readLaunchRecord(folder) {
  try {
    const info = await lstat(path.join(folder, RECORD_FILE));
    if (!info.isFile()) return null;
    const value = JSON.parse(await readFile(path.join(folder, RECORD_FILE), "utf8"));
    return value && typeof value === "object" && LAUNCH_ID_PATTERN.test(value.id) && Array.isArray(value.runs) ? value : null;
  } catch {
    return null;
  }
}

export async function writeLaunchRecord(folder, record) {
  await writeAtomically(path.join(folder, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Every launch folder on this machine with its record: [{ folder, record }], skipping unreadable ones. */
export async function listLaunchRecords(env) {
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
export async function storeLocation(projectRoot) {
  const described = await describeRecordStore(projectRoot);
  if (!described.location) return `${described.kind}:${described.label}`;
  try {
    return await realpath(described.location);
  } catch {
    return path.resolve(described.location);
  }
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const time = (value) => (typeof value === "string" ? Date.parse(value) : Number.NaN);

/** How the last run of a record stands: "none", "running", "lost", or "ended". */
export function lastRunStatus(record, now = Date.now()) {
  const run = record.runs.at(-1);
  if (!run) return "none";
  if (run.endedAt) return "ended";
  const heartbeat = time(run.heartbeatAt);
  if (!processAlive(run.supervisorPid) || !(now - heartbeat <= HEARTBEAT_STALE_MS)) return "lost";
  return "running";
}

/** Whether one of the record's runs runs under a live supervisor. */
export function launchRunning(record, now = Date.now()) {
  return lastRunStatus(record, now) === "running";
}

function lastErrorLine(text) {
  if (typeof text !== "string") return null;
  const line = text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1);
  return line ? line.slice(0, STDERR_LINE_MAX) : null;
}

/** The end of the last run as a time, or null while it runs or was never recorded and its supervisor's last sign of life otherwise. */
function lastEnd(record, status) {
  const run = record.runs.at(-1);
  if (!run) return time(record.createdAt);
  if (status === "ended") return time(run.endedAt);
  if (status === "lost") return time(run.heartbeatAt) || time(run.startedAt);
  return null;
}

function stateOf(record, status, label) {
  const run = record.runs.at(-1);
  if (status === "running") return { state: "running", reason: null };
  if (status === "lost") return { state: "failed", reason: SUPERVISION_LOST };
  const stderr = lastErrorLine(run.stderr);
  const tail = stderr ? ` ${stderr}` : "";
  if (run.exit?.signal) return { state: "failed", reason: `${label} ended by signal ${run.exit.signal}.${tail}` };
  if (run.exit && run.exit.code !== 0) return { state: "failed", reason: `${label} ended with exit code ${run.exit.code}.${tail}` };
  if (typeof run.hostError === "string") return { state: "failed", reason: `${label} reported an error: ${run.hostError}` };
  const refusals = Array.isArray(run.refusals) ? run.refusals : [];
  if (refusals.length) {
    const [first] = refusals;
    const more = refusals.length > 1 ? ` (and ${refusals.length - 1} more)` : "";
    return { state: "blocked", reason: `${label} refused ${first.tool}: ${first.reason}${more}` };
  }
  return { state: "finished", reason: null };
}

/** The launch view of a record: { id, initiative, host, hostLabel, checkout, launchedAt, runningMs, runs, state, reason, exit, resumeCommand, answerWaits }. */
export function launchView(record, { now = Date.now() } = {}) {
  const status = lastRunStatus(record, now);
  const label = hostDefinition(record.host)?.label ?? record.host;
  const { state, reason: hostText } = stateOf(record, status, label);
  const reason = redactSessionId(hostText, record.hostSessionId);
  const runningMs = record.runs.reduce((sum, run, index) => {
    const start = time(run.startedAt);
    if (!Number.isFinite(start)) return sum;
    let end = time(run.endedAt);
    if (!Number.isFinite(end)) end = index === record.runs.length - 1 && status === "running" ? now : time(run.heartbeatAt);
    return Number.isFinite(end) ? sum + Math.max(0, end - start) : sum;
  }, 0);
  const ended = [...record.runs].reverse().find((run) => run.endedAt);
  const exit = status === "lost" ? null : ended?.exit ? { code: ended.exit.code ?? null, signal: ended.exit.signal ?? null } : null;
  const command = status === "running" ? null : resumeCommandOf(record.host, record.hostSessionId);
  const resumeCommand = command ? { command, cwd: record.checkout } : null;
  return {
    id: record.id,
    initiative: record.initiative,
    host: record.host,
    hostLabel: label,
    checkout: record.checkout,
    launchedAt: record.runs[0]?.startedAt ?? null,
    runningMs,
    runs: record.runs.length,
    state,
    reason,
    exit,
    resumeCommand,
    answerWaits: false
  };
}

/** Whether a launch folder may be removed: its last run ended, or its supervision was lost, more than 14 days before now, or it never started a run. */
export function expired(record, now = Date.now()) {
  const status = lastRunStatus(record, now);
  if (status === "running") return false;
  const end = lastEnd(record, status);
  if (status === "none") return !Number.isFinite(end) || now - end > UNSTARTED_STALE_MS;
  return Number.isFinite(end) && now - end > RETENTION_MS;
}

export async function removeLaunchFolder(folder) {
  await rm(folder, { recursive: true, force: true });
}
