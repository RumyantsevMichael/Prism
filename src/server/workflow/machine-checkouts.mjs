import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { isRemoteStore, managedStoreId, managedStoresDirectory } from "./remote-url.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";
import { parseStoreJson } from "./store-json.mjs";

// Each machine lists where its checkouts of each named repository are, in Prism's application folder beside the managed store clones.
// The list holds local paths, so it stays on this machine and never reaches a record store.
const CHECKOUTS_FILE = "checkouts.json";
const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;

/** The machine's checkout list: checkouts.json in Prism's application folder, the folder that holds managed store clones. */
export function checkoutsFile(env = process.env) {
  return path.join(reviewAppDirectory(env), CHECKOUTS_FILE);
}

const real = (target) => realpath(target).catch(() => path.resolve(target));

const validEntry = (entry) => entry !== null && typeof entry === "object"
  && typeof entry.store === "string" && path.isAbsolute(entry.store)
  && typeof entry.repository === "string" && entry.repository
  && typeof entry.path === "string" && path.isAbsolute(entry.path)
  && typeof entry.recordedAt === "string";

// The listed entries, [] for a missing or unreadable list, or null for a list this Prism must leave alone: another schemaVersion, or no regular file.
async function readEntries(file) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (info.isSymbolicLink() || !info.isFile()) return null;
  let parsed;
  try { parsed = parseStoreJson(await readFile(file, "utf8")); } catch { return []; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !Object.hasOwn(parsed, "schemaVersion")) return [];
  if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
  return Array.isArray(parsed.checkouts) ? parsed.checkouts.filter(validEntry) : [];
}

// The real path of the store a checkout's workflow configuration names, without cloning a remote store, or null when it names none.
async function configuredStore(root, env) {
  const { workspace } = await readWorkflowConfig(root);
  const configured = workspace?.store ?? null;
  if (configured === null) return { store: null, repository: null };
  if (isRemoteStore(configured)) {
    const id = managedStoreId(configured);
    return { store: id ? await real(path.join(managedStoresDirectory(env), id)) : null, repository: workspace.repository };
  }
  return { store: await real(path.resolve(root, configured)), repository: workspace.repository };
}

// Whether a listed path still holds a .prism/workflow.md that names this store and this repository name.
async function stillHolds(entry, env) {
  try {
    const named = await configuredStore(entry.path, env);
    return named.store === entry.store && named.repository === entry.repository;
  } catch { return false; }
}

const order = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const byPlace = (left, right) => order(left.store, right.store) || order(left.repository, right.repository) || order(left.path, right.path);

/**
 * Record a checkout of a named repository in this machine's list: replace any entry with the same path, drop each entry of the same store and repository whose path no longer holds that checkout, and rewrite the list atomically under its lock.
 * Resolves to true when the list was written, or false when it is left alone because another Prism wrote it with another schemaVersion.
 */
export async function recordCheckout({ store, repository, path: checkout, env = process.env, now = new Date() }) {
  const file = checkoutsFile(env);
  const entry = { store: await real(store), repository, path: await real(checkout), recordedAt: now.toISOString() };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return withArtifactLock(file, () => withFileLock(file, async () => {
    const listed = await readEntries(file);
    if (listed === null) return false;
    const kept = [];
    for (const item of listed) {
      if (item.path === entry.path) continue;
      if (item.store === entry.store && item.repository === entry.repository && !(await stillHolds(item, env))) continue;
      kept.push(item);
    }
    const checkouts = [...kept, entry].sort(byPlace).map(({ store: where, repository: name, path: at, recordedAt }) => ({ store: where, repository: name, path: at, recordedAt }));
    await writeAtomically(file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, checkouts }, null, 2)}\n`, { mode: 0o600 });
    return true;
  }, undefined, { timeoutMs: LOCK_TIMEOUT_MS }));
}
