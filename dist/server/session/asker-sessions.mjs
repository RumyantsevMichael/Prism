// Generated from src/server/session/asker-sessions.mts by scripts/native-build/compile.mjs.
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { resolveHost } from "./launch-hosts.mjs";
import { LAUNCH_ID_PATTERN, launchFolder, launchRunning, readLaunchRecord } from "./launch-records.mjs";
const SESSIONS_FILE = "gate-asker-sessions.json";
const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5e3;
const ENTRIES_KEPT = 500;
const AGENTS_TIMEOUT_MS = 5e3;
const AGENTS_FRESH_MS = 1e3;
function askerSessionsFile(env = process.env) {
  return path.join(reviewAppDirectory(env), SESSIONS_FILE);
}
const validEntry = (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry) && (entry.host === null || typeof entry.host === "string") && (entry.sessionId === null || typeof entry.sessionId === "string") && (entry.launch === null || typeof entry.launch === "string") && typeof entry.checkout === "string" && path.isAbsolute(entry.checkout) && (entry.initiative === null || typeof entry.initiative === "string") && typeof entry.askedAt === "string";
async function readEntries(file) {
  let info;
  try {
    info = await lstat(file);
  } catch {
    return {};
  }
  if (info.isSymbolicLink() || !info.isFile()) return {};
  let parsed;
  try {
    parsed = parseStoreJson(await readFile(file, "utf8"));
  } catch {
    return {};
  }
  if (parsed?.schemaVersion !== SCHEMA_VERSION || parsed.gates === null || typeof parsed.gates !== "object" || Array.isArray(parsed.gates)) return {};
  return Object.fromEntries(Object.entries(parsed.gates).filter(([, entry]) => validEntry(entry)));
}
async function keepAskerSessions(targets, entry, env = process.env) {
  if (!targets.length) return;
  const file = askerSessionsFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 448 });
  await withArtifactLock(file, () => withFileLock(file, async () => {
    const gates = await readEntries(file);
    for (const target of targets) gates[target] = { ...entry };
    const kept = Object.entries(gates).sort(([, left], [, right]) => right.askedAt.localeCompare(left.askedAt)).slice(0, ENTRIES_KEPT);
    await writeAtomically(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, gates: Object.fromEntries(kept) }, null, 2)}
`, { mode: 384 });
  }, void 0, { timeoutMs: LOCK_TIMEOUT_MS }));
}
async function readAskerSessions(env = process.env) {
  return readEntries(askerSessionsFile(env));
}
const agentsReads = /* @__PURE__ */ new Map();
function claudeAgents(checkout, env) {
  const hit = agentsReads.get(checkout);
  if (hit && Date.now() - hit.at < AGENTS_FRESH_MS) return hit.value;
  const value = (async () => {
    const host = await resolveHost("claude-code", env);
    if (!host?.available || !host.command) return { reason: host?.reason ?? "Claude Code was not found: no claude executable on PATH." };
    return new Promise((resolve) => {
      execFile(host.command, [...host.prefix, "agents", "--json"], { cwd: checkout, env, timeout: AGENTS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          const line = String(stderr ?? "").split(/\r?\n/).map((text) => text.trim()).find(Boolean);
          const code = typeof error.code === "number" ? error.code : error.killed ? "timeout" : error.code ?? "unknown";
          resolve({ reason: `claude agents --json failed: ${line ?? `exit code ${code}`}` });
          return;
        }
        try {
          const ids = /* @__PURE__ */ new Set();
          const visit = (value2) => {
            if (typeof value2 === "string") ids.add(value2);
            else if (Array.isArray(value2)) value2.forEach(visit);
            else if (value2 && typeof value2 === "object") Object.values(value2).forEach(visit);
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
const codexHome = (env) => env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), ".codex");
const exists = (file) => lstat(file).then(() => true, () => false);
async function askerState(asker, kept, env = process.env) {
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
function askerReach(state, asker) {
  return state === "open" && !asker.launched ? `Prism cannot reach this session, because no wait holds the question. Send any message in that ${asker.harness ?? "this harness"} session, and it reads the answer.` : null;
}
export {
  askerReach,
  askerSessionsFile,
  askerState,
  keepAskerSessions,
  readAskerSessions
};
