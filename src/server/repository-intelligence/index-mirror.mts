import path from "node:path";
import { createHash } from "node:crypto";
import { chmod, lstat, open, readdir, rm, rmdir } from "node:fs/promises";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { regularBytes, semanticError } from "./native-files.mjs";
import type { SourceFile } from "./repository-unit-types.mjs";

// Each storage location keeps the files its builds read in `mirror`, with `mirror.json` naming them by hash, and the runtime keeps its derived state in `runtime-state`.
// `mirror` names the files the mirror holds now, and `indexed` the files of the latest build whose structure or index the runtime returned,
// so a change that a stopped build copied but never indexed is still named to the next build.
// The manifest is written before the mirror changes, without the files about to change, so a copy that stops part way never leaves a file named by a wrong hash.
// Call only while holding the storage location's lock.

export interface MirrorManifest { schemaVersion: 1; mirror: Record<string, string>; indexed: Record<string, string> | null }
// Without `changedFiles` and `removedFiles` the build is a full one, which the runtime builds without its kept state.
export interface MirrorUpdate { mirror: string; changedFiles?: string[]; removedFiles?: string[] }
interface UpdateOptions {
  // Makes a private folder, refusing a symlinked one, as the storage location's own folders are made.
  privateDirectory: (directory: string) => Promise<string>;
  report?: (current: number, total: number) => void;
  // Throws when the build may no longer go on.
  current?: () => void;
}

const HASH = /^[a-f\d]{64}$/;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return Boolean(relative) && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); };
const hashes = (value: unknown): value is Record<string, string> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.values(value as object).every(hash => typeof hash === "string" && HASH.test(hash));
const manifestFile = (directory: string) => path.join(directory, "mirror.json");
// A mirror file is read-only, which Windows refuses to delete until it is writable again.
const removeFile = async (target: string) => { await chmod(target, 0o600).catch(() => {}); await rm(target, { force: true }); };
const writeManifest = (directory: string, manifest: MirrorManifest) => writeAtomically(manifestFile(directory), JSON.stringify(manifest), { mode: 0o600 });

/** The location's manifest, or undefined when it is missing, unreadable, or malformed. */
export async function readMirrorManifest(directory: string): Promise<MirrorManifest | undefined> {
  try {
    const manifest = JSON.parse((await regularBytes(manifestFile(directory), 256 * 1024 * 1024)).toString("utf8"));
    if (manifest?.schemaVersion !== 1 || !hashes(manifest.mirror) || !(manifest.indexed === null || hashes(manifest.indexed))) return undefined;
    return manifest;
  } catch { return undefined; }
}

// Whether every file the manifest names is a regular file of the mirror.
async function holds(mirror: string, files: string[]) {
  for (const file of files) {
    const target = path.resolve(mirror, file);
    if (!inside(mirror, target)) return false;
    const info = await lstat(target).catch(() => null);
    if (!info?.isFile()) return false;
  }
  return true;
}

// Removes the folders a removed file leaves empty, up to the mirror itself.
async function pruneEmpty(mirror: string, target: string) {
  for (let folder = path.dirname(target); inside(mirror, folder); folder = path.dirname(folder)) {
    if ((await readdir(folder).catch(() => ["unreadable"])).length) return;
    await rmdir(folder).catch(() => {});
  }
}

/**
 * Brings the location's mirror to the snapshot's files, copying only those whose hash differs from the manifest, and names the changes since the indexed build.
 * A manifest that is missing, unreadable, names a file the mirror lacks, or has no indexed build empties the mirror and the runtime's state for a full build.
 */
export async function updateMirror(directory: string, files: Pick<SourceFile, "file" | "hash" | "absolutePath">[], { privateDirectory, report = () => {}, current = () => {} }: UpdateOptions): Promise<MirrorUpdate> {
  const mirror = path.join(directory, "mirror");
  let manifest = await readMirrorManifest(directory);
  if (!manifest || manifest.indexed === null || !(await holds(mirror, Object.keys(manifest.mirror)))) {
    manifest = { schemaVersion: 1, mirror: {}, indexed: null };
    // The empty manifest comes first, so a build that stops while emptying or copying leaves the next build a full one.
    await writeManifest(directory, manifest);
    await rm(mirror, { recursive: true, force: true });
    await rm(path.join(directory, "runtime-state"), { recursive: true, force: true });
  }
  await privateDirectory(mirror);
  const snapshot = new Map(files.map(file => [file.file, file]));
  const copied = files.filter(file => manifest!.mirror[file.file] !== file.hash);
  const removed = Object.keys(manifest.mirror).filter(file => !snapshot.has(file));
  const kept = Object.fromEntries(Object.entries(manifest.mirror).filter(([file]) => snapshot.has(file) && snapshot.get(file)!.hash === manifest!.mirror[file]));
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
    const handle = await open(target, "wx", 0o400);
    try {
      const bytes = await regularBytes(file.absolutePath, 2 * 1024 * 1024);
      if (sha(bytes) !== file.hash) throw semanticError("stale_snapshot", "Source bytes changed while copying the snapshot.");
      await handle.writeFile(bytes);
    } catch (error) { await handle.close().catch(() => {}); await removeFile(target); throw error; }
    await handle.close();
    report(position + 1, copied.length);
  }
  const indexed = manifest.indexed;
  await writeManifest(directory, { schemaVersion: 1, mirror: Object.fromEntries(files.map(file => [file.file, file.hash])), indexed });
  if (indexed === null) return { mirror };
  return { mirror, changedFiles: files.filter(file => indexed[file.file] !== file.hash).map(file => file.file).sort(),
    removedFiles: Object.keys(indexed).filter(file => !snapshot.has(file)).sort() };
}

/** Records the files of a build whose structure or index the runtime returned, which the next build's change lists are counted from. */
export async function markIndexed(directory: string, files: Pick<SourceFile, "file" | "hash">[]) {
  const manifest = await readMirrorManifest(directory);
  // A manifest that cannot be read leaves the next build a full one, which needs no record.
  if (!manifest) return;
  await writeManifest(directory, { ...manifest, indexed: Object.fromEntries(files.map(file => [file.file, file.hash])) });
}

/** Makes the next build of the location a full one, as when its mirror proved not to match its manifest. */
export async function forgetMirror(directory: string) {
  await rm(manifestFile(directory), { force: true });
}
