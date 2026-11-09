import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomically } from "./artifact-store.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { readRecord, listClaimRecords, withRecordLock, writeRecord } from "./record-store.mjs";
import { isLive, parseClaim } from "./slice-claims.mjs";
import { readCoordinationState } from "./state.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";

// A shipped initiative's state is history: these helpers read its shipped decision and the work that keeps an initiative from shipping,
// and name the refusal of a change to a shipped initiative.

/** The refusal of a change to a shipped initiative, with the initiative and its ship time. */
export class ShippedHistoryError extends Error {
  constructor(initiative, shippedAt) {
    super(`Initiative ${initiative} shipped at ${shippedAt}, so its state is history and this change was not applied; start new work as a new initiative that references it.`);
    this.name = "ShippedHistoryError";
    this.code = "initiative_shipped";
    this.initiative = initiative;
    this.shippedAt = shippedAt;
  }
}

/** The refusal of a change while the roadmap record exists but cannot be read or parsed, so whether the initiative shipped is unknown. */
export class UnreadableRoadmapError extends Error {
  constructor(initiative, reason) {
    super(`The roadmap record cannot be read (${reason}), so Prism cannot tell whether initiative ${initiative} shipped and this change was not applied; repair the roadmap record and try again.`);
    this.name = "UnreadableRoadmapError";
    this.code = "invalid_roadmap";
    this.initiative = initiative;
  }
}

/** The ship date of a shipped decision: the first ten characters of its time. */
export const shipDate = (decision) => String(decision.at).slice(0, 10);

/** The shipped decision of a roadmap entry, or null when the entry has none. */
export const entryShippedDecision = (entry) => entry?.decision?.kind === "shipped" && typeof entry.decision.at === "string" ? entry.decision : null;

// The roadmap entry of an initiative: { entry } read from the roadmap record, with entry undefined when the record or the entry is absent,
// or { problem, error } with why a record that exists cannot be read or parsed.
async function roadmapEntry(projectRoot, initiative) {
  let record;
  try {
    const { bytes } = await readRecord(projectRoot, { kind: "roadmap" });
    if (!bytes) return { entry: undefined };
    record = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { problem: error instanceof SyntaxError ? "it is not valid JSON" : error.message, error };
  }
  const entries = Array.isArray(record?.initiatives) ? record.initiatives : [];
  return { entry: entries.find((entry) => entry?.id === initiative) };
}

/**
 * The shipped decision of an initiative read from the roadmap record, or null when the initiative has not shipped,
 * the roadmap has no entry for it, or the record cannot be read.
 * It reads the record directly, so modules that the roadmap module imports can use it.
 */
export async function shippedDecision(projectRoot, initiative) {
  const { entry } = await roadmapEntry(projectRoot, initiative);
  return entryShippedDecision(entry);
}

// The code of an operating-system or Node.js error, as opposed to a refusal that Prism names.
const SYSTEM_CODE = /^(E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/;

/**
 * Refuse a change to a shipped initiative: throws ShippedHistoryError when the roadmap records the initiative as shipped,
 * UnreadableRoadmapError when the roadmap record exists but cannot be read or parsed, and returns otherwise, a project without a roadmap record included.
 * Every writer of an initiative's state calls it after argument validation and before its other checks, and again inside the lock it writes under,
 * so a ship that lands between the two still refuses the change and a refused change writes nothing.
 */
export async function refuseShipped(projectRoot, initiative) {
  const { entry, problem, error } = await roadmapEntry(projectRoot, initiative);
  // A refusal of the record store itself, such as an unnamed checkout or a path outside the project, already refuses the change and names its own fix.
  if (error && typeof error.code === "string" && !SYSTEM_CODE.test(error.code)) throw error;
  if (problem) throw new UnreadableRoadmapError(initiative, problem);
  const decision = entryShippedDecision(entry);
  if (decision) throw new ShippedHistoryError(initiative, decision.at);
}

async function pendingProposals(projectRoot, initiative, record) {
  if (record === undefined) {
    const { bytes } = await readRecord(projectRoot, { kind: "initiative", initiative });
    record = bytes ? JSON.parse(bytes.toString("utf8")) : null;
  }
  const proposals = record?.proposals;
  return proposals && typeof proposals === "object" && !Array.isArray(proposals) ? Object.keys(proposals).sort() : [];
}

/**
 * The work that keeps an initiative from shipping: { gates, claims, proposals }, where gates lists every pending user gate, answered or not,
 * as { id, slice, question, answered } in state order, claims lists each live claim as { slice, label, activity, expiresAt } in slug order,
 * and proposals lists the scopes with a pending design proposal in slug order.
 * Pass record (the initiative record, or null) or state (a coordination state read) when the caller has already read them.
 */
export async function openWork(projectRoot, initiative, { record, state, now = Date.now() } = {}) {
  const coordination = state === undefined ? await readCoordinationState({ projectRoot, initiative }) : state;
  const pending = Array.isArray(coordination?.state?.pending) ? coordination.state.pending : [];
  const gates = pending
    .filter((gate) => gate && typeof gate === "object" && typeof gate.id === "string")
    .map((gate) => ({ id: gate.id, slice: gate.slice ?? null, question: gate.question ?? null, answered: Boolean(gate.answer) }));
  const claims = [];
  for (const { slice, bytes } of await listClaimRecords(projectRoot, initiative)) {
    const { claim } = parseClaim(slice, bytes);
    if (isLive(claim, now)) claims.push({ slice, label: claim.label, activity: claim.activity, expiresAt: claim.expiresAt });
  }
  claims.sort((left, right) => left.slice < right.slice ? -1 : left.slice > right.slice ? 1 : 0);
  return { gates, claims, proposals: await pendingProposals(projectRoot, initiative, record) };
}

/** Whether open work lists anything. */
export const hasOpenWork = (work) => work.gates.length > 0 || work.claims.length > 0 || work.proposals.length > 0;

/** The refusal message of shipping an initiative with open work, naming each gate id, claimed slice, and proposal scope. */
export function openWorkMessage(initiative, work) {
  const parts = [];
  if (work.gates.length) parts.push(`pending user gates ${work.gates.map((gate) => `${gate.id} (${[gate.slice ? `slice ${gate.slice}` : null, gate.answered ? "answered" : "unanswered"].filter(Boolean).join(", ")})`).join(", ")}`);
  if (work.claims.length) parts.push(`live claims on ${work.claims.map((claim) => `${claim.slice} (${claim.activity} by ${claim.label} until ${claim.expiresAt})`).join(", ")}`);
  if (work.proposals.length) parts.push(`pending design proposals for ${work.proposals.join(", ")}`);
  return `Initiative ${initiative} cannot ship while work is open: ${parts.join("; ")}. Resolve each gate, finish or release each claim, and accept or replace each proposal first, because no agent can finish this work once the initiative is history.`;
}

// A shipped initiative's slice documents carry the history mark, and its decision records their content without the mark,
// so a read can tell which documents changed after ship.

const MARK_FIRST = /^> Shipped history: initiative `[^`]+` shipped on \d{4}-\d{2}-\d{2}, so this document records finished work\.$/;
const MARK_SECOND = "> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.";
const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The two lines of the history mark of a shipped initiative, each ending in a newline. */
export const historyMark = (initiative, date) => `> Shipped history: initiative \`${initiative}\` shipped on ${date}, so this document records finished work.\n${MARK_SECOND}\n`;

/** The message that a read of a shipped initiative carries. */
export const shippedHistoryMessage = (initiative, decision) => `Initiative ${initiative} shipped on ${shipDate(decision)} and its state is history: take current intent only from Approved requirements, Accepted ADRs, the glossary, and feature files, and cite this initiative only as history.`;

// Where a document holds the mark: { start, end } as line indexes of the lines to remove, or null when it holds none.
function markLines(lines) {
  if (/^# /.test(lines[0] ?? "") && lines[1] === "" && MARK_FIRST.test(lines[2] ?? "") && lines[3] === MARK_SECOND) return { start: 1, end: 4 };
  if (MARK_FIRST.test(lines[0] ?? "") && lines[1] === MARK_SECOND && lines[2] === "") return { start: 0, end: 3 };
  return null;
}

/** A document's content without the history mark: the two mark lines and the blank line inserted with them removed. */
export function unmarkedContent(content) {
  const lines = content.split("\n");
  const found = markLines(lines);
  if (!found) return content;
  lines.splice(found.start, found.end - found.start);
  return lines.join("\n");
}

/** A document with the history mark: under a level-one heading on the first line, otherwise at the top; a document that holds a mark is returned unchanged. */
export function markDocument(content, initiative, date) {
  if (markLines(content.split("\n"))) return content;
  const mark = historyMark(initiative, date);
  const end = content.indexOf("\n");
  if (/^# /.test(content) && end !== -1) return `${content.slice(0, end + 1)}\n${mark}${content.slice(end + 1)}`;
  // A document that is only a heading without a newline keeps none after the mark, so removing the mark returns it exactly.
  if (/^# /.test(content)) return `${content}\n\n${mark.slice(0, -1)}`;
  return `${mark}\n${content}`;
}

// Whether a project-relative path stays inside the initiative's plans folder, so a slug or path from a record never reaches a file outside it.
function insideInitiativePlans(plans, initiative, relative) {
  if (typeof relative !== "string" || path.posix.isAbsolute(relative) || path.isAbsolute(relative)) return false;
  const folder = path.posix.join(plans, initiative);
  const normalized = path.posix.normalize(relative);
  return normalized === relative && normalized.startsWith(`${folder}/`) && !normalized.split("/").includes("..");
}

/**
 * The project-relative paths of an initiative's slice documents by its initiative record, in path order; none without a record or a plans path.
 * A slice key outside the slug pattern names no document, so a record never leads a read or a mark outside the plans folder.
 */
async function sliceDocumentPaths(projectRoot, initiative) {
  if (!SLUG_PATTERN.test(initiative ?? "")) return [];
  let slices;
  try {
    const { bytes } = await readRecord(projectRoot, { kind: "initiative", initiative });
    if (!bytes) return [];
    slices = JSON.parse(bytes.toString("utf8"))?.slices;
  } catch {
    return [];
  }
  if (!slices || typeof slices !== "object" || Array.isArray(slices)) return [];
  const plans = (await readWorkflowConfig(projectRoot)).paths.plans;
  if (!plans) return [];
  const folders = Object.keys(slices).filter((slug) => SLUG_PATTERN.test(slug)).map((slug) => slices[slug]?.parent === null ? `${plans}/${initiative}` : `${plans}/${initiative}/${slug}`);
  const files = [...new Set(folders.map((folder) => path.posix.join(folder, "slice.md")))];
  return files.filter((file) => insideInitiativePlans(plans, initiative, file)).sort();
}

// A document's state: { content } when it reads, { absent: true } when it does not exist, or { problem } with why it cannot be read.
async function readDocument(projectRoot, relative) {
  try {
    return { content: await readFile(path.join(projectRoot, relative), "utf8") };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { absent: true };
    return { problem: error.message };
  }
}

/**
 * The slice documents of an initiative that exist in this checkout: documents lists { path, content, unmarked } for each readable one,
 * and problems { path, reason } for each that exists but cannot be read, both in path order.
 */
export async function readSliceDocuments(projectRoot, initiative) {
  const documents = [];
  const problems = [];
  for (const relative of await sliceDocumentPaths(projectRoot, initiative)) {
    const read = await readDocument(projectRoot, relative);
    if (read.problem) problems.push({ path: relative, reason: read.problem });
    else if (!read.absent) documents.push({ path: relative, content: read.content, unmarked: unmarkedContent(read.content) });
  }
  return { documents, problems };
}

/** The recorded form of documents read by readSliceDocuments: { path, sha256 } of each one's content without the mark. */
export const documentDigests = (documents) => documents.map((document) => ({ path: document.path, sha256: sha256(document.unmarked) }));

/**
 * Write the history mark into documents read by readSliceDocuments; returns marked, the paths written in path order,
 * and problems { path, reason } for each that could not be written. A document that already holds a mark is left as it is,
 * and so is one whose content changed since it was read, which is listed under problems, so the mark never overwrites an edit.
 */
export async function writeHistoryMarks(projectRoot, initiative, decision, documents) {
  const marked = [];
  const problems = [];
  for (const document of documents) {
    const next = markDocument(document.content, initiative, shipDate(decision));
    if (next === document.content) continue;
    try {
      const current = await readDocument(projectRoot, document.path);
      if (current.content !== document.content) {
        const markedMeanwhile = current.content !== undefined && markLines(current.content.split("\n")) !== null && unmarkedContent(current.content) === document.unmarked;
        if (!markedMeanwhile) problems.push({ path: document.path, reason: current.problem ?? (current.absent ? "it was removed after it was read, so it was not marked" : "it changed after it was read, so it was not marked and its recorded content is the content read") });
        continue;
      }
      await writeAtomically(path.join(projectRoot, document.path), next);
      marked.push(document.path);
    } catch (error) {
      problems.push({ path: document.path, reason: error.message });
    }
  }
  return { marked, problems };
}

async function readRoadmapBytes(projectRoot) {
  const { bytes } = await readRecord(projectRoot, { kind: "roadmap" });
  return bytes;
}

/**
 * Record and mark the slice documents of an initiative that shipped before its decision recorded them, at the first read that reaches it:
 * returns { decision, marked } once recorded, or null when the initiative has not shipped, its decision already records documents,
 * no slice document exists in this checkout, or the roadmap changed meanwhile, so that a later read records them. It never throws.
 */
export async function recordShipDocuments(projectRoot, initiative) {
  try {
    const before = await readRoadmapBytes(projectRoot);
    if (!before) return null;
    const revision = sha256(before);
    const decision = entryShippedDecision(JSON.parse(before.toString("utf8"))?.initiatives?.find?.((entry) => entry?.id === initiative));
    if (!decision || Array.isArray(decision.documents)) return null;
    const { documents } = await readSliceDocuments(projectRoot, initiative);
    if (!documents.length) return null;
    const recorded = { ...decision, documents: documentDigests(documents), documentsRecordedAt: new Date().toISOString(), documentsFrom: "first-read" };
    const written = await withRecordLock(projectRoot, { kind: "roadmap" }, async () => {
      const current = await readRoadmapBytes(projectRoot);
      if (!current || sha256(current) !== revision) return false;
      const record = JSON.parse(current.toString("utf8"));
      const entry = record.initiatives.find((item) => item?.id === initiative);
      entry.decision = recorded;
      await writeRecord(projectRoot, { kind: "roadmap" }, `${JSON.stringify(record, null, 2)}\n`);
      return true;
    });
    if (!written) return null;
    const { marked } = await writeHistoryMarks(projectRoot, initiative, recorded, documents);
    return { decision: recorded, marked };
  } catch {
    return null;
  }
}

/** Record the slice documents of every shipped roadmap entry whose decision has none; returns { initiative, marked } for each entry this call recorded. */
export async function recordEarlierShips(projectRoot, entries) {
  const results = [];
  for (const entry of entries) {
    const decision = entryShippedDecision(entry);
    if (!decision || Array.isArray(decision.documents)) continue;
    const recorded = await recordShipDocuments(projectRoot, entry.id);
    if (recorded) results.push({ initiative: entry.id, marked: recorded.marked });
  }
  return results;
}

/** Each recorded document whose content differs, ignoring the mark, or that no longer exists, and each slice document in a folder that had none recorded, in path order. */
async function documentChanges(projectRoot, initiative, recorded) {
  const changes = [];
  const known = new Set(recorded.map((item) => item.path));
  for (const item of recorded) {
    const read = await readDocument(projectRoot, item.path);
    if (read.absent) changes.push({ path: item.path, change: "removed" });
    else if (read.problem || sha256(unmarkedContent(read.content)) !== item.sha256) changes.push({ path: item.path, change: "changed" });
  }
  const { documents } = await readSliceDocuments(projectRoot, initiative);
  for (const document of documents) if (!known.has(document.path)) changes.push({ path: document.path, change: "added" });
  return changes.sort(byPath);
}

/**
 * What a read of a shipped initiative reports: { initiative, shippedAt, message, documents, changedAfterShip }, with marked listing the documents
 * this read marked when it recorded an earlier ship's documents, or null when the initiative has not shipped.
 */
export async function shippedHistory(projectRoot, initiative) {
  let decision = await shippedDecision(projectRoot, initiative);
  if (!decision) return null;
  let marked = [];
  if (!Array.isArray(decision.documents)) {
    const recorded = await recordShipDocuments(projectRoot, initiative);
    // A read that recorded nothing may have lost the race to another read, so it answers from the decision as recorded now.
    if (recorded) ({ decision, marked } = recorded);
    else decision = (await shippedDecision(projectRoot, initiative)) ?? decision;
  }
  // A recorded path comes from the shared roadmap record, so only one inside the initiative's plans folder is read or reported.
  const plans = Array.isArray(decision.documents) ? await readWorkflowConfig(projectRoot).then((config) => config.paths.plans).catch(() => null) : null;
  const recorded = Array.isArray(decision.documents) && plans && SLUG_PATTERN.test(initiative ?? "")
    ? decision.documents.filter((item) => insideInitiativePlans(plans, initiative, item?.path)).sort(byPath)
    : [];
  const changedAfterShip = Array.isArray(decision.documents) ? await documentChanges(projectRoot, initiative, recorded).catch(() => []) : [];
  return {
    initiative,
    shippedAt: decision.at,
    message: shippedHistoryMessage(initiative, decision),
    documents: recorded.map((item) => item.path),
    changedAfterShip,
    ...(marked.length ? { marked } : {})
  };
}

/** The label that the review browser shows on a page of a shipped initiative. */
export const shippedHistoryLabel = (initiative, decision) => `Shipped history: ${initiative} shipped on ${shipDate(decision)}; this page records finished work.`;

/** The reason that the review browser gives for every action on a shipped initiative, its slices, and its gates. */
export const shippedActionReason = (decision) => `The initiative shipped on ${shipDate(decision)}, so its state is history.`;

/** The text line of an MCP read that marked slice documents, asking to commit them apart from the task's changes. */
export const historyMarksText = (initiative, marked) => `Prism marked these slice documents of shipped initiative ${initiative} as history: ${marked.join(", ")}. Commit them in a commit of their own, apart from this task's changes.`;
