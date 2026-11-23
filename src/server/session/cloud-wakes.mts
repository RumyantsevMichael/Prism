import { spawn } from "node:child_process";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { parseStoreJson } from "../workflow/store-json.mjs";
import { askerSubject, strippedEnvironment, type AskerResume } from "./launch-hosts.mjs";

// A wake posts one turn into the Claude Code cloud session that asked a gate, from the person's own computer, through
// `claude -p <pointer> --cloud <cse id>`; the turn is only a pointer to the answer, so nothing else of the gate reaches the harness.
// This machine keeps the latest wake of each gate in a private file of its review app folder, so the gate's card can show it.

const WAKES_FILE = "gate-wakes.json";
const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
// The most gates the file keeps, the newest wake first.
const ENTRIES_KEPT = 500;
export const WAKE_LIMIT_MS = 120 * 1000;
const REASON_MAX = 300;
const CLOUD_ID = /^cse_[A-Za-z0-9]{8,120}$/;
// A wake runs without the host session variables of the review app's own environment and outside any launch.
const WAKE_STRIPPED = ["PRISM_LAUNCH", "CLAUDE_CODE_REMOTE"];

export interface WakeResult { at: string; delivered: boolean; reason: string | null }

/** Whether a value is a Claude Code cloud session id, cse_<id>, that a wake may name. */
export const isCloudSessionId = (value: unknown): value is string => typeof value === "string" && CLOUD_ID.test(value);

/** The only text a wake sends: the gate, what it belongs to, and that its answer is in Prism's records. */
export function wakePointer(subject: AskerResume) {
  return `Prism: question ${subject.gate} of ${askerSubject(subject)} has an answer in the review app. Read it from Prism's records before you continue.`;
}

/** The environment of a wake: the review app's own, without the host session variables and without a launch. */
export function wakeEnvironment(env: NodeJS.ProcessEnv) {
  const result = strippedEnvironment(env);
  for (const name of WAKE_STRIPPED) delete result[name];
  return result;
}

const lastLine = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? null;

/**
 * Sends one wake: runs the resolved claude with `-p <pointer> --cloud <cse id>` in the checkout, standard input closed, and a limit of
 * 120 seconds, and answers whether Claude Code delivered it, with the reason it gave when it did not.
 */
export function sendWake({ command, prefix = [], cloud, pointer, checkout, env, limitMs = WAKE_LIMIT_MS }: { command: string; prefix?: string[]; cloud: string; pointer: string; checkout: string; env: NodeJS.ProcessEnv; limitMs?: number }): Promise<WakeResult> {
  if (!isCloudSessionId(cloud)) throw new Error("The cloud session id is not one Prism can pass to Claude Code.");
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (delivered: boolean, reason: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ at: new Date().toISOString(), delivered, reason: reason === null ? null : reason.slice(0, REASON_MAX) });
    };
    let child: any;
    try {
      child = spawn(command, [...prefix, "-p", pointer, "--cloud", cloud], { cwd: checkout, env: wakeEnvironment(env), shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (error: any) {
      resolve({ at: new Date().toISOString(), delivered: false, reason: String(error?.message ?? error).slice(0, REASON_MAX) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      done(false, `The wake did not finish within ${Math.round(limitMs / 1000)} seconds.`);
    }, limitMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.on("error", (error: any) => done(false, lastLine(stderr) ?? String(error?.message ?? error)));
    child.on("close", (code: number | null, signal: string | null) => {
      if (timedOut) return;
      if (code === 0) return done(true, null);
      done(false, lastLine(stderr) ?? `The wake exited with code ${code ?? signal ?? "unknown"}.`);
    });
  });
}

export function gateWakesFile(env = process.env) {
  return path.join(reviewAppDirectory(env), WAKES_FILE);
}

const validWake = (entry: any): entry is WakeResult => entry !== null && typeof entry === "object" && !Array.isArray(entry)
  && typeof entry.at === "string" && typeof entry.delivered === "boolean" && (entry.reason === null || typeof entry.reason === "string");

async function readEntries(file: string): Promise<Record<string, WakeResult>> {
  let info;
  try { info = await lstat(file); } catch { return {}; }
  if (info.isSymbolicLink() || !info.isFile()) return {};
  let parsed;
  try { parsed = parseStoreJson(await readFile(file, "utf8")); } catch { return {}; }
  if (parsed?.schemaVersion !== SCHEMA_VERSION || parsed.gates === null || typeof parsed.gates !== "object" || Array.isArray(parsed.gates)) return {};
  return Object.fromEntries(Object.entries(parsed.gates).filter(([, entry]) => validWake(entry)).map(([target, entry]: [string, any]) => [target, { at: entry.at, delivered: entry.delivered, reason: entry.reason }]));
}

/** Keeps the latest wake of a gate target, gate:<initiative>/<id> or approval:<id>, in this machine's private file. */
export async function keepGateWake(target: string, wake: WakeResult, env = process.env) {
  const file = gateWakesFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withArtifactLock(file, () => withFileLock(file, async () => {
    const gates = await readEntries(file);
    gates[target] = { at: wake.at, delivered: wake.delivered, reason: wake.reason };
    const kept = Object.entries(gates).sort(([, left], [, right]) => right.at.localeCompare(left.at)).slice(0, ENTRIES_KEPT);
    await writeAtomically(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, gates: Object.fromEntries(kept) }, null, 2)}\n`, { mode: 0o600 });
  }, undefined, { timeoutMs: LOCK_TIMEOUT_MS }));
}

/** The latest wake of each gate target that this machine sent. */
export async function readGateWakes(env = process.env) {
  return readEntries(gateWakesFile(env));
}
