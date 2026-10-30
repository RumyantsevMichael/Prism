import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { initiativeDirectory, readWorkflowConfig, roadmapPaths } from "./workflow-config.mjs";

// Machine records live under .prism beside the workflow config; human documents and generated views stay under the configured paths.
export const RECORD_DIRECTORY = ".prism";
const INITIATIVES = `${RECORD_DIRECTORY}/initiatives`;
const ROADMAP_RECORD = `${RECORD_DIRECTORY}/roadmap.json`;
const RECORD_FILES = Object.freeze({ initiative: "initiative.json", state: "state.json", review: "review.json", "change-map": "change-map.json", "design-view": "design-view.json", "frozen-tests": "frozen-tests.json" });
const SLICE_KINDS = new Set(["review", "change-map", "design-view", "frozen-tests", "runs"]);
const LEGACY_CHANGE_MAP = "concept-delta.json";
const HOUSEKEEPING = Object.freeze({
  ".gitattributes": "# Prism writes these records through its MCP tools; hosts collapse them in pull request diffs.\n/roadmap.json linguist-generated=true gitlab-generated\n/initiatives/** linguist-generated=true gitlab-generated\n",
  ".gitignore": "# Transient lock and write files of Prism records.\n*.lock\n.*.tmp\n"
});
const RECORD_MAX_BYTES = 64 * 1024 * 1024;
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// A checkout can bring legacy records back, so a migration result is trusted only briefly.
const MIGRATION_TTL_MS = 5000;
const migrations = new Map();

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

// Every existing ancestor must resolve inside the project, so a symlinked .prism cannot redirect writes.
async function assertContained(root, target) {
  let current = path.dirname(target);
  while (true) {
    try {
      if (!inside(root, await realpath(current))) throw fail("invalid_path", "The record location resolves outside the project root.");
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw fail("invalid_path", "The record location cannot be resolved inside the project root.");
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

async function ensureHousekeeping(root) {
  const directory = path.join(root, RECORD_DIRECTORY);
  await mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(HOUSEKEEPING)) {
    const target = path.join(directory, name);
    if (!(await regularFile(target))) await writeAtomically(target, contents);
  }
}

// Each legacy record found beside the Markdown it describes, paired with its .prism location.
async function legacyRecords(root, config) {
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
    const rootSlice = await legacyRootSlice(root, directory, initiative);
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

async function legacyRootSlice(root, directory, initiative) {
  for (const candidate of [`${directory}/${RECORD_FILES.initiative}`, recordPath({ kind: "initiative", initiative })]) {
    try {
      const record = JSON.parse(await readFile(path.join(root, candidate), "utf8"));
      const found = Object.entries(record?.slices ?? {}).find(([, slice]) => slice?.parent === null)?.[0];
      if (found && SLUG_PATTERN.test(found)) return found;
    } catch { /* A missing or unreadable record falls back to the initiative identifier. */ }
  }
  return initiative;
}

async function moveRecord(root, move, report) {
  const source = path.join(root, move.from), target = path.join(root, move.to);
  if (!(await regularFile(source))) return;
  await assertContained(root, source);
  await assertContained(root, target);
  if (await regularFile(target)) {
    const [left, right] = await Promise.all([readFile(source), readFile(target)]);
    if (left.equals(right)) { await rm(source, { force: true }); report.moved.push(move); return; }
    report.conflicts.push(move);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await rename(source, target);
  report.moved.push(move);
}

async function migrate(root) {
  const report = { moved: [], conflicts: [] };
  const config = await readWorkflowConfig(root);
  const moves = await legacyRecords(root, config);
  const pending = [];
  for (const move of moves) if (await regularFile(path.join(root, move.from))) pending.push(move);
  // Reads never create files, so a project without legacy records stays untouched until its first record write.
  if (!pending.length) return report;
  await ensureHousekeeping(root);
  const lock = path.join(root, RECORD_DIRECTORY, "migration");
  await withArtifactLock(lock, () => withFileLock(lock, async () => {
    for (const move of pending) await moveRecord(root, move, report);
  }, fail, { timeoutMs: 30000 }));
  return report;
}

/** Move every legacy record of a project into .prism once per process, so all initiatives read from one place. */
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
}

/** Resolve a record key to its file: { root, path, target }. */
export async function locateRecord(projectRootPath, key) {
  const root = await projectRoot(projectRootPath);
  await ensureRecords(root);
  const relative = recordPath(key);
  const target = path.join(root, relative);
  await assertContained(root, target);
  if (key.kind !== "runs") await regularFile(target);
  return { root, path: relative, target };
}

/** Read a record's bytes, or null when it does not exist. */
export async function readRecord(projectRootPath, key, { maxBytes = RECORD_MAX_BYTES } = {}) {
  const located = await locateRecord(projectRootPath, key);
  return { ...located, bytes: await readBytes(located.target, maxBytes) };
}

/** Replace a record atomically. */
export async function writeRecord(projectRootPath, key, contents) {
  const located = await locateRecord(projectRootPath, key);
  await mkdir(path.dirname(located.target), { recursive: true });
  await assertContained(located.root, located.target);
  await ensureHousekeeping(located.root);
  await writeAtomically(located.target, contents);
  return located;
}

/** Run an action while holding a record's in-process and cross-process locks. */
export async function withRecordLock(projectRootPath, key, action, makeError = fail, options = {}) {
  const located = await locateRecord(projectRootPath, key);
  await mkdir(path.dirname(located.target), { recursive: true });
  await assertContained(located.root, located.target);
  return withArtifactLock(located.target, () => withFileLock(located.target, () => action(located), makeError, options));
}

/** Add one immutable entry under a list key such as runs; an existing entry is never replaced. */
export async function appendRecord(projectRootPath, key, id, entry) {
  if (typeof id !== "string" || !ENTRY_ID.test(id)) throw fail("validation_failed", "An entry id must use letters, digits, dots, hyphens, or underscores.");
  const located = await locateRecord(projectRootPath, key);
  const target = path.join(located.target, `${id}.json`);
  await ensureHousekeeping(located.root);
  await mkdir(located.target, { recursive: true });
  await assertContained(located.root, target);
  return withArtifactLock(target, () => withFileLock(target, async () => {
    if (await regularFile(target)) throw fail("entry_exists", `The entry ${id} already exists.`);
    await writeAtomically(target, `${JSON.stringify(entry, null, 2)}\n`);
    return { ...located, path: `${located.path}/${id}.json`, target };
  }, fail));
}

/** List the entries of a list key in id order. */
export async function listRecordEntries(projectRootPath, key, { maxBytes = 1024 * 1024 } = {}) {
  const located = await locateRecord(projectRootPath, key);
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
  const root = await projectRoot(projectRootPath);
  await ensureRecords(root);
  const ids = [];
  for (const initiative of await directoryNames(path.join(root, INITIATIVES))) {
    for (const kind of ["initiative", "state"]) if (await regularFile(path.join(root, recordPath({ kind, initiative })))) { ids.push(initiative); break; }
  }
  return ids;
}

/** The slices of an initiative that hold any record. */
export async function listSliceRecords(projectRootPath, initiative) {
  const root = await projectRoot(projectRootPath);
  await ensureRecords(root);
  return directoryNames(path.join(root, INITIATIVES, requireSlug(initiative, "initiative"), "slices"));
}

/** Remove an initiative's coordination records after its coordination ends; run entries outlive the cleanup. */
export async function removeInitiativeRecords(projectRootPath, initiative) {
  const root = await projectRoot(projectRootPath);
  await ensureRecords(root);
  const target = path.join(root, INITIATIVES, requireSlug(initiative, "initiative"));
  await assertContained(root, path.join(target, "x"));
  for (const kind of ["initiative", "state"]) await rm(path.join(root, recordPath({ kind, initiative })), { force: true });
  for (const slice of await directoryNames(path.join(target, "slices"))) {
    const folder = path.join(target, "slices", slice);
    for (const entry of await readdir(folder)) if (entry !== "runs") await rm(path.join(folder, entry), { recursive: true, force: true });
    await rmdir(folder).catch(() => {});
  }
  // Only folders left empty go, so a slice that still holds runs keeps its path.
  await rmdir(path.join(target, "slices")).catch(() => {});
  await rmdir(target).catch(() => {});
  await rmdir(path.join(root, INITIATIVES)).catch(() => {});
}

/** The legacy and current location of a slice's human documents: the root slice shares the initiative folder. */
export async function sliceDocumentFolder(projectRootPath, initiative, slice) {
  const root = await projectRoot(projectRootPath);
  const config = await readWorkflowConfig(root);
  const directory = initiativeDirectory(config, requireSlug(initiative, "initiative"));
  if (directory === null) return null;
  requireSlug(slice, "slice");
  const bytes = await readBytes(path.join(root, recordPath({ kind: "initiative", initiative })), 1024 * 1024).catch(() => null);
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
  if (parts.length === 2) return { kind, initiative, slice: await legacyRootSlice(root, `${config.paths.plans}/${initiative}`, initiative) };
  if (parts.length === 3 && SLUG_PATTERN.test(parts[1])) return { kind, initiative, slice: parts[1] };
  return null;
}

/** Whether two stored paths, current or legacy, name the same record. */
export async function sameRecord(projectRootPath, left, right) {
  if (left === right) return true;
  const [a, b] = await Promise.all([keyOfPath(projectRootPath, left), keyOfPath(projectRootPath, right)]);
  return Boolean(a && b) && recordPath(a) === recordPath(b);
}
