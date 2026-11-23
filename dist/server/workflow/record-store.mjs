// Generated from src/server/workflow/record-store.mts by scripts/native-build/compile.mjs.
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
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
const RECORD_DIRECTORY = ".prism";
const INITIATIVES = `${RECORD_DIRECTORY}/initiatives`;
const ROADMAP_RECORD = `${RECORD_DIRECTORY}/roadmap.json`;
const RECORD_FILES = Object.freeze({ initiative: "initiative.json", state: "state.json", review: "review.json", "change-map": "change-map.json", "design-view": "design-view.json", "frozen-tests": "frozen-tests.json" });
const SLICE_KINDS = /* @__PURE__ */ new Set(["review", "change-map", "design-view", "frozen-tests", "runs"]);
const LEGACY_CHANGE_MAP = "concept-delta.json";
const CLAIMS = "claims";
const FORMAT_MIGRATIONS = "format-migrations";
const FORMAT_MIGRATION_ID = /^(?:migration-[0-9a-f]{8,64}|run-[0-9a-f]{16})$/;
const FORMAT_MIGRATION_FILE = /^(?:migration-[0-9a-f]{8,64}|run-[0-9a-f]{16})\.json$/;
const FORMAT_FINDINGS = "format-findings";
const FORMAT_FINDING_ID = /^finding-[0-9a-f]{16,64}$/;
const FORMAT_FINDING_FILE = /^finding-[0-9a-f]{16,64}\.json$/;
const HOUSEKEEPING = Object.freeze({
  ".gitattributes": "# Prism writes these records through its MCP tools; hosts collapse them in pull request diffs.\n/roadmap.json linguist-generated=true gitlab-generated\n/initiatives/** linguist-generated=true gitlab-generated\n",
  ".gitignore": "# Transient lock and write files of Prism records, and the store's sync state.\n*.lock\n.*.tmp\n/.prism-sync/\n"
});
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIGRATION_TTL_MS = 5e3;
const migrations = /* @__PURE__ */ new Map();
const pendingMoves = /* @__PURE__ */ new Map();
const unreportedMoves = [];
const nameChecks = /* @__PURE__ */ new Map();
const checkoutlessRoots = /* @__PURE__ */ new Map();
async function useStoreWithoutCheckout(root, { base, label, sync = true }) {
  checkoutlessRoots.set(await realpath(root), { base: await realpath(base), label, sync: sync === true });
}
async function forgetStoreWithoutCheckout(root) {
  checkoutlessRoots.delete(await realpath(root).catch(() => path.resolve(root)));
}
async function isStoreWithoutCheckout(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) return false;
  return checkoutlessRoots.has(await realpath(root).catch(() => path.resolve(root)));
}
class RecordStoreError extends Error {
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
function recordPath(key) {
  if (key?.kind === "roadmap") return ROADMAP_RECORD;
  if (key?.kind === "format-migration") {
    if (typeof key.id !== "string" || !FORMAT_MIGRATION_ID.test(key.id)) throw fail("invalid_path", "A format migration record id is run- and 16 hexadecimal digits, or migration- and hexadecimal digits.");
    return `${RECORD_DIRECTORY}/${FORMAT_MIGRATIONS}/${key.id}.json`;
  }
  if (key?.kind === "format-finding") {
    if (typeof key.id !== "string" || !FORMAT_FINDING_ID.test(key.id)) throw fail("invalid_path", "A format finding id is finding- and hexadecimal digits.");
    return `${RECORD_DIRECTORY}/${FORMAT_FINDINGS}/${key.id}.json`;
  }
  const initiative = requireSlug(key?.initiative, "initiative");
  if (key.kind === "initiative" || key.kind === "state") return `${INITIATIVES}/${initiative}/${RECORD_FILES[key.kind]}`;
  if (key.kind === "claim") return `${INITIATIVES}/${initiative}/${CLAIMS}/${requireSlug(key.slice, "slice")}.json`;
  if (!SLICE_KINDS.has(key.kind)) throw fail("invalid_path", `Unknown record kind ${key.kind}.`);
  const folder = `${INITIATIVES}/${initiative}/slices/${requireSlug(key.slice, "slice")}`;
  return key.kind === "runs" ? `${folder}/runs` : `${folder}/${RECORD_FILES[key.kind]}`;
}
function parseRecordPath(relative) {
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
function isManagedRecordFile(relative) {
  if (relative === ROADMAP_RECORD || relative.startsWith(`${INITIATIVES}/`) || relative.startsWith(`${RECORD_DIRECTORY}/${FORMAT_MIGRATIONS}/`) || relative.startsWith(`${RECORD_DIRECTORY}/${FORMAT_FINDINGS}/`)) return true;
  return relative.startsWith(`${RECORD_DIRECTORY}/`) && Object.hasOwn(HOUSEKEEPING, relative.slice(RECORD_DIRECTORY.length + 1));
}
const MIGRATION_FILE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}|[0-9a-f]{40,64})\.json$/;
const ARTIFACT_LEDGER_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.json$/;
const ARTIFACT_COMMENT_FILE = ARTIFACT_LEDGER_FILE;
function isStoreFile(relative) {
  if (typeof relative !== "string") return false;
  if (Object.hasOwn(HOUSEKEEPING, relative) || relative === "roadmap.json") return true;
  const names = relative.split("/");
  if (names[0] === ARTIFACTS) return names.length > 1 && names.slice(1).every(wellFormedName);
  if (names[0] === ARTIFACT_STATUS) return names.length > 2 && names.at(-1) === STATUS_RECORD_NAME && names.slice(1).every(wellFormedName);
  if (names[0] === ARTIFACT_ACCEPTED) return names.length === 2 && /^[0-9a-f]{64}$/.test(names[1]);
  if (names[0] === ARTIFACT_COMMENTS) return names.length > 2 && ARTIFACT_COMMENT_FILE.test(names.at(-1)) && names.slice(1).every(wellFormedName);
  if (names[0] === ARTIFACT_IDENTITY) return names.length > 1 && names.slice(1).every(wellFormedName) && locationArtifact(names.slice(1).join("/")) !== null;
  if (names[0] === "migrations") return names.length === 2 && MIGRATION_FILE.test(names[1]);
  if (names[0] === ARTIFACT_MIGRATIONS) return names.length === 2 && ARTIFACT_LEDGER_FILE.test(names[1]);
  if (names[0] === FORMAT_MIGRATIONS) return names.length === 2 && FORMAT_MIGRATION_FILE.test(names[1]);
  if (names[0] === FORMAT_FINDINGS) return names.length === 2 && FORMAT_FINDING_FILE.test(names[1]);
  if (names[0] === REPOSITORIES) return names.length === 2 && names[1].endsWith(".json") && portableRepositoryName(names[1].slice(0, -".json".length));
  if (names[0] !== "initiatives") return false;
  const key = parseRecordPath(`${RECORD_DIRECTORY}/${relative}`);
  if (key?.kind !== "runs") return key !== null && key.kind !== "roadmap";
  return names.length === 6 && names[5].endsWith(".json") && ENTRY_ID.test(names[5].slice(0, -".json".length));
}
const KiB = 1024, MiB = 1024 * KiB;
const STORE_FILE_BOUNDS = Object.freeze({
  artifact: 16 * MiB,
  accepted: 16 * MiB,
  status: 16 * MiB,
  identity: 256,
  comment: 64 * KiB,
  ledger: 16 * MiB,
  migration: 16 * MiB,
  "format-migration": 16 * MiB,
  "format-finding": 64 * KiB,
  registration: 64 * KiB,
  roadmap: MiB,
  initiative: MiB,
  state: MiB,
  "change-map": MiB,
  review: 4 * MiB,
  "design-view": 4 * MiB,
  "frozen-tests": 4 * MiB,
  claim: 64 * KiB,
  runs: 4 * MiB,
  "root-text": MiB,
  "root-git": 64 * KiB
});
const COMMENTS_PER_ARTIFACT_MAX = 1e3;
const STORE_TREE_FILES_MAX = 25e4;
const boundText = (bytes) => bytes % MiB === 0 ? `${bytes / MiB} MiB` : bytes % KiB === 0 ? `${bytes / KiB} KiB` : `${bytes} bytes`;
const INERT_FILES = /* @__PURE__ */ new Set(["README", "README.md", "README.txt", "LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]);
const isRootStoreFile = (relative) => INERT_FILES.has(relative) || Object.hasOwn(HOUSEKEEPING, relative);
function storeFileBound(relative) {
  if (INERT_FILES.has(relative)) return STORE_FILE_BOUNDS["root-text"];
  if (typeof relative === "string" && Object.hasOwn(HOUSEKEEPING, relative)) return STORE_FILE_BOUNDS["root-git"];
  if (typeof relative !== "string" || !isStoreFile(relative)) return null;
  const top = relative.split("/")[0];
  const kind = { [ARTIFACTS]: "artifact", [ARTIFACT_ACCEPTED]: "accepted", [ARTIFACT_STATUS]: "status", [ARTIFACT_IDENTITY]: "identity", [ARTIFACT_COMMENTS]: "comment", [ARTIFACT_MIGRATIONS]: "ledger", migrations: "migration", [FORMAT_MIGRATIONS]: "format-migration", [FORMAT_FINDINGS]: "format-finding", [REPOSITORIES]: "registration" }[top] ?? parseRecordPath(`${RECORD_DIRECTORY}/${relative}`)?.kind;
  return STORE_FILE_BOUNDS[kind] ?? null;
}
function isStoreFolder(relative) {
  if (typeof relative !== "string") return false;
  const names = relative.split("/");
  if (names.length === 1) return ["initiatives", ARTIFACTS, ARTIFACT_STATUS, ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY, ARTIFACT_MIGRATIONS, "migrations", FORMAT_MIGRATIONS, FORMAT_FINDINGS, REPOSITORIES].includes(names[0]);
  if (names[0] === ARTIFACTS || names[0] === ARTIFACT_STATUS || names[0] === ARTIFACT_COMMENTS || names[0] === ARTIFACT_IDENTITY) return names.slice(1).every(wellFormedName);
  if (names[0] !== "initiatives" || !SLUG_PATTERN.test(names[1])) return false;
  if (names.length === 2) return true;
  if (names.length === 3) return names[2] === CLAIMS || names[2] === "slices";
  return names[2] === "slices" && SLUG_PATTERN.test(names[3]) && (names.length === 4 || names.length === 5 && names[4] === "runs");
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function projectRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw fail("invalid_project_root", "The project root must be an absolute path.");
  return realpath(root);
}
function storeRelative(relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) return null;
  const normalized = path.posix.normalize(relative.replaceAll("\\", "/")).replace(/\/$/, "");
  return normalized === INITIATIVES || isManagedRecordFile(normalized) ? normalized.slice(RECORD_DIRECTORY.length + 1) : null;
}
const physical = (store, relative) => path.join(store.base, relative.slice(RECORD_DIRECTORY.length + 1));
async function recordStoreOf(projectRootPath) {
  const scope = currentScope();
  if (!scope) return storeOf(projectRootPath);
  if (!scope.stores.has(projectRootPath)) scope.stores.set(projectRootPath, storeOf(projectRootPath));
  return scope.stores.get(projectRootPath);
}
const readScope = new AsyncLocalStorage();
async function withRecordReads(action) {
  const scope = { open: true, stores: /* @__PURE__ */ new Map(), synced: /* @__PURE__ */ new Map(), configs: /* @__PURE__ */ new Map(), folderChecks: folderChecks() };
  try {
    return await readScope.run(scope, action);
  } finally {
    scope.open = false;
    scope.stores.clear();
    scope.synced.clear();
    scope.configs.clear();
    scope.folderChecks = null;
  }
}
async function scopedWorkflowConfig(projectRootPath) {
  const scope = currentScope();
  if (!scope) return readWorkflowConfig(await projectRoot(projectRootPath));
  if (!scope.configs.has(projectRootPath)) scope.configs.set(projectRootPath, projectRoot(projectRootPath).then(readWorkflowConfig));
  return scope.configs.get(projectRootPath);
}
const currentScope = () => {
  const scope = readScope.getStore();
  return scope?.open ? scope : null;
};
async function storeOf(projectRootPath) {
  const store = await resolveStore(projectRootPath);
  if (!store.external || store.checkoutless) return { ...store, repository: null };
  return { ...store, repository: await checkedRepository(store) };
}
async function recordStoreSummary(projectRootPath) {
  let store;
  try {
    store = await resolveStore(projectRootPath);
  } catch {
    return null;
  }
  if (!store.external) return null;
  const configured = (await readWorkflowConfig(store.root)).workspace?.store ?? null;
  const status = store.sync ? await readSyncStatus(store.base) : null;
  return {
    store: configured === null ? null : withoutCredentials(configured),
    folder: store.base,
    sync: store.sync ? "on" : "off",
    lastSync: status ? { state: status.state, at: status.at } : null,
    note: "This record lives in the project's record store, not in the checkout, and the store is shared with every checkout of the workspace; read and change it only through Prism's tools."
  };
}
async function resolveStore(projectRootPath) {
  const root = await projectRoot(projectRootPath);
  const checkoutless = checkoutlessRoots.get(root);
  if (checkoutless) return { root, base: checkoutless.base, contain: checkoutless.base, external: true, sync: checkoutless.sync, checkoutless: true };
  const config = await readWorkflowConfig(root);
  const { workspace } = config;
  const configured = workspace?.store ?? null;
  if (configured === null) return { root, base: path.join(root, RECORD_DIRECTORY), contain: root, external: false, sync: false };
  checkArtifactFolders(config);
  if (isRemoteStore(configured)) {
    const base2 = await managedRecordStore(root, configured, (message, store) => fail("store_unavailable", message, { store }));
    if (inside(root, base2) || inside(base2, root)) throw fail("store_unavailable", `The clone ${base2} of the record store named under Workspace in .prism/workflow.md overlaps the project root. Keep the host's plugin data directory outside the project.`, { resolved: base2 });
    return { root, base: base2, contain: base2, external: true, sync: workspace.sync === true };
  }
  const resolved = path.resolve(root, configured);
  const unavailable = (reason) => fail("store_unavailable", `The record store ${configured} named under Workspace in .prism/workflow.md resolves to ${resolved}, which ${reason}`, { store: configured, resolved });
  let base;
  try {
    base = await realpath(resolved);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) throw unavailable("does not exist. Create or clone the store there; Prism never creates it.");
    throw error;
  }
  if (!(await stat(base)).isDirectory()) throw unavailable("is not a directory. Create or clone the store there; Prism never creates it.");
  if (inside(root, base)) throw unavailable("is inside the project root. Place the store outside the project, so every checkout can share it.");
  if (inside(base, root)) throw unavailable("contains the project root. Place the store beside the project, so records and project files never share a folder.");
  const tooOld = workspace.sync === true ? await gitTooOld() : null;
  if (tooOld) throw unavailable(`has Store sync on. ${tooOld.replace(/; update Git\.$/, "; update Git, or turn Store sync off.")}`);
  return { root, base, contain: base, external: true, sync: workspace.sync === true };
}
async function checkedRepository(store) {
  const key = `${store.root}\0${store.base}`;
  const cached = nameChecks.get(key);
  let pending = cached && (cached.at === null || Date.now() - cached.at < MIGRATION_TTL_MS) ? cached.pending : null;
  if (!pending) {
    pending = (async () => {
      const name = (await readWorkflowConfig(store.root)).workspace?.repository ?? null;
      return checkRepositoryName({ root: store.root, base: store.base, name, fail, sync: store.sync, beforeWrite: () => ensureHousekeeping(store) });
    })();
    pending.catch((error) => {
      if ((!REPOSITORY_REFUSALS.includes(error?.code) || error?.pending === true) && nameChecks.get(key)?.pending === pending) nameChecks.delete(key);
    });
    const entry = { at: null, pending };
    nameChecks.set(key, entry);
    pending.then(() => {
      entry.at = Date.now();
    }, () => {
      entry.at = Date.now();
    });
  }
  return (await pending).repository;
}
const ARTIFACT_FOLDERS = Object.freeze([["requirements", "Requirements"], ["adrs", "ADRs"], ["plans", "Plans"]]);
function checkArtifactFolders(config) {
  let components = [];
  try {
    components = readComponents(config).declared;
  } catch {
    components = [];
  }
  for (const [key, label] of ARTIFACT_FOLDERS) {
    const folder = config?.paths?.[key];
    if (typeof folder !== "string") continue;
    const component = folder === "" ? null : components.find((candidate) => candidate.folder === folder || candidate.folder.startsWith(`${folder}/`)) ?? null;
    if (folder !== "" && component === null) continue;
    const what = folder === "" ? "is the project root" : `${component.folder === folder ? "is" : "holds"} the folder ${component.folder} of the component ${component.name}`;
    throw fail("artifact_folder_invalid", `The ${label} folder ${JSON.stringify(folder === "" ? "." : folder)} configured under ## Paths in .prism/workflow.md ${what}, so moving its files into the record store would take the source tree; Prism moved, removed, and wrote no file. Set ${label} to a folder below the project root that holds no component's folder, or to n/a.`, { key: label, folder: folder === "" ? "." : folder, ...component ? { component: component.name } : {} });
  }
}
function recordsUnavailable(error) {
  return error?.code === "store_unavailable" || error?.code === "artifact_folder_invalid" || REPOSITORY_REFUSALS.includes(error?.code) || error?.code === "invalid_path" && error.storeLayout === true;
}
async function recordSyncStatus(projectRootPath) {
  const store = await recordStoreOf(projectRootPath).catch(() => null);
  return store?.sync ? readSyncStatus(store.base) : null;
}
async function describeRecordStore(projectRootPath) {
  const root = await projectRoot(projectRootPath);
  const checkoutless = checkoutlessRoots.get(root);
  if (checkoutless) return { kind: "remote", label: checkoutless.label, location: checkoutless.base, sync: checkoutless.sync };
  const configured = (await readWorkflowConfig(root)).workspace?.store ?? null;
  if (configured === null) return { kind: "project", label: RECORD_DIRECTORY, location: path.join(root, RECORD_DIRECTORY), sync: false };
  const kind = isRemoteStore(configured) ? "remote" : "folder";
  const label = kind === "remote" ? remoteLabel(configured) ?? "remote store" : configured;
  try {
    const store = await recordStoreOf(root);
    return { kind, label, location: store.base, sync: store.sync };
  } catch (error) {
    if (!recordsUnavailable(error)) throw error;
    return { kind, label, location: null, sync: false, unavailable: withoutCredentials(error.message) };
  }
}
async function listRecordStoreConflicts(projectRootPath) {
  return listSavedConflicts((await recordStoreOf(projectRootPath)).base);
}
async function readRecordStoreConflict(projectRootPath, savedAs) {
  return readSavedConflict((await recordStoreOf(projectRootPath)).base, savedAs);
}
async function resolveRecordFile(projectRootPath, relative) {
  const part = storeRelative(relative);
  if (part === null) return { root: projectRootPath, target: path.resolve(projectRootPath, relative) };
  const store = await recordStoreOf(projectRootPath);
  if (!store.external) return { root: projectRootPath, target: path.resolve(projectRootPath, relative) };
  return { root: store.contain, target: path.join(store.base, part) };
}
async function assertContained(root, target, label = "the project root", checks = null, { write = false } = {}) {
  checks ??= write ? null : currentScope()?.folderChecks ?? null;
  let current = path.dirname(target);
  while (true) {
    try {
      if (checks?.missing.has(current)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      const real = checks?.reals.get(current) ?? await realpath(current);
      if (!inside(root, real)) throw fail("invalid_path", `The record location resolves outside ${label}.`);
      checks?.reals.set(current, real);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      checks?.missing.add(current);
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
async function readStoreFileBytes(target, max) {
  return readBytes(target, max);
}
const oversizedRevision = (error) => createHash("sha256").update(`oversized:${error.size}`).digest("hex");
async function readBytes(target, max) {
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    if (error.code === "ELOOP") throw fail("invalid_path", "A record must not be a symbolic link.");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail("invalid_path", "A record must be a regular file.");
    if (info.size > max) throw fail("artifact_too_large", `The record holds ${info.size} bytes, above the ${boundText(max)} that a store file of its kind may hold, so it is read as a damaged record.`, { tooLarge: true, size: info.size, bound: max });
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function ensureHousekeeping(store) {
  const directory = store.base;
  await mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(HOUSEKEEPING)) {
    const target = path.join(directory, name);
    if (!await regularFile(target)) await writeAtomically(target, contents);
  }
}
async function legacyRecords(root, store, config) {
  const moves = [];
  const roadmap = roadmapPaths(config);
  if (roadmap) moves.push({ from: roadmap.record, to: ROADMAP_RECORD });
  if (config.paths.plans === null) return moves;
  let entries = [];
  try {
    entries = await readdir(path.join(root, config.paths.plans), { withFileTypes: true });
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  for (const entry of entries.filter((item) => item.isDirectory() && SLUG_PATTERN.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const initiative = entry.name, directory = initiativeDirectory(config, initiative);
    moves.push({ from: `${directory}/${RECORD_FILES.initiative}`, to: recordPath({ kind: "initiative", initiative }) });
    moves.push({ from: `${directory}/${RECORD_FILES.state}`, to: recordPath({ kind: "state", initiative }) });
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
    } catch {
    }
  }
  return initiative;
}
async function inRepoRecords(root) {
  const moves = [];
  const visit = async (relative) => {
    let entries = [];
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
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
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) if (entry.isDirectory()) await pruneEmptyFolders(path.join(target, entry.name));
  await rmdir(target).catch(() => {
  });
}
async function moveRecord(root, store, move, report) {
  const source = path.join(root, move.from), target = physical(store, move.to);
  if (!await regularFile(source)) return;
  await assertContained(root, source, "the project root", null, { write: true });
  await assertContained(store.contain, target, store.external ? "the record store" : "the project root", null, { write: true });
  if (await regularFile(target)) {
    const [left, right] = await Promise.all([readFile(source), readFile(target)]);
    if (left.equals(right)) {
      await rm(source, { force: true });
      report.moved.push(move);
      return;
    }
    report.conflicts.push(move);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  if (store.external) {
    await writeAtomically(target, await readFile(source));
    await rm(source, { force: true });
  } else await rename(source, target);
  report.moved.push(move);
}
const LEGACY_MARKER = /^[0-9a-f]{40,64}\.json$/;
const ledgers = /* @__PURE__ */ new Map();
async function readLedger(store) {
  const directory = path.join(store.base, "migrations");
  let names = [];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  const cached = ledgers.get(store.base);
  if (cached && cached.names === names.join("\n")) return cached.ledger;
  const ledger = { records: /* @__PURE__ */ new Set(), repositories: /* @__PURE__ */ new Set() };
  for (const name of names) {
    let entry;
    try {
      entry = parseStoreJson((await readBytes(path.join(directory, name), STORE_FILE_BOUNDS.migration))?.toString("utf8") ?? "null");
    } catch {
      continue;
    }
    if (LEGACY_MARKER.test(name)) ledger.repositories.add(name.slice(0, -".json".length));
    for (const record of entry?.records ?? []) if (typeof record === "string") ledger.records.add(record);
    for (const conflict of entry?.conflicts ?? []) if (typeof conflict?.to === "string") ledger.records.add(conflict.to);
  }
  ledgers.set(store.base, { names: names.join("\n"), ledger });
  return ledger;
}
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
    for (const move of await fresh()) await moveRecord(root, store, move, report);
    if (!report.moved.length && !report.conflicts.length) return;
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const marker = path.join(store.base, "migrations", `${at.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.json`);
    await mkdir(path.dirname(marker), { recursive: true });
    await assertContained(store.contain, marker, "the record store", null, { write: true });
    const records = [...new Set(report.moved.map((move) => move.to))];
    await writeAtomically(marker, `${JSON.stringify({ schemaVersion: 2, repository, migratedAt: at, moved: records.length, records, conflicts: report.conflicts }, null, 2)}
`);
  }, fail, { timeoutMs: 3e4 }));
  await pruneEmptyFolders(path.join(root, INITIATIVES));
  return report;
}
async function migrate(root) {
  const report = { moved: [], conflicts: [] };
  const store = await recordStoreOf(root);
  const config = await readWorkflowConfig(root);
  if (store.external) {
    await migrateIntoStore(root, store, config, report);
    await noteRecordMoves(root, store, report);
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
  }, fail, { timeoutMs: 3e4 }));
  pendingMoves.delete(root);
  await noteRecordMoves(root, store, report);
  return report;
}
const RECORD_MOVE_NOTES = path.join(".prism-sync", "record-moves");
const LOCAL_RECORD_MOVE_NOTES = "record-moves";
const RECORD_MOVE_NOTE = /^\d+-[0-9a-f]{8}\.json$/;
const recordMoveNotes = (root, store) => store.external ? path.join(store.base, RECORD_MOVE_NOTES) : path.join(reviewAppDirectory(), LOCAL_RECORD_MOVE_NOTES, createHash("sha256").update(root).digest("hex").slice(0, 32));
async function noteRecordMoves(root, store, report) {
  if (!report.moved.length && !report.conflicts.length) return;
  const entry = { root, ...store.external ? { store: store.base } : {}, moved: report.moved, conflicts: report.conflicts };
  if (toolCalls.getStore()?.open) {
    unreportedMoves.push(entry);
    return;
  }
  try {
    const directory = recordMoveNotes(root, store);
    await mkdir(directory, { recursive: true, mode: 448 });
    const note = path.join(directory, `${Date.now()}-${randomBytes(4).toString("hex")}.json`);
    if (store.external) await assertContained(store.contain, note, "the record store", null, { write: true });
    await writeAtomically(note, `${JSON.stringify(entry)}
`);
  } catch {
    unreportedMoves.push(entry);
  }
}
async function takeRecordMoveNotes(root) {
  let directory, names;
  try {
    directory = recordMoveNotes(root, await recordStoreOf(root));
    names = (await readdir(directory)).filter((name) => RECORD_MOVE_NOTE.test(name)).sort();
  } catch {
    return [];
  }
  const taken = [];
  for (const name of names) {
    const note = path.join(directory, name);
    let entry;
    try {
      entry = parseStoreJson(await readFile(note, "utf8"));
    } catch {
      continue;
    }
    if (entry?.root !== root || !Array.isArray(entry.moved) || !Array.isArray(entry.conflicts)) continue;
    const claimed = path.join(directory, `.${name}.${randomBytes(4).toString("hex")}.taken`);
    try {
      await rename(note, claimed);
    } catch {
      continue;
    }
    await rm(claimed, { force: true }).catch(() => {
    });
    taken.push({ root, ...typeof entry.store === "string" ? { store: entry.store } : {}, moved: entry.moved, conflicts: entry.conflicts });
  }
  await rmdir(directory).catch(() => {
  });
  return taken;
}
const toolCalls = new AsyncLocalStorage();
async function withToolCall(call, run) {
  call.open = true;
  try {
    return await toolCalls.run(call, run);
  } finally {
    call.open = false;
  }
}
const toolCallContext = () => ({ roots: /* @__PURE__ */ new Set(), open: false, writes: /* @__PURE__ */ new Map() });
function noteToolCallWrite(target, version) {
  const call = toolCalls.getStore();
  if (!call?.open || !call.writes) return;
  call.writes.set(target, /* @__PURE__ */ new Set([...call.writes.get(target) ?? [], version]));
}
function nameToolCallRoot(root) {
  const call = toolCalls.getStore();
  if (call?.open) call.roots.add(root);
}
function outsideToolCall(run) {
  return toolCalls.exit(run);
}
const inToolCallOf = (root) => {
  const call = toolCalls.getStore();
  return call?.open === true && call.roots.has(root);
};
const artifactMigrations = /* @__PURE__ */ new Map();
const deferredMoves = /* @__PURE__ */ new Map();
const RETRY_WAIT_MS = 1e3;
const PULLED = /* @__PURE__ */ new Set(["ok", "conflicts", "push_rejected", "no_upstream", "not_a_repository"]);
const MOVED = Promise.resolve(null);
const unfinishedMoves = [];
const namedMoves = /* @__PURE__ */ new Map();
function migrateArtifactsOnce(root, store, config) {
  const key = `${root}\0${store.base}`;
  if (artifactMigrations.has(key)) return artifactMigrations.get(key).then(() => null);
  const pending = (async () => {
    const { migrateArtifacts } = await import("./artifact-migration.mjs");
    return migrateArtifacts({
      root,
      kinds: artifactKinds(config),
      store: store.base,
      repository: store.repository,
      named: namedMoves.get(key) ?? namedMoves.set(key, /* @__PURE__ */ new Set()).get(key),
      // With store sync on, the move decides against the store as its own pull left it, so it reads what other machines pushed.
      pull: store.sync ? (move) => pullThenMove(root, store, key, move) : null,
      prepare: async ({ pulled }) => {
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
  const forget = () => {
    if (artifactMigrations.get(key) === pending) artifactMigrations.delete(key);
  };
  pending.then((outcome) => {
    if (outcome?.deferred || outcome?.operation) forget();
    else deferredMoves.delete(key);
    if (outcome?.retry) artifactMigrations.delete(key);
  }, forget);
  return pending;
}
async function pullAndMove(store, move) {
  let moved = null;
  const whileLocked = async (status2) => {
    if (PULLED.has(status2?.state)) moved = await move().then((outcome) => ({ outcome }), (error) => ({ error }));
  };
  const status = await syncRecordStoreNow(store.base, { whileLocked }).catch(() => ({ state: "git_failed" }));
  const state = typeof status?.state === "string" ? status.state : "git_failed";
  return moved ? { pulled: true, state, ...moved } : { pulled: false, state };
}
const settledMove = (result) => {
  if (result.error) throw result.error;
  return result;
};
async function pullThenMove(root, store, key, move) {
  await prepareStoreFiles(store.base).catch(() => {
  });
  const deferred = deferredMoves.get(key);
  if (!deferred) {
    const result = await pullAndMove(store, move);
    if (!result.pulled) deferredMoves.set(key, { state: result.state, retry: null });
    return settledMove(result);
  }
  if (!deferred.retry) {
    deferred.retry = pullAndMove(store, move).then((result) => {
      deferred.retry = null;
      if (!result.pulled) {
        deferred.state = result.state;
        return result;
      }
      if (result.error || result.outcome?.operation) return result;
      if (deferredMoves.get(key) === deferred) {
        deferredMoves.delete(key);
        artifactMigrations.set(key, MOVED);
      }
      if (result.outcome) unfinishedMoves.push({ key, root, store: store.base, outcome: result.outcome });
      return { ...result, handedOff: true };
    });
  }
  let timer;
  const waited = await Promise.race([deferred.retry, new Promise((resolve) => {
    timer = setTimeout(resolve, RETRY_WAIT_MS, null);
  })]);
  clearTimeout(timer);
  if (!waited) return { pulled: false, state: deferred.state };
  if (!waited.handedOff) return settledMove(waited);
  return { pulled: true, state: waited.state, outcome: null };
}
async function finishUnfinishedMoves(roots, { proceed = () => true, writes = null } = {}) {
  const handoffs = unfinishedMoves.filter((handoff) => roots.has(handoff.root));
  if (!handoffs.length) return;
  const { finishedMove } = await import("./artifact-migration.mjs");
  for (const handoff of handoffs) {
    if (!proceed()) return;
    const index = unfinishedMoves.indexOf(handoff);
    if (index === -1) continue;
    unfinishedMoves.splice(index, 1);
    let outcome;
    try {
      outcome = await finishedMove(handoff.outcome, { proceed, writes });
    } catch {
      artifactMigrations.delete(handoff.key);
      continue;
    }
    if (outcome?.interrupted) {
      unfinishedMoves.unshift(handoff);
      return;
    }
    if (outcome?.pending) {
      unfinishedMoves.splice(Math.min(index, unfinishedMoves.length), 0, handoff);
      unreportedMoves.push({ root: handoff.root, store: handoff.store, moved: [], conflicts: [], artifacts: outcome.pending });
      continue;
    }
    if (outcome?.retry) artifactMigrations.delete(handoff.key);
    if (outcome) unreportedMoves.push({ root: handoff.root, store: handoff.store, moved: [], conflicts: [], artifacts: outcome });
  }
}
async function artifactsInCheckout(projectRootPath) {
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
async function storedFrozenTests(store) {
  const tests = /* @__PURE__ */ new Set();
  let names = [];
  try {
    names = (await readdir(path.join(store.base, "initiatives"), { withFileTypes: true })).filter((entry) => entry.isDirectory() && SLUG_PATTERN.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  for (const name of names) {
    let record;
    try {
      record = parseStoreJson((await readBytes(physical(store, recordPath({ kind: "initiative", initiative: name })), STORE_FILE_BOUNDS.initiative))?.toString("utf8") ?? "null");
    } catch {
      continue;
    }
    for (const slice of Object.values(record?.slices ?? {})) {
      for (const test of Array.isArray(slice?.design?.frozenTests) ? slice.design.frozenTests : []) {
        const file = normalizeArtifactPath(typeof test === "string" ? test : test?.path);
        if (file) tests.add(file);
      }
    }
  }
  return tests;
}
function legacyLocations(root, store) {
  if (store.external) return Promise.resolve(/* @__PURE__ */ new Map());
  const cached = pendingMoves.get(root);
  if (cached && Date.now() - cached.at < MIGRATION_TTL_MS) return cached.value;
  const value = (async () => {
    const found = /* @__PURE__ */ new Map();
    for (const move of await legacyRecords(root, store, await readWorkflowConfig(root))) {
      if (found.has(move.to) || !await regularFile(path.join(root, move.from)).catch(() => false)) continue;
      if (!await regularFile(path.join(root, move.to)).catch(() => true)) found.set(move.to, move.from);
    }
    return found;
  })();
  value.catch(() => pendingMoves.delete(root));
  pendingMoves.set(root, { at: Date.now(), value });
  return value;
}
async function takeMigrationReports(roots = /* @__PURE__ */ new Set()) {
  const taken = unreportedMoves.filter((report) => !report.artifacts || roots.has(report.root));
  for (const report of taken) unreportedMoves.splice(unreportedMoves.indexOf(report), 1);
  const noted = [];
  for (const root of roots) noted.push(...await takeRecordMoveNotes(root));
  return [...noted, ...taken];
}
function restoreMigrationReports(reports) {
  unreportedMoves.unshift(...reports ?? []);
}
async function moveLegacyRecords(projectRootPath) {
  let root;
  try {
    root = await projectRoot(projectRootPath);
  } catch {
    return;
  }
  await ensureRecords(root);
}
async function ensureRecords(root) {
  if (checkoutlessRoots.has(root)) return { moved: [], conflicts: [] };
  const { report, store, config } = await recordsMoved(root);
  if (store.external && inToolCallOf(root)) {
    const artifacts = await migrateArtifactsOnce(root, store, config);
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
function forgetMigrations() {
  migrations.clear();
  artifactMigrations.clear();
  deferredMoves.clear();
  unfinishedMoves.length = 0;
  namedMoves.clear();
  pendingMoves.clear();
  nameChecks.clear();
}
const storeLabel = (store) => store.external ? "the record store" : "the project root";
const fetchlessReads = new AsyncLocalStorage();
function withFetchlessReads(run) {
  return fetchlessReads.run(true, run);
}
async function synced(store) {
  if (!store.sync) return;
  await prepareStoreFiles(store.base).catch(() => {
  });
  if (!store.checkoutless && !fetchlessReads.getStore()) pullRecordStoreIfStale(store.base);
  await waitForStableStore(store.base);
}
async function openStore(projectRootPath, { write = false } = {}) {
  const store = await recordStoreOf(projectRootPath);
  const scope = write ? null : currentScope();
  if (!scope) {
    if (write || store.external) await ensureRecords(store.root);
    await synced(store);
    return store;
  }
  if (!scope.synced.has(store.base)) scope.synced.set(store.base, (async () => {
    if (store.external) await ensureRecords(store.root);
    await synced(store);
  })());
  await scope.synced.get(store.base);
  return store;
}
async function locate(projectRootPath, key, options) {
  const store = await openStore(projectRootPath, options);
  const relative = recordPath(key);
  const target = physical(store, relative);
  await assertContained(store.contain, target, storeLabel(store));
  const located = { root: store.root, path: relative, target };
  if (key.kind === "runs" || await regularFile(target)) return { store, located };
  const legacy = (await legacyLocations(store.root, store)).get(relative);
  if (!legacy) return { store, located };
  const source = path.join(store.root, legacy);
  await assertContained(store.root, source);
  return { store, located: { ...located, target: source, legacy } };
}
async function locateRecord(projectRootPath, key) {
  return (await locate(projectRootPath, key)).located;
}
async function readRecord(projectRootPath, key, { maxBytes = STORE_FILE_BOUNDS[key?.kind] ?? STORE_FILE_BOUNDS.artifact } = {}) {
  const { located } = await locate(projectRootPath, key);
  return { ...located, bytes: await readBytes(located.target, maxBytes) };
}
async function writeRecord(projectRootPath, key, contents) {
  const { store, located } = await locate(projectRootPath, key, { write: true });
  await mkdir(path.dirname(located.target), { recursive: true });
  await assertContained(store.contain, located.target, storeLabel(store), null, { write: true });
  await ensureHousekeeping(store);
  await writeAtomically(located.target, contents);
  if (store.sync) scheduleRecordSync(store.base);
  return located;
}
async function withRecordLock(projectRootPath, key, action, makeError = fail, options = {}) {
  const { store, located } = await locate(projectRootPath, key, { write: true });
  await mkdir(path.dirname(located.target), { recursive: true });
  await assertContained(store.contain, located.target, storeLabel(store), null, { write: true });
  return withArtifactLock(located.target, () => withFileLock(located.target, () => action(located), makeError, options));
}
async function removeRecord(projectRootPath, key) {
  const { store, located } = await locate(projectRootPath, key, { write: true });
  await assertContained(store.contain, located.target, storeLabel(store), null, { write: true });
  if (!await regularFile(located.target)) return false;
  await rm(located.target, { force: true });
  await rmdir(path.dirname(located.target)).catch(() => {
  });
  if (store.sync) scheduleRecordSync(store.base);
  return true;
}
async function listClaimRecords(projectRootPath, initiative) {
  const { located } = await locate(projectRootPath, { kind: "claim", initiative, slice: "x" });
  const folder = path.dirname(located.target);
  let names = [];
  try {
    names = (await readdir(folder)).filter((name) => name.endsWith(".json") && SLUG_PATTERN.test(name.slice(0, -5))).sort();
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  const claims = [];
  for (const name of names) {
    const bytes = await readBytes(path.join(folder, name), 64 * 1024).catch(() => null);
    if (bytes !== null) claims.push({ slice: name.slice(0, -5), bytes });
  }
  return claims;
}
async function appendRecord(projectRootPath, key, id, entry) {
  if (typeof id !== "string" || !ENTRY_ID.test(id)) throw fail("validation_failed", "An entry id must use letters, digits, dots, hyphens, or underscores.");
  const { store, located } = await locate(projectRootPath, key, { write: true });
  const target = path.join(located.target, `${id}.json`);
  await ensureHousekeeping(store);
  await mkdir(located.target, { recursive: true });
  await assertContained(store.contain, target, storeLabel(store), null, { write: true });
  const appended = await withArtifactLock(target, () => withFileLock(target, async () => {
    if (await regularFile(target)) throw fail("entry_exists", `The entry ${id} already exists.`);
    await writeAtomically(target, `${JSON.stringify(entry, null, 2)}
`);
    return { ...located, path: `${located.path}/${id}.json`, target };
  }, fail));
  if (store.sync) scheduleRecordSync(store.base);
  return appended;
}
async function listFormatMigrationRecords(projectRootPath) {
  const { located } = await locate(projectRootPath, { kind: "format-migration", id: "migration-00000000" });
  const folder = path.dirname(located.target);
  let names = [];
  try {
    names = (await readdir(folder)).filter((name) => FORMAT_MIGRATION_FILE.test(name)).sort();
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  const records = [];
  for (const name of names) {
    const bytes = await readBytes(path.join(folder, name), STORE_FILE_BOUNDS["format-migration"]).catch(() => null);
    if (bytes !== null) records.push({ id: name.slice(0, -".json".length), bytes });
  }
  return records;
}
async function listFormatFindingRecords(projectRootPath) {
  const { located } = await locate(projectRootPath, { kind: "format-finding", id: "finding-0000000000000000" });
  const folder = path.dirname(located.target);
  let names = [];
  try {
    names = (await readdir(folder)).filter((name) => FORMAT_FINDING_FILE.test(name)).sort();
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  const records = [];
  for (const name of names) {
    const bytes = await readBytes(path.join(folder, name), STORE_FILE_BOUNDS["format-finding"]).catch(() => null);
    if (bytes !== null) records.push({ id: name.slice(0, -".json".length), bytes });
  }
  return records;
}
async function listRecordEntries(projectRootPath, key, { maxBytes = STORE_FILE_BOUNDS.runs } = {}) {
  const { located } = await locate(projectRootPath, key);
  let names = [];
  try {
    names = (await readdir(located.target)).filter((name) => name.endsWith(".json") && ENTRY_ID.test(name.slice(0, -5))).sort();
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  const entries = [];
  for (const name of names) {
    const bytes = await readBytes(path.join(located.target, name), maxBytes);
    if (bytes !== null) entries.push({ id: name.slice(0, -5), entry: parseStoreJson(bytes.toString("utf8")) });
  }
  return entries;
}
async function directoryNames(target) {
  try {
    return (await readdir(target, { withFileTypes: true })).filter((entry) => entry.isDirectory() && SLUG_PATTERN.test(entry.name)).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function listInitiatives(projectRootPath) {
  const store = await openStore(projectRootPath);
  const ids = /* @__PURE__ */ new Set();
  for (const initiative of await directoryNames(physical(store, INITIATIVES))) {
    for (const kind of ["initiative", "state"]) if (await regularFile(physical(store, recordPath({ kind, initiative })))) {
      ids.add(initiative);
      break;
    }
  }
  for (const relative of (await legacyLocations(store.root, store)).keys()) {
    const key = parseRecordPath(relative);
    if (key?.kind === "initiative" || key?.kind === "state") ids.add(key.initiative);
  }
  return [...ids].sort();
}
async function listSliceRecords(projectRootPath, initiative) {
  const store = await openStore(projectRootPath);
  const slices = new Set(await directoryNames(path.join(physical(store, INITIATIVES), requireSlug(initiative, "initiative"), "slices")));
  for (const relative of (await legacyLocations(store.root, store)).keys()) {
    const key = parseRecordPath(relative);
    if (key?.slice && key.initiative === initiative) slices.add(key.slice);
  }
  return [...slices].sort();
}
async function removeInitiativeRecords(projectRootPath, initiative) {
  const store = await recordStoreOf(projectRootPath);
  await ensureRecords(store.root);
  await synced(store);
  const target = path.join(physical(store, INITIATIVES), requireSlug(initiative, "initiative"));
  await assertContained(store.contain, path.join(target, "x"), storeLabel(store), null, { write: true });
  for (const kind of ["initiative", "state"]) await rm(physical(store, recordPath({ kind, initiative })), { force: true });
  await rm(path.join(target, CLAIMS), { recursive: true, force: true });
  for (const slice of await directoryNames(path.join(target, "slices"))) {
    const folder = path.join(target, "slices", slice);
    for (const entry of await readdir(folder)) if (entry !== "runs") await rm(path.join(folder, entry), { recursive: true, force: true });
    await rmdir(folder).catch(() => {
    });
  }
  await rmdir(path.join(target, "slices")).catch(() => {
  });
  await rmdir(target).catch(() => {
  });
  await rmdir(physical(store, INITIATIVES)).catch(() => {
  });
  if (store.sync) scheduleRecordSync(store.base);
}
async function sliceDocumentFolder(projectRootPath, initiative, slice) {
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
  } catch {
  }
  return slice === rootSlice ? directory : `${directory}/${slice}`;
}
async function keyOfPath(projectRootPath, relative) {
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
async function sameRecord(projectRootPath, left, right) {
  if (left === right) return true;
  const [a, b] = await Promise.all([keyOfPath(projectRootPath, left), keyOfPath(projectRootPath, right)]);
  return Boolean(a && b) && recordPath(a) === recordPath(b);
}
async function seenScopes(projectRootPath) {
  const root = await projectRoot(projectRootPath);
  const config = await readWorkflowConfig(root);
  if ((config.workspace?.store ?? null) === null && !checkoutlessRoots.has(root)) throw fail("store_not_configured", "This project's .prism/workflow.md names no record store under ## Workspace, so its descriptive artifacts stay in the checkout: read and edit them there with your own file tools.");
  const store = await recordStoreOf(root);
  await ensureRecords(store.root);
  await synced(store);
  return scopesOf(root, config, store);
}
async function scopesOf(root, config, store) {
  const base = path.join(store.base, ARTIFACTS);
  let scopes = [WORKSPACE_SCOPE];
  if (store.repository !== null) {
    const own = repositoryScope(store.repository);
    const components = path.join(base, scopeFolder(own), "components");
    await assertUnlinked(store.base, path.join(components, "x"));
    scopes = [WORKSPACE_SCOPE, own, ...(await folderNames(components, COMPONENT_NAME)).map((name) => componentScope(store.repository, name))];
  }
  const others = [];
  for (const name of await folderNames(path.join(base, REPOSITORIES), portableRepositoryName)) {
    if (name === store.repository) continue;
    others.push(repositoryScope(name));
    for (const component of await folderNames(path.join(base, REPOSITORIES, name, "components"), COMPONENT_NAME)) others.push(componentScope(name, component));
  }
  const all = [...scopes, ...others].sort((left, right) => left.label < right.label ? -1 : left.label > right.label ? 1 : 0);
  return { root, config, kinds: artifactKinds(config), store, base, repository: store.repository, scopes, all };
}
async function folderNames(folder, form) {
  const named = typeof form === "function" ? form : (name) => form.test(name);
  try {
    return (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isDirectory() && named(entry.name)).map((entry) => entry.name).sort();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return [];
    throw error;
  }
}
async function repositoryScopes(seen, repository) {
  if (typeof repository !== "string" || !COMPONENT_NAME.test(repository)) return [];
  const own = repositoryScope(repository);
  const components = path.join(seen.base, scopeFolder(own), "components");
  await assertUnlinked(seen.store.base, path.join(components, "x"));
  let names = [];
  try {
    names = (await readdir(components, { withFileTypes: true })).filter((entry) => entry.isDirectory() && COMPONENT_NAME.test(entry.name)).map((entry) => entry.name).sort();
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  return [own, ...names.map((name) => componentScope(repository, name))];
}
async function assertUnlinked(base, target, checks = null) {
  const relative = path.relative(base, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw fail("invalid_path", "The artifact location resolves outside the record store.");
  let current = base;
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const above = checks !== null && index < parts.length - 1;
    if (above && checks.folders.has(current)) continue;
    if (above && checks.missing.has(current)) return;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      if (above) checks.missing.add(current);
      return;
    }
    if (info.isSymbolicLink()) throw fail("invalid_path", "An artifact location in the record store passes through a symbolic link, which Prism does not follow.");
    if (above && info.isDirectory()) checks.folders.add(current);
  }
}
const folderChecks = () => ({ folders: /* @__PURE__ */ new Set(), missing: /* @__PURE__ */ new Set(), reals: /* @__PURE__ */ new Map() });
async function resolveArtifactFile(seen, location, { fresh = false } = {}) {
  const target = path.join(seen.base, ...location.split("/"));
  if (!inside(seen.base, target) || target === seen.base) throw fail("invalid_path", "The artifact location resolves outside the store's artifacts folder.");
  const checks = fresh ? null : seen.folderChecks ?? currentScope()?.folderChecks ?? null;
  await assertUnlinked(seen.store.base, target, checks);
  await assertContained(seen.store.contain, target, "the record store", checks);
  return target;
}
async function resolveStatusFile(seen, relative, { fresh = false } = {}) {
  const folder = path.join(seen.store.base, relative.split("/")[0]);
  if (![ARTIFACT_STATUS, ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY].includes(relative.split("/")[0])) throw fail("invalid_path", "A status file lies outside the store's status folders.");
  const target = path.join(seen.store.base, ...relative.split("/"));
  if (!inside(folder, target) || target === folder) throw fail("invalid_path", "The status location resolves outside the store's status folders.");
  const checks = fresh ? null : seen.folderChecks ?? currentScope()?.folderChecks ?? null;
  await assertUnlinked(seen.store.base, target, checks);
  await assertContained(seen.store.contain, target, "the record store", checks);
  return target;
}
function statusFileResolver(seen) {
  const kinds = /* @__PURE__ */ new Map(), reals = /* @__PURE__ */ new Map();
  const kindOf = (target) => {
    if (!kinds.has(target)) kinds.set(target, lstat(target).then((info) => info.isSymbolicLink() ? "link" : "present", (error) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return "missing";
      throw error;
    }));
    return kinds.get(target);
  };
  const realOf = (target) => {
    if (!reals.has(target)) reals.set(target, realpath(target));
    return reals.get(target);
  };
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
async function resolveLedgerFile(seen, name) {
  if (!ARTIFACT_LEDGER_FILE.test(name)) throw fail("invalid_path", "An artifact ledger file has a time and a random suffix as its name.");
  const target = path.join(seen.store.base, ARTIFACT_MIGRATIONS, name);
  await assertUnlinked(seen.store.base, target);
  await assertContained(seen.store.contain, target, "the record store", null, { write: true });
  return target;
}
async function withArtifactStoreLock(seen, action, options = {}) {
  const lock = path.join(seen.store.base, ARTIFACTS);
  return withArtifactLock(lock, () => withFileLock(lock, async () => {
    await ensureHousekeeping(seen.store);
    return action();
  }, fail, options));
}
const storeArtifacts = () => import("./store-artifacts.mjs");
async function inArtifactStore(projectRootPath, file) {
  return (await artifactPathTest(projectRootPath))(file);
}
async function artifactPathTest(projectRootPath) {
  const config = await scopedWorkflowConfig(projectRootPath);
  if ((config.workspace?.store ?? null) === null) return () => false;
  const kinds = artifactKinds(config);
  return (file) => {
    const normalized = normalizeArtifactPath(file);
    if (normalized === null || normalized === "") return false;
    const address = artifactAddress(kinds, normalized);
    return address !== null && address.rest !== "";
  };
}
async function readArtifactBytes(projectRootPath, file) {
  if (await inArtifactStore(projectRootPath, file)) return (await (await storeArtifacts()).readStoreArtifact(projectRootPath, file))?.bytes ?? null;
  const root = await projectRoot(projectRootPath);
  try {
    return await readFile(path.resolve(root, file));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
}
async function readArtifactText(projectRootPath, file) {
  return (await readArtifactBytes(projectRootPath, file))?.toString("utf8") ?? null;
}
async function writeArtifactText(projectRootPath, file, decide, { write = writeAtomically, follow = false } = {}) {
  const choose = typeof decide === "function" ? decide : () => decide;
  if (await inArtifactStore(projectRootPath, file)) return { ...await (await storeArtifacts()).writeStoreArtifact(projectRootPath, file, choose, { follow }), store: true };
  const root = await projectRoot(projectRootPath);
  const target = path.resolve(root, file);
  if (!inside(root, target) || target === root) throw fail("invalid_path", `${file} lies outside the project root.`);
  await assertContained(root, target, "the project root", null, { write: true });
  const current = await regularFile(target) ? await readFile(target, "utf8") : null;
  const next = await choose(current);
  if (next === void 0 || next === null && current === null || next === current) return { written: false, store: false };
  if (next === null) await rm(target, { force: true });
  else {
    await mkdir(path.dirname(target), { recursive: true });
    await assertContained(root, target, "the project root", null, { write: true });
    await write(target, next);
  }
  return { written: true, store: false };
}
async function listStoreArtifacts(projectRootPath, folder = "") {
  const config = await scopedWorkflowConfig(projectRootPath);
  if ((config.workspace?.store ?? null) === null) return null;
  return (await storeArtifacts()).storeArtifactPaths(projectRootPath, folder);
}
export {
  ARTIFACT_COMMENT_FILE,
  ARTIFACT_LEDGER_FILE,
  COMMENTS_PER_ARTIFACT_MAX,
  FORMAT_FINDINGS,
  FORMAT_MIGRATIONS,
  INERT_FILES,
  RECORD_DIRECTORY,
  RecordStoreError,
  STORE_FILE_BOUNDS,
  STORE_TREE_FILES_MAX,
  appendRecord,
  artifactPathTest,
  artifactsInCheckout,
  boundText,
  checkArtifactFolders,
  describeRecordStore,
  ensureRecords,
  finishUnfinishedMoves,
  folderChecks,
  forgetMigrations,
  forgetStoreWithoutCheckout,
  inArtifactStore,
  isManagedRecordFile,
  isRootStoreFile,
  isStoreFile,
  isStoreFolder,
  isStoreWithoutCheckout,
  keyOfPath,
  listClaimRecords,
  listFormatFindingRecords,
  listFormatMigrationRecords,
  listInitiatives,
  listRecordEntries,
  listRecordStoreConflicts,
  listSliceRecords,
  listStoreArtifacts,
  locateRecord,
  moveLegacyRecords,
  nameToolCallRoot,
  noteToolCallWrite,
  outsideToolCall,
  oversizedRevision,
  parseRecordPath,
  readArtifactBytes,
  readArtifactText,
  readRecord,
  readRecordStoreConflict,
  readStoreFileBytes,
  recordPath,
  recordStoreOf,
  recordStoreSummary,
  recordSyncStatus,
  recordsUnavailable,
  removeInitiativeRecords,
  removeRecord,
  repositoryId,
  repositoryScopes,
  resolveArtifactFile,
  resolveLedgerFile,
  resolveRecordFile,
  resolveStatusFile,
  restoreMigrationReports,
  sameRecord,
  seenScopes,
  sliceDocumentFolder,
  statusFileResolver,
  storeFileBound,
  takeMigrationReports,
  toolCallContext,
  useStoreWithoutCheckout,
  withArtifactStoreLock,
  withFetchlessReads,
  withRecordLock,
  withRecordReads,
  withToolCall,
  writeArtifactText,
  writeRecord
};
