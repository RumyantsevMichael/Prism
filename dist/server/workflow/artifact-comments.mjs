// Generated from src/server/workflow/artifact-comments.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readdir } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { ARTIFACT_COMMENTS, artifactAddress, artifactLocation } from "./artifact-paths.mjs";
import { ARTIFACT_COMMENT_FILE, COMMENTS_PER_ARTIFACT_MAX, resolveStatusFile } from "./record-store.mjs";
import { scheduleRecordSync } from "./record-store-sync.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { validUntil } from "./view-validity.mjs";
const COMMENT_TEXT_MAX = 4e3;
const COMMENT_FILE_MAX = 64 * 1024;
const FUTURE_SLACK_MS = 5 * 60 * 1e3;
const COMMENT_KEYS = ["location", "version", "line", "text", "author", "at", "entry", "by", "via"];
const VERSION_FORM = /^sha256:[0-9a-f]{64}$/;
const ENTRY_ID = /^[0-9a-f]{32}$/;
const TIME_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const textOf = (value, min, max) => typeof value === "string" && value.length >= min && value.length <= max;
function storedTime(value) {
  if (typeof value !== "string" || !TIME_FORM.test(value)) return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value;
}
function storedAuthor(by) {
  return hasKeys(by, ["name", "email", "checkout"]) && textOf(by.name, 1, 200) && (by.email === null || textOf(by.email, 0, 200)) && textOf(by.checkout, 1, 400);
}
const aheadOfClock = (at, now = Date.now()) => {
  const time = Date.parse(at);
  if (!(time > now + FUTURE_SLACK_MS)) return false;
  validUntil(time - FUTURE_SLACK_MS);
  return true;
};
const commentsFolder = (scope, address) => path.posix.join(ARTIFACT_COMMENTS, artifactLocation(scope, address));
const nameTime = (at) => at.replace(/[:.]/g, "-");
const commentName = (at) => `${nameTime(at)}-${randomBytes(4).toString("hex")}.json`;
const NAME_TIME_LENGTH = "YYYY-MM-DDTHH-MM-SS-sssZ".length;
const timeOfName = (name) => `${name.slice(0, 13)}:${name.slice(14, 16)}:${name.slice(17, 19)}.${name.slice(20, NAME_TIME_LENGTH)}`;
function storedComment(name, bytes, location) {
  if (!bytes || bytes.length > COMMENT_FILE_MAX) return null;
  if (!ARTIFACT_COMMENT_FILE.test(name)) return null;
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.replace(/\n$/, "").includes("\n")) return null;
    value = parseStoreJson(text);
  } catch {
    return null;
  }
  if (!hasKeys(value, COMMENT_KEYS) || value.location !== location || value.via !== "review-app") return null;
  if (typeof value.version !== "string" || !VERSION_FORM.test(value.version)) return null;
  if (!Number.isSafeInteger(value.line) || value.line < 1) return null;
  if (!textOf(value.text, 1, COMMENT_TEXT_MAX) || value.text.trim() === "") return null;
  if (!hasKeys(value.author, ["name", "host"]) || !textOf(value.author.name, 1, 200) || !textOf(value.author.host, 0, 255)) return null;
  if (!storedAuthor(value.by) || value.by.name !== value.author.name) return null;
  if (typeof value.entry !== "string" || !ENTRY_ID.test(value.entry) || !storedTime(value.at) || !name.startsWith(`${nameTime(value.at)}-`)) return null;
  return value;
}
async function savedComment(target, location) {
  const bytes = await readCommentFile(target);
  const value = bytes ? storedComment(path.basename(target), bytes, location) : null;
  return value ? { line: value.line, text: value.text } : null;
}
const shown = (name, value) => ({ id: name.slice(0, -".json".length), version: value.version, line: value.line, text: value.text, author: { name: value.author.name, host: value.author.host }, at: value.at, entry: value.entry });
async function readCommentFile(target) {
  if (!constants.O_NOFOLLOW && !(await lstat(target).catch(() => null))?.isFile()) return null;
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > COMMENT_FILE_MAX) return null;
    const buffer = Buffer.alloc(info.size + 1);
    let filled = 0;
    for (let read; filled < buffer.length && (read = (await handle.read(buffer, filled, buffer.length - filled, filled)).bytesRead) > 0; ) filled += read;
    return filled > info.size ? null : buffer.subarray(0, filled);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {
    });
  }
}
async function folderEntries(target, location) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return [];
    throw error;
  }
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
async function boundedNames(target) {
  const names = [];
  let count = 0;
  const folder = await opendir(target, { bufferSize: 128 });
  try {
    for await (const entry of folder) {
      if (++count > COMMENTS_PER_ARTIFACT_MAX) return [];
      if (entry.isFile() && ARTIFACT_COMMENT_FILE.test(entry.name)) names.push(entry.name);
    }
  } finally {
    await folder.close().catch(() => {
    });
  }
  return names.sort();
}
async function folderFull(target) {
  let count = 0;
  let folder;
  try {
    folder = await opendir(target, { bufferSize: 128 });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
  try {
    for await (const entry of folder) {
      void entry;
      if (++count >= COMMENTS_PER_ARTIFACT_MAX) return true;
    }
  } finally {
    await folder.close().catch(() => {
    });
  }
  return false;
}
const LISTING_TRUSTED_MS = 5e3;
const ATTENTION_TRUSTED_MS = 6e4;
const RACY_MS = 1e3;
const LISTINGS_KEPT = 256;
let listingsKept = LISTINGS_KEPT;
const STAMPS_AT_ONCE = 16;
const listings = /* @__PURE__ */ new Map();
const inFlight = /* @__PURE__ */ new Map();
const stampOf = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const lstatOrNull = (target) => lstat(target, { bigint: true }).catch((error) => {
  if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
  throw error;
});
const racy = (info, now) => now - Number(info.mtimeMs) < RACY_MS || now - Number(info.ctimeMs) < RACY_MS;
function folderListing(target, location, { fresh = false } = {}) {
  const key = `${fresh ? "fresh" : "kept"}\0${location}\0${target}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const reading = readListing(target, location, fresh).finally(() => inFlight.delete(key));
  inFlight.set(key, reading);
  return reading;
}
async function readListing(target, location, fresh) {
  const folder = await lstatOrNull(target);
  if (!folder?.isDirectory()) {
    listings.delete(target);
    return null;
  }
  const stamp = stampOf(folder);
  const kept = listings.get(target)?.location === location ? listings.get(target) : null;
  const now = Date.now();
  let listing = kept;
  if (fresh || !(kept?.stamp === stamp && !kept.racy)) {
    let names;
    try {
      names = await boundedNames(target);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
      throw error;
    }
    const files = /* @__PURE__ */ new Map();
    if (kept) {
      for (const name of names) if (kept.files.has(name)) files.set(name, { ...kept.files.get(name), checked: -Infinity });
    }
    listing = { location, stamp, racy: racy(folder, now), names, files, revision: 0, valid: null, summary: null };
  }
  listings.delete(target);
  listings.set(target, listing);
  while (listings.size > listingsKept) listings.delete(listings.keys().next().value);
  return listing;
}
const HOLDS_NONE = Object.freeze({ at: null, entry: null });
async function knownFile(listing, target, name, { trustedMs, fresh = false }) {
  const known = listing.files.get(name);
  const now = Date.now();
  if (!fresh && known && !known.racy && now - known.checked < trustedMs) return { file: known, read: false };
  const info = await lstatOrNull(path.join(target, name));
  if (!info?.isFile()) {
    forget(listing, name);
    return { file: HOLDS_NONE, read: false };
  }
  const stamp = stampOf(info);
  if (!fresh && known?.stamp === stamp && !known.racy) {
    known.checked = now;
    return { file: known, read: false };
  }
  const read = info.size <= COMMENT_FILE_MAX;
  const bytes = read ? await readCommentFile(path.join(target, name)) : null;
  const value = bytes ? storedComment(name, bytes, listing.location) : null;
  const file = { stamp, racy: racy(info, now), checked: now, at: value?.at ?? null, entry: value?.entry ?? null };
  listing.files.set(name, file);
  listing.revision += 1;
  return { file, value, read };
}
function forget(listing, name) {
  if (listing.files.delete(name)) listing.revision += 1;
}
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
    batch.forEach((name, position) => {
      const { file } = found[position];
      if (file.at !== null) order.push({ name, at: file.at, entry: file.entry });
    });
  }
  return order;
}
async function listedComment(target, location, { name, at, entry }) {
  const bytes = await readCommentFile(path.join(target, name));
  const value = bytes ? storedComment(name, bytes, location) : null;
  return value && value.at === at && value.entry === entry ? value : null;
}
const readListed = (target, location, items) => Promise.all(items.map(async (item) => {
  const value = await listedComment(target, location, item);
  return value ? { name: item.name, value } : null;
}));
const resolvedFolder = (seen, scope, address) => resolveStatusFile(seen, commentsFolder(scope, address)).catch(() => null);
const COMMENT_PAGE = 20;
async function listComments(seen, scope, address, offset = 1) {
  const target = await resolvedFolder(seen, scope, address);
  if (!target) return { comments: [], totalComments: 0, nextCommentOffset: null };
  const location = artifactLocation(scope, address);
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
async function commentFolderOf(seen, scope, address) {
  const location = artifactLocation(scope, address);
  const target = await resolvedFolder(seen, scope, address);
  return { location, target, entries: target ? await folderEntries(target, location) : [] };
}
async function movedComment(seen, scope, address, { name, comment }) {
  const target = await resolveStatusFile(seen, `${commentsFolder(scope, address)}/${name}`);
  return { target, bytes: Buffer.from(`${JSON.stringify({ ...comment, location: artifactLocation(scope, address) })}
`, "utf8") };
}
async function addComment(seen, scope, address, { version, line, text, author, entry }) {
  const folder = await resolveStatusFile(seen, commentsFolder(scope, address));
  if (await folderFull(folder)) throw Object.assign(new Error(`This file already holds the ${COMMENTS_PER_ARTIFACT_MAX} comments that a file may hold, so the comment was not stored.`), { code: "comment_limit" });
  const name = commentName(entry.at);
  const target = await resolveStatusFile(seen, `${commentsFolder(scope, address)}/${name}`);
  const comment = { location: artifactLocation(scope, address), version, line, text, author: { name: author.name, host: String(author.host ?? "").slice(0, 255) }, at: entry.at, entry: entry.id, by: entry.by, via: entry.via };
  const bytes = Buffer.from(`${JSON.stringify(comment)}
`, "utf8");
  if (!storedComment(name, bytes, comment.location)) throw Object.assign(new Error("The comment is not of the form that every reader takes, so it was not stored."), { code: "invalid_comment" });
  await mkdir(folder, { recursive: true });
  await writeAtomically(target, bytes);
  if (seen.store.sync) scheduleRecordSync(seen.store.base);
  return shown(name, comment);
}
const READS_PER_LISTED = 4;
const STAMPS_PER_LISTED = 50;
const work = { walked: 0, merged: 0 };
const attentionWork = () => ({ ...work });
const validNames = (listing) => listing.valid ??= listing.names.filter((name) => storedTime(timeOfName(name)));
function eligibleCount(valid, now) {
  const limit = nameTime(new Date(now + FUTURE_SLACK_MS).toISOString());
  let low = 0, high = valid.length;
  while (low < high) {
    const middle = low + high >>> 1;
    if (valid[middle].slice(0, NAME_TIME_LENGTH) <= limit) low = middle + 1;
    else high = middle;
  }
  return low;
}
function newer(left, right) {
  if (left.at !== right.at) return left.at > right.at;
  if (Boolean(left.unknown) !== Boolean(right.unknown)) return Boolean(left.unknown);
  return left.unknown ? left.name > right.name : left.entry > right.entry;
}
function folderSummary(listing, end, latest) {
  const kept = listing.summary;
  if (kept && kept.revision === listing.revision && kept.end === end && kept.latest === latest) return { summary: kept, walked: false };
  const valid = validNames(listing);
  const known = [], unknown = [];
  const entries = /* @__PURE__ */ new Set();
  let boundary = null, low = end, checkedAt = Infinity;
  for (let index = end - 1; index >= 0; index -= 1) {
    const name = valid[index];
    const at = timeOfName(name);
    if (boundary !== null && at < boundary) break;
    low = index;
    work.walked += 1;
    const file = listing.files.get(name);
    if (!file || file.racy) {
      unknown.push(index);
      continue;
    }
    checkedAt = Math.min(checkedAt, file.checked);
    if (file.at === null) continue;
    known.push({ name, at: file.at, entry: file.entry });
    entries.add(file.entry);
    if (boundary === null && entries.size >= latest) boundary = file.at;
  }
  known.sort((left, right) => byText(right.at, left.at) || byText(right.entry, left.entry));
  const top = [];
  const taken = /* @__PURE__ */ new Set();
  for (const item of known) {
    if (top.length >= latest) break;
    if (!taken.has(item.entry)) {
      taken.add(item.entry);
      top.push(item);
    }
  }
  listing.summary = { revision: listing.revision, end, latest, top, unknown, low, checkedAt, stamping: null };
  return { summary: listing.summary, walked: true };
}
function listCursor(items) {
  let at = 0;
  return { item: items[0] ?? null, next() {
    at += 1;
    this.item = items[at] ?? null;
  } };
}
function summaryCursor(listing, summary) {
  const valid = validNames(listing);
  const { top, unknown } = summary;
  const nameAt = (position) => {
    const name = valid[unknown[position]];
    return { name, at: timeOfName(name), unknown: true };
  };
  let known = 0, named = 0, pending = unknown.length ? nameAt(0) : null;
  const cursor = {
    item: null,
    next() {
      const comment = known < top.length ? top[known] : null;
      if (pending && (!comment || newer(pending, comment))) {
        cursor.item = pending;
        named += 1;
        pending = named < unknown.length ? nameAt(named) : null;
      } else if (comment) {
        cursor.item = comment;
        known += 1;
      } else cursor.item = null;
    }
  };
  cursor.next();
  return cursor;
}
async function restamp(listing, target, summary, budget, now) {
  const valid = validNames(listing);
  if (summary.stamping === null) summary.stamping = { next: summary.end - 1, began: now };
  let used = 0;
  while (summary.stamping.next >= summary.low && used < budget) {
    const batch = [];
    while (summary.stamping.next >= summary.low && batch.length < STAMPS_AT_ONCE && used + batch.length < budget) {
      const name = valid[summary.stamping.next--];
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
  if (summary.stamping.next < summary.low) {
    summary.checkedAt = summary.stamping.began;
    summary.stamping = null;
  }
  return used;
}
function mergedNewestFirst() {
  const heap = [];
  let added = 0;
  const itemOf = (entry) => entry.source.cursor.item;
  const before = (left, right) => newer(itemOf(left), itemOf(right)) || !newer(itemOf(right), itemOf(left)) && left.order < right.order;
  const swap = (left, right) => {
    [heap[left], heap[right]] = [heap[right], heap[left]];
  };
  const up = (index) => {
    while (index > 0) {
      const parent = index - 1 >> 1;
      if (!before(heap[index], heap[parent])) return;
      swap(index, parent);
      index = parent;
    }
  };
  const down = (index) => {
    for (; ; ) {
      let top = index;
      for (const child of [2 * index + 1, 2 * index + 2]) if (child < heap.length && before(heap[child], heap[top])) top = child;
      if (top === index) return;
      swap(index, top);
      index = top;
    }
  };
  return {
    get size() {
      return heap.length;
    },
    add(source) {
      if (source.cursor.item) {
        heap.push({ source, order: added++ });
        up(heap.length - 1);
      }
    },
    peek: () => itemOf(heap[0]),
    pop() {
      const entry = heap[0];
      const item = itemOf(entry);
      work.merged += 1;
      entry.source.cursor.next();
      if (!entry.source.cursor.item) {
        const last = heap.pop();
        if (heap.length) heap[0] = last;
      }
      if (heap.length) down(0);
      return { source: entry.source, item };
    }
  };
}
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
async function appliedComments(seen, now = Date.now(), { latest = Infinity, artifacts = [], resolve = (relative) => resolveStatusFile(seen, relative) } = {}) {
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
    if (stamps > 0 && now - summary.checkedAt > ATTENTION_TRUSTED_MS) {
      stamps -= await restamp(listing, target, summary, stamps, now);
      ({ summary, walked } = folderSummary(listing, end, latest));
    }
    queue.add({ listing, target, file, scope, cursor: summaryCursor(listing, summary) });
    tops.push({ listing, target, file, scope, top: summary.top });
    if (walked) await yieldTurn();
  }
  const found = [];
  const ids = /* @__PURE__ */ new Set();
  const learned = [];
  const take = ({ source, item }) => {
    if (!ids.has(item.entry)) {
      ids.add(item.entry);
      found.push({ source, ...item });
    }
  };
  while (queue.size && found.length < latest) {
    if (!queue.peek().unknown) {
      take(queue.pop());
      continue;
    }
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
      if (file.at === null) continue;
      const joined = { name: item.name, at: file.at, entry: file.entry, value };
      queue.add({ ...source, cursor: listCursor([joined]) });
      learned.push({ ...source, item: joined });
    }
  }
  const entries = [];
  for (let index = 0; index < found.length; index += STAMPS_AT_ONCE) {
    const batch = found.slice(index, index + STAMPS_AT_ONCE);
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
async function appliedComment(seen, { path: file, scope }, address, { comment, id }, now = Date.now()) {
  const name = `${comment}.json`;
  if (!ARTIFACT_COMMENT_FILE.test(name)) return null;
  const target = await resolvedFolder(seen, scope, address);
  if (!target) return null;
  const listing = await folderListing(target, artifactLocation(scope, address));
  if (!listing?.names.includes(name)) return null;
  const { value } = await knownFile(listing, target, name, { trustedMs: 0, fresh: true });
  return value && value.entry === id && !aheadOfClock(value.at, now) ? commentEntry(value, file, scope) : null;
}
export {
  COMMENT_PAGE,
  COMMENT_TEXT_MAX,
  FUTURE_SLACK_MS,
  addComment,
  aheadOfClock,
  appliedComment,
  appliedComments,
  attentionWork,
  commentFolderOf,
  commentsFolder,
  listComments,
  movedComment,
  readCommentFile,
  savedComment,
  storedAuthor,
  storedComment,
  storedTime
};
