import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

// The folders inside a watched tree that hold no file a view reads: Git's own data, which every git command can touch, and the store's sync state.
const SKIPPED = new Set([".git", ".prism-sync"]);
// A file watcher misses changes on some file systems, such as a network drive or a Windows folder seen from WSL, and can drop events under load,
// so every version is also checked against a listing of its files while a page reads it: at most every VERIFY_MS while any target has no working watcher,
// and at most every WATCHED_VERIFY_MS while every target has one, which bounds how long a dropped event can go unnoticed.
export const VERIFY_MS = 5000;
export const WATCHED_VERIFY_MS = 30000;
// Linux file systems whose changes made elsewhere, as by Windows under WSL or by another machine, reach no watcher here.
const EVENTLESS_TYPES = new Set(["9p", "drvfs", "cifs", "smb3", "smbfs", "nfs", "nfs4", "fuse.sshfs", "afs", "ncpfs", "virtiofs"]);

let mounts: Promise<{ point: string; type: string }[]> | null = null;
// Whether a path lies on a file system whose watcher would miss changes made elsewhere, from the longest matching mount point Linux lists.
async function eventless(target: string) {
  if (process.platform !== "linux") return false;
  mounts ??= readFile("/proc/self/mounts", "utf8").then((text) => text.split("\n").map((line) => line.split(" ")).filter((fields) => fields.length > 2)
    .map(([, point, type]) => ({ point: point.replace(/\\040/g, " "), type })), () => []);
  let found: { point: string; type: string } | null = null;
  for (const mount of await mounts) {
    const inside = mount.point === "/" || target === mount.point || target.startsWith(`${mount.point}/`);
    if (inside && (!found || mount.point.length > found.point.length)) found = mount;
  }
  return found ? EVENTLESS_TYPES.has(found.type) : false;
}

const skipped = (relative: string) => relative.split(/[\\/]/).some((segment) => SKIPPED.has(segment));

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
    if (SKIPPED.has(entry.name)) continue;
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
 * A recursive file watcher on each target changes the version at once; a listing of the targets, taken while versions are read at most every verifyMs
 * while a target has no working watcher and every watchedVerifyMs otherwise, changes it for anything a watcher missed. targetsOf(root) names what to watch, and is asked again at each check, since a configuration change can move the store.
 * Watchers never keep the process alive.
 */
export function createViewVersions({ targetsOf, verifyMs = VERIFY_MS, watchedVerifyMs = WATCHED_VERIFY_MS, now = () => Date.now(), watchTree = watch, isEventless = eventless }: { targetsOf: (root: string) => Promise<Targets>; verifyMs?: number; watchedVerifyMs?: number; now?: () => number; watchTree?: typeof watch; isEventless?: (target: string) => Promise<boolean> }) {
  const roots = new Map<string, any>();

  function stopWatchers(state: any) {
    for (const watcher of state.watchers) {
      try { watcher.close(); } catch {}
    }
    state.watchers = [];
  }

  async function startWatchers(state: any, targets: Targets) {
    stopWatchers(state);
    state.unwatched = false;
    // A watched change makes the next listing the new baseline, so the change is counted once.
    const changed = () => { state.version += 1; state.signature = null; };
    const add = async (target: string, recursive: boolean, relevant: (name: string) => boolean) => {
      if (await isEventless(target).catch(() => true)) state.unwatched = true;
      try {
        const watcher = watchTree(target, { recursive, persistent: false }, (_event, name) => {
          if (name === null || name === undefined || relevant(String(name))) changed();
        });
        // A watcher that fails, as one on a folder that was removed does, leaves the listing check to notice changes.
        watcher.on("error", () => {
          try { watcher.close(); } catch {}
          state.watchers = state.watchers.filter((item: any) => item !== watcher);
          state.unwatched = true;
          changed();
        });
        watcher.unref?.();
        state.watchers.push(watcher);
      } catch {
        // A target that cannot be watched, or does not exist yet, is covered by the listing check alone.
        state.unwatched = true;
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
    }
    const signature = await signatureOf(targets);
    if (state.signature !== null && signature !== state.signature) state.version += 1;
    state.signature = signature;
    state.checkedAt = now();
  }

  /** The current version of a root's views, checked against a listing of its targets when the last check is older than verifyMs. */
  async function current(root: string) {
    let state = roots.get(root);
    if (!state) {
      state = { version: 0, watchers: [], unwatched: true, targetsKey: null, signature: null, checkedAt: -Infinity, checking: null, targetsOf: () => targetsOf(root) };
      roots.set(root, state);
    }
    if (now() - state.checkedAt >= (state.unwatched ? verifyMs : watchedVerifyMs)) {
      state.checking ??= check(state).finally(() => { state.checking = null; });
      await state.checking;
    }
    return state.version;
  }

  /** Change every root's version, for a write this process made, which its next read must see at once. */
  function bump() {
    for (const state of roots.values()) state.version += 1;
  }

  function close() {
    for (const state of roots.values()) stopWatchers(state);
    roots.clear();
  }

  return { current, bump, close };
}
