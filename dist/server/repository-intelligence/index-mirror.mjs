// Generated from src/server/repository-intelligence/index-mirror.mts by scripts/native-build/compile.mjs.
import path from "node:path";
import { createHash } from "node:crypto";
import { chmod, lstat, open, readdir, rm, rmdir } from "node:fs/promises";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { regularBytes, semanticError } from "./native-files.mjs";
const HASH = /^[a-f\d]{64}$/;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return Boolean(relative) && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};
const hashes = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((hash) => typeof hash === "string" && HASH.test(hash));
const manifestFile = (directory) => path.join(directory, "mirror.json");
const removeFile = async (target) => {
  await chmod(target, 384).catch(() => {
  });
  await rm(target, { force: true });
};
const writeManifest = (directory, manifest) => writeAtomically(manifestFile(directory), JSON.stringify(manifest), { mode: 384 });
async function readMirrorManifest(directory) {
  try {
    const manifest = JSON.parse((await regularBytes(manifestFile(directory), 256 * 1024 * 1024)).toString("utf8"));
    if (manifest?.schemaVersion !== 1 || !hashes(manifest.mirror) || !(manifest.indexed === null || hashes(manifest.indexed))) return void 0;
    return manifest;
  } catch {
    return void 0;
  }
}
async function holds(mirror, files) {
  for (const file of files) {
    const target = path.resolve(mirror, file);
    if (!inside(mirror, target)) return false;
    const info = await lstat(target).catch(() => null);
    if (!info?.isFile()) return false;
  }
  return true;
}
async function pruneEmpty(mirror, target) {
  for (let folder = path.dirname(target); inside(mirror, folder); folder = path.dirname(folder)) {
    if ((await readdir(folder).catch(() => ["unreadable"])).length) return;
    await rmdir(folder).catch(() => {
    });
  }
}
async function updateMirror(directory, files, { privateDirectory, report = () => {
}, current = () => {
} }) {
  const mirror = path.join(directory, "mirror");
  let manifest = await readMirrorManifest(directory);
  if (!manifest || manifest.indexed === null || !await holds(mirror, Object.keys(manifest.mirror))) {
    manifest = { schemaVersion: 1, mirror: {}, indexed: null };
    await writeManifest(directory, manifest);
    await rm(mirror, { recursive: true, force: true });
    await rm(path.join(directory, "runtime-state"), { recursive: true, force: true });
  }
  await privateDirectory(mirror);
  const snapshot = new Map(files.map((file) => [file.file, file]));
  const copied = files.filter((file) => manifest.mirror[file.file] !== file.hash);
  const removed = Object.keys(manifest.mirror).filter((file) => !snapshot.has(file));
  const kept = Object.fromEntries(Object.entries(manifest.mirror).filter(([file]) => snapshot.has(file) && snapshot.get(file).hash === manifest.mirror[file]));
  if (copied.length || removed.length) await writeManifest(directory, { ...manifest, mirror: kept });
  for (const file of removed) {
    const target = path.resolve(mirror, file);
    if (!inside(mirror, target)) continue;
    await removeFile(target);
    await pruneEmpty(mirror, target);
  }
  report(0, copied.length);
  for (const [position, file] of copied.entries()) {
    current();
    const target = path.resolve(mirror, file.file);
    if (!inside(mirror, target)) throw semanticError("invalid_path", "A snapshot path escapes its mirror.");
    await privateDirectory(path.dirname(target));
    await removeFile(target);
    const handle = await open(target, "wx", 256);
    try {
      const bytes = await regularBytes(file.absolutePath, 2 * 1024 * 1024);
      if (sha(bytes) !== file.hash) throw semanticError("stale_snapshot", "Source bytes changed while copying the snapshot.");
      await handle.writeFile(bytes);
    } catch (error) {
      await handle.close().catch(() => {
      });
      await removeFile(target);
      throw error;
    }
    await handle.close();
    report(position + 1, copied.length);
  }
  const indexed = manifest.indexed;
  await writeManifest(directory, { schemaVersion: 1, mirror: Object.fromEntries(files.map((file) => [file.file, file.hash])), indexed });
  if (indexed === null) return { mirror };
  return {
    mirror,
    changedFiles: files.filter((file) => indexed[file.file] !== file.hash).map((file) => file.file).sort(),
    removedFiles: Object.keys(indexed).filter((file) => !snapshot.has(file)).sort()
  };
}
async function markIndexed(directory, files) {
  const manifest = await readMirrorManifest(directory);
  if (!manifest) return;
  await writeManifest(directory, { ...manifest, indexed: Object.fromEntries(files.map((file) => [file.file, file.hash])) });
}
async function forgetMirror(directory) {
  await rm(manifestFile(directory), { force: true });
}
export {
  forgetMirror,
  markIndexed,
  readMirrorManifest,
  updateMirror
};
