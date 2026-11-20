// Generated from src/server/workflow/index-history.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { HISTORY_LIMIT, historyEntryProblem, historyOrder, insertHistoryEntry } from "./state.mjs";
import { parseStoreJson } from "./store-json.mjs";
const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5e3;
const real = (target) => realpath(target).catch(() => path.resolve(target));
async function indexHistoryFile(projectRoot, env = process.env) {
  const checkout = await real(projectRoot);
  const key = createHash("sha256").update(checkout).digest("hex").slice(0, 16);
  return { checkout, file: path.join(reviewAppDirectory(env), "index-history", `${key}.json`) };
}
async function readEntries(file, checkout) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return [];
  let parsed;
  try {
    parsed = parseStoreJson(await readFile(file, "utf8"));
  } catch {
    return [];
  }
  if (parsed?.schemaVersion !== SCHEMA_VERSION || parsed.checkout !== checkout || !Array.isArray(parsed.history)) return [];
  return parsed.history.filter((entry) => historyEntryProblem(entry) === null).sort(historyOrder).slice(-HISTORY_LIMIT);
}
async function readIndexHistory(projectRoot, env = process.env) {
  const { checkout, file } = await indexHistoryFile(projectRoot, env);
  return { schemaVersion: SCHEMA_VERSION, checkout, history: await readEntries(file, checkout) };
}
async function appendIndexHistory(projectRoot, entry, env = process.env) {
  const problem = historyEntryProblem(entry);
  if (problem) throw Object.assign(new Error(`The index history entry is invalid: ${problem}.`), { code: "invalid_entry" });
  const { checkout, file } = await indexHistoryFile(projectRoot, env);
  await mkdir(path.dirname(file), { recursive: true, mode: 448 });
  return withArtifactLock(file, () => withFileLock(file, async () => {
    const history = insertHistoryEntry(await readEntries(file, checkout), entry);
    await writeAtomically(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, checkout, history }, null, 2)}
`, { mode: 384 });
    return { schemaVersion: SCHEMA_VERSION, checkout, history };
  }, void 0, { timeoutMs: LOCK_TIMEOUT_MS }));
}
export {
  appendIndexHistory,
  indexHistoryFile,
  readIndexHistory
};
