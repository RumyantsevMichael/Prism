import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACTS, letterCaseKey, portableName, wellFormedName } from "./artifact-paths.mjs";
import { withFileLock, writeAtomically } from "./artifact-store.mjs";
import { hasRecordMerge, recordMergeFor } from "./record-merge.mjs";
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
// Variables that could point Git at another repository, index, or object store than the store's own.
const REDIRECTING = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|QUARANTINE_PATH|REPLACE_REF_BASE|GRAFT_FILE|SHALLOW_FILE)$/;

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
const isSavedFile = (relative) => isRecordFile(relative) || isArtifactFile(relative);
const syncPath = (base, ...parts) => path.join(base, SYNC_DIRECTORY, ...parts);

function gitEnvironment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !REDIRECTING.test(name)));
  // An SSH password or host-key prompt would hang a sync that holds the store lock, so SSH never asks unless the user configured it.
  const ssh = env.GIT_SSH_COMMAND || env.GIT_SSH ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  // The system attributes file, like the person's own and the store's, never decides which bytes a store command hands over.
  return { ...env, ...ssh, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", GIT_ATTR_NOSYSTEM: "1", LC_ALL: "C", ...extra };
}

// The sync uses Git only as an object store: it hashes a file's bytes with no filters, writes a blob's bytes as they are, and never runs add, checkout, reset, or status, so no ignore or attributes rule applies.
// These settings of the person's configuration would convert line endings or add ignore and attributes rules wherever Git still reads them, so every store command runs with them fixed instead.
const FIXED_CONFIG = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.safecrlf=false", "-c", "core.attributesFile=", "-c", "core.excludesFile="];

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
 * Local versions that a sync saved because the upstream changed the same record or the same lines of an artifact, in stores this process uses, since this process started and not reported before:
 * { record, savedAs, at } for a record, and { store, location, savedAs, at } for an artifact, whose location is its path below artifacts/ in the store at store.
 */
export async function takeSavedConflicts() {
  const found = [];
  for (const base of watched) {
    const directory = syncPath(base, "conflicts");
    let stamps = [];
    try { stamps = (await readdir(directory)).sort(); } catch { continue; }
    for (const stamp of stamps) {
      const at = stampTime(stamp);
      const key = `${base}\0${stamp}`;
      if (!(at >= PROCESS_START) || reported.has(key)) continue;
      reported.add(key);
      for (const file of await savedFiles(path.join(directory, stamp), isSavedFile)) {
        const savedAs = path.join(directory, stamp, ...file.split("/"));
        found.push(isArtifactFile(file) ? { store: base, location: file.slice(ARTIFACTS.length + 1), savedAs, at: new Date(at).toISOString() } : { record: `.prism/${file}`, savedAs, at: new Date(at).toISOString() });
      }
    }
  }
  return found;
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
   * or an entry where Prism keeps a folder, or below a file Prism keeps outside artifacts/, which would clash with Prism's own files;
   * and "carried" for any other regular file, such as a .DS_Store that an earlier Prism committed, which stays in Git only.
   */
  const kind = (file, mode) => {
    if (!FILE_MODES.has(mode) || file.split("/").some((name) => unsafeName(name) || !portableName(name))) return "unsafe";
    if (shareable(file)) return "shared";
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
  for (const [file, entry] of files) (kind(file, entry.mode) === "shared" ? shared : other).set(file, entry);
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
    const input = [...entries].map(([file, entry]) => `${entry.mode} ${entry.object}\t${file}\0`).join("");
    if (input) await required(base, ["update-index", "-z", "--index-info"], { env, input });
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
  const artifacts = echoes.filter(({ file }) => isArtifactFile(file));
  if (artifacts.length) await holdLocks([path.join(base, ARTIFACTS)], async () => { for (const echo of artifacts) await rewrite(echo); });
  for (const echo of echoes.filter(({ file }) => !isArtifactFile(file))) await holdLocks([echo.target], () => rewrite(echo));
  await writeAtomically(syncPath(base, RAW_FILES), `${JSON.stringify({ at: new Date().toISOString() })}\n`);
  migrated.add(base);
}

/**
 * The store's files at the paths it shares, as Map(path, { mode, object }), each hashed from its bytes exactly as they are, so no ignore or attributes rule decides what is committed or how.
 * Only regular files count, found without following a symbolic link, and with artifacts false the branch's artifacts stand in for the ones on disk.
 * A file keeps the mode the branch gives it, and a new one is a plain file, so a file system without an executable bit changes no mode.
 */
async function localFiles(base, artifacts, held) {
  const { shareable, isStoreFolder } = await storeLayout();
  for (let attempt = 1; ; attempt++) {
    const found = [];
    const visit = async (relative) => {
      let entries = [];
      try { entries = await readdir(relative ? path.join(base, ...relative.split("/")) : base, { withFileTypes: true }); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return; throw error; }
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isFile()) { if (shareable(child) && (artifacts || !isArtifactFile(child))) found.push(child); }
        else if (entry.isDirectory() && isStoreFolder(child) && (artifacts || child !== ARTIFACTS)) await visit(child);
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
    if (!artifacts) for (const [file, entry] of held) if (isArtifactFile(file)) files.set(file, entry);
    return files;
  }
}

/**
 * Commit the store's changes; run is one sync's state, whose artifacts is false once an update held the artifact lock when this sync came to read the artifacts.
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
  let files = null;
  if (run.artifacts !== false) {
    files = await withFileLock(path.join(base, ARTIFACTS), () => localFiles(base, true, shared), undefined, { timeoutMs: run.artifacts ? SETTINGS.applyLockMs : 1 })
      .catch((error) => { if (error.code !== "lock_timeout") throw error; return null; });
    run.artifacts = files !== null;
    if (!files) scheduleRecordSync(base);
  }
  if (run.artifacts === false) files = await localFiles(base, false, shared);
  const entries = besides(files, other);
  if (sameFiles(entries, branch)) return false;
  const changed = [...new Set([...branch.keys(), ...entries.keys()])].filter((file) => !sameEntry(branch.get(file), entries.get(file))).sort();
  const listed = changed.slice(0, COMMIT_LIST).join("\n") + (changed.length > COMMIT_LIST ? `\n… and ${changed.length - COMMIT_LIST} more` : "");
  const tree = await writeTree(base, entries);
  const commit = (await required(base, [...author, "commit-tree", tree, ...(previous ? ["-p", previous] : []), "-m", "prism: update records", "-m", listed])).text;
  await moveBranch(base, commit, previous, "prism: update records");
  return true;
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

// Git checks every object a fetch receives, so a tree that a teammate built with a name such as "..", ".git", or an empty one fails the fetch, and the sync's own check of the upstream's tree still guards every write.
// Only the objects new to the store are checked, so a history that this machine already holds never stops its syncs.
const CHECKED_FETCH = ["-c", "fetch.fsckObjects=true"];

async function sync(base, options) {
  const top = await git(base, ["rev-parse", "--show-toplevel"]);
  if (top.missing) return writeStatus(base, { state: "not_a_repository", message: "Git is not available, so the record store is not synced." });
  if (!top.ok || path.resolve(top.text) !== path.resolve(base)) return writeStatus(base, { state: "not_a_repository", message: "The record store is not the top of a Git checkout, so it is not synced." });
  const author = await identity(base);
  await migrateLineEndings(base);
  const run = {};
  await commitLocal(base, author, run);
  let upstream = await upstreamOf(base);
  if (!upstream && managed.has(base)) {
    const published = await publishBranch(base, author, options);
    if (published.status) return writeStatus(base, published.status);
    upstream = published.upstream;
  }
  if (!upstream) return writeStatus(base, { state: "no_upstream", message: "The store's branch has no upstream, so records are committed locally only." });
  const conflicts = [];
  let busy = false;
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    // A merge left unapplied keeps the branch where it was, so files it replaced and local writes are committed and merged again.
    if (attempt > 1) await commitLocal(base, author, run);
    const fetched = await git(base, [...CHECKED_FETCH, "fetch", "--quiet", upstream.remote]);
    if (!fetched.ok) return writeStatus(base, { state: "fetch_failed", message: fetched.stderr, ...await counts(base) });
    lastFetch.set(base, Date.now());
    const merged = await merge(base, author, options);
    if (merged.failed) return writeStatus(base, { state: "merge_failed", message: merged.failed, ...await counts(base) });
    busy = !merged.applied;
    if (busy) continue;
    conflicts.push(...merged.conflicts);
    const { ahead } = await counts(base);
    if (!ahead && !(await unpublished(base))) return writeStatus(base, settled(conflicts));
    const refused = await unpushable(base);
    if (refused) return writeStatus(base, { state: "merge_failed", conflicts, message: refused, ...await counts(base) });
    await options.beforePush?.();
    const pushed = await git(base, ["push", "--quiet", upstream.remote, `HEAD:${upstream.merge}`]);
    if (pushed.ok) return writeStatus(base, { ...settled(conflicts), ...await counts(base) });
    if (!/rejected|fetch first|non-fast-forward/i.test(pushed.stderr)) return writeStatus(base, { state: "push_rejected", conflicts, message: pushed.stderr, ...await counts(base) });
  }
  if (busy) {
    scheduleRecordSync(base);
    return writeStatus(base, { state: "merge_failed", conflicts, message: "Record files changed or stayed locked while the upstream was merged, so the store kept its branch and the next sync merges again.", ...await counts(base) });
  }
  return writeStatus(base, { state: "push_rejected", conflicts, message: `The push was rejected ${PUSH_ATTEMPTS} times because others pushed first.`, ...await counts(base) });
}

/**
 * Give a managed clone's branch its upstream on origin: adopt the branch another machine pushed first, or push this one with its upstream set.
 * A clone of an empty remote has no upstream until then, so its first sync publishes it instead of reporting no_upstream.
 * Returns { upstream } to continue the sync, or { status } to report.
 */
async function publishBranch(base, author, options) {
  const branch = (await git(base, ["symbolic-ref", "--quiet", "--short", "HEAD"])).text;
  if (!branch || !(await git(base, ["config", "--local", "--get", "remote.origin.url"])).ok) return { upstream: null };
  const fetched = await git(base, [...CHECKED_FETCH, "fetch", "--quiet", "origin"]);
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
  const refused = await unpushable(base);
  if (refused) return { status: { state: "merge_failed", message: refused } };
  await options.beforePush?.();
  const pushed = await git(base, ["push", "--quiet", "-u", "origin", "HEAD"]);
  if (!pushed.ok) return { status: { state: "push_rejected", message: pushed.stderr } };
  return { upstream: await upstreamOf(base) };
}

// Merge the fetched upstream without touching the working tree, then replace changed files one by one atomically.
async function merge(base, author, options) {
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
  if (!head.ok || (await git(base, ["merge-base", "--is-ancestor", head.text, theirs])).ok) return { applied: await apply(base, head.ok ? head.text : null, theirs, options), conflicts: [] };
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
  if (!(await apply(base, head.text, commit, options))) return { applied: false, conflicts: [] };
  return { applied: true, conflicts: await saveLocal(base, local.shared, upstreamFiles.shared, conflicted) };
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
 * Save the local files at each conflicted path, and below it when it was a folder, that differ from the upstream's, under one new conflict stamp: [{ path, savedAs }], savedAs null for a path the local side removed.
 * local and upstream are the shared entries of the two sides, so only files Prism writes are saved.
 * The copies are written into a folder of their own and moved into the conflicts folder whole, so a reader never sees a stamp that holds only some of them.
 */
async function saveLocal(base, local, upstream, conflicted) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const staging = syncPath(base, "saving", stamp);
  const conflicts = [];
  // A folder's path and a file below it can both be conflicted, so each local file is saved once.
  const done = new Set();
  for (const file of conflicted) {
    const within = (candidate) => candidate === file || candidate.startsWith(`${file}/`);
    const changed = [...local].filter(([candidate, entry]) => within(candidate) && upstream.get(candidate)?.object !== entry.object && !done.has(candidate)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (!changed.length && !done.has(file)) conflicts.push({ path: file, savedAs: null });
    for (const [candidate, entry] of changed) {
      done.add(candidate);
      const target = path.join(staging, ...candidate.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeAtomically(target, await entryBytes(base, entry));
      conflicts.push({ path: candidate, savedAs: `${SYNC_DIRECTORY}/conflicts/${stamp}/${candidate}` });
    }
  }
  if (conflicts.some((conflict) => conflict.savedAs)) {
    await mkdir(syncPath(base, "conflicts"), { recursive: true });
    await rename(staging, syncPath(base, "conflicts", stamp));
  }
  await rm(syncPath(base, "saving"), { recursive: true, force: true });
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

// The entries of a commit's or a tree's whole tree, files and links alike: Map(path, { mode, object }), empty without one.
async function treeFiles(base, commit) {
  const files = new Map();
  if (!commit) return files;
  for (const line of (await required(base, ["ls-tree", "-r", "-z", "--full-tree", commit])).stdout.toString("utf8").split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const [mode, , object] = line.slice(0, tab).split(" ");
    files.set(line.slice(tab + 1), { mode, object });
  }
  return files;
}

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
 * two paths that differ only in letter case, where clash is the first of them, or an entry where Prism keeps a folder, or below a file Prism keeps outside artifacts/.
 * Any other entry that Prism does not write, such as a .DS_Store or a notes file, is no reason to refuse a tree: it stays in Git, and no sync writes it to disk or changes it.
 */
export async function unsafeStoreEntry(base, commit) {
  const { kind } = await storeLayout();
  const files = await treeFiles(base, commit);
  for (const [file, entry] of files) if (kind(file, entry.mode) === "unsafe") return { path: file, kind: entryKind(entry.mode) };
  const clash = letterCaseClash(files.keys());
  return clash ? { path: clash[1], kind: "an entry", clash: clash[0] } : null;
}

/** What a tree holds that no store may hold, and why, for a refusal that names a tree's unsafe entry. */
export function describeUnsafeEntry(unsafe) {
  const what = unsafe.clash ? `${JSON.stringify(unsafe.clash)} and ${JSON.stringify(unsafe.path)}, whose paths differ only in letter case,` : `${unsafe.kind} at ${JSON.stringify(unsafe.path)},`;
  return `${what} which no store may hold, since a link, a path that some file system reads as Git's folder, the sync folder, or a place outside the store, a name that Windows refuses, two paths that macOS and Windows read as one, or an entry where Prism keeps its own files would make some machine's store unsafe or stuck`;
}

/** Refuse an upstream commit whose tree holds an entry no store may hold, before any file is written or removed and before the branch or the index moves, so the branch stays where it was. */
async function refuseUnsafeTree(base, commit) {
  const unsafe = await unsafeStoreEntry(base, commit);
  if (unsafe) throw Object.assign(new Error(`The upstream holds ${describeUnsafeEntry(unsafe)}, so the store was left as it was. Remove that path from the remote's branch.`), { unsafePath: true });
}

// The refusal of a push whose branch tip holds an entry that every other machine's sync and first clone would refuse, or null when the tip is safe to push.
async function unpushable(base) {
  const unsafe = await unsafeStoreEntry(base, "HEAD");
  return unsafe ? `The store's branch holds ${describeUnsafeEntry(unsafe)}, so it was not pushed. Remove that path from the remote's branch or from this store.` : null;
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
 * The branch moves only when every changed file held the previous commit's bytes and holds the target's bytes afterwards.
 * Otherwise the branch stays, so the next commit records the replaced files and the local writes, and the next merge resolves them.
 */
async function apply(base, from, to, options) {
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
    const artifactLock = files.some(isArtifactFile) ? [artifacts] : [];
    // Every artifact update holds the artifact lock from its version checks to its last write, so only the other files take a lock of their own beside them.
    const locked = targets.filter((target, index) => !isArtifactFile(files[index]));
    // Folders under artifacts/ are made and removed only while the artifact lock is held, so none appears or vanishes between an update's layout check and its last write.
    return await holdLocks(artifactLock, async () => {
      try {
        for (const target of locked) await mkdir(path.dirname(target), { recursive: true });
        return await holdLocks(locked, async () => {
          const next = [];
          for (const [index, file] of files.entries()) {
            const [bytes, expected] = await Promise.all([fileBytes(targets[index]), entryBytes(base, before.get(file))]);
            if (!sameBytes(bytes, expected)) return false;
            next.push(await entryBytes(base, after.get(file)));
          }
          // Removals come first, and an artifact folder that one leaves empty, or holding only a file manager's files, goes with it,
          // so a file that takes a removed folder's place, or a folder that differs from a removed one only in letter case, is made anew rather than inside the old one.
          for (const [index, bytes] of next.entries()) {
            if (bytes !== null) continue;
            if (!(await clearFolder(targets[index]))?.isDirectory()) await rm(targets[index], { force: true });
            if (isArtifactFile(files[index])) await pruneArtifactFolders(artifacts, targets[index]);
          }
          for (const [index, bytes] of next.entries()) {
            if (bytes === null) continue;
            await mkdir(path.dirname(targets[index]), { recursive: true });
            await clearFolder(targets[index]);
            await writeAtomically(targets[index], bytes);
          }
          for (const [index, bytes] of next.entries()) if (!sameBytes(await fileBytes(targets[index]), bytes)) return false;
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
