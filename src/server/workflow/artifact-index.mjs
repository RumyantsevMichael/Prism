import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_STATUS, artifactLocation, scopeFolder, STATUS_RECORD_NAME, wellFormedName } from "./artifact-paths.mjs";
import { hasStatus, parseRecord } from "./artifact-status.mjs";
import { reviewAppDirectory } from "../review/review-app-discovery.mjs";

// Listings of a store's artifacts answer from an index of every scope's files, so a store of tens of thousands of artifacts lists within a second.
// The index lives in this process for each store and is refreshed when a store sync changed files, when Prism wrote an artifact on this machine, and when it is older than a minute.
// A file added or removed by hand changes its folder, so a listing also refreshes when a folder the index read changed since.
// A refresh reads only the files whose size, times, or inode changed since the last one.
const MAX_AGE_MS = 60 * 1000;
const KINDS = ["requirements", "adrs", "plans", "glossary", "roadmap"];
const HASH_CHUNK = 1024 * 1024;
// Changed files are read a few at a time, so a refresh of many new files never runs out of file handles.
const READS_AT_ONCE = 32;
// Every process that writes artifacts in a store leaves a new token in a file of the Prism application folder named for the store, so another process's index on this machine sees the write.
const STAMPS = "artifact-index";

// Each index is kept by its store and the labels of the scopes it holds, so checkouts that read different scope sets of one store keep one index each.
const indexes = new Map();
const refreshes = new Map();
const generations = new Map();

const stampOf = (base) => path.join(reviewAppDirectory(), STAMPS, createHash("sha256").update(base).digest("hex").slice(0, 16));
const fileStamp = (info) => `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;

/**
 * Note that a store's artifacts changed, so the next listing in any process on this machine refreshes its index first.
 * It never fails: an index that cannot see the note still refreshes once it is a minute old.
 */
export async function markArtifactIndexStale(storeBase) {
  generations.set(storeBase, (generations.get(storeBase) ?? 0) + 1);
  try {
    await mkdir(path.dirname(stampOf(storeBase)), { recursive: true });
    await writeFile(stampOf(storeBase), `${randomBytes(16).toString("hex")}\n`);
  } catch { /* The in-process generation still marks this process's index stale. */ }
}

/**
 * The artifacts of the given scopes of a seen store as { indexedAt, entries }, refreshed first when it is stale:
 * each entry is { location, scope, kind, rest, version, bytes, status }, with status the recorded status of a requirement or ADR and null for every other kind.
 * Links, special files, and names that break the artifact name form are left out, as listings leave them out.
 */
export async function artifactIndex(seen, scopes) {
  const storeBase = seen.store.base;
  const key = [storeBase, ...scopes.map((scope) => scope.label)].join("\0");
  const token = await readFile(stampOf(storeBase), "utf8").catch(() => "");
  const generation = generations.get(storeBase) ?? 0;
  let index = indexes.get(key);
  const fresh = index?.list && index.token === token && index.generation === generation && Date.now() - index.builtAt <= MAX_AGE_MS && await foldersUnchanged(index.folders);
  if (!fresh) {
    // Listings that find the index stale while a refresh runs wait for that refresh rather than start their own.
    let pending = refreshes.get(key);
    if (!pending) {
      pending = refresh(seen, scopes, index, { token, generation, key }).finally(() => refreshes.delete(key));
      refreshes.set(key, pending);
    }
    index = await pending;
  }
  return { indexedAt: new Date(index.builtAt).toISOString(), entries: index.list };
}

async function refresh(seen, scopes, previous, { token, generation, key }) {
  const builtAt = Date.now();
  const files = previous?.files ?? new Map();
  const statuses = previous?.statuses ?? new Map();
  const next = new Map();
  const nextStatuses = new Map();
  const reads = limiter(READS_AT_ONCE);
  const jobs = [];
  const folders = new Map();
  await noteFolder(folders, seen.base);
  for (const scope of scopes) {
    await noteFolder(folders, path.join(seen.base, ...scopeFolder(scope).split("/").filter(Boolean)));
    for (const kind of KINDS) {
      if (kind === "roadmap" && scope.kind !== "workspace") continue;
      const location = artifactLocation(scope, { kind, rest: kind === "glossary" || kind === "roadmap" ? null : "" });
      const folder = kind === "glossary" || kind === "roadmap" ? null : location;
      const found = [];
      // A file system that ignores letter case opens a stored Requirements folder for requirements, so only a kind folder or file whose name matches exactly is read.
      if (!(await exactName(seen.base, location))) continue;
      if (folder === null) {
        const info = await lstat(path.join(seen.base, ...location.split("/"))).catch(() => null);
        if (info?.isFile()) found.push({ location, rest: null, info });
      } else await walk(path.join(seen.base, ...folder.split("/")), folder, "", found, null, folders);
      for (const file of found) {
        const stamp = fileStamp(file.info);
        const held = files.get(file.location);
        const entry = { location: file.location, scope, kind, rest: file.rest, stamp, version: held?.stamp === stamp ? held.version : null, bytes: file.info.size, status: null };
        next.set(file.location, entry);
        if (entry.version === null) jobs.push(reads(async () => { entry.version = await versionOf(path.join(seen.base, ...file.location.split("/"))); }));
      }
      if (hasStatus(kind)) {
        const records = [];
        await walk(path.join(seen.store.base, ARTIFACT_STATUS, ...location.split("/")), location, "", records, STATUS_RECORD_NAME);
        for (const record of records) {
          const at = record.location.slice(0, -(STATUS_RECORD_NAME.length + 1));
          const stamp = fileStamp(record.info);
          const held = statuses.get(at);
          const status = { stamp, status: held?.stamp === stamp ? held.status : undefined };
          nextStatuses.set(at, status);
          if (status.status === undefined) jobs.push(reads(async () => { status.status = parseRecord(kind, await readFile(path.join(seen.store.base, ARTIFACT_STATUS, ...record.location.split("/"))).catch(() => null)).status; }));
        }
      }
    }
  }
  await Promise.all(jobs);
  const list = [];
  for (const entry of next.values()) {
    if (entry.version === null) continue;
    if (hasStatus(entry.kind)) entry.status = nextStatuses.get(entry.location)?.status ?? parseRecord(entry.kind, null).status;
    list.push(entry);
  }
  const index = { token, generation, builtAt, folders, files: next, statuses: nextStatuses, list };
  indexes.set(key, index);
  return index;
}

// A folder's times, or none when it is missing, which a listing compares to tell whether files were added or removed there.
const folderStamp = (info) => info ? `${info.mtimeMs}:${info.ctimeMs}:${info.ino}` : "missing";
async function noteFolder(folders, folder) {
  folders.set(folder, folderStamp(await lstat(folder).catch(() => null)));
}

async function foldersUnchanged(folders) {
  const checks = await Promise.all([...folders].map(async ([folder, stamp]) => folderStamp(await lstat(folder).catch(() => null)) === stamp));
  return checks.every(Boolean);
}

// Whether the last name of a location below a folder is the exact name of an entry of the folder above it.
async function exactName(base, location) {
  const names = location.split("/");
  const parent = path.join(base, ...names.slice(0, -1));
  try { return (await readdir(parent)).includes(names.at(-1)); }
  catch { return false; }
}

// Every regular file below a folder whose names follow the artifact name form, as { location, rest, info }, without following a link; with only, just the files of that name.
// With folders, a Map, each folder walked is noted with its times.
async function walk(directory, location, prefix, found, only = null, folders = null) {
  if (folders) await noteFolder(folders, directory);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return; }
  await Promise.all(entries.map(async (entry) => {
    if (!wellFormedName(entry.name)) return;
    const rest = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(target, location, rest, found, only, folders);
    if (!entry.isFile() || (only !== null && entry.name !== only)) return;
    const info = await lstat(target).catch(() => null);
    if (info?.isFile()) found.push({ location: `${location}/${rest}`, rest, info });
  }));
}

// The version of a stored file, sha256 of its bytes read in chunks without following a link or blocking on a special file, or null when it is gone or no regular file.
async function versionOf(target) {
  let handle;
  try { handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)); }
  catch { return null; }
  try {
    if (!(await handle.stat()).isFile()) return null;
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(HASH_CHUNK);
    for (let read; (read = (await handle.read(chunk, 0, HASH_CHUNK, null)).bytesRead) > 0;) hash.update(chunk.subarray(0, read));
    return `sha256:${hash.digest("hex")}`;
  } catch { return null; }
  finally { await handle.close(); }
}

function limiter(count) {
  let active = 0;
  const waiting = [];
  const next = () => { if (active < count && waiting.length) { active += 1; waiting.shift()(); } };
  return (job) => new Promise((resolve, reject) => {
    waiting.push(() => job().then(resolve, reject).finally(() => { active -= 1; next(); }));
    next();
  });
}
