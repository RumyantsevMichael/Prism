// Generated from src/server/review/view-versions.mts by scripts/native-build/compile.mjs.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync, readdirSync, watch } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
const SKIPPED = /* @__PURE__ */ new Set([".git", ".prism-sync"]);
const VERIFY_MS = 5e3;
const WATCHED_VERIFY_MS = 3e4;
const EVENTLESS_TYPES = /* @__PURE__ */ new Set(["9p", "drvfs", "cifs", "smb3", "smbfs", "nfs", "nfs4", "fuse.sshfs", "afs", "ncpfs", "virtiofs", "afpfs", "webdav", "macfuse", "osxfuse"]);
const MOUNTS_MS = 6e4;
let mounts = null;
const readMounts = () => {
  if (process.platform === "linux") {
    return readFile("/proc/self/mounts", "utf8").then((text) => text.split("\n").map((line) => line.split(" ")).filter((fields) => fields.length > 2).map(([, point, type]) => ({ point: point.replace(/\\040/g, " "), type })), () => []);
  }
  return new Promise((resolve) => execFile("mount", [], { timeout: 1e4, windowsHide: true }, (error, stdout) => resolve(error ? [] : stdout.split("\n").map((line) => /^.* on (.+) \(([^,)]+)/.exec(line)).filter((match) => match !== null).map((match) => ({ point: match[1], type: match[2] })))));
};
async function eventless(target) {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  if (!mounts || Date.now() - mounts.at >= MOUNTS_MS) mounts = { at: Date.now(), list: readMounts() };
  let found = null;
  for (const mount of await mounts.list) {
    const inside = mount.point === "/" || target === mount.point || target.startsWith(`${mount.point}/`);
    if (inside && (!found || mount.point.length > found.point.length)) found = mount;
  }
  return found && EVENTLESS_TYPES.has(found.type) ? found.type : null;
}
function reasonOf(type, target) {
  if (type === "drvfs" || type === "9p" && /^\/mnt\/[a-z]\//i.test(`${target}/`)) return "wsl";
  if (type === "9p" || type === "virtiofs") return "virtual";
  return "network";
}
const transient = (name) => name.endsWith(".lock") || name.startsWith(".") && name.endsWith(".tmp");
const skipped = (relative) => relative.split(/[\\/]/).some((segment) => SKIPPED.has(segment)) || transient(path.basename(relative));
const gitHead = (root) => new Promise((resolve) => {
  execFile("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], { timeout: 1e4, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout.trim()));
});
async function listing(folder, lines, relative = "") {
  let entries;
  try {
    entries = await readdir(path.join(folder, relative), { withFileTypes: true });
  } catch (error) {
    lines.push(`${folder}\0${relative}\0${error.code ?? "unreadable"}`);
    return;
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (SKIPPED.has(entry.name) || !entry.isDirectory() && transient(entry.name)) continue;
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
async function folderListing(folder, lines, details, relative = "") {
  const absolute = path.join(folder, relative);
  const info = await lstat(absolute).catch(() => null);
  if (!info) {
    lines.push(`${folder}\0${relative}\0gone`);
    details.delete(absolute);
    return;
  }
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    lines.push(`${folder}\0${relative}\0unreadable`);
    return;
  }
  const kept = details.get(absolute);
  if (kept && kept.mtime === info.mtimeMs) lines.push(kept.line);
  else {
    const own = [];
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
async function quickSignatureOf(targets, details = /* @__PURE__ */ new Map()) {
  const lines = [];
  for (const folder of targets.folders) await folderListing(folder, lines, details);
  for (const file of targets.files) {
    const info = await lstat(file).catch(() => null);
    lines.push(`file\0${file}\0${info ? `${info.size}\0${info.mtimeMs}` : "gone"}`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
async function signatureOf(targets) {
  const lines = [];
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
const defaultWatch = process.platform === "win32" ? (() => {
  throw new Error("Folders are not watched on Windows.");
}) : process.platform === "linux" ? ((target, options, listener) => options?.recursive ? watchFolderTree(target, listener) : watch(target, options, listener)) : watch;
function watchFolderTree(root, listener) {
  const tree = new EventEmitter();
  const watchers = /* @__PURE__ */ new Map();
  let closed = false;
  let started = false;
  const fail = (error) => {
    if (!started) throw error;
    tree.emit("error", error);
  };
  const forget = (relative) => {
    for (const [folder, watcher] of watchers) {
      if (folder !== relative && !folder.startsWith(`${relative}${path.sep}`)) continue;
      try {
        watcher.close();
      } catch {
      }
      watchers.delete(folder);
    }
  };
  const add = (relative, report) => {
    if (closed || watchers.has(relative) || relative && skipped(relative)) return;
    const folder = path.join(root, relative);
    let watcher;
    try {
      watcher = watch(folder, { persistent: false }, (event, name) => {
        if (closed) return;
        const child = name === null || name === void 0 ? null : relative ? path.join(relative, String(name)) : String(name);
        listener(event, child);
        if (child !== null && event === "rename") settle(child);
      });
    } catch (error) {
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
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (report && !skipped(child)) listener("rename", child);
      if (entry.isDirectory()) add(child, report);
    }
  };
  const settle = (relative) => {
    let info;
    try {
      info = lstatSync(path.join(root, relative));
    } catch {
      forget(relative);
      return;
    }
    if (info.isDirectory()) add(relative, true);
    else forget(relative);
  };
  tree.close = () => {
    closed = true;
    for (const watcher of watchers.values()) {
      try {
        watcher.close();
      } catch {
      }
    }
    watchers.clear();
  };
  try {
    add("", false);
  } catch (error) {
    tree.close();
    throw error;
  }
  started = true;
  tree.unref = () => {
  };
  tree.ref = () => {
  };
  return tree;
}
async function nearestExisting(target) {
  let child = target;
  for (let parent = path.dirname(target); parent !== child; child = parent, parent = path.dirname(parent)) {
    const info = await lstat(parent).catch(() => null);
    if (info?.isDirectory()) return { folder: parent, name: path.basename(child) };
    if (info) return null;
  }
  return null;
}
const none = () => ({ folders: [], files: [], gitRoots: [] });
function createViewVersions({ targetsOf, verifyMs = VERIFY_MS, watchedVerifyMs = WATCHED_VERIFY_MS, now = () => Date.now(), watchTree = defaultWatch, isEventless = eventless }) {
  const roots = /* @__PURE__ */ new Map();
  function stopWatchers(state) {
    for (const watcher of state.watchers) {
      try {
        watcher.close();
      } catch {
      }
    }
    state.watchers = [];
  }
  const unwatchedOf = (state) => ({ folders: state.targets.folders.filter((folder) => !state.watched.has(folder)), files: state.targets.files.filter((file) => !state.watched.has(file)), gitRoots: [] });
  const anyUnwatched = (state) => state.targets && (unwatchedOf(state).folders.length > 0 || unwatchedOf(state).files.length > 0);
  async function startWatchers(state, targets) {
    stopWatchers(state);
    state.watched = /* @__PURE__ */ new Set();
    state.reasons = /* @__PURE__ */ new Map();
    const unwatchable = (target) => state.reasons.set(target, process.platform === "win32" ? "windows" : "unwatchable");
    const changed = () => {
      state.version += 1;
      state.signature = null;
      state.partialSignature = null;
      state.quickSignature = null;
    };
    const open = (target, watchedPath, recursive, relevant, onEvent = changed) => {
      const watcher = watchTree(watchedPath, { recursive, persistent: false }, (_event, name) => {
        if (name === null || name === void 0 || relevant(String(name))) onEvent();
      });
      watcher.on("error", () => {
        try {
          watcher.close();
        } catch {
        }
        state.watchers = state.watchers.filter((item) => item !== watcher);
        state.watched.delete(target);
        state.reasons.set(target, "unwatchable");
        changed();
      });
      watcher.unref?.();
      state.watchers.push(watcher);
    };
    const add = async (target, recursive, relevant) => {
      const type = await isEventless(target).catch(() => true);
      if (type) {
        state.reasons.set(target, reasonOf(type, target));
        try {
          open(target, target, recursive, relevant);
        } catch {
        }
        return;
      }
      try {
        open(target, target, recursive, relevant);
        state.watched.add(target);
        return;
      } catch {
      }
      unwatchable(target);
      if (await lstat(target).then(() => true, () => false)) return;
      const above = await nearestExisting(target);
      if (!above) return;
      try {
        open(target, above.folder, false, (name) => name === above.name, () => {
          changed();
          state.targetsKey = null;
          state.checkedAt = -Infinity;
        });
        state.watched.add(target);
        state.reasons.delete(target);
      } catch {
      }
    };
    for (const folder of targets.folders) await add(folder, true, (name) => !skipped(name));
    for (const file of targets.files) await add(file, false, () => true);
  }
  async function check(state) {
    let targets;
    try {
      targets = await state.targetsOf();
    } catch {
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
  async function partialCheck(state) {
    const unwatched = unwatchedOf(state);
    if (now() - state.partialAt >= verifyMs) {
      const signature2 = await signatureOf(unwatched);
      if (state.partialSignature !== null && signature2 !== state.partialSignature) state.version += 1;
      state.partialSignature = signature2;
      state.quickSignature = await quickSignatureOf(unwatched, state.folderDetails);
      state.partialAt = now();
      return;
    }
    const signature = await quickSignatureOf(unwatched, state.folderDetails);
    if (state.quickSignature !== null && signature !== state.quickSignature) state.version += 1;
    state.quickSignature = signature;
  }
  async function current(root) {
    let state = roots.get(root);
    if (!state) {
      state = { version: 0, watchers: [], watched: /* @__PURE__ */ new Set(), reasons: /* @__PURE__ */ new Map(), folderDetails: /* @__PURE__ */ new Map(), targetsKey: null, targets: null, signature: null, partialSignature: null, quickSignature: null, checkedAt: -Infinity, partialAt: -Infinity, checking: null, targetsOf: () => targetsOf(root) };
      roots.set(root, state);
    }
    if (now() - state.checkedAt >= watchedVerifyMs || !state.targets) {
      state.checking ??= check(state).finally(() => {
        state.checking = null;
      });
      await state.checking;
    } else if (anyUnwatched(state)) {
      state.checking ??= partialCheck(state).finally(() => {
        state.checking = null;
      });
      await state.checking;
    }
    return state.version;
  }
  async function watching(root) {
    await current(root);
    const state = roots.get(root);
    if (!state?.targets) return null;
    const unwatched = unwatchedOf(state);
    return { unwatched: [...unwatched.folders, ...unwatched.files].map((target) => ({ path: target, reason: state.reasons.get(target) ?? "unwatchable" })), targets: state.targets.folders.length + state.targets.files.length };
  }
  function recheck(root) {
    const state = roots.get(root);
    if (state) state.checkedAt = -Infinity;
  }
  function bump() {
    for (const state of roots.values()) state.version += 1;
  }
  function close() {
    for (const state of roots.values()) stopWatchers(state);
    roots.clear();
  }
  return { current, watching, recheck, bump, close };
}
export {
  VERIFY_MS,
  WATCHED_VERIFY_MS,
  createViewVersions,
  transient
};
