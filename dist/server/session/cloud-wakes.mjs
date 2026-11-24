// Generated from src/server/session/cloud-wakes.mts by scripts/native-build/compile.mjs.
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { askerSubject, strippedEnvironment } from "./launch-hosts.mjs";
const WAKES_FILE = "gate-wakes.json";
const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5e3;
const ENTRIES_KEPT = 500;
const WAKE_LIMIT_MS = 120 * 1e3;
const REASON_MAX = 300;
const CLOUD_ID = /^cse_[A-Za-z0-9]{8,120}$/;
const WAKE_STRIPPED = ["PRISM_LAUNCH", "CLAUDE_CODE_REMOTE"];
const isCloudSessionId = (value) => typeof value === "string" && CLOUD_ID.test(value);
function wakePointer(subject) {
  return `Prism: question ${subject.gate} of ${askerSubject(subject)} has an answer in the review app. Read it from Prism's records before you continue.`;
}
function wakeEnvironment(env) {
  const result = strippedEnvironment(env);
  for (const name of WAKE_STRIPPED) delete result[name];
  return result;
}
const lastLine = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? null;
function sendWake({ command, prefix = [], cloud, pointer, checkout, env, limitMs = WAKE_LIMIT_MS }) {
  if (!isCloudSessionId(cloud)) throw new Error("The cloud session id is not one Prism can pass to Claude Code.");
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (delivered, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ at: (/* @__PURE__ */ new Date()).toISOString(), delivered, reason: reason === null ? null : reason.slice(0, REASON_MAX) });
    };
    let child;
    try {
      child = spawn(command, [...prefix, "-p", pointer, "--cloud", cloud], { cwd: checkout, env: wakeEnvironment(env), shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ at: (/* @__PURE__ */ new Date()).toISOString(), delivered: false, reason: String(error?.message ?? error).slice(0, REASON_MAX) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      done(false, `The wake did not finish within ${Math.round(limitMs / 1e3)} seconds.`);
    }, limitMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (error) => done(false, lastLine(stderr) ?? String(error?.message ?? error)));
    child.on("close", (code, signal) => {
      if (timedOut) return;
      if (code === 0) return done(true, null);
      done(false, lastLine(stderr) ?? `The wake exited with code ${code ?? signal ?? "unknown"}.`);
    });
  });
}
function gateWakesFile(env = process.env) {
  return path.join(reviewAppDirectory(env), WAKES_FILE);
}
const validWake = (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry) && typeof entry.at === "string" && typeof entry.delivered === "boolean" && (entry.reason === null || typeof entry.reason === "string");
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
  return Object.fromEntries(Object.entries(parsed.gates).filter(([, entry]) => validWake(entry)).map(([target, entry]) => [target, { at: entry.at, delivered: entry.delivered, reason: entry.reason }]));
}
async function keepGateWake(target, wake, env = process.env) {
  const file = gateWakesFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 448 });
  await withArtifactLock(file, () => withFileLock(file, async () => {
    const gates = await readEntries(file);
    gates[target] = { at: wake.at, delivered: wake.delivered, reason: wake.reason };
    const kept = Object.entries(gates).sort(([, left], [, right]) => right.at.localeCompare(left.at)).slice(0, ENTRIES_KEPT);
    await writeAtomically(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, gates: Object.fromEntries(kept) }, null, 2)}
`, { mode: 384 });
  }, void 0, { timeoutMs: LOCK_TIMEOUT_MS }));
}
async function readGateWakes(env = process.env) {
  return readEntries(gateWakesFile(env));
}
export {
  WAKE_LIMIT_MS,
  gateWakesFile,
  isCloudSessionId,
  keepGateWake,
  readGateWakes,
  sendWake,
  wakeEnvironment,
  wakePointer
};
