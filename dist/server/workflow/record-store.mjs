import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import path from "node:path";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { pullRecordStoreIfStale, readSyncStatus, scheduleRecordSync, waitForStableStore } from "./record-store-sync.mjs";
import { managedRecordStore } from "./record-store-remote.mjs";
import { isRemoteStore } from "./remote-url.mjs";
import { initiativeDirectory, readWorkflowConfig, roadmapPaths } from "./workflow-config.mjs";

// Machine records live under .prism beside the workflow config, or in the record store the workflow config names; human documents and generated views stay under the configured paths.
// A record keeps its .prism path as its address in both cases: only recordStoreOf and resolveRecordFile know where its file lives.
export const RECORD_DIRECTORY = ".prism";
const INITIATIVES = `${RECORD_DIRECTORY}/initiatives`;
const ROADMAP_RECORD = `${RECORD_DIRECTORY}/roadmap.json`;
const RECORD_FILES = Object.freeze({ initiative: "initiative.json", state: "state.json", review: "review.json", "change-map": "change-map.json", "design-view": "design-view.json", "frozen-tests": "frozen-tests.json" });
const SLICE_KINDS = new Set(["review", "change-map", "design-view", "frozen-tests", "runs"]);
const LEGACY_CHANGE_MAP = "concept-delta.json";
const HOUSEKEEPING = Object.freeze({
  ".gitattributes": "# Prism writes these records through its MCP tools; hosts collapse them in pull request diffs.\n/roadmap.json linguist-generated=true gitlab-generated\n/initiatives/** linguist-generated=true gitlab-generated\n",
  ".gitignore": "# Transient lock and write files of Prism records, and the store's sync state.\n*.lock\n.*.tmp\n/.prism-sync/\n"
});
const RECORD_MAX_BYTES = 64 * 1024 * 1024;
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// A checkout can bring legacy records back, so a migration result is trusted only briefly.
const MIGRATION_TTL_MS = 5000;
const migrations = new Map();
const pendingMoves = new Map();
const unreportedMoves = [];

export class RecordStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RecordStoreError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code, message, details) => new RecordStoreError(code, message, details);

function requireSlug(value, label) {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) throw fail("invalid_path", `The ${label} identifier must use letters, digits, hyphens, or underscores.`);
  return value;
}

/** The project-relative location of a record key: { kind: "roadmap" | "initiative" | "state" | "review" | "change-map" | "design-view" | "frozen-tests" | "runs", initiative?, slice? }. */
export function recordPath(key) {
  if (key?.kind === "roadmap") return ROADMAP_RECORD;
  const initiative = requireSlug(key?.initiative, "initiative");
  if (key.kind === "initiative" || key.kind === "state") return `${INITIATIVES}/${initiative}/${RECORD_FILES[key.kind]}`;
  if (!SLICE_KINDS.has(key.kind)) throw fail("invalid_path", `Unknown record kind ${key.kind}.`);
  const folder = `${INITIATIVES}/${initiative}/slices/${requireSlug(key.slice, "slice")}`;
  return key.kind === "runs" ? `${folder}/runs` : `${folder}/${RECORD_FILES[key.kind]}`;
}

/** The key of a project-relative path under .prism, or null. */
export function parseRecordPath(relative) {
  if (relative === ROADMAP_RECORD) return { kind: "roadmap" };
  const parts = typeof relative === "string" ? relative.split("/") : [];
  if (parts[0] !== RECORD_DIRECTORY || parts[1] !== "initiatives" || !SLUG_PATTERN.test(parts[2] ?? "")) return null;
  if (parts.length === 4 && parts[3] === RECORD_FILES.initiative) return { kind: "initiative", initiative: parts[2] };
  if (parts.length === 4 && parts[3] === RECORD_FILES.state) return { kind: "state", initiative: parts[2] };
  if (parts[3] !== "slices" || !SLUG_PATTERN.test(parts[4] ?? "")) return null;
  const base = { initiative: parts[2], slice: parts[4] };
  if (parts.length === 6 && parts[5] === RECORD_FILES.review) return { kind: "review", ...base };
  if (parts.length === 6 && [RECORD_FILES["change-map"], LEGACY_CHANGE_MAP].includes(parts[5])) return { kind: "change-map", ...base };
  if (parts.length === 6 && parts[5] === RECORD_FILES["design-view"]) return { kind: "design-view", ...base };
  if (parts.length === 6 && parts[5] === RECORD_FILES["frozen-tests"]) return { kind: "frozen-tests", ...base };
  if (parts[5] === "runs") return { kind: "runs", ...base };
  return null;
}

/** Whether Prism alone writes this project-relative file, so source snapshots never count it. */
export function isManagedRecordFile(relative) {
  if (relative === ROADMAP_RECORD || relative.startsWith(`${INITIATIVES}/`)) return true;
  return relative.startsWith(`${RECORD_DIRECTORY}/`) && Object.hasOwn(HOUSEKEEPING, relative.slice(RECORD_DIRECTORY.length + 1));
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function projectRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw fail("invalid_project_root", "The project root must be an absolute path.");
  return realpath(root);
}

// The part of a project-relative path below .prism when the path names a record location; .prism/workflow.md and every other path stay in the project.
function storeRelative(relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) return null;
  const normalized = path.posix.normalize(relative.replaceAll("\\", "/")).replace(/\/$/, "");
  return normalized === INITIATIVES || isManagedRecordFile(normalized) ? normalized.slice(RECORD_DIRECTORY.length + 1) : null;
}

const physical = (store, relative) => path.join(store.base, relative.slice(RECORD_DIRECTORY.length + 1));

/**
 * Where a project's records live: { root, base, contain, external, sync }.
 * base holds what .prism holds in the project, and contain is the folder no record may resolve outside.
 * A configured store is never created or replaced by a fallback, because either would split the records of checkouts that share it.
 * A store named by its remote resolves to the clone Prism keeps of it, which the first access clones, and is then an external store like any other.
 */
export async function recordStoreOf(projectRootPath) {
  const root = await projectRoot(projectRootPath);
  const { workspace } = await readWorkflowConfig(root);
  const configured = workspace?.store ?? null;
  if (configured === null) return { root, base: path.join(root, RECORD_DIRECTORY), contain: root, external: false, sync: false };
  if (isRemoteStore(configured)) {
    const base = await managedRecordStore(root, configured, (message, store) => fail("store_unavailable", message, { store }));
    if (inside(root, base) || inside(base, root)) throw fail("store_unavailable", `The clone ${base} of the record store named under Workspace in .prism/workflow.md overlaps the project root. Keep the host's plugin data directory outside the project.`, { resolved: base });
    return { root, base, contain: base, external: true, sync: workspace.sync === true };
  }
  const resolved = path.resolve(root, configured);
  const unavailable = (reason) => fail("store_unavailable", `The record store ${configured} named under Workspace in .prism/workflow.md resolves to ${resolved}, which ${reason}`, { store: configured, resolved });
  let base;
  try { base = await realpath(resolved); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) throw unavailable("does not exist. Create or clone the store there; Prism never creates it.");
    throw error;
  }
  if (!(await stat(base)).isDirectory()) throw unavailable("is not a directory. Create or clone the store there; Prism never creates it.");
  if (inside(root, base)) throw unavailable("is inside the project root. Place the store outside the project, so every checkout can share it.");
  if (inside(base, root)) throw unavailable("contains the project root. Place the store beside the project, so records and project files never share a folder.");
  return { root, base, contain: base, external: true, sync: workspace.sync === true };
}

/** The latest sync outcome of a project's record store, or null when the store does not sync or has not synced yet. */
export async function recordSyncStatus(projectRootPath) {
  const store = await recordStoreOf(projectRootPath).catch(() => null);
  return store?.sync ? readSyncStatus(store.base) : null;
}

/** The physical file of a project-relative path, { root, target }: a record path maps into the record store, any other path stays under the project root. */
export async function resolveRecordFile(projectRootPath, relative) {
  const part = storeRelative(relative);
  if (part === null) return { root: projectRootPath, target: path.resolve(projectRootPath, relative) };
  const store = await recordStoreOf(projectRootPath);
  if (!store.external) return { root: projectRootPath, target: path.resolve(projectRootPath, relative) };
  return { root: store.contain, target: path.join(store.base, part) };
}

// Every existing ancestor must resolve inside the project, or inside the record store, so a symlink cannot redirect writes.
async function assertContained(root, target, label = "the project root") {
  let current = path.dirname(target);
  while (true) {
    try {
      if (!inside(root, await realpath(current))) throw fail("invalid_path", `The record location resolves outside ${label}.`);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw fail("invalid_path", `The record location cannot be resolved inside ${label}.`);
      current = parent;
    }
  }
}

async function regularFile(target) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw fail("invalid_path", "A record must be a regular file.");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readBytes(target, max) {
  let handle;
  try { handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    if (error.code === "ELOOP") throw fail("invalid_path", "A record must not be a symbolic link.");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail("invalid_path", "A record must be a regular file.");
    if (info.size > max) throw fail("artifact_too_large", `The record exceeds ${max} bytes.`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function ensureHousekeeping(store) {
  const directory = store.base;
  await mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(HOUSEKEEPING)) {
    const target = path.join(directory, name);
    if (!(await regularFile(target))) await writeAtomically(target, contents);
  }
}

// Each legacy record found beside the Markdown it describes, paired with its .prism location.
async function legacyRecords(root, store, config) {
  const moves = [];
  const roadmap = roadmapPaths(config);
  if (roadmap) moves.push({ from: roadmap.record, to: ROADMAP_RECORD });
  if (config.paths.plans === null) return moves;
  let entries = [];
  try { entries = await readdir(path.join(root, config.paths.plans), { withFileTypes: true }); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  for (const entry of entries.filter((item) => item.isDirectory() && SLUG_PATTERN.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const initiative = entry.name, directory = initiativeDirectory(config, initiative);
    moves.push({ from: `${directory}/${RECORD_FILES.initiative}`, to: recordPath({ kind: "initiative", initiative }) });
    moves.push({ from: `${directory}/${RECORD_FILES.state}`, to: recordPath({ kind: "state", initiative }) });
    // The initiative directory is the root slice's folder, so its slice records belong to the root slug the record names.
    const rootSlice = await legacyRootSlice(root, store, directory, initiative);
    const folders = [{ folder: directory, slice: rootSlice }];
    for (const child of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (child.isDirectory() && SLUG_PATTERN.test(child.name)) folders.push({ folder: `${directory}/${child.name}`, slice: child.name });
    }
    for (const { folder, slice } of folders) {
      moves.push({ from: `${folder}/${RECORD_FILES.review}`, to: recordPath({ kind: "review", initiative, slice }) });
      const changeMap = recordPath({ kind: "change-map", initiative, slice });
      moves.push({ from: `${folder}/${RECORD_FILES["change-map"]}`, to: changeMap });
      moves.push({ from: `${folder}/${LEGACY_CHANGE_MAP}`, to: changeMap });
    }
  }
  return moves;
}

async function legacyRootSlice(root, store, directory, initiative) {
  for (const candidate of [path.join(root, directory, RECORD_FILES.initiative), physical(store, recordPath({ kind: "initiative", initiative }))]) {
    try {
      const record = JSON.parse(await readFile(candidate, "utf8"));
      const found = Object.entries(record?.slices ?? {}).find(([, slice]) => slice?.parent === null)?.[0];
      if (found && SLUG_PATTERN.test(found)) return found;
    } catch { /* A missing or unreadable record falls back to the initiative identifier. */ }
  }
  return initiative;
}

// With a record store, the records a checkout still holds under its own .prism move into the store too.
async function inRepoRecords(root) {
  const moves = [];
  const visit = async (relative) => {
    let entries = [];
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith(".json")) moves.push({ from: child, to: child });
    }
  };
  if (await regularFile(path.join(root, ROADMAP_RECORD))) moves.push({ from: ROADMAP_RECORD, to: ROADMAP_RECORD });
  await visit(INITIATIVES);
  return moves;
}

async function pruneEmptyFolders(target) {
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) if (entry.isDirectory()) await pruneEmptyFolders(path.join(target, entry.name));
  await rmdir(target).catch(() => {});
}

async function moveRecord(root, store, move, report) {
  const source = path.join(root, move.from), target = physical(store, move.to);
  if (!(await regularFile(source))) return;
  await assertContained(root, source);
  await assertContained(store.contain, target, store.external ? "the record store" : "the project root");
  if (await regularFile(target)) {
    const [left, right] = await Promise.all([readFile(source), readFile(target)]);
    if (left.equals(right)) { await rm(source, { force: true }); report.moved.push(move); return; }
    report.conflicts.push(move);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  // A store can sit on another file system, where rename fails, so its records are copied and then removed.
  if (store.external) { await writeAtomically(target, await readFile(source)); await rm(source, { force: true }); }
  else await rename(source, target);
  report.moved.push(move);
}

/** The identity every full clone of one repository shares, its first root commit in sorted order, or null outside Git, before the first commit, or in a shallow clone, whose oldest fetched commits only look like roots. */
// A root commit never changes once it exists, so each project asks Git only until it has one.
const repositoryIds = new Map();
const git = (root, args) => new Promise((resolve) => {
  execFile("git", ["-C", root, ...args], { timeout: 10000 }, (error, stdout) => resolve(error ? null : stdout.trim()));
});
export async function repositoryId(root) {
  if (repositoryIds.has(root)) return repositoryIds.get(root);
  const shallow = await git(root, ["rev-parse", "--is-shallow-repository"]);
  if (shallow === "true") { repositoryIds.set(root, null); return null; }
  const id = shallow === null ? null : ((await git(root, ["rev-list", "--max-parents=0", "HEAD"])) ?? "").split(/\s+/).filter(Boolean).sort()[0] || null;
  if (id) repositoryIds.set(root, id);
  return id;
}

// Every record path a store ever took from a checkout, from the migration files under its migrations folder.
// Each migration writes a file of its own, so two machines never change the same file and the store's Git merge never conflicts on them.
const LEGACY_MARKER = /^[0-9a-f]{40,64}\.json$/;
const ledgers = new Map();
async function readLedger(store) {
  const directory = path.join(store.base, "migrations");
  let names = [];
  try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort(); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  const cached = ledgers.get(store.base);
  if (cached && cached.names === names.join("\n")) return cached.ledger;
  const ledger = { records: new Set(), repositories: new Set() };
  for (const name of names) {
    let entry;
    try { entry = JSON.parse(await readFile(path.join(directory, name), "utf8")); }
    catch { continue; }
    // A file from before the ledger names the repository it migrated, without the paths.
    if (LEGACY_MARKER.test(name)) ledger.repositories.add(name.slice(0, -".json".length));
    for (const record of entry?.records ?? []) if (typeof record === "string") ledger.records.add(record);
    for (const conflict of entry?.conflicts ?? []) if (typeof conflict?.to === "string") ledger.records.add(conflict.to);
  }
  ledgers.set(store.base, { names: names.join("\n"), ledger });
  return ledger;
}

// Committed records exist in every checkout, so a store takes each record path only once; a later copy would bring back a record removed since.
async function migrateIntoStore(root, store, config, report) {
  const repository = await repositoryId(root);
  if (repository && (await readLedger(store)).repositories.has(repository)) return report;
  const candidates = async () => [...await inRepoRecords(root), ...await legacyRecords(root, store, config)];
  const fresh = async () => {
    const { records } = await readLedger(store);
    const moves = [];
    for (const move of await candidates()) if (!records.has(move.to) && await regularFile(path.join(root, move.from))) moves.push(move);
    return moves;
  };
  if (!(await fresh()).length) return report;
  await ensureHousekeeping(store);
  const lock = path.join(store.base, "migration");
  await withArtifactLock(lock, () => withFileLock(lock, async () => {
    // Records already under the project's .prism come first, so they win over a legacy copy as they do without a store.
    for (const move of await fresh()) await moveRecord(root, store, move, report);
    if (!report.moved.length && !report.conflicts.length) return;
    const at = new Date().toISOString();
    const marker = path.join(store.base, "migrations", `${at.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.json`);
    await mkdir(path.dirname(marker), { recursive: true });
    await assertContained(store.contain, marker, "the record store");
    const records = [...new Set(report.moved.map((move) => move.to))];
    await writeAtomically(marker, `${JSON.stringify({ schemaVersion: 2, repository, migratedAt: at, moved: records.length, records, conflicts: report.conflicts }, null, 2)}\n`);
  }, fail, { timeoutMs: 30000 }));
  await pruneEmptyFolders(path.join(root, INITIATIVES));
  return report;
}

async function migrate(root) {
  const report = { moved: [], conflicts: [] };
  const store = await recordStoreOf(root);
  const config = await readWorkflowConfig(root);
  if (store.external) {
    await migrateIntoStore(root, store, config, report);
    if (report.moved.length || report.conflicts.length) unreportedMoves.push({ root, store: store.base, ...report });
    return report;
  }
  const moves = await legacyRecords(root, store, config);
  const pending = [];
  for (const move of moves) if (await regularFile(path.join(root, move.from))) pending.push(move);
  if (!pending.length) return report;
  await ensureHousekeeping(store);
  const lock = path.join(store.base, "migration");
  await withArtifactLock(lock, () => withFileLock(lock, async () => {
    for (const move of pending) await moveRecord(root, store, move, report);
  }, fail, { timeoutMs: 30000 }));
  pendingMoves.delete(root);
  if (report.moved.length || report.conflicts.length) unreportedMoves.push({ root, ...report });
  return report;
}

// Legacy records still beside their Markdown, by the .prism path each moves to: reads resolve a record there until a write moves them all.
// A record store takes a checkout's records on its first access, so only records in the project are read in place.
function legacyLocations(root, store) {
  if (store.external) return Promise.resolve(new Map());
  const cached = pendingMoves.get(root);
  if (cached && Date.now() - cached.at < MIGRATION_TTL_MS) return cached.value;
  const value = (async () => {
    const found = new Map();
    for (const move of await legacyRecords(root, store, await readWorkflowConfig(root))) {
      if (found.has(move.to) || !(await regularFile(path.join(root, move.from)).catch(() => false))) continue;
      if (!(await regularFile(path.join(root, move.to)).catch(() => true))) found.set(move.to, move.from);
    }
    return found;
  })();
  value.catch(() => pendingMoves.delete(root));
  pendingMoves.set(root, { at: Date.now(), value });
  return value;
}

/** The record moves that writes made since the last call, for the tool result that reports them. */
export function takeMigrationReports() {
  return unreportedMoves.splice(0);
}

/** Move legacy records before a record update, so the update reads and locks each record where it now lives; an unusable root is left for the update to report. */
export async function moveLegacyRecords(projectRootPath) {
  let root;
  try { root = await projectRoot(projectRootPath); } catch { return; }
  await ensureRecords(root);
}

/** Move every legacy record of a project into .prism, or into its record store, once per process, so all initiatives read from one place; only writes move records into .prism. */
export function ensureRecords(root) {
  const existing = migrations.get(root);
  if (existing && Date.now() - existing.at < MIGRATION_TTL_MS) return existing.pending;
  const pending = migrate(root).catch((error) => {
    migrations.delete(root);
    throw error;
  });
  migrations.set(root, { at: Date.now(), pending });
  return pending;
}

/** Forget recent migration checks, so the next record access looks for legacy records again. */
export function forgetMigrations() {
  migrations.clear();
  pendingMoves.clear();
}

const storeLabel = (store) => store.external ? "the record store" : "the project root";

// A synced store pulls in the background when its last fetch is old, and record access waits while a merge replaces record files.
async function synced(store) {
  if (!store.sync) return;
  pullRecordStoreIfStale(store.base);
  await waitForStableStore(store.base);
}

// Records move into .prism only on a write, while a record store takes a checkout's records on its first access.
async function openStore(projectRootPath, { write = false } = {}) {
  const store = await recordStoreOf(projectRootPath);
  if (write || store.external) await ensureRecords(store.root);
  await synced(store);
  return store;
}

async function locate(projectRootPath, key, options) {
  const store = await openStore(projectRootPath, options);
  const relative = recordPath(key);
  const target = physical(store, relative);
  await assertContained(store.contain, target, storeLabel(store));
  const located = { root: store.root, path: relative, target };
  if (key.kind === "runs" || await regularFile(target)) return { store, located };
  // Before the first write moves them, a record is read where an older Prism kept it.
  const legacy = (await legacyLocations(store.root, store)).get(relative);
  if (!legacy) return { store, located };
  const source = path.join(store.root, legacy);
  await assertContained(store.root, source);
  return { store, located: { ...located, target: source, legacy } };
}

/** Resolve a record key to its file: { root, path, target, legacy? }, where path stays the .prism address and target is the file in the project, the record store, or a legacy location. */
export async function locateRecord(projectRootPath, key) {
  return (await locate(projectRootPath, key)).located;
}

/** Read a record's bytes, or null when it does not exist. */
export async function readRecord(projectRootPath, key, { maxBytes = RECORD_MAX_BYTES } = {}) {
  const { located } = await locate(projectRootPath, key);
  return { ...located, bytes: await readBytes(located.target, maxBytes) };
}

/** Replace a record atomically. */
export async function writeRecord(projectRootPath, key, contents) {
  const { store, located } = await locate(projectRootPath, key, { write: true });
  await mkdir(path.dirname(located.target), { recursive: true });
  await assertContained(store.contain, located.target, storeLabel(store));
  await ensureHousekeeping(store);
  await writeAtomically(located.target, contents);
  if (store.sync) scheduleRecordSync(store.base);
  return located;
}

/** Run an action while holding a record's in-process and cross-process locks. */
export async function withRecordLock(projectRootPath, key, action, makeError = fail, options = {}) {
  const { store, located } = await locate(projectRootPath, key, { write: true });
  await mkdir(path.dirname(located.target), { recursive: true });
  await assertContained(store.contain, located.target, storeLabel(store));
  return withArtifactLock(located.target, () => withFileLock(located.target, () => action(located), makeError, options));
}

/** Add one immutable entry under a list key such as runs; an existing entry is never replaced. */
export async function appendRecord(projectRootPath, key, id, entry) {
  if (typeof id !== "string" || !ENTRY_ID.test(id)) throw fail("validation_failed", "An entry id must use letters, digits, dots, hyphens, or underscores.");
  const { store, located } = await locate(projectRootPath, key, { write: true });
  const target = path.join(located.target, `${id}.json`);
  await ensureHousekeeping(store);
  await mkdir(located.target, { recursive: true });
  await assertContained(store.contain, target, storeLabel(store));
  const appended = await withArtifactLock(target, () => withFileLock(target, async () => {
    if (await regularFile(target)) throw fail("entry_exists", `The entry ${id} already exists.`);
    await writeAtomically(target, `${JSON.stringify(entry, null, 2)}\n`);
    return { ...located, path: `${located.path}/${id}.json`, target };
  }, fail));
  if (store.sync) scheduleRecordSync(store.base);
  return appended;
}

/** List the entries of a list key in id order. */
export async function listRecordEntries(projectRootPath, key, { maxBytes = 1024 * 1024 } = {}) {
  const { located } = await locate(projectRootPath, key);
  let names = [];
  try { names = (await readdir(located.target)).filter((name) => name.endsWith(".json") && ENTRY_ID.test(name.slice(0, -5))).sort(); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  const entries = [];
  for (const name of names) {
    const bytes = await readBytes(path.join(located.target, name), maxBytes);
    if (bytes !== null) entries.push({ id: name.slice(0, -5), entry: JSON.parse(bytes.toString("utf8")) });
  }
  return entries;
}

async function directoryNames(target) {
  try { return (await readdir(target, { withFileTypes: true })).filter((entry) => entry.isDirectory() && SLUG_PATTERN.test(entry.name)).map((entry) => entry.name).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

/** The initiatives that hold an initiative record or coordination state. */
export async function listInitiatives(projectRootPath) {
  const store = await openStore(projectRootPath);
  const ids = new Set();
  for (const initiative of await directoryNames(physical(store, INITIATIVES))) {
    for (const kind of ["initiative", "state"]) if (await regularFile(physical(store, recordPath({ kind, initiative })))) { ids.add(initiative); break; }
  }
  for (const relative of (await legacyLocations(store.root, store)).keys()) {
    const key = parseRecordPath(relative);
    if (key?.kind === "initiative" || key?.kind === "state") ids.add(key.initiative);
  }
  return [...ids].sort();
}

/** The slices of an initiative that hold any record. */
export async function listSliceRecords(projectRootPath, initiative) {
  const store = await openStore(projectRootPath);
  const slices = new Set(await directoryNames(path.join(physical(store, INITIATIVES), requireSlug(initiative, "initiative"), "slices")));
  for (const relative of (await legacyLocations(store.root, store)).keys()) {
    const key = parseRecordPath(relative);
    if (key?.slice && key.initiative === initiative) slices.add(key.slice);
  }
  return [...slices].sort();
}

/** Remove an initiative's coordination records after its coordination ends; run entries outlive the cleanup. */
export async function removeInitiativeRecords(projectRootPath, initiative) {
  const store = await recordStoreOf(projectRootPath);
  await ensureRecords(store.root);
  await synced(store);
  const target = path.join(physical(store, INITIATIVES), requireSlug(initiative, "initiative"));
  await assertContained(store.contain, path.join(target, "x"), storeLabel(store));
  for (const kind of ["initiative", "state"]) await rm(physical(store, recordPath({ kind, initiative })), { force: true });
  for (const slice of await directoryNames(path.join(target, "slices"))) {
    const folder = path.join(target, "slices", slice);
    for (const entry of await readdir(folder)) if (entry !== "runs") await rm(path.join(folder, entry), { recursive: true, force: true });
    await rmdir(folder).catch(() => {});
  }
  // Only folders left empty go, so a slice that still holds runs keeps its path.
  await rmdir(path.join(target, "slices")).catch(() => {});
  await rmdir(target).catch(() => {});
  await rmdir(physical(store, INITIATIVES)).catch(() => {});
  if (store.sync) scheduleRecordSync(store.base);
}

/** The legacy and current location of a slice's human documents: the root slice shares the initiative folder. */
export async function sliceDocumentFolder(projectRootPath, initiative, slice) {
  const root = await projectRoot(projectRootPath);
  const config = await readWorkflowConfig(root);
  const directory = initiativeDirectory(config, requireSlug(initiative, "initiative"));
  if (directory === null) return null;
  requireSlug(slice, "slice");
  const store = await recordStoreOf(root);
  const bytes = await readBytes(physical(store, recordPath({ kind: "initiative", initiative })), 1024 * 1024).catch(() => null);
  let rootSlice = initiative;
  try {
    const found = bytes && Object.entries(JSON.parse(bytes.toString("utf8"))?.slices ?? {}).find(([, value]) => value?.parent === null)?.[0];
    if (found) rootSlice = found;
  } catch { /* An unreadable record keeps the identifier convention. */ }
  return slice === rootSlice ? directory : `${directory}/${slice}`;
}

/** Map a stored legacy record path, such as an older review's change map, to the key it now lives under. */
export async function keyOfPath(projectRootPath, relative) {
  const direct = parseRecordPath(relative);
  if (direct) return direct;
  const root = await projectRoot(projectRootPath);
  const config = await readWorkflowConfig(root);
  const roadmap = roadmapPaths(config);
  if (roadmap && relative === roadmap.record) return { kind: "roadmap" };
  if (config.paths.plans === null) return null;
  const prefix = `${config.paths.plans}/`;
  if (typeof relative !== "string" || !relative.startsWith(prefix)) return null;
  const parts = relative.slice(prefix.length).split("/");
  const initiative = parts[0];
  if (!SLUG_PATTERN.test(initiative ?? "")) return null;
  const name = parts.at(-1);
  if (parts.length === 2 && (name === RECORD_FILES.initiative || name === RECORD_FILES.state)) return { kind: name === RECORD_FILES.state ? "state" : "initiative", initiative };
  const kind = name === RECORD_FILES.review ? "review" : [RECORD_FILES["change-map"], LEGACY_CHANGE_MAP].includes(name) ? "change-map" : null;
  if (!kind) return null;
  if (parts.length === 2) return { kind, initiative, slice: await legacyRootSlice(root, await recordStoreOf(root), `${config.paths.plans}/${initiative}`, initiative) };
  if (parts.length === 3 && SLUG_PATTERN.test(parts[1])) return { kind, initiative, slice: parts[1] };
  return null;
}

/** Whether two stored paths, current or legacy, name the same record. */
export async function sameRecord(projectRootPath, left, right) {
  if (left === right) return true;
  const [a, b] = await Promise.all([keyOfPath(projectRootPath, left), keyOfPath(projectRootPath, right)]);
  return Boolean(a && b) && recordPath(a) === recordPath(b);
}
