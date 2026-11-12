import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { HISTORY_LIMIT, historyEntryProblem, historyOrder, insertHistoryEntry } from "./state.mjs";
import { parseStoreJson } from "./store-json.mjs";

// A checkout's index belongs to this machine, so the history of its rebuilds stays in Prism's application folder and never reaches a record store.
const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;

const real = (target) => realpath(target).catch(() => path.resolve(target));

/** The index history file of a checkout: index-history/<first 16 hexadecimal digits of the SHA-256 of its real path>.json in Prism's application folder. */
export async function indexHistoryFile(projectRoot, env = process.env) {
  const checkout = await real(projectRoot);
  const key = createHash("sha256").update(checkout).digest("hex").slice(0, 16);
  return { checkout, file: path.join(reviewAppDirectory(env), "index-history", `${key}.json`) };
}

// The entries of a well-formed file of this checkout in history order; anything else reads as an empty history.
async function readEntries(file, checkout) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (info.isSymbolicLink() || !info.isFile()) return [];
  let parsed;
  try { parsed = parseStoreJson(await readFile(file, "utf8")); } catch { return []; }
  if (parsed?.schemaVersion !== SCHEMA_VERSION || parsed.checkout !== checkout || !Array.isArray(parsed.history)) return [];
  return parsed.history.filter((entry) => historyEntryProblem(entry) === null).sort(historyOrder).slice(-HISTORY_LIMIT);
}

/** The checkout's index history, { schemaVersion, checkout, history }, with every index target's entries in history order. */
export async function readIndexHistory(projectRoot, env = process.env) {
  const { checkout, file } = await indexHistoryFile(projectRoot, env);
  return { schemaVersion: SCHEMA_VERSION, checkout, history: await readEntries(file, checkout) };
}

/** Adds an entry at its place in the checkout's index history under its lock, keeping the newest entries, in a file readable only by its user. */
export async function appendIndexHistory(projectRoot, entry, env = process.env) {
  const problem = historyEntryProblem(entry);
  if (problem) throw Object.assign(new Error(`The index history entry is invalid: ${problem}.`), { code: "invalid_entry" });
  const { checkout, file } = await indexHistoryFile(projectRoot, env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return withArtifactLock(file, () => withFileLock(file, async () => {
    const history = insertHistoryEntry(await readEntries(file, checkout), entry);
    await writeAtomically(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, checkout, history }, null, 2)}\n`, { mode: 0o600 });
    return { schemaVersion: SCHEMA_VERSION, checkout, history };
  }, undefined, { timeoutMs: LOCK_TIMEOUT_MS }));
}
