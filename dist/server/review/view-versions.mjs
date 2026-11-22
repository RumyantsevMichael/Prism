// Generated from src/server/review/view-versions.mts by scripts/native-build/compile.mjs.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
const SKIPPED = /* @__PURE__ */ new Set([".git", ".prism-sync"]);
const VERIFY_MS = 5e3;
const WATCHED_VERIFY_MS = 3e4;
const EVENTLESS_TYPES = /* @__PURE__ */ new Set(["9p", "drvfs", "cifs", "smb3", "smbfs", "nfs", "nfs4", "fuse.sshfs", "afs", "ncpfs", "virtiofs"]);
let mounts = null;
async function eventless(target) {
  if (process.platform !== "linux") return false;
  mounts ??= readFile("/proc/self/mounts", "utf8").then((text) => text.split("\n").map((line) => line.split(" ")).filter((fields) => fields.length > 2).map(([, point, type]) => ({ point: point.replace(/\\040/g, " "), type })), () => []);
  let found = null;
  for (const mount of await mounts) {
    const inside = mount.point === "/" || target === mount.point || target.startsWith(`${mount.point}/`);
    if (inside && (!found || mount.point.length > found.point.length)) found = mount;
  }
  return found ? EVENTLESS_TYPES.has(found.type) : false;
}
const skipped = (relative) => relative.split(/[\\/]/).some((segment) => SKIPPED.has(segment));
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
async function folderListing(folder, lines, relative = "") {
  const info = await lstat(path.join(folder, relative)).catch(() => null);
  lines.push(`${folder}\0${relative}\0${info ? info.mtimeMs : "gone"}`);
  let entries;
  try {
    entries = await readdir(path.join(folder, relative), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIPPED.has(entry.name)) await folderListing(folder, lines, relative ? `${relative}/${entry.name}` : entry.name);
  }
}
async function quickSignatureOf(targets) {
  const lines = [];
  for (const folder of targets.folders) await folderListing(folder, lines);
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
}) : watch;
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
  async function startWatchers(state, targets) {
    stopWatchers(state);
    state.unwatched = false;
    const changed = () => {
      state.version += 1;
      state.signature = null;
    };
    const add = async (target, recursive, relevant) => {
      if (await isEventless(target).catch(() => true)) state.unwatched = true;
      try {
        const watcher = watchTree(target, { recursive, persistent: false }, (_event, name) => {
          if (name === null || name === void 0 || relevant(String(name))) changed();
        });
        watcher.on("error", () => {
          try {
            watcher.close();
          } catch {
          }
          state.watchers = state.watchers.filter((item) => item !== watcher);
          state.unwatched = true;
          changed();
        });
        watcher.unref?.();
        state.watchers.push(watcher);
      } catch {
        state.unwatched = true;
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
    }
    const signature = await signatureOf(targets);
    if (state.signature !== null && signature !== state.signature) state.version += 1;
    state.signature = signature;
    state.targets = targets;
    state.quickSignature = state.unwatched ? await quickSignatureOf(targets) : null;
    state.checkedAt = now();
  }
  async function quickCheck(state) {
    const signature = await quickSignatureOf(state.targets);
    if (signature !== state.quickSignature) {
      state.quickSignature = signature;
      state.version += 1;
    }
  }
  async function current(root) {
    let state = roots.get(root);
    if (!state) {
      state = { version: 0, watchers: [], unwatched: true, targetsKey: null, targets: null, signature: null, quickSignature: null, checkedAt: -Infinity, checking: null, targetsOf: () => targetsOf(root) };
      roots.set(root, state);
    }
    if (now() - state.checkedAt >= (state.unwatched ? verifyMs : watchedVerifyMs)) {
      state.checking ??= check(state).finally(() => {
        state.checking = null;
      });
      await state.checking;
    } else if (state.unwatched && state.targets) {
      state.checking ??= quickCheck(state).finally(() => {
        state.checking = null;
      });
      await state.checking;
    }
    return state.version;
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
  return { current, recheck, bump, close };
}
export {
  VERIFY_MS,
  WATCHED_VERIFY_MS,
  createViewVersions
};
