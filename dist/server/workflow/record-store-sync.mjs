import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_ACCEPTED, ARTIFACT_STATUS, ARTIFACTS, letterCaseKey, portableName, STORE_NAME_BYTES_MAX, STORE_PATH_BYTES_MAX, storePathFits, wellFormedName } from "./artifact-paths.mjs";
import { withFileLock, writeAtomically } from "./artifact-store.mjs";
import { commitProblem, gitFileName, isLinkMode, LINK_TARGET_BYTES_MAX, linkTargetProblem, TREE_DEPTH_MAX, TREE_DEPTH_TEXT, tooDeepTree, treeEntries, treeProblems } from "./git-objects.mjs";
import { hasRecordMerge, recordMergeFor } from "./record-merge.mjs";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { localRepository, localTransport, UnresolvableLocalRemote } from "./git-local-repository.mjs";
import { withoutCredentials } from "./remote-url.mjs";

// A record store that is a Git checkout exchanges its records with its upstream.
// One process at a time syncs a store, and record reads and writes wait while a merge replaces record files.
export const SYNC_DIRECTORY = ".prism-sync";
const SETTINGS = { debounceMs: 5000, pullIntervalMs: 30000, waitMs: 10000, applyLockMs: 2000, gitTimeoutMs: 120000 };
const PUSH_ATTEMPTS = 3;
const COMMIT_LIST = 20;
const scheduled = new Map();
const running = new Map();
// Stores whose debounced sync came due while a sync was running; that sync may have committed before the write.
const rerun = new Set();
const lastFetch = new Map();
// Stores this process synced or pulled, and the saved conflicts it already reported, so each agent hears once about a change the upstream won.
const PROCESS_START = Date.now();
const watched = new Set();
const reported = new Set();
// Clones that Prism made of a remote store, whose branch may publish itself to an empty origin.
const managed = new Set();
// Variables that could point Git at another repository, index, or object store than the store's own, read pathspecs or attributes another way, or send its output elsewhere,
// which the parent process may hold, as when a Git hook starts the server, so no store command inherits them.
const INHERITED_OUT = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|QUARANTINE_PATH|REPLACE_REF_BASE|GRAFT_FILE|SHALLOW_FILE|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS|ATTR_SOURCE|REDIRECT_STDIN|REDIRECT_STDOUT|REDIRECT_STDERR)$/;

/** Change the debounce, pull interval, or torn-read wait; tests shorten them. */
export function configureRecordSync(settings = {}) {
  for (const key of Object.keys(SETTINGS)) if (Number.isFinite(settings[key])) SETTINGS[key] = settings[key];
}

/** Cancel every debounced sync and forget fetch times, so a process or a test can finish. */
export function cancelRecordSyncs() {
  for (const timer of scheduled.values()) clearTimeout(timer);
  scheduled.clear();
  lastFetch.clear();
  rerun.clear();
}

// The notice every view that Prism generates from a record carries, as generatedNotice in projection.mjs writes it.
const GENERATED_VIEW = Buffer.from("This file is a generated view of ");
// A repository registration syncs as a record, so a registration made on two machines keeps the upstream one instead of failing the merge.
const isRegistrationFile = (relative) => /^repositories\/[^/]+\.json$/.test(relative);
const isRecordFile = (relative) => relative === "roadmap.json" || relative.startsWith("initiatives/") || isRegistrationFile(relative);
const isClaimFile = (relative) => /^initiatives\/[^/]+\/claims\/[^/]+\.json$/.test(relative);
// A claim or a registration that lost a race is its holder's news, reported through the refusal or acceptance it causes, so no conflict list shows it.
const isQuietConflict = (relative) => isClaimFile(relative) || isRegistrationFile(relative);
// A person's artifact keeps the upstream version on a line conflict, as a record does, and its local version is saved and reported by its location.
const isArtifactFile = (relative) => relative.startsWith(`${ARTIFACTS}/`);
// An artifact's status record and its accepted bytes change with the artifact under the artifact lock, so a sync stages them with the artifacts, and a status record that changed on both sides keeps the upstream one as a record does.
const STATUS_FOLDERS = [ARTIFACT_STATUS, ARTIFACT_ACCEPTED];
const isStatusFile = (relative) => STATUS_FOLDERS.some((folder) => relative.startsWith(`${folder}/`));
const isGuardedFile = (relative) => isArtifactFile(relative) || isStatusFile(relative);
const guardedFolder = (relative) => [ARTIFACTS, ...STATUS_FOLDERS].find((folder) => relative.startsWith(`${folder}/`)) ?? null;
const isSavedFile = (relative) => isRecordFile(relative) || isGuardedFile(relative);
const syncPath = (base, ...parts) => path.join(base, SYNC_DIRECTORY, ...parts);
// The pending notices of saved conflicts, one per conflict stamp, which tool results clear once they carry them.
const NOTICES = "notices";

function gitEnvironment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED_OUT.test(name)));
  // An SSH password or host-key prompt would hang a sync that holds the store lock, so SSH never asks unless the user configured it.
  const ssh = env.GIT_SSH_COMMAND || env.GIT_SSH ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  // The system attributes file, like the person's own and the store's, never decides which bytes a store command hands over.
  // A replace ref, which pack-objects and push ignore, would make the checks read other objects than the push sends, and a grafts file other parents than every other machine reads,
  // so every store command reads the real objects and parents instead: /dev/null, which Git for Windows also opens, holds no graft,
  // and FIXED_CONFIG turns off the advice Git gives about any grafts file it opens.
  return { ...env, ...ssh, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", LC_ALL: "C", ...extra };
}

// The sync uses Git only as an object store: it hashes a file's bytes with no filters, writes a blob's bytes as they are, and never runs add, checkout, reset, or status, so no ignore or attributes rule applies.
// These settings of the person's configuration would convert line endings or add ignore and attributes rules wherever Git still reads them, so every store command runs with them fixed instead.
// Git for Windows also refuses a path longer than Windows' old 260-character limit unless core.longpaths is on, so every store command turns it on, as a managed clone does.
// A replace ref, the commit-graph file, or a reachability bitmap could make one command read other objects, parents, or sets of objects than another, as push does,
// so every store command reads the objects themselves, and what the checks read is what a push sends.
// Every store command walks trees as deep as Git 2.43 and later allow by default, whatever the person's core.maxTreeDepth, so this machine refuses what every other machine's fetch refuses.
// A setting given with -c is read after every configuration file and variable, so it wins over the person's for that command only.
const FIXED_CONFIG = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.safecrlf=false", "-c", "core.attributesFile=", "-c", "core.excludesFile=", "-c", "core.longpaths=true",
  "-c", "core.useReplaceRefs=false", "-c", "core.commitGraph=false", "-c", "pack.useBitmaps=false", "-c", `core.maxTreeDepth=${TREE_DEPTH_MAX}`, "-c", "advice.graftFileDeprecated=false"];

/** The Git timeout that every store command, including a managed clone, runs within. */
export const gitTimeoutMs = () => SETTINGS.gitTimeoutMs;

/** Mark a store as a clone Prism made of a remote store, so a sync gives its branch an upstream on origin when it has none. */
export function markManagedStore(base) {
  managed.add(base);
}

/** Run Git in a folder with the sanitized store environment and timeout: { ok, code, missing, stdout, text, stderr }. */
export function runGit(base, args, options) {
  return git(base, args, options);
}

function git(base, args, { env = {}, input, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = execFile("git", [...FIXED_CONFIG, "-C", base, ...args], { env: gitEnvironment(env), timeout: SETTINGS.gitTimeoutMs, maxBuffer, encoding: "buffer" }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (typeof error.code === "number" ? error.code : -1) : 0, missing: error?.code === "ENOENT", stdout, text: stdout.toString("utf8").trim(), stderr: stderr.toString("utf8").trim() });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/**
 * The oldest Git whose commands and options every store sync and every first clone of a remote store use, as each command's documentation and source at that version show.
 * An older Git would fail some of them midway, so a store refuses to sync on one instead.
 */
export const GIT_MINIMUM = "2.25";
const versionChecks = new Map();

/**
 * Why this machine's Git cannot sync a store, as a sentence that names its version and the minimum; null when it can, when Git is missing, which every caller reports on its own, or when its version cannot be read.
 * The answer is kept for each PATH, so one process asks Git once.
 */
export function gitTooOld() {
  const key = process.env.PATH ?? "";
  if (!versionChecks.has(key)) {
    versionChecks.set(key, new Promise((resolve) => {
      execFile("git", ["--version"], { env: gitEnvironment(), timeout: SETTINGS.gitTimeoutMs }, (error, stdout) => {
        const found = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(error ? "" : String(stdout).trim());
        if (!found) return resolve(null);
        const [major, minor] = GIT_MINIMUM.split(".").map(Number);
        const older = Number(found[1]) < major || (Number(found[1]) === major && Number(found[2]) < minor);
        resolve(older ? `This machine has Git ${found.slice(1).filter(Boolean).join(".")}, and syncing a record store needs Git ${GIT_MINIMUM} or later, so Prism does not sync it; update Git.` : null);
      });
    }));
  }
  return versionChecks.get(key);
}

async function required(base, args, options) {
  const result = await git(base, args, options);
  if (!result.ok) throw Object.assign(new Error(result.stderr || `git ${args[0]} failed.`), { git: result });
  return result;
}

// The working-tree marker tells record reads and writes in every process that the merge step is replacing record files.
async function holderAlive(marker) {
  try {
    const owner = JSON.parse(await readFile(marker, "utf8"));
    if (Date.now() - Date.parse(owner.at) > SETTINGS.waitMs * 6) return false;
    try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  } catch (error) { return error.code !== "ENOENT"; }
}

/** Wait, at most the configured bound, while another sync's merge step replaces record files in this store. */
export async function waitForStableStore(base) {
  const marker = syncPath(base, "working-tree");
  const deadline = Date.now() + SETTINGS.waitMs;
  while (Date.now() < deadline && await holderAlive(marker)) await new Promise((resolve) => setTimeout(resolve, 25));
}

/** Debounce a sync after a record write; a sync problem never reaches the write. */
export function scheduleRecordSync(base) {
  watched.add(base);
  clearTimeout(scheduled.get(base));
  const timer = setTimeout(() => {
    scheduled.delete(base);
    if (running.has(base)) { rerun.add(base); return; }
    syncRecordStore(base).catch(() => {});
  }, SETTINGS.debounceMs);
  timer.unref();
  scheduled.set(base, timer);
}

/** Start a background sync after a record read when the last fetch is older than the pull interval; the read never waits for it. */
export function pullRecordStoreIfStale(base) {
  watched.add(base);
  if (running.has(base) || Date.now() - (lastFetch.get(base) ?? 0) < SETTINGS.pullIntervalMs) return;
  lastFetch.set(base, Date.now());
  syncRecordStore(base).catch(() => {});
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const stampTime = (stamp) => Date.parse(stamp.replace(STAMP, "$1:$2:$3.$4Z"));

// The record files a sync saved under one conflict stamp, as store-relative paths.
// A claim or a registration that lost a race is reported through its refusal, lost-claim notice, or acceptance, so the store's status shows only other saved records.
function settled(conflicts) {
  const shown = conflicts.filter((conflict) => !isQuietConflict(conflict.path));
  return { state: shown.length ? "conflicts" : "ok", conflicts: shown, message: shown.length ? "Concurrent changes to records or artifacts were resolved for the upstream; the local versions are saved." : "" };
}

async function savedFiles(directory, kept = isRecordFile) {
  const files = [];
  const visit = async (relative) => {
    let entries = [];
    try { entries = await readdir(path.join(directory, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      // A claim or a registration that lost to the upstream is reported by its own refusal, its holder's notice of a lost claim, or the next name check.
      else if (entry.isFile() && kept(child) && !isQuietConflict(child)) files.push(child);
    }
  };
  await visit("");
  return files;
}

/** Every local record version a sync saved in a store, newest first: { path, savedAs, at }, with savedAs relative to the store like a sync status names it. */
export async function listSavedConflicts(base) {
  let stamps = [];
  try { stamps = (await readdir(syncPath(base, "conflicts"))).filter((stamp) => STAMP.test(stamp)).sort().reverse(); } catch { return []; }
  const found = [];
  for (const stamp of stamps) {
    const at = new Date(stampTime(stamp)).toISOString();
    for (const file of await savedFiles(syncPath(base, "conflicts", stamp))) found.push({ path: file, savedAs: `${SYNC_DIRECTORY}/conflicts/${stamp}/${file}`, at });
  }
  return found;
}

/** The saved local copy named by a store-relative savedAs path and the record it was saved from, as text: { path, saved, current }; null for any other path. */
export async function readSavedConflict(base, savedAs) {
  const parts = typeof savedAs === "string" ? savedAs.split("/") : [];
  const file = parts.slice(3).join("/");
  if (parts[0] !== SYNC_DIRECTORY || parts[1] !== "conflicts" || !STAMP.test(parts[2] ?? "") || !isRecordFile(file) || parts.slice(3).some((part) => !part || part === "." || part === "..")) return null;
  const text = (target) => readFile(target, "utf8").catch((error) => { if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null; throw error; });
  const saved = await text(path.join(base, ...parts));
  return saved === null ? null : { path: file, saved, current: await text(path.join(base, ...file.split("/"))) };
}

/**
 * Local versions that a sync saved because the upstream changed the same record or the same lines of an artifact, or a file whose local version the sync withheld,
 * in stores this process uses, that this process has not reported before and that a sync saved since this process started or that no tool result has carried yet:
 * { record, savedAs, at } for a record, { store, location, savedAs, at } for an artifact, whose location is its path below artifacts/ in the store at store,
 * and { store, file, savedAs, at } for any other file the store shares, such as its .gitattributes.
 * A tool result that carries them confirms them with confirmSavedConflicts, which clears their pending notices.
 */
export async function takeSavedConflicts() {
  const { shareable } = await storeLayout();
  const found = [];
  for (const base of watched) {
    const directory = syncPath(base, "conflicts");
    let stamps = [];
    try { stamps = (await readdir(directory)).sort(); } catch { continue; }
    const pending = new Set(await readdir(syncPath(base, NOTICES)).catch(() => []));
    for (const stamp of stamps) {
      const at = stampTime(stamp);
      const key = `${base}\0${stamp}`;
      if (reported.has(key) || !(at >= PROCESS_START || pending.has(stamp))) continue;
      reported.add(key);
      const notice = pending.has(stamp) ? syncPath(base, NOTICES, stamp) : null;
      const items = (await savedFiles(path.join(directory, stamp), (file) => isSavedFile(file) || shareable(file))).map((file) => {
        const savedAs = path.join(directory, stamp, ...file.split("/"));
        const when = new Date(at).toISOString();
        return isArtifactFile(file) ? { store: base, location: file.slice(ARTIFACTS.length + 1), savedAs, at: when } : isRecordFile(file) ? { record: `.prism/${file}`, savedAs, at: when } : { store: base, file, savedAs, at: when };
      });
      // A stamp that holds only claims and registrations, which other results report, has nothing to carry.
      if (notice && !items.length) await rm(notice, { force: true });
      for (const item of items) { if (notice) notices.set(item, notice); reportKeys.set(item, key); found.push(item); }
    }
  }
  return found;
}

// The pending notice of each saved version that takeSavedConflicts returned, and the key that marks its stamp reported.
const notices = new WeakMap();
const reportKeys = new WeakMap();

/** Clear the pending notices of saved versions that a tool result carried, so no Prism server started later names them again. */
export async function confirmSavedConflicts(taken) {
  for (const notice of new Set((taken ?? []).map((item) => notices.get(item)).filter(Boolean))) await rm(notice, { force: true }).catch(() => {});
}

/** Give back saved versions that takeSavedConflicts returned for a tool result that was never written, so this process's next result names them and their pending notices stay. */
export function releaseSavedConflicts(taken) {
  for (const item of taken ?? []) if (reportKeys.has(item)) reported.delete(reportKeys.get(item));
}

/**
 * Sync a store now and wait for the outcome, instead of the debounced sync: after a sync that is already running, and while another process holds the store's sync lock, it waits and syncs again.
 * Options pass through to the sync.
 */
export async function syncRecordStoreNow(base, options = {}) {
  watched.add(base);
  clearTimeout(scheduled.get(base));
  scheduled.delete(base);
  const deadline = Date.now() + SETTINGS.gitTimeoutMs;
  while (true) {
    // A running sync may have committed before the caller's write, so the caller's own sync starts after it.
    while (running.has(base)) await running.get(base).catch(() => {});
    const status = await syncRecordStore(base, options);
    if (status.state !== "skipped" || Date.now() > deadline) return status;
    clearTimeout(scheduled.get(base));
    scheduled.delete(base);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The latest sync outcome of a store, or null before its first sync. */
export async function readSyncStatus(base) {
  try { return JSON.parse(await readFile(syncPath(base, "status.json"), "utf8")); }
  catch { return null; }
}

async function writeStatus(base, status) {
  const value = { at: new Date().toISOString(), state: "ok", ahead: 0, behind: 0, conflicts: [], message: "", ...status };
  value.conflicts = value.conflicts.filter((conflict) => !isQuietConflict(conflict.path));
  // Git names a remote as configured, and a configured remote can carry a token.
  value.message = withoutCredentials(value.message);
  await mkdir(syncPath(base), { recursive: true });
  await writeAtomically(syncPath(base, "status.json"), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

/**
 * Commit the store's record changes, merge its upstream, and push, holding the store-wide sync lock.
 * A process that finds the lock held skips and schedules another sync, so a change made after the holder committed is not left behind.
 * Options let tests act between steps: beforeApply runs while the working-tree marker is held, beforePush before each push.
 */
export function syncRecordStore(base, options = {}) {
  if (running.has(base)) return running.get(base);
  const pending = (async () => {
    await mkdir(syncPath(base), { recursive: true });
    try {
      return await withFileLock(syncPath(base, "sync"), () => sync(base, options), undefined, { ...syncLockOptions(), timeoutMs: 1 });
    } catch (error) {
      // The holder may have committed before this process wrote, so a later sync picks the change up.
      if (error.code === "lock_timeout") { scheduleRecordSync(base); return { state: "skipped" }; }
      // An upstream entry that no store may hold, or a path that leads outside the store, stops the merge before any file changes, so the branch stays and every sync reports it until the upstream drops it.
      if (error.unsafePath) return writeStatus(base, { state: "merge_failed", message: error.message, ...await counts(base) });
      // A Git error outside fetch, merge, and push, such as a leftover index lock, is reported as it is and never repaired here.
      return writeStatus(base, { state: "git_failed", message: error.message }).catch(() => ({ state: "git_failed", message: withoutCredentials(error.message) }));
    }
  })().finally(() => {
    running.delete(base);
    if (rerun.delete(base)) scheduleRecordSync(base);
  });
  running.set(base, pending);
  return pending;
}

async function identity(base) {
  const args = [];
  if (!(await git(base, ["config", "user.name"])).text) args.push("-c", "user.name=Prism");
  if (!(await git(base, ["config", "user.email"])).text) args.push("-c", "user.email=prism@localhost");
  return args;
}

// The modes of the entries a store shares: a regular file, executable or not, and never a symbolic link or a submodule link.
const FILE_MODES = new Set(["100644", "100755"]);
// A Git host can add a README or a license to a new repository, so a store also shares these names at its root, as plain files that Prism never reads.
const INERT_FILES = new Set(["README", "README.md", "README.txt", "LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]);
// Code points that HFS+ ignores in a name, as Git's own check of its folder's name lists them.
const IGNORED_CODE_POINTS = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;
const PROTECTED_NAMES = new Set([".git", SYNC_DIRECTORY]);

/**
 * Whether a name of a tree path leads, on some machine's file system, outside the store's files: empty or made only of dots and spaces, with a backslash or a colon as in a drive form,
 * or Git's folder or the sync folder as a file system that ignores letter case, trailing dots and spaces, and HFS+'s ignored code points reads it, or as a Windows short name such as GIT~1.
 */
function unsafeName(name) {
  if (name.includes("\\") || name.includes(":")) return true;
  const plain = name.replace(IGNORED_CODE_POINTS, "").replace(/[. ]+$/, "").toLowerCase();
  return plain === "" || PROTECTED_NAMES.has(plain) || /^[^.]{1,6}~[0-9]+$/.test(plain);
}

// The record store module, which owns the store's layout, imports this one, so it loads when a sync first needs that layout.
let layout;
const storeLayout = () => layout ??= import("./record-store.mjs").then(({ isStoreFile, isStoreFolder }) => {
  const shareable = (file) => isStoreFile(file) || INERT_FILES.has(file);
  /**
   * How a store treats a tree entry: "shared" for a regular file at a path Prism writes, or a README or license at the root, which every sync writes to disk and commits;
   * "unsafe" for a link, a path that leads outside the store's files on some machine, a path with a name that some supported machine cannot hold, which Git for Windows refuses even in its index,
   * a path that is not UTF-8, which macOS and Windows cannot hold either, a path Prism shares that is too long for some machine to write,
   * a path with a name that Git reads as .gitattributes or .gitmodules, other than the file .gitattributes at the root, which Git checks in ways older Git does not (see gitFileName),
   * or an entry where Prism keeps a folder, or below a file Prism keeps outside artifacts/, which would clash with Prism's own files;
   * and "carried" for any other regular file, such as a .DS_Store that an earlier Prism committed, which stays in Git only.
   */
  const kind = (file, { mode, notUtf8 }) => {
    if (!FILE_MODES.has(mode) || notUtf8 || file.split("/").some((name) => unsafeName(name) || !portableName(name) || (file !== ".gitattributes" && gitFileName(bytesOfPath(name))))) return "unsafe";
    if (shareable(file)) return storePathFits(file) ? "shared" : "unsafe";
    if (isStoreFolder(file) || folders(file).some((folder) => !isArtifactFile(folder) && shareable(folder))) return "unsafe";
    return "carried";
  };
  return { shareable, isStoreFolder, kind };
});

// The entries of a tree split into the ones a store shares and every other one.
async function partition(files) {
  const { kind } = await storeLayout();
  const shared = new Map();
  const other = new Map();
  for (const [file, entry] of files) (kind(file, entry) === "shared" ? shared : other).set(file, entry);
  return { shared, other };
}

/**
 * A tree's shared entries with the other entries carried beside them, as Map(path, entry).
 * One tree never holds a file and a folder at one path, so a carried entry at, above, or below a shared file gives way to it: a file Prism writes always keeps its place.
 */
function besides(shared, other) {
  const result = new Map(shared);
  const places = new Set([...shared.keys()].flatMap(folders));
  for (const [file, entry] of other) {
    if (!shared.has(file) && !places.has(file) && !folders(file).some((folder) => shared.has(folder))) result.set(file, entry);
  }
  return result;
}

const sameFiles = (left, right) => left.size === right.size && [...left].every(([file, entry]) => sameEntry(right.get(file), entry));

// Write a tree of these entries through an index of the sync's own, so the store's index and files play no part: the tree's id.
async function writeTree(base, entries) {
  const index = syncPath(base, "tree-index");
  const env = { GIT_INDEX_FILE: index };
  await rm(index, { force: true });
  try {
    await required(base, ["read-tree", "--empty"], { env });
    const input = Buffer.concat([...entries].flatMap(([file, entry]) => [Buffer.from(`${entry.mode} ${entry.object}\t`), bytesOfPath(file), Buffer.from([0])]));
    if (input.length) await required(base, ["update-index", "-z", "--index-info"], { env, input });
    return (await required(base, ["write-tree"], { env })).text;
  } finally {
    await rm(index, { force: true });
  }
}

// Point the branch at a commit made from the commit it held, and the store's index at that commit's tree, without touching any file.
// The index takes the tree first, so a tree that this machine's Git refuses in an index never becomes the branch's.
async function moveBranch(base, commit, previous, message) {
  await required(base, ["read-tree", commit]);
  await required(base, ["update-ref", "-m", message, "HEAD", commit, previous ?? ""]).catch(async (error) => {
    await git(base, previous ? ["read-tree", previous] : ["read-tree", "--empty"]);
    throw error;
  });
}

// The sync folder's record that a clone's files hold their blobs' bytes, which the line-ending migration writes once it has run.
const RAW_FILES = "raw-files.json";
const migrated = new Set();
const syncLockOptions = () => ({ renew: true, abandonWhenUnrenewed: true, staleMs: SETTINGS.gitTimeoutMs * 2 });

/**
 * Prepare a store's files for syncing, once per clone, before any Prism write in this process reaches them: an earlier Prism checked a first clone's files out through Git's line-ending conversion,
 * so every file it has not rewritten since may hold its blob's text with each line ending in CR LF instead.
 * Each file at a path the store shares whose bytes differ from the branch's blob only in that way is rewritten with the blob's bytes, and the sync folder records that the clone is migrated,
 * so every later sync commits a file's bytes exactly as they are, a Prism write that changes only line endings among them, and no old clone pushes a CR LF copy of every file.
 * It holds the store's sync lock, so no sync moves the branch or replaces a file meanwhile; a store that is no Git checkout is left as it is.
 */
export async function prepareStoreFiles(base) {
  if (migrated.has(base) || await rawFilesRecorded(base)) return;
  await mkdir(syncPath(base), { recursive: true });
  await withFileLock(syncPath(base, "sync"), () => migrateLineEndings(base), undefined, { ...syncLockOptions(), timeoutMs: SETTINGS.gitTimeoutMs });
}

async function rawFilesRecorded(base) {
  if (await fileBytes(syncPath(base, RAW_FILES)) === null) return false;
  migrated.add(base);
  return true;
}

// Whether a file's bytes are the blob's text with each LF read as CR LF, the only change Git's line-ending conversion makes on checkout.
const lineEndingEcho = (bytes, blobBytes) => !blobBytes.includes(13) && bytes.includes(13) && bytes.toString("latin1").replaceAll("\r\n", "\n") === blobBytes.toString("latin1");

// The migration itself, run while the store's sync lock is held.
async function migrateLineEndings(base) {
  if (migrated.has(base) || await rawFilesRecorded(base)) return;
  const top = await git(base, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || path.resolve(top.text) !== path.resolve(base)) return;
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const { shared } = await partition(await treeFiles(base, head.ok ? head.text : null));
  const found = [];
  for (const [file, entry] of shared) if ((await lstat(path.join(base, ...file.split("/"))).catch(() => null))?.isFile()) found.push([file, entry]);
  const hashed = found.length ? await required(base, ["hash-object", "--no-filters", "--stdin-paths"], { input: `${found.map(([file]) => file).join("\n")}\n` }) : { text: "" };
  const objects = hashed.text ? hashed.text.split("\n") : [];
  const echoes = [];
  for (const [index, [file, entry]] of found.entries()) {
    if (objects[index] === entry.object) continue;
    const target = path.join(base, ...file.split("/"));
    const [bytes, blobBytes] = await Promise.all([fileBytes(target), entryBytes(base, entry)]);
    if (bytes && blobBytes && lineEndingEcho(bytes, blobBytes)) echoes.push({ file, target, blobBytes });
  }
  // Each file is rewritten under the lock that a write of it takes, and only while it still holds the converted copy.
  const rewrite = async ({ target, blobBytes }) => {
    const bytes = await fileBytes(target);
    if (bytes && lineEndingEcho(bytes, blobBytes)) await writeAtomically(target, blobBytes);
  };
  const artifacts = echoes.filter(({ file }) => isGuardedFile(file));
  if (artifacts.length) await holdLocks([path.join(base, ARTIFACTS)], async () => { for (const echo of artifacts) await rewrite(echo); });
  for (const echo of echoes.filter(({ file }) => !isGuardedFile(file))) await holdLocks([echo.target], () => rewrite(echo));
  await writeAtomically(syncPath(base, RAW_FILES), `${JSON.stringify({ at: new Date().toISOString() })}\n`);
  migrated.add(base);
}

/**
 * The store's files at the paths it shares, as Map(path, { mode, object }), each hashed from its bytes exactly as they are, so no ignore or attributes rule decides what is committed or how.
 * Only regular files count, found without following a symbolic link, and with artifacts false the branch's artifacts stand in for the ones on disk.
 * A file keeps the mode the branch gives it, and a new one is a plain file, so a file system without an executable bit changes no mode.
 */
async function localFiles(base, artifacts, held, withheld) {
  const { shareable, isStoreFolder } = await storeLayout();
  for (let attempt = 1; ; attempt++) {
    const found = [];
    const visit = async (relative) => {
      let entries = [];
      try { entries = await readdir(relative ? path.join(base, ...relative.split("/")) : base, { withFileTypes: true }); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return; throw error; }
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        // A file whose path some machine cannot write stays out of every commit, and the sync's status names it.
        if (entry.isFile()) { if (shareable(child) && (artifacts || !isGuardedFile(child))) (storePathFits(child) ? found.push(child) : withheld.set(child, TOO_LONG)); }
        else if (entry.isDirectory() && isStoreFolder(child) && (artifacts || (child !== ARTIFACTS && !STATUS_FOLDERS.includes(child)))) await visit(child);
      }
    };
    await visit("");
    found.sort();
    const hashed = found.length ? await git(base, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: `${found.join("\n")}\n` }) : { ok: true, text: "" };
    const objects = hashed.text ? hashed.text.split("\n") : [];
    // A record removed or replaced between the listing and the hashing makes the hashing fail, so the listing is taken again.
    if (!hashed.ok || objects.length !== found.length) {
      if (attempt < 3) continue;
      throw Object.assign(new Error(hashed.stderr || "git hash-object failed."), { git: hashed });
    }
    const files = new Map();
    for (const [index, file] of found.entries()) files.set(file, { mode: held.get(file)?.mode ?? "100644", object: objects[index] });
    if (!artifacts) for (const [file, entry] of held) if (isGuardedFile(file)) files.set(file, entry);
    return files;
  }
}

// Why a sync leaves a file out of its commits, as its status names it.
const TOO_LONG = `its name holds more than ${STORE_NAME_BYTES_MAX} bytes or its path more than ${STORE_PATH_BYTES_MAX}, so some machine could not write it`;

/**
 * Commit the store's changes; run is one sync's state, whose artifacts is false once an update held the artifact lock when this sync came to read the artifacts,
 * and whose withheld maps each file this commit left out to why: a path too long for some machine, or a file whose object Git's object check refuses, which keeps the branch's version.
 * An artifact update holds the store's artifact lock from its version checks to its last write, so reading the artifacts under that lock never commits part of an update.
 * An update in progress is left to a later sync, which its own write schedules, for the rest of this sync, so this sync never merges the upstream over a change the update is still making:
 * the first commit tries the lock once, and a later commit waits for it as long as a merge does.
 * The commit holds the shared files as the store holds them and every other entry as the branch holds it, so no local commit adds, changes, or removes a file Prism does not write.
 */
async function commitLocal(base, author, run) {
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const previous = head.ok ? head.text : null;
  const branch = await treeFiles(base, previous);
  const { shared, other } = await partition(branch);
  const withheld = new Map();
  run.withheld = withheld;
  // The local version of each file withheld because Git's object check refuses it, which a merge that replaces the file saves.
  run.heldBack = new Map();
  let files = null;
  if (run.artifacts !== false) {
    files = await withFileLock(path.join(base, ARTIFACTS), () => localFiles(base, true, shared, withheld), undefined, { timeoutMs: run.artifacts ? SETTINGS.applyLockMs : 1 })
      .catch((error) => { if (error.code !== "lock_timeout") throw error; return null; });
    run.artifacts = files !== null;
    if (!files) scheduleRecordSync(base);
  }
  if (run.artifacts === false) files = await localFiles(base, false, shared, withheld);
  for (;;) {
    const entries = besides(files, other);
    if (sameFiles(entries, branch)) return false;
    const changed = [...new Set([...branch.keys(), ...entries.keys()])].filter((file) => !sameEntry(branch.get(file), entries.get(file))).sort();
    const listed = changed.slice(0, COMMIT_LIST).join("\n") + (changed.length > COMMIT_LIST ? `\n… and ${changed.length - COMMIT_LIST} more` : "");
    const tree = await writeTree(base, entries);
    const commit = (await required(base, [...author, "commit-tree", tree, ...(previous ? ["-p", previous] : []), "-m", "prism: update records", "-m", listed])).text;
    // The objects a commit adds pass the check that every other machine's fetch applies before the branch takes them, so the branch's history never holds one that no other machine could fetch.
    const refused = await refusedObjects(base, commit, previous ? [previous] : [], { pushing: false });
    if (refused) {
      const culprits = changed.filter((file) => files.has(file) && refused.objects.includes(files.get(file).object) && (refused.places.get(files.get(file).object)?.includes(file) ?? true));
      if (!culprits.length) throw new Error(`Git's object check, which every other machine's fetch applies, refuses the store's new commit, so it was not made: ${refused.message}`);
      for (const file of culprits) {
        withheld.set(file, `Git's object check, which every other machine's fetch applies, refuses it (${refused.message})`);
        run.heldBack.set(file, files.get(file));
        if (shared.has(file)) files.set(file, shared.get(file)); else files.delete(file);
      }
      continue;
    }
    await moveBranch(base, commit, previous, "prism: update records");
    return true;
  }
}

/**
 * The objects that a commit holds and the known commits do not, checked as strictly as a fetch with fetch.fsckObjects, or a clone with transfer.fsckObjects, checks what it receives:
 * null when Git accepts them, else { message, objects, places } with Git's reasons, the objects they name, and where the new trees hold them.
 * Git's own rules for commits and trees run first, as git-objects.mjs ports them, so the check never depends on how much this machine's Git checks: see refusedHistory.
 * The objects are then packed into the sync folder and indexed there with index-pack --strict, which every such fetch and clone runs, so a refusal here is one that another machine would meet.
 * The pack leaves out blobs, which the store already holds: the check reads every blob it inspects by name, such as a .gitattributes, from the store, and checks no other blob's content.
 * Git before 2.43 packs with a filter only to standard output, so the pack reaches its file from there.
 * A local commit passes pushing false, since it adds only files the store shares, which carry no name Git reads as .gitattributes or .gitmodules and are no links,
 * and the push of a branch that holds such an entry is refused.
 */
async function refusedObjects(base, tip, known, { pushing = true } = {}) {
  const folder = syncPath(base, "object-check");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  try {
    const revisions = `${tip}\n${known.map((commit) => `^${commit}\n`).join("")}`;
    const history = await refusedHistory(base, revisions, pushing);
    if (history.reasons.length) return refusal(history.reasons, history.places);
    const pack = (await required(base, ["pack-objects", "--revs", "--stdout", "--quiet", "--filter=blob:none"], { input: revisions, maxBuffer: PACK_BYTES_MAX })).stdout;
    await writeFile(path.join(folder, "objects.pack"), pack);
    const checked = await git(base, ["index-pack", "--strict", "-o", path.join(folder, "objects.idx"), path.join(folder, "objects.pack")]);
    if (checked.ok) return null;
    const reasons = checked.stderr.split("\n").filter((line) => line.startsWith("error: ")).map((line) => line.slice("error: ".length));
    return refusal(reasons.length ? reasons : [checked.stderr]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

// A filtered pack holds only commits and trees, so even a store of long history packs within this bound.
const PACK_BYTES_MAX = 1024 * 1024 * 1024;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// A refusal: Git's reasons, the objects they name, and, where the check knows them, the paths at which the new trees hold each refused object, as Map(object, [path]).
const refusal = (reasons, places = new Map()) => {
  const message = reasons.join("; ");
  return { message, objects: [...message.matchAll(/\b[0-9a-f]{40}(?:[0-9a-f]{24})?\b/g)].map((match) => match[0]), places };
};

// The limits Git 2.43's object check sets for a .gitattributes: a line, without its line feed, shorter than 2048 bytes, and a file of at most 100 MiB (attr.h).
const ATTRIBUTES_LINE_MAX = 2048;
const ATTRIBUTES_BYTES_MAX = 100 * 1024 * 1024;

/**
 * What the commits and trees new to the known commits hold that some supported Git's checked fetch refuses, in the words of Git's object check: { reasons, places }.
 * Every commit and every tree is checked by Git's own rules as git-objects.mjs ports them, whatever this machine's Git checks,
 * and, when pushing is true, every link those trees hold by the target rules of the Git releases that checked targets.
 * A .gitattributes is refused when it is no blob or is missing, is over 100 MiB, or has a line of 2048 bytes or more before its first zero byte, whether its blob is new or already in the store's history.
 * Only a regular file named exactly .gitattributes in a commit's root tree is read so; when pushing is true, every other entry with a name that gitFileName matches,
 * such as a folder named .gitattributes, a link, a .gitmodules, or one in a folder, is a reason too, so no Git that checks less than 2.43 lets such a history be pushed.
 */
async function refusedHistory(base, revisions, pushing) {
  const listed = await git(base, ["rev-list", "--objects", "--stdin"], { input: revisions, maxBuffer: PACK_BYTES_MAX });
  // Git 2.43 and later stop the walk at a tree deeper than core.maxTreeDepth, which every store command sets to Git's default, as every other machine's fetch would.
  if (!listed.ok && listed.stderr.includes(TREE_DEPTH_TEXT)) return { reasons: [deepTreeReason()], places: new Map() };
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || "git rev-list failed."), { git: listed });
  const output = listed.stdout;
  // Each line is an object id, followed for a tree or a blob by a space and the path it was first found at.
  const where = new Map();
  for (let at = 0; at < output.length;) {
    const end = output.indexOf(10, at) < 0 ? output.length : output.indexOf(10, at);
    const line = output.subarray(at, end);
    const space = line.indexOf(32);
    const object = (space < 0 ? line : line.subarray(0, space)).toString("latin1");
    if (OBJECT_ID.test(object)) where.set(object, space < 0 ? "" : pathOfBytes(line.subarray(space + 1)));
    at = end + 1;
  }
  const none = { reasons: [], places: new Map() };
  if (!where.size) return none;
  const types = await objectInfo(base, [...where.keys()]);
  const trees = [...where.keys()].filter((object) => types.get(object)?.type === "tree");
  const roots = new Set();
  const reasons = [];
  const places = new Map();
  const place = (tree, name) => where.get(tree) ? `${where.get(tree)}/${name}` : name;
  const refuse = (object, reason, at = []) => { reasons.push(`object ${object}: ${reason}`); if (at.length) places.set(object, [...(places.get(object) ?? []), ...at]); };
  for (const [commit, contents] of await objectContents(base, [...where.keys()].filter((object) => types.get(object)?.type === "commit"))) {
    const problem = commitProblem(contents, commit.length);
    if (problem) refuse(commit, `${problem.id}: ${problem.text}`);
    const tree = /^tree ([0-9a-f]+)\n/.exec(contents.toString("latin1"))?.[1];
    if (tree) roots.add(tree);
  }
  const found = new Map();
  const misnamed = new Map();
  const links = new Map();
  const treeContents = await objectContents(base, trees);
  // Git before 2.43 walks a tree of any depth, so the depth that later releases allow is checked here too.
  const deep = tooDeepTree(roots, treeContents);
  if (deep) {
    const shown = deep.names.slice(0, 3).map(pathOfBytes).join("/");
    refuse(deep.root, deepTreeReason(), [`${shown}/…`]);
  }
  for (const [tree, contents] of treeContents) {
    const size = tree.length / 2;
    for (const problem of treeProblems(contents, size)) {
      // A name too long for Git is shown by its first characters only.
      const shown = problem.names.map((name) => name.length > STORE_NAME_BYTES_MAX ? `${pathOfBytes(name.subarray(0, 64))}…` : pathOfBytes(name));
      refuse(tree, `${problem.id}: ${problem.text}`, shown.length ? [...new Set(shown)].map((name) => place(tree, name)) : [where.get(tree) || "/"]);
    }
    for (const entry of treeEntries(contents, size)) {
      const name = pathOfBytes(entry.name);
      if (pushing && isLinkMode(entry.mode)) links.set(entry.object, [...(links.get(entry.object) ?? []), place(tree, name)]);
      if (gitFileName(entry.name)) {
        if (roots.has(tree) && name === ".gitattributes" && FILE_MODES.has(entry.modeText)) found.set(entry.object, [...(found.get(entry.object) ?? []), ".gitattributes"]);
        else if (pushing) misnamed.set(tree, [...(misnamed.get(tree) ?? []), place(tree, name)]);
      }
    }
  }
  for (const [tree, at] of misnamed) refuse(tree, `${at.map(shownPath).join(", ")}: a name that Git reads as .gitattributes or .gitmodules, which a store holds only as the file .gitattributes at its root`, at);
  const blobs = found.size || links.size ? await objectInfo(base, [...found.keys(), ...links.keys()]) : new Map();
  const readable = [];
  for (const object of found.keys()) {
    const info = blobs.get(object);
    if (!info) refuse(object, "gitattributesMissing: unable to read .gitattributes blob", found.get(object));
    else if (info.type !== "blob") refuse(object, "gitattributesBlob: non-blob found at .gitattributes", found.get(object));
    else if (info.size > ATTRIBUTES_BYTES_MAX) refuse(object, "gitattributesLarge: .gitattributes too large to parse", found.get(object));
    else readable.push(object);
  }
  for (const [object, contents] of await objectContents(base, readable)) {
    const text = contents.includes(0) ? contents.subarray(0, contents.indexOf(0)) : contents;
    for (let at = 0; at < text.length;) {
      const end = text.indexOf(10, at) < 0 ? text.length : text.indexOf(10, at);
      if (end - at >= ATTRIBUTES_LINE_MAX) { refuse(object, "gitattributesLineLength: .gitattributes has too long lines to parse", found.get(object)); break; }
      at = end + 1;
    }
  }
  // Git 2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, 2.44.1, and 2.45.1 check the target of every link a tree they receive holds, though a store shares no link.
  const targets = [];
  for (const [object, at] of links) {
    const info = blobs.get(object);
    if (!info) refuse(object, "symlinkTargetMissing: unable to read <symlink-target> blob", at);
    else if (info.type !== "blob") refuse(object, "symlinkTargetBlob: non-blob found at <symlink-target>", at);
    else if (info.size > LINK_TARGET_BYTES_MAX) refuse(object, "symlinkTargetLength: symlink target too long", at);
    else targets.push(object);
  }
  for (const [object, contents] of await objectContents(base, targets)) {
    const problem = linkTargetProblem(contents);
    if (problem) refuse(object, `${problem.id}: ${problem.text}`, links.get(object));
  }
  return { reasons, places };
}

// The reason a history whose trees nest deeper than Git 2.43 and later walk is refused, in Git's words.
const deepTreeReason = () => `maxTreeDepth: ${TREE_DEPTH_TEXT}, since a folder is nested more than ${TREE_DEPTH_MAX} folders deep`;

// The type and size of each object the store holds: Map(object, { type, size }), without the ones it lacks.
async function objectInfo(base, objects) {
  const info = new Map();
  const output = (await required(base, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: `${objects.join("\n")}\n` })).text;
  for (const line of output.split("\n")) {
    const [object, type, size] = line.split(" ");
    if (size !== undefined && type !== "missing") info.set(object, { type, size: Number(size) });
  }
  return info;
}

// The contents of objects the store holds, as Map(object, bytes), read in one Git process.
async function objectContents(base, objects) {
  const contents = new Map();
  if (!objects.length) return contents;
  const output = (await required(base, ["cat-file", "--batch"], { input: `${objects.join("\n")}\n`, maxBuffer: PACK_BYTES_MAX })).stdout;
  for (let at = 0; at < output.length;) {
    const header = output.indexOf(10, at);
    if (header < 0) break;
    const [object, type, size] = output.subarray(at, header).toString("latin1").split(" ");
    if (type === "missing" || size === undefined) { at = header + 1; continue; }
    contents.set(object, output.subarray(header + 1, header + 1 + Number(size)));
    at = header + 1 + Number(size) + 1;
  }
  return contents;
}

/**
 * Give the branch, which holds every commit of its upstream, the upstream's entries that a store does not share, so a push never adds, changes, or removes one on the remote,
 * as when a commit that an earlier Prism made, or one made by hand, holds a file Prism does not write; with no upstream branch yet, the branch keeps none of them.
 */
async function alignWithUpstream(base, author, head, theirs) {
  const [mine, upstream] = await Promise.all([treeFiles(base, head), treeFiles(base, theirs)]);
  const entries = besides((await partition(mine)).shared, (await partition(upstream)).other);
  if (sameFiles(entries, mine)) return;
  const commit = (await required(base, [...author, "commit-tree", await writeTree(base, entries), "-p", head, "-m", "prism: keep the remote's files that Prism does not write"])).text;
  await moveBranch(base, commit, head, "prism: sync records");
}

async function upstreamOf(base) {
  const branch = (await git(base, ["symbolic-ref", "--quiet", "--short", "HEAD"])).text;
  if (!branch) return null;
  const remote = (await git(base, ["config", `branch.${branch}.remote`])).text;
  const merge = (await git(base, ["config", `branch.${branch}.merge`])).text;
  return remote && merge ? { branch, remote, merge } : null;
}

async function counts(base) {
  const result = await git(base, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  const [ahead, behind] = result.ok ? result.text.split(/\s+/).map(Number) : [0, 0];
  return { ahead: ahead || 0, behind: behind || 0 };
}

// A branch whose upstream names a branch the remote does not have yet, as a clone of an empty remote has, counts nothing ahead but still has commits to push.
async function unpublished(base) {
  return !(await git(base, ["rev-parse", "--verify", "--quiet", "@{upstream}"])).ok && (await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
}

// For a remote reached by a path or a file:// URL, Git runs receive-pack for a push, and upload-pack for a fetch or a clone, on this machine inside the remote repository with that repository's configuration,
// and starts them without any -c setting, so a hook, a core.hooksPath, or a core.alternateRefsCommand that the remote's own files name would run here as this user,
// as would the automatic maintenance receive-pack starts after a push, whose children read programs such as gc.recentObjectsHook from that configuration,
// and a filter or core.fsmonitor command when receive.denyCurrentBranch=updateInstead makes a push check out the remote's branch.
// Every store command that reaches such a remote names the helper instead: Git reading hooks from an empty folder Prism owns, with a push to a checked-out branch refused,
// no automatic maintenance, every hook event turned off for the hooks that hook.<name> settings configure (Git 2.54 and later), each of those hooks the remote's configuration names turned off by name,
// and an alternate refs command that lists nothing, since an empty one makes every push's connectivity check print that it cannot run it.
// A -c setting reaches the helper's own children too, since Git passes it on to every Git command it starts.
// An SSH server or a Git daemon takes that command as the service to run and refuses it, and HTTP ignores it, so only a local transport gets it.
// The command names such a remote by the path of the repository Git enters for its URL, and the helper enters that same repository whatever path Git hands it, so the hook names come from the repository that the helper opens.
// A remote.<name>.uploadpack or remote.<name>.receivepack that the person set is a transport setting of theirs, so it runs as they set it.
const NO_HOOKS = "no-hooks";
// Every hook event that Git's documentation lists, so no event the helper or a command it starts runs has a configured hook left on.
const HOOK_EVENTS = ["applypatch-msg", "commit-msg", "fsmonitor-watchman", "post-applypatch", "post-checkout", "post-commit", "post-index-change", "post-merge", "post-receive", "post-rewrite",
  "post-update", "pre-applypatch", "pre-auto-gc", "pre-commit", "pre-merge-commit", "pre-push", "pre-rebase", "pre-receive", "prepare-commit-msg", "proc-receive", "push-to-checkout",
  "receive-report", "reference-transaction", "sendemail-validate", "update"];
const REMOTE_HELPER_CONFIG = ["core.alternateRefsCommand=exit 0;", "core.alternateRefsPrefixes=", "receive.denyCurrentBranch=refuse", "core.fsmonitor=",
  "receive.autogc=false", "gc.auto=0", "gc.autoPackLimit=0", "maintenance.auto=false", ...HOOK_EVENTS.map((event) => `hook.${event}.enabled=false`)];
const shellQuoted = (text) => `'${text.replaceAll("'", "'\\''")}'`;
// Git starts a local transport's helper through the shell as one command line, the helper's text, a space, and the path Git reached quoted for the shell
// (connect.c's git_connect and run-command.c's prepare_shell_cmd, from Git 2.25 through the current release and in Git for Windows).
// So the helper is a shell function that runs Git's helper in the repository its own text names, and the path Git appends is only the function's argument, which it ignores:
// no url.<base>.insteadOf or url.<base>.pushInsteadOf rule, and no other rewrite of the path, changes the repository that the helper enters.
const PINNED_HELPER = "prism_pinned_helper";
const UTF8_EXACT = new TextDecoder("utf-8", { fatal: true });

// Whether Git reaches a remote URL by its local transport, by Git's own rules in transport.c and connect.c.
export { localTransport };

// The empty folder every remote-side helper reads hooks from, in Prism's application folder; Git for Windows' shell reads its path with forward slashes.
async function noHooksFolder() {
  const folder = path.join(reviewAppDirectory(), NO_HOOKS);
  try { await mkdir(folder, { recursive: true, mode: 0o700 }); }
  catch (error) { throw new Error(`Prism could not create the empty hooks folder ${folder} that a sync with a local remote needs: ${error.message}`); }
  return process.platform === "win32" ? folder.replaceAll("\\", "/") : folder;
}

/**
 * The names of the hooks that hook.<name> settings configure for the Git directory a remote-side helper enters, read as receive-pack reads them there.
 * Git 2.55 turns off a hook event by its name only while no hook.<event>.command or hook.<event>.parallel makes that name a hook's, and Git 2.54 has no event switch, so each named hook is also turned off by name.
 */
async function configuredHooks(repository) {
  // Git exits with 1 when no key matches.
  const listed = await git(repository, [`--git-dir=${repository}`, "config", "--null", "--get-regexp", "^hook\\."]);
  const names = new Set();
  for (const entry of listed.ok ? listed.stdout.toString("latin1").split("\0") : []) {
    const key = Buffer.from(entry.split("\n", 1)[0], "latin1");
    let text;
    // A -c setting is passed as UTF-8 text, so a hook whose name is not UTF-8 cannot be turned off by name.
    try { text = UTF8_EXACT.decode(key); }
    catch { throw new Error("The remote store's Git configuration sets up a hook whose name is not UTF-8, which Prism cannot turn off, so it does not sync with that remote. Remove that hook's settings from the remote repository's configuration."); }
    const match = /^hook\.(.+)\.(command|event|parallel)$/i.exec(text);
    if (match) names.add(match[1]);
  }
  return [...names];
}

/**
 * Refuse a repository path that one of the person's url.<base>.insteadOf rules, or for a push url.<base>.pushInsteadOf rules, would rewrite when Git reads it from the command line, as remote.c's alias_url does for any URL, from a folder.
 * Git would then reach another place than the repository whose hook names were read, by another transport too, so Prism does not use that path.
 */
async function refuseRewrite(option, repository, base) {
  const listed = await git(base, ["config", "--null", "--get-regexp", "^url\\..*\\.(push)?insteadof$"]);
  if (!listed.ok) return;
  const bytes = Buffer.from(repository);
  for (const entry of listed.stdout.toString("latin1").split("\0")) {
    const split = entry.indexOf("\n");
    if (split < 0) continue;
    const kind = entry.slice(0, split).endsWith(".pushinsteadof") ? "pushInsteadOf" : "insteadOf";
    if (kind === "pushInsteadOf" && option !== "--receive-pack") continue;
    const prefix = Buffer.from(entry.slice(split + 1), "latin1");
    if (bytes.subarray(0, prefix.length).equals(prefix)) {
      throw new Error(`A url.<base>.${kind} rule in Git's configuration matches ${repository}, the repository that the store's local remote reaches, so Git would reach another place for that path than the repository Prism checked, and Prism does not sync with that remote. Change the rule so that it no longer matches that path.`);
    }
  }
}

/**
 * The options that name the remote-side helper, --upload-pack or --receive-pack, for the Git directory it enters, by the absolute path that localRepository found and Git takes on its command line, run from a folder.
 * The helper runs Git's helper in that repository whatever path Git hands it, and each setting is quoted for the shell.
 */
export async function helperForRepository(option, repository, base) {
  const program = option === "--receive-pack" ? "receive-pack" : "upload-pack";
  await refuseRewrite(option, repository, base);
  const named = await configuredHooks(repository);
  // A -c setting splits its key from its value at the first equals sign, so a hook whose name holds one cannot be turned off by name.
  const unnamed = named.find((name) => name.includes("="));
  if (unnamed !== undefined) throw new Error(`The remote store's Git configuration sets up a hook named "${unnamed}", which Prism cannot turn off, so it does not sync with that remote. Remove the hook.${unnamed}.* settings from the remote repository's configuration.`);
  const settings = [`core.hooksPath=${await noHooksFolder()}`, ...REMOTE_HELPER_CONFIG, ...named.map((name) => `hook.${name}.enabled=false`)].map((setting) => `-c ${shellQuoted(setting)}`);
  const command = `git ${settings.join(" ")} ${program} ${shellQuoted(repository)}`;
  // receive-pack checks a signed push's certificate with the gpg program the remote's configuration names, and only the remote's hooks, which never run, read the result, so a push sends none.
  return [`${option}=${PINNED_HELPER}() { exec ${command}; }; ${PINNED_HELPER}`, ...(program === "receive-pack" ? ["--no-signed"] : [])];
}

/**
 * The repository that Git enters for a remote URL from a folder, as localRepository finds it: null for another transport, { path }, or { stops: true } when Git finds none.
 * A local URL whose repository Prism cannot find the way Git does is refused with a message that names it.
 */
export async function localRemoteRepository(url, base) {
  try { return await localRepository(url, base); }
  catch (error) {
    if (!(error instanceof UnresolvableLocalRemote)) throw error;
    throw new Error(`Prism cannot tell which repository Git opens for the local remote ${withoutCredentials(url)}, because ${error.message}, so it does not use that remote. ${error.hint ?? "Name the remote repository by its absolute path or by a file:// URL of that path."}`);
  }
}

/** Why a sync neither fetches from nor pushes to a local remote URL at which Git finds no repository, so no helper ever starts there. */
export const noLocalRepository = (url) => `No Git repository is found at the local remote ${withoutCredentials(url)}, so Prism neither fetched from it nor pushed to it.`;

/**
 * The URLs that Git printed, one per line, as text when they are UTF-8; a local path that is not, which Node would read as another path, is refused.
 */
export function gitUrlText(result) {
  const bytes = result.stdout.subarray(0, result.stdout.length - (result.stdout.at(-1) === 0x0a ? 1 : 0));
  try { return UTF8_EXACT.decode(bytes); }
  catch {
    if (!bytes.toString("latin1").split("\n").some((url) => localTransport(url))) return result.text;
    throw new Error("The store's remote URL is a local path that is not UTF-8, so Prism cannot tell which repository Git opens for it and does not use that remote. Rename the folders on the way to the remote repository so that every name is UTF-8.");
  }
}

/**
 * The options that name the remote-side helper, --upload-pack or --receive-pack, of a fetch, clone, or push from a folder whose remote Git reaches at any of these URLs by its local transport; none for any other remote.
 * The hook names come from the one repository that Git enters for those URLs, and a local URL at which Git finds none, or URLs that reach two repositories, are refused.
 */
export async function remoteHelperOption(option, urls, base = process.cwd()) {
  const found = await Promise.all(urls.map((url) => localRemoteRepository(url, base)));
  if (found.every((entry) => entry === null)) return [];
  const missing = urls.find((url, at) => found[at]?.stops);
  if (missing !== undefined) throw new Error(noLocalRepository(missing));
  const paths = [...new Set(found.filter((entry) => entry?.path).map((entry) => entry.path))];
  if (paths.length > 1) throw new Error(`The URLs ${urls.map(withoutCredentials).join(", ")} reach more than one local repository, and a helper enters only one.`);
  return helperForRepository(option, paths[0], base);
}

/**
 * What a fetch or a push of a remote names on its command line: { targets }, one { target, helper } for each repository it reaches, or { missing } with why it reaches none.
 * A remote that Git reaches by its local transport is named by the absolute path of the repository Git enters for it, and its helper enters that repository whatever path Git hands it, so the helper's hook names are read from the very repository the fetch or push opens,
 * and the person's remote, URLs, url.<base>.insteadOf, and url.<base>.pushInsteadOf settings stay as they are, since only the command line changes.
 * A local URL at which Git finds no repository is neither fetched nor pushed, so no helper starts anywhere for it.
 * Any other remote, and one whose remote.<name>.uploadpack, remote.<name>.receivepack, or remote.<name>.vcs the person set, is named as it is.
 */
async function remoteTargets(base, remote, option) {
  const asIs = { targets: [{ target: remote, helper: [] }] };
  const key = option === "--receive-pack" ? "receivepack" : "uploadpack";
  for (const setting of [key, "vcs"]) if ((await git(base, ["config", "--get", `remote.${remote}.${setting}`])).ok) return asIs;
  const urls = option === "--receive-pack" ? await pushUrls(base, remote) : [await fetchUrl(base, remote)];
  const found = await Promise.all(urls.map((url) => localRemoteRepository(url, base)));
  if (found.every((entry) => entry === null)) return asIs;
  const missing = urls.find((url, at) => found[at]?.stops);
  if (missing !== undefined) return { missing: noLocalRepository(missing) };
  const other = urls.find((url, at) => !found[at]?.path);
  if (other !== undefined) throw new Error(`A push to the remote ${remote} reaches ${withoutCredentials(other)} as well as a local repository, and Prism names a local repository by its own path, so it does not push to that remote. Give each repository a remote of its own.`);
  const paths = [...new Set(found.map((entry) => entry.path))];
  // Every helper is built, and every hook name checked, before any repository is fetched or pushed.
  const helpers = await Promise.all(paths.map((target) => helperForRepository(option, target, base)));
  return { targets: paths.map((target, at) => ({ target, helper: helpers[at] })) };
}

// The URL a fetch reaches, after url.<base>.insteadOf, for a configured remote or a URL.
async function fetchUrl(base, remote) {
  const url = await git(base, ["ls-remote", "--get-url", remote]);
  return url.ok && url.text ? gitUrlText(url) : remote;
}

// Every URL a push reaches, after pushurl and url.<base>.pushInsteadOf; a push to a configured remote goes to each.
async function pushUrls(base, remote) {
  const named = await git(base, ["remote", "get-url", "--push", "--all", remote]);
  return named.ok && named.text ? gitUrlText(named).split("\n") : [await fetchUrl(base, remote)];
}

// Git checks every object a fetch receives, so a tree that a teammate built with a name such as "..", ".git", or an empty one fails the fetch, and the sync's own check of the upstream's tree still guards every write.
// Only the objects new to the store are checked, so a history that this machine already holds never stops its syncs.
// A configured remote is fetched with its branches mapped to refs/remotes/<remote>/ on the command line, so the fetch removes the remote-tracking branches that the remote no longer holds,
// and the commits the push check takes as known are ones the remote still has, while no remote.<name>.fetch refspec of the person's decides which other refs it removes.
// It fetches no tag, removes no tag, writes no commit-graph file, and fetches no submodule, whatever the person's fetch settings.
// Returns Git's result, or a failed one whose message says why a local remote with no repository was not fetched.
async function fetchRemote(base, remote) {
  const named = (await git(base, ["remote", "get-url", remote])).ok;
  const { targets, missing } = await remoteTargets(base, remote, "--upload-pack");
  if (missing) return { ok: false, stderr: missing };
  const [{ target, helper }] = targets;
  return git(base, ["-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--prune", "--no-prune-tags", "--no-tags", "--no-recurse-submodules", "--no-write-commit-graph",
    ...helper, target, ...(named ? [`+refs/heads/*:refs/remotes/${remote}/*`] : [])]);
}

// A remote named in the store's configuration, whose remote.<name>.mirror setting would make Git refuse a push of one refspec, rather than a URL, which has no such setting.
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The push of the branch to one branch of a remote that every sync runs: the refspec names the branch on both sides, and the push sends no tag, as push.followTags would, and no submodule, as push.recurseSubmodules would,
 * so it sends only the objects of the branch's history, which the push check walked; remote.<name>.push is never read when a refspec is given.
 * A push that names a local repository by its path leaves the remote-tracking branch and the upstream as they were, so they are set as a push to the remote sets them.
 * Returns Git's result for the first push that failed, or for the last one.
 */
async function pushBranch(base, remote, destination, { setUpstream } = {}) {
  const { targets, missing } = await remoteTargets(base, remote, "--receive-pack");
  if (missing) return { ok: false, stderr: missing };
  const byName = targets.length === 1 && targets[0].target === remote;
  const named = (await git(base, ["remote", "get-url", remote])).ok;
  const pushed = (await required(base, ["rev-parse", "--verify", "HEAD"])).text;
  let result;
  for (const { target, helper } of targets) {
    result = await git(base, ["-c", "push.followTags=false", ...(REMOTE_NAME.test(remote) ? ["-c", `remote.${remote}.mirror=false`] : []),
      "push", "--quiet", "--no-follow-tags", "--no-recurse-submodules", ...helper, ...(setUpstream && byName ? ["--set-upstream"] : []), target, `HEAD:${destination}`]);
    if (!result.ok) return result;
    if (!byName && named && destination.startsWith("refs/heads/")) await required(base, ["update-ref", `refs/remotes/${remote}/${destination.slice("refs/heads/".length)}`, pushed]);
  }
  if (setUpstream && !byName) {
    await required(base, ["config", `branch.${setUpstream}.remote`, remote]);
    await required(base, ["config", `branch.${setUpstream}.merge`, destination]);
  }
  return result;
}

async function sync(base, options) {
  const top = await git(base, ["rev-parse", "--show-toplevel"]);
  if (top.missing) return writeStatus(base, { state: "not_a_repository", message: "Git is not available, so the record store is not synced." });
  if (!top.ok || path.resolve(top.text) !== path.resolve(base)) return writeStatus(base, { state: "not_a_repository", message: "The record store is not the top of a Git checkout, so it is not synced." });
  const tooOld = await gitTooOld();
  if (tooOld) return writeStatus(base, { state: "git_failed", message: tooOld });
  const author = await identity(base);
  await migrateLineEndings(base);
  // Local versions that a sync stopped while saving or replacing are saved for good, or dropped when no file was replaced, before anything else changes.
  const conflicts = await recoverSaved(base);
  const run = {};
  const report = (status) => writeStatus(base, withheldIn({ ...status, conflicts: [...conflicts, ...(status.conflicts ?? [])] }, run.withheld));
  await commitLocal(base, author, run);
  let upstream = await upstreamOf(base);
  if (!upstream && managed.has(base)) {
    const published = await publishBranch(base, author, options);
    if (published.status) return report(published.status);
    upstream = published.upstream;
  }
  if (!upstream) return report({ state: "no_upstream", message: "The store's branch has no upstream, so records are committed locally only." });
  let busy = false;
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    // A merge left unapplied keeps the branch where it was, so files it replaced and local writes are committed and merged again.
    if (attempt > 1) await commitLocal(base, author, run);
    const fetched = await fetchRemote(base, upstream.remote);
    if (!fetched.ok) return report({ state: "fetch_failed", message: fetched.stderr, ...await counts(base) });
    lastFetch.set(base, Date.now());
    const merged = await merge(base, author, options, run);
    if (merged.failed) return report({ state: "merge_failed", message: merged.failed, ...await counts(base) });
    // A merge that replaced files without moving the branch saved the local versions it replaced, which the next attempt would otherwise commit as the upstream's.
    conflicts.push(...merged.conflicts);
    busy = !merged.applied;
    if (busy) continue;
    const { ahead } = await counts(base);
    if (!ahead && !(await unpublished(base))) return report(settled([]));
    const refused = await unpushable(base, upstream.remote);
    if (refused) return report({ state: "merge_failed", message: refused, ...await counts(base) });
    await options.beforePush?.();
    const pushed = await pushBranch(base, upstream.remote, upstream.merge);
    if (pushed.ok) return report({ ...settled([]), ...await counts(base) });
    // Only a push that lost a race to another push tries again; a remote that refused it for another reason, such as a checked-out branch, says why.
    if (!/\[rejected\]|fetch first|non-fast-forward|cannot lock ref|incorrect old value/i.test(pushed.stderr)) return report({ state: "push_rejected", message: pushed.stderr, ...await counts(base) });
  }
  if (busy) {
    scheduleRecordSync(base);
    return report({ state: "merge_failed", message: "Record files changed or stayed locked while the upstream was merged, so the store kept its branch and the next sync merges again.", ...await counts(base) });
  }
  return report({ state: "push_rejected", message: `The push was rejected ${PUSH_ATTEMPTS} times because others pushed first.`, ...await counts(base) });
}

/**
 * A status with the files that the sync's commits left out named in its message and listed under withheld as { path, reason }, so the person can rename or fix them while every other change syncs.
 * An ok or conflicts state carries the conflicts' message and the conflicts it settles.
 */
function withheldIn(status, withheld) {
  const value = status.state === "ok" && settled(status.conflicts).state === "conflicts" ? { ...status, ...settled(status.conflicts) } : status;
  if (!withheld?.size) return value;
  const listed = [...withheld].slice(0, 5).map(([file, reason]) => `${shownPath(file)}, because ${reason}`).join("; ");
  const more = withheld.size > 5 ? `; and ${withheld.size - 5} more` : "";
  const note = `The sync did not commit ${listed}${more}. Rename, shorten, or fix it in the store, and the next sync commits it; every other change synced as usual.`;
  return { ...value, withheld: [...withheld].map(([file, reason]) => ({ path: file, reason })), message: [value.message, note].filter(Boolean).join(" ") };
}

/**
 * Give a managed clone's branch its upstream on origin: adopt the branch another machine pushed first, or push this one with its upstream set.
 * A clone of an empty remote has no upstream until then, so its first sync publishes it instead of reporting no_upstream.
 * Returns { upstream } to continue the sync, or { status } to report.
 */
async function publishBranch(base, author, options) {
  const branch = (await git(base, ["symbolic-ref", "--quiet", "--short", "HEAD"])).text;
  if (!branch || !(await git(base, ["config", "--local", "--get", "remote.origin.url"])).ok) return { upstream: null };
  const fetched = await fetchRemote(base, "origin");
  if (!fetched.ok) return { status: { state: "fetch_failed", message: fetched.stderr } };
  lastFetch.set(base, Date.now());
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const theirs = await git(base, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  if (theirs.ok) {
    // An unborn branch has nothing local to keep, so it takes the pushed branch's files before it tracks it.
    if (!head.ok) await refuseUnsafeTree(base, theirs.text);
    if (!head.ok && !(await apply(base, null, theirs.text, options))) return { status: { state: "merge_failed", message: "Record files changed or stayed locked while the upstream was applied, so the next sync applies it again." } };
    await required(base, ["branch", "--quiet", `--set-upstream-to=origin/${branch}`, branch]);
    return { upstream: await upstreamOf(base) };
  }
  if (!head.ok) return { status: { state: "ok", message: "The store and its remote are still empty, so there is nothing to sync yet." } };
  await alignWithUpstream(base, author, head.text, null);
  const refused = await unpushable(base, "origin");
  if (refused) return { status: { state: "merge_failed", message: refused } };
  await options.beforePush?.();
  const pushed = await pushBranch(base, "origin", `refs/heads/${branch}`, { setUpstream: branch });
  if (!pushed.ok) return { status: { state: "push_rejected", message: pushed.stderr } };
  return { upstream: await upstreamOf(base) };
}

// Merge the fetched upstream without touching the working tree, then replace changed files one by one atomically.
async function merge(base, author, options, run) {
  const upstream = await git(base, ["rev-parse", "--verify", "--quiet", "@{upstream}"]);
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  // An upstream branch that the remote does not hold, as one deleted there, has nothing to merge, and the push that publishes the branch again keeps none of its entries that a store does not share.
  if (!upstream.ok) {
    if (head.ok) await alignWithUpstream(base, author, head.text, null);
    return { applied: true, conflicts: [] };
  }
  const theirs = upstream.text;
  // A branch that holds the whole upstream takes nothing from it, and only gives its push the upstream's entries that a store does not share,
  // which are checked first, since a branch that took the upstream by hand can hold one that this machine's Git refuses in an index.
  if (head.ok && (await git(base, ["merge-base", "--is-ancestor", theirs, head.text])).ok) {
    await refuseUnsafeTree(base, theirs);
    await alignWithUpstream(base, author, head.text, theirs);
    return { applied: true, conflicts: [] };
  }
  // The upstream is another machine's work, so its whole tree is checked before any of it is taken, whether it fast-forwards or merges.
  await refuseUnsafeTree(base, theirs);
  if (!head.ok || (await git(base, ["merge-base", "--is-ancestor", head.text, theirs])).ok) {
    const from = head.ok ? head.text : null;
    const kept = run.heldBack?.size ? heldCopies(run, await treeFiles(base, from), await treeFiles(base, theirs)) : [];
    return replaceFiles(base, run, { from, to: theirs, copies: kept }, options);
  }
  const mergeBase = await git(base, ["merge-base", head.text, theirs]);
  if (!mergeBase.ok || !mergeBase.text) return { failed: "The store's branch and its upstream share no commit, so the store was left as it was.", conflicts: [] };
  // Only the entries a store shares merge; every other entry comes from the upstream alone, so no machine's commit changes one and a local one never reaches the remote.
  const [original, local, upstreamFiles] = await Promise.all([mergeBase.text, head.text, theirs].map(async (commit) => (await partition(await treeFiles(base, commit)))));
  const { result, conflicts: fileConflicts } = await mergeFiles(base, original.shared, local.shared, upstreamFiles.shared);
  const merges = await structuralMerges(base, original.shared, local.shared, upstreamFiles.shared);
  const views = new Set(merges.views);
  // The upstream version wins, as the first push does for a stale revision, and the local version is kept beside the store once the merge applies.
  // A generated view that changed on both sides takes the upstream view whole, which the next write of its record regenerates, so it is neither saved nor reported.
  const takeUpstream = (file) => { if (upstreamFiles.shared.has(file)) result.set(file, upstreamFiles.shared.get(file)); else result.delete(file); };
  const fallback = [...new Set([...fileConflicts, ...merges.fallback])].filter((file) => !merges.merged.has(file) && !views.has(file));
  for (const file of [...fallback, ...views]) takeUpstream(file);
  // A record merged by structure takes its merged blob instead of the line merge.
  for (const [file, contents] of merges.merged) result.set(file, { mode: "100644", object: (await required(base, ["hash-object", "-w", "--no-filters", "--stdin"], { input: contents })).text });
  const clashes = [...settleFolders(result, upstreamFiles.shared), ...settleLetterCase(result, local.shared, upstreamFiles.shared)];
  // A conflict inside a place where the upstream took the whole folder or file is saved with that place.
  const inClash = (file) => clashes.some((place) => file === place || file.startsWith(`${place}/`));
  const conflicted = [...clashes, ...fallback.filter((file) => !inClash(file))];
  const other = conflicted.filter((file) => !isSavedFile(file));
  if (other.length) return { failed: `The upstream conflicts with local changes to ${other.slice(0, 5).join(", ")}, so the store was left as it was.`, conflicts: [] };
  const merged = besides(result, upstreamFiles.other);
  // A file the upstream carries can still meet a local file in another letter case, which no other machine could then take.
  const clash = letterCaseClash(merged.keys());
  if (clash) return { failed: `The merge would hold ${describeUnsafeEntry({ path: clash[1], clash: clash[0] })}, so the store was left as it was. Remove or rename one of them.`, conflicts: [] };
  const tree = await writeTree(base, merged);
  const commit = (await required(base, [...author, "commit-tree", tree, "-p", head.text, "-p", theirs, "-m", `prism: merge records from ${(await git(base, ["rev-parse", "--abbrev-ref", "@{upstream}"])).text || "upstream"}`])).text;
  const copies = conflictCopies(local.shared, upstreamFiles.shared, conflicted);
  // A file whose local version the sync withheld keeps the branch's version in the local tree, so the merge replaces it whenever the upstream changed it, and its withheld bytes are saved as a conflict's are.
  for (const [file, entry] of heldCopies(run, local.shared, merged)) {
    const at = copies.findIndex(([candidate]) => candidate === file);
    if (at < 0) copies.push([file, entry]); else copies[at] = [file, entry];
  }
  return replaceFiles(base, run, { from: head.text, to: commit, copies }, options);
}

/**
 * Replace the store's files with a target commit's, after saving the local versions that it replaces into a stage, so a sync that stops anywhere in between loses none of them:
 * { applied, conflicts }, where conflicts lists the saved versions, as a sync status names them, of the files the merge replaced.
 * copies lists [path, entry] for each local version to save, with entry null for a conflicted path where the local side holds no file.
 * run.heldBack maps each file whose local version the sync withheld to that version, which the replacement takes as the file's own bytes; a replaced one is withheld no more.
 */
async function replaceFiles(base, run, { from, to, copies }, options) {
  const held = run.heldBack ?? new Map();
  if (!copies.length) return { applied: await apply(base, from, to, options, {}, held), conflicts: [] };
  const stage = await stageLocal(base, copies, { from, to });
  const applied = await apply(base, from, to, options, { replacing: (file) => markReplaced(stage, file) }, held);
  if (applied) for (const [file, entry] of copies) if (entry && held.get(file) === entry) { held.delete(file); run.withheld?.delete(file); }
  return { applied, conflicts: await settleStage(base, stage, applied) };
}

// The withheld local versions of the files that a change from one tree to another replaces, as [path, entry].
function heldCopies(run, before, after) {
  return [...(run.heldBack ?? [])].filter(([file]) => !sameEntry(before.get(file), after.get(file)));
}

/**
 * Merge three trees' files path by path: result maps each file path to the entry it takes, and conflicts lists the paths that changed on both sides and do not merge.
 * A path that changed on one side only takes that side's entry, which is no entry where that side removed it, and a path that both sides changed alike keeps that change.
 * A file that both sides changed takes the line merge of its text when it merges cleanly, and otherwise the upstream's entry, so the local one is saved.
 * A file that one side moved, to another scope or within its folder, is a removal and an addition like any other, so no change follows a guessed move.
 */
async function mergeFiles(base, original, local, upstream) {
  const result = new Map();
  const conflicts = [];
  for (const file of new Set([...original.keys(), ...local.keys(), ...upstream.keys()])) {
    const [was, ours, theirs] = [original.get(file), local.get(file), upstream.get(file)];
    let taken = theirs;
    if (sameEntry(ours, theirs) || sameEntry(was, theirs)) taken = ours;
    else if (!sameEntry(was, ours)) {
      const object = await lineMerge(base, was, ours, theirs);
      if (object) taken = { mode: ours.mode, object };
      else conflicts.push(file);
    }
    if (taken) result.set(file, taken);
  }
  return { result, conflicts };
}

// The folders above a path, outermost first.
const folders = (file) => file.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));

/**
 * Give each place in a merged result where a file sits and also a folder of other result files the upstream's file or folder there, and return those places.
 * One tree never holds a file and a folder at one path, so such a place holds one side's file and the other side's folder, both changed there: a true two-sided clash.
 * A file and a folder that each side changed alone, at paths that do not meet, stay as merged.
 */
function settleFolders(result, upstream) {
  const clashes = [];
  for (;;) {
    const places = new Set();
    for (const file of result.keys()) for (const folder of folders(file)) if (result.has(folder)) places.add(folder);
    const outermost = [...places].filter((place) => !folders(place).some((folder) => places.has(folder)));
    if (!outermost.length) return clashes;
    for (const place of outermost) {
      const within = (file) => file === place || file.startsWith(`${place}/`);
      for (const file of [...result.keys()]) if (within(file)) result.delete(file);
      for (const [file, entry] of upstream) if (within(file)) result.set(file, entry);
      clashes.push(place);
    }
  }
}

// Git reads a file as binary when its first 8000 bytes hold a zero byte, and a line merge of such a file is no merge.
const isText = (bytes) => !bytes.subarray(0, 8000).includes(0);

// The object of the clean line merge of a text file that both sides changed and kept as a regular file of one mode, or null when it conflicts or is no such file.
// A file that both sides added merges against an empty file, as Git's own merge does.
async function lineMerge(base, original, local, upstream) {
  if (!local || !upstream || local.mode !== upstream.mode || !FILE_MODES.has(local.mode) || (original && !FILE_MODES.has(original.mode))) return null;
  const contents = await Promise.all([local, original, upstream].map(async (entry) => entry ? (await required(base, ["cat-file", "blob", entry.object])).stdout : Buffer.alloc(0)));
  if (!contents.every(isText)) return null;
  const folder = syncPath(base, "merge-files");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  try {
    const targets = ["local", "original", "upstream"].map((name) => path.join(folder, name));
    for (const [index, target] of targets.entries()) await writeAtomically(target, contents[index]);
    const merged = await git(base, ["merge-file", "-p", "--quiet", ...targets]);
    if (!merged.ok) return null;
    return (await required(base, ["hash-object", "-w", "--no-filters", "--stdin"], { input: merged.stdout })).text;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * The local files at each conflicted path, and below it when it was a folder, that differ from the upstream's, as [path, entry] in a stable order,
 * with [path, null] for a conflicted path where the local side holds no such file, as where it removed one.
 * local and upstream are the shared entries of the two sides, so only files Prism writes are saved.
 */
function conflictCopies(local, upstream, conflicted) {
  const copies = [];
  // A folder's path and a file below it can both be conflicted, so each local file is saved once.
  const done = new Set();
  for (const file of conflicted) {
    const within = (candidate) => candidate === file || candidate.startsWith(`${file}/`);
    const changed = [...local].filter(([candidate, entry]) => within(candidate) && upstream.get(candidate)?.object !== entry.object && !done.has(candidate)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (!changed.length && !done.has(file)) copies.push([file, null]);
    for (const [candidate, entry] of changed) {
      done.add(candidate);
      copies.push([candidate, entry]);
    }
  }
  return copies;
}

/**
 * Save local versions into a staging folder of the sync folder before the merge replaces any file: the stage, whose conflicts lists { path, saved },
 * with saved true for each path whose copy sits below the stage's files folder and left out for a path the local side removed.
 * The stage's record names the commit the branch held and the target commit, and is written last, so a stage without one never held every copy and is dropped.
 * Each file the replacement is about to replace or remove is named in the stage's replaced record first, so a stage that a stopped sync left is settled for exactly the files it replaced.
 */
async function stageLocal(base, copies, { from, to }) {
  const folder = syncPath(base, "saving", `${Date.now()}-${process.pid}`);
  await rm(folder, { recursive: true, force: true });
  const conflicts = [];
  for (const [file, entry] of copies) {
    if (!entry) { conflicts.push({ path: file }); continue; }
    const target = path.join(folder, "files", ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeAtomically(target, await entryBytes(base, entry));
    conflicts.push({ path: file, saved: true });
  }
  await mkdir(folder, { recursive: true });
  await writeAtomically(path.join(folder, REPLACED_RECORD), "[]\n");
  await writeAtomically(path.join(folder, STAGE_RECORD), `${JSON.stringify({ from, to, conflicts })}\n`);
  return { folder, from, to, conflicts, replaced: [] };
}

const STAGE_RECORD = "stage.json";
const REPLACED_RECORD = "replaced.json";

// Whether a replaced or removed file is, holds, or lies below a staged conflict's path.
const touches = (file, conflict) => file === conflict || file.startsWith(`${conflict}/`) || conflict.startsWith(`${file}/`);

// Name a file the replacement is about to replace or remove in the stage's replaced record, when it touches one of the stage's conflicts.
async function markReplaced(stage, file) {
  if (!stage.conflicts.some((conflict) => touches(file, conflict.path)) || stage.replaced.includes(file)) return;
  stage.replaced.push(file);
  await writeAtomically(path.join(stage.folder, REPLACED_RECORD), `${JSON.stringify(stage.replaced)}\n`);
}

/**
 * Settle a stage once its replacement ended or stopped: the conflicts it saves, as a sync status lists them.
 * A replacement that moved the branch saved every staged version; otherwise only the conflicts whose files it named as replaced and whose local version is no longer on disk are saved,
 * and every other one is left to the next merge, which saves it again from the file that still holds it, so each local version is saved once.
 * Settling removes the copies it does not save first, so a sync that stops while settling settles the same conflicts again.
 */
async function settleStage(base, stage, moved) {
  const copyOf = (file) => path.join(stage.folder, "files", ...file.split("/"));
  const kept = [];
  for (const conflict of stage.conflicts) {
    if (moved) { kept.push(conflict); continue; }
    if (!stage.replaced.some((file) => touches(file, conflict.path))) continue;
    if (!conflict.saved) { kept.push(conflict); continue; }
    const [now, copy] = await Promise.all([fileBytes(path.join(base, ...conflict.path.split("/"))), fileBytes(copyOf(conflict.path))]);
    if (copy !== null && !sameBytes(now, copy)) kept.push(conflict);
  }
  if (!kept.length) return dropSaved(stage);
  for (const conflict of stage.conflicts) if (conflict.saved && !kept.includes(conflict)) await rm(copyOf(conflict.path), { force: true });
  return publishSaved(base, { folder: stage.folder, conflicts: kept });
}

/**
 * Move a folder of saved copies into the conflicts folder under a new conflict stamp, with a pending notice of that stamp written first,
 * so the next tool result of every Prism server that uses the store names them, whether the server ran when they were saved or started later: the stamp.
 */
async function publishCopies(base, source) {
  await mkdir(syncPath(base, "conflicts"), { recursive: true });
  await mkdir(syncPath(base, NOTICES), { recursive: true });
  const taken = (name) => Promise.all([syncPath(base, "conflicts", name), syncPath(base, NOTICES, name)].map((target) => lstat(target).then(() => true, () => false))).then((found) => found.some(Boolean));
  // Two saves within one millisecond take the next free stamp.
  for (let attempt = 0; ; attempt++) {
    const candidate = new Date(Date.now() + attempt).toISOString().replace(/[:.]/g, "-");
    if (await taken(candidate)) continue;
    await writeAtomically(syncPath(base, NOTICES, candidate), `${JSON.stringify({ at: new Date().toISOString() })}\n`);
    try { await rename(source, syncPath(base, "conflicts", candidate)); return candidate; }
    catch (error) {
      await rm(syncPath(base, NOTICES, candidate), { force: true });
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) || attempt >= 100) throw error;
    }
  }
}

/**
 * Move a stage's copies into the conflicts folder under a new conflict stamp, so every Prism server that uses the store, one started since the stage was made among them, reports them once:
 * the stage's conflicts as a sync status lists them, with savedAs relative to the store.
 */
async function publishSaved(base, { folder, conflicts }) {
  const stamp = conflicts.some((conflict) => conflict.saved) ? await publishCopies(base, path.join(folder, "files")) : null;
  await rm(folder, { recursive: true, force: true });
  return conflicts.map(({ path: file, saved }) => ({ path: file, savedAs: saved ? `${SYNC_DIRECTORY}/conflicts/${stamp}/${file}` : null }));
}

// Drop a stage whose merge replaced none of its files, so the merge that runs again saves its copies once.
async function dropSaved({ folder }) {
  await rm(folder, { recursive: true, force: true });
  return [];
}

/**
 * Settle every stage that a sync left behind when it stopped, which only one sync at a time can do, since each holds the store's sync lock: the conflicts it saves, as a sync status lists them.
 * A stage whose merge moved the branch is published whole, one whose replacement named files as replaced saves the conflicts of those it did replace, and one that replaced none is dropped,
 * since those files still hold the local versions and the next merge saves them again; one without its record, or whose copies were already published, is removed.
 * A folder that an earlier Prism left there holds its copies directly, after its merge applied, so it is moved to the conflicts folder whole.
 * A pending notice whose stamp holds no saved copies, as when a sync stopped before it moved them, is removed.
 */
async function recoverSaved(base) {
  const { shareable } = await storeLayout();
  for (const name of await readdir(syncPath(base, NOTICES)).catch(() => [])) {
    if (!(await lstat(syncPath(base, "conflicts", name)).then(() => true, () => false))) await rm(syncPath(base, NOTICES, name), { force: true });
  }
  let names = [];
  try { names = (await readdir(syncPath(base, "saving"))).sort(); } catch { return []; }
  const conflicts = [];
  for (const name of names) {
    const folder = syncPath(base, "saving", name);
    const stage = await readFile(path.join(folder, STAGE_RECORD), "utf8").then(JSON.parse).catch(() => null);
    const copies = await lstat(path.join(folder, "files")).then((stats) => stats.isDirectory(), () => false);
    if (!stage && !copies && STAMP.test(name)) {
      await publishCopies(base, folder).catch(() => rm(folder, { recursive: true, force: true }));
      continue;
    }
    // The record is the sync folder's own, and still names only paths a store shares, so no check of a stage reads outside the store.
    const valid = Array.isArray(stage?.conflicts) && stage.conflicts.every((conflict) => typeof conflict?.path === "string" && (isSavedFile(conflict.path) || shareable(conflict.path)) && conflict.path.split("/").every((part) => part && part !== "." && part !== ".."));
    const saved = valid ? stage.conflicts.filter((conflict) => conflict.saved) : [];
    if (!valid || (saved.length && !copies)) { await rm(folder, { recursive: true, force: true }); continue; }
    const moved = typeof stage.to === "string" && (await git(base, ["merge-base", "--is-ancestor", stage.to, "HEAD"])).ok;
    let replaced = await readFile(path.join(folder, REPLACED_RECORD), "utf8").then(JSON.parse).catch(() => null);
    // A stage that an earlier Prism made has no replaced record, so each saved file whose bytes on disk differ from its copy counts as replaced, as that Prism counted it.
    if (!Array.isArray(replaced)) {
      replaced = [];
      for (const conflict of saved) if (!sameBytes(await fileBytes(path.join(base, ...conflict.path.split("/"))), await fileBytes(path.join(folder, "files", ...conflict.path.split("/"))))) replaced.push(conflict.path);
    }
    conflicts.push(...await settleStage(base, { folder, conflicts: stage.conflicts, replaced: replaced.filter((file) => typeof file === "string") }, moved));
  }
  await rmdir(syncPath(base, "saving")).catch(() => {});
  return conflicts;
}

/**
 * Merge by structure every record that changed on both sides since the merge base and whose kind registers a merge, whether or not the line merge conflicts,
 * because a clean line merge of JSON can still be wrong or non-canonical.
 * A registration changed on both sides keeps the upstream version whole, even when the line merge is clean, so no machine keeps a mix of two registrations.
 * A record removed on either side keeps the file merge's handling of a removal.
 * original, local, and upstream are the shared entries of the three trees.
 * Returns the merged contents by path, and the paths whose merge found a conflict or an invalid result, which fall back to the upstream version.
 */
async function structuralMerges(base, original, local, upstream) {
  const merged = new Map();
  const fallback = [];
  const views = [];
  const differs = (side, file) => !sameEntry(original.get(file), side.get(file));
  const changed = [...new Set([...original.keys(), ...local.keys(), ...upstream.keys()])].filter((file) => differs(local, file) && differs(upstream, file));
  const bytesOf = (side, file) => entryBytes(base, side.get(file));
  // Prism writes the views it generates from records, such as initiative.md, into the store's artifacts, so one that both sides regenerated is not a person's change.
  for (const file of changed.filter((item) => item.startsWith(`${ARTIFACTS}/`))) {
    const [mine, theirs] = await Promise.all([local, upstream].map((side) => bytesOf(side, file)));
    if (mine !== null && theirs !== null && !mine.equals(theirs) && [mine, theirs].every((bytes) => bytes.includes(GENERATED_VIEW))) views.push(file);
  }
  const both = changed.filter((file) => hasRecordMerge(file) || isRegistrationFile(file));
  for (const file of both) {
    const [was, mine, theirs] = await Promise.all([original, local, upstream].map((side) => bytesOf(side, file)));
    if (mine === null || theirs === null || mine.equals(theirs)) continue;
    if (isRegistrationFile(file)) { fallback.push(file); continue; }
    const mergeRecord = await recordMergeFor(file);
    let outcome;
    try {
      outcome = await mergeRecord({ path: file, base: was?.toString("utf8") ?? null, local: mine.toString("utf8"), upstream: theirs.toString("utf8") });
    } catch (error) {
      outcome = { conflict: error.message };
    }
    if (typeof outcome?.contents === "string") merged.set(file, Buffer.from(outcome.contents, "utf8"));
    else fallback.push(file);
  }
  return { merged, fallback, views };
}

// The bytes of a tree entry's blob exactly as Git holds them, or null for no entry or one that is no regular file.
const entryBytes = async (base, entry) => entry && FILE_MODES.has(entry.mode) ? (await required(base, ["cat-file", "blob", entry.object])).stdout : null;
// A path that is a folder, or lies below a file, holds no file, as when a file on one side meets a folder on the other.
const fileBytes = (target) => readFile(target).catch((error) => { if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null; throw error; });
const sameBytes = (left, right) => left === null || right === null ? left === right : left.equals(right);

// Every changed file's record lock is held from the first check until the branch moves, so no locked record write lands in between.
// When an artifact changes, the store's artifact lock, which an artifact update holds from its version checks to its writes, is taken first, so neither lands between the other's check and write.
async function holdLocks(targets, action) {
  if (!targets.length) return action();
  return withFileLock(targets[0], () => holdLocks(targets.slice(1), action), undefined, { timeoutMs: SETTINGS.applyLockMs });
}

// The entries of a commit's or a tree's whole tree, files and links alike: Map(path, { mode, object }), empty without one, each path read from its bytes as pathOfBytes reads it.
async function treeFiles(base, commit) {
  const files = new Map();
  if (!commit) return files;
  const output = (await required(base, ["ls-tree", "-r", "-z", "--full-tree", commit])).stdout;
  for (let at = 0; at < output.length;) {
    const end = output.indexOf(0, at) < 0 ? output.length : output.indexOf(0, at);
    const tab = output.indexOf(9, at);
    if (tab < 0 || tab > end) throw new Error(`git ls-tree printed an entry without a path for ${commit}.`);
    const [mode, , object] = output.subarray(at, tab).toString("latin1").split(" ");
    const name = output.subarray(tab + 1, end);
    files.set(pathOfBytes(name), utf8(name) ? { mode, object } : { mode, object, notUtf8: true });
    at = end + 1;
  }
  return files;
}

// A byte of a tree path that is no part of a UTF-8 character is read as the lone surrogate U+DC00 plus that byte, which no UTF-8 text decodes to,
// so two paths that differ only in such bytes keep apart, and every path is written back with the bytes it was read from.
// The u flag matches a lone surrogate only, never half of a character beyond U+FFFF such as U+1F4A1.
const STRAY_BYTE = /[\udc80-\udcff]/u;
// Whether a tree path's bytes are UTF-8, decided on the bytes themselves, so a character beyond U+FFFF is never mistaken for a stray byte.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8 = (bytes) => { try { UTF8.decode(bytes); return true; } catch { return false; } };
const UTF8_LENGTH = (lead) => lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;

/** A tree path's bytes as text, with each byte that is not UTF-8 kept as a lone surrogate. */
function pathOfBytes(bytes) {
  const text = bytes.toString("utf8");
  if (Buffer.from(text).equals(bytes)) return text;
  let read = "";
  for (let at = 0; at < bytes.length;) {
    const size = UTF8_LENGTH(bytes[at]);
    const piece = bytes.subarray(at, at + size);
    if (size && piece.length === size && Buffer.from(piece.toString("utf8")).equals(piece)) { read += piece.toString("utf8"); at += size; }
    else read += String.fromCharCode(0xdc00 + bytes[at++]);
  }
  return read;
}

/** The bytes of a tree path that pathOfBytes read. */
function bytesOfPath(file) {
  if (!STRAY_BYTE.test(file)) return Buffer.from(file);
  const parts = [];
  let run = "";
  for (const character of file) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 0xdc80 && code <= 0xdcff) { parts.push(Buffer.from(run), Buffer.from([code - 0xdc00])); run = ""; }
    else run += character;
  }
  parts.push(Buffer.from(run));
  return Buffer.concat(parts);
}

/** A path as a message names it: quoted, with each byte that is not UTF-8 shown as \x and its two hex digits. */
const shownPath = (file) => JSON.stringify(file).replace(/\\udc([89a-f][0-9a-f])/g, "\\x$1");

const sameEntry = (left, right) => left === right || (left !== undefined && right !== undefined && left.mode === right.mode && left.object === right.object);
const entryKind = (mode) => mode === "120000" ? "a symbolic link" : mode === "160000" ? "a submodule link" : FILE_MODES.has(mode) ? "a file" : "an entry";

/**
 * The first two places of a tree, files or the folders above them, whose paths differ only in letter case or Unicode normalization, which macOS and Windows read as one, or null when there are none.
 */
function letterCaseClash(files) {
  const seen = new Map();
  for (const file of files) {
    for (const place of [...folders(file), file]) {
      const key = letterCaseKey(place);
      const known = seen.get(key);
      if (known === undefined) seen.set(key, place);
      else if (known !== place) return [known, place];
    }
  }
  return null;
}

/**
 * Settle each pair of places in a merged result whose paths differ only in letter case, as when two machines each wrote one spelling, for the upstream:
 * macOS and Windows read both as one file or folder, so the upstream's spelling keeps the upstream's files, as a conflict does, and the local files of both spellings are saved.
 * Returns the places whose local files that takes out; a pair that only the local side holds is left, and the merge refuses it.
 * local and upstream are the shared entries of the two sides; the upstream's tree holds no such pair itself.
 */
function settleLetterCase(result, local, upstream) {
  const within = (candidate, folder) => candidate === folder || candidate.startsWith(`${folder}/`);
  const upstreamHolds = (place) => [...upstream.keys()].some((file) => within(file, place));
  const clashes = [];
  for (;;) {
    const pair = letterCaseClash(result.keys());
    if (!pair) return clashes;
    const theirs = pair.find(upstreamHolds);
    const place = pair.find((candidate) => candidate !== theirs);
    if (!theirs || upstreamHolds(place)) return clashes;
    for (const candidate of [...result.keys()]) if (within(candidate, place) || within(candidate, theirs)) result.delete(candidate);
    for (const [candidate, entry] of upstream) if (within(candidate, theirs)) result.set(candidate, entry);
    clashes.push(place);
    if ([...local].some(([candidate, entry]) => within(candidate, theirs) && !sameEntry(upstream.get(candidate), entry))) clashes.push(theirs);
  }
}

/**
 * The first entry of a commit's whole tree that no store may hold, as { path, kind, clash? }, or null when there is none:
 * a symbolic or submodule link, a path that some file system reads as leading outside the store's files, such as one with a ".." part, Git's folder, or the sync folder in any spelling,
 * a name that Windows or Git for Windows refuses, such as aux.md, a name ending in "." or " ", or one holding a character such as "?" or a control character,
 * two paths that differ only in letter case, where clash is the first of them, a name that Git reads as .gitattributes or .gitmodules other than the file .gitattributes at the root,
 * or an entry where Prism keeps a folder, or below a file Prism keeps outside artifacts/.
 * Any other entry that Prism does not write, such as a .DS_Store or a notes file, is no reason to refuse a tree: it stays in Git, and no sync writes it to disk or changes it.
 */
export async function unsafeStoreEntry(base, commit) {
  const { kind } = await storeLayout();
  const files = await treeFiles(base, commit);
  for (const [file, entry] of files) if (kind(file, entry) === "unsafe") return { path: file, kind: entryKind(entry.mode) };
  const clash = letterCaseClash(files.keys());
  return clash ? { path: clash[1], kind: "an entry", clash: clash[0] } : null;
}

/** What a tree holds that no store may hold, and why, for a refusal that names a tree's unsafe entry. */
export function describeUnsafeEntry(unsafe) {
  const what = unsafe.clash ? `${shownPath(unsafe.clash)} and ${shownPath(unsafe.path)}, whose paths differ only in letter case,` : `${unsafe.kind} at ${shownPath(unsafe.path)},`;
  return `${what} which no store may hold, since a link, a path that some file system reads as Git's folder, the sync folder, or a place outside the store, a name that Windows refuses, a path that is not UTF-8, a file Prism shares whose name holds more than ${STORE_NAME_BYTES_MAX} bytes or whose path holds more than ${STORE_PATH_BYTES_MAX}, two paths that macOS and Windows read as one, a name that Git reads as .gitattributes or .gitmodules other than the store's own .gitattributes at its root, or an entry where Prism keeps its own files would make some machine's store unsafe or stuck`;
}

/** Refuse an upstream commit whose tree holds an entry no store may hold, before any file is written or removed and before the branch or the index moves, so the branch stays where it was. */
async function refuseUnsafeTree(base, commit) {
  const unsafe = await unsafeStoreEntry(base, commit);
  if (unsafe) throw Object.assign(new Error(`The upstream holds ${describeUnsafeEntry(unsafe)}, so the store was left as it was. Remove that path from the remote's branch.`), { unsafePath: true });
}

/**
 * The refusal of a push whose branch tip holds an entry that every other machine's sync and first clone would refuse, or whose objects that the remote's branches lack fail the check
 * that every other machine's fetch and first clone apply, as a .gitattributes with a line over 2048 bytes does; null when the push is safe.
 * Such an object stays in the remote's history once pushed, so no later commit could undo it for the machines that refuse it.
 */
async function unpushable(base, remote) {
  const unsafe = await unsafeStoreEntry(base, "HEAD");
  if (unsafe) return `The store's branch holds ${describeUnsafeEntry(unsafe)}, so it was not pushed. Remove that path from the remote's branch or from this store.`;
  const known = (await required(base, ["for-each-ref", "--format=%(objectname)", `refs/remotes/${remote}/`])).text.split("\n").filter(Boolean);
  const refused = await refusedObjects(base, "HEAD", known);
  if (!refused) return null;
  const places = [...new Set([...refused.places.values()].flat())];
  const named = (places.length ? places : [...await treeFiles(base, "HEAD")].filter(([, entry]) => refused.objects.includes(entry.object)).map(([file]) => file)).map(shownPath);
  return `The store's branch holds ${named.length ? named.join(" and ") : "an object"} that Git's object check refuses (${refused.message}), so it was not pushed, since every other machine's fetch and first clone would then refuse the remote for good. Fix that file in this store, or take the commit you made by hand that holds it off the store's branch.`;
}

/**
 * Write the shared files of a commit into a checkout that has none yet, each from its blob's bytes exactly, then point the checkout's index at the commit, so the first clone of a store holds what every sync expects.
 * Every other entry stays in Git only.
 */
export async function writeCommitFiles(base, commit) {
  const { shared } = await partition(await treeFiles(base, commit));
  const files = [...shared];
  // The blobs are read in batches of bounded size, so a store of many files takes few Git processes and no batch outgrows the output buffer.
  const sizes = files.length ? (await required(base, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], { input: `${files.map(([, entry]) => entry.object).join("\n")}\n` })).text.split("\n").map((line) => Number(line.split(" ")[1])) : [];
  const LIMIT = 32 * 1024 * 1024;
  for (let start = 0; start < files.length;) {
    let end = start;
    let total = 0;
    while (end < files.length && (end === start || total + sizes[end] <= LIMIT)) total += sizes[end++] + 128;
    const batch = files.slice(start, end);
    const output = (await required(base, ["cat-file", "--batch"], { input: `${batch.map(([, entry]) => entry.object).join("\n")}\n`, maxBuffer: total + 1024 * 1024 })).stdout;
    let at = 0;
    for (const [file, entry] of batch) {
      const header = output.indexOf(10, at);
      const [object, type, size] = output.subarray(at, header).toString("utf8").split(" ");
      if (object !== entry.object || type !== "blob") throw new Error(`Git holds no blob ${entry.object} for ${file}.`);
      const target = path.join(base, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, output.subarray(header + 1, header + 1 + Number(size)));
      at = header + 1 + Number(size) + 1;
    }
    start = end;
  }
  await required(base, ["read-tree", commit]);
}

// A changed path is written only below the store and through no symbolic link that sits in the store, whatever the upstream holds.
async function outsideStore(base, file) {
  const parts = file.split("/");
  const root = path.resolve(base);
  if (!path.resolve(root, ...parts).startsWith(`${root}${path.sep}`)) return true;
  for (let at = 1; at <= parts.length; at++) {
    const stats = await lstat(path.join(root, ...parts.slice(0, at))).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; });
    if (!stats) return false;
    if (stats.isSymbolicLink()) return true;
  }
  return false;
}

async function refuseOutsidePaths(base, files) {
  for (const file of files) {
    if (await outsideStore(base, file)) throw Object.assign(new Error(`The upstream changes the path ${JSON.stringify(file)}, which leads outside the store's files through a symbolic link in the store, so the store was left as it was.`), { unsafePath: true });
  }
}

// A folder can sit where a file goes or is removed, as a submodule link that an earlier Prism checked out leaves an empty one; an empty folder goes, and one that holds files stays.
async function clearFolder(target) {
  const stats = await lstat(target).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; });
  if (stats?.isDirectory()) await rmdir(target).catch((error) => { if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(error.code)) throw error; });
  return stats;
}

/**
 * Replace the files at shared paths that differ between two commits by atomic renames of their blobs' bytes, then move the branch and index to the target commit.
 * An entry at any other path, such as a .DS_Store the store's history holds, is never written, removed, or compared on disk.
 * The branch moves only when every changed file held the previous commit's bytes and holds the target's bytes afterwards, in the target's spelling.
 * Otherwise the branch stays, so the next commit records the replaced files and the local writes, and the next merge resolves them; progress.replacing, when given, runs before each file is replaced or removed.
 * held maps a file whose local version the sync withheld to that version, which the file may hold in place of the branch's.
 * On a file system that ignores letter case, as macOS and Windows use by default, a path that differs only in letter case from a file on disk opens that file,
 * so a path counts as holding bytes only when every name of it is stored in that spelling, and two changed paths that such a file system reads as one take one lock.
 */
async function apply(base, from, to, options, progress = {}, held = new Map()) {
  const marker = syncPath(base, "working-tree");
  await writeAtomically(marker, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  let files = [];
  try {
    await options.beforeApply?.();
    const { shareable } = await storeLayout();
    const [before, after] = await Promise.all([treeFiles(base, from), treeFiles(base, to)]);
    // A link that the branch held and the target drops was never a file on disk that Prism wrote, so it stays as it is; a submodule link's empty folder goes.
    const onDisk = (file) => [before.get(file), after.get(file)].some((entry) => FILE_MODES.has(entry?.mode)) || before.get(file)?.mode === "160000";
    files = [...new Set([...before.keys(), ...after.keys()])].filter((file) => shareable(file) && !sameEntry(before.get(file), after.get(file)) && onDisk(file)).sort();
    await refuseOutsidePaths(base, files);
    const targets = files.map((file) => path.join(base, ...file.split("/")));
    const artifacts = path.join(base, ARTIFACTS);
    const artifactLock = files.some(isGuardedFile) ? [artifacts] : [];
    // Every artifact update holds the artifact lock from its version checks to its last write, so only the other files take a lock of their own beside them.
    const keys = new Set();
    const locked = targets.filter((target, index) => !isGuardedFile(files[index]) && !keys.has(letterCaseKey(files[index])) && keys.add(letterCaseKey(files[index])));
    // Folders under artifacts/ are made and removed only while the artifact lock is held, so none appears or vanishes between an update's layout check and its last write.
    return await holdLocks(artifactLock, async () => {
      try {
        for (const target of locked) await mkdir(path.dirname(target), { recursive: true });
        return await holdLocks(locked, async () => {
          const next = [];
          const listings = new Map();
          const ownBytes = async (index, cache) => (await storedInSpelling(base, files[index], cache)) ? fileBytes(targets[index]) : null;
          for (const [index, file] of files.entries()) {
            const [bytes, expected] = await Promise.all([ownBytes(index, listings), entryBytes(base, before.get(file))]);
            // A file whose local version the sync withheld still holds that version, which the caller saved.
            if (!sameBytes(bytes, expected) && !(held.has(file) && sameBytes(bytes, await entryBytes(base, held.get(file))))) return false;
            next.push(await entryBytes(base, after.get(file)));
          }
          // Removals come first, and an artifact folder that one leaves empty, or holding only a file manager's files, goes with it,
          // so a file that takes a removed folder's place, or a folder that differs from a removed one only in letter case, is made anew rather than inside the old one.
          for (const [index, bytes] of next.entries()) {
            if (bytes !== null) continue;
            await progress.replacing?.(files[index]);
            if (!(await clearFolder(targets[index]))?.isDirectory()) await rm(targets[index], { force: true });
            if (guardedFolder(files[index])) await pruneArtifactFolders(path.join(base, guardedFolder(files[index])), targets[index]);
          }
          for (const [index, bytes] of next.entries()) {
            if (bytes === null) continue;
            await progress.replacing?.(files[index]);
            await respellFolders(base, files[index]);
            await mkdir(path.dirname(targets[index]), { recursive: true });
            await clearFolder(targets[index]);
            await writeAtomically(targets[index], bytes);
          }
          const written = new Map();
          for (const [index, bytes] of next.entries()) if (!sameBytes(await ownBytes(index, written), bytes)) return false;
          // The index takes the target's tree before the branch moves, so a tree that this machine's Git refuses in an index never becomes the branch's.
          await required(base, ["read-tree", to]);
          await required(base, ["update-ref", "-m", "prism: sync records", "HEAD", to, ...(from ? [from] : [])]).catch(async (error) => {
            await git(base, from ? ["read-tree", from] : ["read-tree", "--empty"]);
            throw error;
          });
          return true;
        });
      } finally {
        // A removed record, or a folder made only for a lock, leaves no empty folder behind, so listings never show it; the per-file locks are released by now.
        for (const file of files) for (let folder = path.dirname(path.join(base, file)); folder !== base; folder = path.dirname(folder)) if (!(await rmdir(folder).then(() => true, () => false))) break;
      }
    }).catch((error) => { if (error.code === "lock_timeout") return false; throw error; });
  } finally {
    await rm(marker, { force: true });
  }
}

/**
 * Whether every name of a store-relative path is stored on disk in exactly that spelling, as a folder listing shows it; cache, when given, keeps each folder's listing for one check of many paths.
 * A file system that ignores letter case finds a path in any letter case, so only this tells a path's own file from one whose name differs only in letter case.
 */
async function storedInSpelling(base, file, cache) {
  let folder = base;
  for (const name of file.split("/")) {
    let names = cache?.get(folder);
    if (!names) {
      names = await readdir(folder).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; });
      cache?.set(folder, names);
    }
    if (!names.includes(name)) return false;
    folder = path.join(folder, name);
  }
  return true;
}

/**
 * Give each folder above a path that the file system stores in another letter case, and finds by this spelling too, this spelling, as it would after a removal emptied it,
 * so a file written below it lands at the target's spelling, which the next commit reads back; a file system that tells letter case apart keeps the two spellings as two folders.
 */
async function respellFolders(base, file) {
  let folder = base;
  for (const name of file.split("/").slice(0, -1)) {
    const names = await readdir(folder).catch(() => null);
    if (!names) return;
    const stored = names.includes(name) ? name : names.find((candidate) => letterCaseKey(candidate) === letterCaseKey(name));
    if (stored === undefined) return;
    if (stored !== name) {
      if (!(await lstat(path.join(folder, name)).then((stats) => stats.isDirectory(), () => false))) return;
      await rename(path.join(folder, stored), path.join(folder, name));
    }
    folder = path.join(folder, name);
  }
}

/**
 * Files that a file manager writes into a folder on its own and writes again when it needs them: Finder's view settings.
 * A removal deletes them with the folder it emptied, so no folder lingers whose letter case a later create in another case would land in.
 * Only a name that the artifact name form refuses is among them, so no file that is or could be an artifact is ever deleted without an operation naming it:
 * Windows Explorer's Thumbs.db meets the name form, so it keeps its folder, and a later create in another letter case there is refused before any change.
 * Lock and temporary files are not among them, since one may belong to a lock or a write that another process holds now.
 */
const FILE_MANAGER_FILES = new Set([".DS_Store"]);
const prunable = (entry) => entry.isFile() && FILE_MANAGER_FILES.has(entry.name) && !wellFormedName(entry.name);

/** Remove the folders that removing an artifact left empty, or holding only file manager files, up to the artifacts folder at base; an artifact update and a sync both call it under the artifact lock. */
export async function pruneArtifactFolders(base, target) {
  for (let folder = path.dirname(target); folder !== base && folder.startsWith(`${base}${path.sep}`); folder = path.dirname(folder)) {
    try {
      const entries = await readdir(folder, { withFileTypes: true });
      if (!entries.every(prunable)) return;
      for (const entry of entries) await rm(path.join(folder, entry.name));
      await rmdir(folder);
    } catch { return; }
  }
}
