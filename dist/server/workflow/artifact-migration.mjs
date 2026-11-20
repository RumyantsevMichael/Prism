// Generated from src/server/workflow/artifact-migration.mts by scripts/native-build/compile.mjs.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeAtomically } from "./artifact-store.mjs";
import { ARTIFACT_MIGRATIONS, ARTIFACT_NAME_FORM, artifactAddress, artifactLocation, locationExcess, malformedArtifactName, repositoryScope, WORKSPACE_SCOPE } from "./artifact-paths.mjs";
import { hasStatus, writtenStatus } from "./artifact-status.mjs";
import { folderChecks, resolveArtifactFile, resolveLedgerFile, STORE_FILE_BOUNDS, withArtifactStoreLock } from "./record-store.mjs";
import { scheduleRecordSync } from "./record-store-sync.mjs";
import { roadmapViewOf } from "./roadmap.mjs";
import { generatedNotice } from "./projection.mjs";
import { ARTIFACT_CONTENT_MAX, artifactText, artifactVersion, collidingPath, createMovedArtifacts, pathIndex, recordMovedStatus, seenArtifacts, storedArtifactIn, writeMovedView } from "./store-artifacts.mjs";
import { roadmapPaths } from "./workflow-config.mjs";
import { parseStoreJson } from "./store-json.mjs";
const REFERENCE_FILES_MAX = 200;
const REFERENCE_LINES_MAX = 20;
const REFERENCE_BYTES_MAX = 4 * 1024 * 1024;
const BATCH_FILES = 200;
const BATCH_BYTES = 16 * 1024 * 1024;
const MOVE_LOCK = Object.freeze({ renew: true, timeoutMs: 12e4 });
const LEDGER_SCHEMA = 1;
const LIST_BUFFER = 256 * 1024 * 1024;
const run = promisify(execFile);
const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
async function gitFiles(root, args, pathspecs = []) {
  const { stdout } = await run("git", ["-c", "core.fsmonitor=false", "-C", root, "ls-files", "-z", ...args, "--", ...pathspecs], { maxBuffer: LIST_BUFFER, windowsHide: true });
  return [...new Set(stdout.split("\0").filter(Boolean))].sort();
}
const ENTRY_STATES = Object.freeze({ H: "ordinary", h: "assume_unchanged", S: "skipped", s: "skipped", M: "unmerged", m: "unmerged" });
async function indexStates(root, pathspecs = []) {
  const states = /* @__PURE__ */ new Map();
  for (const entry of await gitFiles(root, ["-v"], pathspecs)) {
    const space = entry.indexOf(" ");
    const file = entry.slice(space + 1);
    const state = ENTRY_STATES[entry.slice(0, space)] ?? "skipped";
    if (states.get(file) !== "unmerged") states.set(file, state);
  }
  return states;
}
const artifactPathspecs = (kinds) => kinds.kinds.map((entry) => `:(literal)${entry.path}`);
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
const OPERATION_MARKERS = Object.freeze(["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer/todo"]);
const MARKER_READ_MAX = 64 * 1024;
async function operationInProgress(root) {
  const { stdout } = await run("git", ["-c", "core.fsmonitor=false", "-C", root, "rev-parse", ...OPERATION_MARKERS.flatMap((marker) => ["--git-path", marker])], { maxBuffer: LIST_BUFFER, windowsHide: true });
  const located = stdout.split("\n").filter(Boolean);
  if (located.length !== OPERATION_MARKERS.length) throw new Error("git rev-parse did not locate every marker");
  const at = new Map(OPERATION_MARKERS.map((marker, index) => [marker, path.resolve(root, located[index])]));
  const present = async (marker) => await lstat(at.get(marker)).catch((error) => {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }) !== null;
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
async function heldFiles(root, files) {
  const held = [];
  for (const file of files) if ((await lstat(path.join(root, ...file.split("/"))).catch(() => null))?.isFile()) held.push(file);
  return held;
}
async function waitingArtifactFiles(root, kinds) {
  const listing = await checkoutListing(root, kinds);
  return listing === null ? null : heldFiles(root, listing.candidates);
}
async function checkoutArtifactsByMove(root, kinds, { store, repository, left = () => false }) {
  const listing = await checkoutListing(root, kinds);
  if (listing === null) return null;
  const files = (await heldFiles(root, listing.candidates)).filter((file) => !left(file));
  const counts = { waiting: 0, kept: (await heldFiles(root, [...listing.assumed, ...listing.unmerged])).filter((file) => !left(file)).length };
  if (!files.length) return counts;
  const ledger = await ledgersOf(store, repository);
  const own = repositoryScope(repository);
  const resolvable = /* @__PURE__ */ new Set(["too_large", "not_text", "path_too_long"]);
  await withCheckoutFiles(root, async (access) => {
    for (const file of files) {
      const reasons = ledger.keptFor.get(file);
      let kept = reasons !== void 0 && !ledger.movedFrom.has(file);
      if (kept && [...reasons].every((reason) => resolvable.has(reason))) {
        const fits = !reasons.has("path_too_long") || locationExcess(artifactLocation(own, artifactAddress(kinds, file))) === null;
        const content = !reasons.has("too_large") && !reasons.has("not_text") ? true : await access.read(file, ARTIFACT_CONTENT_MAX).then((read) => Boolean(read?.bytes) && artifactText(read.bytes) !== null, () => false);
        if (fits && content) kept = false;
      }
      counts[kept ? "kept" : "waiting"] += 1;
    }
  });
  return counts;
}
async function holdsArtifactPaths(root, kinds) {
  for (const entry of kinds.kinds) if (await lstat(path.join(root, ...entry.path.split("/"))).then(() => true, () => false)) return true;
  return false;
}
async function fileBytes(folder, file, max = Infinity) {
  let handle;
  try {
    handle = await open(path.join(folder, ...file.split("/")), READ_FLAGS);
  } catch (error) {
    if (GONE.includes(error.code)) return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const FOLDER_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY || 0);
const GONE = ["ENOENT", "ENOTDIR", "ELOOP"];
const FOLDERS_OPEN_MAX = 16;
let heldFolders = null;
function holdsFolders() {
  heldFolders ??= (async () => {
    if (process.platform !== "linux") return false;
    let handle;
    try {
      handle = await open("/", FOLDER_FLAGS);
      return await readlink(`/proc/self/fd/${handle.fd}`) === "/";
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => {
      });
    }
  })();
  return heldFolders;
}
const sameFile = (left, right) => right !== null && left.dev === right.dev && left.ino === right.ino;
const unchangedFile = (left, right) => sameFile(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
async function checkoutFiles(root, decided = null) {
  const real = decided ?? await realpath(root);
  const linked = await holdsFolders();
  const rootHere = async () => await realpath(root).catch(() => null) === real;
  const absent = async () => await rootHere() ? "gone" : null;
  const handles = /* @__PURE__ */ new Map();
  const placeOf = (folder) => folder === "" ? real : path.join(real, ...folder.split("/"));
  const parts = (file) => {
    const names = file.split("/");
    return { folder: names.slice(0, -1).join("/"), name: names.at(-1) };
  };
  const release = async (folder) => {
    const handle = handles.get(folder);
    handles.delete(folder);
    await handle?.close().catch(() => {
    });
  };
  const hold = async (folder) => {
    const handle = await open(placeOf(folder), FOLDER_FLAGS);
    handles.set(folder, handle);
    while (handles.size > FOLDERS_OPEN_MAX) await release(handles.keys().next().value);
    return handle;
  };
  const placed = async (folder) => {
    const place = placeOf(folder);
    if (linked) {
      for (const fresh of [false, true]) {
        let handle = fresh ? null : handles.get(folder);
        if (handle) {
          handles.delete(folder);
          handles.set(folder, handle);
        } else {
          if (fresh) await release(folder);
          try {
            handle = await hold(folder);
          } catch (error) {
            if (["ENOENT", "ENOTDIR"].includes(error.code)) return absent();
            if (error.code === "ELOOP") return null;
            throw error;
          }
        }
        const prefix = `/proc/self/fd/${handle.fd}`;
        if (await readlink(prefix).catch(() => null) === place) return prefix;
      }
      return null;
    }
    const resolved = await realpath(place).catch(() => null);
    if (resolved !== null) return resolved === place && await rootHere() ? place : null;
    let current = real;
    for (const name of folder === "" ? [] : folder.split("/")) {
      current = path.join(current, name);
      const info = await lstat(current).catch(() => null);
      if (info === null || !(info.isDirectory() || info.isSymbolicLink())) return absent();
      if (!info.isDirectory()) return null;
    }
    return await realpath(place).catch(() => null) === place && await rootHere() ? place : null;
  };
  const opened = async (file) => {
    const { folder, name } = parts(file);
    const prefix = await placed(folder);
    if (prefix === "gone") return { state: "gone" };
    if (prefix === null) return { state: "outside" };
    const entry = `${prefix}/${name}`;
    const before = await lstat(entry).catch((error) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
      throw error;
    });
    if (before === null) return { state: await absent() ?? "outside" };
    if (before.isSymbolicLink()) return { state: "outside" };
    if (!before.isFile()) return { state: "gone" };
    let handle;
    try {
      handle = await open(entry, READ_FLAGS);
    } catch (error) {
      if (error.code === "ENOENT") return { state: await absent() ?? "outside" };
      if (GONE.includes(error.code)) return { state: "outside" };
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
      } finally {
        await found.handle.close();
      }
    },
    async remove(file, { version, size }) {
      const found = await opened(file);
      if (found.state !== "open") return found.state === "gone" ? "gone" : "changed";
      try {
        if (Number(found.info.size) !== size) return "changed";
        const bytes = await found.handle.readFile();
        const read = await found.handle.stat({ bigint: true });
        if (bytes.length !== size || artifactVersion(bytes) !== version || !unchangedFile(found.info, read)) return "changed";
        if (await placed(found.folder) !== found.prefix || !unchangedFile(read, await lstat(found.entry, { bigint: true }).catch(() => null))) return "changed";
        try {
          await unlink(found.entry);
        } catch (error) {
          if (error.code === "ENOENT") return "gone";
          throw error;
        }
        return "removed";
      } finally {
        await found.handle.close();
      }
    },
    async lacks(file) {
      const { folder, name } = parts(file);
      const prefix = await placed(folder);
      if (prefix === null) return false;
      if (prefix === "gone") return true;
      const entry = await lstat(`${prefix}/${name}`).catch((error) => {
        if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
        throw error;
      });
      return entry === null && await absent() === "gone";
    },
    async removeFolder(folder) {
      const { folder: parent, name } = parts(folder);
      const prefix = await placed(parent);
      if (prefix === null || prefix === "gone") return false;
      return rmdir(`${prefix}/${name}`).then(() => true, () => false);
    },
    async close() {
      for (const folder of [...handles.keys()]) await release(folder);
    }
  };
}
async function withCheckoutFiles(root, action, real = null) {
  const access = await checkoutFiles(root, real);
  try {
    return await action(access);
  } finally {
    await access.close();
  }
}
const readLedgers = (seen) => ledgersOf(seen.store.base, seen.repository);
async function ledgersOf(storeBase, repository) {
  const folder = path.join(storeBase, ARTIFACT_MIGRATIONS);
  const ledger = { moved: /* @__PURE__ */ new Set(), movedFrom: /* @__PURE__ */ new Set(), movedTo: /* @__PURE__ */ new Map(), kept: /* @__PURE__ */ new Set(), keptFor: /* @__PURE__ */ new Map() };
  let names = [];
  try {
    names = (await readdir(folder)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  for (const name of names) {
    let entry;
    try {
      entry = parseStoreJson((await fileBytes(folder, name, STORE_FILE_BOUNDS.ledger))?.toString("utf8") ?? "null");
    } catch {
      continue;
    }
    if (entry?.repository !== repository) continue;
    for (const move of Array.isArray(entry.moved) ? entry.moved : []) {
      if (typeof move?.to === "string") ledger.moved.add(move.to);
      if (typeof move?.from === "string") ledger.movedFrom.add(move.from);
      if (typeof move?.from === "string" && typeof move?.to === "string") ledger.movedTo.set(move.from, move.to);
    }
    for (const kept of Array.isArray(entry.kept) ? entry.kept : []) {
      if (typeof kept?.path !== "string" || typeof kept.reason !== "string") continue;
      ledger.kept.add(`${kept.path}\0${kept.reason}`);
      ledger.keptFor.set(kept.path, /* @__PURE__ */ new Set([...ledger.keptFor.get(kept.path) ?? [], kept.reason]));
    }
  }
  return ledger;
}
async function migrateArtifacts({ root, kinds, store, repository, pull = null, named = null, prepare }) {
  const listing = await checkoutListing(root, kinds);
  if (listing === null) return await holdsArtifactPaths(root, kinds) ? { repository, store, unlisted: true } : null;
  const report = (listing2, outcome) => ({ repository, store, untracked: listing2.untracked, ignored: listing2.ignored, references: [], moreReferences: 0, moved: [], earlier: [], kept: [], passed: [], ledger: null, ...outcome });
  const quiet = (listing2, passed = []) => passed.length || listing2.untracked.length || listing2.ignored ? report(listing2, { passed }) : null;
  const operation = async () => {
    const waiting = await waitsFor(root);
    if (waiting === void 0) return { repository, store, unlisted: true };
    return waiting ? { repository, store, operation: waiting } : null;
  };
  const decide = async (listing2, { seen, recordSources, frozenTests }) => {
    const stopped2 = await operation();
    if (stopped2) return stopped2;
    const left = (file) => recordSources.has(file) || frozenTests.has(file);
    const files = listing2.candidates.filter((file) => !left(file));
    const passed = await passedOver(seen, listing2, left);
    if (!files.length) return quiet(listing2, passed);
    const { earlier, lacking } = await movedEarlier(seen, files, listing2.deleted, named);
    const present = files.filter((file) => !lacking.has(file));
    if (!present.length && !earlier.length) return quiet(listing2, passed);
    const decided = present.length ? await withArtifactStoreLock(seen, async () => await operation() ?? { into: await moveIntoStore(seen, present) }, MOVE_LOCK) : { into: { moved: [], kept: [], ledger: null, real: await realpath(root) } };
    if (!decided.into) return decided;
    return { finish: (options) => finishMove(seen, listing2, { ...decided.into, earlier, passed }, report, { ...options, named }) };
  };
  const decides = (listing2) => listing2.candidates.length || listing2.assumed.length || listing2.unmerged.length;
  if (!decides(listing)) return quiet(listing);
  const stopped = await operation();
  if (stopped) return stopped;
  if (pull && await anyDependsOnStore(root, kinds, repository, listing.candidates)) {
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
const waitsFor = (root) => operationInProgress(root).catch(() => void 0);
async function passedOver(seen, listing, left) {
  const entries = [...listing.assumed.map((file) => ({ path: file, reason: "assume_unchanged" })), ...listing.unmerged.map((file) => ({ path: file, reason: "unmerged" }))].filter((entry) => !left(entry.path));
  if (!entries.length) return [];
  const lacking = /* @__PURE__ */ new Set();
  await withCheckoutFiles(seen.root, async (access) => {
    for (const entry of entries) if (await access.lacks(entry.path)) lacking.add(entry.path);
  });
  const ledger = lacking.size ? await readLedgers(seen) : null;
  return entries.filter((entry) => !lacking.has(entry.path) || ledger.movedFrom.has(entry.path)).sort(byPath);
}
async function movedEarlier(seen, files, deleted, named) {
  const lacking = /* @__PURE__ */ new Set();
  await withCheckoutFiles(seen.root, async (access) => {
    for (const file of files) if (await access.lacks(file)) lacking.add(file);
  });
  const earlier = [];
  if (!lacking.size) return { earlier, lacking };
  const ledger = await readLedgers(seen);
  for (const file of lacking) {
    if (!deleted.has(file)) continue;
    const to = ledger.movedTo.get(file);
    if (to !== void 0 && !named?.has(file) && await storeHolds(seen, to)) earlier.push({ from: file, to });
  }
  return { earlier, lacking };
}
async function storeHolds(seen, location) {
  try {
    return (await lstat(await resolveArtifactFile(seen, location)).catch(() => null))?.isFile() ?? false;
  } catch {
    return false;
  }
}
const unfinishedMove = (outcome) => typeof outcome?.finish === "function";
async function finishedMove(outcome, { proceed = () => true, writes = null } = {}) {
  return unfinishedMove(outcome) ? outcome.finish({ proceed, writes }) : outcome;
}
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
  const location = artifactLocation(own, address);
  if (locationExcess(location) !== null) return { address, kept: "path_too_long", details: { location } };
  return { address, size, bytes, text, location };
}
async function anyDependsOnStore(root, kinds, repository, files) {
  const own = repositoryScope(repository);
  try {
    return await withCheckoutFiles(root, async (access) => {
      for (const file of files) {
        try {
          const local = await decideLocally(access, kinds, own, file);
          if (local !== null && !local.kept) return true;
        } catch {
          return true;
        }
      }
      return false;
    });
  } catch {
    return true;
  }
}
function moveIntoStore(seen, files) {
  return withCheckoutFiles(seen.root, async (access) => ({ ...await decideAndWrite(seen, access, files), real: access.real }));
}
async function decideAndWrite(seen, access, files) {
  const own = repositoryScope(seen.repository);
  const ledger = await readLedgers(seen);
  const held = await seenArtifacts(seen);
  const heldAt = /* @__PURE__ */ new Map();
  for (const entry of held) heldAt.set(entry.path, [...heldAt.get(entry.path) ?? [], entry]);
  const moved = [], kept = [], creates = [], statuses = [];
  const keep = (file, reason, details = {}) => kept.push({ path: file, reason, ...details });
  for (const file of files) {
    const local = await decideLocally(access, seen.kinds, own, file);
    if (local === null) continue;
    if (local.kept) {
      keep(file, local.kept, local.details);
      continue;
    }
    const { address, size, bytes, text, location } = local;
    if (local.roadmap) {
      await decideRoadmapView(seen, access, file, address, size, { moved, keep });
      continue;
    }
    const version = artifactVersion(bytes);
    const holders = heldAt.get(file) ?? [];
    const holder = holders.find((entry) => entry.scope.kind === "repository") ?? holders.find((entry) => entry.scope.kind === "component");
    if (holder) {
      const stored = await storedArtifactIn(seen, holder.scope, address);
      if (stored.record?.version !== version) {
        keep(file, "differs", { location: stored.location });
        continue;
      }
      if (hasStatus(address.kind)) statuses.push({ scope: holder.scope, address, written: writtenStatus(text), bytes });
      moved.push({ from: file, to: stored.location, version, size: bytes.length });
      continue;
    }
    if (holders.some((entry) => entry.scope.kind === "workspace")) {
      keep(file, "workspace_holds", { location: artifactLocation(WORKSPACE_SCOPE, address) });
      continue;
    }
    if (ledger.moved.has(location)) {
      keep(file, "removed_in_store", { location });
      continue;
    }
    creates.push({ file, address, scope: own, location, size: bytes.length });
  }
  const storedIndex = pathIndex(held);
  const createIndex = pathIndex(creates.map((item) => ({ kind: item.address.kind, path: item.file })));
  const writes = [];
  for (const item of creates) {
    const other = collidingPath(storedIndex, item.address.kind, item.file) ?? collidingPath(createIndex, item.address.kind, item.file);
    if (other === void 0) writes.push(item);
    else keep(item.file, "name_conflict", { other });
  }
  for (const batch of batches(writes)) {
    for (const item of await createWrites(seen, access, batch, keep, held)) moved.push({ from: item.file, to: item.location, version: item.version, size: item.size });
  }
  for (const { scope, address, written, bytes } of statuses) await recordMovedStatus(seen, scope, address, written, bytes);
  const name = await writeLedger(seen, ledger, moved, kept);
  return { moved, kept, ledger: name };
}
function* batches(writes) {
  let batch = [], bytes = 0;
  for (const item of writes) {
    if (batch.length && (batch.length >= BATCH_FILES || bytes + item.size > BATCH_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += item.size;
  }
  if (batch.length) yield batch;
}
async function createWrites(seen, access, batch, keep, held) {
  const items = [];
  for (const item of batch) {
    const read = await access.read(item.file, ARTIFACT_CONTENT_MAX);
    if (read === null) continue;
    if (read.bytes === null) {
      keep(item.file, "too_large", { size: read.size });
      continue;
    }
    const { bytes } = read;
    const text = artifactText(bytes);
    if (text === null) {
      keep(item.file, "not_text");
      continue;
    }
    items.push({ ...item, bytes, text, size: bytes.length, version: artifactVersion(bytes), ...hasStatus(item.address.kind) ? { writtenStatus: writtenStatus(text) } : {} });
  }
  const done = (list) => list.map(({ bytes, text, ...rest }) => rest);
  try {
    await createMovedArtifacts(seen, items, { held });
    return done(items);
  } catch (error) {
    if (error?.name !== "ArtifactError") throw error;
  }
  const created = [];
  for (const item of items) {
    try {
      await createMovedArtifacts(seen, [item], { held });
      created.push(item);
    } catch (error) {
      if (error?.name !== "ArtifactError") throw error;
      keepRefused(item, error, keep);
    }
  }
  return done(created);
}
function keepRefused(item, error, keep) {
  if (error.code === "artifact_name_conflict") keep(item.file, "name_conflict", { other: error.path });
  else if (error.code === "artifact_path_too_long") keep(item.file, "path_too_long", { location: item.location });
  else if (error.code === "invalid_path" && typeof error.location === "string") keep(item.file, "name_conflict", { other: `artifacts/${error.location}` });
  else if (error.code === "artifact_name_invalid") keep(item.file, "name_invalid");
  else if (error.code === "artifact_too_large") keep(item.file, "too_large", { size: item.size });
  else keep(item.file, "differs", { location: item.location });
}
async function decideRoadmapView(seen, access, file, address, size, { moved, keep }) {
  const recordName = path.posix.basename(roadmapPaths(seen.config).record);
  const record = await fileBytes(seen.store.base, "roadmap.json", 64 * 1024 * 1024).catch(() => null);
  const view = roadmapViewOf(record, recordName);
  if (view === null) {
    keep(file, "no_roadmap_record");
    return;
  }
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
async function writeLedger(seen, ledger, moved, kept) {
  if (!moved.length && kept.every((entry) => ledger.kept.has(`${entry.path}\0${entry.reason}`))) return null;
  const at = (/* @__PURE__ */ new Date()).toISOString();
  const text = (part) => `${JSON.stringify({ schemaVersion: LEDGER_SCHEMA, repository: seen.repository, migratedAt: at, moved: part.moved, kept: part.kept }, null, 2)}
`;
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
function ledgerParts(entries, text) {
  const whole = text(entries);
  if (Buffer.byteLength(whole) <= STORE_FILE_BOUNDS.ledger) return [{ ...entries, text: whole }];
  const items = [...entries.moved.map((item) => ["moved", item]), ...entries.kept.map((item) => ["kept", item])];
  if (items.length < 2) throw new Error("A ledger entry exceeds the bound of a ledger file.");
  const half = Math.ceil(items.length / 2);
  const part = (list) => ({ moved: list.filter(([kind]) => kind === "moved").map(([, item]) => item), kept: list.filter(([kind]) => kind === "kept").map(([, item]) => item) });
  return [...ledgerParts(part(items.slice(0, half)), text), ...ledgerParts(part(items.slice(half)), text)];
}
async function finishMove(seen, listing, decided, report, { proceed = () => true, writes = null, named = null } = {}) {
  const passed = [...decided.passed ?? []], untracked = [...listing.untracked];
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
  const reading = { ...seen, folderChecks: folderChecks() };
  for (const move of decided.moved) {
    if (!ledgered?.has(`${move.from}\0${move.to}`)) {
      retry = true;
      continue;
    }
    const stored = await storedVersion(reading, move.to, move.size, writes).catch(() => "other");
    checked.push({ move, stored, confirmed: stored === move.version || Boolean(stored?.updated) });
  }
  const stayFor = ({ move, stored }) => stay(move, stored === null ? "removed_in_store" : "differs");
  const unique = (entries) => [...new Map(entries.map((entry) => [entry.path, entry])).values()].sort(byPath);
  const done = (outcome) => report(listing, { untracked: [...new Set(untracked)].sort(), ...outcome, passed: unique(passed) });
  const states = waiting === null ? await indexStates(seen.root, artifactPathspecs(seen.kinds)).catch(() => null) : null;
  if (states === null || await realpath(seen.root).catch(() => null) !== decided.real) {
    for (const entry of checked) if (!entry.confirmed) stayFor(entry);
    return done({ kept: [...decided.kept, ...stayed].sort(byPath), ledger: decided.ledger, retry: true });
  }
  return withCheckoutFiles(seen.root, async (access) => {
    const taken = async (file) => {
      const state = states.get(file);
      if (state === "ordinary") return true;
      if (state === "assume_unchanged" || state === "unmerged") passed.push({ path: file, reason: state });
      else if (state === void 0 && !await access.lacks(file)) untracked.push(file);
      return state === void 0 && await access.lacks(file);
    };
    const removing = [];
    for (const entry of checked) {
      if (!await taken(entry.move.from)) continue;
      if (entry.confirmed || entry.stored !== null && await access.lacks(entry.move.from) && await storeHolds(seen, entry.move.to)) removing.push(entry.move);
      else stayFor(entry);
    }
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
      if (!proceed()) return { interrupted: true };
      if (await access.remove(move.from, move) === "changed") stay(move, "differs");
      else {
        left.push(move);
        named?.add(move.from);
      }
    }
    const removed = left.map((move) => move.from);
    if (left.length !== removing.length) {
      const gone = new Set(removed);
      found = await referencesOf(access, seen.kinds, listing.tracked.filter((file) => !gone.has(file)), formerPaths(left));
    }
    await pruneCheckoutFolders(access, seen.kinds, removed);
    for (const item of earlier) named?.add(item.from);
    return done({ moved: left.map(({ from, to }) => ({ from, to })), earlier: earlier.map(({ from, to }) => ({ from, to })), kept: [...decided.kept, ...stayed].sort(byPath), references: found.references, moreReferences: found.moreReferences, ledger: decided.ledger, ...retry ? { retry } : {} });
  }, decided.real);
}
async function ledgerMoves(seen, names) {
  if (!names?.length) return null;
  const moves = /* @__PURE__ */ new Set();
  try {
    for (const name of names) {
      const file = await resolveLedgerFile(seen, name);
      const entry = parseStoreJson((await fileBytes(path.dirname(file), path.basename(file), STORE_FILE_BOUNDS.ledger))?.toString("utf8") ?? "null");
      if (entry?.repository !== seen.repository || !Array.isArray(entry.moved)) return null;
      for (const move of entry.moved) if (typeof move?.from === "string" && typeof move.to === "string") moves.add(`${move.from}\0${move.to}`);
    }
  } catch {
    return null;
  }
  return moves;
}
async function storedVersion(seen, location, size, writes = null) {
  const file = await resolveArtifactFile(seen, location);
  const info = await lstat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return null;
  const updates = writes?.get(file);
  if (updates?.size && info.isFile() && info.size <= ARTIFACT_CONTENT_MAX) {
    const bytes2 = await fileBytes(path.dirname(file), path.basename(file), ARTIFACT_CONTENT_MAX);
    const version = bytes2 === null ? null : artifactVersion(bytes2);
    if (version !== null && updates.has(version)) return { updated: true };
    if (version !== null && bytes2.length === size) return version;
    return "other";
  }
  const bytes = info.isFile() && info.size === size ? await fileBytes(path.dirname(file), path.basename(file), size) : null;
  return bytes === null ? "other" : artifactVersion(bytes);
}
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
const WORKFLOW_CONFIG = ".prism/workflow.md";
async function referencesOf(access, kinds, tracked, movedFiles) {
  const none = { references: [], moreReferences: 0 };
  if (!movedFiles.length) return none;
  const folders = kinds.kinds.filter((entry) => entry.folder && entry.path !== "" && movedFiles.some((file) => artifactAddress(kinds, file)?.kind === entry.kind)).map((entry) => entry.path);
  const needles = [.../* @__PURE__ */ new Set([...folders, ...movedFiles.filter((file) => !folders.some((folder) => file.startsWith(`${folder}/`)))])];
  const found = [];
  let more = 0;
  for (const file of tracked) {
    if (file === WORKFLOW_CONFIG) continue;
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
const UNSAFE_IN_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ESCAPED_AFTER_JSON = /[\u007f-\u009f\u2028\u2029]/gu;
function shownPath(value) {
  const text = String(value);
  if (!UNSAFE_IN_LINE.test(text)) return text;
  return JSON.stringify(text).replace(ESCAPED_AFTER_JSON, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function keptExplanation(entry) {
  const where = entry.location ? shownPath(`artifacts/${entry.location}`) : null;
  switch (entry.reason) {
    case "differs":
      return `the store already holds other bytes at ${where}; a person compares the two and brings what still matters into the store with update_artifact before removing the checkout's copy`;
    case "workspace_holds":
      return `the workspace scope already holds this path at ${where}; a person brings what still matters into it with update_artifact before removing the checkout's copy`;
    case "removed_in_store":
      return `it moved into the store at ${where} before and was removed there since, so the store does not take it back; a person decides whether to write it again with update_artifact or to remove the checkout's copy`;
    case "name_invalid":
      return `its path breaks the artifact name form, so the store does not take it: ${ARTIFACT_NAME_FORM}; rename it to that form, and a later first access moves it`;
    case "name_conflict":
      return `it differs only in letter case from ${shownPath(entry.other)}, and the two would be one file on a file system that ignores letter case; rename one of them, and a later first access moves it`;
    case "path_too_long":
      return `its location ${where} ${locationExcess(entry.location) ?? "was too long when the move ran"}, so some machine could not write it or its comments; give it a shorter path, and a later first access moves it`;
    case "too_large":
      return `it holds ${entry.size} bytes, above the ${ARTIFACT_CONTENT_MAX} bytes (1 MiB) that an artifact may hold, so the store does not take it; keep it in the checkout, or make it smaller and commit it for a later first access to move`;
    case "not_text":
      return "it is not UTF-8 text, which the artifact tools read and write, so the store does not take it; keep it in the checkout";
    case "view_differs":
      return `it differs from the roadmap view at ${where} that the store generates from the roadmap record; put content that the roadmap record lacks into the record through update_roadmap before a person removes the file`;
    case "assume_unchanged":
      return "its index entry has Git's assume-unchanged bit, so Git neither shows nor stages a change or a removal at its path and the store does not take it; git update-index --no-assume-unchanged on its path clears the bit, after which a later session's move decides it, or reports it as moved earlier when the checkout lacks it";
    case "unmerged":
      return "Git's index holds it unmerged, in the stages of a conflict that a merge, rebase, git am, cherry-pick, revert, or git stash pop stopped on, so its file may hold conflict markers and the store does not take it; a person resolves the conflict and stages the result with git add, or ends the operation, after which a later session's move decides it";
    case "no_roadmap_record":
      return "the store holds no valid roadmap record to generate the view from; put content that a roadmap record needs into the record through update_roadmap before a person removes the file";
    default:
      return entry.reason;
  }
}
export {
  checkoutArtifactsByMove,
  finishedMove,
  keptExplanation,
  migrateArtifacts,
  shownPath,
  unfinishedMove,
  waitingArtifactFiles
};
