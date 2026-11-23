import { execFile } from "node:child_process";
import { lstat, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { resolveHost } from "./launch-hosts.mjs";
import { LAUNCH_ID_PATTERN, launchFolder, launchRunning, readLaunchRecord } from "./launch-records.mjs";

// The session that asked each gate on this machine, kept in a private file of the review app folder and never in the shared records,
// so only this machine can tell whether that session is open and later resume it.
// An entry is keyed by the gate's target, gate:<initiative>/<id> or approval:<id>, and holds the launch host, the host session id,
// which only Claude Code and Codex give, the launch that ran the session when Prism launched it, the checkout's path, and the initiative.

const SESSIONS_FILE = "gate-asker-sessions.json";
const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
// The most entries the file keeps, the newest first, so a machine that asks many gates keeps a bounded file.
const ENTRIES_KEPT = 500;
const AGENTS_TIMEOUT_MS = 5000;
// One read of claude agents --json answers every gate of one checkout for this long, so a page that asks often runs it rarely.
const AGENTS_FRESH_MS = 1000;

export interface AskerSession { host: string | null; sessionId: string | null; launch: string | null; checkout: string; initiative: string | null; askedAt: string }

export function askerSessionsFile(env = process.env) {
  return path.join(reviewAppDirectory(env), SESSIONS_FILE);
}

const validEntry = (entry: any): entry is AskerSession => entry !== null && typeof entry === "object" && !Array.isArray(entry)
  && (entry.host === null || typeof entry.host === "string") && (entry.sessionId === null || typeof entry.sessionId === "string")
  && (entry.launch === null || typeof entry.launch === "string") && typeof entry.checkout === "string" && path.isAbsolute(entry.checkout)
  && (entry.initiative === null || typeof entry.initiative === "string") && typeof entry.askedAt === "string";

async function readEntries(file: string): Promise<Record<string, AskerSession>> {
  let info;
  try { info = await lstat(file); } catch { return {}; }
  if (info.isSymbolicLink() || !info.isFile()) return {};
  let parsed;
  try { parsed = parseStoreJson(await readFile(file, "utf8")); } catch { return {}; }
  if (parsed?.schemaVersion !== SCHEMA_VERSION || parsed.gates === null || typeof parsed.gates !== "object" || Array.isArray(parsed.gates)) return {};
  return Object.fromEntries(Object.entries(parsed.gates).filter(([, entry]) => validEntry(entry))) as Record<string, AskerSession>;
}

/** Keeps the asking session of each target in this machine's private file, readable only by its owner. */
export async function keepAskerSessions(targets: string[], entry: AskerSession, env = process.env) {
  if (!targets.length) return;
  const file = askerSessionsFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withArtifactLock(file, () => withFileLock(file, async () => {
    const gates = await readEntries(file);
    for (const target of targets) gates[target] = { ...entry };
    const kept = Object.entries(gates).sort(([, left], [, right]) => right.askedAt.localeCompare(left.askedAt)).slice(0, ENTRIES_KEPT);
    await writeAtomically(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, gates: Object.fromEntries(kept) }, null, 2)}\n`, { mode: 0o600 });
  }, undefined, { timeoutMs: LOCK_TIMEOUT_MS }));
}

/** The asking sessions this machine kept, by target. */
export async function readAskerSessions(env = process.env) {
  return readEntries(askerSessionsFile(env));
}

// What claude agents --json printed in one checkout, read at most once a second: { ids } of every string value, or { reason }.
const agentsReads = new Map<string, { at: number; value: Promise<{ ids: Set<string> } | { reason: string }> }>();

function claudeAgents(checkout: string, env: NodeJS.ProcessEnv) {
  const hit = agentsReads.get(checkout);
  if (hit && Date.now() - hit.at < AGENTS_FRESH_MS) return hit.value;
  const value = (async () => {
    const host = await resolveHost("claude-code", env);
    if (!host?.available || !host.command) return { reason: host?.reason ?? "Claude Code was not found: no claude executable on PATH." };
    return new Promise<{ ids: Set<string> } | { reason: string }>((resolve) => {
      execFile(host.command!, [...host.prefix, "agents", "--json"], { cwd: checkout, env, timeout: AGENTS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error: any, stdout, stderr) => {
        if (error) {
          const line = String(stderr ?? "").split(/\r?\n/).map((text) => text.trim()).find(Boolean);
          const code = typeof error.code === "number" ? error.code : error.killed ? "timeout" : error.code ?? "unknown";
          resolve({ reason: `claude agents --json failed: ${line ?? `exit code ${code}`}` });
          return;
        }
        try {
          const ids = new Set<string>();
          const visit = (value: any) => {
            if (typeof value === "string") ids.add(value);
            else if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === "object") Object.values(value).forEach(visit);
          };
          visit(JSON.parse(String(stdout)));
          resolve({ ids });
        } catch {
          const line = String(stderr ?? "").split(/\r?\n/).map((text) => text.trim()).find(Boolean);
          resolve({ reason: `claude agents --json failed: ${line ?? "exit code 0"}` });
        }
      });
    });
  })();
  agentsReads.set(checkout, { at: Date.now(), value });
  return value;
}

const codexHome = (env: NodeJS.ProcessEnv) => env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), ".codex");
const exists = (file: string) => lstat(file).then(() => true, () => false);

export type AskerState = { state: "waiting" | "open" | "not-running" | "unknown"; reason: string | null };

/**
 * The state of a gate's asker on this machine, in the order the gate card reads it: waiting while a live hold holds the gate,
 * then unknown for a cloud session or one of another machine, then from its launched session, claude agents --json, or the Codex
 * thread writer lock; asker is the shared record's view and kept the private entry of this machine, or null.
 */
export async function askerState(asker: { known: boolean; harness: string | null; machine: string | null; cloud: boolean; launched: boolean; held: boolean }, kept: AskerSession | null, env = process.env): Promise<AskerState> {
  if (asker.held) return { state: "waiting", reason: null };
  if (!asker.known) return { state: "unknown", reason: "Prism has no record of the session that asked this question." };
  if (asker.cloud) return { state: "unknown", reason: "Prism cannot tell whether a cloud session is open." };
  if (!kept) return { state: "unknown", reason: `It ran on ${asker.machine ?? "another machine"}; Prism can tell whether it is open only there.` };
  if (asker.launched) {
    const record = kept.launch && LAUNCH_ID_PATTERN.test(kept.launch) ? await readLaunchRecord(launchFolder(env, kept.launch)) : null;
    return { state: record && launchRunning(record) ? "open" : "not-running", reason: null };
  }
  if (kept.host === "claude-code" && kept.sessionId) {
    const read = await claudeAgents(kept.checkout, env);
    if ("reason" in read) return { state: "unknown", reason: read.reason };
    return { state: read.ids.has(kept.sessionId) ? "open" : "not-running", reason: null };
  }
  if (kept.host === "codex" && kept.sessionId) {
    const lock = path.join(codexHome(env), "thread-writer-locks", `${path.basename(kept.sessionId)}.lock`);
    return { state: await exists(lock) ? "open" : "not-running", reason: null };
  }
  return { state: "unknown", reason: `Prism cannot tell whether a ${asker.harness ?? "this harness"} session is open.` };
}

/** How the person reaches an open asker that no wait holds, or null. */
export function askerReach(state: string, asker: { harness: string | null; launched: boolean }) {
  return state === "open" && !asker.launched ? `Prism cannot reach this session, because no wait holds the question. Send any message in that ${asker.harness ?? "this harness"} session, and it reads the answer.` : null;
}
