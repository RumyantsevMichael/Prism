import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readdir } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { ARTIFACT_COMMENTS, artifactAddress, artifactLocation, artifactPathOf, locationArtifact } from "./artifact-paths.mjs";
import { ARTIFACT_COMMENT_FILE, COMMENTS_PER_ARTIFACT_MAX, resolveStatusFile } from "./record-store.mjs";
import { scheduleRecordSync } from "./record-store-sync.mjs";
import { parseStoreJson } from "./store-json.mjs";

// A person's comments on a store artifact: each comment is one file of its own below artifact-comments/<the artifact's location>/,
// so comments that two machines write never change the same file and a store sync brings each one as it is.
// A comment's file also holds the review app's history entry that applied it, since a comment belongs to no initiative's history.
// A store sync brings files that no Prism checked, so a reader takes a file as a comment only in the exact form that addComment writes.

/** The most characters a comment's text holds. */
export const COMMENT_TEXT_MAX = 4000;
// A comment file is small; a larger file someone placed there is left out unread.
const COMMENT_FILE_MAX = 64 * 1024;
// A machine's clock may run a little ahead of the reader's, so Recent changes leaves out only an entry dated further ahead than this.
export const FUTURE_SLACK_MS = 5 * 60 * 1000;

const COMMENT_KEYS = ["location", "version", "line", "text", "author", "at", "entry", "by", "via"];
const VERSION_FORM = /^sha256:[0-9a-f]{64}$/;
const ENTRY_ID = /^[0-9a-f]{32}$/;
const TIME_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const textOf = (value, min, max) => typeof value === "string" && value.length >= min && value.length <= max;

/** Whether a time is in the one form Prism writes, UTC with milliseconds, whose text order is its time order, and names a real moment, as toISOString gives it back. */
export function storedTime(value) {
  if (typeof value !== "string" || !TIME_FORM.test(value)) return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value;
}

/** Whether a history entry's author is of the form the review app's actions write: { name, email, checkout }, with name 1 to 200 characters, email null or at most 200, and checkout 1 to 400. */
export function storedAuthor(by) {
  return hasKeys(by, ["name", "email", "checkout"]) && textOf(by.name, 1, 200) && (by.email === null || textOf(by.email, 0, 200)) && textOf(by.checkout, 1, 400);
}

/** Whether an entry's time lies more than a few minutes after the reading machine's clock, so Recent changes waits for it. */
export const aheadOfClock = (at, now = Date.now()) => Date.parse(at) > now + FUTURE_SLACK_MS;

/** The store-relative folder of an artifact's comments: artifact-comments/<the artifact's location>. */
export const commentsFolder = (scope, address) => path.posix.join(ARTIFACT_COMMENTS, artifactLocation(scope, address));

// A comment's file name: its time with ":" and "." as "-", then "-", a random suffix, and ".json", so names never collide.
// The time part has one width and keeps the time's text order, so the order of comment names is the order by time and then by file name.
const nameTime = (at) => at.replace(/[:.]/g, "-");
const commentName = (at) => `${nameTime(at)}-${randomBytes(4).toString("hex")}.json`;
const NAME_TIME_LENGTH = "YYYY-MM-DDTHH-MM-SS-sssZ".length;
// The time that a comment-named file's name gives, in the form a comment's at takes; a file holds a comment only when its at is this time.
const timeOfName = (name) => `${name.slice(0, 13)}:${name.slice(14, 16)}:${name.slice(17, 19)}.${name.slice(20, NAME_TIME_LENGTH)}`;

/**
 * The stored comment that a file's name and bytes hold, or null for a file that is not in the exact form addComment writes:
 * a name of the comment form whose time part is the comment's at, one line of JSON with exactly its keys, location naming the folder that holds it, and every value of the form and size that Prism writes.
 * A store sync uses the same check, so a merge rewrites location only in a comment that every reader takes.
 */
export function storedComment(name, bytes, location) {
  if (!bytes || bytes.length > COMMENT_FILE_MAX) return null;
  if (!ARTIFACT_COMMENT_FILE.test(name)) return null;
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.replace(/\n$/, "").includes("\n")) return null;
    value = parseStoreJson(text);
  } catch { return null; }
  if (!hasKeys(value, COMMENT_KEYS) || value.location !== location || value.via !== "review-app") return null;
  if (typeof value.version !== "string" || !VERSION_FORM.test(value.version)) return null;
  if (!Number.isSafeInteger(value.line) || value.line < 1) return null;
  if (!textOf(value.text, 1, COMMENT_TEXT_MAX) || value.text.trim() === "") return null;
  if (!hasKeys(value.author, ["name", "host"]) || !textOf(value.author.name, 1, 200) || !textOf(value.author.host, 0, 255)) return null;
  if (!storedAuthor(value.by) || value.by.name !== value.author.name) return null;
  if (typeof value.entry !== "string" || !ENTRY_ID.test(value.entry) || !storedTime(value.at) || !name.startsWith(`${nameTime(value.at)}-`)) return null;
  return value;
}

/**
 * The line and text of a comment file that a store sync saved aside from the comment folder of a location, as { line, text },
 * or null when the file is no comment of the exact form addComment writes, within every bound a reader checks, so a note quotes no other bytes.
 */
export async function savedComment(target, location) {
  const bytes = await readCommentFile(target);
  const value = bytes ? storedComment(path.basename(target), bytes, location) : null;
  return value ? { line: value.line, text: value.text } : null;
}

// A comment as get_artifact and /api/artifact return it.
const shown = (name, value) => ({ id: name.slice(0, -".json".length), version: value.version, line: value.line, text: value.text, author: { name: value.author.name, host: value.author.host }, at: value.at, entry: value.entry });

/**
 * The bytes of a comment file, or null when it is no regular file of at most COMMENT_FILE_MAX bytes: it is opened without following a link and without blocking,
 * and its type and size come from the opened file before any byte is read; where the platform has no O_NOFOLLOW, a check of the entry before the open stands in for it.
 */
export async function readCommentFile(target) {
  if (!constants.O_NOFOLLOW && !(await lstat(target).catch(() => null))?.isFile()) return null;
  let handle;
  try { handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)); }
  catch { return null; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > COMMENT_FILE_MAX) return null;
    // One byte more than the size, so a file that grew after the check is left out rather than read past the bound.
    const buffer = Buffer.alloc(info.size + 1);
    let filled = 0;
    for (let read; filled < buffer.length && (read = (await handle.read(buffer, filled, buffer.length - filled, filled)).bytesRead) > 0;) filled += read;
    return filled > info.size ? null : buffer.subarray(0, filled);
  } catch { return null; }
  finally { await handle.close().catch(() => {}); }
}

/**
 * Every entry of a comment folder that is no folder, as { name, target, comment }, where comment is the stored comment or null for a file that holds none, such as a link or a damaged file.
 * A missing folder holds none.
 */
async function folderEntries(target, location) {
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; }
  const found = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const file = path.join(target, entry.name);
    const bytes = entry.isFile() && ARTIFACT_COMMENT_FILE.test(entry.name) ? await readCommentFile(file) : null;
    found.push({ name: entry.name, target: file, comment: bytes ? storedComment(entry.name, bytes, location) : null });
  }
  return found;
}

const byText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/**
 * The names of a comment folder's regular files named like a comment, read one batch at a time and no further than one past the entries an artifact's comments may hold, in name order.
 * A file holds a comment only when its name's time part is the comment's at, so name order is the order by time and then by file name in which a reader lists comments, known without reading a file.
 * A folder of more entries than an artifact's comments may hold holds no comment that a reader takes, so it lists none.
 */
async function boundedNames(target) {
  const names = [];
  let count = 0;
  const folder = await opendir(target, { bufferSize: 128 });
  try {
    for await (const entry of folder) {
      if (++count > COMMENTS_PER_ARTIFACT_MAX) return [];
      if (entry.isFile() && ARTIFACT_COMMENT_FILE.test(entry.name)) names.push(entry.name);
    }
  } finally { await folder.close().catch(() => {}); }
  return names.sort();
}

/** Whether an artifact's comment folder already holds the entries that an artifact's comments may hold, so no comment is added to it; read no further than that many names. */
async function folderFull(target) {
  let count = 0;
  let folder;
  try { folder = await opendir(target, { bufferSize: 128 }); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
  try {
    for await (const entry of folder) { void entry; if (++count >= COMMENTS_PER_ARTIFACT_MAX) return true; }
  } finally { await folder.close().catch(() => {}); }
  return false;
}

// A sync can bring any number of comment files, and every open review page and Attention read comments on each poll, so each process keeps what each comment folder held:
// its comment names in order, from one bounded listing and no file read, and for each file that a reader needed and read, the stamp of its entry and the time and entry id of the comment it holds,
// or none for a file that holds no comment. A file is read only when a reader needs to know whether it holds a comment: a page of one artifact's comments reads that folder's files,
// and Attention reads the newest names of all folders only until it has the comments it lists.
// A listing's names stand while the folder's own stamp is unchanged, since adding, removing, or renaming an entry changes it; a file's content can change in place, which the folder's stamp does not show,
// so what a file held is taken for at most a few seconds after its stamp was last checked, then checked by its stamp again when a reader next needs it, and only a new or changed file is read again.
const LISTING_TRUSTED_MS = 5000;
// Attention lists only the newest comments of all folders, each read again before it is shown, so it checks each file's stamp less often.
const ATTENTION_TRUSTED_MS = 60000;
// A change within this long before a listing may share its stamp with a later one on a file system whose clock is coarse, so such a listing or file is never taken by its stamp.
const RACY_MS = 1000;
// The listings kept: never fewer than the comment folders that the last read of Attention took, so its next read finds each folder's listing again.
const LISTINGS_KEPT = 256;
let listingsKept = LISTINGS_KEPT;
// Few stamps and reads at once, so a read of a large folder leaves room in the file thread pool for the person's own requests.
const STAMPS_AT_ONCE = 16;
const listings = new Map();
// A read of a folder that another read is already making shares that read, so concurrent pages make one check of a folder rather than one each.
const inFlight = new Map();

// What tells two states of a folder or file apart: its device, inode, size, and change and modification times, in nanoseconds where the platform has them.
const stampOf = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const lstatOrNull = (target) => lstat(target, { bigint: true }).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; });
const racy = (info, now) => now - Number(info.mtimeMs) < RACY_MS || now - Number(info.ctimeMs) < RACY_MS;

/**
 * The listing this process keeps of a comment folder, as { location, stamp, racy, names, files, revision, valid, summary }, taken again once the folder's stamp changed, or always with fresh,
 * where names are its comment names in order, files maps each file read to { stamp, racy, checked, at, entry }, revision counts the changes to files,
 * and valid and summary are what Attention keeps of it, taken again once the listing or its revision changes; null for a missing folder, or a link or other entry in its place, which holds none.
 */
function folderListing(target, location, { fresh = false } = {}) {
  const key = `${fresh ? "fresh" : "kept"}\0${location}\0${target}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const reading = readListing(target, location, fresh).finally(() => inFlight.delete(key));
  inFlight.set(key, reading);
  return reading;
}

async function readListing(target, location, fresh) {
  // The folder's stamp is taken before its names are read, so a change during the read leaves a stamp that the next read finds changed.
  const folder = await lstatOrNull(target);
  if (!folder?.isDirectory()) { listings.delete(target); return null; }
  const stamp = stampOf(folder);
  const kept = listings.get(target)?.location === location ? listings.get(target) : null;
  const now = Date.now();
  let listing = kept;
  if (fresh || !(kept?.stamp === stamp && !kept.racy)) {
    let names;
    try { names = await boundedNames(target); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
    // What the process learned of each file still named stays, checked by the file's stamp when a reader next needs it, since an entry replaced under its name changed the folder.
    const files = new Map();
    if (kept) for (const name of names) if (kept.files.has(name)) files.set(name, { ...kept.files.get(name), checked: -Infinity });
    listing = { location, stamp, racy: racy(folder, now), names, files, revision: 0, valid: null, summary: null };
  }
  listings.delete(target);
  listings.set(target, listing);
  while (listings.size > listingsKept) listings.delete(listings.keys().next().value);
  return listing;
}

const HOLDS_NONE = Object.freeze({ at: null, entry: null });

/**
 * What one named file of a listing holds, as { file, value, read }: file is { at, entry }, both null for a file that holds no comment, value the stored comment when this call read the file,
 * and read whether it was read. A file read before is taken as it was within trustedMs of its last check,
 * and else checked by its stamp and taken while that is unchanged; any other file is read, opened without following a link. fresh reads the file again whatever its stamp.
 */
async function knownFile(listing, target, name, { trustedMs, fresh = false }) {
  const known = listing.files.get(name);
  const now = Date.now();
  if (!fresh && known && !known.racy && now - known.checked < trustedMs) return { file: known, read: false };
  const info = await lstatOrNull(path.join(target, name));
  if (!info?.isFile()) { forget(listing, name); return { file: HOLDS_NONE, read: false }; }
  const stamp = stampOf(info);
  if (!fresh && known?.stamp === stamp && !known.racy) { known.checked = now; return { file: known, read: false }; }
  const read = info.size <= COMMENT_FILE_MAX;
  const bytes = read ? await readCommentFile(path.join(target, name)) : null;
  const value = bytes ? storedComment(name, bytes, listing.location) : null;
  const file = { stamp, racy: racy(info, now), checked: now, at: value?.at ?? null, entry: value?.entry ?? null };
  listing.files.set(name, file);
  listing.revision += 1;
  return { file, value, read };
}

// What a listing knew of one file is dropped, so the file is read again when a reader next needs it.
function forget(listing, name) {
  if (listing.files.delete(name)) listing.revision += 1;
}

/**
 * The comments of one folder, oldest first by time and then by file name, as { name, at, entry }, from the listing this process keeps of it; fresh lists the folder and reads every file again.
 * A missing folder, or a link or other entry in its place, holds none.
 */
function commentOrder(target, location, { fresh = false } = {}) {
  const key = `${fresh ? "fresh" : "kept"}\0${location}\0${target}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const reading = readOrder(target, location, fresh).finally(() => inFlight.delete(key));
  inFlight.set(key, reading);
  return reading;
}

async function readOrder(target, location, fresh) {
  const listing = await folderListing(target, location, { fresh });
  if (!listing) return [];
  const order = [];
  for (let index = 0; index < listing.names.length; index += STAMPS_AT_ONCE) {
    const batch = listing.names.slice(index, index + STAMPS_AT_ONCE);
    const found = await Promise.all(batch.map((name) => knownFile(listing, target, name, { trustedMs: LISTING_TRUSTED_MS, fresh })));
    batch.forEach((name, position) => { const { file } = found[position]; if (file.at !== null) order.push({ name, at: file.at, entry: file.entry }); });
  }
  return order;
}

// The stored comment of one listed file, read again, or null when it no longer holds the comment the listing names, as after a change in place.
async function listedComment(target, location, { name, at, entry }) {
  const bytes = await readCommentFile(path.join(target, name));
  const value = bytes ? storedComment(name, bytes, location) : null;
  return value && value.at === at && value.entry === entry ? value : null;
}

// The stored comments that items of a listing name, read again, as { name, value }, with a change since the listing as null.
const readListed = (target, location, items) => Promise.all(items.map(async (item) => { const value = await listedComment(target, location, item); return value ? { name: item.name, value } : null; }));

// The folder of an artifact's comments, or null when a link at artifact-comments/ or at a folder below it would lead a read elsewhere.
const resolvedFolder = (seen, scope, address) => resolveStatusFile(seen, commentsFolder(scope, address)).catch(() => null);

/** The most comments one read returns, so a sync that brings any number of them puts a bounded amount of text in one result. */
export const COMMENT_PAGE = 20;

/**
 * One page of the comments on an artifact in a scope of a seen store, oldest first, including those a sync brought from other machines:
 * { comments, totalComments, nextCommentOffset }, with at most COMMENT_PAGE comments from the 1-based offset, the number of all of them,
 * and the 1-based position of the first one left out, or null when none is, so reads from 1, each from the last one's nextCommentOffset, give every comment once.
 * The count needs every file of the one folder, at most COMMENTS_PER_ARTIFACT_MAX, each read once and then checked by its stamp.
 */
export async function listComments(seen, scope, address, offset = 1) {
  const target = await resolvedFolder(seen, scope, address);
  if (!target) return { comments: [], totalComments: 0, nextCommentOffset: null };
  const location = artifactLocation(scope, address);
  // A file of the page that changed since the listing, in place where the folder's stamp shows nothing, makes one more read from a listing of every file.
  for (let attempt = 1; ; attempt += 1) {
    const all = await commentOrder(target, location, { fresh: attempt > 1 });
    const start = Math.min(offset, all.length + 1) - 1;
    const page = all.slice(start, start + COMMENT_PAGE);
    const read = await readListed(target, location, page);
    if (attempt > 1 || read.every(Boolean)) {
      const comments = read.filter(Boolean).map(({ name, value }) => shown(name, value));
      const next = start + page.length;
      return { comments, totalComments: all.length, nextCommentOffset: next < all.length ? next + 1 : null };
    }
  }
}

/**
 * What an artifact's comment folder holds, for an update that moves or removes the artifact, or creates one at its location, while the caller holds the store's artifact lock:
 * { location, entries }, with entries every file, link, or other entry of the folder that is no folder, as { name, target, comment },
 * and comment the stored comment that a move carries, or null. A folder behind a link holds nothing that Prism reads or removes.
 */
export async function commentFolderOf(seen, scope, address) {
  const location = artifactLocation(scope, address);
  const target = await resolvedFolder(seen, scope, address);
  return { location, target, entries: target ? await folderEntries(target, location) : [] };
}

/** The file that a comment takes in the comment folder of another location, with location naming it and every other key as it was: { target, bytes }. */
export async function movedComment(seen, scope, address, { name, comment }) {
  const target = await resolveStatusFile(seen, `${commentsFolder(scope, address)}/${name}`);
  return { target, bytes: Buffer.from(`${JSON.stringify({ ...comment, location: artifactLocation(scope, address) })}\n`, "utf8") };
}

/**
 * Store one comment on an artifact in a scope of a seen store, while the caller holds the store's artifact lock: { version, line, text, author, entry },
 * where author is { name, host } and entry the review app's history entry that applies it, whose id, time, author, and source the file keeps.
 * Returns the comment as a reader gets it.
 */
export async function addComment(seen, scope, address, { version, line, text, author, entry }) {
  const folder = await resolveStatusFile(seen, commentsFolder(scope, address));
  // An artifact holds at most COMMENTS_PER_ARTIFACT_MAX comments, past which no reader takes any, so a comment on a full folder is refused and stores nothing.
  if (await folderFull(folder)) throw Object.assign(new Error(`This file already holds the ${COMMENTS_PER_ARTIFACT_MAX} comments that a file may hold, so the comment was not stored.`), { code: "comment_limit" });
  const name = commentName(entry.at);
  const target = await resolveStatusFile(seen, `${commentsFolder(scope, address)}/${name}`);
  const comment = { location: artifactLocation(scope, address), version, line, text, author: { name: author.name, host: String(author.host ?? "").slice(0, 255) }, at: entry.at, entry: entry.id, by: entry.by, via: entry.via };
  const bytes = Buffer.from(`${JSON.stringify(comment)}\n`, "utf8");
  // A comment that no reader would take is refused before it is written, so no stored comment goes unseen.
  if (!storedComment(name, bytes, comment.location)) throw Object.assign(new Error("The comment is not of the form that every reader takes, so it was not stored."), { code: "invalid_comment" });
  await mkdir(folder, { recursive: true });
  await writeAtomically(target, bytes);
  if (seen.store.sync) scheduleRecordSync(seen.store.base);
  return shown(name, comment);
}

// One read of Attention reads at most this many comment files per comment it lists whose content this process does not know yet, and checks the stamps of at most this many more that it read before,
// so files that a sync brought under newer names than every comment, holding none, cost a bounded amount of work per poll, and each later read goes on past what the earlier ones learned.
const READS_PER_LISTED = 4;
const STAMPS_PER_LISTED = 50;

// What Attention's reads walked: names that folder summaries took, and items that merges took, so a test shows that a poll's work does not grow with names it never lists.
const work = { walked: 0, merged: 0 };
/** The names that Attention's folder summaries walked and the items its merges took in this process so far, as { walked, merged }. */
export const attentionWork = () => ({ ...work });

// A listing's comment names whose time is a real moment, in name order, taken once for each listing, so a name of an invalid time is dropped once rather than walked on each poll.
const validNames = (listing) => listing.valid ??= listing.names.filter((name) => storedTime(timeOfName(name)));

// The number of valid names, in name order, whose time is no more than FUTURE_SLACK_MS after now: name order is time order, so the names ahead of the clock are a suffix that a binary search finds.
function eligibleCount(valid, now) {
  const limit = nameTime(new Date(now + FUTURE_SLACK_MS).toISOString());
  let low = 0, high = valid.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (valid[middle].slice(0, NAME_TIME_LENGTH) <= limit) low = middle + 1;
    else high = middle;
  }
  return low;
}

// The order in which Recent changes lists comments: newer time first, then the greater entry id; a name whose file is not known yet comes before every known comment of its time, since it may hold any entry,
// and names not known yet of one time go by name, so a read of them takes the folders in turn where their names are alike.
function newer(left, right) {
  if (left.at !== right.at) return left.at > right.at;
  if (Boolean(left.unknown) !== Boolean(right.unknown)) return Boolean(left.unknown);
  return left.unknown ? left.name > right.name : left.entry > right.entry;
}

/**
 * What Attention keeps of one folder for the first end valid names, the ones not ahead of the clock, and latest, as { revision, end, latest, top, unknown, low, checkedAt, stamping },
 * taken again only once the listing, its revision, end, or latest changes. top lists newest first by the order of newer the folder's own newest latest known comments, as { name, at, entry },
 * and unknown the positions among the valid names, newest first, of each name above the time of the last of them whose file this process does not know, or read while it changed.
 * A comment that the latest known ones leave out is listed by no read, since the folder alone holds latest that come before it, whatever its unknown names hold.
 * low is the first valid name the walk took, checkedAt the oldest stamp check of the known files from low to end, and stamping where a check of their stamps stopped, or null.
 */
function folderSummary(listing, end, latest) {
  const kept = listing.summary;
  if (kept && kept.revision === listing.revision && kept.end === end && kept.latest === latest) return { summary: kept, walked: false };
  const valid = validNames(listing);
  const known = [], unknown = [];
  const entries = new Set();
  let boundary = null, low = end, checkedAt = Infinity;
  for (let index = end - 1; index >= 0; index -= 1) {
    const name = valid[index];
    const at = timeOfName(name);
    // Once the folder holds latest known comments, it walks on only through the names that share the last one's time, whose order is by entry id.
    if (boundary !== null && at < boundary) break;
    low = index;
    work.walked += 1;
    const file = listing.files.get(name);
    if (!file || file.racy) { unknown.push(index); continue; }
    checkedAt = Math.min(checkedAt, file.checked);
    if (file.at === null) continue;
    known.push({ name, at: file.at, entry: file.entry });
    entries.add(file.entry);
    if (boundary === null && entries.size >= latest) boundary = file.at;
  }
  // A sort is stable, so of two files that hold one entry, the newer name stays.
  known.sort((left, right) => byText(right.at, left.at) || byText(right.entry, left.entry));
  const top = [];
  const taken = new Set();
  for (const item of known) {
    if (top.length >= latest) break;
    if (!taken.has(item.entry)) { taken.add(item.entry); top.push(item); }
  }
  listing.summary = { revision: listing.revision, end, latest, top, unknown, low, checkedAt, stamping: null };
  return { summary: listing.summary, walked: true };
}

// A place in a list of items in the order of newer: item is the next one, or null past the last, and next() moves on to the one after it.
function listCursor(items) {
  let at = 0;
  return { item: items[0] ?? null, next() { at += 1; this.item = items[at] ?? null; } };
}

// A place in a folder's summary: its known comments and its names to read merged newest first, each name's item made only when the merge reaches it.
function summaryCursor(listing, summary) {
  const valid = validNames(listing);
  const { top, unknown } = summary;
  const nameAt = (position) => { const name = valid[unknown[position]]; return { name, at: timeOfName(name), unknown: true }; };
  let known = 0, named = 0, pending = unknown.length ? nameAt(0) : null;
  const cursor = {
    item: null,
    next() {
      const comment = known < top.length ? top[known] : null;
      if (pending && (!comment || newer(pending, comment))) {
        cursor.item = pending;
        named += 1;
        pending = named < unknown.length ? nameAt(named) : null;
      } else if (comment) { cursor.item = comment; known += 1; }
      else cursor.item = null;
    }
  };
  cursor.next();
  return cursor;
}

/**
 * Check the stamps of the known files that a folder's summary took, from where the last check stopped, at most budget of them, and return how many it checked.
 * A file whose stamp changed, or that is no regular file now, is no longer known, so the next summary lists it as a name to read; once every one is checked, checkedAt moves to when the pass began.
 */
async function restamp(listing, target, summary, budget, now) {
  const valid = validNames(listing);
  if (summary.stamping === null) summary.stamping = { next: summary.end - 1, began: now };
  let used = 0;
  while (summary.stamping.next >= summary.low && used < budget) {
    const batch = [];
    while (summary.stamping.next >= summary.low && batch.length < STAMPS_AT_ONCE && used + batch.length < budget) {
      const name = valid[summary.stamping.next--];
      // A file checked within the trusted time, as by a page's read or an earlier pass, needs no check yet.
      const known = listing.files.get(name);
      if (known && now - known.checked > ATTENTION_TRUSTED_MS) batch.push(name);
    }
    used += batch.length;
    await Promise.all(batch.map(async (name) => {
      const known = listing.files.get(name);
      const info = await lstatOrNull(path.join(target, name));
      if (!known || !info?.isFile() || stampOf(info) !== known.stamp) forget(listing, name);
      else known.checked = Date.now();
    }));
  }
  if (summary.stamping.next < summary.low) { summary.checkedAt = summary.stamping.began; summary.stamping = null; }
  return used;
}

/**
 * Sources merged newest first, each { cursor } over items in the order of newer, as a heap of the sources by the item each lists next, the newest on top;
 * sources whose next items tie go in the order they were added, so each read takes one order. pop() gives { source, item } and moves that source on to its next item.
 */
function mergedNewestFirst() {
  const heap = [];
  let added = 0;
  const itemOf = (entry) => entry.source.cursor.item;
  const before = (left, right) => newer(itemOf(left), itemOf(right)) || (!newer(itemOf(right), itemOf(left)) && left.order < right.order);
  const swap = (left, right) => { [heap[left], heap[right]] = [heap[right], heap[left]]; };
  const up = (index) => {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(heap[index], heap[parent])) return;
      swap(index, parent);
      index = parent;
    }
  };
  const down = (index) => {
    for (;;) {
      let top = index;
      for (const child of [2 * index + 1, 2 * index + 2]) if (child < heap.length && before(heap[child], heap[top])) top = child;
      if (top === index) return;
      swap(index, top);
      index = top;
    }
  };
  return {
    get size() { return heap.length; },
    add(source) { if (source.cursor.item) { heap.push({ source, order: added++ }); up(heap.length - 1); } },
    peek: () => itemOf(heap[0]),
    pop() {
      const entry = heap[0];
      const item = itemOf(entry);
      work.merged += 1;
      entry.source.cursor.next();
      if (!entry.source.cursor.item) { const last = heap.pop(); if (heap.length) heap[0] = last; }
      if (heap.length) down(0);
      return { source: entry.source, item };
    }
  };
}

// A comment's history entry as Recent changes lists it, with initiative null and artifact { path, scope }, since a comment belongs to no initiative.
const commentEntry = (value, file, scope) => ({
  id: value.entry,
  action: "artifact.comment",
  target: `artifact:${scope.label}:${file}`,
  before: null,
  after: { version: value.version, line: value.line, text: value.text },
  at: value.at,
  by: value.by,
  via: value.via,
  initiative: null,
  artifact: { path: file, scope }
});

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The review app's applied comments on the artifacts that a seen store's checkout sees, given as artifacts [{ path, scope }], each as its history entry, read from the comment's file,
 * with initiative null and artifact { path, scope }, since a comment belongs to no initiative; a comment dated more than a few minutes after the reading clock waits.
 * Only the comment folder of each artifact's own location is read, so a folder at a location that holds no artifact is never listed.
 * latest, when given, keeps only the newest that many comments of all the folders by time and then entry id, the order in which Recent changes lists them.
 * A comment's time is its file name's, so each folder's kept listing gives that order up to entry id without a file read, and its kept summary gives the folder's own newest latest known comments,
 * with ties at one time settled within the folder, and the names it still has to read; the summary is taken again only once the folder, a file of it, or the clock's place among its names changes.
 * The read merges those summaries newest first, reads each name it does not know as it reaches it, at most READS_PER_LISTED files per listed comment, until it has latest comments,
 * or, once that budget ends, lists after the comments it has the newest known ones, and reads again each one it lists before it lists it, so an honest store costs about latest file reads, a poll's work does not grow with names ahead of the clock, of an invalid time, or tied at one time,
 * and each later read goes on past what the earlier ones learned. It yields to the event loop between folders whose summary it takes again, so no poll holds the event loop long.
 */
export async function appliedComments(seen, now = Date.now(), { latest = Infinity, artifacts = [], resolve = (relative) => resolveStatusFile(seen, relative) } = {}) {
  // The listing of every folder this read takes stays kept for the next one, so no read evicts a listing that the same read or the next one needs.
  listingsKept = Math.max(LISTINGS_KEPT, artifacts.length + 64);
  const bounded = Number.isFinite(latest);
  let reads = bounded ? Math.max(1, latest) * READS_PER_LISTED : Infinity;
  let stamps = bounded ? Math.max(1, latest) * STAMPS_PER_LISTED : Infinity;
  const queue = mergedNewestFirst();
  const tops = [];
  for (const { path: file, scope } of artifacts) {
    const address = artifactAddress(seen.kinds, file);
    if (address === null) continue;
    const location = artifactLocation(scope, address);
    const target = await resolve(`${ARTIFACT_COMMENTS}/${location}`).catch(() => null);
    if (!target) continue;
    const listing = await folderListing(target, location);
    if (!listing?.names.length) continue;
    const end = eligibleCount(validNames(listing), now);
    let { summary, walked } = folderSummary(listing, end, latest);
    // A known file is taken as it was for a while after its stamp was last checked, then checked again by its stamp within the poll's budget.
    if (stamps > 0 && now - summary.checkedAt > ATTENTION_TRUSTED_MS) {
      stamps -= await restamp(listing, target, summary, stamps, now);
      ({ summary, walked } = folderSummary(listing, end, latest));
    }
    queue.add({ listing, target, file, scope, cursor: summaryCursor(listing, summary) });
    tops.push({ listing, target, file, scope, top: summary.top });
    if (walked) await yieldTurn();
  }
  const found = [];
  const ids = new Set();
  const learned = [];
  const take = ({ source, item }) => { if (!ids.has(item.entry)) { ids.add(item.entry); found.push({ source, ...item }); } };
  while (queue.size && found.length < latest) {
    if (!queue.peek().unknown) {
      take(queue.pop());
      continue;
    }
    // A name this process does not know is read when the merge reaches it, and the reads end where their budget does, so the next read goes on from what this one learned.
    // Every comment found so far comes before that name, so the read then lists after them the newest known comments that come after it, and a later read puts any comment the name holds in its place.
    if (reads <= 0) {
      const rest = mergedNewestFirst();
      for (const { top, ...source } of tops) rest.add({ ...source, cursor: listCursor(top) });
      for (const { item, ...source } of learned) rest.add({ ...source, cursor: listCursor([item]) });
      while (rest.size && found.length < latest) take(rest.pop());
      break;
    }
    const batch = [];
    const room = Math.min(STAMPS_AT_ONCE, reads, Math.max(1, latest - found.length));
    while (queue.size && batch.length < room && queue.peek().unknown) batch.push(queue.pop());
    const known = await Promise.all(batch.map(({ source, item }) => knownFile(source.listing, source.target, item.name, { trustedMs: ATTENTION_TRUSTED_MS })));
    for (const [index, { source, item }] of batch.entries()) {
      const { file, value, read } = known[index];
      if (read) reads -= 1;
      // A file that holds a comment joins the merge at its place in the order, as its folder's next summary lists it.
      if (file.at === null) continue;
      const joined = { name: item.name, at: file.at, entry: file.entry, value };
      queue.add({ ...source, cursor: listCursor([joined]) });
      learned.push({ ...source, item: joined });
    }
  }
  const entries = [];
  for (let index = 0; index < found.length; index += STAMPS_AT_ONCE) {
    const batch = found.slice(index, index + STAMPS_AT_ONCE);
    // A file read by this read is listed as read; any other one is read again, and one that no longer holds the comment its listing names, as after a change in place, is read anew next time.
    const values = await Promise.all(batch.map(async (item) => {
      if (item.value) return item.value;
      const value = await listedComment(item.source.target, item.source.listing.location, item);
      if (!value) forget(item.source.listing, item.name);
      return value;
    }));
    for (const [position, value] of values.entries()) if (value) entries.push(commentEntry(value, batch[position].source.file, batch[position].source.scope));
  }
  return entries;
}

/**
 * The applied comment that one stored comment's file holds, named by the comment's id, as Recent changes in this checkout lists it for the artifact { path, scope } at address,
 * or null when the file holds no comment of that entry, the comment is dated more than a few minutes after the clock, or its folder holds more entries than an artifact's comments may.
 * It reads that one file and the folder's kept listing, so an applied comment reaches another checkout's tabs at the cost of one entry, whatever the store's other folders hold.
 */
export async function appliedComment(seen, { path: file, scope }, address, { comment, id }, now = Date.now()) {
  const name = `${comment}.json`;
  if (!ARTIFACT_COMMENT_FILE.test(name)) return null;
  const target = await resolvedFolder(seen, scope, address);
  if (!target) return null;
  const listing = await folderListing(target, artifactLocation(scope, address));
  if (!listing?.names.includes(name)) return null;
  const { value } = await knownFile(listing, target, name, { trustedMs: 0, fresh: true });
  return value && value.entry === id && !aheadOfClock(value.at, now) ? commentEntry(value, file, scope) : null;
}
