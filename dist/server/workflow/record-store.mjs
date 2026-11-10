import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import path from "node:path";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { gitTooOld, listSavedConflicts, prepareStoreFiles, pullRecordStoreIfStale, readSavedConflict, readSyncStatus, scheduleRecordSync, syncRecordStoreNow, waitForStableStore } from "./record-store-sync.mjs";
import { managedRecordStore } from "./record-store-remote.mjs";
import { isRemoteStore, remoteLabel, withoutCredentials } from "./remote-url.mjs";
import { checkRepositoryName, portableRepositoryName, REPOSITORIES, REPOSITORY_REFUSALS, repositoryId } from "./repository-names.mjs";
import { ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY, ARTIFACT_MIGRATIONS, ARTIFACT_STATUS, ARTIFACTS, STATUS_RECORD_NAME, artifactAddress, componentScope, locationArtifact, normalizeArtifactPath, repositoryScope, scopeFolder, wellFormedName, WORKSPACE_SCOPE } from "./artifact-paths.mjs";
import { COMPONENT_NAME, readComponents } from "./components.mjs";
import { artifactKinds, initiativeDirectory, readWorkflowConfig, roadmapPaths } from "./workflow-config.mjs";
import { parseStoreJson } from "./store-json.mjs";

// Machine records live under .prism beside the workflow config, or in the record store the workflow config names; human documents and generated views stay under the configured paths.
// A record keeps its .prism path as its address in both cases: only recordStoreOf and resolveRecordFile know where its file lives.
export const RECORD_DIRECTORY = ".prism";
const INITIATIVES = `${RECORD_DIRECTORY}/initiatives`;
const ROADMAP_RECORD = `${RECORD_DIRECTORY}/roadmap.json`;
const RECORD_FILES = Object.freeze({ initiative: "initiative.json", state: "state.json", review: "review.json", "change-map": "change-map.json", "design-view": "design-view.json", "frozen-tests": "frozen-tests.json" });
const SLICE_KINDS = new Set(["review", "change-map", "design-view", "frozen-tests", "runs"]);
const LEGACY_CHANGE_MAP = "concept-delta.json";
const CLAIMS = "claims";
const HOUSEKEEPING = Object.freeze({
  ".gitattributes": "# Prism writes these records through its MCP tools; hosts collapse them in pull request diffs.\n/roadmap.json linguist-generated=true gitlab-generated\n/initiatives/** linguist-generated=true gitlab-generated\n",
  ".gitignore": "# Transient lock and write files of Prism records, and the store's sync state.\n*.lock\n.*.tmp\n/.prism-sync/\n"
});
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// A checkout can bring legacy records back, so a migration result is trusted only briefly.
const MIGRATION_TTL_MS = 5000;
const migrations = new Map();
const pendingMoves = new Map();
const unreportedMoves = [];
// A repository name check is trusted as briefly as a migration check, so a changed Repository line or origin applies within that time.
const nameChecks = new Map();

export { repositoryId };

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

/** The project-relative location of a record key: { kind: "roadmap" | "initiative" | "state" | "claim" | "review" | "change-map" | "design-view" | "frozen-tests" | "runs", initiative?, slice? }. */
export function recordPath(key) {
  if (key?.kind === "roadmap") return ROADMAP_RECORD;
  const initiative = requireSlug(key?.initiative, "initiative");
  if (key.kind === "initiative" || key.kind === "state") return `${INITIATIVES}/${initiative}/${RECORD_FILES[key.kind]}`;
  // Each slice's claim is a record of its own, so a claim's changes never touch the initiative record.
  if (key.kind === "claim") return `${INITIATIVES}/${initiative}/${CLAIMS}/${requireSlug(key.slice, "slice")}.json`;
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
  if (parts.length === 5 && parts[3] === CLAIMS && parts[4].endsWith(".json") && SLUG_PATTERN.test(parts[4].slice(0, -5))) return { kind: "claim", initiative: parts[2], slice: parts[4].slice(0, -5) };
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

// The names of the migration files Prism writes: a time and random suffix, or before the ledger, the hash that names the migrated repository.
const MIGRATION_FILE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}|[0-9a-f]{40,64})\.json$/;
// The names of the ledger files that a move of a checkout's artifacts writes: a time and a random suffix.
export const ARTIFACT_LEDGER_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.json$/;
// The names of comment files, which take the same form: a time and a random suffix.
export const ARTIFACT_COMMENT_FILE = ARTIFACT_LEDGER_FILE;

/**
 * Whether a store-relative path is one Prism writes in a record store, and so one that every machine of the store shares:
 * the ignore and attributes files at the root, the roadmap record, each record path an initiative's records use, each registration and migration file, each artifact ledger file,
 * and each file below artifacts/ whose every name follows the artifact name form.
 * No other path is shared, so a store's history never carries the sync folder, a lock, a temporary file, Git's folder, or a name that another file system reads as one of these.
 */
export function isStoreFile(relative) {
  if (typeof relative !== "string") return false;
  if (Object.hasOwn(HOUSEKEEPING, relative) || relative === "roadmap.json") return true;
  const names = relative.split("/");
  if (names[0] === ARTIFACTS) return names.length > 1 && names.slice(1).every(wellFormedName);
  // A status record sits at its artifact's location below artifact-status/, and accepted bytes under their hash below artifact-accepted/.
  if (names[0] === ARTIFACT_STATUS) return names.length > 2 && names.at(-1) === STATUS_RECORD_NAME && names.slice(1).every(wellFormedName);
  if (names[0] === ARTIFACT_ACCEPTED) return names.length === 2 && /^[0-9a-f]{64}$/.test(names[1]);
  // A comment is one file of its own, named by its time and a random suffix, below its artifact's location in artifact-comments/.
  if (names[0] === ARTIFACT_COMMENTS) return names.length > 2 && ARTIFACT_COMMENT_FILE.test(names.at(-1)) && names.slice(1).every(wellFormedName);
  // An artifact's identity sits at its location below artifact-identity/, and only at a location of an artifact's form, so a file where Prism keeps folders of identity files, such as artifact-identity/plans, is shared nowhere.
  if (names[0] === ARTIFACT_IDENTITY) return names.length > 1 && names.slice(1).every(wellFormedName) && locationArtifact(names.slice(1).join("/")) !== null;
  if (names[0] === "migrations") return names.length === 2 && MIGRATION_FILE.test(names[1]);
  if (names[0] === ARTIFACT_MIGRATIONS) return names.length === 2 && ARTIFACT_LEDGER_FILE.test(names[1]);
  if (names[0] === REPOSITORIES) return names.length === 2 && names[1].endsWith(".json") && portableRepositoryName(names[1].slice(0, -".json".length));
  if (names[0] !== "initiatives") return false;
  const key = parseRecordPath(`${RECORD_DIRECTORY}/${relative}`);
  if (key?.kind !== "runs") return key !== null && key.kind !== "roadmap";
  // A run entry is one file of its own below the slice's runs folder.
  return names.length === 6 && names[5].endsWith(".json") && ENTRY_ID.test(names[5].slice(0, -".json".length));
}

const KiB = 1024, MiB = 1024 * KiB;
/**
 * The most bytes that a store file of each kind holds, well above the largest file of that kind that Prism or a Git host writes, which every reader and every sync applies,
 * since anyone who can push to a store can push files of any size; no JSON kind is bounded above 16 MiB, which a JSON parse reads within a server's heap.
 * root-text is a README or license at the store's root and root-git its .gitattributes or .gitignore, which no reader loads and every sync writes, hashes, merges, and saves.
 */
export const STORE_FILE_BOUNDS = Object.freeze({
  artifact: 16 * MiB, accepted: 16 * MiB, status: 16 * MiB, identity: 256, comment: 64 * KiB, ledger: 16 * MiB, migration: 16 * MiB, registration: 64 * KiB,
  roadmap: MiB, initiative: MiB, state: MiB, "change-map": MiB, review: 4 * MiB, "design-view": 4 * MiB, "frozen-tests": 4 * MiB, claim: 64 * KiB, runs: 4 * MiB,
  "root-text": MiB, "root-git": 64 * KiB
});
/** The most comment files that one artifact's comment folder holds. */
export const COMMENTS_PER_ARTIFACT_MAX = 1000;
/** The most files that a store's tree holds, far above the files that Prism writes for a workspace, so every machine lists and holds a store's tree in bounded memory and time. */
export const STORE_TREE_FILES_MAX = 250000;

/** The bound of a store file kind as a person reads it, such as 256 bytes, 64 KiB, or 16 MiB. */
export const boundText = (bytes) => bytes % MiB === 0 ? `${bytes / MiB} MiB` : bytes % KiB === 0 ? `${bytes / KiB} KiB` : `${bytes} bytes`;

/** A Git host can add a README or a license to a new repository, so a store also shares these names at its root, as plain files that Prism never reads. */
export const INERT_FILES = new Set(["README", "README.md", "README.txt", "LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]);

/** Whether a store-relative path is a README or license at the store's root, or the .gitattributes or .gitignore that Prism writes there: files that no reader of Prism loads. */
export const isRootStoreFile = (relative) => INERT_FILES.has(relative) || Object.hasOwn(HOUSEKEEPING, relative);

/**
 * The most bytes that the store file at a store-relative path holds, or null for a path that a store does not share.
 * A README or license at the root takes 1 MiB and the .gitattributes or .gitignore there 64 KiB, so no file that a store shares is without a bound.
 */
export function storeFileBound(relative) {
  if (INERT_FILES.has(relative)) return STORE_FILE_BOUNDS["root-text"];
  if (typeof relative === "string" && Object.hasOwn(HOUSEKEEPING, relative)) return STORE_FILE_BOUNDS["root-git"];
  if (typeof relative !== "string" || !isStoreFile(relative)) return null;
  const top = relative.split("/")[0];
  const kind = { [ARTIFACTS]: "artifact", [ARTIFACT_ACCEPTED]: "accepted", [ARTIFACT_STATUS]: "status", [ARTIFACT_IDENTITY]: "identity", [ARTIFACT_COMMENTS]: "comment", [ARTIFACT_MIGRATIONS]: "ledger", migrations: "migration", [REPOSITORIES]: "registration" }[top]
    ?? parseRecordPath(`${RECORD_DIRECTORY}/${relative}`)?.kind;
  return STORE_FILE_BOUNDS[kind] ?? null;
}

/**
 * Whether a store-relative path is a folder that holds files Prism writes in a record store:
 * a top folder of the layout, a folder below artifacts/ whose every name follows the artifact name form, or an initiative's folder, its claims, slices, one slice, or that slice's runs.
 */
export function isStoreFolder(relative) {
  if (typeof relative !== "string") return false;
  const names = relative.split("/");
  if (names.length === 1) return ["initiatives", ARTIFACTS, ARTIFACT_STATUS, ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY, ARTIFACT_MIGRATIONS, "migrations", REPOSITORIES].includes(names[0]);
  if (names[0] === ARTIFACTS || names[0] === ARTIFACT_STATUS || names[0] === ARTIFACT_COMMENTS || names[0] === ARTIFACT_IDENTITY) return names.slice(1).every(wellFormedName);
  if (names[0] !== "initiatives" || !SLUG_PATTERN.test(names[1])) return false;
  if (names.length === 2) return true;
  if (names.length === 3) return names[2] === CLAIMS || names[2] === "slices";
  return names[2] === "slices" && SLUG_PATTERN.test(names[3]) && (names.length === 4 || (names.length === 5 && names[4] === "runs"));
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
 * Where a project's records live: { root, base, contain, external, sync, repository }.
 * base holds what .prism holds in the project, and contain is the folder no record may resolve outside.
 * A configured store is never created or replaced by a fallback, because either would split the records of checkouts that share it.
 * A store named by its remote resolves to the clone Prism keeps of it, which the first access clones, and is then an external store like any other.
 * A checkout of an external store passes its repository name check first: repository is its accepted name, and a refused checkout, including one that names no repository, throws.
 */
export async function recordStoreOf(projectRootPath) {
  const store = await resolveStore(projectRootPath);
  if (!store.external) return { ...store, repository: null };
  return { ...store, repository: await checkedRepository(store) };
}

async function resolveStore(projectRootPath) {
  const root = await projectRoot(projectRootPath);
  const config = await readWorkflowConfig(root);
  const { workspace } = config;
  const configured = workspace?.store ?? null;
  if (configured === null) return { root, base: path.join(root, RECORD_DIRECTORY), contain: root, external: false, sync: false };
  checkArtifactFolders(config);
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
  // A store with sync on is refused on a Git older than its sync needs, which would fail some of the sync's commands midway.
  const tooOld = workspace.sync === true ? await gitTooOld() : null;
  if (tooOld) throw unavailable(`has Store sync on. ${tooOld.replace(/; update Git\.$/, "; update Git, or turn Store sync off.")}`);
  return { root, base, contain: base, external: true, sync: workspace.sync === true };
}

// The check runs before migration, housekeeping, and record access, so a refused checkout leaves the store and its own records as they were.
// In a synced store the check confirms a registration it writes with a sync of its own, and pushes an addition to a registration with the next sync.
// A check that a still-pending registration would decide refuses without waiting, so a check nested inside a held record lock never waits for another check's sync.
async function checkedRepository(store) {
  const key = `${store.root}\0${store.base}`;
  const cached = nameChecks.get(key);
  let pending = cached && Date.now() - cached.at < MIGRATION_TTL_MS ? cached.pending : null;
  if (!pending) {
    pending = (async () => {
      const name = (await readWorkflowConfig(store.root)).workspace?.repository ?? null;
      return checkRepositoryName({ root: store.root, base: store.base, name, fail, sync: store.sync, beforeWrite: () => ensureHousekeeping(store) });
    })();
    // A refusal is trusted as long as an acceptance, so a refused checkout does not ask Git again on every operation; any other failure, and a refusal because a registration is still pending, is checked again at once.
    pending.catch((error) => { if ((!REPOSITORY_REFUSALS.includes(error?.code) || error?.pending === true) && nameChecks.get(key)?.pending === pending) nameChecks.delete(key); });
    nameChecks.set(key, { at: Date.now(), pending });
  }
  return (await pending).repository;
}

// With a store, the move of a checkout's artifacts takes every tracked file below the Requirements, ADRs, and Plans folders, so none of them may be the project root or hold a component's folder, which would take the source tree.
const ARTIFACT_FOLDERS = Object.freeze([["requirements", "Requirements"], ["adrs", "ADRs"], ["plans", "Plans"]]);

/**
 * Refuse, with artifact_folder_invalid, a configuration with a store whose Requirements, ADRs, or Plans folder is the project root or is or holds the folder of a component declared under ## Components.
 * It reads only the parsed configuration, so it runs before Prism registers the repository or moves, removes, or writes any file; a component declaration that cannot be read names no folder here.
 */
export function checkArtifactFolders(config) {
  let components = [];
  try { components = readComponents(config).declared; } catch { components = []; }
  for (const [key, label] of ARTIFACT_FOLDERS) {
    const folder = config?.paths?.[key];
    if (typeof folder !== "string") continue;
    const component = folder === "" ? null : components.find((candidate) => candidate.folder === folder || candidate.folder.startsWith(`${folder}/`)) ?? null;
    if (folder !== "" && component === null) continue;
    const what = folder === "" ? "is the project root" : `${component.folder === folder ? "is" : "holds"} the folder ${component.folder} of the component ${component.name}`;
    throw fail("artifact_folder_invalid", `The ${label} folder ${JSON.stringify(folder === "" ? "." : folder)} configured under ## Paths in .prism/workflow.md ${what}, so moving its files into the record store would take the source tree; Prism moved, removed, and wrote no file. Set ${label} to a folder below the project root that holds no component's folder, or to n/a.`, { key: label, folder: folder === "" ? "." : folder, ...(component ? { component: component.name } : {}) });
  }
}

/** Whether an error means a project's records cannot be used, as an unavailable store, a refused repository name, an artifact folder that would take the source tree, or a registrations entry that is no folder of the store does, so a view hides only the records. */
export function recordsUnavailable(error) {
  return error?.code === "store_unavailable" || error?.code === "artifact_folder_invalid" || REPOSITORY_REFUSALS.includes(error?.code) || (error?.code === "invalid_path" && error.storeLayout === true);
}

/** The latest sync outcome of a project's record store, or null when the store does not sync or has not synced yet. */
export async function recordSyncStatus(projectRootPath) {
  const store = await recordStoreOf(projectRootPath).catch(() => null);
  return store?.sync ? readSyncStatus(store.base) : null;
}

/**
 * Where a project's records live, for people: { kind: "project" | "folder" | "remote", label, location, sync, unavailable? }.
 * label is the store as configured, a remote without user information; location is the resolved folder or managed clone, or null when the store cannot be reached.
 */
export async function describeRecordStore(projectRootPath) {
  const root = await projectRoot(projectRootPath);
  const configured = (await readWorkflowConfig(root)).workspace?.store ?? null;
  if (configured === null) return { kind: "project", label: RECORD_DIRECTORY, location: path.join(root, RECORD_DIRECTORY), sync: false };
  const kind = isRemoteStore(configured) ? "remote" : "folder";
  const label = kind === "remote" ? remoteLabel(configured) ?? "remote store" : configured;
  try {
    const store = await recordStoreOf(root);
    return { kind, label, location: store.base, sync: store.sync };
  } catch (error) {
    // A refused repository name shows as an unavailable store does, with the refusal as the reason.
    if (!recordsUnavailable(error)) throw error;
    return { kind, label, location: null, sync: false, unavailable: withoutCredentials(error.message) };
  }
}

/** Every local record version that a sync of the project's record store saved, newest first. */
export async function listRecordStoreConflicts(projectRootPath) {
  return listSavedConflicts((await recordStoreOf(projectRootPath)).base);
}

/** One saved local record version of the project's record store and the record it was saved from, or null. */
export async function readRecordStoreConflict(projectRootPath, savedAs) {
  return readSavedConflict((await recordStoreOf(projectRootPath)).base, savedAs);
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

/**
 * The bytes of a store file, opened without following a link, or null when it does not exist; its size is checked from the opened file before any byte is read,
 * so a file above max throws artifact_too_large with tooLarge true and is never read, and its reader treats it as it treats a damaged file of its kind.
 */
export async function readStoreFileBytes(target, max) { return readBytes(target, max); }

/** The revision of a record above its kind's bound, which is never read: a hash of its size, so an update that names it replaces that damaged record and no other. */
export const oversizedRevision = (error) => createHash("sha256").update(`oversized:${error.size}`).digest("hex");

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
    if (info.size > max) throw fail("artifact_too_large", `The record holds ${info.size} bytes, above the ${boundText(max)} that a store file of its kind may hold, so it is read as a damaged record.`, { tooLarge: true, size: info.size, bound: max });
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
      const record = parseStoreJson((await readBytes(candidate, STORE_FILE_BOUNDS.initiative))?.toString("utf8") ?? "null");
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
    try { entry = parseStoreJson((await readBytes(path.join(directory, name), STORE_FILE_BOUNDS.migration))?.toString("utf8") ?? "null"); }
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
// A marker from before the ledger names its repository by root commit, so it keeps covering that repository whether or not the checkout has a name.
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

// The record move's report, with the store and configuration it read, which the artifact move of a tool call takes next.
async function migrate(root) {
  const report = { moved: [], conflicts: [] };
  const store = await recordStoreOf(root);
  const config = await readWorkflowConfig(root);
  if (store.external) {
    await migrateIntoStore(root, store, config, report);
    if (report.moved.length || report.conflicts.length) unreportedMoves.push({ root, store: store.base, ...report });
    return { report, store, config };
  }
  return { report: await migrateIntoProject(root, store, config, report), store, config };
}

async function migrateIntoProject(root, store, config, report) {
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

/*
 * Only a Prism tool call whose project root is a checkout moves the checkout's existing artifacts, because only its result carries the move's report.
 * Each tool call runs in a context of its own that names the project roots it resolved, and the context closes when the call returns,
 * so a review browser request, the shared review app's project list, a hook, a tool call of another checkout, and work that a tool call left running in the background read the store without moving.
 */
const toolCalls = new AsyncLocalStorage();

/** Run one tool call in its own context, whose roots set lists the project roots the call names; once run settles, nothing it started moves a checkout's artifacts. */
export async function withToolCall(call, run) {
  call.open = true;
  try { return await toolCalls.run(call, run); } finally { call.open = false; }
}

/** A new tool call context: { roots, open, writes }, where writes maps each store file that the call's update_artifact wrote to the versions it wrote there. */
export const toolCallContext = () => ({ roots: new Set(), open: false, writes: new Map() });

/** Note a store file and the version that an update_artifact of the current tool call wrote there, so finishing a move in that call does not keep a moved file whose artifact the call updated. */
export function noteToolCallWrite(target, version) {
  const call = toolCalls.getStore();
  if (!call?.open || !call.writes) return;
  call.writes.set(target, new Set([...call.writes.get(target) ?? [], version]));
}

/** Name a project root of the current tool call, whose first store access in the call may move the checkout's artifacts. */
export function nameToolCallRoot(root) {
  const call = toolCalls.getStore();
  if (call?.open) call.roots.add(root);
}

/** Run outside any tool call, such as a review browser request or background work that a tool call starts, so no store access in it moves a checkout's artifacts. */
export function outsideToolCall(run) {
  return toolCalls.exit(run);
}

const inToolCallOf = (root) => {
  const call = toolCalls.getStore();
  return call?.open === true && call.roots.has(root);
};

// A checkout's existing artifacts move into its repository's scope on the first access to the store of a tool call of the checkout in a server process, after its records moved,
// so a later access in the same process reports nothing again; a move that failed, or that waits for a pull, is tried again by the next tool call.
const artifactMigrations = new Map();
// Moves that wait for a pull, by checkout and store: { state, retry }, where state is the outcome of the last pull that did not complete,
// and retry is the pull, and the move right after it, that a later access started and that runs on in the background.
const deferredMoves = new Map();
// How long a later access of a deferred move waits for its retry before it proceeds, so a remote that hangs never holds up each tool call.
const RETRY_WAIT_MS = 1000;
// The sync outcomes after which the store holds what its remote held: a completed fetch and merge, whether or not the push went through, or no remote to pull from.
const PULLED = new Set(["ok", "conflicts", "push_rejected", "no_upstream", "not_a_repository"]);
// What a checkout's later accesses find once a retry in the background moved its artifacts: nothing left to move or report.
const MOVED = Promise.resolve(null);
// Decided moves whose store copies, status records, and ledger are written, as { key, root, store, outcome }: a tool call's own move, and one that a retry ran in the background.
// The checkout's files stay until a tool call of the checkout finishes the move right before it writes its result, removing them and reporting the move in that result,
// so a refused or cancelled call, or one answered after the host closed input, leaves its move to the next result that is written.
const unfinishedMoves = [];
// The checkout paths that this process's results name as moved, by checkout and store, so a file moved earlier is reported once in each process and never beside its own move.
const namedMoves = new Map();
function migrateArtifactsOnce(root, store, config) {
  const key = `${root}\0${store.base}`;
  if (artifactMigrations.has(key)) return artifactMigrations.get(key).then(() => null);
  const pending = (async () => {
    const { migrateArtifacts } = await import("./artifact-migration.mjs");
    return migrateArtifacts({
      root, kinds: artifactKinds(config), store: store.base, repository: store.repository,
      named: namedMoves.get(key) ?? namedMoves.set(key, new Set()).get(key),
      // With store sync on, the move decides against the store as its own pull left it, so it reads what other machines pushed.
      pull: store.sync ? (move) => pullThenMove(root, store, key, move) : null,
      prepare: async ({ pulled }) => {
        // Right after a pull, the move runs while the sync holds the store's sync lock, so no sync prepares the store's files or replaces them meanwhile.
        if (!pulled) await synced(store);
        return {
          seen: await scopesOf(root, config, store),
          recordSources: new Set((await legacyRecords(root, store, config)).map((move) => move.from)),
          frozenTests: await storedFrozenTests(store)
        };
      }
    });
  })();
  artifactMigrations.set(key, pending);
  const forget = () => { if (artifactMigrations.get(key) === pending) artifactMigrations.delete(key); };
  pending.then((outcome) => {
    // A move that waits for a pull, or for an operation that Git has in progress in the checkout, is tried again by the next tool call of the checkout.
    if (outcome?.deferred || outcome?.operation) forget();
    else deferredMoves.delete(key);
    // Moves that the ledger could not confirm wait for a later access to move again.
    if (outcome?.retry) artifactMigrations.delete(key);
  }, forget);
  return pending;
}

/**
 * Complete a sync of the store and run move while the sync still holds the store's sync lock, so the move decides against the store exactly as this pull left it:
 * { pulled, state, outcome } or { pulled, state, error } with move's outcome or error, where pulled says whether the store held what its remote held, so move ran,
 * and state is the sync's outcome without Git's output.
 */
async function pullAndMove(store, move) {
  let moved = null;
  const whileLocked = async (status) => {
    if (PULLED.has(status?.state)) moved = await move().then((outcome) => ({ outcome }), (error) => ({ error }));
  };
  const status = await syncRecordStoreNow(store.base, { whileLocked }).catch(() => ({ state: "git_failed" }));
  const state = typeof status?.state === "string" ? status.state : "git_failed";
  return moved ? { pulled: true, state, ...moved } : { pulled: false, state };
}

const settledMove = (result) => { if (result.error) throw result.error; return result; };

/**
 * Pull the store and run the move right after the pull, as pullAndMove does; a move decides only against a pull that it completed itself, never an earlier one.
 * The first access waits for its pull. After a deferral, a later access starts one retry at a time and waits for it at most RETRY_WAIT_MS;
 * a retry that ends later runs its move in the background as soon as its pull completes, writing only the store, and the next tool call removes the checkout's files and reports them.
 */
async function pullThenMove(root, store, key, move) {
  await prepareStoreFiles(store.base).catch(() => {});
  const deferred = deferredMoves.get(key);
  if (!deferred) {
    const result = await pullAndMove(store, move);
    if (!result.pulled) deferredMoves.set(key, { state: result.state, retry: null });
    return settledMove(result);
  }
  if (!deferred.retry) {
    deferred.retry = pullAndMove(store, move).then((result) => {
      deferred.retry = null;
      if (!result.pulled) { deferred.state = result.state; return result; }
      // A move that failed, or that found an operation in progress in the checkout, is tried again by the next access, with a pull of its own.
      if (result.error || result.outcome?.operation) return result;
      if (deferredMoves.get(key) === deferred) {
        deferredMoves.delete(key);
        artifactMigrations.set(key, MOVED);
      }
      // The next tool call of the checkout whose result is written finishes the move, whether or not an access still waits for it.
      if (result.outcome) unfinishedMoves.push({ key, root, store: store.base, outcome: result.outcome });
      return { ...result, handedOff: true };
    });
  }
  let timer;
  const waited = await Promise.race([deferred.retry, new Promise((resolve) => { timer = setTimeout(resolve, RETRY_WAIT_MS, null); })]);
  clearTimeout(timer);
  if (!waited) return { pulled: false, state: deferred.state };
  if (!waited.handedOff) return settledMove(waited);
  return { pulled: true, state: waited.state, outcome: null };
}

/**
 * Finish the decided moves of the given checkouts right before the tool call writes a result that reports them, so every file a move removes is named in the result written right after:
 * each removes a checkout file only once it confirms the file against the move's ledger and the store's bytes, or bytes that writes, the call's update_artifact writes, put there,
 * and a file it cannot confirm stays in the checkout. proceed() says whether the result is still to be written; once it says no, a move stops removing files and waits for the next result.
 * A move that fails is tried again by a later access.
 */
export async function finishUnfinishedMoves(roots, { proceed = () => true, writes = null } = {}) {
  const handoffs = unfinishedMoves.filter((handoff) => roots.has(handoff.root));
  if (!handoffs.length) return;
  const { finishedMove } = await import("./artifact-migration.mjs");
  for (const handoff of handoffs) {
    if (!proceed()) return;
    const index = unfinishedMoves.indexOf(handoff);
    if (index === -1) continue;
    unfinishedMoves.splice(index, 1);
    let outcome;
    try { outcome = await finishedMove(handoff.outcome, { proceed, writes }); }
    catch { artifactMigrations.delete(handoff.key); continue; }
    if (outcome?.interrupted) { unfinishedMoves.unshift(handoff); return; }
    // While Git has an operation in progress in the checkout, the move removes nothing: its result says that the move waits, and a later result finishes it.
    if (outcome?.pending) {
      unfinishedMoves.splice(Math.min(index, unfinishedMoves.length), 0, handoff);
      unreportedMoves.push({ root: handoff.root, store: handoff.store, moved: [], conflicts: [], artifacts: outcome.pending });
      continue;
    }
    if (outcome?.retry) artifactMigrations.delete(handoff.key);
    if (outcome) unreportedMoves.push({ root: handoff.root, store: handoff.store, moved: [], conflicts: [], artifacts: outcome });
  }
}

/**
 * The files that Git tracks under a checkout's artifact paths and that its work tree still holds, other than a frozen test of an accepted design and the record files that the record move takes,
 * as notes for people: { awaitingMove?, keptInCheckout? }, each { files, message } and left out when it counts none, where awaitingMove counts the files that a move still decides on
 * and keptInCheckout the files that a ledger keeps for a reason they still have; {} when the project has no record store, or the store or Git cannot be used.
 * It only reads, so a review browser shows what waits without moving, writing, or removing a file.
 */
export async function artifactsInCheckout(projectRootPath) {
  try {
    const root = await projectRoot(projectRootPath);
    const store = await recordStoreOf(root);
    if (!store.external) return {};
    const config = await readWorkflowConfig(root);
    const records = new Set((await legacyRecords(root, store, config)).map((move) => move.from));
    const frozenTests = await storedFrozenTests(store);
    const { checkoutArtifactsByMove } = await import("./artifact-migration.mjs");
    const counts = await checkoutArtifactsByMove(root, artifactKinds(config), { store: store.base, repository: store.repository, left: (file) => records.has(file) || frozenTests.has(file) });
    if (!counts) return {};
    const notes = {};
    if (counts.waiting) {
      const files = counts.waiting, one = files === 1;
      notes.awaitingMove = { files, message: `${files} ${one ? "file" : "files"} that Git tracks under this checkout's artifact paths ${one ? "is" : "are"} still in the checkout and not in the record store. An agent's Prism tool call in this checkout moves ${one ? "it" : "them"} into the store and reports each move or why a file stays. An agent session moves the checkout's files once, so a file that Git starts tracking after that move waits for the next session.` };
    }
    if (counts.kept) {
      const files = counts.kept, one = files === 1;
      notes.keptInCheckout = { files, message: `${files} ${one ? "file" : "files"} that Git tracks under this checkout's artifact paths ${one ? "stays" : "stay"} in the checkout until a person settles ${one ? "it" : "each"}, as the report of the move that kept ${one ? "it" : "them"} gave ${one ? "its" : "each one's"} reason; no tool call is needed or waited for.` };
    }
    return notes;
  } catch {
    return {};
  }
}

// The frozen tests of every accepted design that the store's initiative records hold, as project-relative paths; an unreadable record names none.
async function storedFrozenTests(store) {
  const tests = new Set();
  let names = [];
  try { names = (await readdir(path.join(store.base, "initiatives"), { withFileTypes: true })).filter((entry) => entry.isDirectory() && SLUG_PATTERN.test(entry.name)).map((entry) => entry.name); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  for (const name of names) {
    let record;
    try { record = parseStoreJson((await readBytes(physical(store, recordPath({ kind: "initiative", initiative: name })), STORE_FILE_BOUNDS.initiative))?.toString("utf8") ?? "null"); }
    catch { continue; }
    for (const slice of Object.values(record?.slices ?? {})) {
      for (const test of Array.isArray(slice?.design?.frozenTests) ? slice.design.frozenTests : []) {
        const file = normalizeArtifactPath(typeof test === "string" ? test : test?.path);
        if (file) tests.add(file);
      }
    }
  }
  return tests;
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

/** The record moves that writes made since the last call, and the artifact moves of the given checkouts, for the tool result that reports them. */
export function takeMigrationReports(roots) {
  const taken = unreportedMoves.filter((report) => !report.artifacts || roots.has(report.root));
  for (const report of taken) unreportedMoves.splice(unreportedMoves.indexOf(report), 1);
  return taken;
}

/** Give back record moves that takeMigrationReports returned for a tool result that was never written, so the next result reports them. */
export function restoreMigrationReports(reports) {
  unreportedMoves.unshift(...(reports ?? []));
}

/** Move legacy records before a record update, so the update reads and locks each record where it now lives; an unusable root is left for the update to report. */
export async function moveLegacyRecords(projectRootPath) {
  let root;
  try { root = await projectRoot(projectRootPath); } catch { return; }
  await ensureRecords(root);
}

/**
 * Move every legacy record of a project into .prism, or into its record store, once per process, so all initiatives read from one place; only writes move records into .prism.
 * In a tool call whose project root is the checkout, the checkout's existing artifacts then move into its record store, and no other access moves them.
 */
export async function ensureRecords(root) {
  const { report, store, config } = await recordsMoved(root);
  if (store.external && inToolCallOf(root)) {
    const artifacts = await migrateArtifactsOnce(root, store, config);
    // A decided move removes the checkout's files only right before the call writes a result that reports them; a report without removals waits for that result as it is.
    if (typeof artifacts?.finish === "function") unfinishedMoves.push({ key: `${root}\0${store.base}`, root, store: store.base, outcome: artifacts });
    else if (artifacts) unreportedMoves.push({ root, store: store.base, moved: [], conflicts: [], artifacts });
  }
  return report;
}

function recordsMoved(root) {
  const existing = migrations.get(root);
  if (existing && Date.now() - existing.at < MIGRATION_TTL_MS) return existing.pending;
  const pending = migrate(root).catch((error) => {
    migrations.delete(root);
    throw error;
  });
  migrations.set(root, { at: Date.now(), pending });
  return pending;
}

/** Forget recent migration and repository name checks, so the next record access looks for legacy records and checks the name again. */
export function forgetMigrations() {
  migrations.clear();
  artifactMigrations.clear();
  deferredMoves.clear();
  unfinishedMoves.length = 0;
  namedMoves.clear();
  pendingMoves.clear();
  nameChecks.clear();
}

const storeLabel = (store) => store.external ? "the record store" : "the project root";

// A synced store prepares its files for syncing before any record or artifact access, pulls in the background when its last fetch is old, and record access waits while a merge replaces record files.
// A preparation that fails is tried again by the next access and by every sync, which runs it first.
async function synced(store) {
  if (!store.sync) return;
  await prepareStoreFiles(store.base).catch(() => {});
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

/** Read a record's bytes, or null when it does not exist; a record above its kind's bound throws artifact_too_large unread, which its reader treats as a damaged record. */
export async function readRecord(projectRootPath, key, { maxBytes = STORE_FILE_BOUNDS[key?.kind] ?? STORE_FILE_BOUNDS.artifact } = {}) {
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

/** Remove a record's file, and its folder when that leaves it empty; returns whether a file was removed. */
export async function removeRecord(projectRootPath, key) {
  const { store, located } = await locate(projectRootPath, key, { write: true });
  await assertContained(store.contain, located.target, storeLabel(store));
  if (!(await regularFile(located.target))) return false;
  await rm(located.target, { force: true });
  await rmdir(path.dirname(located.target)).catch(() => {});
  if (store.sync) scheduleRecordSync(store.base);
  return true;
}

/** The claim records of an initiative's slices: [{ slice, bytes }], in slice order. */
export async function listClaimRecords(projectRootPath, initiative) {
  // Claims have no legacy location, so any slice's claim path names the folder in the project or the store.
  const { located } = await locate(projectRootPath, { kind: "claim", initiative, slice: "x" });
  const folder = path.dirname(located.target);
  let names = [];
  try { names = (await readdir(folder)).filter((name) => name.endsWith(".json") && SLUG_PATTERN.test(name.slice(0, -5))).sort(); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  const claims = [];
  for (const name of names) {
    const bytes = await readBytes(path.join(folder, name), 64 * 1024).catch(() => null);
    if (bytes !== null) claims.push({ slice: name.slice(0, -5), bytes });
  }
  return claims;
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
export async function listRecordEntries(projectRootPath, key, { maxBytes = STORE_FILE_BOUNDS.runs } = {}) {
  const { located } = await locate(projectRootPath, key);
  let names = [];
  try { names = (await readdir(located.target)).filter((name) => name.endsWith(".json") && ENTRY_ID.test(name.slice(0, -5))).sort(); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  const entries = [];
  for (const name of names) {
    const bytes = await readBytes(path.join(located.target, name), maxBytes);
    if (bytes !== null) entries.push({ id: name.slice(0, -5), entry: parseStoreJson(bytes.toString("utf8")) });
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
  await rm(path.join(target, CLAIMS), { recursive: true, force: true });
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
  const bytes = await readBytes(physical(store, recordPath({ kind: "initiative", initiative })), STORE_FILE_BOUNDS.initiative).catch(() => null);
  let rootSlice = initiative;
  try {
    const found = bytes && Object.entries(parseStoreJson(bytes.toString("utf8"))?.slices ?? {}).find(([, value]) => value?.parent === null)?.[0];
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

/**
 * The store artifacts a checkout sees: { root, config, kinds, store, base, repository, scopes }, where base is the store's artifacts folder and scopes lists
 * the workspace scope, the repository's scope under its accepted name, and the scope of each component folder of the repository that the store holds.
 * It refuses with store_not_configured without a store, and with the store's own refusal when the store is unavailable or the repository name is refused, before it reads or writes anything else.
 */
export async function seenScopes(projectRootPath) {
  const root = await projectRoot(projectRootPath);
  const config = await readWorkflowConfig(root);
  if ((config.workspace?.store ?? null) === null) throw fail("store_not_configured", "This project's .prism/workflow.md names no record store under ## Workspace, so its descriptive artifacts stay in the checkout: read and edit them there with your own file tools.");
  const store = await recordStoreOf(root);
  await ensureRecords(store.root);
  await synced(store);
  return scopesOf(root, config, store);
}

// The scopes a checkout sees in its store, read without moving records or artifacts, so the move of a checkout's artifacts can read them itself.
async function scopesOf(root, config, store) {
  const base = path.join(store.base, ARTIFACTS);
  const own = repositoryScope(store.repository);
  const components = path.join(base, scopeFolder(own), "components");
  await assertUnlinked(store.base, path.join(components, "x"));
  let names = [];
  try { names = (await readdir(components, { withFileTypes: true })).filter((entry) => entry.isDirectory() && COMPONENT_NAME.test(entry.name)).map((entry) => entry.name).sort(); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  return { root, config, kinds: artifactKinds(config), store, base, repository: store.repository, scopes: [WORKSPACE_SCOPE, own, ...names.map((name) => componentScope(store.repository, name))] };
}

// No folder between the store and an artifact may be a symbolic link, so a link placed in the store cannot redirect a read or write elsewhere.
async function assertUnlinked(base, target) {
  const relative = path.relative(base, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw fail("invalid_path", "The artifact location resolves outside the record store.");
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return; throw error; }
    if (info.isSymbolicLink()) throw fail("invalid_path", "An artifact location in the record store passes through a symbolic link, which Prism does not follow.");
  }
}

/** The file of an artifact location below artifacts/ in a seen store, after checking that it stays inside the store and passes through no symbolic link. */
export async function resolveArtifactFile(seen, location) {
  const target = path.join(seen.base, ...location.split("/"));
  if (!inside(seen.base, target) || target === seen.base) throw fail("invalid_path", "The artifact location resolves outside the store's artifacts folder.");
  await assertUnlinked(seen.store.base, target);
  await assertContained(seen.store.contain, target, "the record store");
  return target;
}

/** The file of a store-relative path below artifact-status/, artifact-accepted/, artifact-comments/, or artifact-identity/ in a seen store, after the checks that resolveArtifactFile makes. */
export async function resolveStatusFile(seen, relative) {
  const folder = path.join(seen.store.base, relative.split("/")[0]);
  if (![ARTIFACT_STATUS, ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY].includes(relative.split("/")[0])) throw fail("invalid_path", "A status file lies outside the store's status folders.");
  const target = path.join(seen.store.base, ...relative.split("/"));
  if (!inside(folder, target) || target === folder) throw fail("invalid_path", "The status location resolves outside the store's status folders.");
  await assertUnlinked(seen.store.base, target);
  await assertContained(seen.store.contain, target, "the record store");
  return target;
}

/**
 * A resolver of store-relative paths below the status folders for one read of many artifacts, such as one Attention read: it makes the checks that resolveStatusFile makes,
 * with each folder's link check and real path taken once for the resolver's life, so a read of a thousand artifacts checks each shared folder once rather than once for each artifact.
 * It is meant for a single read, during which a folder that changes is read as it was at its first check.
 */
export function statusFileResolver(seen) {
  const kinds = new Map(), reals = new Map();
  const kindOf = (target) => {
    if (!kinds.has(target)) kinds.set(target, lstat(target).then((info) => info.isSymbolicLink() ? "link" : "present", (error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return "missing"; throw error; }));
    return kinds.get(target);
  };
  const realOf = (target) => { if (!reals.has(target)) reals.set(target, realpath(target)); return reals.get(target); };
  return async (relative) => {
    const top = relative.split("/")[0];
    if (![ARTIFACT_STATUS, ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY].includes(top)) throw fail("invalid_path", "A status file lies outside the store's status folders.");
    const folder = path.join(seen.store.base, top);
    const target = path.join(seen.store.base, ...relative.split("/"));
    if (!inside(folder, target) || target === folder) throw fail("invalid_path", "The status location resolves outside the store's status folders.");
    let current = seen.store.base;
    for (const part of path.relative(seen.store.base, target).split(path.sep)) {
      current = path.join(current, part);
      const kind = await kindOf(current);
      if (kind === "missing") break;
      if (kind === "link") throw fail("invalid_path", "An artifact location in the record store passes through a symbolic link, which Prism does not follow.");
    }
    for (let parent = path.dirname(target); ; parent = path.dirname(parent)) {
      try {
        if (!inside(seen.store.contain, await realOf(parent))) throw fail("invalid_path", "The record location resolves outside the record store.");
        return target;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (path.dirname(parent) === parent) throw fail("invalid_path", "The record location cannot be resolved inside the record store.");
      }
    }
  };
}

/** The file of a ledger name below artifact-migrations/ in a seen store, after the checks that resolveArtifactFile makes. */
export async function resolveLedgerFile(seen, name) {
  if (!ARTIFACT_LEDGER_FILE.test(name)) throw fail("invalid_path", "An artifact ledger file has a time and a random suffix as its name.");
  const target = path.join(seen.store.base, ARTIFACT_MIGRATIONS, name);
  await assertUnlinked(seen.store.base, target);
  await assertContained(seen.store.contain, target, "the record store");
  return target;
}

/**
 * Run an action that changes a seen store's artifacts while holding the store's artifact lock, so each update checks and changes the files it touches alone.
 * Options pass through to the file lock: a long action, such as the move of a checkout's artifacts, renews the lock, so no waiting process takes it as abandoned while the action runs.
 */
export async function withArtifactStoreLock(seen, action, options = {}) {
  const lock = path.join(seen.store.base, ARTIFACTS);
  return withArtifactLock(lock, () => withFileLock(lock, async () => {
    await ensureHousekeeping(seen.store);
    return action();
  }, fail, options));
}

// The store functions check names, scopes, and layout and take the artifact lock, and they import this module, so they load when first used.
const storeArtifacts = () => import("./store-artifacts.mjs");

/** Whether a project-relative path is an artifact path of a project whose .prism/workflow.md names a record store, so its file lives in the store and never in the checkout. */
export async function inArtifactStore(projectRootPath, file) {
  return (await artifactPathTest(projectRootPath))(file);
}

/** A test of whether a project-relative path is an artifact path, as inArtifactStore decides, reading the configuration once; it accepts no path in a project without a store. */
export async function artifactPathTest(projectRootPath) {
  const config = await readWorkflowConfig(await projectRoot(projectRootPath));
  if ((config.workspace?.store ?? null) === null) return () => false;
  const kinds = artifactKinds(config);
  return (file) => {
    const normalized = normalizeArtifactPath(file);
    if (normalized === null || normalized === "") return false;
    const address = artifactAddress(kinds, normalized);
    return address !== null && address.rest !== "";
  };
}

/**
 * The bytes of a file that Prism reads itself, such as a slice.md, a diagram, or a recovery note, or null when it does not exist:
 * an artifact path of a project with a store is read from the store, every other path from the checkout.
 */
export async function readArtifactBytes(projectRootPath, file) {
  if (await inArtifactStore(projectRootPath, file)) return (await (await storeArtifacts()).readStoreArtifact(projectRootPath, file))?.bytes ?? null;
  const root = await projectRoot(projectRootPath);
  try { return await readFile(path.resolve(root, file)); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
}

/** The text of a file that Prism reads itself, from the store or the checkout as readArtifactBytes decides, or null when it does not exist. */
export async function readArtifactText(projectRootPath, file) {
  return (await readArtifactBytes(projectRootPath, file))?.toString("utf8") ?? null;
}

/**
 * Change a file that Prism writes itself, such as a generated view or a recovery note: decide gets its current text, or null, and returns the text to write,
 * null to remove it, or undefined to leave it; a string stands for a decide that always writes it.
 * An artifact path of a project with a store is written through the store's checked update, in the scope that holds it, a new one in the scope that holds its nearest folder with
 * an artifact that is no generated view, else the workspace scope,
 * and every other path in the checkout, with write, which defaults to an atomic replace; with follow, a generated view also moves to the scope that holds its folder.
 * Returns { written, store }.
 * @param {string} projectRootPath @param {string} file @param {string | null | ((current: string | null) => unknown)} decide
 * @param {{ write?: (target: string, contents: string) => Promise<unknown>, follow?: boolean }} [options]
 */
export async function writeArtifactText(projectRootPath, file, decide, { write = writeAtomically, follow = false } = {}) {
  const choose = typeof decide === "function" ? decide : () => decide;
  if (await inArtifactStore(projectRootPath, file)) return { ...(await (await storeArtifacts()).writeStoreArtifact(projectRootPath, file, choose, { follow })), store: true };
  const root = await projectRoot(projectRootPath);
  const target = path.resolve(root, file);
  if (!inside(root, target) || target === root) throw fail("invalid_path", `${file} lies outside the project root.`);
  await assertContained(root, target);
  const current = await regularFile(target) ? await readFile(target, "utf8") : null;
  const next = await choose(current);
  if (next === undefined || (next === null && current === null) || next === current) return { written: false, store: false };
  if (next === null) await rm(target, { force: true });
  else {
    await mkdir(path.dirname(target), { recursive: true });
    await assertContained(root, target);
    await write(target, next);
  }
  return { written: true, store: false };
}

/** The artifact paths the store holds below a project-relative folder, as { path, scope, kind }, or null when the project names no store, so its files are listed in the checkout. */
export async function listStoreArtifacts(projectRootPath, folder = "") {
  const config = await readWorkflowConfig(await projectRoot(projectRootPath));
  if ((config.workspace?.store ?? null) === null) return null;
  return (await storeArtifacts()).storeArtifactPaths(projectRootPath, folder);
}
