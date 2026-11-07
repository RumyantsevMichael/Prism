import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { ARTIFACTS } from "./artifact-paths.mjs";
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

// A repository registration syncs as a record, so a registration made on two machines keeps the upstream one instead of failing the merge.
const isRegistrationFile = (relative) => /^repositories\/[^/]+\.json$/.test(relative);
const isRecordFile = (relative) => relative === "roadmap.json" || relative.startsWith("initiatives/") || isRegistrationFile(relative);
const isClaimFile = (relative) => /^initiatives\/[^/]+\/claims\/[^/]+\.json$/.test(relative);
// A claim or a registration that lost a race is its holder's news, reported through the refusal or acceptance it causes, so no conflict list shows it.
const isQuietConflict = (relative) => isClaimFile(relative) || isRegistrationFile(relative);
const syncPath = (base, ...parts) => path.join(base, SYNC_DIRECTORY, ...parts);

function gitEnvironment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !REDIRECTING.test(name)));
  // An SSH password or host-key prompt would hang a sync that holds the store lock, so SSH never asks unless the user configured it.
  const ssh = env.GIT_SSH_COMMAND || env.GIT_SSH ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  return { ...env, ...ssh, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", LC_ALL: "C", ...extra };
}

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

function git(base, args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile("git", ["-C", base, ...args], { env: gitEnvironment(env), timeout: SETTINGS.gitTimeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
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
  return { state: shown.length ? "conflicts" : "ok", conflicts: shown, message: shown.length ? "Concurrent record changes were resolved for the upstream; the local versions are saved." : "" };
}

async function savedFiles(directory) {
  const files = [];
  const visit = async (relative) => {
    let entries = [];
    try { entries = await readdir(path.join(directory, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      // A claim or a registration that lost to the upstream is reported by its own refusal, its holder's notice of a lost claim, or the next name check.
      else if (entry.isFile() && isRecordFile(child) && !isQuietConflict(child)) files.push(child);
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

/** Local record versions that a sync saved because the upstream changed the same record, in stores this process uses, since this process started and not reported before. */
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
      for (const file of await savedFiles(path.join(directory, stamp))) found.push({ record: `.prism/${file}`, savedAs: path.join(directory, stamp, file), at: new Date(at).toISOString() });
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
      return await withFileLock(syncPath(base, "sync"), () => sync(base, options), undefined, { timeoutMs: 1, renew: true, abandonWhenUnrenewed: true, staleMs: SETTINGS.gitTimeoutMs * 2 });
    } catch (error) {
      // The holder may have committed before this process wrote, so a later sync picks the change up.
      if (error.code === "lock_timeout") { scheduleRecordSync(base); return { state: "skipped" }; }
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

async function commitLocal(base, author) {
  await required(base, ["add", "-A", "--", "."]);
  // Only the store's own ignore files decide what it tracks: the person's core.excludesFile and the store's info/exclude would leave files that other machines share uncommitted.
  const leftOut = (await required(base, ["ls-files", "-z", "--others", "--exclude-per-directory=.gitignore", "--", "."])).stdout;
  if (leftOut.length) await required(base, ["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: leftOut });
  // A store whose ignore file predates the sync folder, or lists no lock files, still never commits the sync folder or the registration lock.
  await required(base, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", SYNC_DIRECTORY, "repositories.lock"]);
  const staged = (await required(base, ["diff", "--cached", "--name-only", "-z"])).stdout.toString("utf8").split("\0").filter(Boolean);
  if (!staged.length) return false;
  const listed = staged.slice(0, COMMIT_LIST).join("\n") + (staged.length > COMMIT_LIST ? `\n… and ${staged.length - COMMIT_LIST} more` : "");
  await required(base, [...author, "commit", "--quiet", "-m", "prism: update records", "-m", listed]);
  return true;
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

async function sync(base, options) {
  const top = await git(base, ["rev-parse", "--show-toplevel"]);
  if (top.missing) return writeStatus(base, { state: "not_a_repository", message: "Git is not available, so the record store is not synced." });
  if (!top.ok || path.resolve(top.text) !== path.resolve(base)) return writeStatus(base, { state: "not_a_repository", message: "The record store is not the top of a Git checkout, so it is not synced." });
  const author = await identity(base);
  await commitLocal(base, author);
  let upstream = await upstreamOf(base);
  if (!upstream && managed.has(base)) {
    const published = await publishBranch(base, options);
    if (published.status) return writeStatus(base, published.status);
    upstream = published.upstream;
  }
  if (!upstream) return writeStatus(base, { state: "no_upstream", message: "The store's branch has no upstream, so records are committed locally only." });
  const conflicts = [];
  let busy = false;
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    // A merge left unapplied keeps the branch where it was, so files it replaced and local writes are committed and merged again.
    if (attempt > 1) await commitLocal(base, author);
    const fetched = await git(base, ["fetch", "--quiet", upstream.remote]);
    if (!fetched.ok) return writeStatus(base, { state: "fetch_failed", message: fetched.stderr, ...await counts(base) });
    lastFetch.set(base, Date.now());
    const merged = await merge(base, author, options);
    if (merged.failed) return writeStatus(base, { state: "merge_failed", message: merged.failed, ...await counts(base) });
    busy = !merged.applied;
    if (busy) continue;
    conflicts.push(...merged.conflicts);
    const { ahead } = await counts(base);
    if (!ahead && !(await unpublished(base))) return writeStatus(base, settled(conflicts));
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
async function publishBranch(base, options) {
  const branch = (await git(base, ["symbolic-ref", "--quiet", "--short", "HEAD"])).text;
  if (!branch || !(await git(base, ["config", "--local", "--get", "remote.origin.url"])).ok) return { upstream: null };
  const fetched = await git(base, ["fetch", "--quiet", "origin"]);
  if (!fetched.ok) return { status: { state: "fetch_failed", message: fetched.stderr } };
  lastFetch.set(base, Date.now());
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const theirs = await git(base, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  if (theirs.ok) {
    // An unborn branch has nothing local to keep, so it takes the pushed branch's files before it tracks it.
    if (!head.ok && !(await apply(base, null, theirs.text, options))) return { status: { state: "merge_failed", message: "Record files changed or stayed locked while the upstream was applied, so the next sync applies it again." } };
    await required(base, ["branch", "--quiet", `--set-upstream-to=origin/${branch}`, branch]);
    return { upstream: await upstreamOf(base) };
  }
  if (!head.ok) return { status: { state: "ok", message: "The store and its remote are still empty, so there is nothing to sync yet." } };
  await options.beforePush?.();
  const pushed = await git(base, ["push", "--quiet", "-u", "origin", "HEAD"]);
  if (!pushed.ok) return { status: { state: "push_rejected", message: pushed.stderr } };
  return { upstream: await upstreamOf(base) };
}

const changedPaths = async (base, from, to) => (await required(base, ["diff", "--name-only", "--no-renames", "-z", from, to])).stdout.toString("utf8").split("\0").filter(Boolean);

// Merge the fetched upstream without touching the working tree, then replace changed files one by one atomically.
async function merge(base, author, options) {
  const upstream = await git(base, ["rev-parse", "--verify", "--quiet", "@{upstream}"]);
  if (!upstream.ok) return { applied: true, conflicts: [] };
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const theirs = upstream.text;
  if (head.ok && (await git(base, ["merge-base", "--is-ancestor", theirs, head.text])).ok) return { applied: true, conflicts: [] };
  if (!head.ok || (await git(base, ["merge-base", "--is-ancestor", head.text, theirs])).ok) return { applied: await apply(base, head.ok ? head.text : null, theirs, options), conflicts: [] };
  const result = await git(base, ["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", head.text, theirs]);
  if (result.code !== 0 && result.code !== 1) return { failed: result.stderr || "Git could not merge the upstream; Git 2.38 or later is required.", conflicts: [] };
  const [mergedTree, ...listed] = result.stdout.toString("utf8").split("\0").filter(Boolean);
  const lineConflicts = [...new Set(listed)];
  const other = lineConflicts.filter((file) => !isRecordFile(file));
  if (other.length) return { failed: `The upstream conflicts with local changes to ${other.slice(0, 5).join(", ")}, so the store was left as it was.`, conflicts: [] };
  const merges = await structuralMerges(base, head.text, theirs);
  const conflicted = [...new Set([...lineConflicts, ...merges.fallback])].filter((file) => !merges.merged.has(file));
  let tree = mergedTree;
  if (conflicted.length || merges.merged.size) {
    // The upstream version wins, as the first push does for a stale revision, and the local version is kept beside the store once the merge applies.
    // A record merged by structure takes its merged blob instead of Git's line merge.
    const index = syncPath(base, "merge-index");
    const env = { GIT_INDEX_FILE: index };
    await rm(index, { force: true });
    await required(base, ["read-tree", mergedTree], { env });
    for (const file of conflicted) {
      const entry = (await required(base, ["ls-tree", "-z", theirs, "--", file])).stdout;
      await required(base, ["update-index", "-z", "--index-info"], { env, input: entry.length ? entry : `0 ${"0".repeat(40)}\t${file}\0` });
    }
    for (const [file, contents] of merges.merged) {
      const object = (await required(base, ["hash-object", "-w", "--stdin"], { input: contents })).text;
      await required(base, ["update-index", "-z", "--index-info"], { env, input: `100644 ${object}\t${file}\0` });
    }
    tree = (await required(base, ["write-tree"], { env })).text;
    await rm(index, { force: true });
  }
  const commit = (await required(base, [...author, "commit-tree", tree, "-p", head.text, "-p", theirs, "-m", `prism: merge records from ${(await git(base, ["rev-parse", "--abbrev-ref", "@{upstream}"])).text || "upstream"}`])).text;
  if (!(await apply(base, head.text, commit, options))) return { applied: false, conflicts: [] };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const conflicts = [];
  for (const file of conflicted) {
    const local = await git(base, ["cat-file", "blob", `${head.text}:${file}`]);
    const savedAs = `${SYNC_DIRECTORY}/conflicts/${stamp}/${file}`;
    if (local.ok) {
      await mkdir(path.dirname(path.join(base, savedAs)), { recursive: true });
      await writeAtomically(path.join(base, savedAs), local.stdout);
    }
    conflicts.push({ path: file, savedAs: local.ok ? savedAs : null });
  }
  return { applied: true, conflicts };
}

/**
 * Merge by structure every record that changed on both sides since the merge base and whose kind registers a merge, whether or not Git's line merge conflicts,
 * because a clean line merge of JSON can still be wrong or non-canonical.
 * A registration changed on both sides keeps the upstream version whole, even when Git's line merge is clean, so no machine keeps a mix of two registrations.
 * A record removed on either side keeps Git's whole-file handling.
 * Returns the merged contents by path, and the paths whose merge found a conflict or an invalid result, which fall back to the upstream version.
 */
async function structuralMerges(base, head, theirs) {
  const merged = new Map();
  const fallback = [];
  const mergeBase = await git(base, ["merge-base", head, theirs]);
  if (!mergeBase.ok || !mergeBase.text) return { merged, fallback };
  const ours = new Set(await changedPaths(base, mergeBase.text, head));
  const both = (await changedPaths(base, mergeBase.text, theirs)).filter((file) => ours.has(file) && (hasRecordMerge(file) || isRegistrationFile(file)));
  for (const file of both) {
    const [original, local, upstream] = await Promise.all([mergeBase.text, head, theirs].map((commit) => blob(base, commit, file)));
    if (local === null || upstream === null || local.equals(upstream)) continue;
    if (isRegistrationFile(file)) { fallback.push(file); continue; }
    const mergeRecord = await recordMergeFor(file);
    let outcome;
    try {
      outcome = await mergeRecord({ path: file, base: original?.toString("utf8") ?? null, local: local.toString("utf8"), upstream: upstream.toString("utf8") });
    } catch (error) {
      outcome = { conflict: error.message };
    }
    if (typeof outcome?.contents === "string") merged.set(file, Buffer.from(outcome.contents, "utf8"));
    else fallback.push(file);
  }
  return { merged, fallback };
}

const blob = async (base, commit, file) => {
  const result = commit ? await git(base, ["cat-file", "blob", `${commit}:${file}`]) : { ok: false };
  return result.ok ? result.stdout : null;
};
const fileBytes = (target) => readFile(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
const sameBytes = (left, right) => left === null || right === null ? left === right : left.equals(right);

// Every changed file's record lock is held from the first check until the branch moves, so no locked record write lands in between.
// When an artifact changes, the store's artifact lock, which an artifact update holds from its version checks to its writes, is taken first, so neither lands between the other's check and write.
async function holdLocks(targets, action) {
  if (!targets.length) return action();
  return withFileLock(targets[0], () => holdLocks(targets.slice(1), action), undefined, { timeoutMs: SETTINGS.applyLockMs });
}

/**
 * Replace the files that differ between two commits by atomic renames, then move the branch and index to the target commit.
 * The branch moves only when every changed file held the previous commit's bytes and holds the target's bytes afterwards.
 * Otherwise the branch stays, so the next commit records the replaced files and the local writes, and the next merge resolves them.
 */
async function apply(base, from, to, options) {
  const marker = syncPath(base, "working-tree");
  await writeAtomically(marker, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  let files = [];
  try {
    await options.beforeApply?.();
    files = from ? await changedPaths(base, from, to) : (await required(base, ["ls-tree", "-r", "--name-only", "-z", to])).stdout.toString("utf8").split("\0").filter(Boolean);
    const targets = files.map((file) => path.join(base, file));
    const artifactLock = files.some((file) => file.startsWith(`${ARTIFACTS}/`)) ? [path.join(base, ARTIFACTS)] : [];
    // Folders under artifacts/ are made and removed only while the artifact lock is held, so none appears or vanishes between an update's layout check and its last write.
    return await holdLocks(artifactLock, async () => {
      try {
        for (const target of targets) await mkdir(path.dirname(target), { recursive: true });
        return await holdLocks(targets, async () => {
          const next = [];
          for (const [index, file] of files.entries()) {
            if (!sameBytes(await fileBytes(targets[index]), await blob(base, from, file))) return false;
            next.push(await blob(base, to, file));
          }
          for (const [index, bytes] of next.entries()) {
            if (bytes === null) await rm(targets[index], { force: true });
            else await writeAtomically(targets[index], bytes);
          }
          for (const [index, bytes] of next.entries()) if (!sameBytes(await fileBytes(targets[index]), bytes)) return false;
          await required(base, ["update-ref", "-m", "prism: sync records", "HEAD", to, ...(from ? [from] : [])]);
          await required(base, ["read-tree", to]);
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
