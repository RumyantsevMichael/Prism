// Generated from fs-boundary.mts by scripts/native-build/compile.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const within = (root, target) => target === root || !path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== ".." && !path.isAbsolute(path.relative(root, target));
function installFileBoundary() {
  let policy = null;
  const originalRealpath = fs.realpathSync;
  const originals = [];
  const denied = [];
  function check(value, write = false) {
    if (!policy || typeof value === "number") return;
    const supplied = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
    if (typeof supplied !== "string") return;
    const target = path.resolve(supplied);
    const roots = write ? policy.writeRoots : policy.readRoots;
    let canonical = target;
    let ancestor = target;
    while (true) {
      try {
        canonical = path.resolve(originalRealpath(ancestor), path.relative(ancestor, target));
        break;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) break;
        if (path.dirname(ancestor) === ancestor) break;
        ancestor = path.dirname(ancestor);
      }
    }
    if (roots.some((root) => within(root, target) && within(root, canonical))) return;
    if (!denied.some((item) => item.path === target && item.write === write)) denied.push({ path: target, write });
    throw Object.assign(new Error("The graph SDK attempted access outside its snapshot."), { code: "ERR_ACCESS_DENIED" });
  }
  function wrap(object, name, checks) {
    const original = object[name];
    if (typeof original !== "function") return;
    const wrapped = function(...args) {
      try {
        for (const [index, mode] of checks(args)) check(args[index], mode);
      } catch (error) {
        if (name === "existsSync") return false;
        throw error;
      }
      return original.apply(this, args);
    };
    if (original.native) wrapped.native = (...args) => {
      check(args[0]);
      return original.native(...args);
    };
    object[name] = wrapped;
    originals.push(() => {
      object[name] = original;
    });
  }
  for (const object of [fs, fs.promises]) {
    for (const base of ["readFile", "readdir", "stat", "lstat", "access", "realpath", "readlink", "opendir", "exists", "createReadStream"]) {
      for (const name of [base, `${base}Sync`]) wrap(object, name, () => [[0, false]]);
    }
    for (const base of ["writeFile", "appendFile", "mkdir", "rmdir", "rm", "unlink", "chmod", "utimes", "truncate", "createWriteStream"]) {
      for (const name of [base, `${base}Sync`]) wrap(object, name, () => [[0, true]]);
    }
    for (const name of ["open", "openSync"]) wrap(object, name, (args) => [[0, typeof args[1] === "number" ? (args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0 : /[wa+]/.test(args[1] || "r")]]);
    for (const name of ["rename", "renameSync", "link", "linkSync", "symlink", "symlinkSync"]) wrap(object, name, () => [[0, true], [1, true]]);
    for (const name of ["copyFile", "copyFileSync", "cp", "cpSync"]) wrap(object, name, () => [[0, false], [1, true]]);
  }
  syncBuiltinESMExports();
  return {
    begin(next) {
      denied.length = 0;
      policy = { readRoots: next.readRoots.map((value) => path.resolve(value)), writeRoots: next.writeRoots.map((value) => path.resolve(value)) };
    },
    end() {
      policy = null;
      return denied.map((item) => ({ ...item }));
    },
    restore() {
      policy = null;
      for (const restore of originals.reverse()) restore();
      syncBuiltinESMExports();
    }
  };
}
export {
  installFileBoundary
};
