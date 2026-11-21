import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";

// How a read of an ACP agent's run options, or a launched run on one, learns that the agent started Prism's server and listed its
// tools: the server, started with PRISM_OPTIONS_READ=1 or with PRISM_LAUNCH naming a launch, writes a marker into the review app
// folder when it answers tools/list, naming its own process and the processes above it, and the read or run waits for a marker below
// the agent process it started. A marker is only a signal, holds no secret, and is removed by the read or run that finds it or by the
// server when it stops.

const MAX_ANCESTORS = 16;
const POLL_MS = 50;

export const optionsReadFolder = (env: NodeJS.ProcessEnv = process.env) => path.join(reviewAppDirectory(env), "options-reads");
const marking = (env: NodeJS.ProcessEnv) => env.PRISM_OPTIONS_READ === "1" || /^launch-[0-9a-f]{16}$/.test(env.PRISM_LAUNCH ?? "");
const markerFile = (env: NodeJS.ProcessEnv, pid: number) => path.join(optionsReadFolder(env), `${pid}.json`);

// The parent of each process, as ps lists them, on a POSIX system with no /proc, such as macOS; empty where ps is missing or fails.
function psParents() {
  const parents = new Map<number, number>();
  if (process.platform === "win32") return parents;
  let table: string;
  try { table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }); } catch { return parents; }
  for (const line of table.split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(parent)) parents.set(pid, parent);
  }
  return parents;
}

// The parent process ids above this process, nearest first, as far as /proc or else ps tells them, and otherwise only the parent.
function ancestors() {
  const found = [process.ppid];
  let pid = process.ppid;
  let listed: Map<number, number> | null = null;
  for (let depth = 1; depth < MAX_ANCESTORS && pid > 1; depth += 1) {
    let parent: number | undefined;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      listed ??= psParents();
      parent = listed.get(pid);
    }
    if (parent === undefined || !Number.isSafeInteger(parent) || parent <= 1) break;
    found.push(parent);
    pid = parent;
  }
  return found;
}

/** Writes this server's marker, when PRISM_OPTIONS_READ or PRISM_LAUNCH asks for one; a failed write only leaves the read to time out. */
export function markToolsListed(env: NodeJS.ProcessEnv = process.env) {
  if (!marking(env)) return;
  try {
    mkdirSync(optionsReadFolder(env), { recursive: true, mode: 0o700 });
    writeFileSync(markerFile(env, process.pid), JSON.stringify({ pid: process.pid, ancestors: ancestors(), at: new Date().toISOString() }), { mode: 0o600 });
  } catch {}
}

/** Removes this server's marker, if it wrote one. */
export function unmarkToolsListed(env: NodeJS.ProcessEnv = process.env) {
  if (!marking(env)) return;
  try { rmSync(markerFile(env, process.pid), { force: true }); } catch {}
}

function takeMarker(env: NodeJS.ProcessEnv, agentPid: number) {
  let names: string[];
  try { names = readdirSync(optionsReadFolder(env)).filter((name) => /^\d+\.json$/.test(name)); } catch { return false; }
  for (const name of names) {
    const file = path.join(optionsReadFolder(env), name);
    let marker: any;
    try { marker = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    if (!Array.isArray(marker?.ancestors) || !marker.ancestors.includes(agentPid)) continue;
    try { rmSync(file, { force: true }); } catch {}
    return true;
  }
  return false;
}

/** Resolves true once a server below agentPid listed its tools, or false at the deadline or when stopped() answers true. */
export function toolsListed({ env, agentPid, deadline, stopped }: { env: NodeJS.ProcessEnv; agentPid: number; deadline: number; stopped: () => boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      if (takeMarker(env, agentPid)) resolve(true);
      else if (stopped() || Date.now() >= deadline) resolve(false);
      else setTimeout(check, POLL_MS);
    };
    check();
  });
}
