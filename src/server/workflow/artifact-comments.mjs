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

// A comment's file name: its time with ":" and "." as "-", then a random suffix, so names sort by time and never collide.
const commentName = (at) => `${at.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.json`;

/**
 * The stored comment that a file's name and bytes hold, or null for a file that is not in the exact form addComment writes:
 * one line of JSON with exactly its keys, location naming the folder that holds it, and every value of the form and size that Prism writes.
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
  if (typeof value.entry !== "string" || !ENTRY_ID.test(value.entry) || !storedTime(value.at)) return null;
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
async function readCommentFile(target) {
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

// Oldest first: by time, then by file name; both times are in the one form whose text order is its time order.
const byText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const oldestFirst = (comments) => comments.sort((left, right) => byText(left.at, right.at) || byText(left.name, right.name));

/**
 * The names of a comment folder's entries, other than folders, read one batch at a time and no further than one past the entries an artifact's comments may hold,
 * as { names, over }, where over says the folder holds more entries than that, so it holds no comment that a reader takes, and names is then empty.
 */
async function boundedNames(target) {
  const names = [];
  let count = 0;
  const folder = await opendir(target, { bufferSize: 128 });
  try {
    for await (const entry of folder) {
      if (++count > COMMENTS_PER_ARTIFACT_MAX) return { names: [], over: true };
      if (entry.isFile() && ARTIFACT_COMMENT_FILE.test(entry.name)) names.push(entry.name);
    }
  } finally { await folder.close().catch(() => {}); }
  return { names, over: false };
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

// A sync can bring any number of comment files, and every open review page reads a file's comments on each poll, so each process keeps what each comment folder held:
// for each file named like a comment, the stamp of its entry and the time and entry id of the comment it holds, or none for a file that holds no comment.
// A listing stands while the folder's own stamp is unchanged, for at most a few seconds, and then each file is checked by its stamp, so only a new or changed file is read again;
// a read of one page of comments then reads only that page's files, and the time order of the rest comes from the listing.
const LISTING_TRUSTED_MS = 5000;
// Attention lists only the newest comments of all folders, each read again before it is shown, so it takes an unchanged folder's listing for longer and checks each file's stamp less often.
const ATTENTION_TRUSTED_MS = 60000;
// A change within this long before a listing may share its stamp with a later one on a file system whose clock is coarse, so such a listing is never reused.
const RACY_MS = 1000;
// The listings kept: never fewer than the comment folders that the last read of Attention took, so its next read finds each folder's listing again.
const LISTINGS_KEPT = 256;
let listingsKept = LISTINGS_KEPT;
// Few stamps at once, so a recheck of a large folder leaves room in the file thread pool for the person's own requests.
const STAMPS_AT_ONCE = 16;
const listings = new Map();
// A read of a folder that another read is already making shares that read, so concurrent pages make one check of a folder rather than one each.
const inFlight = new Map();

// What tells two states of a folder or file apart: its device, inode, size, and change and modification times, in nanoseconds where the platform has them.
const stampOf = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const lstatOrNull = (target) => lstat(target, { bigint: true }).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; });

// What one file of a comment folder holds as a listing keeps it: its stamp, and the comment's at and entry, both null for a file that holds no comment.
async function listedFile(target, name, location, known, now) {
  const info = await lstatOrNull(path.join(target, name));
  if (!info?.isFile()) return null;
  const stamp = stampOf(info);
  if (known?.stamp === stamp && !known.racy) return known;
  const bytes = info.size <= COMMENT_FILE_MAX ? await readCommentFile(path.join(target, name)) : null;
  const comment = bytes ? storedComment(name, bytes, location) : null;
  return { stamp, racy: racy(info, now), at: comment?.at ?? null, entry: comment?.entry ?? null };
}
const racy = (info, now) => now - Number(info.mtimeMs) < RACY_MS || now - Number(info.ctimeMs) < RACY_MS;

/**
 * The comments of one folder, oldest first, as { name, at, entry }, from the listing this process keeps of it; fresh reads every file again.
 * A missing folder, or a link or other entry in its place, holds none.
 */
function commentOrder(target, location, { fresh = false, trustedMs = LISTING_TRUSTED_MS } = {}) {
  const key = `${fresh ? "fresh" : trustedMs}\0${location}\0${target}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const reading = readOrder(target, location, fresh, trustedMs).finally(() => inFlight.delete(key));
  inFlight.set(key, reading);
  return reading;
}

async function readOrder(target, location, fresh, trustedMs) {
  // The folder's stamp is taken before its names are read, so a change during the read leaves a stamp that the next read finds changed.
  const folder = await lstatOrNull(target);
  if (!folder?.isDirectory()) { listings.delete(target); return []; }
  const stamp = stampOf(folder);
  const kept = listings.get(target)?.location === location ? listings.get(target) : null;
  const now = Date.now();
  if (!fresh && kept?.stamp === stamp && !kept.racy && now - kept.checked < trustedMs) return kept.order;
  let listed;
  try { listed = await boundedNames(target); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; }
  // A folder of more entries than an artifact's comments may hold holds no comment that a reader takes, as a damaged file holds none.
  const { names } = listed;
  const files = new Map();
  for (let index = 0; index < names.length; index += STAMPS_AT_ONCE) {
    const batch = names.slice(index, index + STAMPS_AT_ONCE);
    const listed = await Promise.all(batch.map((name) => listedFile(target, name, location, fresh ? null : kept?.files.get(name), now)));
    batch.forEach((name, position) => { if (listed[position]) files.set(name, listed[position]); });
  }
  const order = oldestFirst([...files].filter(([, file]) => file.at !== null).map(([name, file]) => ({ name, at: file.at, entry: file.entry })));
  listings.delete(target);
  listings.set(target, { location, stamp, racy: racy(folder, now), checked: now, files, order });
  while (listings.size > listingsKept) listings.delete(listings.keys().next().value);
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

/**
 * The review app's applied comments on the artifacts that a seen store's checkout sees, given as artifacts [{ path, scope }], each as its history entry, read from the comment's file,
 * with initiative null and artifact { path, scope }, since a comment belongs to no initiative; a comment dated more than a few minutes after the reading clock waits.
 * Only the comment folder of each artifact's own location is read, so a folder at a location that holds no artifact is never listed.
 * latest, when given, keeps only the newest that many comments of all the folders by time and then entry id, the order in which Recent changes lists them,
 * chosen from the folders' listings before any comment file is read, so a read costs the listings, kept between reads, and at most latest file reads.
 */
export async function appliedComments(seen, now = Date.now(), { latest = Infinity, artifacts = [], resolve = (relative) => resolveStatusFile(seen, relative) } = {}) {
  // The listing of every folder this read takes stays kept for the next one, so no read evicts a listing that the same read or the next one needs.
  listingsKept = Math.max(LISTINGS_KEPT, artifacts.length + 64);
  const candidates = [];
  for (const { path: file, scope } of artifacts) {
    const address = artifactAddress(seen.kinds, file);
    if (address === null) continue;
    const location = artifactLocation(scope, address);
    const target = await resolve(`${ARTIFACT_COMMENTS}/${location}`).catch(() => null);
    if (!target) continue;
    for (const item of await commentOrder(target, location, { trustedMs: ATTENTION_TRUSTED_MS })) if (!aheadOfClock(item.at, now)) candidates.push({ item, target, location, file, scope });
  }
  const newest = latest < candidates.length ? candidates.sort((left, right) => byText(left.item.at, right.item.at) || byText(left.item.entry, right.item.entry)).slice(-latest) : candidates;
  const entries = [];
  for (const { item, target, location, file, scope } of newest) {
    const [found] = await readListed(target, location, [item]);
    if (!found) continue;
    const { value } = found;
    entries.push({
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
  }
  return entries;
}
