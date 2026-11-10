import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { ARTIFACT_COMMENTS, artifactAddress, artifactLocation, artifactPathOf, locationArtifact } from "./artifact-paths.mjs";
import { ARTIFACT_COMMENT_FILE, resolveStatusFile } from "./record-store.mjs";
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

// The stored comments of one folder, as { name, value }.
const folderComments = async (target, location) => (await folderEntries(target, location)).filter((entry) => entry.comment).map(({ name, comment }) => ({ name, value: comment }));

// Oldest first: by time, then by file name; both times are in the one form whose text order is its time order.
const oldestFirst = (comments) => comments.sort((left, right) => (left.value.at < right.value.at ? -1 : left.value.at > right.value.at ? 1 : 0) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

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
  const all = target ? oldestFirst(await folderComments(target, artifactLocation(scope, address))) : [];
  const start = Math.min(offset, all.length + 1) - 1;
  const comments = all.slice(start, start + COMMENT_PAGE).map(({ name, value }) => shown(name, value));
  const next = start + comments.length;
  return { comments, totalComments: all.length, nextCommentOffset: next < all.length ? next + 1 : null };
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

// Every folder below artifact-comments/ that holds an entry named like a comment file, as its location below the folder; a link to a folder is never followed.
async function commentLocations(root, prefix, found) {
  let entries;
  try { entries = await readdir(prefix === "" ? root : path.join(root, ...prefix.split("/")), { withFileTypes: true }); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return; throw error; }
  let holds = false;
  for (const entry of entries) {
    if (entry.isDirectory()) await commentLocations(root, prefix === "" ? entry.name : `${prefix}/${entry.name}`, found);
    else if (entry.isFile() && ARTIFACT_COMMENT_FILE.test(entry.name)) holds = true;
  }
  if (holds && prefix !== "") found.push(prefix);
}

/**
 * The review app's applied comments on the artifacts of the scopes a seen store's checkout sees, each as its history entry, read from the comment's file,
 * with initiative null and artifact { path, scope }, since a comment belongs to no initiative; a comment dated more than a few minutes after the reading clock waits.
 */
export async function appliedComments(seen, now = Date.now()) {
  const root = await resolveStatusFile(seen, `${ARTIFACT_COMMENTS}/x`).then((target) => path.dirname(target)).catch(() => null);
  if (!root) return [];
  const locations = [];
  await commentLocations(root, "", locations);
  const entries = [];
  for (const location of locations) {
    const found = locationArtifact(location);
    const scope = found && seen.scopes.find((candidate) => candidate.label === found.scope.label);
    if (!scope) continue;
    const file = artifactPathOf(seen.kinds, found.kind, found.rest);
    const address = file === null ? null : artifactAddress(seen.kinds, file);
    if (address?.kind !== found.kind || address.rest !== found.rest) continue;
    const target = await resolveStatusFile(seen, `${ARTIFACT_COMMENTS}/${location}`).catch(() => null);
    if (!target) continue;
    for (const { value } of await folderComments(target, location)) {
      if (aheadOfClock(value.at, now)) continue;
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
  }
  return entries;
}
