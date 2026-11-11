import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readLaunchRecord, tokenVoided, LAUNCH_ID_PATTERN } from "./launch-records.mjs";

// Ending a launched session's host and every process it started, also those that left its process group or session.
// The review app that review-app.json names, its descendants, and every launch supervisor with its descendants are spared,
// so a stop never ends the shared review app or another launched session.
// A listed process is ended later only while it is still the same process, so a reused process id is never ended.
// On Windows a process counts as a child of the parent it names only when it started no earlier than that parent,
// since Windows keeps the parent id of a parent that ended and gives that id to new processes.
// A launch supervisor is recognized by its exact command line, node, the supervisor script, and a launch folder in this machine's launches folder,
// and, during a stop, by the launch record of that folder, never by a mention of the script's name.
// The whole stop keeps to one deadline counted from the stop request, so every listing, forced round, and settle wait fits in it.

export const DEFAULT_STOP_GRACE_MS = 10000;
const LIST_TIMEOUT_MS = 10000;
const FORCED_ROUNDS = 3;
const ROUND_PAUSE_MS = 50;
// After the forced end, the stop waits this long at most for the ended processes to leave the process list,
// since an orphan stays listed until the system reaps it.
const SETTLE_MS = 3000;
const SETTLE_POLL_MS = 100;
// After the grace period, the forced end and the settle wait finish within this long, which leaves time to record the run's end
// inside the grace period and 5 seconds that a stop answers within.
export const STOP_FINISH_MS = 3500;
const MIN_SIGNAL_TIMEOUT_MS = 1000;
const MIN_LISTING_MS = 2000;
const DISCOVERY_FILE = "review-app.json";

/** The grace period of a stop: PRISM_LAUNCH_STOP_GRACE_MS milliseconds, and 10000 without a valid value. */
export function stopGraceMs(env = process.env) {
  const value = typeof env?.PRISM_LAUNCH_STOP_GRACE_MS === "string" ? env.PRISM_LAUNCH_STOP_GRACE_MS.trim() : "";
  return /^\d{1,9}$/.test(value) ? Number(value) : DEFAULT_STOP_GRACE_MS;
}

function run(command, args, timeoutMs = LIST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: Math.max(1, Math.round(timeoutMs)), windowsHide: true, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => resolve(error ? null : stdout));
  });
}

function posixPs() {
  return ["/bin/ps", "/usr/bin/ps"].find((file) => existsSync(file)) ?? "ps";
}

function windowsTool(name) {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const candidates = name === "powershell.exe"
    ? [path.join(root, "System32", "WindowsPowerShell", "v1.0", name)]
    : [path.join(root, "System32", name)];
  return candidates.find((file) => existsSync(file)) ?? name;
}

const WINDOWS_LIST = "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; s = $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }); a = [string]$_.CommandLine } } | ConvertTo-Json -Compress";

/** The processes of this machine as a Map of pid to { pid, ppid, started, args }, or null when the list cannot be read within timeoutMs. */
export async function listProcesses(platform = process.platform, timeoutMs = LIST_TIMEOUT_MS) {
  const table = new Map();
  if (!(timeoutMs > 0)) return null;
  if (platform === "win32") {
    const out = await run(windowsTool("powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST], timeoutMs);
    if (out === null) return null;
    let entries;
    try { entries = JSON.parse(out); } catch { return null; }
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const pid = Number(entry?.p);
      const ppid = Number(entry?.q);
      if (Number.isSafeInteger(pid) && pid > 0) table.set(pid, { pid, ppid: Number.isSafeInteger(ppid) ? ppid : 0, started: String(entry.s ?? ""), args: String(entry.a ?? "") });
    }
    return table;
  }
  const out = await run(posixPs(), ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "args="], timeoutMs);
  if (out === null) return null;
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s?(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    table.set(pid, { pid, ppid: Number(match[2]), started: match[3].replace(/\s+/g, " "), args: match[4] });
  }
  return table;
}

/** The process id that review-app.json in the review app folder names, read leniently, so an unverified file still spares its process. */
export async function reviewAppPid(reviewAppFolder) {
  if (!reviewAppFolder) return null;
  try {
    const value = JSON.parse(await readFile(path.join(reviewAppFolder, DISCOVERY_FILE), "utf8"));
    return Number.isSafeInteger(value?.pid) && value.pid > 0 ? value.pid : null;
  } catch {
    return null;
  }
}

// A process is a child of the parent it names. Only a Windows listing gives start times as FILETIME numbers,
// and only Windows keeps the parent id of a parent that ended, so there a process that started before that parent is not its child.
// POSIX reparents an orphan, and its lstart is local time without a zone that can run backwards, so there the parent id alone decides.
function childOf(entry, parent) {
  if (!parent || !/^\d+$/.test(entry.started) || !/^\d+$/.test(parent.started)) return true;
  return BigInt(entry.started) >= BigInt(parent.started);
}

// A supervisor's command line is `<node> <path>/launch-supervisor.mjs <launch folder> <cause> <token>`,
// each path possibly holding spaces or quoted as Windows quotes it.
// It is read in one pass from each end, without a backtracking pattern, so any command line takes time linear in its length,
// and a line longer than the longest Windows command line is never a supervisor's.
const SUPERVISOR_SCRIPT = "launch-supervisor.mjs";
const NODE_NAMES = ["node", "node.exe"];
const SUPERVISOR_CAUSES = new Set(["launch", "person", "gate"]);
const MAX_SUPERVISOR_COMMAND = 32767;
const NODE_BEFORE_SPACE = /(?:^|[\\/])node(?:\.exe)?(?=\s)/i;
const isSpace = (char) => char !== undefined && /\s/.test(char);
const isSeparator = (char) => char === "/" || char === "\\";
const isTokenChar = (char) => char !== undefined && /[0-9A-Za-z]/.test(char);
const isLetter = (char) => char !== undefined && /[A-Za-z]/.test(char);

// Whether a path is a file of one of these names, in any folder.
function namesFile(text, names) {
  const lower = text.toLowerCase();
  return names.some((name) => lower.endsWith(name) && (lower.length === name.length || isSeparator(lower[lower.length - name.length - 1])));
}

// Whether a field is the node executable, quoted or not.
function nodeField(text) {
  if (!text.startsWith("\"")) return namesFile(text, NODE_NAMES);
  return text.length > 1 && text.endsWith("\"") && !text.slice(1, -1).includes("\"") && namesFile(text.slice(1, -1), NODE_NAMES);
}

// The index before the whitespace that ends at index end, or -1 when no whitespace ends there.
function beforeSpace(text, end) {
  let index = end;
  while (index > 0 && isSpace(text[index - 1])) index -= 1;
  return index < end ? index : -1;
}

// The launch folder of `<node> <script> <folder>`, or null.
function supervisorFolder(head) {
  const lower = head.toLowerCase();
  let at = lower.indexOf(SUPERVISOR_SCRIPT);
  const fieldEnd = (index) => {
    const after = index + SUPERVISOR_SCRIPT.length;
    return isSpace(head[after]) || (head[after] === "\"" && isSpace(head[after + 1]));
  };
  while (at !== -1 && !fieldEnd(at)) at = lower.indexOf(SUPERVISOR_SCRIPT, at + 1);
  if (at <= 0) return null;
  const end = at + SUPERVISOR_SCRIPT.length;
  const quoted = head[end] === "\"";
  let index = quoted ? end + 1 : end;
  while (isSpace(head[index])) index += 1;
  let folder = head.slice(index);
  if (folder.startsWith("\"")) {
    if (folder.length < 2 || !folder.endsWith("\"")) return null;
    folder = folder.slice(1, -1);
  }
  if (!folder || folder.includes("\"")) return null;
  if (quoted) {
    const open = head.lastIndexOf("\"", at - 1);
    if (open <= 0 || !namesFile(head.slice(open + 1, end), [SUPERVISOR_SCRIPT])) return null;
    const nodeEnd = beforeSpace(head, open);
    return nodeEnd > 0 && nodeField(head.slice(0, nodeEnd)) ? folder : null;
  }
  if (isSpace(head[at - 1])) {
    const nodeEnd = beforeSpace(head, at);
    return nodeEnd > 0 && nodeField(head.slice(0, nodeEnd)) ? folder : null;
  }
  if (!isSeparator(head[at - 1])) return null;
  // The script's folder may hold spaces, so the node executable is any one that whitespace follows before that folder's last separator.
  if (head.startsWith("\"")) {
    const close = head.indexOf("\"", 1);
    return close > 0 && close < at - 2 && isSpace(head[close + 1]) && nodeField(head.slice(0, close + 1)) ? folder : null;
  }
  return NODE_BEFORE_SPACE.test(head.slice(0, at - 1)) ? folder : null;
}

/**
 * The launch folder and token of a process whose command line is exactly a launch supervisor's, or null.
 * With launchesDir, the launch folder must be the folder of a launch id in it.
 */
export function supervisorCommand(args, launchesDir = null) {
  const line = String(args ?? "").trim();
  if (line.length > MAX_SUPERVISOR_COMMAND) return null;
  let index = line.length;
  while (isTokenChar(line[index - 1])) index -= 1;
  const token = line.slice(index);
  const causeEnd = beforeSpace(line, index);
  if (!token || causeEnd <= 0) return null;
  index = causeEnd;
  while (isLetter(line[index - 1])) index -= 1;
  const headEnd = beforeSpace(line, index);
  if (!SUPERVISOR_CAUSES.has(line.slice(index, causeEnd).toLowerCase()) || headEnd <= 0) return null;
  const folder = supervisorFolder(line.slice(0, headEnd));
  if (!folder) return null;
  const name = path.basename(folder);
  if (launchesDir) {
    if (path.dirname(folder) !== path.resolve(launchesDir) || !LAUNCH_ID_PATTERN.test(name)) return null;
  } else if (path.basename(path.dirname(folder)) !== "launches" || !name.startsWith("launch-")) {
    return null;
  }
  return { folder, token };
}

const supervisorByCommand = (entry) => supervisorCommand(entry.args) !== null;

function spared(entry, sparedPids, isSupervisor) {
  return sparedPids.has(entry.pid) || isSupervisor(entry);
}

/**
 * The descendants of the roots, without the roots, skipping every spared process and the processes below it.
 * isSupervisor names the launch supervisors to spare besides sparedPids, by default every process with a supervisor's exact command line.
 */
export function descendantsOf(table, roots, sparedPids = new Set(), { isSupervisor = supervisorByCommand } = {}) {
  const children = new Map();
  for (const entry of table.values()) {
    if (entry.pid === entry.ppid) continue;
    if (!childOf(entry, table.get(entry.ppid))) continue;
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry);
  }
  const found = new Map();
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (spared(child, sparedPids, isSupervisor)) continue;
      found.set(child.pid, child);
      queue.push(child.pid);
    }
  }
  return [...found.values()];
}

function signal(pid, forced, platform, timeoutMs = LIST_TIMEOUT_MS) {
  if (platform === "win32") {
    return run(windowsTool("taskkill.exe"), forced ? ["/PID", String(pid), "/F"] : ["/PID", String(pid)], Math.min(LIST_TIMEOUT_MS, Math.max(MIN_SIGNAL_TIMEOUT_MS, timeoutMs)));
  }
  try { process.kill(pid, forced ? "SIGKILL" : "SIGTERM"); } catch {}
  return null;
}

// A listed supervisor command counts as a launch supervisor when its launch folder's record names this process as the supervisor
// of the running run with its token, or does not know the token yet, while that supervisor is still starting its host.
async function liveSupervisor(entry, launchesDir, records) {
  const command = supervisorCommand(entry.args, launchesDir);
  if (!command) return false;
  if (!records.has(command.folder)) records.set(command.folder, readLaunchRecord(command.folder));
  const record = await records.get(command.folder);
  if (!record) return false;
  const run = record.runs.find((item) => item?.token === command.token);
  if (run) return run.supervisorPid === entry.pid && !run.endedAt;
  return !tokenVoided(record, command.token);
}

// The processes a stop spares in this listing: this supervisor, the review app, and every launch supervisor.
async function sparedSet(reviewAppFolder, table) {
  const pids = new Set([process.pid]);
  const app = await reviewAppPid(reviewAppFolder);
  if (app) pids.add(app);
  if (table && reviewAppFolder) {
    const launchesDir = path.join(reviewAppFolder, "launches");
    const records = new Map();
    await Promise.all([...table.values()].map(async (entry) => {
      if (!pids.has(entry.pid) && await liveSupervisor(entry, launchesDir, records)) pids.add(entry.pid);
    }));
  }
  return pids;
}

const exactlySpared = () => false;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Ends a host and its process tree: lists the host's descendants, asks the host to end, and after the grace period,
 * or at once when the host ends before it, forcibly ends the host while it runs, every listed process that is still the same process,
 * and every descendant of theirs that it then finds.
 * `running` answers whether the host still runs, and `ended` settles when it has ended.
 * The grace period counts from requestedAt, the time of the stop request, and the forced end and the settle wait finish
 * at most finishMs after the grace period, so the stop as a whole keeps to one deadline.
 */
export async function endProcessTree({ pid, running, ended, graceMs = DEFAULT_STOP_GRACE_MS, reviewAppFolder = null, platform = process.platform, settleMs = SETTLE_MS, requestedAt = Date.now(), finishMs = STOP_FINISH_MS }) {
  const start = Math.min(Number.isFinite(requestedAt) ? requestedAt : Date.now(), Date.now());
  const graceEnd = start + graceMs;
  const deadline = graceEnd + finishMs;
  const left = (until = deadline) => until - Date.now();
  // The listings that decide what is ended get at least a short time even past the deadline, so a late stop still ends the tree.
  const needed = () => Math.max(left(), MIN_LISTING_MS);
  const before = await listProcesses(platform, needed());
  const listed = before ? descendantsOf(before, [pid], await sparedSet(reviewAppFolder, before), { isSupervisor: exactlySpared }) : [];
  if (running()) await signal(pid, false, platform, left(graceEnd));
  let timer;
  await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, left(graceEnd))); })]);
  clearTimeout(timer);
  const killed = new Set();
  const identity = (entry) => `${entry.pid}:${entry.started}`;
  // The host is this process's own child, so its id cannot be reused before it is reaped, and it is ended without a listing.
  if (running()) await signal(pid, true, platform, left());
  for (let round = 0; round < FORCED_ROUNDS && (round === 0 || left() > 0); round += 1) {
    const now = await listProcesses(platform, round === 0 ? needed() : left());
    if (!now) break;
    const sparedPids = await sparedSet(reviewAppFolder, now);
    const roots = running() ? [pid] : [];
    const targets = [];
    for (const entry of listed) {
      const current = now.get(entry.pid);
      if (!current || current.started !== entry.started || sparedPids.has(current.pid)) continue;
      roots.push(entry.pid);
      if (!killed.has(identity(current))) targets.push(current);
    }
    for (const entry of descendantsOf(now, roots, sparedPids, { isSupervisor: exactlySpared })) if (!killed.has(identity(entry))) targets.push(entry);
    const fresh = targets.filter((target, index) => targets.findIndex((other) => other.pid === target.pid) === index);
    if (!fresh.length) break;
    for (const entry of fresh) killed.add(identity(entry));
    await Promise.all(fresh.map((entry) => signal(entry.pid, true, platform, left())));
    await pause(Math.min(ROUND_PAUSE_MS, left()));
  }
  const settleBy = Math.min(Date.now() + settleMs, deadline);
  while (killed.size && Date.now() < settleBy) {
    const now = await listProcesses(platform, settleBy - Date.now());
    if (!now || ![...now.values()].some((entry) => killed.has(identity(entry)))) return;
    await pause(Math.min(SETTLE_POLL_MS, settleBy - Date.now()));
  }
}
