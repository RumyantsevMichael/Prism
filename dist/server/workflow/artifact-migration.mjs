import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeAtomically } from "./artifact-store.mjs";
import { ARTIFACT_MIGRATIONS, ARTIFACT_NAME_FORM, artifactAddress, artifactLocation, collideInLetterCase, malformedArtifactName, repositoryScope, WORKSPACE_SCOPE } from "./artifact-paths.mjs";
import { hasStatus, writtenStatus } from "./artifact-status.mjs";
import { resolveLedgerFile, withArtifactStoreLock } from "./record-store.mjs";
import { scheduleRecordSync } from "./record-store-sync.mjs";
import { roadmapViewOf } from "./roadmap.mjs";
import { generatedNotice } from "./projection.mjs";
import { ARTIFACT_LOCATION_MAX, artifactVersion, createMovedArtifacts, seenArtifacts, storedArtifactIn, writeMovedView } from "./store-artifacts.mjs";
import { roadmapPaths } from "./workflow-config.mjs";

// On a checkout's first access to its store, its existing descriptive artifacts move into its repository's scope once, and every file the move cannot take stays where it is.
// The move writes the store first and removes a checkout file only once the store holds its bytes, so an interruption leaves a file in both places rather than in neither.
const REFERENCE_FILES_MAX = 200;
const REFERENCE_BYTES_MAX = 4 * 1024 * 1024;
const LEDGER_SCHEMA = 1;
const run = promisify(execFile);

const posix = (...parts) => parts.filter((part) => part !== "").join("/");

// Whether each folder from the checkout's root down to a configured path is a real folder, never a symbolic link, so the move never reads through one.
async function realFolder(root, relative) {
  let current = root;
  for (const name of relative === "" ? [] : relative.split("/")) {
    current = path.join(current, name);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
    if (!info.isDirectory()) return false;
  }
  return true;
}

// Every regular file below a configured folder, or the configured file itself, as project-relative paths, without following a symbolic link or entering Git's folder.
async function checkoutFiles(root, kinds) {
  const found = new Map();
  const add = (file, kind) => {
    const address = artifactAddress(kinds, file);
    // The longest configured path decides a file's kind, so a file that a nested configured path holds is that kind's alone.
    if (address && address.kind === kind && address.rest !== "") found.set(file, address);
  };
  const visit = async (relative, kind) => {
    let entries;
    try { entries = await readdir(path.join(root, ...relative.split("/")), { withFileTypes: true }); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return; throw error; }
    for (const entry of entries) {
      // Git's folder, and the checkout's own .prism folder, which holds its configuration and the records the record move decides, are never artifacts.
      if (entry.name === ".git" || (relative === "" && entry.name === ".prism")) continue;
      const child = posix(relative, entry.name);
      if (entry.isDirectory()) await visit(child, kind);
      else if (entry.isFile()) add(child, kind);
    }
  };
  for (const entry of kinds.kinds) {
    if (entry.folder) {
      if (await realFolder(root, entry.path)) await visit(entry.path, entry.kind);
      continue;
    }
    if (!(await realFolder(root, path.posix.dirname(entry.path) === "." ? "" : path.posix.dirname(entry.path)))) continue;
    const info = await lstat(path.join(root, ...entry.path.split("/"))).catch(() => null);
    if (info?.isFile()) add(entry.path, entry.kind);
  }
  return [...found].map(([file, address]) => ({ file, address })).sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
}

// The bytes of a checkout file, read without following a symbolic link, or null when it is gone or is no regular file.
async function checkoutBytes(root, file) {
  let handle;
  try { handle = await open(path.join(root, ...file.split("/")), constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)); }
  catch (error) { if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return null; throw error; }
  try {
    if (!(await handle.stat()).isFile()) return null;
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
    try { entry = JSON.parse((await checkoutBytes(folder, name))?.toString("utf8") ?? "null"); }
    catch { continue; }
    if (entry?.repository !== seen.repository) continue;
    for (const move of Array.isArray(entry.moved) ? entry.moved : []) if (typeof move?.to === "string") ledger.moved.add(move.to);
    for (const kept of Array.isArray(entry.kept) ? entry.kept : []) if (typeof kept?.path === "string") ledger.kept.add(`${kept.path}\0${kept.reason}`);
  }
  return ledger;
}

/**
 * Move a checkout's files under its artifact paths into its repository's scope, given the scopes it sees.
 * recordSources holds the record files that the record move takes, and frozenTests the frozen tests of accepted designs; both stay in the checkout, and the roadmap view is decided apart.
 * Returns null when the checkout holds no such file, else { repository, store, moved, kept, references, moreReferences }:
 * moved lists { from, to } from checkout path to location below artifacts/, and kept lists { path, reason, location?, other? }.
 */
export async function migrateArtifacts(seen, { recordSources = new Set(), frozenTests = new Set() } = {}) {
  const { root, kinds } = seen;
  const files = (await checkoutFiles(root, kinds)).filter(({ file }) => !recordSources.has(file) && !frozenTests.has(file));
  if (!files.length) return null;
  const outcome = await withArtifactStoreLock(seen, () => moveFiles(seen, files));
  await pruneCheckoutFolders(root, kinds, outcome.moved.map((move) => move.from));
  const { references, moreReferences } = await referencesOf(root, kinds, outcome.moved.map((move) => move.from));
  return { repository: seen.repository, store: seen.store.base, moved: outcome.moved, kept: outcome.kept, references, moreReferences };
}

async function moveFiles(seen, files) {
  const own = repositoryScope(seen.repository);
  const ledger = await readLedgers(seen);
  const held = await seenArtifacts(seen);
  const moved = [], kept = [], removals = [];
  const creates = [];
  const keep = (file, reason, details = {}) => kept.push({ path: file, reason, ...details });
  for (const { file, address } of files) {
    if (malformedArtifactName(address) !== null) { keep(file, "name_invalid"); continue; }
    const bytes = await checkoutBytes(seen.root, file);
    if (bytes === null) continue;
    if (address.kind === "roadmap") { await decideRoadmapView(seen, file, address, bytes, { moved, kept: keep, removals }); continue; }
    const location = artifactLocation(own, address);
    const holders = held.filter((entry) => entry.path === file);
    // The repository's scope, or one of its component scopes, already holding the path is where the file belongs; the workspace scope holding it keeps the file apart.
    const holder = holders.find((entry) => entry.scope.kind === "repository") ?? holders.find((entry) => entry.scope.kind === "component");
    if (holder) {
      const stored = await storedArtifactIn(seen, holder.scope, address);
      if (stored.record?.version === artifactVersion(bytes)) { moved.push({ from: file, to: stored.location }); removals.push({ file, bytes }); }
      else keep(file, "differs", { location: stored.location });
      continue;
    }
    const workspace = holders.find((entry) => entry.scope.kind === "workspace");
    if (workspace) { keep(file, "workspace_holds", { location: artifactLocation(WORKSPACE_SCOPE, address) }); continue; }
    if (ledger.moved.has(location)) { keep(file, "removed_in_store", { location }); continue; }
    if (location.length > ARTIFACT_LOCATION_MAX) { keep(file, "path_too_long", { location }); continue; }
    creates.push({ file, address, scope: own, bytes, location });
  }
  // A file that the move would create in another letter case than a path a seen scope holds, or than another file it would create, stays, and so does that other file.
  const colliding = new Map();
  for (const item of creates) {
    const other = held.find((entry) => entry.kind === item.address.kind && collideInLetterCase(item.file, entry.path))?.path
      ?? creates.find((candidate) => candidate !== item && candidate.address.kind === item.address.kind && collideInLetterCase(item.file, candidate.file))?.file;
    if (other !== undefined) colliding.set(item, other);
  }
  for (const [item, other] of colliding) keep(item.file, "name_conflict", { other });
  const writes = creates.filter((item) => !colliding.has(item));
  for (const item of await createWrites(seen, writes, keep)) { moved.push({ from: item.file, to: item.location }); removals.push(item); }
  // A checkout file goes only once the store holds its bytes, and only while it still holds the bytes the store took.
  const removed = new Set();
  for (const { file, bytes } of removals) {
    const current = await checkoutBytes(seen.root, file);
    if (current === null || current.equals(bytes)) { await rm(path.join(seen.root, ...file.split("/")), { force: true }); removed.add(file); }
  }
  const stayed = moved.filter((move) => !removed.has(move.from));
  // A file that changed while it moved keeps its new bytes in the checkout, beside the store's copy of the earlier ones.
  for (const move of stayed) keep(move.from, move.to === artifactLocation(WORKSPACE_SCOPE, { kind: "roadmap", rest: null }) ? "view_differs" : "differs", { location: move.to });
  const done = moved.filter((move) => removed.has(move.from));
  await writeLedger(seen, ledger, done, kept);
  return { moved: done, kept: kept.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) };
}

// The writes go in as one update; when the store refuses one, such as a folder of another letter case that holds no artifact, each goes alone and a refused one stays in the checkout.
async function createWrites(seen, writes, keep) {
  const status = (item) => hasStatus(item.address.kind) ? { writtenStatus: writtenStatus(item.bytes.toString("utf8")) } : {};
  try {
    await createMovedArtifacts(seen, writes.map((item) => ({ ...item, ...status(item) })));
    return writes;
  } catch (error) { if (error?.name !== "ArtifactError") throw error; }
  const created = [];
  for (const item of writes) {
    try { await createMovedArtifacts(seen, [{ ...item, ...status(item) }]); created.push(item); }
    catch (error) { if (error?.name !== "ArtifactError") throw error; keepRefused(item, error, keep); }
  }
  return created;
}

// A write the store refused keeps its file with the reason closest to the refusal: a letter-case clash, a long location, or other bytes where the file would go.
function keepRefused(item, error, keep) {
  if (error.code === "artifact_name_conflict") keep(item.file, "name_conflict", { other: error.path });
  else if (error.code === "artifact_path_too_long") keep(item.file, "path_too_long", { location: item.location });
  else if (error.code === "invalid_path" && typeof error.location === "string") keep(item.file, "name_conflict", { other: `artifacts/${error.location}` });
  else if (error.code === "artifact_name_invalid") keep(item.file, "name_invalid");
  else keep(item.file, "differs", { location: item.location });
}

/**
 * The checkout's roadmap view is a view of the roadmap record, which the record move took into the store, so it never moves into a repository's scope:
 * with a valid stored record, the store's view is generated from it, replacing a missing or generated view and never a hand-written one,
 * and the checkout's view goes only when its bytes equal the view the store then holds.
 */
async function decideRoadmapView(seen, file, address, bytes, { moved, kept: keep, removals }) {
  const recordName = path.posix.basename(roadmapPaths(seen.config).record);
  const record = await checkoutBytes(seen.store.base, "roadmap.json").catch(() => null);
  const view = roadmapViewOf(record, recordName);
  if (view === null) { keep(file, "no_roadmap_record"); return; }
  const current = await storedArtifactIn(seen, WORKSPACE_SCOPE, address);
  let held = current.record?.bytes ?? null;
  const generated = held === null || held.toString("utf8").includes(generatedNotice(recordName));
  if (generated && (held === null || !held.equals(Buffer.from(view, "utf8")))) {
    await writeMovedView(seen, file, address, WORKSPACE_SCOPE, view, current.record?.version ?? null);
    held = Buffer.from(view, "utf8");
  }
  if (held !== null && held.equals(bytes)) { moved.push({ from: file, to: current.location }); removals.push({ file, bytes }); }
  else keep(file, "view_differs", { location: current.location });
}

// One ledger file names the repository, each move, and each kept file; a move that kept only files that an earlier ledger already kept for the same reason writes none.
async function writeLedger(seen, ledger, moved, kept) {
  if (!moved.length && kept.every((entry) => ledger.kept.has(`${entry.path}\0${entry.reason}`))) return;
  const at = new Date().toISOString();
  const target = await resolveLedgerFile(seen, `${at.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.json`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomically(target, `${JSON.stringify({ schemaVersion: LEDGER_SCHEMA, repository: seen.repository, migratedAt: at, moved, kept }, null, 2)}\n`);
  if (seen.store.sync) scheduleRecordSync(seen.store.base);
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
 * Each tracked file left in the checkout whose text names a moved file's former path or the configured folder of a kind that lost files, as <file>:<line>,<line>,
 * at most REFERENCE_FILES_MAX of them, with the count of the rest.
 */
async function referencesOf(root, kinds, movedFiles) {
  const none = { references: [], moreReferences: 0 };
  if (!movedFiles.length) return none;
  const folders = kinds.kinds.filter((entry) => entry.folder && entry.path !== "" && movedFiles.some((file) => artifactAddress(kinds, file)?.kind === entry.kind)).map((entry) => entry.path);
  const needles = [...new Set([...movedFiles, ...folders])];
  let tracked;
  try { tracked = (await run("git", ["-C", root, "ls-files", "-z"], { maxBuffer: 256 * 1024 * 1024 })).stdout.split("\0").filter(Boolean).sort(); }
  catch { return none; }
  const found = [];
  for (const file of tracked) {
    const info = await lstat(path.join(root, ...file.split("/"))).catch(() => null);
    if (!info?.isFile() || info.size > REFERENCE_BYTES_MAX) continue;
    const bytes = await checkoutBytes(root, file).catch(() => null);
    if (bytes === null || bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").split("\n");
    const numbers = lines.flatMap((line, index) => needles.some((needle) => line.includes(needle)) ? [index + 1] : []);
    if (numbers.length) found.push(`${file}:${numbers.join(",")}`);
  }
  return { references: found.slice(0, REFERENCE_FILES_MAX), moreReferences: Math.max(0, found.length - REFERENCE_FILES_MAX) };
}

/** The reasons a moved checkout's file stayed, for people: each reason's explanation, given the file's kept entry. */
export function keptExplanation(entry) {
  const where = entry.location ? `artifacts/${entry.location}` : null;
  switch (entry.reason) {
    case "differs": return `the store already holds other bytes at ${where}; a person compares the two and brings what still matters into the store with update_artifact before removing the checkout's copy`;
    case "workspace_holds": return `the workspace scope already holds this path at ${where}; a person brings what still matters into it with update_artifact before removing the checkout's copy`;
    case "removed_in_store": return `it moved into the store at ${where} before and was removed there since, so the store does not take it back; a person decides whether to write it again with update_artifact or to remove the checkout's copy`;
    case "name_invalid": return `its path breaks the artifact name form, so the store does not take it: ${ARTIFACT_NAME_FORM}; rename it to that form, and a later first access moves it`;
    case "name_conflict": return `it differs only in letter case from ${entry.other}, and the two would be one file on a file system that ignores letter case; rename one of them, and a later first access moves it`;
    case "path_too_long": return `its location ${where} would hold ${entry.location.length} characters, above the ${ARTIFACT_LOCATION_MAX} that a location may hold; give it a shorter path, and a later first access moves it`;
    case "view_differs": return `it differs from the roadmap view at ${where} that the store generates from the roadmap record; put content that the roadmap record lacks into the record through update_roadmap before a person removes the file`;
    case "no_roadmap_record": return "the store holds no valid roadmap record to generate the view from; put content that a roadmap record needs into the record through update_roadmap before a person removes the file";
    default: return entry.reason;
  }
}
