import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY, ARTIFACT_MIGRATIONS, ARTIFACT_STATUS, ARTIFACTS, IDENTITY_FILE_MAX, identityContent, identityOf, letterCaseKey, locationIdentity, STATUS_RECORD_NAME, uniqueIdentities, portableName, STORE_NAME_BYTES_MAX, STORE_PATH_BYTES_MAX, storePathFits, wellFormedName } from "./artifact-paths.mjs";
import { markArtifactIndexStale } from "./artifact-index.mjs";
import { renameWhenFree, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { commitProblem, gitFileName, isLinkMode, LINK_TARGET_BYTES_MAX, linkTargetProblem, TREE_DEPTH_MAX, TREE_DEPTH_TEXT, tooDeepTree, treeEntries, treeProblems } from "./git-objects.mjs";
import { canonicalJson, hasRecordMerge, nestedDeeperThan, recordMergeFor } from "./record-merge.mjs";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { localRepository, localTransport, UnresolvableLocalRemote } from "./git-local-repository.mjs";
import { withoutCredentials } from "./remote-url.mjs";
import { parseStoreJson } from "./store-json.mjs";

// A record store that is a Git checkout exchanges its records with its upstream.
// One process at a time syncs a store, and record reads and writes wait while a merge replaces record files.
export const SYNC_DIRECTORY = ".prism-sync";
// treeFilesMax, when set, stands in for the bound on a store tree's files, and historyBytesMax for the bound on a listing of the history that the remote lacks, so a test can reach either with a small store.
const SETTINGS = { debounceMs: 5000, pullIntervalMs: 30000, waitMs: 10000, applyLockMs: 2000, gitTimeoutMs: 120000, treeFilesMax: null, historyBytesMax: null };
// A short-lived process, such as a hook, reads the clone as it is: a pull it starts would outlive its host's time limit and be killed partway.
let pullOnRead = true;
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

// The log that sync outcomes are written to, which a server process passes; this module is also loaded where the log is not, so it writes nothing until one is given.
let log = null;

/**
 * Change the debounce, pull interval, or torn-read wait, or the bound on a store tree's files, which tests shorten, turn off the pull that a record read starts,
 * turn on the watcher that syncs what is pending when the process ends, or give the log, an object with info and warn, that sync outcomes are written to.
 */
export function configureRecordSync(settings = {}) {
  for (const key of Object.keys(SETTINGS)) if (Number.isFinite(settings[key])) SETTINGS[key] = settings[key];
  if (typeof settings.pullOnRead === "boolean") pullOnRead = settings.pullOnRead;
  if (typeof settings.watchPending === "boolean") watchPending = settings.watchPending;
  if (settings.log !== undefined) log = settings.log;
}

/** Cancel every debounced sync and forget fetch times, so a process or a test can finish. */
export function cancelRecordSyncs() {
  for (const timer of scheduled.values()) clearTimeout(timer);
  scheduled.clear();
  lastFetch.clear();
  rerun.clear();
  written.clear();
}

// The script that finishes the syncs a process hands off when it ends.
const HANDOFF_SCRIPT = new URL("./record-store-handoff.mjs", import.meta.url);
// A long-lived process, such as the MCP server, turns on a watcher process while it has syncs pending, since a host may end it in a way that runs none of its code.
let watchPending = false;
let watcher = null;
let watcherList = "";
// Stores with a record write that no sync has started on, and stores whose running sync started on one; a sync that only pulls is not pending.
const written = new Set();
const writing = new Set();

const handOffOff = () => process.env.PRISM_STORE_HANDOFF === "off";
const pendingStores = () => [...new Set([...written, ...writing, ...rerun])].map((base) => ({ base, managed: managed.has(base) }));

function startWatcher() {
  try {
    const child = spawn(process.execPath, [fileURLToPath(HANDOFF_SCRIPT)], { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.once("exit", () => { if (watcher === child) { watcher = null; watcherList = ""; } });
    child.unref();
    child.stdin.unref?.();
    return child;
  } catch {
    // The next Prism process to sync the store pushes what this one wrote.
    return null;
  }
}

// Tell the watcher which stores have a sync pending, starting it on the first one and ending it once none is left.
// It syncs the last list it was told when its input closes, which happens however this process ends: a signal, Windows' forced end, or SIGKILL.
function updateWatcher() {
  if (!watchPending || handOffOff()) return;
  const stores = pendingStores();
  if (!stores.length && !watcher) return;
  const list = JSON.stringify(stores);
  if (list === watcherList) return;
  watcher ??= startWatcher();
  if (!watcher) return;
  watcherList = list;
  if (stores.length) { watcher.stdin.write(`${list}\n`); return; }
  watcher.stdin.end(`${list}\n`);
  watcher = null;
  watcherList = "";
}

/**
 * Hand every store whose debounced sync has not run, or whose sync is running or due again, to the detached watcher process, which syncs it and exits, then cancel this process's syncs.
 * A host can end a session within a fraction of a second, before the debounce comes due, so a process that ends calls this to push the records it wrote; it returns the stores handed off.
 */
export function handOffRecordSyncs() {
  const stores = pendingStores();
  cancelRecordSyncs();
  // A test suite turns the hand-off off, so no detached process writes a folder that a test removes.
  if (handOffOff()) return [];
  const child = watcher ?? (stores.length ? startWatcher() : null);
  watcher = null;
  watcherList = "";
  child?.stdin.end(`${JSON.stringify(stores)}\n`);
  return stores.map((store) => store.base);
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
// An artifact's status record, its identity, and its accepted bytes change with the artifact under the artifact lock, so a sync stages them with the artifacts, and a status record that changed on both sides keeps the upstream one as a record does.
// The ledger of a move of a checkout's artifacts, and each comment on an artifact, are written under the same lock, so no commit holds the ledger without the artifacts it lists.
const STATUS_FOLDERS = [ARTIFACT_STATUS, ARTIFACT_ACCEPTED, ARTIFACT_COMMENTS, ARTIFACT_IDENTITY, ARTIFACT_MIGRATIONS];
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

// The most bytes of Git output that a sync takes whole, from one command whose output is bounded by construction: a constant answer, one line for each item that the sync handed it, or a merge of three files within their bounds.
// Every output that can grow with a store's content or history is read record by record through gitRecords instead, with a bound on its records and their bytes.
const GIT_OUTPUT_MAX = 64 * 1024 * 1024;
// The most bytes of Git's error output that a sync keeps, which a remote's messages could otherwise grow without end.
const GIT_ERRORS_MAX = 64 * 1024;

function git(base, args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile("git", [...FIXED_CONFIG, "-C", base, ...args], { env: gitEnvironment(env), timeout: SETTINGS.gitTimeoutMs, maxBuffer: GIT_OUTPUT_MAX, encoding: "buffer", windowsHide: true }, (error, stdout, stderr) => {
      // Nothing here may throw, since a throw in this callback would end the process rather than the sync.
      try {
        const over = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const errors = over ? `git ${args[0]} printed more than ${GIT_OUTPUT_MAX} bytes, more than a sync takes from one command.` : stderr.subarray(0, GIT_ERRORS_MAX).toString("utf8").trim();
        resolve({ ok: !error, code: error ? (typeof error.code === "number" ? error.code : -1) : 0, missing: error?.code === "ENOENT", stdout, text: over ? "" : stdout.toString("utf8").trim(), stderr: errors });
      } catch (failure) {
        resolve({ ok: false, code: -1, missing: false, stdout: Buffer.alloc(0), text: "", stderr: `git ${args[0]} failed: ${failure.message}` });
      }
    });
    child.stdin?.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
  });
}

/**
 * Run Git and take its output as records, each ended by the separator byte, as they arrive rather than from one buffer: take receives each record's bytes,
 * and Git is stopped once more than limit records arrived, once the records hold more than maxBytes bytes in all, or once one record holds more than maxRecord bytes,
 * so a listing never takes more memory or time than its bounds allow, whatever the tree or history holds.
 * With separator null, take receives the output's chunks as they arrive, bounded by maxBytes alone.
 * take may return a promise, and the output waits for it, so a reader can act on a batch of records before more arrive; take returning false stops the listing.
 * Returns { ok, over, long, stopped, stderr }: over is "count" or "bytes" when a bound on all records was passed, long holds the first bytes of a record above maxRecord, and stopped says take stopped it.
 */
function gitRecords(base, args, { separator, limit = Infinity, maxBytes = Infinity, maxRecord = Infinity, take, input, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn("git", [...FIXED_CONFIG, "-C", base, ...args], { env: gitEnvironment(env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let count = 0, bytes = 0, over = null, long = null, stopped = false, failure = null, done = false;
    const errors = [];
    let errorBytes = 0;
    const stop = () => { done = true; child.kill(); };
    // A record is checked against every bound before take sees it, so nothing past a bound is kept.
    const record = async (bytesOf) => {
      if (bytesOf.length > maxRecord) { long = Buffer.from(bytesOf.subarray(0, 512)); return false; }
      if (++count > limit) { over = "count"; return false; }
      if ((bytes += bytesOf.length + 1) > maxBytes) { over = "bytes"; return false; }
      try {
        const kept = await take(bytesOf);
        if (kept === false) { stopped = true; return false; }
      } catch (error) { failure = error.message; return false; }
      return true;
    };
    const timer = setTimeout(() => { failure ??= `git ${args[0]} took longer than ${SETTINGS.gitTimeoutMs} ms.`; done = true; child.kill("SIGKILL"); }, SETTINGS.gitTimeoutMs);
    child.stderr.on("data", (chunk) => { if (errorBytes < GIT_ERRORS_MAX) { errors.push(chunk); errorBytes += chunk.length; } });
    child.stdin.on("error", () => {});
    child.on("error", (error) => { failure ??= error.code === "ENOENT" ? "Git is not available." : error.message; });
    const reading = (async () => {
      let pending = Buffer.alloc(0);
      try {
        for await (const chunk of child.stdout) {
          if (done) continue;
          if (separator === null) {
            if ((bytes += chunk.length) > maxBytes) { over = "bytes"; stop(); continue; }
            try { if ((await take(chunk)) === false) { stopped = true; stop(); } } catch (error) { failure = error.message; stop(); }
            continue;
          }
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          let at = 0;
          for (let end; !done && (end = pending.indexOf(separator, at)) >= 0; at = end + 1) if (!(await record(pending.subarray(at, end)))) stop();
          if (done) { pending = Buffer.alloc(0); continue; }
          pending = Buffer.from(pending.subarray(at));
          // A record that has not ended yet is held only up to its bound.
          if (pending.length > maxRecord) { long = Buffer.from(pending.subarray(0, 512)); pending = Buffer.alloc(0); stop(); }
        }
      } catch (error) { if (!done) failure ??= error.message; }
      return pending;
    })();
    child.on("close", async (code) => {
      const pending = await reading;
      clearTimeout(timer);
      if (!done && !failure && pending.length && separator !== null) await record(pending);
      const stderr = failure ?? Buffer.concat(errors).toString("utf8").trim();
      resolve({ ok: Boolean(over || long || stopped) || (!failure && code === 0), over, long, stopped, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

// A refusal of Git output past the bound that a sync reads it within, which the sync reports by name as it reports an entry that no store may hold, and never as a failure of the process.
// The sync stops where the refusal arises, so a refusal of the history that a push would send says that the branch was not pushed, and any other one that the sync went no further.
const outputRefusal = (text, fix = "", outcome = "the sync went no further") => Object.assign(new Error(`${text}, so ${outcome}.${fix ? ` ${fix}` : ""}`), { unsafePath: true, outputBound: true });

/**
 * The most bytes of a listing of the history that the remote lacks, or of the contents of its commits and trees, that a sync reads, and the most records of such a listing:
 * far above what years of syncs list, since each sync's commit changes a few files, so only a history that commits made by hand grew, or whose trees change far more than a store's, passes them.
 * A listing past either bound is stopped there, and the push is refused by name.
 */
const HISTORY_BYTES_MAX = 256 * 1024 * 1024;
const historyBytesMax = () => SETTINGS.historyBytesMax ?? HISTORY_BYTES_MAX;
const historyRecordsMax = () => Math.floor(historyBytesMax() / 32);
const HISTORY_FIX = "Take the commits made by hand that the remote lacks off the store's branch, such as by running git reset --soft with the tip of the remote's branch in the store, which keeps every file on disk, and the next sync commits the store's files again.";
// A refusal of one commit's listing names that commit, which only a commit made by hand makes so large, and the command that takes it off with every later commit while every file stays on disk:
// a soft reset to the commit before it, or, where it is the branch's first, which Git cannot reset to before, the removal of the branch's ref, as resetAdvice gives it.
const historyRefusal = (what, commit = null, first = false) => outputRefusal(`Git's listing of ${what} holds more than ${historyBytesMax()} bytes or ${historyRecordsMax()} entries, more than a sync reads${commit ? " for one commit" : ""}`,
  !commit ? HISTORY_FIX : first
    ? "Take that commit made by hand off the store's branch, such as by running git update-ref -d HEAD in the store, which keeps every file on disk and takes every commit off the branch, since that commit is its first, and the next sync commits the store's files again."
    : `Take that commit made by hand off the store's branch, such as by running git reset --soft ${commit}^ in the store, which keeps every file on disk and takes off every later commit too, and the next sync commits the store's files again.`,
  "the store's branch was not pushed");
async function commitRefusal(base, what, commit) {
  const parent = await git(base, ["rev-parse", "--verify", "--quiet", `${commit}^1`]);
  return historyRefusal(what, commit, !(parent.ok && parent.text));
}

// The most branches or shared commits of a remote that a sync lists, far above the few that a store's remote holds, since a sync checks each of them against the branch.
const REMOTE_REFS_MAX = 4096;

// The commits that a rev-list prints, read within the bounds of a history listing.
async function historyCommits(base, args, input, env = {}) {
  const commits = [];
  const listed = await gitRecords(base, args, { separator: 10, limit: historyRecordsMax(), maxBytes: historyBytesMax(), maxRecord: 128, input, env, take: (line) => { if (line.length) commits.push(line.toString("latin1")); } });
  if (listed.over || listed.long) throw historyRefusal("the commits that the remote lacks");
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || `git ${args[0]} failed.`), { git: listed });
  return commits;
}

/**
 * The lines of a Git command whose output is one line for each item that the sync handed it, or a few lines of a constant form, read through gitRecords within limit lines of at most maxRecord bytes each.
 * A command that prints more is stopped and refused by what it lists, and one that fails throws with Git's message.
 */
async function gitLines(base, args, options) {
  const listed = await gitLinesResult(base, args, options);
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || `git ${args[0]} failed.`), { git: listed });
  return listed.lines;
}
// The same lines as { ok, lines, stderr }, for a caller that tries again when Git fails; output past the bounds is still refused.
async function gitLinesResult(base, args, { input, env, limit, maxRecord = 512, what = `the output of git ${args[0]}` }) {
  const lines = [];
  const listed = await gitRecords(base, args, { separator: 10, limit, maxBytes: limit * (maxRecord + 1), maxRecord, input, env, take: (line) => { lines.push(line.toString("utf8")); } });
  if (listed.over || listed.long) throw outputRefusal(`Git's listing of ${what} holds more than ${listed.long ? `${maxRecord} bytes in one line` : `${limit} lines`}, more than a sync reads`);
  return { ok: listed.ok, lines, stderr: listed.stderr };
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
      execFile("git", ["--version"], { env: gitEnvironment(), timeout: SETTINGS.gitTimeoutMs, windowsHide: true }, (error, stdout) => {
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
    const owner = parseStoreJson(await readFile(marker, "utf8"));
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

/** Debounce a sync after a record write, or after a sync that must run again, which carries a write only when the one it repeats did; a sync problem never reaches the write. */
export function scheduleRecordSync(base, carriesWrite = true) {
  watched.add(base);
  if (carriesWrite) written.add(base);
  clearTimeout(scheduled.get(base));
  const timer = setTimeout(() => {
    scheduled.delete(base);
    if (running.has(base)) rerun.add(base);
    else syncRecordStore(base).catch(() => {});
    updateWatcher();
  }, SETTINGS.debounceMs);
  timer.unref();
  scheduled.set(base, timer);
  updateWatcher();
}

/** Start a background sync after a record read when the last fetch is older than the pull interval; the read never waits for it. */
export function pullRecordStoreIfStale(base) {
  watched.add(base);
  if (!pullOnRead || running.has(base) || Date.now() - (lastFetch.get(base) ?? 0) < SETTINGS.pullIntervalMs) return;
  lastFetch.set(base, Date.now());
  syncRecordStore(base).catch(() => {});
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const stampTime = (stamp) => Date.parse(stamp.replace(STAMP, "$1:$2:$3.$4Z"));

// The record files a sync saved under one conflict stamp, as store-relative paths.
// A claim or a registration that lost a race is reported through its refusal, lost-claim notice, or acceptance, so the store's status shows only other saved records.
function settled(conflicts) {
  const shown = conflicts.filter((conflict) => !isQuietConflict(conflict.path));
  return { state: shown.length ? "conflicts" : "ok", conflicts: shown, message: shown.length ? conflictsMessage(shown) : "" };
}

// What a sync's conflicts are, by the kinds of file they name, and whose copy each saved file holds and why:
// this machine's version where both sides changed a file, the other machine's change where this machine's removal stands, which carries theirs true, and no copy where this machine's removal gave way;
// a copy that carries tooLongAt, of either side, was saved because its path at its artifact's new location, which the message names, would pass a store path's bounds.
function conflictsMessage(shown) {
  const isComment = (file) => file.startsWith(`${ARTIFACT_COMMENTS}/`);
  const nouns = [[isRecordFile, "records"], [isGuardedFile, "artifacts"], [isComment, "comments"], [(file) => !isSavedFile(file) && !isComment(file), "other store files"]]
    .filter(([kind]) => shown.some((conflict) => kind(conflict.path))).map(([, noun]) => noun);
  const named = nouns.length === 1 ? nouns[0].replace(/^other /, "") : nouns.length === 2 ? nouns.join(" and ") : `${nouns.slice(0, -1).join(", ")}, and ${nouns.at(-1)}`;
  const count = (test) => shown.filter(test).length;
  const mine = count((conflict) => conflict.savedAs && !conflict.theirs && !conflict.tooLongAt);
  const theirs = count((conflict) => conflict.savedAs && conflict.theirs && !conflict.tooLongAt);
  const removed = count((conflict) => !conflict.savedAs);
  // A copy saved because its path would be too long where the merge keeps its artifact names that location, for each side whose copy it holds.
  const tooLong = (other) => {
    const copies = shown.filter((conflict) => conflict.savedAs && conflict.tooLongAt && Boolean(conflict.theirs) === other);
    if (!copies.length) return [];
    const locations = [...new Set(copies.map((conflict) => shownPath(`${ARTIFACTS}/${conflict.tooLongAt}`)))];
    const whose = other ? "the other machine's" : "this machine's";
    const what = copies.length === 1 ? `${whose} change to a file of a moved artifact is saved, because its path` : `${whose} ${copies.length} changes to files of moved artifacts are saved, because their paths`;
    return [`${what} would hold a name of more than ${STORE_NAME_BYTES_MAX} bytes or more than ${STORE_PATH_BYTES_MAX} bytes in all, too long for a store to share, at the artifact's new location ${locations.length === 1 ? locations[0] : locations.length <= 3 ? `${locations.slice(0, -1).join(", ")} or ${locations.at(-1)}` : `${locations.slice(0, 3).join(", ")}, or one of ${locations.length - 3} more`}, where the store keeps the artifact without ${copies.length === 1 ? "that file" : "those files"}`];
  };
  const outcomes = [
    ...(mine ? ["the store keeps the upstream's side, and this machine's versions are saved"] : []),
    ...(theirs ? [`the other machine's ${theirs === 1 ? "change to a file that this machine removed is" : `${theirs} changes to files that this machine removed are`} saved, because this machine's removal stands`] : []),
    ...tooLong(false),
    ...tooLong(true),
    ...(removed ? [`this machine's removal of ${removed === 1 ? "a file" : `${removed} files`} gave way to the upstream's change, so the store holds the upstream's version there again`] : [])
  ];
  return `Concurrent changes to ${named} were resolved; ${outcomes.join("; ")}.`;
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
  // Each copy's size comes from the opened file before any byte is read, so a copy above its kind's bound, such as a withheld record that a sync moved aside, is named by its size and never read.
  const { bound } = await storeLayout();
  const [saved, current] = [await boundedBytes(path.join(base, ...parts), bound(file)), await boundedBytes(path.join(base, ...file.split("/")), bound(file))];
  if (saved === null) return null;
  const text = (bytes) => Buffer.isBuffer(bytes) ? bytes.toString("utf8") : null;
  const over = [["saved", saved], ["current", current]].filter(([, bytes]) => overBytes(bytes)).map(([name, bytes]) => [name, bytes.size]);
  return { path: file, saved: text(saved), current: text(current), ...(over.length ? { tooLarge: Object.fromEntries(over), bound: bound(file) } : {}) };
}

/**
 * Local versions that a sync saved because the upstream changed the same record or the same lines of an artifact, a status record or comment that a merge left without its artifact, or a file whose local version the sync withheld,
 * in stores this process uses, that this process has not reported before and that a sync saved since this process started or that no tool result has carried yet:
 * { record, savedAs, at } for a record, { store, location, savedAs, at } for an artifact, whose location is its path below artifacts/ in the store at store,
 * { store, statusOf, savedAs, at } for a status record and { store, commentOn, savedAs, at } for a comment, each naming the location of the artifact it belongs to,
 * and { store, file, savedAs, at } for any other file the store shares, such as its .gitattributes; an artifact, status record, or comment that holds another machine's change, which the merge took out where this machine's removal stood, also carries theirs true,
 * one that the merge left out because its path at the location it gave the artifact would pass a store path's bounds carries that location as tooLongAt, and theirs true when it holds the other machine's change,
 * a comment of this machine's that the sync left out because its artifact's comment folder already held the comments that an artifact may hold carries surplus true,
 * any copy, a record's among them, of a file that this machine's sync held back because it was above its kind's bound and that the other machine then changed or removed carries overBound true,
 * and a file at the store's root, such as a README, that the other machine changed too carries bothChanged true, while any other such file is one whose local version this machine's sync withheld.
 * Ahead of each stamp's copies come the local changes its merge undid and no copy names: { store, undoneRemoval, folder, at } for a removal that gave way, naming the location that holds the artifact again,
 * { store, undoneFile, folder, at } for a removal of a file at the store's root that gave way, naming its path there,
 * and { store, undoneMove, movedTo, folder, at } for a move sent elsewhere, naming the location that keeps the artifact and the one this machine moved it to, with folder the store's conflicts folder.
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
      const about = await readAbout(base, stamp);
      const when = new Date(at).toISOString();
      const items = (await savedFiles(path.join(directory, stamp), (file) => isSavedFile(file) || shareable(file))).map((file) => {
        const savedAs = path.join(directory, stamp, ...file.split("/"));
        const whose = { ...(about.theirs.has(file) ? { theirs: true } : about.surplus.has(file) ? { surplus: true } : about.bothChanged.has(file) ? { bothChanged: true } : about.overBound.has(file) ? { overBound: true } : {}), ...(about.tooLong.has(file) ? { tooLongAt: about.tooLong.get(file) } : {}) };
        if (isArtifactFile(file)) return { store: base, location: file.slice(ARTIFACTS.length + 1), savedAs, at: when, ...whose };
        if (isRecordFile(file)) return { record: `.prism/${file}`, savedAs, at: when, ...(whose.overBound ? { overBound: true } : {}) };
        // A status record or comment is named by the artifact location it belongs to, so the result names the artifact's path and scope.
        const location = derivedLocation(file);
        if (location !== null) return file.startsWith(`${ARTIFACT_STATUS}/`) ? { store: base, statusOf: location, savedAs, at: when, ...whose } : { store: base, commentOn: location, savedAs, at: when, ...whose };
        return { store: base, file, savedAs, at: when, ...whose };
      });
      // The local changes that the stamp's merge undid come first, as the result names them first.
      items.unshift(...about.undone.map((change) => ({ store: base, ...("removal" in change ? { undoneRemoval: change.removal } : "file" in change ? { undoneFile: change.file } : { undoneMove: change.move, movedTo: change.movedTo }), folder: directory, at: when })));
      // A stamp that holds only claims and registrations, which other results report, has nothing to carry.
      if (notice && !items.length) await rm(notice, { force: true });
      for (const item of items) { if (notice) notices.set(item, notice); reportKeys.set(item, key); found.push(item); }
    }
  }
  return found;
}

// A location as the sync folder's own notes name one: a store path below artifacts/ that leads nowhere else.
const noteLocation = (location) => typeof location === "string" && location.length > 0 && location.split("/").every((part) => part && part !== "." && part !== "..");
const undoneForm = (change) => change !== null && typeof change === "object" && (noteLocation(change.removal) || noteLocation(change.file) || (noteLocation(change.move) && noteLocation(change.movedTo)));

// What a conflict stamp's copies are and which local changes its merge undid, from the note beside it, or nothing for a stamp without one or with a note of any other form.
async function readAbout(base, stamp) {
  const value = await readFile(aboutPath(base, stamp), "utf8").then(parseStoreJson).catch(() => null);
  const paths = (list) => new Set(Array.isArray(list) ? list.filter((file) => typeof file === "string") : []);
  const undone = Array.isArray(value?.undone) ? value.undone.filter(undoneForm).map((change) => noteLocation(change.removal) ? { removal: change.removal } : noteLocation(change.file) ? { file: change.file } : { move: change.move, movedTo: change.movedTo }) : [];
  const tooLong = new Map(Array.isArray(value?.tooLong) ? value.tooLong.filter((entry) => typeof entry?.path === "string" && noteLocation(entry.location)).map((entry) => [entry.path, entry.location]) : []);
  return { theirs: paths(value?.theirs), tooLong, surplus: paths(value?.surplus), bothChanged: paths(value?.bothChanged), overBound: paths(value?.overBound), undone };
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
  try { return parseStoreJson(await readFile(syncPath(base, "status.json"), "utf8")); }
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
 * Options let tests act between steps: beforeApply runs while the working-tree marker is held, beforePush before each push;
 * whileLocked(status) runs after the sync, while the lock is still held, and must not throw.
 */
export function syncRecordStore(base, options = {}) {
  if (running.has(base)) return running.get(base);
  const pending = (async () => {
    await mkdir(syncPath(base), { recursive: true });
    try {
      return await withFileLock(syncPath(base, "sync"), async () => {
        // Only a process that logs reads the state before the sync, so a sync where nothing logs runs no Git command more.
        const before = log ? await Promise.all([readSyncStatus(base), headOf(base)]).catch(() => null) : null;
        const status = await sync(base, options);
        if (before) await logSync(base, before[0], before[1], status).catch(() => {});
        // A caller that must act on the store exactly as this sync left it, such as a move that decides against this pull, does so before the lock is released.
        await options.whileLocked?.(status);
        return status;
      }, undefined, { ...syncLockOptions(), timeoutMs: 1 });
    } catch (error) {
      // The holder may have committed before this process wrote, so a later sync picks the change up.
      if (error.code === "lock_timeout") { scheduleRecordSync(base, writing.has(base)); return { state: "skipped" }; }
      // An upstream entry that no store may hold, or a path that leads outside the store, stops the merge before any file changes, so the branch stays and every sync reports it until the upstream drops it.
      if (error.unsafePath) return writeStatus(base, { state: "merge_failed", message: error.message, ...await counts(base).catch(() => ({})) }).catch(() => ({ state: "merge_failed", message: withoutCredentials(error.message) }));
      // A Git error outside fetch, merge, and push, such as a leftover index lock, is reported as it is and never repaired here.
      return writeStatus(base, { state: "git_failed", message: error.message }).catch(() => ({ state: "git_failed", message: withoutCredentials(error.message) }));
    }
  })().finally(() => {
    running.delete(base);
    writing.delete(base);
    if (rerun.delete(base)) scheduleRecordSync(base);
    updateWatcher();
  });
  running.set(base, pending);
  if (written.delete(base)) writing.add(base);
  updateWatcher();
  return pending;
}

const headOf = async (base) => { const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]); return head.ok ? head.text : null; };

// The log names each sync that changed the store's branch, each failure once until its reason changes, and the sync that ends a run of failures,
// so a person reads in the log when records were shared and why they were not, without a line for every sync that found nothing to do.
async function logSync(base, previous, head, status) {
  if (!log || !status || status.state === "skipped") return;
  const failed = (value) => value && value.state !== "ok";
  if (failed(status)) {
    if (previous?.state !== status.state || previous?.message !== status.message) log.warn("store_sync_failed", { store: base, state: status.state, message: status.message, ahead: status.ahead, behind: status.behind });
    return;
  }
  const now = await headOf(base);
  const conflicts = status.conflicts?.length ?? 0;
  // A sync that pushed commits an earlier sync left unpushed changes no branch, so it shows by its count of unpushed commits.
  if (now !== head || conflicts || (previous?.ahead > 0 && !status.ahead)) log.info("store_synced", { store: base, from: head, to: now, ahead: status.ahead, behind: status.behind, ...(conflicts ? { savedConflicts: conflicts } : {}) });
  else if (failed(previous)) log.info("store_synced", { store: base, recovered: previous.state, ahead: status.ahead, behind: status.behind });
}

async function identity(base) {
  const args = [];
  if (!(await git(base, ["config", "user.name"])).text) args.push("-c", "user.name=Prism");
  if (!(await git(base, ["config", "user.email"])).text) args.push("-c", "user.email=prism@localhost");
  return args;
}

// The modes of the entries a store shares: a regular file, executable or not, and never a symbolic link or a submodule link.
const FILE_MODES = new Set(["100644", "100755"]);
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
const storeLayout = () => layout ??= import("./record-store.mjs").then(({ boundText, COMMENTS_PER_ARTIFACT_MAX, INERT_FILES, isRootStoreFile, isStoreFile, isStoreFolder, STORE_FILE_BOUNDS, STORE_TREE_FILES_MAX, storeFileBound }) => {
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
    // Below artifact-identity/ a store holds only the identity files of artifact locations, so any other entry there, which would stand in the way of one, is refused.
    if (file.startsWith(`${ARTIFACT_IDENTITY}/`)) return "unsafe";
    if (isStoreFolder(file) || folders(file).some((folder) => !isArtifactFile(folder) && shareable(folder))) return "unsafe";
    return "carried";
  };
  // A file at a path that a store shares takes its kind's bound, and a comment file counts toward its folder's bound on comments.
  const isCommentFile = (file) => file.startsWith(`${ARTIFACT_COMMENTS}/`) && isStoreFile(file);
  // A README or license at the root, or the .gitattributes or .gitignore there, takes its kind's bound as every other file does, and no reader of Prism loads it,
  // so where both sides changed one and its lines conflict, the store keeps the upstream's version and saves this machine's, as for a record or an artifact.
  // The most bytes that the sync reads of one blob at a path: its kind's bound, or the largest bound of any kind at a path that has no kind of its own.
  const largest = Math.max(...Object.values(STORE_FILE_BOUNDS));
  const blobMax = (file) => storeFileBound(file) ?? largest;
  const treeFilesMax = () => SETTINGS.treeFilesMax ?? STORE_TREE_FILES_MAX;
  return { shareable, isStoreFolder, kind, bound: storeFileBound, blobMax, boundText, commentsMax: COMMENTS_PER_ARTIFACT_MAX, isCommentFile, rootFile: isRootStoreFile, treeFilesMax };
});

// Why a file stays out of a commit, or out of a store, by its size or by its comment folder's count, as a sync's status or refusal names it.
// No reader of Prism loads a file at the store's root, so what such a file above its bound meets is another machine's sync, which refuses it.
const OVER_BOUND = "that a store file of its kind may hold";
const overBound = (size, bound, boundText, root = false) => `it holds ${size} bytes, above the ${boundText(bound)} ${OVER_BOUND}, so ${root ? "every other machine's sync would refuse it" : "no reader on another machine would read it"}`;
const OVER_COMMENTS = "its comment folder holds more than";
const overComments = (max) => `${OVER_COMMENTS} ${max} comment files, the most that an artifact's comments may hold, and the sync commits every comment that the store already shares and then this machine's others by file name, up to ${max}`;

/**
 * The first file of a commit's tree that a store shares and that holds more than its kind's bound, as { path, size, bound }, or the first comment folder that holds more comment files than an artifact may,
 * as { folder, count }, or { files } with the bound for a tree of more files than a store's tree may hold; null when the tree holds none of them.
 * The sizes come from Git's tree listing, so no blob is read.
 */
export async function oversizedStoreEntry(base, commit) {
  const { kind, bound, isCommentFile, commentsMax } = await storeLayout();
  const counts = new Map();
  let found = null;
  try {
    await listTree(base, commit, true, (meta, name) => {
      if (found) return;
      const [mode, , object, size] = meta.split(/ +/);
      const file = pathOfBytes(name);
      if (!FILE_MODES.has(mode) || kind(file, { mode, object }) !== "shared") return;
      const limit = bound(file);
      if (limit !== null && Number(size) > limit) { found = { path: file, size: Number(size), bound: limit }; return; }
      if (isCommentFile(file)) {
        const folder = path.posix.dirname(file);
        counts.set(folder, (counts.get(folder) ?? 0) + 1);
      }
    });
  } catch (error) {
    if (!error.treeTooLarge) throw error;
    return { files: error.treeTooLarge, bytes: error.listingBytes };
  }
  if (found) return found;
  for (const [folder, count] of counts) if (count > commentsMax) return { folder, count };
  return null;
}

/**
 * The first file above its kind's bound that a commit reachable from tip and not from the known commits adds or changes, as { path, size, bound }, or null.
 * Each such commit's changes come from Git's tree comparison with its parents, read as it arrives, and their sizes from Git's object listing, so no blob is read.
 * A merge lists only the files that it holds differently from every parent, since a file that it holds as a parent does came from that parent, which is itself walked or known.
 * Only the entries of files that a store shares and bounds are kept, and their sizes are checked a batch at a time, so the walk holds at most one batch however long the history is;
 * each commit's own listing is bounded as a history listing is, and a commit past that bound is refused by name.
 */
async function oversizedHistory(base, known, tip = "HEAD") {
  const { shareable, bound } = await storeLayout();
  const commits = await historyCommits(base, ["rev-list", "--stdin"], `${tip}\n${known.map((commit) => `^${commit}\n`).join("")}`);
  if (!commits.length) return null;
  const batch = new Map();
  let found = null, meta = null, commit = null, records = 0, bytes = 0, tooLong = null;
  const check = async () => {
    const sizes = await objectInfo(base, [...batch.keys()]);
    for (const [object, { file, limit }] of batch) {
      const size = sizes.get(object)?.size;
      if (found === null && size !== undefined && size > limit) found = { path: file, size, bound: limit };
    }
    batch.clear();
    return found === null;
  };
  // Each commit's listing is its id, and then each changed entry: its metadata, ":<modes> <ids> <status>" with one more colon, mode, and id for each further parent, and its path, each ended by a zero byte;
  // the last mode and id are the commit's own.
  const listed = await gitRecords(base, ["diff-tree", "--stdin", "-r", "-z", "-c", "--root", "--no-renames"], {
    separator: 0, maxRecord: LISTED_META_MAX * 8 + LISTED_PATH_BYTES_MAX, input: `${commits.join("\n")}\n`, take: async (record) => {
      if (meta === null && record[0] !== 0x3a) {
        commit = record.toString("latin1");
        records = 0;
        bytes = 0;
        return true;
      }
      if (++records > historyRecordsMax() || (bytes += record.length + 1) > historyBytesMax()) { tooLong = commit; return false; }
      if (meta === null) {
        meta = record.toString("latin1");
        return true;
      }
      const parents = /^:+/.exec(meta)[0].length;
      const fields = meta.slice(parents).split(" ");
      meta = null;
      const [mode, object] = [fields[parents], fields[2 * parents + 1]];
      const file = pathOfBytes(record);
      const limit = FILE_MODES.has(mode) && shareable(file) ? bound(file) : null;
      if (limit === null || (batch.get(object)?.limit ?? Infinity) <= limit) return true;
      batch.set(object, { file, limit });
      return batch.size < 4096 || await check();
    } });
  if (tooLong !== null || listed.long) throw (tooLong ?? commit) ? await commitRefusal(base, `the changes of commit ${tooLong ?? commit}`, tooLong ?? commit) : historyRefusal("the changes that the remote lacks");
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || "git diff-tree failed."), { git: listed });
  if (found === null && batch.size) await check();
  return found;
}

/** The refusal of an upstream or a remote branch that holds a file above its kind's bound or a comment folder above its bound, in the words of a sync's message. */
export async function describeOversizedEntry(over) {
  const { boundText, commentsMax, rootFile } = await storeLayout();
  if (over.files) return `${wideTree(over)}, which no store takes`;
  if (over.folder) return `${over.count} comment files in ${shownPath(over.folder)}, above the ${commentsMax} that an artifact's comments may hold, which no reader takes`;
  return `${shownPath(over.path)}, which holds ${over.size} bytes, above the ${boundText(over.bound)} that a store file of its kind may hold, which ${rootFile(over.path) ? "no store takes" : "no reader takes"}`;
}

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
 * Move a clone's folder from source to target while holding the clone's sync lock, so no sync of source, from this or an earlier Prism, runs while it moves.
 * qualifies() runs under the lock and decides whether the move happens; renameFolder does the move.
 * It answers whether the folder moved, throws an error with code lock_timeout when a sync holds the lock, and throws the rename's error when the move fails, leaving source as it was.
 * The lock moves with the folder and is removed at its new place.
 */
export async function moveUnderSyncLock(source, target, qualifies, renameFolder = rename) {
  await mkdir(syncPath(source), { recursive: true });
  const lock = `${syncPath(source, "sync")}.lock`;
  return withFileLock(syncPath(source, "sync"), async () => {
    if (!(await qualifies())) return false;
    const token = (await readFile(lock, "utf8").then(parseStoreJson).catch(() => null))?.token;
    await renameFolder(source, target);
    const moved = path.join(target, path.relative(source, lock));
    const owner = await readFile(moved, "utf8").then(parseStoreJson).catch(() => null);
    if (token && owner?.token === token) await rm(moved, { force: true });
    return true;
  }, undefined, { ...syncLockOptions(), timeoutMs: 1, closeHandle: true });
}

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
  // A branch past the files that a store's tree may hold is refused by the sync, and the migration waits for a branch that a sync can list.
  let listed;
  try { listed = await treeFiles(base, head.ok ? head.text : null); }
  catch (error) { if (error.treeTooLarge) return; throw error; }
  const { shared } = await partition(listed);
  const found = [];
  for (const [file, entry] of shared) if ((await lstat(path.join(base, ...file.split("/"))).catch(() => null))?.isFile()) found.push([file, entry]);
  // Git answers with one id for each path given.
  const objects = found.length ? await gitLines(base, ["hash-object", "--no-filters", "--stdin-paths"], { input: `${found.map(([file]) => file).join("\n")}\n`, limit: found.length, maxRecord: 128 }) : [];
  const echoes = [];
  const { bound } = await storeLayout();
  const differing = found.filter(([, entry], index) => objects[index] !== entry.object);
  const blobSizes = differing.length ? await objectInfo(base, [...new Set(differing.map(([, entry]) => entry.object))]) : new Map();
  for (const [file, entry] of differing) {
    const target = path.join(base, ...file.split("/"));
    // A converted copy holds one more byte for each line, so only a file at most twice its blob's size, of a blob within its kind's bound, is read, and memory stays bounded whatever a file holds.
    const blobSize = blobSizes.get(entry.object)?.size;
    const size = (await lstat(target).catch(() => null))?.size;
    if (blobSize === undefined || size === undefined || size <= blobSize || size > 2 * blobSize || (bound(file) !== null && blobSize > bound(file))) continue;
    const [bytes, blobBytes] = await Promise.all([boundedBytes(target, 2 * blobSize), readBlob(base, file, entry)]);
    if (Buffer.isBuffer(bytes) && Buffer.isBuffer(blobBytes) && lineEndingEcho(bytes, blobBytes)) echoes.push({ file, target, blobBytes });
  }
  // Each file is rewritten under the lock that a write of it takes, and only while it still holds the converted copy.
  const rewrite = async ({ target, blobBytes }) => {
    const bytes = await boundedBytes(target, 2 * blobBytes.length);
    if (Buffer.isBuffer(bytes) && lineEndingEcho(bytes, blobBytes)) await writeAtomically(target, blobBytes);
  };
  const artifacts = echoes.filter(({ file }) => isGuardedFile(file));
  if (artifacts.length) await holdLocks([path.join(base, ARTIFACTS)], async () => { for (const echo of artifacts) await rewrite(echo); });
  for (const echo of echoes.filter(({ file }) => !isGuardedFile(file))) await holdLocks([echo.target], () => rewrite(echo));
  await writeAtomically(syncPath(base, RAW_FILES), `${JSON.stringify({ at: new Date().toISOString() })}\n`);
  migrated.add(base);
}

/**
 * The store's files at the paths it shares, as Map(path, { mode, object }), each hashed from its bytes exactly as they are, so no ignore or attributes rule decides what is committed or how.
 * Only regular files count, found without following a symbolic link.
 * A file keeps the mode the branch gives it, and a new one is a plain file, so a file system without an executable bit changes no mode.
 * Every file it hashes held at most its kind's bound when its size was checked, a README at the root among them, so a commit that reads them under the artifact lock holds that lock for a bounded read unless a file grows meanwhile,
 * and one that grew past its bound by its hashing is withheld by the size of the object Git wrote.
 * oversized takes each file it leaves out that a merge may replace, by its path, with the size it found for a file above its kind's bound and null for a comment past its folder's bound.
 */
async function localFiles(base, held, withheld, oversized = new Map()) {
  const { shareable, isStoreFolder, bound, boundText, isCommentFile, commentsMax, rootFile } = await storeLayout();
  for (let attempt = 1; ; attempt++) {
    const found = [];
    const visit = async (relative) => {
      let entries = [];
      try { entries = await readdir(relative ? path.join(base, ...relative.split("/")) : base, { withFileTypes: true }); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return; throw error; }
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        // A file whose path some machine cannot write stays out of every commit, and the sync's status names it.
        if (entry.isFile()) { if (shareable(child)) (storePathFits(child) ? found.push(child) : withheld.set(child, TOO_LONG)); }
        else if (entry.isDirectory() && isStoreFolder(child)) await visit(child);
      }
    };
    await visit("");
    found.sort();
    // A file above its kind's bound stays out of every commit, as a path too long for some machine does, and so does each comment file past the first ones by name of a folder above its bound.
    const over = new Map();
    const comments = new Map();
    for (let start = 0; start < found.length; start += 64) {
      await Promise.all(found.slice(start, start + 64).map(async (file) => {
        const limit = bound(file);
        if (limit === null) return;
        const info = await lstat(path.join(base, ...file.split("/"))).catch(() => null);
        if (info?.isFile() && info.size > limit) { over.set(file, info.size); withheld.set(file, overBound(info.size, limit, boundText, rootFile(file))); }
      }));
    }
    for (const file of found) if (!over.has(file) && isCommentFile(file)) comments.set(path.posix.dirname(file), [...comments.get(path.posix.dirname(file)) ?? [], file]);
    // A folder past its bound commits as a merge keeps one: every comment that the branch already holds and then this machine's others by file name, up to the bound,
    // so the sync's own commit never removes a comment that other machines share, and never holds more comments than an artifact may.
    for (const names of comments.values()) {
      if (names.length <= commentsMax) continue;
      const ordered = [...names.filter((file) => held.has(file)), ...names.filter((file) => !held.has(file))];
      for (const file of ordered.slice(commentsMax)) { over.set(file, null); withheld.set(file, overComments(commentsMax)); }
    }
    if (over.size) {
      // A comment past its folder's bound that the branch does not hold is one the merge counts as a comment of no tree, and every file above its bound is one whose path the upstream may change.
      for (const [file, size] of over) if (size !== null || !isCommentFile(file) || held.has(file)) oversized.set(file, size);
      found.splice(0, found.length, ...found.filter((file) => !over.has(file)));
    }
    // Git answers with one id for each path given.
    const hashed = found.length ? await gitLinesResult(base, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: `${found.join("\n")}\n`, limit: found.length, maxRecord: 128 }) : { ok: true, lines: [] };
    const objects = hashed.lines;
    // A record removed or replaced between the listing and the hashing makes the hashing fail, so the listing is taken again.
    if (!hashed.ok || objects.length !== found.length) {
      if (attempt < 3) continue;
      throw Object.assign(new Error(hashed.stderr || "git hash-object failed."), { git: hashed });
    }
    // A file written in place while the sync runs can grow past its kind's bound between its size check and its hashing, so the size of each object Git wrote, from Git's object listing without reading it,
    // decides again: an object above its file's bound is withheld as if the size check had caught it, so the branch keeps the file's earlier version and no commit of the sync holds it.
    const sizes = found.length ? await objectInfo(base, [...new Set(objects)]) : new Map();
    const files = new Map();
    for (const [index, file] of found.entries()) {
      const limit = bound(file);
      const size = sizes.get(objects[index])?.size;
      if (limit !== null && size !== undefined && size > limit) {
        withheld.set(file, overBound(size, limit, boundText, rootFile(file)));
        oversized.set(file, size);
        continue;
      }
      files.set(file, { mode: held.get(file)?.mode ?? "100644", object: objects[index] });
    }
    return files;
  }
}

// What tells one file on disk from another without reading it: its device, inode, size, and change time, which every write or replacement of it changes.
const diskIdentity = (stats) => ({ dev: stats.dev, ino: stats.ino, size: stats.size, mtime: stats.mtimeNs, ctime: stats.ctimeNs });
async function sameDiskFile(target, disk) {
  const stats = await lstat(target, { bigint: true }).catch(() => null);
  const now = stats?.isFile() ? diskIdentity(stats) : null;
  return Boolean(now) && Object.keys(disk).every((key) => now[key] === disk[key]);
}

// Why a sync leaves a file out of its commits, as its status names it.
const OBJECT_CHECK = "Git's object check, which every other machine's fetch applies, refuses it";
const TOO_LONG = `its name holds more than ${STORE_NAME_BYTES_MAX} bytes or its path more than ${STORE_PATH_BYTES_MAX}, so some machine could not write it`;

/**
 * Commit the store's changes; run is one sync's state, whose lockBusy is true where an update held the artifact lock for as long as this commit waits for it,
 * and whose withheld maps each file this commit left out to why: a path too long for some machine, or a file whose object Git's object check refuses, which keeps the branch's version.
 * An artifact update holds the store's artifact lock from its version checks to its last write, so reading the artifacts under that lock never commits part of an update.
 * The first commit of a sync tries the lock once, so a sync never merges the upstream over an update that is still writing, and a later commit of the sync waits for it as long as a merge waits to apply;
 * where the lock is busy, the commit reads nothing and makes nothing, and the sync commits, merges, and pushes nothing, so it never merges while files under the lock are uncommitted on disk,
 * and a later sync, which the update's own write schedules too, tries again.
 * The commit holds the shared files as the store holds them and every other entry as the branch holds it, so no local commit adds, changes, or removes a file Prism does not write.
 */
async function commitLocal(base, author, run) {
  run.pending = null;
  run.lockBusy = false;
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const previous = head.ok ? head.text : null;
  let branch;
  try { branch = await treeFiles(base, previous); }
  catch (error) {
    if (error.treeTooLarge) run.wideBranch = { files: error.treeTooLarge, bytes: error.listingBytes };
    else if (error.longPath) run.wideBranch = { path: error.longPath, long: true, kind: "an entry" };
    else throw error;
    return false;
  }
  run.wideBranch = null;
  const { shared, other } = await partition(branch);
  const withheld = new Map();
  run.withheld = withheld;
  // The local version of each file withheld because Git's object check refuses it, which a merge that replaces the file saves.
  run.heldBack = new Map();
  const oversized = new Map();
  const files = await withFileLock(path.join(base, ARTIFACTS), () => localFiles(base, shared, withheld, oversized), undefined, { timeoutMs: run.lockTried ? SETTINGS.applyLockMs : 1 })
    .catch((error) => { if (error.code !== "lock_timeout") throw error; return null; });
  run.lockTried = true;
  run.lockBusy = files === null;
  if (run.lockBusy) {
    scheduleRecordSync(base);
    return false;
  }
  // A withheld file keeps the branch's version in the commit, and its local version is held back, so a merge that replaces it saves it as a conflict's local version is saved.
  // A comment past its folder's bound is hashed, since it held at most a comment's bound when its size was checked; a file above its kind's bound is never read, and enters neither memory nor a commit:
  // it is held back by the file it is on disk, which a merge that replaces or removes its path moves into the saved copies by a rename.
  // A file that grew past its bound after its size was checked is found by the size of the object Git wrote for it, which no commit takes, and is held back by the file it is on disk as well.
  const { bound, boundText, rootFile } = await storeLayout();
  for (const [file, found] of oversized) {
    const target = path.join(base, ...file.split("/"));
    const mode = shared.get(file)?.mode ?? "100644";
    let size = found;
    if (size === null) {
      const hashed = await git(base, ["hash-object", "-w", "--no-filters", "--", target]);
      const object = hashed.ok && hashed.text ? hashed.text : null;
      const grown = object ? (await objectInfo(base, [object])).get(object)?.size : undefined;
      if (grown !== undefined && grown > bound(file)) {
        size = grown;
        withheld.set(file, overBound(grown, bound(file), boundText, rootFile(file)));
      } else if (object) run.heldBack.set(file, { mode, object });
    }
    if (size !== null) {
      const disk = await lstat(target, { bigint: true }).catch(() => null);
      if (disk?.isFile()) run.heldBack.set(file, { mode, object: null, disk: diskIdentity(disk) });
    }
    if (shared.has(file)) files.set(file, shared.get(file)); else files.delete(file);
  }
  const { treeFilesMax } = await storeLayout();
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
      // A refusal only of files that the branch already holds, as a .gitattributes that a commit made by hand put there, is no change of this commit's,
      // so the commit is made, and the push check refuses the branch by that file's name with the command that takes the commit made by hand off.
      const held = new Set([...branch.values()].map((entry) => entry.object));
      const inherited = !culprits.length && refused.objects.length > 0 && refused.objects.every((object) => held.has(object));
      if (!culprits.length && !inherited) throw new Error(`Git's object check, which every other machine's fetch applies, refuses the store's new commit, so it was not made: ${refused.message}`);
      if (culprits.length) {
        for (const file of culprits) {
          withheld.set(file, `${OBJECT_CHECK} (${refused.message})`);
          run.heldBack.set(file, files.get(file));
          if (shared.has(file)) files.set(file, shared.get(file)); else files.delete(file);
        }
        continue;
      }
    }
    // No commit whose tree holds more files than a store's tree may enters the branch's history, and no file is left out to make room:
    // where this machine's changes would take the tree past that bound, the commit is left unmade, as a commit object that no ref names and no push sends,
    // and the merge takes its tree as this machine's side, so its result, which must be within the bound, is the branch's next commit.
    if (entries.size > treeFilesMax()) {
      run.pending = { commit, from: previous, files: entries.size, entries };
      return false;
    }
    await moveBranch(base, commit, previous, "prism: update records");
    // The commits that this sync made of this machine's changes one after another, which a stop at the bound on a store tree's files takes off together.
    run.made = previous && run.made?.to === previous ? { from: run.made.from, to: commit } : { from: previous, to: commit };
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
    const history = await refusedHistoryInBatches(base, tip, known, pushing);
    if (history.reasons.length) return refusal(history.reasons, history.places);
    // The pack reaches its file as Git writes it, within its bound, so no pack is held in memory.
    const handle = await open(path.join(folder, "objects.pack"), "w");
    let packed;
    try { packed = await gitRecords(base, ["pack-objects", "--revs", "--stdout", "--quiet", "--filter=blob:none"], { separator: null, maxBytes: PACK_BYTES_MAX, input: revisions, take: async (chunk) => { await handle.write(chunk); } }); }
    finally { await handle.close(); }
    if (packed.over) throw outputRefusal(`The commits and trees that the remote lacks pack to more than ${PACK_BYTES_MAX} bytes, more than a sync checks`, HISTORY_FIX, "the store's branch was not pushed");
    if (!packed.ok) throw Object.assign(new Error(packed.stderr || "git pack-objects failed."), { git: packed });
    const checked = await git(base, ["index-pack", "--strict", "-o", path.join(folder, "objects.idx"), path.join(folder, "objects.pack")]);
    if (checked.ok) return null;
    const reasons = checked.stderr.split("\n").filter((line) => line.startsWith("error: ")).map((line) => line.slice("error: ".length));
    return refusal(reasons.length ? reasons : [checked.stderr]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * refusedHistory over the commits reachable from tip and not from the known commits, oldest first, a batch of commits at a time, so each walk stays within the bound of a history listing
 * however long that history is, as after many syncs whose pushes failed: each batch walks its commits' own objects, those that no commit before it and no known commit holds.
 * A batch past the bound is walked again in halves, and a single commit past it is refused by name, since only a commit made by hand makes one so large.
 */
async function refusedHistoryInBatches(base, tip, known, pushing) {
  const commits = (await historyCommits(base, ["rev-list", "--topo-order", "--reverse", "--parents", "--stdin"], `${tip}\n${known.map((commit) => `^${commit}\n`).join("")}`)).map((line) => line.split(" "));
  let size = Math.min(commits.length, 1024), ceiling = Infinity;
  for (let at = 0; at < commits.length;) {
    const batch = commits.slice(at, at + size);
    const inBatch = new Set(batch.map(([commit]) => commit));
    const below = new Set(batch.flatMap(([, ...parents]) => parents).filter((parent) => !inBatch.has(parent)));
    const revisions = `${[...inBatch].join("\n")}\n${[...below, ...known].map((commit) => `^${commit}\n`).join("")}`;
    let history;
    try { history = await refusedHistory(base, revisions, pushing); }
    catch (error) {
      if (!error.outputBound) throw error;
      if (batch.length === 1) throw await commitRefusal(base, `the objects of commit ${batch[0][0]}`, batch[0][0]);
      ceiling = batch.length;
      size = Math.ceil(batch.length / 2);
      continue;
    }
    if (history.reasons.length) return history;
    at += batch.length;
    size = Math.max(1, Math.min(size * 2, ceiling - 1));
  }
  return { reasons: [], places: new Map() };
}

// The commit up to which the history of the store's branch passed the push checks, so a later check walks only the commits after it, whatever the remote holds:
// a sync whose pushes keep failing then walks only what changed since its last sync. The ref is Prism's own and no push or fetch sends or prunes it.
const CHECKED_REF = "refs/prism-checked/branch";
async function checkedTip(base) {
  const checked = await git(base, ["rev-parse", "--verify", "--quiet", `${CHECKED_REF}^{commit}`]);
  return checked.ok && checked.text ? checked.text : null;
}

/**
 * Run the push checks of the branch's history, the object check and the size check, on the commits after the last checked one and the known commits, and record the branch's tip as checked when they pass,
 * so each sync checks only what changed since the last one, also while fetches or pushes fail. A refusal is left for the push check, which reports it by name.
 */
async function advanceChecked(base, remote) {
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!head.ok || !head.text) return;
  const checked = await checkedTip(base);
  if (checked === head.text) return;
  const walked = [...await knownCommits(base, remote), ...(checked ? [checked] : [])];
  try {
    if (await refusedObjects(base, head.text, walked)) return;
    if (await oversizedHistory(base, walked, head.text)) return;
  } catch (error) {
    if (error.outputBound) return;
    throw error;
  }
  await required(base, ["update-ref", CHECKED_REF, head.text]);
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
  // The walk is read as it arrives, so no output buffer bounds it: it walks only the commits that the known ones lack, this machine's own history, which a first publish of a long-lived store makes long,
  // and every tree in it that a sync commits or a push sends is one that the bound on a store tree's files already checked.
  const where = new Map();
  const listed = await gitRecords(base, ["rev-list", "--objects", "--stdin"], { separator: 10, limit: historyRecordsMax(), maxBytes: historyBytesMax(), maxRecord: LISTED_META_MAX + LISTED_PATH_BYTES_MAX, input: revisions, take: (line) => {
    // Each line is an object id, followed for a tree or a blob by a space and the path it was first found at.
    const space = line.indexOf(32);
    const object = (space < 0 ? line : line.subarray(0, space)).toString("latin1");
    if (OBJECT_ID.test(object)) where.set(object, space < 0 ? "" : pathOfBytes(line.subarray(space + 1)));
  } });
  // Git 2.43 and later stop the walk at a tree deeper than core.maxTreeDepth, which every store command sets to Git's default, as every other machine's fetch would.
  if (!listed.ok && listed.stderr.includes(TREE_DEPTH_TEXT)) return { reasons: [deepTreeReason()], places: new Map() };
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || "git rev-list failed."), { git: listed });
  if (listed.over) throw historyRefusal("the objects that the remote lacks");
  // An object found at a path longer than any supported machine holds ends the walk, which keeps nothing past it.
  if (listed.long) {
    const space = listed.long.indexOf(32);
    const shown = `${pathOfBytes(listed.long.subarray(space + 1, space + 1 + 64))}…`;
    return { reasons: [`largePath: ${longEntry(shown)}`], places: new Map([[listed.long.subarray(0, space).toString("latin1"), [shown]]]) };
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
  // The commits' and trees' contents are read within the bound of a history listing, and past it the push is refused by name.
  const historyContents = (objects) => objectContents(base, objects, historyBytesMax(), "the commits and trees that the remote lacks").catch((error) => { throw error.outputBound ? historyRefusal("the commits and trees that the remote lacks") : error; });
  for (const [commit, contents] of await historyContents([...where.keys()].filter((object) => types.get(object)?.type === "commit"))) {
    const problem = commitProblem(contents, commit.length);
    if (problem) refuse(commit, `${problem.id}: ${problem.text}`);
    const tree = /^tree ([0-9a-f]+)\n/.exec(contents.toString("latin1"))?.[1];
    if (tree) roots.add(tree);
  }
  const found = new Map();
  const misnamed = new Map();
  const links = new Map();
  const treeContents = await historyContents(trees);
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
  // A .gitattributes above the bound of its kind is not read: the bound checks of the push refuse it in every commit that the remote lacks.
  const attributes = await readBlobs(base, readable.map((object) => ({ file: ".gitattributes", entry: { mode: "100644", object } })));
  for (const [index, contents] of attributes.entries()) {
    const object = readable[index];
    if (!Buffer.isBuffer(contents)) continue;
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
  const read = await readBlobs(base, targets.map((object) => ({ file: "<symlink-target>", entry: { mode: "100644", object }, max: LINK_TARGET_BYTES_MAX })));
  for (const [index, contents] of read.entries()) {
    const object = targets[index];
    const problem = linkTargetProblem(contents);
    if (problem) refuse(object, `${problem.id}: ${problem.text}`, links.get(object));
  }
  return { reasons, places };
}

// The reason a history whose trees nest deeper than Git 2.43 and later walk is refused, in Git's words.
const deepTreeReason = () => `maxTreeDepth: ${TREE_DEPTH_TEXT}, since a folder is nested more than ${TREE_DEPTH_MAX} folders deep`;

// The type and size of each object the store holds: Map(object, { type, size }), without the ones it lacks.
// Git answers with one line for each object asked, so the listing is read within that many lines.
async function objectInfo(base, objects) {
  const info = new Map();
  if (!objects.length) return info;
  for (const line of await gitLines(base, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: `${objects.join("\n")}\n`, limit: objects.length, maxRecord: 128, what: "the store's object sizes" })) {
    const [object, type, size] = line.split(" ");
    if (size !== undefined && type !== "missing") info.set(object, { type, size: Number(size) });
  }
  return info;
}

/**
 * The contents of objects the store holds, as Map(object, bytes), read in one Git process as its output arrives: commits and trees, and the blobs that readBlobs sized first.
 * The output is read within maxBytes, which readBlobs sets to the bytes its sizes take, and past which the read is refused by what it reads.
 */
async function objectContents(base, objects, maxBytes, what = "the store's objects") {
  const contents = new Map();
  if (!objects.length) return contents;
  // Each object is a header line, "<object> <type> <size>" or "<object> missing", then that many bytes and a line feed, which arrive split across chunks anywhere.
  let header = Buffer.alloc(0), current = null, parts = [], have = 0;
  const listed = await gitRecords(base, ["cat-file", "--batch"], { separator: null, maxBytes, input: `${objects.join("\n")}\n`, take: (chunk) => {
    for (let at = 0; at < chunk.length;) {
      if (!current) {
        const end = chunk.indexOf(10, at);
        if (end < 0) { header = Buffer.concat([header, chunk.subarray(at)]); return; }
        const [object, type, size] = Buffer.concat([header, chunk.subarray(at, end)]).toString("latin1").split(" ");
        header = Buffer.alloc(0);
        at = end + 1;
        if (type === "missing" || size === undefined) continue;
        current = { object, need: Number(size) + 1 };
        parts = [];
        have = 0;
      }
      const piece = chunk.subarray(at, Math.min(chunk.length, at + current.need - have));
      parts.push(piece);
      have += piece.length;
      at += piece.length;
      if (have === current.need) {
        const body = Buffer.concat(parts);
        contents.set(current.object, body.subarray(0, body.length - 1));
        current = null;
        parts = [];
      }
    }
  } });
  if (listed.over) throw outputRefusal(`Git's output of ${what} holds more than ${maxBytes} bytes, more than a sync reads`);
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || "git cat-file failed."), { git: listed });
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
  // The tips that the last fetch brought, which the branch may have merged since, are recorded before this fetch can prune them, and what this fetch brings after it.
  if (named) await recordShared(base, remote);
  const fetched = await git(base, ["-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--prune", "--no-prune-tags", "--no-tags", "--no-recurse-submodules", "--no-write-commit-graph",
    ...helper, target, ...(named ? [`+refs/heads/*:refs/remotes/${remote}/*`] : [])]);
  if (fetched.ok && named) await recordShared(base, remote);
  return fetched;
}

// The commits of the store's branch that it knows a named remote held, kept as refs named by their commit below SHARED_REFS/<remote>/, which no fetch prunes and no push sends:
// a fetch with --prune drops the remote-tracking branch of a branch deleted on the remote while other machines still hold its commits,
// so these refs and the remote-tracking branches are together the commits that the store knows it shares, which the push check takes as known and no refusal's reset takes off.
const SHARED_REFS = "refs/prism-store/shared";
// A remote's branches are its own, so they are listed within REMOTE_REFS_MAX of them, each with a name of at most a ref's length on any supported machine, and a remote past that is refused by name.
const refObjects = async (base, prefix) => (await gitLines(base, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)", prefix], { limit: REMOTE_REFS_MAX, maxRecord: 2 * LISTED_PATH_BYTES_MAX + LISTED_META_MAX, what: `the refs below ${prefix}` }))
  .filter(Boolean).map((line) => line.split(" ")).filter(([, , symref]) => !symref).map(([ref, object]) => [ref, object]);

/**
 * Record, after a fetch, the commits of the store's branch that the remote's branches hold, each tip that the branch holds and the merge bases of the branch with each tip it lacks,
 * and, after a push, the pushed commit, beside the commits recorded before that the branch still holds, keeping only the ones that no other of them holds.
 * Only commits that the branch holds are recorded or kept, and no commit the branch lacks ever replaces one it holds, so what the store knows its branch shares with other machines
 * outlasts a remote branch that is deleted or rewritten, even one whose tip the store never merged, while the refs stay few: a commit that the branch no longer holds, as after a push by force outside Prism, goes.
 */
async function recordShared(base, remote, pushed = []) {
  if (!REMOTE_NAME.test(remote)) return;
  const prefix = `${SHARED_REFS}/${remote}/`;
  const held = await refObjects(base, prefix);
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const shared = new Set();
  if (head.ok && head.text) {
    const holds = async (object) => (await git(base, ["merge-base", "--is-ancestor", object, head.text])).ok;
    for (const object of new Set(held.map(([, object]) => object))) if (await holds(object)) shared.add(object);
    for (const object of new Set([...(await refObjects(base, `refs/remotes/${remote}/`)).map(([, object]) => object), ...pushed])) {
      if (await holds(object)) { shared.add(object); continue; }
      // Two commits have few merge bases, so their listing is read within the bound on a remote's refs.
      const common = await gitLinesResult(base, ["merge-base", "--all", head.text, object], { limit: REMOTE_REFS_MAX, maxRecord: 128, what: "the merge bases of the store's branch and a remote branch" });
      if (common.ok) for (const commit of common.lines.filter(Boolean)) shared.add(commit);
    }
  }
  const tips = [...shared];
  // The independent tips are some of the tips given, so their listing is one line for each at most.
  const kept = new Set(tips.length > 1 ? (await gitLines(base, ["merge-base", "--independent", ...tips], { limit: tips.length, maxRecord: 128 })).filter(Boolean) : tips);
  const updates = [
    ...held.filter(([ref, object]) => !kept.has(object) || ref !== `${prefix}${object}`).map(([ref]) => `delete ${ref}\n`),
    ...[...kept].filter((object) => !held.some(([ref]) => ref === `${prefix}${object}`)).map((object) => `update ${prefix}${object} ${object}\n`)
  ];
  if (updates.length) await required(base, ["update-ref", "--stdin"], { input: updates.join("") });
}

// The commits that the store knows a remote's machines share: its remote-tracking branches and the tips recorded for it.
async function knownCommits(base, remote) {
  const refs = [...await refObjects(base, `refs/remotes/${remote}/`), ...(REMOTE_NAME.test(remote) ? await refObjects(base, `${SHARED_REFS}/${remote}/`) : [])];
  return [...new Set(refs.map(([, object]) => object))];
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
  if (named) await recordShared(base, remote, [pushed]);
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
  const checked = await checkedTip(base);
  const started = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  // A sync stopped at the bound on a store tree's files takes off the commits it made of this machine's changes, if any, so the branch, the index,
  // and the checked commit are as they were before it, and the disk too, which only a merge's replacement changes. No file is named as withheld, since none is committed.
  // Where an earlier attempt of the sync merged the upstream and lost its push to another push, that merge stays, and the message says so.
  const stopped = async (pastTree) => {
    if (run.made) await takeOffCommit(base, run.made);
    // The checked commit only lets a later check walk less, so going back to the earlier one is always safe.
    if (await checkedTip(base) !== checked) await git(base, checked ? ["update-ref", CHECKED_REF, checked] : ["update-ref", "-d", CHECKED_REF]);
    const now = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const kept = now.ok && now.text !== (started.ok ? started.text : null);
    return writeStatus(base, withheldIn({ state: "merge_failed", message: await pastTreeRefusal(pastTree, kept), conflicts, ...await counts(base) }, null));
  };
  // A sync that found an artifact update holding the artifact lock commits, merges, and pushes nothing, so no merge moves an artifact away from a file on disk that no commit holds yet;
  // it is no failure, so it ends as a sync that found another sync running does, writes no status, and the next sync, which the update's write schedules, tries again.
  const locked = () => ({ state: "skipped" });
  await commitLocal(base, author, run);
  if (run.lockBusy) return locked();
  let upstream = await upstreamOf(base);
  // A branch whose tree a commit made by hand took past the files that a store's tree may hold is refused before it is merged or pushed, with the command that takes that commit off.
  if (run.wideBranch) return report({ state: "merge_failed", message: await wideBranchRefusal(base, upstream?.remote ?? "origin", { upstream: false, sent: "merged or pushed", unsafe: run.wideBranch }), ...await counts(base) });
  // With no upstream to merge, the tree that a push would send is this machine's own, so changes that take it past the bound stop the sync.
  if (run.pending && !upstream) return stopped({ files: run.pending.files });
  if (!upstream && managed.has(base)) {
    const published = await publishBranch(base, author, options, run, conflicts);
    if (published.status) return report(published.status);
    upstream = published.upstream;
  }
  if (!upstream) return report({ state: "no_upstream", message: "The store's branch has no upstream, so records are committed locally only." });
  // The branch's new commits pass the push checks now, before the fetch, so a store whose fetches or pushes fail for a long time checks each sync's commits once rather than all of them at every sync.
  await advanceChecked(base, upstream.remote);
  let busy = false;
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    // A merge left unapplied keeps the branch where it was, so files it replaced and local writes are committed and merged again.
    if (attempt > 1) await commitLocal(base, author, run);
    if (run.lockBusy) return locked();
    if (run.wideBranch) return report({ state: "merge_failed", message: await wideBranchRefusal(base, upstream.remote, { upstream: false, sent: "merged or pushed", unsafe: run.wideBranch }), ...await counts(base) });
    const fetched = await fetchRemote(base, upstream.remote);
    if (!fetched.ok) return report({ state: "fetch_failed", message: fetched.stderr, ...await counts(base) });
    lastFetch.set(base, Date.now());
    const merged = await merge(base, author, options, run, upstream.remote);
    if (merged.pastTree) return stopped(merged.pastTree);
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
  // Each reason takes its own fix, so no message asks for a change that would not let its file sync: a shorter name, fewer bytes, a fix of what Git's object check refuses,
  // or, for a comment file past its folder's bound, which commits under no name, taking it out of the folder, after which the folder's comments show again.
  const reasons = [...withheld.values()];
  const fixes = [
    [(reason) => reason === TOO_LONG, "Give each file whose name or path is too long a shorter name in the store, and the next sync commits it."],
    [(reason) => reason.includes(OVER_BOUND), "Make each file above its kind's bound smaller than that bound in the store, and the next sync commits it."],
    [(reason) => reason.startsWith(OBJECT_CHECK), "Fix each file that Git's object check refuses in the store, as its reason says, and the next sync commits it."],
    [(reason) => reason.startsWith(OVER_COMMENTS), "Move each comment file that the sync did not commit out of its comment folder, keeping what it says if that matters, since no reader shows a comment of a folder that holds more comment files than an artifact's comments may hold, and no sync commits more of them; the folder's other comments then show again."]
  ].filter(([fits]) => reasons.some(fits)).map(([, fix]) => fix);
  // Only a sync that pushed, or had nothing to push, synced every other change; any other one committed them on this machine alone.
  const others = ["ok", "conflicts"].includes(value.state) ? "Every other change synced as usual." : "Every other change is committed on this machine only, and reaches the remote once a sync can push again.";
  const note = `The sync did not commit ${listed}${more}. ${fixes.join(" ")} ${others}`;
  return { ...value, withheld: [...withheld].map(([file, reason]) => ({ path: file, reason })), message: [value.message, note].filter(Boolean).join(" ") };
}

/**
 * Give a managed clone's branch its upstream on origin: adopt the branch another machine pushed first, or push this one with its upstream set.
 * A clone of an empty remote has no upstream until then, so its first sync publishes it instead of reporting no_upstream.
 * Returns { upstream } to continue the sync, or { status } to report.
 */
async function publishBranch(base, author, options, run, conflicts) {
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
    // A local file at a path the pushed branch holds meets the rules a merge applies: one that this sync withheld is saved before it is replaced, one above its bound by a move of the file unread.
    if (!head.ok) {
      const copies = run.heldBack?.size ? heldCopies(run, new Map(), await treeFiles(base, theirs.text)) : [];
      const adopted = await replaceFiles(base, run, { from: null, to: theirs.text, copies }, options);
      conflicts.push(...adopted.conflicts);
      if (!adopted.applied) return { status: { state: "merge_failed", message: "Record files changed or stayed locked while the upstream was applied, so the next sync applies it again." } };
    }
    await required(base, ["branch", "--quiet", `--set-upstream-to=origin/${branch}`, branch]);
    return { upstream: await upstreamOf(base) };
  }
  if (!head.ok) return { status: { state: "ok", message: "The store and its remote are still empty, so there is nothing to sync yet." } };
  await alignWithUpstream(base, author, head.text, null);
  const refused = await unpushable(base, "origin", { upstream: false });
  if (refused) return { status: { state: "merge_failed", message: refused } };
  await options.beforePush?.();
  const pushed = await pushBranch(base, "origin", `refs/heads/${branch}`, { setUpstream: branch });
  if (!pushed.ok) return { status: { state: "push_rejected", message: pushed.stderr } };
  return { upstream: await upstreamOf(base) };
}

// Merge the fetched upstream without touching the working tree, then replace changed files one by one atomically.
async function merge(base, author, options, run, remote) {
  const upstream = await git(base, ["rev-parse", "--verify", "--quiet", "@{upstream}"]);
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  // This machine's changes that its own commit would take past the bound on a store tree's files are this side of the merge, as the commit object that the branch never took,
  // so the merge holds them as if they were committed, and where nothing of the upstream merges with them, the tree that a push would send is theirs alone, which stops the sync.
  // Its files are taken as the commit read them, since a listing of its tree would pass the bound that every listing keeps.
  const pending = run.pending && head.ok && run.pending.from === head.text ? run.pending.entries : null;
  if (run.pending && !pending) return { pastTree: { files: run.pending.files }, conflicts: [] };
  // An upstream branch that the remote does not hold, as one deleted there, has nothing to merge, and the push that publishes the branch again keeps none of its entries that a store does not share.
  if (!upstream.ok && pending) return { pastTree: { files: run.pending.files }, conflicts: [] };
  if (!upstream.ok) {
    if (head.ok) await alignWithUpstream(base, author, head.text, null);
    return { applied: true, conflicts: [] };
  }
  const theirs = upstream.text;
  // A branch that holds the whole upstream takes nothing from it, and only gives its push the upstream's entries that a store does not share,
  // which are checked first, since a branch that took the upstream by hand can hold one that this machine's Git refuses in an index.
  if (head.ok && (await git(base, ["merge-base", "--is-ancestor", theirs, head.text])).ok) {
    if (pending) return { pastTree: { files: run.pending.files }, conflicts: [] };
    await refuseUnsafeTree(base, theirs);
    await alignWithUpstream(base, author, head.text, theirs);
    return { applied: true, conflicts: [] };
  }
  // The upstream is another machine's work, so its whole tree is checked before any of it is taken, whether it fast-forwards or merges.
  await refuseUnsafeTree(base, theirs);
  if (!head.ok || (!pending && (await git(base, ["merge-base", "--is-ancestor", head.text, theirs])).ok)) {
    const from = head.ok ? head.text : null;
    const kept = run.heldBack?.size ? heldCopies(run, await treeFiles(base, from), await treeFiles(base, theirs)) : [];
    return replaceFiles(base, run, { from, to: theirs, copies: kept }, options);
  }
  const mergeBase = await git(base, ["merge-base", head.text, theirs]);
  if (!mergeBase.ok || !mergeBase.text) return { failed: "The store's branch and its upstream share no commit, so the store was left as it was.", conflicts: [] };
  // Only the entries a store shares merge; every other entry comes from the upstream alone, so no machine's commit changes one and a local one never reaches the remote.
  const [original, local, upstreamFiles] = await Promise.all([mergeBase.text, pending ?? head.text, theirs].map(async (commit) => (await partition(typeof commit === "string" ? await treeFiles(base, commit) : commit))));
  // The upstream's files passed their bounds above, and a file that this machine changed and that holds more than its kind's bound, which only a commit made by hand puts on the branch,
  // is refused before the merge reads any blob, since the push would refuse it anyway and Git's output of a blob that large can outgrow what a sync reads.
  // The upstream's files are not on disk yet, so the command goes back to before that commit rather than to the upstream's tip.
  const over = await oversizedChange(base, original.shared, local.shared);
  if (over) {
    const fix = await takeOffAdvice(base, { upstream: false, known: await knownCommits(base, remote), paths: [over.path], holds: (_file, { size }) => size > over.bound,
      until: "each file while it stays above its bound", instead: oversizedFix(over.path) });
    return { failed: `The store's branch holds ${await describeOversizedEntry(over)}, so the upstream was not merged and the branch was not pushed, since every other machine's sync would then refuse the remote's branch. ${fix}`, conflicts: [] };
  }
  // Each side's change to an artifact merges at the location that the merge gives the artifact's identity, as if both sides had made it there.
  const placed = await placeByIdentity(base, original.shared, local.shared, upstreamFiles.shared);
  const { result, conflicts: fileConflicts } = await mergeFiles(base, placed.original, placed.local, placed.upstream);
  const merges = await structuralMerges(base, placed.original, placed.local, placed.upstream);
  const views = new Set(merges.views);
  // The upstream version wins, as the first push does for a stale revision, and the local version is kept beside the store once the merge applies.
  // A generated view that changed on both sides takes the upstream view whole, which the next write of its record regenerates, so it is neither saved nor reported.
  const takeUpstream = (file) => { if (placed.upstream.has(file)) result.set(file, placed.upstream.get(file)); else result.delete(file); };
  const fallback = [...new Set([...fileConflicts, ...merges.fallback])].filter((file) => !merges.merged.has(file) && !views.has(file));
  for (const file of [...fallback, ...views]) takeUpstream(file);
  // A record merged by structure takes its merged blob instead of the line merge.
  for (const [file, contents] of merges.merged) result.set(file, { mode: "100644", object: (await required(base, ["hash-object", "-w", "--no-filters", "--stdin"], { input: contents })).text });
  const clashes = [...settleFolders(result, placed.upstream), ...settleLetterCase(result, placed.local, placed.upstream)];
  // A conflict inside a place where the upstream took the whole folder or file is saved with that place.
  const inClash = (file) => clashes.some((place) => file === place || file.startsWith(`${place}/`));
  const conflicted = [...clashes, ...fallback.filter((file) => !inClash(file))];
  // A file at the store's root, such as a README that both sides changed and whose lines do not merge, keeps the upstream's version and saves the local one, as a record or an artifact does.
  const { rootFile } = await storeLayout();
  const other = conflicted.filter((file) => !isSavedFile(file) && !rootFile(file));
  if (other.length) return { failed: `The upstream conflicts with local changes to ${other.slice(0, 5).join(", ")}, so the store was left as it was.`, conflicts: [] };
  // A status record or comment whose artifact the merged store does not hold, as one changed on one machine while another removed the artifact, leaves the store and is saved and reported.
  const stranded = strandedFiles(result);
  for (const [file] of stranded) result.delete(file);
  // A comment folder that both sides' comments would take past its bound keeps every comment of the upstream and then this machine's by file name up to the bound; each other one is saved and named.
  const surplus = await surplusComments(result, placed.upstream);
  for (const [file] of surplus) result.delete(file);
  await placedIdentities(base, result, placed.identities);
  // A merge never takes the tree past the files that a store's tree may hold: where the merge of both sides' changes would, counted once every placement made its files, no file is left out to make room,
  // and the merge is not made, so the sync commits, merges, and pushes nothing, and every file stays on disk as it is.
  const { treeFilesMax } = await storeLayout();
  const merged = besides(result, upstreamFiles.other);
  if (merged.size > treeFilesMax()) return { pastTree: { files: merged.size }, conflicts: [] };
  // A file the upstream carries can still meet a local file in another letter case, which no other machine could then take.
  const clash = letterCaseClash(merged.keys());
  if (clash) return { failed: `The merge would hold ${describeUnsafeEntry({ path: clash[1], clash: clash[0] })}, so the store was left as it was. Remove or rename one of them.`, conflicts: [] };
  const tree = await writeTree(base, merged);
  const commit = (await required(base, [...author, "commit-tree", tree, "-p", head.text, "-p", theirs, "-m", `prism: merge records from ${(await git(base, ["rev-parse", "--abbrev-ref", "@{upstream}"])).text || "upstream"}`])).text;
  const copies = conflictCopies(placed.local, placed.upstream, conflicted);
  // A file at the store's root that both sides changed keeps the upstream's version: this machine's copy is saved and named as such, and where this machine removed the file, the removal that gave way is named instead.
  const bothChanged = new Map(copies.filter(([file, entry]) => entry && rootFile(file)));
  const undoneFiles = copies.filter(([file, entry]) => !entry && rootFile(file) && !placed.local.has(file)).map(([file]) => ({ file }));
  for (const [file, entry] of [...stranded, ...surplus]) if (!copies.some(([candidate]) => candidate === file)) copies.push([file, entry]);
  // A file that the merge took out of a place, as the other artifact where two met at one location or one whose placed path a store cannot hold, is saved as a conflict's local version is.
  for (const [file, entry] of placed.saved) {
    const at = copies.findIndex(([candidate]) => candidate === file);
    if (at < 0) copies.push([file, entry]); else copies[at] = [file, entry];
  }
  // A file whose local version the sync withheld keeps the branch's version in the local tree, so the merge replaces it whenever the upstream changed it, and its withheld bytes are saved as a conflict's are.
  for (const [file, entry] of heldCopies(run, local.shared, merged)) {
    const at = copies.findIndex(([candidate]) => candidate === file);
    if (at < 0) copies.push([file, entry]); else copies[at] = [file, entry];
  }
  // A saved copy of the upstream's change, which the merge took out where this machine's removal stood or where its path at the artifact's new location would be too long, is named as the other machine's change,
  // and a saved copy of either side's file whose path at that location would be too long is named with that location, as saved for that cause.
  const theirsSaved = new Set(copies.filter(([file, entry]) => placed.theirs.has(file) && placed.saved.get(file) === entry).map(([file]) => file));
  const tooLongSaved = new Map(copies.filter(([file, entry]) => placed.tooLong.has(file) && placed.saved.get(file) === entry).map(([file]) => [file, placed.tooLong.get(file)]));
  // A saved copy of a comment that its folder's bound left out is named as such, since its artifact stays, with the comments that reached the store first.
  const surplusSaved = new Set(copies.filter(([file, entry]) => surplus.some(([candidate, left]) => candidate === file && left === entry)).map(([file]) => file));
  // A saved copy of such a file is named as a change that both machines made, unless it holds the version that this machine's sync withheld, which is named as withheld.
  const bothSaved = new Set(copies.filter(([file, entry]) => entry && bothChanged.get(file) === entry).map(([file]) => file));
  // The files on disk hold this machine's side of the merge, which is the commit left unmade where there is one, while the branch moves from where it is.
  return replaceFiles(base, run, { from: head.text, diskTree: pending ?? head.text, to: commit, copies, theirs: theirsSaved, tooLong: tooLongSaved, surplus: surplusSaved, bothChanged: bothSaved, undone: [...placed.undone, ...undoneFiles] }, options);
}

/**
 * Replace the store's files with a target commit's, after saving the local versions that it replaces into a stage, so a sync that stops anywhere in between loses none of them:
 * { applied, conflicts }, where conflicts lists the saved versions, as a sync status names them, of the files the merge replaced.
 * copies lists [path, entry] for each local version to save, with entry null for a conflicted path where the local side holds no file.
 * run.heldBack maps each file whose local version the sync withheld to that version, which the replacement takes as the file's own bytes; a replaced one is withheld no more.
 * theirs names the copied paths that hold the upstream's change rather than a local version, tooLong maps each copied path that the merge left out because its path at its artifact's new location would pass a store path's bounds to that location, surplus the copied comments that their folder's bound left out,
 * bothChanged the copied files at the store's root that the upstream changed too, and undone lists the local changes that the target does not keep and no copy names, which the stage carries so that the next tool results name them once the branch moved.
 * A comment on disk that neither commit holds and that the target's comments leave no room for is saved into the stage too, which is made when it is first needed.
 */
async function replaceFiles(base, run, { from, diskTree = from, to, copies, theirs = new Set(), tooLong = new Map(), surplus = new Set(), bothChanged = new Set(), undone = [] }, options) {
  const held = run.heldBack ?? new Map();
  let stage = copies.length || undone.length ? await stageLocal(base, copies, { from, to, theirs, tooLong, surplus, bothChanged, undone }) : null;
  const progress = {
    replacing: async (file) => { if (stage) { await markReplaced(stage, file); await moveAside(base, stage, file); } },
    leaving: async (file, bytes) => {
      stage ??= await stageLocal(base, [], { from, to });
      return bytes === null ? stageSurplusMove(base, stage, file) : stageSurplus(stage, file, bytes);
    }
  };
  const applied = await apply(base, from, to, options, progress, held, diskTree);
  // The files the sync replaced change what the store's artifact listings hold.
  await markArtifactIndexStale(base);
  if (applied) for (const [file, entry] of copies) if (entry && held.get(file) === entry) { held.delete(file); run.withheld?.delete(file); }
  return { applied, conflicts: stage ? await settleStage(base, stage, applied) : [] };
}

// The withheld local versions of the files that a change from one tree to another replaces, as [path, entry].
function heldCopies(run, before, after) {
  return [...(run.heldBack ?? [])].filter(([file]) => !sameEntry(before.get(file), after.get(file)));
}

// The paths of a location's identity file and status record below the store's status folders.
const identityPath = (location) => `${ARTIFACT_IDENTITY}/${location}`;
const statusPath = (location) => `${ARTIFACT_STATUS}/${location}/${STATUS_RECORD_NAME}`;
const isIdentityFile = (relative) => relative.startsWith(`${ARTIFACT_IDENTITY}/`);

/** The artifact location that a status record or a comment file belongs to, or null for any other path. */
function derivedLocation(file) {
  if (file.startsWith(`${ARTIFACT_STATUS}/`) && file.endsWith(`/${STATUS_RECORD_NAME}`)) return file.slice(ARTIFACT_STATUS.length + 1, -(STATUS_RECORD_NAME.length + 1)) || null;
  if (!file.startsWith(`${ARTIFACT_COMMENTS}/`)) return null;
  const location = file.slice(ARTIFACT_COMMENTS.length + 1, file.lastIndexOf("/"));
  return file.lastIndexOf("/") > ARTIFACT_COMMENTS.length ? location : null;
}

// What a file of a location is to its artifact, the same at every location: its bytes, its status record, or one comment by its file name.
function roleOf(file, location) {
  if (file === `${ARTIFACTS}/${location}`) return "artifact";
  if (file === statusPath(location)) return "status";
  return `comment/${file.slice(ARTIFACT_COMMENTS.length + location.length + 2)}`;
}
function rolePath(role, location) {
  if (role === "artifact") return `${ARTIFACTS}/${location}`;
  if (role === "status") return statusPath(location);
  return `${ARTIFACT_COMMENTS}/${location}/${role.slice("comment/".length)}`;
}

// The files of a tree by the location they belong to: Map(location, Map(role, [path, entry])) for each location that holds an artifact, a status record, or a comment.
function locationGroups(files) {
  const groups = new Map();
  for (const [file, entry] of files) {
    const location = file.startsWith(`${ARTIFACTS}/`) ? file.slice(ARTIFACTS.length + 1) : derivedLocation(file);
    if (location === null) continue;
    if (!groups.has(location)) groups.set(location, new Map());
    groups.get(location).set(roleOf(file, location), [file, entry]);
  }
  return groups;
}

/**
 * The identity of each artifact a tree holds: ids, Map(location, id); where, Map(id, location); and written, Map(location, id) for the id each identity file holds.
 * An artifact takes the id its identity file holds, and the id its location gives when that file is missing, of another form, larger than an identity file, or holds an id that another artifact of the tree also holds.
 * The tree is another machine's work, so an identity file is read only when Git's object database says it is a blob small enough to be one.
 */
async function treeIdentities(base, files, groups) {
  const wanted = [];
  for (const [location, group] of groups) {
    const entry = group.has("artifact") ? files.get(identityPath(location)) : undefined;
    if (entry && FILE_MODES.has(entry.mode)) wanted.push([location, entry.object]);
  }
  const contents = await readBlobs(base, wanted.map(([location, object]) => ({ file: identityPath(location), entry: { mode: "100644", object }, max: IDENTITY_FILE_MAX })));
  const written = new Map();
  for (const [index, [location]] of wanted.entries()) {
    const id = Buffer.isBuffer(contents[index]) ? identityOf(contents[index]) : null;
    if (id !== null) written.set(location, id);
  }
  // An id that two locations hold is no artifact's own, so each location whose file gave it takes the id the location gives instead, until no two locations share one.
  const ids = uniqueIdentities([...groups].filter(([, group]) => group.has("artifact")).map(([location]) => location), written);
  return { ids, where: new Map([...ids].map(([location, id]) => [id, location])), written };
}

// A comment file is small, so a larger blob that a tree holds there is moved with its bytes as they are and never read.
const COMMENT_BYTES_MAX = 64 * 1024;

// The comment module, which schedules a sync after it writes a comment, imports this one, so it loads when a merge first places a comment.
let comments;
const commentModule = () => comments ??= import("./artifact-comments.mjs");
const commentForm = () => commentModule().then(({ storedComment }) => storedComment);
const commentFileReader = () => commentModule().then(({ readCommentFile }) => readCommentFile);

// The entry a file of one location takes at another: a comment of the exact form Prism writes names its new location, as a move rewrites it, and every other file keeps its bytes as they are.
async function placedEntry(base, role, entry, from, to) {
  if (!role.startsWith("comment/") || !FILE_MODES.has(entry.mode)) return entry;
  const bytes = await readBlob(base, rolePath(role, from), entry, COMMENT_BYTES_MAX);
  if (!Buffer.isBuffer(bytes)) return entry;
  const value = (await commentForm())(role.slice("comment/".length), bytes, from);
  if (value === null) return entry;
  const object = (await required(base, ["hash-object", "-w", "--no-filters", "--stdin"], { input: Buffer.from(`${JSON.stringify({ ...value, location: to })}\n`, "utf8") })).text;
  return { ...entry, object };
}

/**
 * The shared entries of the merge base and both sides with every artifact's files, its bytes, its status record, and its comments, placed in each tree at the one location that the merge gives the artifact's identity,
 * so a path merge takes each change as if both sides had made it there: a file only one side changed takes that side's version, and one both changed merges by lines or keeps the upstream's.
 * The merge gives an identity the location at which both sides hold it, else the one to which one side moved it while the other kept it where the base held it,
 * else the upstream's where both moved it, else, where only one side holds it, the one at which that side holds it, unless the other side's removal of it stands, so it takes none:
 * the upstream's removal stands wherever this machine holds the artifact as the base did, and a change this machine made to it meets the removal at its location and is saved,
 * while this machine's removal stands against every upstream change that left the artifact's bytes as the base held them, whose changed files are saved,
 * and gives way only to an upstream edit of its bytes, after which this side holds it there as the base did, so every upstream change to it merges in.
 * Every other location is left as the side that moved the artifact away or removed it left it.
 * Where two identities would take one location, it keeps the one the upstream holds there; the other goes to where the upstream holds it,
 * or, when the upstream holds it nowhere else, leaves the merge, and each of its local files that the base does not hold alike and that differs from what the location keeps is saved.
 * A file whose placed path would exceed the bounds of a store path is not placed: a side's version that the base does not hold alike is saved instead.
 * Identity files take no part in the path merge; placedIdentities gives back the one of each artifact the merge keeps.
 * Returns { original, local, upstream, saved, theirs, undone, identities }: the trees as Map(path, entry), saved as Map(path, entry) of the files to save under their own paths,
 * theirs as the Set of saved paths that hold the upstream's change rather than this machine's, tooLong as Map(path, location) of the saved paths left out because their path at the artifact's location would pass a store path's bounds, undone as the changes of this machine that the merge does not keep and that no saved copy names,
 * { removal: location } for a removal that gave way and { move: location, movedTo } for a move to another location that the merge sent elsewhere,
 * and what placedIdentities reads.
 */
async function placeByIdentity(base, original, local, upstream) {
  const trees = { original, local, upstream };
  const groups = {}, identities = {};
  for (const [name, files] of Object.entries(trees)) {
    groups[name] = locationGroups(files);
    identities[name] = await treeIdentities(base, files, groups[name]);
  }
  const at = (name, id) => identities[name].where.get(id) ?? null;
  // Whether a side holds an artifact as the base held it, at the same location with the same files, so the other side's removal of it is the only change and it takes no location.
  const unchanged = (name, id) => {
    const location = at(name, id);
    const [mine, was] = [groups[name].get(location), location === at("original", id) ? groups.original.get(location) : undefined];
    return Boolean(mine && was) && mine.size === was.size && [...mine].every(([role, [, entry]]) => sameEntry(was.get(role)?.[1], entry));
  };
  // Whether a side changed an artifact's bytes from the base's, wherever it holds it; a change of its status record, its comments, or its location alone leaves them.
  const editedBytes = (name, id) => groups[name].get(at(name, id))?.get("artifact")?.[1]?.object !== groups.original.get(at("original", id))?.get("artifact")?.[1]?.object;
  const final = new Map();
  // The artifacts whose removal stands while the upstream changed something other than their bytes, and those whose local removal gave way to an upstream edit of their bytes.
  const standing = new Set();
  const gaveWay = new Set();
  for (const id of new Set([...identities.local.where.keys(), ...identities.upstream.where.keys()])) {
    const [was, ours, theirs] = ["original", "local", "upstream"].map((name) => at(name, id));
    if (ours !== null && theirs !== null) final.set(id, ours === theirs || ours === was ? theirs : theirs === was ? ours : theirs);
    else if (ours !== null) { if (!unchanged("local", id)) final.set(id, ours); }
    else if (was === null) final.set(id, theirs);
    else if (editedBytes("upstream", id)) { final.set(id, theirs); gaveWay.add(id); }
    else standing.add(id);
  }
  // Two identities meet at one location only where one side holds each there; the upstream's keeps it.
  const dropped = new Set();
  const contested = new Map();
  for (let again = true; again;) {
    again = false;
    const taking = new Map();
    for (const [id, location] of final) if (!dropped.has(id)) taking.set(location, [...(taking.get(location) ?? []), id]);
    for (const [location, held] of taking) {
      if (held.length < 2) continue;
      const kept = held.find((id) => identities.upstream.ids.get(location) === id) ?? held[0];
      contested.set(location, kept);
      for (const id of held.filter((candidate) => candidate !== kept)) {
        const theirs = at("upstream", id);
        if (theirs !== null && theirs !== location) { final.set(id, theirs); again = true; }
        else dropped.add(id);
      }
    }
  }
  const placed = { original: new Map(), local: new Map(), upstream: new Map() };
  for (const [name, files] of Object.entries(trees)) {
    for (const [file, entry] of files) if (!isIdentityFile(file) && !file.startsWith(`${ARTIFACTS}/`) && derivedLocation(file) === null) placed[name].set(file, entry);
  }
  // The base's version of a file of an identity's artifact, as it would read at a location.
  const baseFile = async (id, role, location) => {
    const from = at("original", id);
    const found = from === null ? undefined : groups.original.get(from)?.get(role)?.[1];
    return found && from !== location ? placedEntry(base, role, found, from, location) : found;
  };
  const saved = new Map();
  const theirs = new Set();
  // The saved files that the merge left out because their path at the artifact's new location would pass a store path's bounds, by that location.
  const tooLong = new Map();
  // The locations at which a local file of an artifact that left the merge is saved, whose saved copy also names a local removal that gave way there.
  const savedAt = new Set();
  const save = (file, entry, name, location, longAt = null) => {
    if (saved.has(file)) return;
    saved.set(file, entry);
    if (longAt !== null) tooLong.set(file, longAt);
    if (name === "upstream") theirs.add(file); else savedAt.add(location);
  };
  const later = [];
  for (const name of ["original", "local", "upstream"]) {
    for (const [location, group] of groups[name]) {
      const id = identities[name].ids.get(location);
      // A status record or comment whose location holds no artifact in this tree stays where it is, for the merge to save if no artifact is left there.
      if (id === undefined) { for (const [file, entry] of group.values()) if (!placed[name].has(file)) placed[name].set(file, entry); continue; }
      // An artifact whose local removal stands leaves every tree, so its location is left as this machine left it, and each file in which the upstream changed it is saved.
      if (standing.has(id)) {
        if (name === "upstream") for (const [role, [file, entry]] of group) if (!sameEntry(await baseFile(id, role, location), entry)) save(file, entry, name, location);
        continue;
      }
      // An artifact that the merge gives no location, which this machine holds only as the base did while the upstream removed it, leaves every tree, so the removal stands and its location is left as the upstream left it.
      if (!final.has(id) && !dropped.has(id)) continue;
      const to = dropped.has(id) ? null : final.get(id);
      for (const [role, [file, entry]] of group) {
        const target = to === null ? null : to === location ? file : rolePath(role, to);
        if (target !== null && storePathFits(target)) {
          later.push([name, target, to === location ? entry : await placedEntry(base, role, entry, location, to)]);
          continue;
        }
        // A file that leaves the merge is saved when it holds a change of this side's that would otherwise be lost.
        if (name === "original" || sameEntry(await baseFile(id, role, location), entry)) continue;
        if (to === null && name === "local") {
          const keeps = upstream.get(file);
          const views = role === "artifact" && keeps && (await readBlobs(base, [{ file, entry }, { file, entry: keeps }])).every((bytes) => Buffer.isBuffer(bytes) && bytes.includes(GENERATED_VIEW));
          if (sameEntry(keeps, entry) || views) continue;
        }
        if (name === "local" || to !== null) save(file, entry, name, location, to);
      }
    }
  }
  for (const [name, target, entry] of later) placed[name].set(target, entry);
  // A local removal that gave way to an upstream edit of the artifact's bytes: this side then holds it where the merge keeps it as the base did, so each of its files takes the upstream's version there.
  // A path at which this side now holds a folder, or below a file it holds, stays as it is, so the merge settles that clash as it settles every other one, for the upstream's file.
  const undone = [];
  const clashes = (target) => folders(target).some((folder) => placed.local.has(folder)) || [...placed.local.keys()].some((file) => file.startsWith(`${target}/`));
  for (const id of gaveWay) {
    const location = final.get(id);
    for (const [role] of groups.original.get(at("original", id))) {
      const target = rolePath(role, location);
      const entry = await baseFile(id, role, location);
      if (entry && storePathFits(target) && !placed.local.has(target) && !clashes(target)) placed.local.set(target, entry);
    }
    // A local file that left the merge at that location is saved, and its saved copy names the removal; any other removal that gave way is named on its own.
    if (!savedAt.has(location)) undone.push({ removal: location });
  }
  // A local move that the merge did not keep, while it keeps the artifact at another location, as where both sides moved it or where the location it was moved to keeps the upstream's artifact.
  for (const id of identities.local.where.keys()) {
    const [was, ours] = [at("original", id), at("local", id)];
    if (was !== null && ours !== was && final.has(id) && !dropped.has(id) && final.get(id) !== ours) undone.push({ move: final.get(id), movedTo: ours });
  }
  const kept = new Map();
  for (const [id, location] of final) if (!dropped.has(id)) kept.set(location, id);
  return { ...placed, saved, theirs, tooLong, undone, identities: { trees: { local, upstream }, of: identities, kept } };
}

/**
 * Give each artifact of a merged result its identity file again: the file that the upstream, else the local side, holds for that identity at that location,
 * else a new file where the identity came from another location, while an artifact whose identity its own location gives needs none.
 */
async function placedIdentities(base, result, { trees, of, kept }) {
  for (const file of [...result.keys()]) {
    if (!file.startsWith(`${ARTIFACTS}/`)) continue;
    const location = file.slice(ARTIFACTS.length + 1);
    const id = kept.get(location);
    const side = ["upstream", "local"].find((name) => trees[name].has(identityPath(location)) && (id === undefined || of[name].written.get(location) === id));
    if (side) result.set(identityPath(location), trees[side].get(identityPath(location)));
    else if (id !== undefined && id !== locationIdentity(location)) {
      result.set(identityPath(location), { mode: "100644", object: (await required(base, ["hash-object", "-w", "--no-filters", "--stdin"], { input: Buffer.from(identityContent(id), "utf8") })).text });
    }
  }
}

/** The status records and comments of a merged result whose location holds no artifact there, as [path, entry]. */
/**
 * The comment files of a merged result that take a comment folder past the comments an artifact may hold, as [path, entry]: a folder keeps every comment file the upstream holds in it
 * and then the others by file name up to the bound, and the rest are this list, which the merge leaves out and saves.
 */
async function surplusComments(result, upstream) {
  const { isCommentFile, commentsMax } = await storeLayout();
  const byFolder = new Map();
  for (const file of result.keys()) if (isCommentFile(file)) byFolder.set(path.posix.dirname(file), [...byFolder.get(path.posix.dirname(file)) ?? [], file]);
  const surplus = [];
  for (const files of byFolder.values()) {
    if (files.length <= commentsMax) continue;
    const theirs = files.filter((file) => sameEntry(upstream.get(file), result.get(file)));
    const ours = files.filter((file) => !sameEntry(upstream.get(file), result.get(file))).sort();
    for (const file of ours.slice(Math.max(0, commentsMax - theirs.length))) surplus.push([file, result.get(file)]);
  }
  return surplus;
}

function strandedFiles(result) {
  const stranded = [];
  for (const [file, entry] of result) {
    const location = derivedLocation(file);
    if (location !== null && !result.has(`${ARTIFACTS}/${location}`)) stranded.push([file, entry]);
  }
  return stranded;
}

/**
 * The first file that the local side changed from the merge base and that holds more than its kind's bound, as { path, size, bound }, or null.
 * The sizes come from one listing of Git's object sizes, so no blob is read.
 */
async function oversizedChange(base, original, local) {
  const { bound } = await storeLayout();
  const changed = [...local].filter(([file, entry]) => FILE_MODES.has(entry.mode) && bound(file) !== null && !sameEntry(original.get(file), entry));
  if (!changed.length) return null;
  const sizes = await objectInfo(base, [...new Set(changed.map(([, { object }]) => object))]);
  for (const [file, { object }] of changed) {
    const size = sizes.get(object)?.size;
    if (size !== undefined && size > bound(file)) return { path: file, size, bound: bound(file) };
  }
  return null;
}

/**
 * Merge three trees' files path by path: result maps each file path to the entry it takes, and conflicts lists the paths that changed on both sides and do not merge.
 * A path that changed on one side only takes that side's entry, which is no entry where that side removed it, and a path that both sides changed alike keeps that change.
 * A file that both sides changed takes the line merge of its text when it merges cleanly, and otherwise the upstream's entry, so the local one is saved.
 * A file that one side moved, to another scope or within its folder, is a removal and an addition like any other, so no change follows a guessed move.
 */
async function mergeFiles(base, original, local, upstream) {
  const { bound } = await storeLayout();
  const result = new Map();
  const conflicts = [];
  for (const file of new Set([...original.keys(), ...local.keys(), ...upstream.keys()])) {
    const [was, ours, theirs] = [original.get(file), local.get(file), upstream.get(file)];
    let taken = theirs;
    if (sameEntry(ours, theirs) || sameEntry(was, theirs)) taken = ours;
    else if (!sameEntry(was, ours)) {
      const object = await lineMerge(base, file, was, ours, theirs, bound(file));
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

// The object of the clean line merge of a text file that both sides changed and kept as a regular file of one mode, or null when it conflicts, is no such file, or would hold more than limit bytes,
// so a merge that would make a file exceed its kind's bound keeps the upstream's version and saves the local one, as a line conflict does.
// A version above its kind's bound, as a merge base that a commit made elsewhere left can hold, is not read, and the file is no merge either.
// A file that both sides added merges against an empty file, as Git's own merge does.
async function lineMerge(base, file, original, local, upstream, limit = null) {
  if (!local || !upstream || local.mode !== upstream.mode || !FILE_MODES.has(local.mode) || (original && !FILE_MODES.has(original.mode))) return null;
  const read = await readBlobs(base, [local, original, upstream].map((entry) => ({ file, entry })));
  const contents = read.map((bytes, index) => index === 1 && bytes === null ? Buffer.alloc(0) : bytes);
  if (!contents.every((bytes) => Buffer.isBuffer(bytes) && isText(bytes))) return null;
  const folder = syncPath(base, "merge-files");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  try {
    const targets = ["local", "original", "upstream"].map((name) => path.join(folder, name));
    for (const [index, target] of targets.entries()) await writeAtomically(target, contents[index]);
    const merged = await git(base, ["merge-file", "-p", "--quiet", ...targets]);
    if (!merged.ok || (limit !== null && merged.stdout.length > limit)) return null;
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
async function stageLocal(base, copies, { from, to, theirs = new Set(), tooLong = new Map(), surplus = new Set(), bothChanged = new Set(), undone = [] }) {
  const folder = syncPath(base, "saving", `${Date.now()}-${process.pid}`);
  await rm(folder, { recursive: true, force: true });
  const conflicts = [];
  for (const [file, entry] of copies) {
    if (!entry) { conflicts.push({ path: file }); continue; }
    const whose = theirs.has(file) ? { theirs: true } : surplus.has(file) ? { surplus: true } : bothChanged.has(file) ? { bothChanged: true } : {};
    const cause = tooLong.has(file) ? { tooLong: tooLong.get(file) } : {};
    // A withheld file above its kind's bound stays where it is until the replacement reaches it, which moves it here, so the stage never reads or copies its bytes,
    // and its copy is named as one that this machine's sync held back for its size, which the other machine then changed or removed.
    if (entry.disk) { conflicts.push({ path: file, saved: true, moved: true, overBound: true, ...whose, ...cause }); continue; }
    const target = path.join(folder, "files", ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeAtomically(target, await boundedBlob(base, file, entry));
    conflicts.push({ path: file, saved: true, ...whose, ...cause });
  }
  await mkdir(folder, { recursive: true });
  await writeAtomically(path.join(folder, REPLACED_RECORD), "[]\n");
  await writeAtomically(path.join(folder, STAGE_RECORD), `${JSON.stringify({ from, to, conflicts, undone })}\n`);
  return { folder, from, to, conflicts, undone, replaced: [] };
}

const STAGE_RECORD = "stage.json";
const REPLACED_RECORD = "replaced.json";

/**
 * Move a withheld file above its kind's bound into the stage's copies right before the replacement replaces or removes it, which markReplaced has named first,
 * by a rename within the store's file system, or by a kernel copy and a removal where the sync folder sits on another one, so its bytes never pass through memory or Git.
 * A sync that stops before the move finds the file still on disk, and one that stops after it finds the copy in the stage, which settling then saves.
 */
async function moveAside(base, stage, file) {
  if (!stage.conflicts.some((conflict) => conflict.path === file && conflict.moved)) return;
  const source = path.join(base, ...file.split("/"));
  const target = path.join(stage.folder, "files", ...file.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  try { await renameWhenFree(source, target); }
  catch (error) {
    if (error.code === "ENOENT") return;
    if (error.code !== "EXDEV") throw error;
    const partial = path.join(stage.folder, "copying");
    await copyFile(source, partial);
    await renameWhenFree(partial, target);
    await rm(source, { force: true });
  }
}

/**
 * Save into a stage a comment of this machine's that leaves the disk because its folder already holds the comments that an artifact may hold, before the caller removes it:
 * the copy is written and named as replaced first, so a sync that stops before the removal finds the comment still on disk and drops the copy, and one that stops after it saves the copy.
 */
async function stageSurplus(stage, file, bytes) {
  const target = path.join(stage.folder, "files", ...file.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomically(target, bytes);
  stage.conflicts.push({ path: file, saved: true, surplus: true });
  await writeAtomically(path.join(stage.folder, STAGE_RECORD), `${JSON.stringify({ from: stage.from, to: stage.to, conflicts: stage.conflicts, undone: stage.undone })}\n`);
  stage.replaced.push(file);
  await writeAtomically(path.join(stage.folder, REPLACED_RECORD), `${JSON.stringify(stage.replaced)}\n`);
}

/**
 * Save into a stage, unread, a file in a comment folder that leaves the disk because its folder already holds the comments that an artifact may hold, and that the comment reader does not read,
 * such as one above a comment's bound: it is named as replaced first and then moved into the stage's copies, so a sync that stops before the move finds it still on disk and one that stops after it saves the copy.
 */
async function stageSurplusMove(base, stage, file) {
  stage.conflicts.push({ path: file, saved: true, surplus: true, moved: true });
  await writeAtomically(path.join(stage.folder, STAGE_RECORD), `${JSON.stringify({ from: stage.from, to: stage.to, conflicts: stage.conflicts, undone: stage.undone })}\n`);
  stage.replaced.push(file);
  await writeAtomically(path.join(stage.folder, REPLACED_RECORD), `${JSON.stringify(stage.replaced)}\n`);
  await moveAside(base, stage, file);
}

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
  // A file moved aside is saved once its copy is in the stage, which only the replacement's move puts there, and is still on disk otherwise, so its bytes are never read here.
  const movedAside = (conflict) => lstat(copyOf(conflict.path)).then((stats) => stats.isFile(), () => false);
  for (const conflict of stage.conflicts) {
    if (conflict.moved) { if ((moved || stage.replaced.some((file) => touches(file, conflict.path))) && await movedAside(conflict)) kept.push(conflict); continue; }
    if (moved) { kept.push(conflict); continue; }
    if (!stage.replaced.some((file) => touches(file, conflict.path))) continue;
    if (!conflict.saved) { kept.push(conflict); continue; }
    // The copy holds a blob's bytes, so the file on disk is read only up to the copy's size, and a longer one differs from it unread.
    const copy = await fileBytes(copyOf(conflict.path));
    const now = await boundedBytes(path.join(base, ...conflict.path.split("/")), copy?.length ?? 0);
    if (copy !== null && !sameBytes(now, copy)) kept.push(conflict);
  }
  // The local changes that the merge undid are named only once the branch moved to it; otherwise the next merge finds them again.
  const undone = moved ? stage.undone ?? [] : [];
  if (!kept.length && !undone.length) return dropSaved(stage);
  for (const conflict of stage.conflicts) if (conflict.saved && !kept.includes(conflict)) await rm(copyOf(conflict.path), { force: true });
  return publishSaved(base, { folder: stage.folder, conflicts: kept, undone });
}

/**
 * Move a folder of saved copies into the conflicts folder under a new conflict stamp, with a pending notice of that stamp written first,
 * so the next tool result of every Prism server that uses the store names them, whether the server ran when they were saved or started later: the stamp.
 */
async function publishCopies(base, source, about = null) {
  await mkdir(syncPath(base, "conflicts"), { recursive: true });
  await mkdir(syncPath(base, NOTICES), { recursive: true });
  // A stage that saved no copy but names undone changes publishes an empty folder of copies, so its stamp is reported as every other one is.
  await mkdir(source, { recursive: true });
  const taken = (name) => Promise.all([syncPath(base, "conflicts", name), syncPath(base, NOTICES, name), aboutPath(base, name)].map((target) => lstat(target).then(() => true, () => false))).then((found) => found.some(Boolean));
  // Two saves within one millisecond take the next free stamp.
  for (let attempt = 0; ; attempt++) {
    const candidate = new Date(Date.now() + attempt).toISOString().replace(/[:.]/g, "-");
    if (await taken(candidate)) continue;
    // What the copies are, and which changes the merge undid, is written before the stamp's copies appear, so no report of them goes without it.
    if (about) {
      await mkdir(syncPath(base, ABOUT), { recursive: true });
      await writeAtomically(aboutPath(base, candidate), `${JSON.stringify(about)}\n`);
    }
    await writeAtomically(syncPath(base, NOTICES, candidate), `${JSON.stringify({ at: new Date().toISOString() })}\n`);
    try { await rename(source, syncPath(base, "conflicts", candidate)); return candidate; }
    catch (error) {
      await rm(syncPath(base, NOTICES, candidate), { force: true });
      await rm(aboutPath(base, candidate), { force: true });
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) || attempt >= 100) throw error;
    }
  }
}

// Beside each conflict stamp that needs it, the sync folder keeps what the stamp's copies are and which local changes its merge undid:
// { theirs: [path], tooLong: [{ path, location }], surplus: [path], bothChanged: [path], overBound: [path], undone: [{ removal } | { file } | { move, movedTo }] }, with theirs naming the saved paths that hold another machine's change rather than this machine's,
// tooLong the saved paths that the merge left out because their path at the location it gave their artifact, named there, would pass a store path's bounds,
// surplus the saved comments of this machine's that their folder's bound left out of the store, bothChanged the saved files at the store's root that the other machine changed too,
// overBound the saved files that this machine's sync held back because each was above its kind's bound and that the other machine then changed or removed,
// and a file in undone a file at the store's root, such as its README, whose removal by this machine gave way to the other machine's change.
const ABOUT = "conflict-notes";
const aboutPath = (base, stamp) => syncPath(base, ABOUT, `${stamp}.json`);

/**
 * Move a stage's copies into the conflicts folder under a new conflict stamp, so every Prism server that uses the store, one started since the stage was made among them, reports them once:
 * the stage's conflicts as a sync status lists them, with savedAs relative to the store.
 */
async function publishSaved(base, { folder, conflicts, undone = [] }) {
  const theirs = conflicts.filter((conflict) => conflict.saved && conflict.theirs).map((conflict) => conflict.path);
  const surplus = conflicts.filter((conflict) => conflict.saved && conflict.surplus && !conflict.theirs).map((conflict) => conflict.path);
  const bothChanged = conflicts.filter((conflict) => conflict.saved && conflict.bothChanged && !conflict.theirs && !conflict.surplus).map((conflict) => conflict.path);
  const tooLong = conflicts.filter((conflict) => conflict.saved && noteLocation(conflict.tooLong)).map((conflict) => ({ path: conflict.path, location: conflict.tooLong }));
  const overBound = conflicts.filter((conflict) => conflict.saved && conflict.overBound && !conflict.theirs && !conflict.surplus && !conflict.bothChanged).map((conflict) => conflict.path);
  const about = theirs.length || tooLong.length || surplus.length || bothChanged.length || overBound.length || undone.length ? { theirs, tooLong, surplus, bothChanged, overBound, undone } : null;
  const stamp = conflicts.some((conflict) => conflict.saved) || undone.length ? await publishCopies(base, path.join(folder, "files"), about) : null;
  await rm(folder, { recursive: true, force: true });
  // A saved copy of the other machine's change carries theirs true, and one whose path would be too long at its artifact's new location carries that location as tooLongAt, so the status message names whose copy it is and why.
  return conflicts.map(({ path: file, saved, theirs: other, tooLong: at }) => ({ path: file, savedAs: saved ? `${SYNC_DIRECTORY}/conflicts/${stamp}/${file}` : null, ...(saved && other ? { theirs: true } : {}), ...(saved && noteLocation(at) ? { tooLongAt: at } : {}) }));
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
  // A note about a stamp whose copies never appeared, as when a sync stopped before it moved them, is removed too.
  for (const name of await readdir(syncPath(base, ABOUT)).catch(() => [])) {
    if (!name.endsWith(".json") || !(await lstat(syncPath(base, "conflicts", name.slice(0, -".json".length))).then(() => true, () => false))) await rm(syncPath(base, ABOUT, name), { force: true });
  }
  let names = [];
  try { names = (await readdir(syncPath(base, "saving"))).sort(); } catch { return []; }
  const conflicts = [];
  for (const name of names) {
    const folder = syncPath(base, "saving", name);
    const stage = await readFile(path.join(folder, STAGE_RECORD), "utf8").then(parseStoreJson).catch(() => null);
    const copies = await lstat(path.join(folder, "files")).then((stats) => stats.isDirectory(), () => false);
    if (!stage && !copies && STAMP.test(name)) {
      await publishCopies(base, folder).catch(() => rm(folder, { recursive: true, force: true }));
      continue;
    }
    // The record is the sync folder's own, and still names only paths a store shares, so no check of a stage reads outside the store.
    const valid = Array.isArray(stage?.conflicts) && stage.conflicts.every((conflict) => typeof conflict?.path === "string" && (isSavedFile(conflict.path) || shareable(conflict.path)) && conflict.path.split("/").every((part) => part && part !== "." && part !== ".."))
      && (stage.undone === undefined || (Array.isArray(stage.undone) && stage.undone.every(undoneForm)));
    const saved = valid ? stage.conflicts.filter((conflict) => conflict.saved) : [];
    if (!valid || (saved.length && !copies)) { await rm(folder, { recursive: true, force: true }); continue; }
    const moved = typeof stage.to === "string" && (await git(base, ["merge-base", "--is-ancestor", stage.to, "HEAD"])).ok;
    let replaced = await readFile(path.join(folder, REPLACED_RECORD), "utf8").then(parseStoreJson).catch(() => null);
    // A stage that an earlier Prism made has no replaced record, so each saved file whose bytes on disk differ from its copy counts as replaced, as that Prism counted it.
    if (!Array.isArray(replaced)) {
      replaced = [];
      for (const conflict of saved) {
        const copy = await fileBytes(path.join(folder, "files", ...conflict.path.split("/")));
        if (!sameBytes(await boundedBytes(path.join(base, ...conflict.path.split("/")), copy?.length ?? 0), copy)) replaced.push(conflict.path);
      }
    }
    conflicts.push(...await settleStage(base, { folder, conflicts: stage.conflicts, undone: stage.undone ?? [], replaced: replaced.filter((file) => typeof file === "string") }, moved));
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
  const { bound } = await storeLayout();
  const merged = new Map();
  const fallback = [];
  const views = [];
  const differs = (side, file) => !sameEntry(original.get(file), side.get(file));
  const changed = [...new Set([...original.keys(), ...local.keys(), ...upstream.keys()])].filter((file) => differs(local, file) && differs(upstream, file));
  const bytesOf = (side, file) => readBlob(base, file, side.get(file));
  // Prism writes the views it generates from records, such as initiative.md, into the store's artifacts, so one that both sides regenerated is not a person's change.
  for (const file of changed.filter((item) => item.startsWith(`${ARTIFACTS}/`))) {
    const [mine, theirs] = await Promise.all([local, upstream].map((side) => bytesOf(side, file)));
    if ([mine, theirs].every(Buffer.isBuffer) && !mine.equals(theirs) && [mine, theirs].every((bytes) => bytes.includes(GENERATED_VIEW))) views.push(file);
  }
  const both = changed.filter((file) => hasRecordMerge(file) || isRegistrationFile(file));
  for (const file of both) {
    const [was, mine, theirs] = await Promise.all([original, local, upstream].map((side) => bytesOf(side, file)));
    // A version above its kind's bound, whichever tree holds it, was not read, so the file keeps the upstream's version and the local one is saved.
    if ([was, mine, theirs].some(overBytes)) { if (mine !== null && theirs !== null) fallback.push(file); continue; }
    if (mine === null || theirs === null || mine.equals(theirs)) continue;
    if (isRegistrationFile(file)) {
      // Two machines that registered one repository alike, apart from when each did, as two first accesses of a new store do, lose nothing by keeping the upstream one.
      if (sameRegistration(mine, theirs)) merged.set(file, theirs); else fallback.push(file);
      continue;
    }
    const mergeRecord = await recordMergeFor(file);
    let outcome;
    try {
      outcome = await mergeRecord({ path: file, base: was?.toString("utf8") ?? null, local: mine.toString("utf8"), upstream: theirs.toString("utf8") });
    } catch (error) {
      outcome = { conflict: error.message };
    }
    // A merged record above its kind's bound keeps the upstream's version, and the local one is saved.
    const contents = typeof outcome?.contents === "string" ? Buffer.from(outcome.contents, "utf8") : null;
    const limit = bound(file);
    if (contents !== null && (limit === null || contents.length <= limit)) merged.set(file, contents);
    else fallback.push(file);
  }
  return { merged, fallback, views };
}

// Whether two registrations' bytes hold the same registration apart from the time each machine registered it.
// A registration that does not parse, nests deeper than a registration does, or cannot be compared for any other reason differs, so the merge keeps the upstream file and saves this machine's.
function sameRegistration(left, right) {
  try {
    const parsed = [left, right].map((bytes) => {
      let value;
      try { value = parseStoreJson(bytes.toString("utf8")); } catch { return null; }
      if (value === null || typeof value !== "object" || Array.isArray(value) || nestedDeeperThan(value)) return null;
      const { registeredAt, ...rest } = value;
      return canonicalJson(rest);
    });
    return parsed[0] !== null && parsed[0] === parsed[1];
  } catch {
    return false;
  }
}

/**
 * The one reader of the blobs that a sync reads, whatever tree holds them, a side, the merge base, or a conflict's copy, and whatever kind they are, a record, a status record, a comment, an artifact, or a root file:
 * each blob is sized first, from one listing of Git's object sizes, and only the blobs of at most their bound are then read, in one Git process, so no blob above its bound enters memory
 * and no Git output outgrows what a sync takes. wanted lists { file, entry, max }, where max defaults to the bound of the file's kind.
 * Returns one answer for each, in order: null for no entry or one that is no regular file, the blob's bytes exactly as Git holds them, and { size } for a blob above its bound, which is never read.
 */
async function readBlobs(base, wanted) {
  const { blobMax } = await storeLayout();
  const answers = wanted.map(() => null);
  const items = wanted.map((item, index) => ({ ...item, index })).filter(({ entry }) => entry && FILE_MODES.has(entry.mode));
  if (!items.length) return answers;
  const info = await objectInfo(base, [...new Set(items.map(({ entry }) => entry.object))]);
  const readable = new Map();
  for (const item of items) {
    const found = info.get(item.entry.object);
    if (found?.type !== "blob") throw new Error(`Git holds no blob ${item.entry.object} for ${shownPath(item.file)}.`);
    if (found.size > (item.max ?? blobMax(item.file))) answers[item.index] = { size: found.size };
    else readable.set(item.entry.object, found.size);
  }
  const total = [...readable.values()].reduce((sum, size) => sum + size + 128, 0);
  const contents = await objectContents(base, [...readable.keys()], total + 1024 * 1024);
  for (const item of items) if (answers[item.index] === null) answers[item.index] = contents.get(item.entry.object);
  return answers;
}
const readBlob = async (base, file, entry, max) => (await readBlobs(base, [{ file, entry, max }]))[0];

/**
 * A reader of the bounded blobs that a run of files takes, in the files' order: entriesOf(file) names the entries the run reads for a file.
 * It reads the blobs of the next files together, in batches of bounded size, so a sync that replaces many files takes a few Git processes rather than two for each file,
 * which on Windows, where a process starts slowly, decided how long a sync of a thousand comments took.
 * A blob it did not read in a batch, as one above its kind's bound or one of no listed file, is read by boundedBlob, which refuses one above the bound by name.
 */
async function boundedBlobReader(base, files, entriesOf, batchBytes = 32 * 1024 * 1024) {
  const { blobMax } = await storeLayout();
  const wanted = files.map((file) => entriesOf(file).filter((entry) => entry && FILE_MODES.has(entry.mode)));
  const info = await objectInfo(base, [...new Set(wanted.flat().map((entry) => entry.object))]);
  const indexOf = new Map(files.map((file, index) => [file, index]));
  const cache = new Map();
  let next = 0;
  return async (file, entry) => {
    const index = indexOf.get(file);
    if (entry && FILE_MODES.has(entry.mode) && !cache.has(entry.object) && index !== undefined && index >= next) {
      cache.clear();
      const batch = [];
      let total = 0;
      let end = index;
      // A batch takes whole files while their blobs fit in batchBytes, and always its first file, so a file is never split across two batches.
      while (end < files.length) {
        const readable = wanted[end].filter((item) => { const found = info.get(item.object); return found?.type === "blob" && found.size <= blobMax(files[end]); });
        const bytes = readable.reduce((sum, item) => sum + info.get(item.object).size + 128, 0);
        if (end > index && total + bytes > batchBytes) break;
        for (const item of readable) batch.push({ file: files[end], entry: item });
        total += bytes;
        end += 1;
      }
      next = end;
      const contents = await readBlobs(base, batch);
      batch.forEach((item, at) => { if (Buffer.isBuffer(contents[at])) cache.set(item.entry.object, contents[at]); });
    }
    return entry && cache.has(entry.object) ? cache.get(entry.object) : boundedBlob(base, file, entry);
  };
}

// The bytes of a blob that the sync writes to disk, which a store holds within its bound wherever the sync writes from: a blob above it is refused by name rather than read.
async function boundedBlob(base, file, entry) {
  const bytes = await readBlob(base, file, entry);
  if (overBytes(bytes)) {
    const { bound, boundText } = await storeLayout();
    throw new Error(`The store's Git holds ${shownPath(file)} at ${bytes.size} bytes, above the ${boundText(bound(file) ?? bytes.size)} that a store file of its kind may hold, which no sync reads, so the store was left as it was.`);
  }
  return bytes;
}
// A path that is a folder, or lies below a file, holds no file, as when a file on one side meets a folder on the other.
const fileBytes = (target) => readFile(target).catch((error) => { if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null; throw error; });

/**
 * The bytes of a regular file of at most max bytes, null where no file or a folder is there, and { size } for one above max, a link, or any other entry, which is read no further:
 * it is opened without following a link and without blocking, and its type and size come from the opened file before any byte is read, so memory stays bounded whatever the file holds;
 * where the platform has no O_NOFOLLOW, as on Windows, a check of the entry before the open stands in for it.
 * max null reads a file of any size; a file that grows past its size while it is read counts as above max.
 */
async function boundedBytes(target, max) {
  if (!constants.O_NOFOLLOW && (await lstat(target).catch(() => null))?.isSymbolicLink()) return { size: null };
  let handle;
  try { handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null;
    if (["ELOOP", "EMLINK", "ENXIO"].includes(error.code)) return { size: null };
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.isDirectory()) return null;
    if (!info.isFile() || (max !== null && info.size > max)) return { size: info.isFile() ? info.size : null };
    const buffer = Buffer.alloc(info.size + 1);
    let filled = 0;
    for (let read; filled < buffer.length && (read = (await handle.read(buffer, filled, buffer.length - filled, filled)).bytesRead) > 0;) filled += read;
    return filled > info.size ? { size: filled } : buffer.subarray(0, filled);
  } finally {
    await handle.close().catch(() => {});
  }
}
const overBytes = (bytes) => bytes !== null && !Buffer.isBuffer(bytes);
// A file read as above its bound is the same as no other bytes.
const sameBytes = (left, right) => overBytes(left) || overBytes(right) ? false : left === null || right === null ? left === right : left.equals(right);

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
  await listTree(base, commit, false, (meta, name) => {
    const [mode, , object] = meta.split(" ");
    files.set(pathOfBytes(name), utf8(name) ? { mode, object } : { mode, object, notUtf8: true });
  });
  return files;
}

/**
 * List a commit's or a tree's whole tree, giving each entry's metadata before its tab, with its size when sizes is true, and its path's bytes to take,
 * and reading no more of the listing than a store's tree may hold: a tree of more files throws an error that names the bound,
 * which a sync reports as merge_failed, as it reports an entry that no store may hold, and whose treeTooLarge holds the bound.
 */
async function listTree(base, commit, sizes, take) {
  const { treeFilesMax } = await storeLayout();
  const max = treeFilesMax();
  const listed = await gitRecords(base, ["ls-tree", "-r", "-z", ...(sizes ? ["-l"] : []), "--full-tree", commit], { separator: 0, limit: max, maxBytes: listingBytesMax(max), maxRecord: LISTED_META_MAX + LISTED_PATH_BYTES_MAX, take: (record) => {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error(`git ls-tree printed an entry without a path for ${commit}.`);
    take(record.subarray(0, tab).toString("latin1"), record.subarray(tab + 1));
  } });
  if (listed.long) {
    const tab = listed.long.indexOf(9);
    const shown = `${pathOfBytes(listed.long.subarray(tab + 1, tab + 1 + 64))}…`;
    throw Object.assign(new Error(`The store's Git holds ${longEntry(shown)} at ${commit}, so the store was left as it was.`), { unsafePath: true, longPath: shown });
  }
  if (listed.over) throw Object.assign(new Error(`The store's Git holds ${wideTree({ files: max, bytes: listed.over === "bytes" ? listingBytesMax(max) : null })} at ${commit}, so the store was left as it was.`), { unsafePath: true, treeTooLarge: max, listingBytes: listed.over === "bytes" ? listingBytesMax(max) : null });
  if (!listed.ok) throw Object.assign(new Error(listed.stderr || "git ls-tree failed."), { git: listed });
}

// A listed entry's metadata before its path, at most its mode, type, object id of 64 digits, and size, and the longest path that any supported machine holds,
// Windows with long paths, so a listing stops at the first entry past them; a listing of a tree within its bound on files, whose shared paths hold at most STORE_PATH_BYTES_MAX each, stays below listingBytesMax.
const LISTED_META_MAX = 128;
const LISTED_PATH_BYTES_MAX = 32767;
const listingBytesMax = (files) => files * (LISTED_META_MAX + STORE_PATH_BYTES_MAX);
const longEntry = (shown) => `an entry whose path holds more than ${LISTED_PATH_BYTES_MAX} bytes, the most that any supported machine holds, ${JSON.stringify(shown)}`;
const wideTree = ({ files, bytes }) => bytes ? `a tree whose listing holds more than ${bytes} bytes, more than a tree of ${files} files, ${TREE_BOUND}, at ${STORE_PATH_BYTES_MAX} bytes for each path`
  : `a tree of more than ${files} files, ${TREE_BOUND}`;

// The bound on a store tree's files, in the words of a sync's message.
const TREE_BOUND = "the most files that a store's tree may hold";

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
  let files;
  try { files = await treeFiles(base, commit); }
  catch (error) {
    if (error.treeTooLarge) return { files: error.treeTooLarge, bytes: error.listingBytes };
    if (error.longPath) return { path: error.longPath, long: true, kind: "an entry" };
    throw error;
  }
  for (const [file, entry] of files) if (kind(file, entry) === "unsafe") return { path: file, kind: entryKind(entry.mode) };
  const clash = letterCaseClash(files.keys());
  return clash ? { path: clash[1], kind: "an entry", clash: clash[0] } : null;
}

/** What to change on the remote's branch for a refusal of what it holds that no store may hold. */
export const unsafeEntryFix = (unsafe) => unsafe.files ? `Remove files${unsafe.bytes ? ", or shorten their paths," : ""} from the remote's branch until it holds at most ${unsafe.files}${unsafe.bytes ? ` whose paths hold at most ${STORE_PATH_BYTES_MAX} bytes each` : ""}.` : "Remove that path from the remote's branch.";

/** What a tree holds that no store may hold, and why, for a refusal that names a tree's unsafe entry. */
export function describeUnsafeEntry(unsafe) {
  if (unsafe.files) return `${wideTree(unsafe)}, which no store may hold, since every machine would have to list and hold them`;
  if (unsafe.long) return `${longEntry(unsafe.path)}, which no store may hold, since no machine could hold it`;
  const what = unsafe.clash ? `${shownPath(unsafe.clash)} and ${shownPath(unsafe.path)}, whose paths differ only in letter case,` : `${unsafe.kind} at ${shownPath(unsafe.path)},`;
  return `${what} which no store may hold, since a link, a path that some file system reads as Git's folder, the sync folder, or a place outside the store, a name that Windows refuses, a path that is not UTF-8, a file Prism shares whose name holds more than ${STORE_NAME_BYTES_MAX} bytes or whose path holds more than ${STORE_PATH_BYTES_MAX}, two paths that macOS and Windows read as one, a name that Git reads as .gitattributes or .gitmodules other than the store's own .gitattributes at its root, or an entry where Prism keeps its own files would make some machine's store unsafe or stuck`;
}

/** Refuse an upstream commit whose tree holds an entry no store may hold, before any file is written or removed and before the branch or the index moves, so the branch stays where it was. */
async function refuseUnsafeTree(base, commit) {
  const unsafe = await unsafeStoreEntry(base, commit);
  if (unsafe) throw Object.assign(new Error(`The upstream holds ${describeUnsafeEntry(unsafe)}, so the store was left as it was. ${unsafeEntryFix(unsafe)}`), { unsafePath: true });
  // A file above its kind's bound, or a comment folder above its bound, is refused as such an entry is, so it never reaches a disk that a reader reads.
  const over = await oversizedStoreEntry(base, commit);
  if (over) throw Object.assign(new Error(`The upstream holds ${await describeOversizedEntry(over)}, so the store was left as it was. Shrink or remove ${over.folder ? "comment files of that folder" : "that file"} on the remote's branch.`), { unsafePath: true });
}

/**
 * The refusal of a push whose branch tip holds an entry that every other machine's sync and first clone would refuse, a file above its kind's bound or a comment folder above its bound among them,
 * whose commits that the remote's branches lack hold a file above its kind's bound, or whose objects that the remote's branches lack fail the check
 * that every other machine's fetch and first clone apply, as a .gitattributes with a line over 2048 bytes does; null when the push is safe.
 * Such an object stays in the remote's history once pushed, so no later commit could undo it for the machines that refuse it.
 * upstream says whether the branch has an upstream, to whose tip the refusal tells the person to move the branch back once the remote holds it.
 */
async function unpushable(base, remote, { upstream = true } = {}) {
  const unsafe = await unsafeStoreEntry(base, "HEAD");
  if (unsafe?.files || unsafe?.long) return wideBranchRefusal(base, remote, { upstream, sent: "pushed", unsafe });
  if (unsafe) return `The store's branch holds ${describeUnsafeEntry(unsafe)}, so it was not pushed. Remove that path from the remote's branch or from this store.`;
  const known = await knownCommits(base, remote);
  // The history that an earlier check passed is walked no more, so the checks walk only the commits after the last checked one; the advice below still keeps every commit that other machines share.
  const head = (await required(base, ["rev-parse", "--verify", "HEAD"])).text;
  const checked = await checkedTip(base);
  const walked = [...known, ...(checked ? [checked] : [])];
  // Git's object check runs first, since a tree that it refuses, such as one nested deeper than Git walks, is one that no listing of the branch's files could read.
  const refused = await refusedObjects(base, head, walked);
  if (refused) {
    const places = [...new Set([...refused.places.values()].flat())];
    const named = places.length ? places : [...await treeFiles(base, "HEAD")].filter(([, entry]) => refused.objects.includes(entry.object)).map(([file]) => file);
    const fix = await takeOffAdvice(base, { upstream, known, paths: named, holds: (_file, { object }) => refused.objects.includes(object), until: "each such file until it is fixed",
      instead: `fix each such file in the store as Git's reason says, and take it out of every commit of the store's branch that no other machine holds yet while keeping every commit that other machines share, such as by making those commits again without it; the next sync then pushes the branch` });
    return `The store's branch holds ${named.length ? named.map(shownPath).join(" and ") : "an object"} that Git's object check refuses (${refused.message}), so it was not pushed, since every other machine's fetch and first clone would then refuse the remote for good. ${fix}`;
  }
  const over = await oversizedStoreEntry(base, "HEAD");
  const before = over ? null : await oversizedHistory(base, walked, head);
  const found = over ?? before;
  if (!found) {
    await required(base, ["update-ref", CHECKED_REF, head]);
    return null;
  }
  const { commentsMax } = await storeLayout();
  // A comment folder that holds too many comment files has no one file to look for, so the oldest commit that the remote lacks is taken off with every later one,
  // and where that would take off a commit that other machines share, moving the surplus comment files out of the folder lets the next sync commit their removal, since only the branch's tip counts them.
  const fix = await takeOffAdvice(base, { upstream, known, paths: found.path ? [found.path] : [], holds: (_file, { size }) => size > found.bound, until: "each file while it stays above its bound",
    instead: found.folder
      ? `move the comment files of ${shownPath(found.folder)} past the first ${commentsMax} by file name out of that folder in the store, keeping what they say if that matters, and the next sync commits their removal and pushes the branch`
      : oversizedFix(found.path) });
  if (over) return `The store's branch holds ${await describeOversizedEntry(over)}, so it was not pushed, since every other machine's sync would then refuse the remote's branch. ${fix}`;
  return `A commit of the store's branch that the remote does not hold yet holds ${await describeOversizedEntry(before)}, so the branch was not pushed, since the remote would keep that file in its history for every clone to fetch. ${fix}`;
}

/**
 * The refusal of a branch whose tree holds more files than a store's tree may, which only a commit made by hand makes, since a sync makes no commit past the bound:
 * the command that takes the commits that the remote lacks off the branch, after which files are removed from the store until the next sync can commit them, or, where that would take off a commit that other machines share, removing files by hand instead.
 * Before a merge the upstream's files are not on disk yet, so upstream is false there and the command goes back to before those commits rather than to the upstream's tip.
 */
async function wideBranchRefusal(base, remote, { upstream, sent, unsafe }) {
  const { treeFilesMax } = await storeLayout();
  const max = treeFilesMax();
  const until = unsafe.long ? "no such entry, which no sync commits" : null;
  const then = unsafe.long ? null : `then remove files that the store no longer needs from it${unsafe.bytes ? ", or shorten their paths," : ""} until it holds at most ${max}, and the next sync shares every change`;
  const instead = unsafe.long ? "remove that entry from the store's branch with a commit made by hand; the next sync then pushes the branch"
    : `remove files${unsafe.bytes ? ", or shorten their paths," : ""} from the store's branch with a commit made by hand until it holds at most ${max}; the next sync then pushes the branch`;
  const fix = await takeOffAdvice(base, { upstream, known: await knownCommits(base, remote), paths: [], holds: () => false, until, then, instead });
  const what = unsafe.files && !unsafe.bytes ? `more than ${max} files, ${TREE_BOUND}` : unsafe.long ? longEntry(unsafe.path) : wideTree(unsafe);
  return `The store's branch holds ${what}, so it was not ${sent}, since every other machine's sync would then refuse the remote's branch. ${fix}`;
}

/**
 * The refusal of a sync whose tree to push, this machine's changes merged with the upstream's as fetched, would hold more files than a store's tree may, with that count, the bound, and the fix:
 * nothing was committed, merged, or pushed, and every file stays on disk as it is, so removing files on any machine is all that the next sync needs to share every change.
 * kept says that an earlier attempt of the sync merged the upstream before another machine pushed first, which stays on the branch and on disk.
 */
async function pastTreeRefusal({ files }, kept = false) {
  const { treeFilesMax } = await storeLayout();
  const max = treeFilesMax();
  return `The tree that the sync would push, this machine's changes merged with the upstream's as fetched, would hold ${files} files, more than ${max}, ${TREE_BOUND}, `
    + (kept ? "so the sync pushed nothing: it keeps the merge of the upstream that it made before another machine pushed first, and this machine's later changes stay on disk as they are, in no commit. "
      : "so the sync committed, merged, and pushed nothing, and every file stays on disk as it is. ")
    + `Remove files that the store no longer needs, on this machine or another, until it holds at most ${max}, and the next sync shares every change.`;
}

// Take the commits that a sync made of this machine's changes off the branch, which still points at the last of them, so the branch and the index are as they were before the sync.
async function takeOffCommit(base, { from, to }) {
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!head.ok || head.text !== to) return;
  await required(base, from ? ["read-tree", from] : ["read-tree", "--empty"]);
  await required(base, from ? ["update-ref", "-m", "prism: keep the store's tree within its bound", "HEAD", from, to] : ["update-ref", "-d", "HEAD", to]);
}

// What a refusal of a file above its bound asks for where no commit can be taken off the branch without one that other machines share.
const oversizedFix = (file) => `make ${shownPath(file)} smaller than its bound in the store, and take it out of every commit of the store's branch that no other machine holds yet while keeping every commit that other machines share, such as by making those commits again without it; the next sync then pushes the branch`;

/**
 * The fix that a refusal of a commit made by hand gives: the command that takes it off the store's branch, as resetAdvice gives it, with what the next sync then does,
 * or, where no command can take it off without a commit that other machines already share, what to change instead.
 */
async function takeOffAdvice(base, { upstream, known, paths, holds, until, then = null, instead }) {
  const command = await resetAdvice(base, { upstream, known, paths, holds });
  if (command) return `Take the commit you made by hand that holds it off the store's branch: ${command}; ${then ?? `the next sync then commits the store's other changes again and withholds ${until}`}.`;
  return `No command can take the commit you made by hand that holds it off the store's branch without also taking off commits that other machines already share, so ${instead}.`;
}

/**
 * The command, with what it does, that takes off the store's branch every commit that a refused push would send from the first one that holds a refused file, while the files on disk stay as they are,
 * computed so that the person runs it as given: a soft reset to the tip of the remote's branch when the remote holds the branch,
 * else a soft reset to the parent of the oldest commit that the remote lacks and whose entry at one of the paths holds tells apart, as { object, size } from Git's object listing,
 * else, where that commit is the branch's first, the removal of the branch's ref, after which the next sync commits the files on disk as the branch's first commit.
 * With no path, or none that such a commit holds, the oldest commit that the remote lacks is the one, so the command takes off every commit the push would send.
 * The known commits are the ones that the store knows other machines share, which outlast a branch deleted on the remote, so no such command takes one off:
 * where the parent would, the last commit of the branch that other machines share is the one, and where there is no single such commit, the answer is null.
 */
async function resetAdvice(base, { upstream, known, paths, holds }) {
  if (upstream) {
    const tip = await git(base, ["rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"]);
    if (tip.ok && tip.text) return `run git reset --soft ${tip.text} in the store, which keeps every file on disk and moves the branch back to the tip of the remote's branch`;
  }
  const revisions = `HEAD\n${known.map((commit) => `^${commit}\n`).join("")}`;
  let first = null;
  if (paths.length) {
    // The commits that the remote lacks and that change one of the paths, oldest first, so no commit comes before one of its parents.
    const changing = await historyCommits(base, ["rev-list", "--topo-order", "--reverse", "--full-history", "--stdin", "--", ...paths], revisions, { GIT_LITERAL_PATHSPECS: "1" });
    const names = changing.flatMap((commit) => paths.map((file) => ({ commit, file })));
    // Git answers with one line for each name asked, "<object> <size>", or the name and "missing" for a commit that does not hold the path.
    const listed = names.length ? await gitLines(base, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], { input: `${names.map(({ commit, file }) => `${commit}:${file}`).join("\n")}\n`, limit: names.length, maxRecord: 128 + STORE_PATH_BYTES_MAX * 2, what: "the sizes of a file in the commits that the remote lacks" }) : [];
    const at = names.findIndex(({ file }, index) => {
      const [object, size] = (listed[index] ?? "").split(" ");
      return /^[0-9a-f]{40,64}$/.test(object) && holds(file, { object, size: Number(size) });
    });
    first = at < 0 ? null : names[at].commit;
  }
  const holding = first !== null;
  if (first === null) {
    // Only the oldest commit is wanted, so the listing stops at it.
    const listed = await gitRecords(base, ["rev-list", "--topo-order", "--reverse", "--stdin"], { separator: 10, maxRecord: 128, input: revisions, take: (line) => { first = line.toString("latin1"); return false; } });
    if (listed.long) throw historyRefusal("the commits that the remote lacks");
    if (!listed.ok) throw Object.assign(new Error(listed.stderr || "git rev-list failed."), { git: listed });
    first ||= null;
  }
  const parent = first ? await git(base, ["rev-parse", "--verify", "--quiet", `${first}^1`]) : { ok: false };
  const target = parent.ok && parent.text ? parent.text : null;
  if (await keepsShared(base, target, known)) {
    if (target) return `run git reset --soft ${target} in the store, which keeps every file on disk and moves the branch back to the commit before the first commit of it that the remote lacks${holding ? " and that holds the file" : ""}`;
    return `run git update-ref -d HEAD in the store, which keeps every file on disk and takes every commit off the branch, since ${holding ? "its first commit holds the file" : "the remote lacks each of them"}`;
  }
  // The latest commits of the branch that other machines share; one of them, which holds every other, is where the branch can go back to.
  const shared = [];
  for (const commit of known) {
    const common = await git(base, ["merge-base", "HEAD", commit]);
    if (common.ok && common.text) shared.push(common.text);
  }
  const latest = shared.length ? (await gitLines(base, ["merge-base", "--independent", ...new Set(shared)], { limit: new Set(shared).size, maxRecord: 128 })).filter(Boolean) : [];
  if (latest.length === 1 && await keepsShared(base, latest[0], known)) return `run git reset --soft ${latest[0]} in the store, which keeps every file on disk and moves the branch back to the last commit of it that other machines already share`;
  return null;
}

// Whether moving the branch back to target, or taking every commit off it for null, keeps every commit of it that the known commits hold, so the branch keeps every commit that other machines share.
async function keepsShared(base, target, known) {
  if (!known.length) return true;
  // A count is one line, whatever the history holds.
  const count = async (others) => (await required(base, ["rev-list", "--count", "--stdin"], { input: `HEAD\n${target ? `^${target}\n` : ""}${others}` })).text;
  return await count("") === await count(known.map((commit) => `^${commit}\n`).join(""));
}

/**
 * Write the shared files of a commit into a checkout that has none yet, each from its blob's bytes exactly, then point the checkout's index at the commit, so the first clone of a store holds what every sync expects.
 * Every other entry stays in Git only.
 */
export async function writeCommitFiles(base, commit) {
  const { shared } = await partition(await treeFiles(base, commit));
  const files = [...shared];
  // The blobs are read in batches of bounded size through the sync's one blob reader, so a store of many files takes few Git processes, no batch outgrows the output buffer, and no blob above its bound is read.
  const info = files.length ? await objectInfo(base, [...new Set(files.map(([, entry]) => entry.object))]) : new Map();
  const sizes = files.map(([, entry]) => info.get(entry.object)?.size ?? 0);
  const LIMIT = 32 * 1024 * 1024;
  for (let start = 0; start < files.length;) {
    let end = start;
    let total = 0;
    while (end < files.length && (end === start || total + sizes[end] <= LIMIT)) total += sizes[end++] + 128;
    const batch = files.slice(start, end);
    const contents = await readBlobs(base, batch.map(([file, entry]) => ({ file, entry })));
    for (const [index, [file]] of batch.entries()) {
      const bytes = contents[index];
      if (!Buffer.isBuffer(bytes)) throw new Error(`Git holds ${shownPath(file)} above the bound that a store file of its kind may hold, so its files were not written.`);
      const target = path.join(base, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
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
 * The branch moves only when every changed file held the previous commit's bytes and holds the target's bytes afterwards, in the target's spelling;
 * diskTree, when given, is the files, as Map(path, entry), that the disk holds in place of the previous commit's, as this machine's changes that the branch never took because their tree passes the bound on a store tree's files.
 * Otherwise the branch stays, so the next commit records the replaced files and the local writes, and the next merge resolves them; progress.replacing, when given, runs before each file is replaced or removed.
 * progress.leaving, when given, takes each comment on disk that neither commit holds and that the target's comments leave no room for, before it leaves the disk.
 * held maps a file whose local version the sync withheld to that version, which the file may hold in place of the branch's, or, for a file above its kind's bound, to the file on disk that it must still be.
 * On a file system that ignores letter case, as macOS and Windows use by default, a path that differs only in letter case from a file on disk opens that file,
 * so a path counts as holding bytes only when every name of it is stored in that spelling, and two changed paths that such a file system reads as one take one lock.
 */
async function apply(base, from, to, options, progress = {}, held = new Map(), diskTree = from) {
  const marker = syncPath(base, "working-tree");
  await writeAtomically(marker, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  let files = [];
  try {
    await options.beforeApply?.();
    const { shareable, bound } = await storeLayout();
    const [before, after] = await Promise.all([diskTree instanceof Map ? diskTree : treeFiles(base, diskTree), treeFiles(base, to)]);
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
          // A file is read only up to its kind's bound, so one above it is never read and holds no commit's bytes.
          const ownBytes = async (index, cache) => (await storedInSpelling(base, files[index], cache)) ? boundedBytes(targets[index], bound(files[index])) : null;
          const blobOf = await boundedBlobReader(base, files, (file) => held.get(file)?.disk ? [after.get(file)] : [before.get(file), after.get(file), held.get(file)]);
          for (const [index, file] of files.entries()) {
            // A file withheld because it is above its kind's bound is never read: it must still be the file the sync held back, which the caller moves aside before replacing it.
            if (held.get(file)?.disk) {
              if (!(await sameDiskFile(targets[index], held.get(file).disk))) return false;
              next.push(await blobOf(file, after.get(file)));
              continue;
            }
            // The branch's version is read only within its bound, as every blob the sync reads is, and one above it, which only a commit made by hand puts on the branch, is refused by name.
            const [bytes, expected] = await Promise.all([ownBytes(index, listings), blobOf(file, before.get(file))]);
            // A file whose local version the sync withheld still holds that version, which the caller saved.
            if (!sameBytes(bytes, expected) && !(held.has(file) && sameBytes(bytes, await blobOf(file, held.get(file))))) return false;
            next.push(await blobOf(file, after.get(file)));
          }
          // A comment that this machine wrote after the sync read its comment folders, as while the sync fetched or while an update held the artifact lock, is in neither commit,
          // so the merge did not count it; where the target's comments leave it no room in its folder, it is saved, named as a comment that the folder's bound left out, and leaves the disk,
          // so no folder on disk holds more comments than a reader takes.
          if (progress.leaving) {
            // Each one is read only through the comment reader, which reads a regular file of at most a comment's bound and follows no link; any other file there is moved aside unread.
            const readComment = await commentFileReader();
            for (const file of await uncountedComments(base, before, after, files)) {
              const target = path.join(base, ...file.split("/"));
              if (!(await lstat(target).catch(() => null))) continue;
              await progress.leaving(file, await readComment(target));
              await rm(target, { force: true });
            }
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
 * The comment files on disk, in the folders to which a change from one tree to another adds comments, that neither tree holds and that the target tree's comments leave no room for,
 * as paths: a folder keeps the target's comments and then these by file name up to the comments an artifact may hold. Only regular files named like a comment count, found without following a link.
 */
async function uncountedComments(base, before, after, files) {
  const { isCommentFile, commentsMax } = await storeLayout();
  const growing = new Set(files.filter((file) => isCommentFile(file) && !before.has(file) && after.has(file)).map((file) => path.posix.dirname(file)));
  if (!growing.size) return [];
  const counts = new Map([...growing].map((folder) => [folder, 0]));
  for (const file of after.keys()) if (isCommentFile(file) && counts.has(path.posix.dirname(file))) counts.set(path.posix.dirname(file), counts.get(path.posix.dirname(file)) + 1);
  const left = [];
  for (const [folder, count] of counts) {
    const entries = await readdir(path.join(base, ...folder.split("/")), { withFileTypes: true }).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; });
    const uncounted = entries.filter((entry) => entry.isFile()).map((entry) => `${folder}/${entry.name}`).filter((file) => isCommentFile(file) && !before.has(file) && !after.has(file)).sort();
    left.push(...uncounted.slice(Math.max(0, commentsMax - count)));
  }
  return left;
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

// Windows refuses to rename a folder to another spelling of its own name, so there the folder first moves to a unique name beside it.
async function respell(from, to) {
  if (process.platform !== "win32") return rename(from, to);
  const between = `${from}.respell-${process.pid}-${randomBytes(4).toString("hex")}`;
  await renameWhenFree(from, between);
  try { await renameWhenFree(between, to); } catch (error) { await renameWhenFree(between, from).catch(() => {}); throw error; }
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
      await respell(path.join(folder, stored), path.join(folder, name));
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

/**
 * What a store clone holds that its upstream lacks: { commits, files, conflicts }, commits whether any branch has a commit that no remote branch holds,
 * files whether a store file on disk differs from its branch's commit, is missing from it, or is a file the commit lacks, and conflicts whether a saved local copy of a conflict waits.
 * It reads Git's objects and the files' bytes and changes nothing, so a caller decides from it whether deleting the clone loses work.
 */
export async function localStoreChanges(base) {
  const head = await git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const ahead = await git(base, ["rev-list", "--count", "--branches", "--not", "--remotes"]);
  const commits = !ahead.ok || Number(ahead.text) > 0 || await unpublished(base);
  const committed = head.ok ? (await partition(await treeFiles(base, head.text))).shared : new Map();
  const withheld = new Map();
  const onDisk = await localFiles(base, committed, withheld);
  let files = withheld.size > 0 || onDisk.size !== committed.size;
  for (const [file, entry] of onDisk) if (!files && committed.get(file)?.object !== entry.object) files = true;
  return { commits, files, conflicts: (await listSavedConflicts(base)).length > 0 };
}
