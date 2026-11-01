import { execFile } from "node:child_process";
import { mkdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeAtomically } from "./artifact-store.mjs";

// A record store that is a Git checkout exchanges its records with its upstream.
// One process at a time syncs a store, and record reads and writes wait while a merge replaces record files.
export const SYNC_DIRECTORY = ".prism-sync";
const SETTINGS = { debounceMs: 5000, pullIntervalMs: 30000, waitMs: 10000, gitTimeoutMs: 120000 };
const PUSH_ATTEMPTS = 3;
const COMMIT_LIST = 20;
const scheduled = new Map();
const running = new Map();
const lastFetch = new Map();
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
}

const isRecordFile = (relative) => relative === "roadmap.json" || relative.startsWith("initiatives/");
const syncPath = (base, ...parts) => path.join(base, SYNC_DIRECTORY, ...parts);

function gitEnvironment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !REDIRECTING.test(name)));
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", LC_ALL: "C", ...extra };
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
  clearTimeout(scheduled.get(base));
  const timer = setTimeout(() => {
    scheduled.delete(base);
    syncRecordStore(base).catch(() => {});
  }, SETTINGS.debounceMs);
  timer.unref();
  scheduled.set(base, timer);
}

/** Start a background sync after a record read when the last fetch is older than the pull interval; the read never waits for it. */
export function pullRecordStoreIfStale(base) {
  if (running.has(base) || Date.now() - (lastFetch.get(base) ?? 0) < SETTINGS.pullIntervalMs) return;
  lastFetch.set(base, Date.now());
  syncRecordStore(base).catch(() => {});
}

/** The latest sync outcome of a store, or null before its first sync. */
export async function readSyncStatus(base) {
  try { return JSON.parse(await readFile(syncPath(base, "status.json"), "utf8")); }
  catch { return null; }
}

async function writeStatus(base, status) {
  const value = { at: new Date().toISOString(), state: "ok", ahead: 0, behind: 0, conflicts: [], message: "", ...status };
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
      return writeStatus(base, { state: "fetch_failed", message: error.message }).catch(() => ({ state: "fetch_failed", message: error.message }));
    }
  })().finally(() => running.delete(base));
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
  // A store whose ignore file predates the sync folder still never commits it.
  await required(base, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", SYNC_DIRECTORY]);
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

async function sync(base, options) {
  const top = await git(base, ["rev-parse", "--show-toplevel"]);
  if (top.missing) return writeStatus(base, { state: "not_a_repository", message: "Git is not available, so the record store is not synced." });
  if (!top.ok || path.resolve(top.text) !== path.resolve(base)) return writeStatus(base, { state: "not_a_repository", message: "The record store is not the top of a Git checkout, so it is not synced." });
  const author = await identity(base);
  await commitLocal(base, author);
  const upstream = await upstreamOf(base);
  if (!upstream) return writeStatus(base, { state: "no_upstream", message: "The store's branch has no upstream, so records are committed locally only." });
  const conflicts = [];
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    const fetched = await git(base, ["fetch", "--quiet", upstream.remote]);
    if (!fetched.ok) return writeStatus(base, { state: "fetch_failed", message: fetched.stderr, ...await counts(base) });
    lastFetch.set(base, Date.now());
    const merged = await merge(base, author, options);
    if (merged.failed) return writeStatus(base, { state: "merge_failed", message: merged.failed, ...await counts(base) });
    conflicts.push(...merged.conflicts);
    const { ahead } = await counts(base);
    if (!ahead) return writeStatus(base, { state: conflicts.length ? "conflicts" : "ok", conflicts, message: conflicts.length ? "Concurrent record changes were resolved for the upstream; the local versions are saved." : "" });
    await options.beforePush?.();
    const pushed = await git(base, ["push", "--quiet", upstream.remote, `HEAD:${upstream.merge}`]);
    if (pushed.ok) return writeStatus(base, { state: conflicts.length ? "conflicts" : "ok", conflicts, message: conflicts.length ? "Concurrent record changes were resolved for the upstream; the local versions are saved." : "", ...await counts(base) });
    if (!/rejected|fetch first|non-fast-forward/i.test(pushed.stderr)) return writeStatus(base, { state: "push_rejected", conflicts, message: pushed.stderr, ...await counts(base) });
  }
  return writeStatus(base, { state: "push_rejected", conflicts, message: `The push was rejected ${PUSH_ATTEMPTS} times because others pushed first.`, ...await counts(base) });
}

const changedPaths = async (base, from, to) => (await required(base, ["diff", "--name-only", "--no-renames", "-z", from, to])).stdout.toString("utf8").split("\0").filter(Boolean);

// Merge the fetched upstream without touching the working tree, then replace changed files one by one atomically.
async function merge(base, author, options) {
  const upstream = await git(base, ["rev-parse", "--verify", "--quiet", "@{upstream}"]);
  if (!upstream.ok) return { conflicts: [] };
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const theirs = upstream.text;
  if (head.ok && (await git(base, ["merge-base", "--is-ancestor", theirs, head.text])).ok) return { conflicts: [] };
  if (!head.ok || (await git(base, ["merge-base", "--is-ancestor", head.text, theirs])).ok) {
    await apply(base, head.ok ? head.text : null, theirs, theirs, options);
    return { conflicts: [] };
  }
  const result = await git(base, ["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", head.text, theirs]);
  if (result.code !== 0 && result.code !== 1) return { failed: result.stderr || "Git could not merge the upstream; Git 2.38 or later is required.", conflicts: [] };
  const [mergedTree, ...listed] = result.stdout.toString("utf8").split("\0").filter(Boolean);
  const conflicted = [...new Set(listed)];
  const other = conflicted.filter((file) => !isRecordFile(file));
  if (other.length) return { failed: `The upstream conflicts with local changes to ${other.slice(0, 5).join(", ")}, so the store was left as it was.`, conflicts: [] };
  let tree = mergedTree;
  const conflicts = [];
  if (conflicted.length) {
    // The upstream version wins, as the first push does for a stale revision, and the local version is kept beside the store.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const index = syncPath(base, "merge-index");
    const env = { GIT_INDEX_FILE: index };
    await rm(index, { force: true });
    await required(base, ["read-tree", mergedTree], { env });
    for (const file of conflicted) {
      const local = await git(base, ["cat-file", "blob", `${head.text}:${file}`]);
      const savedAs = `${SYNC_DIRECTORY}/conflicts/${stamp}/${file}`;
      if (local.ok) {
        await mkdir(path.dirname(path.join(base, savedAs)), { recursive: true });
        await writeAtomically(path.join(base, savedAs), local.stdout);
      }
      conflicts.push({ path: file, savedAs: local.ok ? savedAs : null });
      const entry = (await required(base, ["ls-tree", "-z", theirs, "--", file])).stdout;
      await required(base, ["update-index", "-z", "--index-info"], { env, input: entry.length ? entry : `0 ${"0".repeat(40)}\t${file}\0` });
    }
    tree = (await required(base, ["write-tree"], { env })).text;
    await rm(index, { force: true });
  }
  const commit = (await required(base, [...author, "commit-tree", tree, "-p", head.text, "-p", theirs, "-m", `prism: merge records from ${(await git(base, ["rev-parse", "--abbrev-ref", "@{upstream}"])).text || "upstream"}`])).text;
  await apply(base, head.text, commit, commit, options);
  return { conflicts };
}

// Each changed file is replaced by an atomic rename under its record lock, and only while it still holds the committed bytes.
// A record written locally since the last commit keeps its bytes and is committed by the next sync.
async function apply(base, from, to, commit, options) {
  const marker = syncPath(base, "working-tree");
  await writeAtomically(marker, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try {
    await options.beforeApply?.();
    const files = from ? await changedPaths(base, from, to) : (await required(base, ["ls-tree", "-r", "--name-only", "-z", to])).stdout.toString("utf8").split("\0").filter(Boolean);
    for (const file of files) {
      const target = path.join(base, file);
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await withFileLock(target, async () => {
          const before = from ? await git(base, ["cat-file", "blob", `${from}:${file}`]) : { ok: false };
          const current = await readFile(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
          if (!(before.ok ? current !== null && current.equals(before.stdout) : current === null)) return;
          const next = await git(base, ["cat-file", "blob", `${to}:${file}`]);
          if (next.ok) await writeAtomically(target, next.stdout);
          else await rm(target, { force: true });
        }, undefined, { timeoutMs: 2000 });
      } catch (error) { if (error.code !== "lock_timeout") throw error; }
      // A removed record leaves no empty folder behind, so listings never show it.
      for (let folder = path.dirname(target); folder !== base; folder = path.dirname(folder)) if (!(await rmdir(folder).then(() => true, () => false))) break;
    }
    const old = from ?? "";
    await required(base, ["update-ref", "-m", "prism: sync records", "HEAD", commit, ...(old ? [old] : [])]);
    await required(base, ["read-tree", commit]);
  } finally {
    await rm(marker, { force: true });
  }
}
