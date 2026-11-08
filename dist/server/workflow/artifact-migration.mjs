import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeAtomically } from "./artifact-store.mjs";
import { ARTIFACT_MIGRATIONS, ARTIFACT_NAME_FORM, artifactAddress, artifactLocation, malformedArtifactName, repositoryScope, WORKSPACE_SCOPE } from "./artifact-paths.mjs";
import { hasStatus, writtenStatus } from "./artifact-status.mjs";
import { resolveLedgerFile, withArtifactStoreLock } from "./record-store.mjs";
import { scheduleRecordSync } from "./record-store-sync.mjs";
import { roadmapViewOf } from "./roadmap.mjs";
import { generatedNotice } from "./projection.mjs";
import { ARTIFACT_CONTENT_MAX, ARTIFACT_LOCATION_MAX, artifactText, artifactVersion, collidingPath, createMovedArtifacts, pathIndex, recordMovedStatus, seenArtifacts, storedArtifactIn, writeMovedView } from "./store-artifacts.mjs";
import { roadmapPaths } from "./workflow-config.mjs";

// On a checkout's first access to its store, the files Git tracks under its artifact paths move into its repository's scope once, and every file the move cannot take stays where it is.
// The move writes the store and its ledger first and removes a checkout file only then, and only while it holds the bytes the store took, so an interruption leaves a file in both places rather than in neither.
const REFERENCE_FILES_MAX = 200;
const REFERENCE_LINES_MAX = 20;
const REFERENCE_BYTES_MAX = 4 * 1024 * 1024;
// The move reads and writes its files in batches, so it never holds more than a bounded number of bytes at once.
const BATCH_FILES = 200;
const BATCH_BYTES = 16 * 1024 * 1024;
// A move of thousands of files can outlast the lock's staleness bound, so it renews the lock, and a checkout that waits for another's move waits longer than an update does.
const MOVE_LOCK = Object.freeze({ renew: true, timeoutMs: 120000 });
const LEDGER_SCHEMA = 1;
const LIST_BUFFER = 256 * 1024 * 1024;
const run = promisify(execFile);

const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

// The checkout's files that Git lists, as project-relative paths: tracked from the index, and with others the untracked ones that Git does not ignore, or with ignored the ignored ones.
// Git runs without the checkout's file system monitor, so listing runs no program that the checkout's configuration names.
async function gitFiles(root, args, pathspecs = []) {
  const { stdout } = await run("git", ["-c", "core.fsmonitor=false", "-C", root, "ls-files", "-z", ...args, "--", ...pathspecs], { maxBuffer: LIST_BUFFER });
  return [...new Set(stdout.split("\0").filter(Boolean))].sort();
}

/**
 * The checkout's files under its artifact paths as Git lists them: { tracked, candidates, untracked, ignored }, where tracked lists every tracked file of the checkout,
 * candidates the tracked ones under the artifact paths, untracked the untracked ones there that Git does not ignore, and ignored the number of ignored ones there;
 * null when Git cannot list them.
 */
async function checkoutListing(root, kinds) {
  const inArtifactPaths = (file) => {
    const address = artifactAddress(kinds, file);
    return address !== null && address.rest !== "";
  };
  const pathspecs = kinds.kinds.map((entry) => `:(literal)${entry.path}`);
  try {
    const tracked = await gitFiles(root, []);
    const untracked = (await gitFiles(root, ["--others", "--exclude-standard"], pathspecs)).filter(inArtifactPaths);
    const ignored = (await gitFiles(root, ["--others", "--ignored", "--exclude-standard"], pathspecs)).filter(inArtifactPaths).length;
    return { tracked, candidates: tracked.filter(inArtifactPaths), untracked, ignored };
  } catch {
    return null;
  }
}

// Whether any configured artifact path exists in the checkout, so a checkout that Git cannot list is reported only when it holds something the move would have taken.
async function holdsArtifactPaths(root, kinds) {
  for (const entry of kinds.kinds) if (await lstat(path.join(root, ...entry.path.split("/"))).then(() => true, () => false)) return true;
  return false;
}

// Whether every folder from the checkout's root down to a file is a real folder, never a symbolic link, so the move never reads through one.
async function realFolders(root, file, cache) {
  let current = "";
  for (const name of file.split("/").slice(0, -1)) {
    current = current === "" ? name : `${current}/${name}`;
    if (!cache.has(current)) cache.set(current, await lstat(path.join(root, ...current.split("/"))).then((info) => info.isDirectory(), () => false));
    if (!cache.get(current)) return false;
  }
  return true;
}

// The size of a checkout file, read without following a symbolic link, or null when it is gone or is no regular file.
async function checkoutSize(root, file) {
  const info = await lstat(path.join(root, ...file.split("/"))).catch(() => null);
  return info?.isFile() ? info.size : null;
}

// The bytes of a checkout file, read without following a symbolic link, or null when it is gone, is no regular file, or holds more than max bytes, so no read takes more than that.
async function checkoutBytes(root, file, max = Infinity) {
  let handle;
  try { handle = await open(path.join(root, ...file.split("/")), constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)); }
  catch (error) { if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return null;
    return await handle.readFile();
  } finally { await handle.close(); }
}

// The ledgers of earlier moves of the repository: the locations each moved into the store, and the files each kept with their reasons.
async function readLedgers(seen) {
  const folder = path.join(seen.store.base, ARTIFACT_MIGRATIONS);
  const ledger = { moved: new Set(), kept: new Set() };
  let names = [];
  try { names = (await readdir(folder)).filter((name) => name.endsWith(".json")).sort(); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  for (const name of names) {
    let entry;
    try { entry = JSON.parse((await checkoutBytes(folder, name, 64 * 1024 * 1024))?.toString("utf8") ?? "null"); }
    catch { continue; }
    if (entry?.repository !== seen.repository) continue;
    for (const move of Array.isArray(entry.moved) ? entry.moved : []) if (typeof move?.to === "string") ledger.moved.add(move.to);
    for (const kept of Array.isArray(entry.kept) ? entry.kept : []) if (typeof kept?.path === "string") ledger.kept.add(`${kept.path}\0${kept.reason}`);
  }
  return ledger;
}

/**
 * Move a checkout's tracked files under its artifact paths into its repository's scope.
 * The caller gives the checkout's root and artifact kinds, the store's folder and the repository's accepted name, pull, which completes a pull of a synced store
 * and returns { pulled, state }, or null without sync, and prepare, which returns { seen, recordSources, frozenTests } once the store is as pulled:
 * the scopes the checkout sees, the record files that the record move takes, and the frozen tests of accepted designs, which all stay in the checkout.
 * Returns null when there is nothing to report, else { repository, store, moved, kept, untracked, ignored, references, moreReferences, ledger },
 * or { repository, store, deferred } when the pull did not complete, or { repository, store, unlisted: true } when Git cannot list the checkout's files:
 * moved lists { from, to } from checkout path to location below artifacts/, kept lists { path, reason, location?, other?, size? }, untracked lists checkout paths,
 * references lists { file, lines, more }, and ledger names the ledger file the move wrote, or null.
 */
export async function migrateArtifacts({ root, kinds, store, repository, pull = null, prepare }) {
  const listing = await checkoutListing(root, kinds);
  if (listing === null) return await holdsArtifactPaths(root, kinds) ? { repository, store, unlisted: true } : null;
  const report = (outcome) => ({ repository, store, untracked: listing.untracked, ignored: listing.ignored, references: [], moreReferences: 0, moved: [], kept: [], ledger: null, ...outcome });
  const quiet = () => listing.untracked.length || listing.ignored ? report({}) : null;
  if (!listing.candidates.length) return quiet();
  if (pull) {
    const pulled = await pull();
    if (!pulled.pulled) return { repository, store, deferred: { state: pulled.state } };
  }
  const { seen, recordSources, frozenTests } = await prepare();
  const files = listing.candidates.filter((file) => !recordSources.has(file) && !frozenTests.has(file));
  if (!files.length) return quiet();
  const decided = await withArtifactStoreLock(seen, () => moveIntoStore(seen, files), MOVE_LOCK);
  const outcome = await removeMoved(seen.root, decided);
  await pruneCheckoutFolders(root, kinds, outcome.moved.map((move) => move.from));
  const removed = new Set(outcome.moved.map((move) => move.from));
  const { references, moreReferences } = await referencesOf(root, kinds, listing.tracked.filter((file) => !removed.has(file)), outcome.moved.map((move) => move.from));
  return report({ moved: outcome.moved, kept: outcome.kept, references, moreReferences, ledger: decided.ledger });
}

// Decide every file, write the store copies and status records, then the ledger, all while holding the store's artifact lock; the checkout's files are removed afterwards.
async function moveIntoStore(seen, files) {
  const own = repositoryScope(seen.repository);
  const ledger = await readLedgers(seen);
  const held = await seenArtifacts(seen);
  const heldAt = new Map();
  for (const entry of held) heldAt.set(entry.path, [...(heldAt.get(entry.path) ?? []), entry]);
  const moved = [], kept = [], creates = [], statuses = [];
  const keep = (file, reason, details = {}) => kept.push({ path: file, reason, ...details });
  const folders = new Map();
  for (const file of files) {
    const address = artifactAddress(seen.kinds, file);
    if (malformedArtifactName(address) !== null) { keep(file, "name_invalid"); continue; }
    if (!(await realFolders(seen.root, file, folders))) continue;
    const size = await checkoutSize(seen.root, file);
    if (size === null) continue;
    if (address.kind === "roadmap") { await decideRoadmapView(seen, file, address, size, { moved, keep }); continue; }
    if (size > ARTIFACT_CONTENT_MAX) { keep(file, "too_large", { size }); continue; }
    const bytes = await checkoutBytes(seen.root, file, ARTIFACT_CONTENT_MAX);
    if (bytes === null) continue;
    const text = artifactText(bytes);
    if (text === null) { keep(file, "not_text"); continue; }
    const version = artifactVersion(bytes);
    const location = artifactLocation(own, address);
    const holders = heldAt.get(file) ?? [];
    // The repository's scope, or one of its component scopes, already holding the path is where the file belongs; the workspace scope holding it keeps the file apart.
    const holder = holders.find((entry) => entry.scope.kind === "repository") ?? holders.find((entry) => entry.scope.kind === "component");
    if (holder) {
      const stored = await storedArtifactIn(seen, holder.scope, address);
      if (stored.record?.version !== version) { keep(file, "differs", { location: stored.location }); continue; }
      // A store copy without its status record, as a move interrupted between the two leaves it, gets the written status before the checkout file goes.
      if (hasStatus(address.kind)) statuses.push({ scope: holder.scope, address, written: writtenStatus(text) });
      moved.push({ from: file, to: stored.location, version, size: bytes.length });
      continue;
    }
    if (holders.some((entry) => entry.scope.kind === "workspace")) { keep(file, "workspace_holds", { location: artifactLocation(WORKSPACE_SCOPE, address) }); continue; }
    if (ledger.moved.has(location)) { keep(file, "removed_in_store", { location }); continue; }
    if (location.length > ARTIFACT_LOCATION_MAX) { keep(file, "path_too_long", { location }); continue; }
    creates.push({ file, address, scope: own, location, size: bytes.length });
  }
  // A file that the move would create in another letter case than a path a seen scope holds, or than another file it would create, stays, and so does that other file.
  const storedIndex = pathIndex(held);
  const createIndex = pathIndex(creates.map((item) => ({ kind: item.address.kind, path: item.file })));
  const writes = [];
  for (const item of creates) {
    const other = collidingPath(storedIndex, item.address.kind, item.file) ?? collidingPath(createIndex, item.address.kind, item.file);
    if (other === undefined) writes.push(item);
    else keep(item.file, "name_conflict", { other });
  }
  for (const batch of batches(writes)) {
    for (const item of await createWrites(seen, batch, keep, held)) moved.push({ from: item.file, to: item.location, version: item.version, size: item.size });
  }
  for (const { scope, address, written } of statuses) await recordMovedStatus(seen, scope, address, written);
  const name = await writeLedger(seen, ledger, moved, kept);
  return { moved, kept, ledger: name };
}

// The writes in batches of at most BATCH_FILES files and BATCH_BYTES bytes, by the sizes the decision read.
function* batches(writes) {
  let batch = [], bytes = 0;
  for (const item of writes) {
    if (batch.length && (batch.length >= BATCH_FILES || bytes + item.size > BATCH_BYTES)) { yield batch; batch = []; bytes = 0; }
    batch.push(item);
    bytes += item.size;
  }
  if (batch.length) yield batch;
}

/**
 * Write one batch: each file's bytes are read again, so a file that changed since the decision is checked and written as it is now.
 * The writes go in as one update; when the store refuses it, such as for a folder of another letter case that holds no artifact, each goes alone against the same listing, and a refused one stays in the checkout.
 */
async function createWrites(seen, batch, keep, held) {
  const items = [];
  for (const item of batch) {
    const size = await checkoutSize(seen.root, item.file);
    if (size === null) continue;
    if (size > ARTIFACT_CONTENT_MAX) { keep(item.file, "too_large", { size }); continue; }
    const bytes = await checkoutBytes(seen.root, item.file, ARTIFACT_CONTENT_MAX);
    if (bytes === null) continue;
    const text = artifactText(bytes);
    if (text === null) { keep(item.file, "not_text"); continue; }
    items.push({ ...item, bytes, text, size: bytes.length, version: artifactVersion(bytes), ...(hasStatus(item.address.kind) ? { writtenStatus: writtenStatus(text) } : {}) });
  }
  const done = (list) => list.map(({ bytes, text, ...rest }) => rest);
  try {
    await createMovedArtifacts(seen, items, { held });
    return done(items);
  } catch (error) { if (error?.name !== "ArtifactError") throw error; }
  const created = [];
  for (const item of items) {
    try { await createMovedArtifacts(seen, [item], { held }); created.push(item); }
    catch (error) { if (error?.name !== "ArtifactError") throw error; keepRefused(item, error, keep); }
  }
  return done(created);
}

// A write the store refused keeps its file with the reason closest to the refusal: a letter-case clash, a long location, or other bytes where the file would go.
function keepRefused(item, error, keep) {
  if (error.code === "artifact_name_conflict") keep(item.file, "name_conflict", { other: error.path });
  else if (error.code === "artifact_path_too_long") keep(item.file, "path_too_long", { location: item.location });
  else if (error.code === "invalid_path" && typeof error.location === "string") keep(item.file, "name_conflict", { other: `artifacts/${error.location}` });
  else if (error.code === "artifact_name_invalid") keep(item.file, "name_invalid");
  else if (error.code === "artifact_too_large") keep(item.file, "too_large", { size: item.size });
  else keep(item.file, "differs", { location: item.location });
}

/**
 * The checkout's roadmap view is a view of the roadmap record, which the record move took into the store, so it never moves into a repository's scope:
 * with a valid stored record, the store's view is generated from it, replacing a missing or generated view and never a hand-written one,
 * and the checkout's view goes only when its bytes equal the view the store then holds.
 */
async function decideRoadmapView(seen, file, address, size, { moved, keep }) {
  const recordName = path.posix.basename(roadmapPaths(seen.config).record);
  const record = await checkoutBytes(seen.store.base, "roadmap.json", 64 * 1024 * 1024).catch(() => null);
  const view = roadmapViewOf(record, recordName);
  if (view === null) { keep(file, "no_roadmap_record"); return; }
  const current = await storedArtifactIn(seen, WORKSPACE_SCOPE, address);
  let held = current.record?.bytes ?? null;
  const generated = held === null || held.toString("utf8").includes(generatedNotice(recordName));
  if (generated && (held === null || !held.equals(Buffer.from(view, "utf8")))) {
    await writeMovedView(seen, file, address, WORKSPACE_SCOPE, view, current.record?.version ?? null);
    held = Buffer.from(view, "utf8");
  }
  const bytes = held !== null && size === held.length ? await checkoutBytes(seen.root, file, held.length) : null;
  if (bytes !== null && bytes.equals(held)) moved.push({ from: file, to: current.location, version: artifactVersion(bytes), size: bytes.length });
  else keep(file, "view_differs", { location: current.location });
}

// One ledger file names the repository, each move, and each kept file, written before any checkout file is removed; a move that kept only files that an earlier ledger already kept for the same reason writes none.
async function writeLedger(seen, ledger, moved, kept) {
  if (!moved.length && kept.every((entry) => ledger.kept.has(`${entry.path}\0${entry.reason}`))) return null;
  const at = new Date().toISOString();
  const name = `${at.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.json`;
  const target = await resolveLedgerFile(seen, name);
  await mkdir(path.dirname(target), { recursive: true });
  const entries = { moved: moved.map(({ from, to }) => ({ from, to })), kept: [...kept].sort(byPath) };
  await writeAtomically(target, `${JSON.stringify({ schemaVersion: LEDGER_SCHEMA, repository: seen.repository, migratedAt: at, ...entries }, null, 2)}\n`);
  if (seen.store.sync) scheduleRecordSync(seen.store.base);
  return name;
}

// A checkout file goes only once the store and the ledger hold it, and only while it still holds the bytes the store took; a file that changed meanwhile keeps its new bytes in the checkout, beside the store's copy of the earlier ones.
async function removeMoved(root, { moved, kept }) {
  const done = [], stayed = [];
  for (const move of moved) {
    const size = await checkoutSize(root, move.from);
    // A file already gone left the checkout, and the store holds it.
    if (size === null) { done.push(move); continue; }
    const current = size === move.size ? await checkoutBytes(root, move.from, move.size) : null;
    if (current !== null && artifactVersion(current) === move.version) {
      await rm(path.join(root, ...move.from.split("/")), { force: true });
      done.push(move);
    } else stayed.push({ path: move.from, reason: move.to === artifactLocation(WORKSPACE_SCOPE, { kind: "roadmap", rest: null }) ? "view_differs" : "differs", location: move.to });
  }
  return { moved: done.map(({ from, to }) => ({ from, to })), kept: [...kept, ...stayed].sort(byPath) };
}

// A folder that the move emptied goes, up to the configured folder, which stays.
async function pruneCheckoutFolders(root, kinds, removed) {
  const tops = new Set(kinds.kinds.filter((entry) => entry.folder).map((entry) => entry.path));
  for (const file of removed) {
    for (let folder = path.posix.dirname(file); folder !== "." && folder !== "" && !tops.has(folder); folder = path.posix.dirname(folder)) {
      try { await rmdir(path.join(root, ...folder.split("/"))); }
      catch { break; }
    }
  }
}

/**
 * Each tracked file left in the checkout whose text names a moved file's former path or the configured folder of a kind that lost files, as { file, lines, more },
 * with at most REFERENCE_LINES_MAX line numbers and the number of its other matching lines, at most REFERENCE_FILES_MAX files, with the count of the rest.
 */
async function referencesOf(root, kinds, tracked, movedFiles) {
  const none = { references: [], moreReferences: 0 };
  if (!movedFiles.length) return none;
  const folders = kinds.kinds.filter((entry) => entry.folder && entry.path !== "" && movedFiles.some((file) => artifactAddress(kinds, file)?.kind === entry.kind)).map((entry) => entry.path);
  // A line that names a moved file below a folder that lost files names that folder too, so the folders and the moved files outside them find every such line.
  const needles = [...new Set([...folders, ...movedFiles.filter((file) => !folders.some((folder) => file.startsWith(`${folder}/`)))])];
  const found = [];
  let more = 0;
  const folderCache = new Map();
  for (const file of tracked) {
    if (!(await realFolders(root, file, folderCache))) continue;
    const bytes = await checkoutBytes(root, file, REFERENCE_BYTES_MAX).catch(() => null);
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

// A character that would end or begin a line, or that a terminal reads as a control, in a path the report prints.
const UNSAFE_IN_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ESCAPED_AFTER_JSON = /[\u007f-\u009f\u2028\u2029]/gu;

/** A path as the move's report prints it: as it is, or, when it holds a control character or a line separator, as a JSON string with every such character escaped, so no file name begins or ends a line. */
export function shownPath(value) {
  const text = String(value);
  if (!UNSAFE_IN_LINE.test(text)) return text;
  return JSON.stringify(text).replace(ESCAPED_AFTER_JSON, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The reasons a moved checkout's file stayed, for people: each reason's explanation, given the file's kept entry. */
export function keptExplanation(entry) {
  const where = entry.location ? shownPath(`artifacts/${entry.location}`) : null;
  switch (entry.reason) {
    case "differs": return `the store already holds other bytes at ${where}; a person compares the two and brings what still matters into the store with update_artifact before removing the checkout's copy`;
    case "workspace_holds": return `the workspace scope already holds this path at ${where}; a person brings what still matters into it with update_artifact before removing the checkout's copy`;
    case "removed_in_store": return `it moved into the store at ${where} before and was removed there since, so the store does not take it back; a person decides whether to write it again with update_artifact or to remove the checkout's copy`;
    case "name_invalid": return `its path breaks the artifact name form, so the store does not take it: ${ARTIFACT_NAME_FORM}; rename it to that form, and a later first access moves it`;
    case "name_conflict": return `it differs only in letter case from ${shownPath(entry.other)}, and the two would be one file on a file system that ignores letter case; rename one of them, and a later first access moves it`;
    case "path_too_long": return `its location ${where} would hold ${entry.location.length} characters, above the ${ARTIFACT_LOCATION_MAX} that a location may hold; give it a shorter path, and a later first access moves it`;
    case "too_large": return `it holds ${entry.size} bytes, above the ${ARTIFACT_CONTENT_MAX} bytes (1 MiB) that an artifact may hold, so the store does not take it; keep it in the checkout, or make it smaller and commit it for a later first access to move`;
    case "not_text": return "it is not UTF-8 text, which the artifact tools read and write, so the store does not take it; keep it in the checkout";
    case "view_differs": return `it differs from the roadmap view at ${where} that the store generates from the roadmap record; put content that the roadmap record lacks into the record through update_roadmap before a person removes the file`;
    case "no_roadmap_record": return "the store holds no valid roadmap record to generate the view from; put content that a roadmap record needs into the record through update_roadmap before a person removes the file";
    default: return entry.reason;
  }
}
