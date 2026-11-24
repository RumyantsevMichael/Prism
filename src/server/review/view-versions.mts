import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync, readdirSync, watch } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

// The folders inside a watched tree that hold no file a view reads: Git's own data, which every git command can touch, and the store's sync state.
const SKIPPED = new Set([".git", ".prism-sync"]);
// A file watcher misses changes on some file systems, such as a network drive or a Windows folder seen from WSL, and can drop events under load,
// so every version is also checked against a listing of its files while a page reads it: the targets without a working watcher at most every VERIFY_MS,
// and every target at most every WATCHED_VERIFY_MS, which bounds how long a dropped event can go unnoticed.
export const VERIFY_MS = 5000;
export const WATCHED_VERIFY_MS = 30000;
// File systems whose changes made elsewhere, as by Windows under WSL or by another machine, reach no watcher here: Linux's names, then macOS's.
const EVENTLESS_TYPES = new Set(["9p", "drvfs", "cifs", "smb3", "smbfs", "nfs", "nfs4", "fuse.sshfs", "afs", "ncpfs", "virtiofs", "afpfs", "webdav", "macfuse", "osxfuse"]);
// The mount table is read again after this long, so a drive mounted while the app runs is counted.
const MOUNTS_MS = 60000;

let mounts: { at: number; list: Promise<{ point: string; type: string }[]> } | null = null;
const readMounts = (): Promise<{ point: string; type: string }[]> => {
  if (process.platform === "linux") {
    return readFile("/proc/self/mounts", "utf8").then((text) => text.split("\n").map((line) => line.split(" ")).filter((fields) => fields.length > 2)
      .map(([, point, type]) => ({ point: point.replace(/\\040/g, " "), type })), () => []);
  }
  // macOS lists each mount as "<device> on <point> (<type>, <options>)".
  return new Promise((resolve) => execFile("mount", [], { timeout: 10000, windowsHide: true }, (error, stdout) => resolve(error ? [] : stdout.split("\n")
    .map((line) => /^.* on (.+) \(([^,)]+)/.exec(line)).filter((match): match is RegExpExecArray => match !== null).map((match) => ({ point: match[1], type: match[2] })))));
};

// The type of the file system a path lies on when a watcher there would miss changes made elsewhere, from the longest matching mount point, or null.
async function eventless(target: string) {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  if (!mounts || Date.now() - mounts.at >= MOUNTS_MS) mounts = { at: Date.now(), list: readMounts() };
  let found: { point: string; type: string } | null = null;
  for (const mount of await mounts.list) {
    const inside = mount.point === "/" || target === mount.point || target.startsWith(`${mount.point}/`);
    if (inside && (!found || mount.point.length > found.point.length)) found = mount;
  }
  return found && EVENTLESS_TYPES.has(found.type) ? found.type : null;
}

/** Why a target is checked rather than watched: a Windows drive seen from WSL, a virtual machine's shared folder, a network drive, Windows itself, or a watcher that failed. */
export type UnwatchedReason = "wsl" | "virtual" | "network" | "windows" | "unwatchable";
function reasonOf(type: string | true, target: string): UnwatchedReason {
  if (type === "drvfs" || (type === "9p" && /^\/mnt\/[a-z]\//i.test(`${target}/`))) return "wsl";
  if (type === "9p" || type === "virtiofs") return "virtual";
  return "network";
}

// Prism's transient lock and write files, which a write creates and removes around the record it changes, as the store's .gitignore names them.
// No view reads them, and the record's own rename shows the change, so they never change a version: a lock that a view's build takes would otherwise start the next build.
export const transient = (name: string) => name.endsWith(".lock") || (name.startsWith(".") && name.endsWith(".tmp"));
const skipped = (relative: string) => relative.split(/[\\/]/).some((segment) => SKIPPED.has(segment)) || transient(path.basename(relative));

const gitHead = (root: string) => new Promise<string>((resolve) => {
  execFile("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], { timeout: 10000, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout.trim()));
});

// One line per file and folder below a folder: its path, kind, size, and modification time, so any added, removed, or rewritten file changes the listing.
async function listing(folder: string, lines: string[], relative = "") {
  let entries;
  try { entries = await readdir(path.join(folder, relative), { withFileTypes: true }); }
  catch (error: any) {
    lines.push(`${folder}\0${relative}\0${error.code ?? "unreadable"}`);
    return;
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (SKIPPED.has(entry.name) || (!entry.isDirectory() && transient(entry.name))) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      lines.push(`${folder}\0${child}\0d`);
      await listing(folder, lines, child);
    } else {
      const info = await lstat(path.join(folder, child)).catch(() => null);
      lines.push(`${folder}\0${child}\0${info ? `${info.size}\0${info.mtimeMs}` : "gone"}`);
    }
  }
}

// One line per folder below a folder. A folder's modification time changes when a file in it is added, removed, or renamed,
// as every write Prism and Git make is, since both write a new file and rename it into place; an edit in place leaves it unchanged.
// A folder whose time changed is read again, its own files without the transient ones, so a lock taken and released leaves its line as it was;
// details keeps each folder's time and line, so a folder whose time holds costs one look.
async function folderListing(folder: string, lines: string[], details: Map<string, { mtime: number; line: string }>, relative = "") {
  const absolute = path.join(folder, relative);
  const info = await lstat(absolute).catch(() => null);
  if (!info) { lines.push(`${folder}\0${relative}\0gone`); details.delete(absolute); return; }
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); }
  catch { lines.push(`${folder}\0${relative}\0unreadable`); return; }
  const kept = details.get(absolute);
  if (kept && kept.mtime === info.mtimeMs) lines.push(kept.line);
  else {
    const own: string[] = [];
    for (const entry of entries) {
      if (SKIPPED.has(entry.name) || entry.isDirectory() || transient(entry.name)) continue;
      const file = await lstat(path.join(absolute, entry.name)).catch(() => null);
      own.push(`${entry.name}\0${file ? `${file.size}\0${file.mtimeMs}` : "gone"}`);
    }
    const line = `${folder}\0${relative}\0${createHash("sha256").update(own.sort().join("\n")).digest("hex")}`;
    details.set(absolute, { mtime: info.mtimeMs, line });
    lines.push(line);
  }
  const folders = entries.filter((entry) => entry.isDirectory() && !SKIPPED.has(entry.name)).map((entry) => entry.name).sort();
  lines.push(`${folder}\0${relative}\0folders\0${folders.join("\0")}`);
  for (const name of folders) await folderListing(folder, lines, details, relative ? `${relative}/${name}` : name);
}

// The folders of the targets and the target files, read where no watcher runs at every version read between full listings, so a write by another process shows at once.
async function quickSignatureOf(targets: Targets, details: Map<string, { mtime: number; line: string }> = new Map()) {
  const lines: string[] = [];
  for (const folder of targets.folders) await folderListing(folder, lines, details);
  for (const file of targets.files) {
    const info = await lstat(file).catch(() => null);
    lines.push(`file\0${file}\0${info ? `${info.size}\0${info.mtimeMs}` : "gone"}`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

async function signatureOf(targets: Targets) {
  const lines: string[] = [];
  for (const folder of targets.folders) {
    lines.push(`folder\0${folder}`);
    await listing(folder, lines);
  }
  for (const file of targets.files) {
    const info = await lstat(file).catch(() => null);
    lines.push(`file\0${file}\0${info ? `${info.size}\0${info.mtimeMs}` : "gone"}`);
  }
  for (const root of targets.gitRoots) lines.push(`head\0${root}\0${await gitHead(root)}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** What a project's views read: folders read as whole trees, single files, and checkouts whose commits a view reads. */
export type Targets = { folders: string[]; files: string[]; gitRoots: string[] };

/**
 * A version per project root that changes whenever a file its views read may have changed, so a view computed once can be reused until then.
 * A file watcher on each target changes the version at once; a target that does not exist yet is watched through its nearest existing folder, so its creation shows at once too.
 * Only the targets without a working watcher are listed while versions are read: their folders at every read, and their whole trees at most every verifyMs.
 * Every target is listed at most every watchedVerifyMs, for an event a watcher dropped and for the checkouts' commits.
 * targetsOf(root) names what to watch, and is asked again at each full listing, since a configuration change can move the store.
 * Watchers never keep the process alive.
 */
// On Windows a watcher holds its folder open, so neither this process nor another, such as the review app replacing a store's clone or removing a workspace,
// could delete or rename the folder while it is watched; there the listings alone notice changes: its folders at every read, and every file at the short interval.
const defaultWatch: typeof watch = process.platform === "win32" ? (() => { throw new Error("Folders are not watched on Windows."); }) as any
  : process.platform === "linux" ? ((target: string, options: any, listener: any) => (options?.recursive ? watchFolderTree(target, listener) : watch(target, options, listener))) as any
    : watch;

// Node's recursive watcher on Linux watches each file on its own and reports a folder's events only as names it has not seen, so once a write replaced a file
// by a rename, as every write Prism and Git make does, later replacements of that file report nothing and a view shows the change only at the next full listing.
// There every folder of the tree gets its own watcher instead, which reports each name added, removed, renamed over, or written in it.
// A folder that shows later gets its watchers as its name is reported, and every name found below it is reported too, so a file written there first is counted.
// Git's data and the store's sync state, which no view reads, get no watcher.
function watchFolderTree(root: string, listener: (event: string, name: string | null) => void) {
  const tree = new EventEmitter() as EventEmitter & { close: () => void; unref: () => void; ref: () => void };
  const watchers = new Map<string, ReturnType<typeof watch>>();
  let closed = false;
  let started = false;
  const fail = (error: unknown) => {
    if (!started) throw error;
    tree.emit("error", error);
  };
  const forget = (relative: string) => {
    for (const [folder, watcher] of watchers) {
      if (folder !== relative && !folder.startsWith(`${relative}${path.sep}`)) continue;
      try { watcher.close(); } catch {}
      watchers.delete(folder);
    }
  };
  // Watches a folder of the tree and every folder below it; with report, also reports each name found, for a folder that showed after the watcher started.
  const add = (relative: string, report: boolean) => {
    if (closed || watchers.has(relative) || (relative && skipped(relative))) return;
    const folder = path.join(root, relative);
    let watcher;
    try {
      watcher = watch(folder, { persistent: false }, (event, name) => {
        if (closed) return;
        const child = name === null || name === undefined ? null : relative ? path.join(relative, String(name)) : String(name);
        listener(event, child);
        if (child !== null && event === "rename") settle(child);
      });
    } catch (error: any) {
      // A folder removed before its watcher started needs none; any other refusal, such as the system's watch limit, leaves the tree to the listings.
      if (relative && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return;
      fail(error);
      return;
    }
    watcher.on("error", (error) => {
      if (relative) forget(relative);
      else tree.emit("error", error);
    });
    watchers.set(relative, watcher);
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (report && !skipped(child)) listener("rename", child);
      if (entry.isDirectory()) add(child, report);
    }
  };
  // A name that a folder's watcher reported added, removed, or renamed: a folder there gets watchers, and a name gone takes its folders' watchers away.
  const settle = (relative: string) => {
    let info;
    try { info = lstatSync(path.join(root, relative)); }
    catch {
      forget(relative);
      return;
    }
    if (info.isDirectory()) add(relative, true);
    else forget(relative);
  };
  tree.close = () => {
    closed = true;
    for (const watcher of watchers.values()) { try { watcher.close(); } catch {} }
    watchers.clear();
  };
  try { add("", false); }
  catch (error) {
    tree.close();
    throw error;
  }
  started = true;
  tree.unref = () => {};
  tree.ref = () => {};
  return tree;
}

// The nearest folder above a missing target that exists, and the name in it that leads to the target, or null when none can be found.
async function nearestExisting(target: string) {
  let child = target;
  for (let parent = path.dirname(target); parent !== child; child = parent, parent = path.dirname(parent)) {
    const info = await lstat(parent).catch(() => null);
    if (info?.isDirectory()) return { folder: parent, name: path.basename(child) };
    if (info) return null;
  }
  return null;
}

const none = (): Targets => ({ folders: [], files: [], gitRoots: [] });

export function createViewVersions({ targetsOf, verifyMs = VERIFY_MS, watchedVerifyMs = WATCHED_VERIFY_MS, now = () => Date.now(), watchTree = defaultWatch, isEventless = eventless }: { targetsOf: (root: string) => Promise<Targets>; verifyMs?: number; watchedVerifyMs?: number; now?: () => number; watchTree?: typeof watch; isEventless?: (target: string) => Promise<string | boolean | null> }) {
  const roots = new Map<string, any>();

  function stopWatchers(state: any) {
    for (const watcher of state.watchers) {
      try { watcher.close(); } catch {}
    }
    state.watchers = [];
  }

  // The targets that no working watcher covers, which the listings between full ones read.
  const unwatchedOf = (state: any): Targets => ({ folders: state.targets.folders.filter((folder: string) => !state.watched.has(folder)), files: state.targets.files.filter((file: string) => !state.watched.has(file)), gitRoots: [] });
  const anyUnwatched = (state: any) => state.targets && (unwatchedOf(state).folders.length > 0 || unwatchedOf(state).files.length > 0);

  async function startWatchers(state: any, targets: Targets) {
    stopWatchers(state);
    state.watched = new Set<string>();
    state.reasons = new Map<string, UnwatchedReason>();
    const unwatchable = (target: string) => state.reasons.set(target, process.platform === "win32" ? "windows" : "unwatchable");
    // A watched change makes the next listings the new baseline, so the change is counted once.
    const changed = () => { state.version += 1; state.signature = null; state.partialSignature = null; state.quickSignature = null; };
    const open = (target: string, watchedPath: string, recursive: boolean, relevant: (name: string) => boolean, onEvent = changed) => {
      const watcher = watchTree(watchedPath, { recursive, persistent: false }, (_event, name) => {
        if (name === null || name === undefined || relevant(String(name))) onEvent();
      });
      // A watcher that fails, as one on a folder that was removed does, leaves the listing checks to notice changes.
      watcher.on("error", () => {
        try { watcher.close(); } catch {}
        state.watchers = state.watchers.filter((item: any) => item !== watcher);
        state.watched.delete(target);
        state.reasons.set(target, "unwatchable");
        changed();
      });
      watcher.unref?.();
      state.watchers.push(watcher);
    };
    const add = async (target: string, recursive: boolean, relevant: (name: string) => boolean) => {
      // A target on a file system that delivers no events for changes made elsewhere keeps a watcher for this computer's own changes, but counts as unwatched.
      const type = await isEventless(target).catch(() => true);
      if (type) {
        state.reasons.set(target, reasonOf(type, target));
        try { open(target, target, recursive, relevant); } catch {}
        return;
      }
      try {
        open(target, target, recursive, relevant);
        state.watched.add(target);
        return;
      } catch {}
      unwatchable(target);
      // A target that does not exist yet is watched through the nearest folder that does; its creation restarts the watchers at the next read, so the new target gets its own.
      if (await lstat(target).then(() => true, () => false)) return;
      const above = await nearestExisting(target);
      if (!above) return;
      try {
        open(target, above.folder, false, (name) => name === above.name, () => { changed(); state.targetsKey = null; state.checkedAt = -Infinity; });
        state.watched.add(target);
        state.reasons.delete(target);
      } catch {
        // A target that cannot be watched is covered by the listing checks alone.
      }
    };
    for (const folder of targets.folders) await add(folder, true, (name) => !skipped(name));
    for (const file of targets.files) await add(file, false, () => true);
  }

  async function check(state: any) {
    let targets: Targets;
    try { targets = await state.targetsOf(); }
    catch {
      // A root whose targets cannot be named, as one with an unavailable store, gets a new version at every read, so nothing of it is reused.
      state.targetsKey = null;
      state.targets = null;
      state.signature = null;
      stopWatchers(state);
      state.version += 1;
      state.checkedAt = -Infinity;
      return;
    }
    const key = JSON.stringify(targets);
    if (key !== state.targetsKey) {
      state.targetsKey = key;
      await startWatchers(state, targets);
      state.version += 1;
      state.signature = null;
    }
    const signature = await signatureOf(targets);
    if (state.signature !== null && signature !== state.signature) state.version += 1;
    state.signature = signature;
    state.targets = targets;
    const unwatched = anyUnwatched(state) ? unwatchedOf(state) : none();
    state.partialSignature = await signatureOf(unwatched);
    state.quickSignature = await quickSignatureOf(unwatched, state.folderDetails);
    state.checkedAt = now();
    state.partialAt = state.checkedAt;
  }

  // Between full listings, the targets without a working watcher are listed in full at most every verifyMs, and their folders at every other read,
  // which costs one look per folder rather than one per file.
  async function partialCheck(state: any) {
    const unwatched = unwatchedOf(state);
    if (now() - state.partialAt >= verifyMs) {
      const signature = await signatureOf(unwatched);
      if (state.partialSignature !== null && signature !== state.partialSignature) state.version += 1;
      state.partialSignature = signature;
      state.quickSignature = await quickSignatureOf(unwatched, state.folderDetails);
      state.partialAt = now();
      return;
    }
    const signature = await quickSignatureOf(unwatched, state.folderDetails);
    if (state.quickSignature !== null && signature !== state.quickSignature) state.version += 1;
    state.quickSignature = signature;
  }

  /** The current version of a root's views, checked against listings of its targets as described above. */
  async function current(root: string) {
    let state = roots.get(root);
    if (!state) {
      state = { version: 0, watchers: [], watched: new Set(), reasons: new Map(), folderDetails: new Map(), targetsKey: null, targets: null, signature: null, partialSignature: null, quickSignature: null, checkedAt: -Infinity, partialAt: -Infinity, checking: null, targetsOf: () => targetsOf(root) };
      roots.set(root, state);
    }
    if (now() - state.checkedAt >= watchedVerifyMs || !state.targets) {
      state.checking ??= check(state).finally(() => { state.checking = null; });
      await state.checking;
    } else if (anyUnwatched(state)) {
      state.checking ??= partialCheck(state).finally(() => { state.checking = null; });
      await state.checking;
    }
    return state.version;
  }

  /**
   * Which of a root's targets no watcher covers and why, as of its last check: an empty list when every target is watched.
   * A target that does not exist and is watched through a folder above it counts as watched.
   */
  async function watching(root: string) {
    await current(root);
    const state = roots.get(root);
    if (!state?.targets) return null;
    const unwatched = unwatchedOf(state);
    return { unwatched: [...unwatched.folders, ...unwatched.files].map((target) => ({ path: target, reason: (state.reasons.get(target) ?? "unwatchable") as UnwatchedReason })), targets: state.targets.folders.length + state.targets.files.length };
  }

  /** Check a root against a full listing at its next read, as after a session reported that it may have changed the root's files. */
  function recheck(root: string) {
    const state = roots.get(root);
    if (state) state.checkedAt = -Infinity;
  }

  /** Change every root's version, for a write this process made, which its next read must see at once. */
  function bump() {
    for (const state of roots.values()) state.version += 1;
  }

  function close() {
    for (const state of roots.values()) stopWatchers(state);
    roots.clear();
  }

  return { current, watching, recheck, bump, close };
}
