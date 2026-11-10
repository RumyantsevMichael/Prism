import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Ending a launched session's host and every process it started, also those that left its process group or session.
// The review app that review-app.json names, its descendants, and every launch supervisor with its descendants are spared,
// so a stop never ends the shared review app or another launched session.
// A listed process is ended later only while it is still the same process, so a reused process id is never ended.

export const DEFAULT_STOP_GRACE_MS = 10000;
const LIST_TIMEOUT_MS = 10000;
const FORCED_ROUNDS = 3;
const ROUND_PAUSE_MS = 50;
// After the forced end, the stop waits this long at most for the ended processes to leave the process list,
// since an orphan stays listed until the system reaps it.
const SETTLE_MS = 3000;
const SETTLE_POLL_MS = 100;
const SUPERVISOR_SCRIPT = "launch-supervisor.mjs";
const DISCOVERY_FILE = "review-app.json";

/** The grace period of a stop: PRISM_LAUNCH_STOP_GRACE_MS milliseconds, and 10000 without a valid value. */
export function stopGraceMs(env = process.env) {
  const value = typeof env?.PRISM_LAUNCH_STOP_GRACE_MS === "string" ? env.PRISM_LAUNCH_STOP_GRACE_MS.trim() : "";
  return /^\d{1,9}$/.test(value) ? Number(value) : DEFAULT_STOP_GRACE_MS;
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: LIST_TIMEOUT_MS, windowsHide: true, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => resolve(error ? null : stdout));
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

/** The processes of this machine as a Map of pid to { pid, ppid, started, args }, or null when the list cannot be read. */
export async function listProcesses(platform = process.platform) {
  const table = new Map();
  if (platform === "win32") {
    const out = await run(windowsTool("powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST]);
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
  const out = await run(posixPs(), ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "args="]);
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

function spared(entry, sparedPids) {
  return sparedPids.has(entry.pid) || entry.args.includes(SUPERVISOR_SCRIPT);
}

/** The descendants of the roots, without the roots, skipping every spared process and the processes below it. */
export function descendantsOf(table, roots, sparedPids = new Set()) {
  const children = new Map();
  for (const entry of table.values()) {
    if (entry.pid === entry.ppid) continue;
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
      if (spared(child, sparedPids)) continue;
      found.set(child.pid, child);
      queue.push(child.pid);
    }
  }
  return [...found.values()];
}

function signal(pid, forced, platform) {
  if (platform === "win32") {
    return run(windowsTool("taskkill.exe"), forced ? ["/PID", String(pid), "/F"] : ["/PID", String(pid)]);
  }
  try { process.kill(pid, forced ? "SIGKILL" : "SIGTERM"); } catch {}
  return null;
}

async function sparedSet(reviewAppFolder) {
  const pids = new Set([process.pid]);
  const app = await reviewAppPid(reviewAppFolder);
  if (app) pids.add(app);
  return pids;
}

/**
 * Ends a host and its process tree: lists the host's descendants, asks the host to end, and after the grace period,
 * or at once when the host ends before it, forcibly ends the host while it runs, every listed process that is still the same process,
 * and every descendant of theirs that it then finds.
 * `running` answers whether the host still runs, and `ended` settles when it has ended.
 */
export async function endProcessTree({ pid, running, ended, graceMs = DEFAULT_STOP_GRACE_MS, reviewAppFolder = null, platform = process.platform, settleMs = SETTLE_MS }) {
  const before = await listProcesses(platform);
  const listed = before ? descendantsOf(before, [pid], await sparedSet(reviewAppFolder)) : [];
  if (running()) await signal(pid, false, platform);
  let timer;
  await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(resolve, graceMs); })]);
  clearTimeout(timer);
  const killed = new Set();
  const identity = (entry) => `${entry.pid}:${entry.started}`;
  for (let round = 0; round < FORCED_ROUNDS; round += 1) {
    const sparedPids = await sparedSet(reviewAppFolder);
    const now = await listProcesses(platform);
    const roots = [];
    const targets = [];
    if (running()) {
      roots.push(pid);
      if (round === 0) targets.push(pid);
    }
    if (now) {
      for (const entry of listed) {
        const current = now.get(entry.pid);
        if (!current || current.started !== entry.started || spared(current, sparedPids)) continue;
        roots.push(entry.pid);
        if (!killed.has(identity(current))) targets.push(entry.pid);
      }
      for (const entry of descendantsOf(now, roots, sparedPids)) if (!killed.has(identity(entry))) targets.push(entry.pid);
    }
    const fresh = targets.filter((target, index) => targets.indexOf(target) === index);
    if (!fresh.length) break;
    for (const target of fresh) {
      const entry = now?.get(target);
      if (entry) killed.add(identity(entry));
      await signal(target, true, platform);
    }
    await new Promise((resolve) => setTimeout(resolve, ROUND_PAUSE_MS));
  }
  const settleBy = Date.now() + settleMs;
  while (killed.size && Date.now() < settleBy) {
    const now = await listProcesses(platform);
    if (!now || ![...now.values()].some((entry) => killed.has(identity(entry)))) return;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}
