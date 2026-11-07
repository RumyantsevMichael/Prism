import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

// Loaded with --import into a Prism server, this stands in for a case-insensitive file system, the default on macOS and Windows, which a Linux host rarely can mount.
// Below the folder that PRISM_TEST_CASE_INSENSITIVE names, every promise-based file call that takes a path finds each name without regard to ASCII letter case,
// while a folder listing keeps each entry's stored case, as such a file system does.
const root = process.env.PRISM_TEST_CASE_INSENSITIVE ? path.resolve(process.env.PRISM_TEST_CASE_INSENSITIVE) : null;
const readNames = fs.readdirSync;
const folded = (name) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

// The path a case-insensitive file system resolves: each name that only matches an entry in another letter case takes that entry's name.
function resolveName(target) {
  if (typeof target !== "string") return target;
  const absolute = path.resolve(target);
  if (root === null || !absolute.startsWith(`${root}${path.sep}`)) return target;
  const parts = path.relative(root, absolute).split(path.sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    let names;
    try { names = readNames(current); } catch { return path.join(current, ...parts.slice(index)); }
    const match = names.includes(part) ? part : names.find((name) => folded(name) === folded(part));
    if (match === undefined) return path.join(current, ...parts.slice(index));
    current = path.join(current, match);
  }
  return current;
}

if (root !== null) {
  const calls = fs.promises;
  for (const name of ["access", "lstat", "mkdir", "open", "readdir", "readFile", "rm", "rmdir", "stat", "unlink", "utimes", "writeFile"]) {
    const original = calls[name];
    calls[name] = (target, ...rest) => original(resolveName(target), ...rest);
  }
  const rename = calls.rename;
  calls.rename = (from, to) => rename(resolveName(from), resolveName(to));
  syncBuiltinESMExports();
  if (process.env.PRISM_TEST_CASE_INSENSITIVE_MARKER) fs.writeFileSync(process.env.PRISM_TEST_CASE_INSENSITIVE_MARKER, `${process.pid}\n`);
}
