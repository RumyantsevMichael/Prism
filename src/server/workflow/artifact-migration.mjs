import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeAtomically } from "./artifact-store.mjs";
import { ARTIFACT_MIGRATIONS, ARTIFACT_NAME_FORM, artifactAddress, artifactLocation, malformedArtifactName, repositoryScope, WORKSPACE_SCOPE } from "./artifact-paths.mjs";
import { hasStatus, writtenStatus } from "./artifact-status.mjs";
import { folderChecks, resolveArtifactFile, resolveLedgerFile, STORE_FILE_BOUNDS, withArtifactStoreLock } from "./record-store.mjs";
import { scheduleRecordSync } from "./record-store-sync.mjs";
import { roadmapViewOf } from "./roadmap.mjs";
import { generatedNotice } from "./projection.mjs";
import { ARTIFACT_CONTENT_MAX, ARTIFACT_LOCATION_MAX, artifactText, artifactVersion, collidingPath, createMovedArtifacts, pathIndex, recordMovedStatus, seenArtifacts, storedArtifactIn, writeMovedView } from "./store-artifacts.mjs";
import { roadmapPaths } from "./workflow-config.mjs";
import { parseStoreJson } from "./store-json.mjs";

// On a checkout's first access to its store, the files Git tracks under its artifact paths move into its repository's scope once, and every file the move cannot take stays where it is.
// The move writes the store and its ledger first and removes a checkout file only then, right before a tool result that reports the removal is written, and only while it holds the bytes the store took,
// so an interruption leaves a file in both places rather than in neither, and every removed file is named in the result that follows the removal,
// or, when a cancel or a host close stops that result, by a later result of the same process or as moved earlier by each later process while `git ls-files --deleted` lists it.
// Only an ordinary merged index entry, which `git ls-files -v` tags H, moves: an entry that Git keeps out of the work tree with its skip-worktree bit, such as a file a sparse checkout leaves out, never moves and is never reported,
// and an entry with the assume-unchanged bit or an unmerged path stays in the checkout, named in no ledger, and is reported with its reason, since Git would neither show nor stage its removal the ordinary way.
// While Git has a merge, rebase, am, cherry-pick, or revert in progress in the checkout, the whole move waits, and so does every removal of a decided move.
const REFERENCE_FILES_MAX = 200;
const REFERENCE_LINES_MAX = 20;
const REFERENCE_BYTES_MAX = 4 * 1024 * 1024;
// The move reads and writes its files in batches, so it never holds more than a bounded number of bytes at once.
const BATCH_FILES = 200;
const BATCH_BYTES = 16 * 1024 * 1024;
// A move of thousands of files can outlast the lock's staleness bound, so it renews the lock, and a checkout that waits for another's move waits longer than an update does.
const MOVE_LOCK = Object.freeze({ renew: true, timeoutMs: 120000 });
const LEDGER_SCHEMA = 1;
const LIST_BUFFER = 256 * 1024 * 1024;
const run = promisify(execFile);

const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

// The checkout's files that Git lists, as project-relative paths: tracked from the index, and with others the untracked ones that Git does not ignore, or with ignored the ignored ones.
// Git runs without the checkout's file system monitor, so listing runs no program that the checkout's configuration names.
async function gitFiles(root, args, pathspecs = []) {
  const { stdout } = await run("git", ["-c", "core.fsmonitor=false", "-C", root, "ls-files", "-z", ...args, "--", ...pathspecs], { maxBuffer: LIST_BUFFER });
  return [...new Set(stdout.split("\0").filter(Boolean))].sort();
}

// The state of an index entry by its `git ls-files -v` tag: H an ordinary merged entry, the only one that the move takes, h one with the assume-unchanged bit,
// S or s a skip-worktree entry, s when its assume-unchanged bit is also set, and M each stage of an unmerged path; any other tag is passed over as the move passes over a skip-worktree entry.
const ENTRY_STATES = Object.freeze({ H: "ordinary", h: "assume_unchanged", S: "skipped", s: "skipped", M: "unmerged", m: "unmerged" });

/** The index entries of a checkout by path, with their states as ENTRY_STATES names them, listed with `git ls-files -v` below the pathspecs, or the whole index without them. */
async function indexStates(root, pathspecs = []) {
  const states = new Map();
  // Each entry of `git ls-files -v -z` is its tag, a space, and its path, so a path that holds a space or a line break is read whole; each stage of an unmerged path gives one entry.
  for (const entry of await gitFiles(root, ["-v"], pathspecs)) {
    const space = entry.indexOf(" ");
    const file = entry.slice(space + 1);
    const state = ENTRY_STATES[entry.slice(0, space)] ?? "skipped";
    if (states.get(file) !== "unmerged") states.set(file, state);
  }
  return states;
}

const artifactPathspecs = (kinds) => kinds.kinds.map((entry) => `:(literal)${entry.path}`);

/**
 * The checkout's files under its artifact paths as Git lists them: { tracked, candidates, deleted, assumed, unmerged, untracked, ignored }, where tracked lists every tracked file of the checkout,
 * candidates the ordinary merged entries under the artifact paths, the only ones that the move takes, deleted holds the ones there that `git ls-files --deleted` lists, the candidates whose file the work tree lacks,
 * assumed the entries there with the assume-unchanged bit, unmerged the unmerged paths there, each once, untracked the untracked files there that Git does not ignore, and ignored the number of ignored ones there;
 * a skip-worktree entry, which Git keeps out of the work tree on purpose, is in none of these but tracked. Null when Git cannot list them.
 */
async function checkoutListing(root, kinds) {
  const inArtifactPaths = (file) => {
    const address = artifactAddress(kinds, file);
    return address !== null && address.rest !== "";
  };
  const pathspecs = artifactPathspecs(kinds);
  try {
    const states = await indexStates(root);
    const tracked = [...states.keys()].sort();
    const inState = (state) => tracked.filter((file) => states.get(file) === state && inArtifactPaths(file));
    const candidates = inState("ordinary");
    const ordinary = new Set(candidates);
    const deleted = new Set((await gitFiles(root, ["--deleted"], pathspecs)).filter((file) => ordinary.has(file)));
    const untracked = (await gitFiles(root, ["--others", "--exclude-standard"], pathspecs)).filter(inArtifactPaths);
    const ignored = (await gitFiles(root, ["--others", "--ignored", "--exclude-standard"], pathspecs)).filter(inArtifactPaths).length;
    return { tracked, candidates, deleted, assumed: inState("assume_unchanged"), unmerged: inState("unmerged"), untracked, ignored };
  } catch {
    return null;
  }
}

// The files that mark an operation in progress, in the order `git status` reads them, below the folder that `git rev-parse --git-path` locates for the checkout, a linked worktree's own included.
const OPERATION_MARKERS = Object.freeze(["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer/todo"]);
const MARKER_READ_MAX = 64 * 1024;

/**
 * The operation that Git has in progress in the checkout, as `merge`, `rebase`, `am`, `cherry-pick`, or `revert`, or null when there is none:
 * a `rebase-apply` folder holding `applying` is `git am`, and a sequencer's todo list without a cherry-pick or revert head names the operation by its first command.
 * Throws when Git cannot locate the markers, so a caller that cannot tell moves and removes nothing.
 */
async function operationInProgress(root) {
  const { stdout } = await run("git", ["-c", "core.fsmonitor=false", "-C", root, "rev-parse", ...OPERATION_MARKERS.flatMap((marker) => ["--git-path", marker])], { maxBuffer: LIST_BUFFER });
  const located = stdout.split("\n").filter(Boolean);
  if (located.length !== OPERATION_MARKERS.length) throw new Error("git rev-parse did not locate every marker");
  const at = new Map(OPERATION_MARKERS.map((marker, index) => [marker, path.resolve(root, located[index])]));
  const present = async (marker) => (await lstat(at.get(marker)).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; })) !== null;
  if (await present("MERGE_HEAD")) return "merge";
  if (await present("rebase-merge")) return "rebase";
  if (await present("rebase-apply")) return await lstat(path.join(at.get("rebase-apply"), "applying")).then(() => "am", () => "rebase");
  if (await present("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (await present("REVERT_HEAD")) return "revert";
  if (await present("sequencer/todo")) {
    const todo = (await fileBytes(path.dirname(at.get("sequencer/todo")), path.basename(at.get("sequencer/todo")), MARKER_READ_MAX).catch(() => null))?.toString("utf8") ?? "";
    const first = todo.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? "";
    return /^revert\s/.test(first) ? "revert" : "cherry-pick";
  }
  return null;
}

// The files among the given ones that the checkout's work tree holds as regular files.
async function heldFiles(root, files) {
  const held = [];
  for (const file of files) if ((await lstat(path.join(root, ...file.split("/"))).catch(() => null))?.isFile()) held.push(file);
  return held;
}

/** The ordinary tracked files under a checkout's artifact paths, the ones that a move takes, that its work tree holds as regular files, or null when Git cannot list them; it reads and runs nothing else. */
export async function waitingArtifactFiles(root, kinds) {
  const listing = await checkoutListing(root, kinds);
  return listing === null ? null : heldFiles(root, listing.candidates);
}

/**
 * The files that Git tracks under a checkout's artifact paths and that its work tree holds, other than a skip-worktree entry and those that left says stay, sorted by what a move does with them: { waiting, kept } as counts,
 * or null when Git cannot list them. An assume-unchanged entry and an unmerged path are kept, whatever a ledger lists; an ordinary file is kept when a ledger of the repository lists it as kept and none lists it as moved,
 * unless every such ledger kept it as too_large or not_text and it now holds at most 1 MiB of UTF-8 text; every other file waits for a move to decide on it. It reads the checkout and the store's ledgers, and writes nothing.
 */
export async function checkoutArtifactsByMove(root, kinds, { store, repository, left = () => false }) {
  const listing = await checkoutListing(root, kinds);
  if (listing === null) return null;
  const files = (await heldFiles(root, listing.candidates)).filter((file) => !left(file));
  const counts = { waiting: 0, kept: (await heldFiles(root, [...listing.assumed, ...listing.unmerged])).filter((file) => !left(file)).length };
  if (!files.length) return counts;
  const ledger = await ledgersOf(store, repository);
  const resolvable = new Set(["too_large", "not_text"]);
  await withCheckoutFiles(root, async (access) => {
    for (const file of files) {
      const reasons = ledger.keptFor.get(file);
      let kept = reasons !== undefined && !ledger.movedFrom.has(file);
      if (kept && [...reasons].every((reason) => resolvable.has(reason))) {
        const read = await access.read(file, ARTIFACT_CONTENT_MAX).catch(() => null);
        if (read?.bytes && artifactText(read.bytes) !== null) kept = false;
      }
      counts[kept ? "kept" : "waiting"] += 1;
    }
  });
  return counts;
}

// Whether any configured artifact path exists in the checkout, so a checkout that Git cannot list is reported only when it holds something the move would have taken.
async function holdsArtifactPaths(root, kinds) {
  for (const entry of kinds.kinds) if (await lstat(path.join(root, ...entry.path.split("/"))).then(() => true, () => false)) return true;
  return false;
}

// The bytes of a store file, read without following a symbolic link, or null when it is gone, is no regular file, or holds more than max bytes, so no read takes more than that.
async function fileBytes(folder, file, max = Infinity) {
  let handle;
  try { handle = await open(path.join(folder, ...file.split("/")), READ_FLAGS); }
  catch (error) { if (GONE.includes(error.code)) return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return null;
    return await handle.readFile();
  } finally { await handle.close(); }
}

/*
 * A checkout's files are read into the store and removed only while each lies inside the checkout through real folders, so a folder swapped for a symbolic link
 * at any point of a move makes the move pass over the files below it rather than read or remove files outside the checkout.
 * Node has no openat or unlinkat. On Linux, a path below /proc/self/fd/<n> resolves inside the folder that the descriptor holds open, as openat would,
 * and that link reads as the folder's real path at that moment, so each file is opened and removed through its folder held open,
 * after the folder's real path is confirmed to be its place below the checkout's real path; the window that remains is the one system call between that confirmation
 * and the open or unlink, in which the held folder could be renamed out of the checkout, so the move could read or remove only the file it decided on, never one that was outside the checkout.
 * Elsewhere, each folder from the checkout's root down is checked by path to be a real folder before and after the file is opened and right before it is removed,
 * and the file at the path must be the file opened, so the window is the one system call between the last check and the open or unlink.
 * A removal also checks, right before the unlink, that the folder's entry is still the file whose bytes it hashed, unchanged; the window there is one system call,
 * in which a file saved at the same path inside the checkout could be removed in its place.
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const FOLDER_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY || 0);
const GONE = ["ENOENT", "ENOTDIR", "ELOOP"];
// The folders a checkout's access holds open at once, the most recently used ones, so a move of many folders never runs out of descriptors.
const FOLDERS_OPEN_MAX = 16;
let heldFolders = null;
// Whether /proc/self/fd names the folders a process holds open, which Linux provides.
function holdsFolders() {
  heldFolders ??= (async () => {
    if (process.platform !== "linux") return false;
    let handle;
    try { handle = await open("/", FOLDER_FLAGS); return await readlink(`/proc/self/fd/${handle.fd}`) === "/"; }
    catch { return false; }
    finally { await handle?.close().catch(() => {}); }
  })();
  return heldFolders;
}

const sameFile = (left, right) => right !== null && left.dev === right.dev && left.ino === right.ino;
const unchangedFile = (left, right) => sameFile(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

/**
 * Access to a checkout's files that reads and removes a file only while it lies inside the checkout through real folders:
 * { real, read(file, max), remove(file, { version, size }), removeFolder(folder), close() }, where real is the checkout's real root that every path resolves below.
 * Given the real root of an earlier access, such as the decision of the move whose files it removes, it resolves every path below that real root, and while the checkout's root resolves elsewhere,
 * such as after the root or a folder above it was swapped for a link, it finds every file outside the checkout, so it never reads or removes a file of another tree.
 * read returns { size, bytes } with bytes null above max, or null when the file is gone, is no regular file, or does not lie inside the checkout through real folders;
 * remove returns "removed", "gone" when it already left its folder, or "changed" when it holds other bytes, is no regular file, or does not lie inside the checkout through real folders;
 * lacks(file) says whether the work tree holds nothing at the file's path while the checkout's root still resolves to the real root.
 */
async function checkoutFiles(root, decided = null) {
  const real = decided ?? await realpath(root);
  const linked = await holdsFolders();
  // Whether the checkout's root still resolves to the real root; a file is "gone" only while it does, since a missing folder below a root that moved away says nothing of the checkout.
  const rootHere = async () => await realpath(root).catch(() => null) === real;
  const absent = async () => await rootHere() ? "gone" : null;
  const handles = new Map();
  const placeOf = (folder) => folder === "" ? real : path.join(real, ...folder.split("/"));
  const parts = (file) => { const names = file.split("/"); return { folder: names.slice(0, -1).join("/"), name: names.at(-1) }; };
  const release = async (folder) => { const handle = handles.get(folder); handles.delete(folder); await handle?.close().catch(() => {}); };
  const hold = async (folder) => {
    const handle = await open(placeOf(folder), FOLDER_FLAGS);
    handles.set(folder, handle);
    while (handles.size > FOLDERS_OPEN_MAX) await release(handles.keys().next().value);
    return handle;
  };
  // A path that resolves inside the folder at its place right now; "gone" when no folder is there; null when what is there is no real folder at its place.
  const placed = async (folder) => {
    const place = placeOf(folder);
    if (linked) {
      for (const fresh of [false, true]) {
        let handle = fresh ? null : handles.get(folder);
        if (handle) { handles.delete(folder); handles.set(folder, handle); }
        else {
          if (fresh) await release(folder);
          try { handle = await hold(folder); } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return absent(); if (error.code === "ELOOP") return null; throw error; }
        }
        const prefix = `/proc/self/fd/${handle.fd}`;
        if (await readlink(prefix).catch(() => null) === place) return prefix;
        // A folder held from an earlier file can have been replaced by another real folder since, which a fresh open finds.
      }
      return null;
    }
    let current = real;
    for (const name of folder === "" ? [] : folder.split("/")) {
      current = path.join(current, name);
      const info = await lstat(current).catch(() => null);
      if (info === null || !(info.isDirectory() || info.isSymbolicLink())) return absent();
      if (!info.isDirectory()) return null;
    }
    return await realpath(place).catch(() => null) === place && await rootHere() ? place : null;
  };
  // The file opened without following a link, confirmed afterwards to be the file at its path in its folder at its place: { state: "open", ... }, or { state: "gone" | "outside" }.
  const opened = async (file) => {
    const { folder, name } = parts(file);
    const prefix = await placed(folder);
    if (prefix === "gone") return { state: "gone" };
    if (prefix === null) return { state: "outside" };
    const entry = `${prefix}/${name}`;
    // An entry that is no regular file, such as a FIFO, a socket, or a device, is passed over without being opened, since opening some of them blocks or fails.
    const before = await lstat(entry).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; });
    if (before === null) return { state: await absent() ?? "outside" };
    if (before.isSymbolicLink()) return { state: "outside" };
    if (!before.isFile()) return { state: "gone" };
    let handle;
    try { handle = await open(entry, READ_FLAGS); }
    catch (error) {
      if (error.code === "ENOENT") return { state: await absent() ?? "outside" };
      if (GONE.includes(error.code)) return { state: "outside" };
      // An entry replaced since by one that open refuses, such as a socket, is no regular file either.
      if (!(await lstat(entry).catch(() => null))?.isFile()) return { state: "gone" };
      throw error;
    }
    const info = await handle.stat({ bigint: true });
    if (info.isFile() && await placed(folder) === prefix && sameFile(info, await lstat(entry, { bigint: true }).catch(() => null))) return { state: "open", handle, info, folder, prefix, entry };
    await handle.close();
    return { state: info.isFile() ? "outside" : "gone" };
  };
  return {
    real,
    async read(file, max = Infinity) {
      const found = await opened(file);
      if (found.state !== "open") return null;
      try {
        const size = Number(found.info.size);
        if (size > max) return { size, bytes: null };
        const bytes = await found.handle.readFile();
        return bytes.length > max ? { size: bytes.length, bytes: null } : { size: bytes.length, bytes };
      } finally { await found.handle.close(); }
    },
    async remove(file, { version, size }) {
      const found = await opened(file);
      if (found.state !== "open") return found.state === "gone" ? "gone" : "changed";
      try {
        if (Number(found.info.size) !== size) return "changed";
        const bytes = await found.handle.readFile();
        const read = await found.handle.stat({ bigint: true });
        if (bytes.length !== size || artifactVersion(bytes) !== version || !unchangedFile(found.info, read)) return "changed";
        // Right before the unlink, the folder is still the real folder at its place, and its entry is still the file just hashed, unchanged.
        if (await placed(found.folder) !== found.prefix || !unchangedFile(read, await lstat(found.entry, { bigint: true }).catch(() => null))) return "changed";
        try { await unlink(found.entry); } catch (error) { if (error.code === "ENOENT") return "gone"; throw error; }
        return "removed";
      } finally { await found.handle.close(); }
    },
    async lacks(file) {
      const { folder, name } = parts(file);
      const prefix = await placed(folder);
      if (prefix === null) return false;
      if (prefix === "gone") return true;
      const entry = await lstat(`${prefix}/${name}`).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; });
      return entry === null && await absent() === "gone";
    },
    async removeFolder(folder) {
      const { folder: parent, name } = parts(folder);
      const prefix = await placed(parent);
      if (prefix === null || prefix === "gone") return false;
      return rmdir(`${prefix}/${name}`).then(() => true, () => false);
    },
    async close() { for (const folder of [...handles.keys()]) await release(folder); }
  };
}

// Run action with a checkout's file access, resolved below the real root of an earlier access when one is given, and close the folders it held open afterwards.
async function withCheckoutFiles(root, action, real = null) {
  const access = await checkoutFiles(root, real);
  try { return await action(access); } finally { await access.close(); }
}

// The ledgers of earlier moves of the repository: the locations each moved into the store, the checkout paths each moved from with the location that the latest such ledger gives, and the files each kept with their reasons.
const readLedgers = (seen) => ledgersOf(seen.store.base, seen.repository);

async function ledgersOf(storeBase, repository) {
  const folder = path.join(storeBase, ARTIFACT_MIGRATIONS);
  const ledger = { moved: new Set(), movedFrom: new Set(), movedTo: new Map(), kept: new Set(), keptFor: new Map() };
  let names = [];
  try { names = (await readdir(folder)).filter((name) => name.endsWith(".json")).sort(); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  for (const name of names) {
    let entry;
    // A ledger above its bound reads as a damaged ledger, unread, which lists nothing.
    try { entry = parseStoreJson((await fileBytes(folder, name, STORE_FILE_BOUNDS.ledger))?.toString("utf8") ?? "null"); }
    catch { continue; }
    if (entry?.repository !== repository) continue;
    for (const move of Array.isArray(entry.moved) ? entry.moved : []) {
      if (typeof move?.to === "string") ledger.moved.add(move.to);
      if (typeof move?.from === "string") ledger.movedFrom.add(move.from);
      if (typeof move?.from === "string" && typeof move?.to === "string") ledger.movedTo.set(move.from, move.to);
    }
    // Only text names a path or a reason, so no value that a sync brings in a ledger is turned into a string.
    for (const kept of Array.isArray(entry.kept) ? entry.kept : []) {
      if (typeof kept?.path !== "string" || typeof kept.reason !== "string") continue;
      ledger.kept.add(`${kept.path}\0${kept.reason}`);
      ledger.keptFor.set(kept.path, new Set([...ledger.keptFor.get(kept.path) ?? [], kept.reason]));
    }
  }
  return ledger;
}

/**
 * Move a checkout's tracked files under its artifact paths into its repository's scope.
 * The caller gives the checkout's root and artifact kinds, the store's folder and the repository's accepted name, pull, or null without sync, named, the set of the checkout's paths that the server process's results name as moved,
 * and prepare({ pulled }), which returns { seen, recordSources, frozenTests }: the scopes the checkout sees, the record files that the record move takes,
 * and the frozen tests of accepted designs, which all stay in the checkout; pulled says that prepare runs right after a pull, while the store's sync lock is held.
 * pull(move) completes a pull of a synced store and, while it still holds the store's sync lock, runs move, so the move decides against no older pull;
 * it returns { pulled, state, outcome }, where outcome is what move returned, or null when another tool result carries it, and rejects with move's error.
 * What move returns, and what this returns, is a report, or a decided move whose store copies, status records, and ledger are written and whose finish({ proceed, writes }) removes the checkout's moved files and returns the report,
 * which the caller runs only right before it writes a tool result that carries the report, as finishedMove says.
 * The report is null when there is nothing to report, else { repository, store, moved, earlier, kept, passed, untracked, ignored, references, moreReferences, ledger },
 * or { repository, store, deferred } when the pull did not complete, { repository, store, operation } while Git has the named operation in progress in the checkout, so the whole move waits,
 * or { repository, store, unlisted: true } when Git cannot list the checkout's files:
 * moved lists { from, to } from checkout path to location below artifacts/, earlier lists the files moved earlier in the same form, kept lists { path, reason, location?, other?, size? },
 * passed lists the assume-unchanged entries and unmerged paths that the report names, as { path, reason } with reason assume_unchanged or unmerged, which no ledger names, untracked lists checkout paths,
 * references lists { file, lines, more }, and ledger lists the names of the ledger files the move wrote, or is null; retry: true says that the ledger could not confirm some moves, whose files stay for a later move.
 */
export async function migrateArtifacts({ root, kinds, store, repository, pull = null, named = null, prepare }) {
  const listing = await checkoutListing(root, kinds);
  if (listing === null) return await holdsArtifactPaths(root, kinds) ? { repository, store, unlisted: true } : null;
  const report = (listing, outcome) => ({ repository, store, untracked: listing.untracked, ignored: listing.ignored, references: [], moreReferences: 0, moved: [], earlier: [], kept: [], passed: [], ledger: null, ...outcome });
  const quiet = (listing, passed = []) => passed.length || listing.untracked.length || listing.ignored ? report(listing, { passed }) : null;
  // An operation that started since the last look, such as during a pull, stops the move as well: the move looks again right before it decides and right before it writes.
  const operation = async () => {
    const waiting = await waitsFor(root);
    if (waiting === undefined) return { repository, store, unlisted: true };
    return waiting ? { repository, store, operation: waiting } : null;
  };
  const decide = async (listing, { seen, recordSources, frozenTests }) => {
    const stopped = await operation();
    if (stopped) return stopped;
    const left = (file) => recordSources.has(file) || frozenTests.has(file);
    const files = listing.candidates.filter((file) => !left(file));
    const passed = await passedOver(seen, listing, left);
    if (!files.length) return quiet(listing, passed);
    const { earlier, lacking } = await movedEarlier(seen, files, listing.deleted, named);
    const present = files.filter((file) => !lacking.has(file));
    if (!present.length && !earlier.length) return quiet(listing, passed);
    // Files moved earlier are only reported, so a move that has nothing else to take writes nothing and takes no lock.
    const decided = present.length ? await withArtifactStoreLock(seen, async () => await operation() ?? { into: await moveIntoStore(seen, present) }, MOVE_LOCK) : { into: { moved: [], kept: [], ledger: null, real: await realpath(root) } };
    if (!decided.into) return decided;
    return { finish: (options) => finishMove(seen, listing, { ...decided.into, earlier, passed }, report, { ...options, named }) };
  };
  const decides = (listing) => listing.candidates.length || listing.assumed.length || listing.unmerged.length;
  if (!decides(listing)) return quiet(listing);
  // While Git has an operation in progress, the work tree holds bytes that no commit holds yet and the operation's next commit takes every staged change, so the whole move waits, before any pull.
  const stopped = await operation();
  if (stopped) return stopped;
  // A pull runs only when some file's decision reads the store, so files that every move keeps or passes over never make an access wait for the remote.
  if (pull && await anyDependsOnStore(root, kinds, repository, listing.candidates)) {
    // The move runs right after the pull that pull completes, and lists the checkout again, since a retry's pull can end long after this access.
    const pulled = await pull(async () => {
      const fresh = await checkoutListing(root, kinds);
      if (fresh === null) return { repository, store, unlisted: true };
      return decides(fresh) ? decide(fresh, await prepare({ pulled: true })) : quiet(fresh);
    });
    if (!pulled.pulled) return { repository, store, deferred: { state: pulled.state } };
    return pulled.outcome;
  }
  return decide(listing, await prepare({ pulled: false }));
}

// The operation that the checkout has in progress, null for none, or undefined when Git cannot tell.
const waitsFor = (root) => operationInProgress(root).catch(() => undefined);

/**
 * The assume-unchanged entries and unmerged paths under the checkout's artifact paths, other than those that left says stay, that the report names, as { path, reason }:
 * each whose work tree holds a file at its path, or that a ledger of the repository lists as moved, an unmerged path once whatever its stages; nothing is written for any of them.
 */
async function passedOver(seen, listing, left) {
  const entries = [...listing.assumed.map((file) => ({ path: file, reason: "assume_unchanged" })), ...listing.unmerged.map((file) => ({ path: file, reason: "unmerged" }))].filter((entry) => !left(entry.path));
  if (!entries.length) return [];
  const lacking = new Set();
  await withCheckoutFiles(seen.root, async (access) => { for (const entry of entries) if (await access.lacks(entry.path)) lacking.add(entry.path); });
  const ledger = lacking.size ? await readLedgers(seen) : null;
  return entries.filter((entry) => !lacking.has(entry.path) || ledger.movedFrom.has(entry.path)).sort(byPath);
}

/**
 * The files moved earlier among a checkout's tracked files: those that the work tree lacks and that deleted, the paths `git ls-files --deleted` lists, holds,
 * that a ledger of the repository lists as moved, and whose store location holds a file, other than those that named says a result of this server process names as moved,
 * as { earlier, lacking }, where earlier lists { from, to } and lacking holds every file that the work tree lacks.
 * A removal that a cancel or a host close kept out of every result is named this way by a later process, for as long as `git ls-files --deleted` lists the file; nothing is written or removed for it.
 */
async function movedEarlier(seen, files, deleted, named) {
  const lacking = new Set();
  await withCheckoutFiles(seen.root, async (access) => { for (const file of files) if (await access.lacks(file)) lacking.add(file); });
  const earlier = [];
  if (!lacking.size) return { earlier, lacking };
  const ledger = await readLedgers(seen);
  for (const file of lacking) {
    if (!deleted.has(file)) continue;
    const to = ledger.movedTo.get(file);
    if (to !== undefined && !named?.has(file) && await storeHolds(seen, to)) earlier.push({ from: file, to });
  }
  return { earlier, lacking };
}

// Whether the store's location below artifacts/ holds a regular file, whatever bytes it holds.
async function storeHolds(seen, location) {
  try { return (await lstat(await resolveArtifactFile(seen, location)).catch(() => null))?.isFile() ?? false; }
  catch { return false; }
}

/** Whether what a move returned is a decided move that still removes its checkout files. */
export const unfinishedMove = (outcome) => typeof outcome?.finish === "function";

/**
 * The report of what a move returned: a decided move is finished first, which removes its checkout files; run it only right before writing the tool result that carries the report.
 * proceed() says whether that result is still to be written, and the finish stops removing files once it says no, returning { interrupted: true }, so the move can be finished again later,
 * which reports a file already removed as moved; writes maps each store file that an update_artifact of the same tool call wrote to the versions it wrote there.
 * While Git has an operation in progress in the checkout, the finish removes nothing and returns { pending }, the report that the move waits for it, and the move is finished again before a later result.
 */
export async function finishedMove(outcome, { proceed = () => true, writes = null } = {}) {
  return unfinishedMove(outcome) ? outcome.finish({ proceed, writes }) : outcome;
}

/**
 * What decides a file before the store is read: null when the move passes over it, because it is gone from the work tree, is no regular file, or does not lie inside the checkout through real folders;
 * { address, kept, details } for a file that every move keeps whatever the store holds; { address, size, roadmap: true } for a roadmap view;
 * and otherwise { address, size, bytes, text, location }, a file that the store decides.
 * The move checks these first, and the pull is skipped only for files these keep or pass over, so a file whose decision reads the store is always decided against a pull.
 */
async function decideLocally(access, kinds, own, file) {
  const address = artifactAddress(kinds, file);
  if (malformedArtifactName(address) !== null) return { address, kept: "name_invalid" };
  const read = await access.read(file, address.kind === "roadmap" ? 0 : ARTIFACT_CONTENT_MAX);
  if (read === null) return null;
  if (address.kind === "roadmap") return { address, size: read.size, roadmap: true };
  if (read.bytes === null) return { address, kept: "too_large", details: { size: read.size } };
  const { size, bytes } = read;
  const text = artifactText(bytes);
  if (text === null) return { address, kept: "not_text" };
  // A location that is too long keeps the file whatever the store holds, so the store is never read for it, and a copy there decides nothing.
  const location = artifactLocation(own, address);
  if (location.length > ARTIFACT_LOCATION_MAX) return { address, kept: "path_too_long", details: { location } };
  return { address, size, bytes, text, location };
}

// Whether the decision for any of the files reads the store, which a file that the move keeps or passes over before reading it never does.
async function anyDependsOnStore(root, kinds, repository, files) {
  const own = repositoryScope(repository);
  try {
    return await withCheckoutFiles(root, async (access) => {
      for (const file of files) {
        try {
          const local = await decideLocally(access, kinds, own, file);
          if (local !== null && !local.kept) return true;
        } catch { return true; }
      }
      return false;
    });
  } catch { return true; }
}

// Decide every file, write the store copies and status records, then the ledger, all while holding the store's artifact lock; the checkout's files are removed afterwards.
// The decided move names the real root it read the checkout's files through, so its removals happen below that root only.
function moveIntoStore(seen, files) {
  return withCheckoutFiles(seen.root, async (access) => ({ ...await decideAndWrite(seen, access, files), real: access.real }));
}

async function decideAndWrite(seen, access, files) {
  const own = repositoryScope(seen.repository);
  const ledger = await readLedgers(seen);
  const held = await seenArtifacts(seen);
  const heldAt = new Map();
  for (const entry of held) heldAt.set(entry.path, [...(heldAt.get(entry.path) ?? []), entry]);
  const moved = [], kept = [], creates = [], statuses = [];
  const keep = (file, reason, details = {}) => kept.push({ path: file, reason, ...details });
  for (const file of files) {
    const local = await decideLocally(access, seen.kinds, own, file);
    if (local === null) continue;
    if (local.kept) { keep(file, local.kept, local.details); continue; }
    const { address, size, bytes, text, location } = local;
    if (local.roadmap) { await decideRoadmapView(seen, access, file, address, size, { moved, keep }); continue; }
    const version = artifactVersion(bytes);
    const holders = heldAt.get(file) ?? [];
    // The repository's scope, or one of its component scopes, already holding the path is where the file belongs; the workspace scope holding it keeps the file apart.
    const holder = holders.find((entry) => entry.scope.kind === "repository") ?? holders.find((entry) => entry.scope.kind === "component");
    if (holder) {
      const stored = await storedArtifactIn(seen, holder.scope, address);
      if (stored.record?.version !== version) { keep(file, "differs", { location: stored.location }); continue; }
      // A store copy without its status record, as a move interrupted between the two leaves it, gets the written status before the checkout file goes.
      if (hasStatus(address.kind)) statuses.push({ scope: holder.scope, address, written: writtenStatus(text) });
      moved.push({ from: file, to: stored.location, version, size: bytes.length });
      continue;
    }
    if (holders.some((entry) => entry.scope.kind === "workspace")) { keep(file, "workspace_holds", { location: artifactLocation(WORKSPACE_SCOPE, address) }); continue; }
    if (ledger.moved.has(location)) { keep(file, "removed_in_store", { location }); continue; }
    creates.push({ file, address, scope: own, location, size: bytes.length });
  }
  // A file that the move would create in another letter case than a path a seen scope holds, or than another file it would create, stays, and so does that other file.
  const storedIndex = pathIndex(held);
  const createIndex = pathIndex(creates.map((item) => ({ kind: item.address.kind, path: item.file })));
  const writes = [];
  for (const item of creates) {
    const other = collidingPath(storedIndex, item.address.kind, item.file) ?? collidingPath(createIndex, item.address.kind, item.file);
    if (other === undefined) writes.push(item);
    else keep(item.file, "name_conflict", { other });
  }
  for (const batch of batches(writes)) {
    for (const item of await createWrites(seen, access, batch, keep, held)) moved.push({ from: item.file, to: item.location, version: item.version, size: item.size });
  }
  for (const { scope, address, written } of statuses) await recordMovedStatus(seen, scope, address, written);
  const name = await writeLedger(seen, ledger, moved, kept);
  return { moved, kept, ledger: name };
}

// The writes in batches of at most BATCH_FILES files and BATCH_BYTES bytes, by the sizes the decision read.
function* batches(writes) {
  let batch = [], bytes = 0;
  for (const item of writes) {
    if (batch.length && (batch.length >= BATCH_FILES || bytes + item.size > BATCH_BYTES)) { yield batch; batch = []; bytes = 0; }
    batch.push(item);
    bytes += item.size;
  }
  if (batch.length) yield batch;
}

/**
 * Write one batch: each file's bytes are read again, so a file that changed since the decision is checked and written as it is now.
 * The writes go in as one update; when the store refuses it, such as for a folder of another letter case that holds no artifact, each goes alone against the same listing, and a refused one stays in the checkout.
 */
async function createWrites(seen, access, batch, keep, held) {
  const items = [];
  for (const item of batch) {
    const read = await access.read(item.file, ARTIFACT_CONTENT_MAX);
    if (read === null) continue;
    if (read.bytes === null) { keep(item.file, "too_large", { size: read.size }); continue; }
    const { bytes } = read;
    const text = artifactText(bytes);
    if (text === null) { keep(item.file, "not_text"); continue; }
    items.push({ ...item, bytes, text, size: bytes.length, version: artifactVersion(bytes), ...(hasStatus(item.address.kind) ? { writtenStatus: writtenStatus(text) } : {}) });
  }
  const done = (list) => list.map(({ bytes, text, ...rest }) => rest);
  try {
    await createMovedArtifacts(seen, items, { held });
    return done(items);
  } catch (error) { if (error?.name !== "ArtifactError") throw error; }
  const created = [];
  for (const item of items) {
    try { await createMovedArtifacts(seen, [item], { held }); created.push(item); }
    catch (error) { if (error?.name !== "ArtifactError") throw error; keepRefused(item, error, keep); }
  }
  return done(created);
}

// A write the store refused keeps its file with the reason closest to the refusal: a letter-case clash, a long location, or other bytes where the file would go.
function keepRefused(item, error, keep) {
  if (error.code === "artifact_name_conflict") keep(item.file, "name_conflict", { other: error.path });
  else if (error.code === "artifact_path_too_long") keep(item.file, "path_too_long", { location: item.location });
  else if (error.code === "invalid_path" && typeof error.location === "string") keep(item.file, "name_conflict", { other: `artifacts/${error.location}` });
  else if (error.code === "artifact_name_invalid") keep(item.file, "name_invalid");
  else if (error.code === "artifact_too_large") keep(item.file, "too_large", { size: item.size });
  else keep(item.file, "differs", { location: item.location });
}

/**
 * The checkout's roadmap view is a view of the roadmap record, which the record move took into the store, so it never moves into a repository's scope:
 * with a valid stored record, the store's view is generated from it, replacing a missing or generated view and never a hand-written one,
 * and the checkout's view goes only when its bytes equal the view the store then holds.
 */
async function decideRoadmapView(seen, access, file, address, size, { moved, keep }) {
  const recordName = path.posix.basename(roadmapPaths(seen.config).record);
  const record = await fileBytes(seen.store.base, "roadmap.json", 64 * 1024 * 1024).catch(() => null);
  const view = roadmapViewOf(record, recordName);
  if (view === null) { keep(file, "no_roadmap_record"); return; }
  const current = await storedArtifactIn(seen, WORKSPACE_SCOPE, address);
  let held = current.record?.bytes ?? null;
  const generated = held === null || held.toString("utf8").includes(generatedNotice(recordName));
  if (generated && (held === null || !held.equals(Buffer.from(view, "utf8")))) {
    await writeMovedView(seen, file, address, WORKSPACE_SCOPE, view, current.record?.version ?? null);
    held = Buffer.from(view, "utf8");
  }
  const read = held !== null && size === held.length ? await access.read(file, held.length) : null;
  const bytes = read?.bytes ?? null;
  if (bytes !== null && bytes.equals(held)) moved.push({ from: file, to: current.location, version: artifactVersion(bytes), size: bytes.length });
  else keep(file, "view_differs", { location: current.location });
}

// A move's ledger names the repository, each move, and each kept file, written before any checkout file is removed; a move that kept only files that an earlier ledger already kept for the same reason writes none.
// A ledger whose entries would take more than the bound of a ledger file is written as several files, each of at most that bound, which together list every move and kept file.
async function writeLedger(seen, ledger, moved, kept) {
  if (!moved.length && kept.every((entry) => ledger.kept.has(`${entry.path}\0${entry.reason}`))) return null;
  const at = new Date().toISOString();
  const text = (part) => `${JSON.stringify({ schemaVersion: LEDGER_SCHEMA, repository: seen.repository, migratedAt: at, moved: part.moved, kept: part.kept }, null, 2)}\n`;
  const parts = ledgerParts({ moved: moved.map(({ from, to }) => ({ from, to })), kept: [...kept].sort(byPath) }, text);
  const names = [];
  for (const part of parts) {
    const name = `${at.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.json`;
    const target = await resolveLedgerFile(seen, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeAtomically(target, part.text);
    names.push(name);
  }
  if (seen.store.sync) scheduleRecordSync(seen.store.base);
  return names.sort();
}

// The entries of a ledger split into parts whose text, as text writes it, holds at most a ledger file's bound: [{ moved, kept, text }], one part when they fit, never an empty part beside another.
function ledgerParts(entries, text) {
  const whole = text(entries);
  if (Buffer.byteLength(whole) <= STORE_FILE_BOUNDS.ledger) return [{ ...entries, text: whole }];
  const items = [...entries.moved.map((item) => ["moved", item]), ...entries.kept.map((item) => ["kept", item])];
  // An entry no ledger file can hold alone would never fit, which the name and path bounds of the files a move takes rule out.
  if (items.length < 2) throw new Error("A ledger entry exceeds the bound of a ledger file.");
  const half = Math.ceil(items.length / 2);
  const part = (list) => ({ moved: list.filter(([kind]) => kind === "moved").map(([, item]) => item), kept: list.filter(([kind]) => kind === "kept").map(([, item]) => item) });
  return [...ledgerParts(part(items.slice(0, half)), text), ...ledgerParts(part(items.slice(half)), text)];
}

/**
 * Finish a move whose store copies, status records, and ledger are written, right before a tool result that reports it is written: a moved checkout file goes only when the move's ledger names its move
 * and its store location still holds the bytes the store took, or bytes that an update_artifact of the finishing tool call wrote there, and only while the checkout file still holds the bytes the store took
 * and lies inside the checkout through real folders; a file that changed meanwhile keeps its new bytes in the checkout, beside the store's copy of the earlier ones.
 * A moved file that the work tree no longer holds, such as one that an interrupted finish removed, is reported as moved whenever its store location holds a file, whatever bytes it holds.
 * The references are found before the first removal, so the result follows the removals as closely as it can; each removed file and each file moved earlier is added to named.
 * A move whose tool call was refused or cancelled, or that a retry ran in the background, is finished by a later tool call whose result reports it, so a process that ends first leaves every file in the checkout for a later move.
 * A moved file goes, or is reported as moved or moved earlier, only while its index entry is still an ordinary merged one: an assume-unchanged entry or an unmerged path stays and is reported with its reason,
 * a skip-worktree entry stays unreported, and a file that Git no longer tracks stays as untracked; while Git has an operation in progress, nothing is removed and the finish returns { pending }.
 */
async function finishMove(seen, listing, decided, report, { proceed = () => true, writes = null, named = null } = {}) {
  const passed = [...(decided.passed ?? [])], untracked = [...listing.untracked];
  const waiting = await waitsFor(seen.root);
  if (waiting) {
    const { repository, store } = report(listing, {});
    return { pending: { repository, store, operation: waiting, finishing: true } };
  }
  const ledgered = decided.moved.length ? await ledgerMoves(seen, decided.ledger) : null;
  const checked = [], stayed = [];
  let retry = false;
  const roadmapLocation = artifactLocation(WORKSPACE_SCOPE, { kind: "roadmap", rest: null });
  const stay = (move, reason) => stayed.push({ path: move.from, reason: move.to === roadmapLocation ? "view_differs" : reason, location: move.to });
  // The store copies are read in one pass, which checks each folder above them once.
  const reading = { ...seen, folderChecks: folderChecks() };
  for (const move of decided.moved) {
    // A move that no ledger confirms is decided again by a later move, so its file stays in the checkout without a report.
    if (!ledgered?.has(`${move.from}\0${move.to}`)) { retry = true; continue; }
    const stored = await storedVersion(reading, move.to, move.size, writes).catch(() => "other");
    checked.push({ move, stored, confirmed: stored === move.version || Boolean(stored?.updated) });
  }
  const stayFor = ({ move, stored }) => stay(move, stored === null ? "removed_in_store" : "differs");
  const unique = (entries) => [...new Map(entries.map((entry) => [entry.path, entry])).values()].sort(byPath);
  const done = (outcome) => report(listing, { untracked: [...new Set(untracked)].sort(), ...outcome, passed: unique(passed) });
  // Git's index as it is now decides which moved files may still go; a checkout whose index Git cannot read, or whose operation Git cannot tell, keeps every file for a later move.
  const states = waiting === null ? await indexStates(seen.root, artifactPathspecs(seen.kinds)).catch(() => null) : null;
  // A checkout whose root resolves elsewhere than where the decision read its files keeps every file, which a later move decides again against the store.
  if (states === null || await realpath(seen.root).catch(() => null) !== decided.real) {
    for (const entry of checked) if (!entry.confirmed) stayFor(entry);
    return done({ kept: [...decided.kept, ...stayed].sort(byPath), ledger: decided.ledger, retry: true });
  }
  return withCheckoutFiles(seen.root, async (access) => {
    // A moved file whose entry stopped being one that the move takes stays as its entry's state says, and so is never removed, reported as moved, or reported as differing.
    const taken = async (file) => {
      const state = states.get(file);
      if (state === "ordinary") return true;
      if (state === "assume_unchanged" || state === "unmerged") passed.push({ path: file, reason: state });
      else if (state === undefined && !await access.lacks(file)) untracked.push(file);
      return state === undefined && await access.lacks(file);
    };
    const removing = [];
    for (const entry of checked) {
      if (!await taken(entry.move.from)) continue;
      if (entry.confirmed || (entry.stored !== null && await access.lacks(entry.move.from) && await storeHolds(seen, entry.move.to))) removing.push(entry.move);
      else stayFor(entry);
    }
    // A file moved earlier is reported only while its entry is still an ordinary one whose removal Git's ordinary staging takes.
    const earlier = [];
    for (const item of decided.earlier ?? []) {
      const state = states.get(item.from);
      if (state === "ordinary") earlier.push(item);
      else if (state === "assume_unchanged" || state === "unmerged") passed.push({ path: item.from, reason: state });
    }
    const formerPaths = (moves) => [...moves.map((move) => move.from), ...earlier.map((item) => item.from)];
    const leaving = new Set(removing.map((move) => move.from));
    let found = await referencesOf(access, seen.kinds, listing.tracked.filter((file) => !leaving.has(file)), formerPaths(removing));
    const left = [];
    for (const move of removing) {
      // A result that will not be written, such as one that the host cancelled meanwhile, removes nothing more, and the move is finished again before a later result.
      if (!proceed()) return { interrupted: true };
      // A file already gone left the checkout, and the store holds it.
      if (await access.remove(move.from, move) === "changed") stay(move, "differs");
      else { left.push(move); named?.add(move.from); }
    }
    const removed = left.map((move) => move.from);
    // A file that changed during the finish stays in the checkout, so the references are found again for the files that left.
    if (left.length !== removing.length) {
      const gone = new Set(removed);
      found = await referencesOf(access, seen.kinds, listing.tracked.filter((file) => !gone.has(file)), formerPaths(left));
    }
    await pruneCheckoutFolders(access, seen.kinds, removed);
    for (const item of earlier) named?.add(item.from);
    return done({ moved: left.map(({ from, to }) => ({ from, to })), earlier: earlier.map(({ from, to }) => ({ from, to })), kept: [...decided.kept, ...stayed].sort(byPath), references: found.references, moreReferences: found.moreReferences, ledger: decided.ledger, ...(retry ? { retry } : {}) });
  }, decided.real);
}

// The moves that the ledger files of a move of the repository name together, as from and to joined by a null character, or null when one of them cannot be read.
async function ledgerMoves(seen, names) {
  if (!names?.length) return null;
  const moves = new Set();
  try {
    for (const name of names) {
      const file = await resolveLedgerFile(seen, name);
      const entry = parseStoreJson((await fileBytes(path.dirname(file), path.basename(file), STORE_FILE_BOUNDS.ledger))?.toString("utf8") ?? "null");
      if (entry?.repository !== seen.repository || !Array.isArray(entry.moved)) return null;
      for (const move of entry.moved) if (typeof move?.from === "string" && typeof move.to === "string") moves.add(`${move.from}\0${move.to}`);
    }
  } catch { return null; }
  return moves;
}

/**
 * The version of the store's copy at a location below artifacts/: null when no file is there, and "other" for a file of another size, so no read takes more than the moved file's size,
 * or { updated: true } when it holds a version that writes, the update_artifact writes of the finishing tool call, put there, read up to the artifact limit.
 */
async function storedVersion(seen, location, size, writes = null) {
  const file = await resolveArtifactFile(seen, location);
  const info = await lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (info === null) return null;
  const updates = writes?.get(file);
  if (updates?.size && info.isFile() && info.size <= ARTIFACT_CONTENT_MAX) {
    const bytes = await fileBytes(path.dirname(file), path.basename(file), ARTIFACT_CONTENT_MAX);
    const version = bytes === null ? null : artifactVersion(bytes);
    if (version !== null && updates.has(version)) return { updated: true };
    if (version !== null && bytes.length === size) return version;
    return "other";
  }
  const bytes = info.isFile() && info.size === size ? await fileBytes(path.dirname(file), path.basename(file), size) : null;
  return bytes === null ? "other" : artifactVersion(bytes);
}

// A folder that the move emptied goes, up to the configured folder, which stays; each folder is tried once, after every folder below it.
async function pruneCheckoutFolders(access, kinds, removed) {
  const tops = new Set(kinds.kinds.filter((entry) => entry.folder).map((entry) => entry.path));
  const prunable = (folder) => folder !== "." && folder !== "" && !tops.has(folder);
  const depth = (folder) => folder.split("/").length;
  const pending = new Set(removed.map((file) => path.posix.dirname(file)).filter(prunable));
  while (pending.size) {
    const deepest = [...pending].reduce((most, folder) => Math.max(most, depth(folder)), 0);
    for (const folder of [...pending].filter((entry) => depth(entry) === deepest)) {
      pending.delete(folder);
      const parent = path.posix.dirname(folder);
      if (await access.removeFolder(folder) && prunable(parent)) pending.add(parent);
    }
  }
}

/**
 * Each tracked file left in the checkout whose text names the former path of a moved file or a file moved earlier, or the configured folder of a kind that lost either, as { file, lines, more },
 * with at most REFERENCE_LINES_MAX line numbers and the number of its other matching lines, at most REFERENCE_FILES_MAX files, with the count of the rest.
 */
async function referencesOf(access, kinds, tracked, movedFiles) {
  const none = { references: [], moreReferences: 0 };
  if (!movedFiles.length) return none;
  const folders = kinds.kinds.filter((entry) => entry.folder && entry.path !== "" && movedFiles.some((file) => artifactAddress(kinds, file)?.kind === entry.kind)).map((entry) => entry.path);
  // A line that names a moved file below a folder that lost files names that folder too, so the folders and the moved files outside them find every such line.
  const needles = [...new Set([...folders, ...movedFiles.filter((file) => !folders.some((folder) => file.startsWith(`${folder}/`)))])];
  const found = [];
  let more = 0;
  for (const file of tracked) {
    const bytes = (await access.read(file, REFERENCE_BYTES_MAX).catch(() => null))?.bytes ?? null;
    if (bytes === null || bytes.includes(0)) continue;
    const lines = [];
    let matching = 0;
    bytes.toString("utf8").split("\n").forEach((line, index) => {
      if (!needles.some((needle) => line.includes(needle))) return;
      matching += 1;
      if (lines.length < REFERENCE_LINES_MAX) lines.push(index + 1);
    });
    if (!matching) continue;
    if (found.length < REFERENCE_FILES_MAX) found.push({ file, lines, more: matching - lines.length });
    else more += 1;
  }
  return { references: found, moreReferences: more };
}

// A character that would end or begin a line, or that a terminal reads as a control, in a path the report prints.
const UNSAFE_IN_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ESCAPED_AFTER_JSON = /[\u007f-\u009f\u2028\u2029]/gu;

/** A path as the move's report prints it: as it is, or, when it holds a control character or a line separator, as a JSON string with every such character escaped, so no file name begins or ends a line. */
export function shownPath(value) {
  const text = String(value);
  if (!UNSAFE_IN_LINE.test(text)) return text;
  return JSON.stringify(text).replace(ESCAPED_AFTER_JSON, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The reasons a moved checkout's file stayed, for people: each reason's explanation, given the file's kept entry. */
export function keptExplanation(entry) {
  const where = entry.location ? shownPath(`artifacts/${entry.location}`) : null;
  switch (entry.reason) {
    case "differs": return `the store already holds other bytes at ${where}; a person compares the two and brings what still matters into the store with update_artifact before removing the checkout's copy`;
    case "workspace_holds": return `the workspace scope already holds this path at ${where}; a person brings what still matters into it with update_artifact before removing the checkout's copy`;
    case "removed_in_store": return `it moved into the store at ${where} before and was removed there since, so the store does not take it back; a person decides whether to write it again with update_artifact or to remove the checkout's copy`;
    case "name_invalid": return `its path breaks the artifact name form, so the store does not take it: ${ARTIFACT_NAME_FORM}; rename it to that form, and a later first access moves it`;
    case "name_conflict": return `it differs only in letter case from ${shownPath(entry.other)}, and the two would be one file on a file system that ignores letter case; rename one of them, and a later first access moves it`;
    case "path_too_long": return `its location ${where} would hold ${entry.location.length} characters, above the ${ARTIFACT_LOCATION_MAX} that a location may hold; give it a shorter path, and a later first access moves it`;
    case "too_large": return `it holds ${entry.size} bytes, above the ${ARTIFACT_CONTENT_MAX} bytes (1 MiB) that an artifact may hold, so the store does not take it; keep it in the checkout, or make it smaller and commit it for a later first access to move`;
    case "not_text": return "it is not UTF-8 text, which the artifact tools read and write, so the store does not take it; keep it in the checkout";
    case "view_differs": return `it differs from the roadmap view at ${where} that the store generates from the roadmap record; put content that the roadmap record lacks into the record through update_roadmap before a person removes the file`;
    case "assume_unchanged": return "its index entry has Git's assume-unchanged bit, so Git neither shows nor stages a change or a removal at its path and the store does not take it; git update-index --no-assume-unchanged on its path clears the bit, after which a later session's move decides it, or reports it as moved earlier when the checkout lacks it";
    case "unmerged": return "Git's index holds it unmerged, in the stages of a conflict that a merge, rebase, git am, cherry-pick, revert, or git stash pop stopped on, so its file may hold conflict markers and the store does not take it; a person resolves the conflict and stages the result with git add, or ends the operation, after which a later session's move decides it";
    case "no_roadmap_record": return "the store holds no valid roadmap record to generate the view from; put content that a roadmap record needs into the record through update_roadmap before a person removes the file";
    default: return entry.reason;
  }
}
