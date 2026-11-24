import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { checkArtifactContent } from "./artifact-check.mjs";
import { assertInput, describeErrors } from "./artifact-schema.mjs";
import { normalizeRequirementReference } from "./initiative.mjs";
import { canonicalJson, mergeHistory, mergeKeyed, mergeOrder, mergeScalars, MergeConflict, parseVersions } from "./record-merge.mjs";
import { listWorkItemRecords, readRecord, readStoreFileBytes, STORE_FILE_BOUNDS, withRecordLock, writeRecord } from "./record-store.mjs";
import { revisionMismatch } from "./revision.mjs";
import { readRoadmapRecord, RoadmapError, updateRoadmap } from "./roadmap.mjs";
import { readCoordinationState, updateCoordinationState } from "./state.mjs";
import { storeArtifactComments, storeArtifactCopy, storeArtifactStatuses } from "./store-artifacts.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";

// Every roadmap entry is a work item, addressed by its roadmap identifier.
// Its shaping record of inputs, findings, research gaps, and cited ADRs is a record of its own beside the entry's initiative records, apart from the roadmap record,
// while the requirement files it cites are the entry's own requirement references, so the roadmap stays the one place that names them.

export class WorkItemError extends Error {
  declare code: string;
  [detail: string]: unknown;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "WorkItemError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code: string, message: string, details?: Record<string, unknown>) => new WorkItemError(code, message, details);

const RECORD_MAX_BYTES = STORE_FILE_BOUNDS["work-item"];
const MERGES_KEPT = 1000;
const PROPOSALS_KEPT = 1000;
/** The lists of a shaping record whose entries carry an identifier that Prism assigns, with the prefix of that identifier. */
const ENTRY_LISTS = Object.freeze([["inputs", "input"], ["questions", "question"], ["findings", "finding"], ["gaps", "gap"]]);
const ENTRY_ID = /^(input|question|finding|gap)-[0-9a-f]{8}$/;
const NOTE_MAX = 300;
const ROUND_MAX = 5;
// A question waits for its gate id until its gate opens, which comes after every check; the placeholder has the id's length, so the record's bound is measured as written.
const GATE_PENDING = "gate-000000000000";

const text = { type: "string", minLength: 1, maxLength: 4000 };
const itemId = { type: "string", minLength: 1, maxLength: 120 };
const link = { type: "string", minLength: 1, maxLength: 2000 };
const paths = { type: "array", maxItems: 200, items: text };
const object = (properties: any, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });

export const GET_WORK_ITEM_SCHEMA = object({ projectRoot: text, item: itemId });
export const UPDATE_WORK_ITEM_SCHEMA = object({
  projectRoot: text,
  item: itemId,
  expectedRevision: { oneOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
  actor: text,
  operations: { type: "array", minItems: 1, maxItems: 50, items: { oneOf: [
    object({ op: { const: "add_input" }, link, note: { type: "string", minLength: 1, maxLength: NOTE_MAX } }),
    object({ op: { const: "add_finding" }, text, source: { type: "string", maxLength: 2000 } }, ["op", "text"]),
    object({ op: { const: "add_research_gap" }, note: text }),
    object({ op: { const: "cite" }, requirements: paths, adrs: paths }, ["op"]),
    object({ op: { const: "uncite" }, requirements: paths, adrs: paths }, ["op"]),
    object({ op: { const: "ask_round" }, questions: { type: "array", minItems: 1, maxItems: ROUND_MAX, items: object({
      question: text,
      recommended: { type: "string", minLength: 1, maxLength: 200 },
      settles: { type: "string", minLength: 1, maxLength: 1000 },
      blocking: { type: "boolean" }
    }) } }),
    object({ op: { const: "withdraw_question" }, question: { type: "string", minLength: 1, maxLength: 40 } }),
    object({ op: { const: "request_ready" } })
  ] } }
}, ["projectRoot", "item", "expectedRevision", "operations"]);

function validateInput(schema: any, input: any) {
  try {
    assertInput(schema, input);
  } catch (error) {
    throw fail("validation_failed", `The work item arguments are invalid: ${describeErrors(error.errors)}`, { errors: error.errors });
  }
}

/** A shaping record before any entry. */
export function emptyShapingRecord() {
  return { inputs: [], questions: [], findings: [], gaps: [], adrs: [], ready: null, origin: null, merges: [], splitInto: null, mergedInto: null, kill: null, changedAt: null };
}

const isRecord = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const nullOr = (value: any, check: (value: any) => boolean) => value === null || check(value);

/** The problems of a shaping record as a reader checks it, which a sync may bring from another machine; [] when it is valid. */
export function shapingRecordErrors(raw: any) {
  if (!isRecord(raw)) return ["The shaping record must be a JSON object."];
  const errors = [];
  const seen = new Set();
  for (const [key, prefix] of ENTRY_LISTS) {
    if (!Array.isArray(raw[key])) { errors.push(`${key} must be an array.`); continue; }
    for (const [index, entry] of raw[key].entries()) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.startsWith(`${prefix}-`) || !ENTRY_ID.test(entry.id)) errors.push(`${key}[${index}] must be an object whose id is ${prefix}- and 8 lowercase hexadecimal digits.`);
      else if (seen.has(entry.id)) errors.push(`${key}[${index}].id duplicates ${entry.id}.`);
      else seen.add(entry.id);
    }
  }
  if (!Array.isArray(raw.adrs) || raw.adrs.some((value: any) => typeof value !== "string") || new Set(raw.adrs).size !== raw.adrs.length) errors.push("adrs must be an array of distinct paths.");
  if (!Array.isArray(raw.merges) || raw.merges.some((value: any) => !isRecord(value))) errors.push("merges must be an array of objects.");
  for (const key of ["ready", "origin", "kill"]) if (!nullOr(raw[key], isRecord)) errors.push(`${key} must be null or an object.`);
  if (!nullOr(raw.splitInto, (value) => Array.isArray(value) && value.every((part: any) => typeof part === "string"))) errors.push("splitInto must be null or an array of identifiers.");
  if (!nullOr(raw.mergedInto, (value) => typeof value === "string")) errors.push("mergedInto must be null or an identifier.");
  if (!nullOr(raw.changedAt, (value) => typeof value === "string")) errors.push("changedAt must be null or a time.");
  // A pending proposal and the closed ones with their outcomes are written once the item has one.
  if (raw.proposal !== undefined && !nullOr(raw.proposal, (value) => isRecord(value) && typeof value.kind === "string" && typeof value.gate === "string")) errors.push("proposal must be null or an object with a kind and a gate.");
  if (raw.proposals !== undefined && (!Array.isArray(raw.proposals) || raw.proposals.some((value: any) => !isRecord(value)))) errors.push("proposals must be an array of objects.");
  return errors;
}

const serialize = (record: any) => `${JSON.stringify(record, null, 2)}\n`;
const revisionOf = (bytes: any) => createHash("sha256").update(bytes).digest("hex");

// A stored shaping record: { revision, record }, both null while the item has none; a damaged one refuses the read.
function parseShapingRecord(item: string, bytes: any) {
  if (bytes === null) return { revision: null, record: null };
  const revision = revisionOf(bytes);
  let raw;
  try { raw = parseStoreJson(bytes.toString("utf8")); }
  catch { throw fail("invalid_work_item", `The shaping record of ${item} is not valid JSON, so it was not read.`, { item, currentRevision: revision }); }
  const errors = shapingRecordErrors(raw);
  if (errors.length) throw fail("invalid_work_item", `The shaping record of ${item} is invalid: ${errors[0]}`, { item, errors, currentRevision: revision });
  return { revision, record: raw };
}

/** An item's stored shaping record: { revision, record }, both null while it has none. */
export async function readShapingRecord(projectRoot: string, item: string) {
  let bytes;
  try {
    ({ bytes } = await readRecord(projectRoot, { kind: "work-item", initiative: item }, { maxBytes: RECORD_MAX_BYTES }));
  } catch (error) {
    if (error?.tooLarge) throw fail("invalid_work_item", `The shaping record of ${item} is larger than its bound, so it was not read.`, { item });
    throw error;
  }
  return parseShapingRecord(item, bytes);
}

/**
 * Merge three versions of a shaping record by structure for store sync: the entries of each list by identifier and their order, cited ADRs by path,
 * merges as history, changedAt as the later of both sides, and every other field as a scalar that conflicts when both sides changed it differently.
 * Returns { contents } with the bytes of a valid merged record, or { conflict }.
 */
export function mergeShapingRecord(versions: any) {
  try {
    const { base, local, upstream } = parseVersions(versions, emptyShapingRecord);
    if ([base, local, upstream].some((record) => shapingRecordErrors(record).length)) throw new MergeConflict("A version of the shaping record is invalid.");
    const merged: Record<string, any> = {};
    const lists: Record<string, any[]> = {};
    for (const [key] of ENTRY_LISTS) {
      const byId = (record: any) => Object.fromEntries(record[key].map((entry: any) => [entry.id, entry]));
      const ids = (record: any) => record[key].map((entry: any) => entry.id);
      const entries = mergeKeyed(`The ${key} entry`, byId(base), byId(local), byId(upstream));
      lists[key] = mergeOrder(`The order of ${key}`, ids(base), ids(local), ids(upstream), new Set(Object.keys(entries))).map((id) => entries[id]);
    }
    const adrs = mergeKeyed("The cited ADR", ...[base, local, upstream].map((record: any) => Object.fromEntries(record.adrs.map((file: string) => [file, file]))) as [any, any, any]);
    lists.adrs = mergeOrder("The order of cited ADRs", base.adrs, local.adrs, upstream.adrs, new Set(Object.keys(adrs)));
    lists.merges = mergeHistory(base.merges, local.merges, upstream.merges, MERGES_KEPT);
    if ([base, local, upstream].some((record: any) => record.proposals !== undefined)) lists.proposals = mergeHistory((base as any).proposals ?? [], (local as any).proposals ?? [], (upstream as any).proposals ?? [], PROPOSALS_KEPT);
    const later = [local.changedAt, upstream.changedAt].filter((value) => typeof value === "string").sort().at(-1) ?? null;
    const scalars = mergeScalars(base, local, upstream, [...Object.keys(lists), "changedAt"]);
    for (const key of new Set([...Object.keys(upstream), ...Object.keys(local), ...Object.keys(base)])) {
      if (Object.hasOwn(lists, key)) merged[key] = lists[key];
      else if (key === "changedAt") merged.changedAt = later;
      else if (Object.hasOwn(scalars, key)) merged[key] = scalars[key];
    }
    const errors = shapingRecordErrors(merged);
    if (errors.length) return { conflict: `The merged shaping record is invalid: ${errors[0]}` };
    const contents = serialize(merged);
    if (Buffer.byteLength(contents) > RECORD_MAX_BYTES) return { conflict: "The merged shaping record exceeds its bound." };
    return { contents };
  } catch (error) {
    return { conflict: error instanceof MergeConflict ? error.message : `The shaping record versions could not be merged: ${error.message}` };
  }
}

// A link is a URI with a scheme, such as https://… or notion://…, or a normalized project-relative path; Prism keeps the link and never what it names.
const URI = /^[A-Za-z][A-Za-z0-9+.-]+:\S+$/;
export function isLink(value: any) {
  if (typeof value !== "string" || !value || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  if (URI.test(value)) return true;
  return !value.includes("\\") && !value.includes(":") && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value !== ".." && !value.startsWith("../") && value !== ".";
}

const linkRefusal = (field: string, value: string) => fail("link_invalid", `The ${field} ${JSON.stringify(value)} is no link: give a URI with a scheme, such as https://example.com/brief or notion://workspace/page, or a project-relative path such as docs/notes/interview.md; nothing changed.`);

// A cited ADR is a normalized path below the configured ADRs folder.
function adrPath(config: any, value: string) {
  const folder = config.paths?.adrs ?? null;
  if (folder === null) throw fail("validation_failed", "The workflow config names no ADRs folder, so no ADR can be cited; nothing changed.");
  const inside = !value.includes("\\") && path.posix.normalize(value) === value && value.startsWith(`${folder}/`) && value.endsWith(".md") && !value.split("/").includes("..");
  if (!inside) throw fail("validation_failed", `${JSON.stringify(value)} is no ADR path below the configured ADRs folder ${folder}/; nothing changed.`);
  return value;
}

function requirementReference(config: any, value: string) {
  const normalized = normalizeRequirementReference(config.paths?.requirements ?? null, value);
  if (normalized.problem) throw fail("validation_failed", `${normalized.problem} Nothing changed.`);
  return normalized.reference as string;
}

const referenceFile = (reference: string) => reference.split("#")[0];

// A new entry identifier that no entry of the record holds.
function newId(record: any, prefix: string) {
  const held = new Set(ENTRY_LISTS.flatMap(([key]) => record[key].map((entry: any) => entry.id)));
  for (;;) {
    const id = `${prefix}-${randomBytes(4).toString("hex")}`;
    if (!held.has(id)) return id;
  }
}

/**
 * Apply operations to a copy of a shaping record and an entry's requirement references, refusing any that is invalid:
 * { record, requirements, added, asks, withdrawals, readyRequested }, where added holds each requirement reference a cite added that the entry did not hold at that point,
 * asks the questions whose gates the update opens, and withdrawals { id, reason } for each gate it closes as withdrawn.
 * Any change clears the ready mark and withdraws a pending proposal, so a confirmation always covers the record as the person saw it.
 */
function applyOperations(config: any, current: any, references: string[], operations: any[], at: string) {
  const record = structuredClone(current ?? emptyShapingRecord());
  let requirements = [...references];
  const added: string[] = [];
  const asks: any[] = [];
  const withdrawals: { id: string; reason: string }[] = [];
  const readyRequested = operations.some((operation) => operation.op === "request_ready");
  if (readyRequested && operations.length > 1) throw fail("validation_failed", "request_ready stands alone in its update, so the confirmation covers the record as it is; nothing changed.");
  for (const operation of operations) {
    switch (operation.op) {
      case "add_input": {
        if (!isLink(operation.link)) throw linkRefusal("link", operation.link);
        if (/[\r\n\u2028\u2029]/.test(operation.note) || !operation.note.trim()) throw fail("validation_failed", `An input's note is one line of 1 to ${NOTE_MAX} characters; nothing changed.`);
        record.inputs.push({ id: newId(record, "input"), link: operation.link, note: operation.note, addedAt: at });
        break;
      }
      case "add_finding": {
        if (operation.source === undefined || !operation.source.trim()) throw fail("source_missing", "A finding needs source, a link to where it was found, so a finding without one is recorded as a research gap with add_research_gap instead; nothing changed.");
        if (!isLink(operation.source)) throw linkRefusal("source", operation.source);
        if (!operation.text.trim()) throw fail("validation_failed", "A finding's text is blank; nothing changed.");
        record.findings.push({ id: newId(record, "finding"), text: operation.text, source: operation.source, addedAt: at });
        break;
      }
      case "add_research_gap":
        if (!operation.note.trim()) throw fail("validation_failed", "A research gap's note is blank; nothing changed.");
        record.gaps.push({ id: newId(record, "gap"), note: operation.note, addedAt: at });
        break;
      case "cite":
      case "uncite": {
        const cited = (operation.requirements ?? []).map((value: string) => requirementReference(config, value));
        const adrs = (operation.adrs ?? []).map((value: string) => adrPath(config, value));
        if (operation.op === "cite") {
          for (const reference of cited) if (!requirements.includes(reference)) { requirements.push(reference); added.push(reference); }
          for (const file of adrs) if (!record.adrs.includes(file)) record.adrs.push(file);
        } else {
          requirements = requirements.filter((reference) => !cited.includes(reference));
          record.adrs = record.adrs.filter((file: string) => !adrs.includes(file));
        }
        break;
      }
      case "ask_round": {
        const blank = operation.questions.find((asked: any) => ["question", "recommended", "settles"].some((field) => !asked[field].trim()));
        if (blank) throw fail("validation_failed", "A question, its recommended answer, and what it settles each need text; nothing changed.");
        const round = Math.max(0, ...record.questions.map((asked: any) => Number.isInteger(asked.round) ? asked.round : 0)) + 1;
        for (const asked of operation.questions) {
          const entry = { id: newId(record, "question"), round, question: asked.question, recommended: asked.recommended, settles: asked.settles, blocking: asked.blocking, gate: GATE_PENDING, askedAt: at, answer: null, withdrawn: false };
          record.questions.push(entry);
          asks.push(entry);
        }
        break;
      }
      case "withdraw_question": {
        const asked = record.questions.find((candidate: any) => candidate.id === operation.question);
        if (!asked) throw fail("validation_failed", `The shaping record has no question ${operation.question}; nothing changed.`);
        if (asked.answer) throw fail("question_answered", `The question ${asked.id} has the person's answer, so it cannot be withdrawn; nothing changed.`);
        if (asked.withdrawn) break;
        asked.withdrawn = true;
        const opening = asks.indexOf(asked);
        if (opening !== -1) asks.splice(opening, 1);
        else if (typeof asked.gate === "string") withdrawals.push({ id: asked.gate, reason: WITHDRAWN_QUESTION });
        break;
      }
      case "request_ready":
        break;
      default:
        throw fail("validation_failed", `Unsupported operation ${operation.op}.`);
    }
  }
  const changed = readyRequested || canonicalJson(requirements) !== canonicalJson(references) || canonicalJson(record) !== canonicalJson(current ?? emptyShapingRecord());
  if (changed && current) {
    record.ready = null;
    if (record.proposal) {
      withdrawals.push(...proposalGates(record.proposal).map((id) => ({ id, reason: WITHDRAWN_PROPOSAL })));
      closeProposal(record, { outcome: "withdrawn", at });
    }
  }
  return { record, requirements, added, asks, withdrawals, readyRequested };
}

// The gates of a proposal: its own, and for a kill the gate of each artifact.
const proposalGates = (proposal: any) => [proposal.gate, ...(Array.isArray(proposal.artifacts) ? proposal.artifacts.map((artifact: any) => artifact?.gate) : [])].filter((id) => typeof id === "string");

// Close a record's pending proposal, keeping it among the closed ones with its outcome.
function closeProposal(record: any, outcome: Record<string, unknown>) {
  record.proposals = [...(record.proposals ?? []), { ...record.proposal, ...outcome }].slice(-PROPOSALS_KEPT);
  record.proposal = null;
}

/** Whether a shaping record's rounds let its item cite a requirement file that is not Approved: some round is answered, and no question is open. */
export function roundsAnswered(record: any) {
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  const open = (asked: any) => !asked.answer && !asked.withdrawn;
  if (questions.some(open)) return false;
  const rounds = new Set(questions.map((asked: any) => asked.round));
  return [...rounds].some((round) => questions.some((asked: any) => asked.round === round && asked.answer));
}

/**
 * Refuse with round_unanswered a change that adds requirement references to files that are not Approved to an item that is emerging before or after it,
 * while the item's shaping record has no answered round or has an open question, so no requirement is drafted for an item before the person answered a round.
 * Each change is { item, before, after, recordBefore, recordAfter, added }, with before null for a new entry.
 */
export async function refuseUnansweredRounds(context: any, changes: any[]) {
  for (const change of changes) {
    if (!change.added.length || change.after.decision || roundsAnswered(change.recordAfter)) continue;
    const pending = [];
    for (const file of [...new Set(change.added.map(referenceFile))] as string[]) {
      if (!(await context.copies(file)).some((copy: any) => copy.status === "Approved")) pending.push(file);
    }
    if (!pending.length) continue;
    const stageOf = async (entry: any, record: any) => entry ? itemStage(entry, record, await citedArtifacts(context, entry, record)) : null;
    if (await stageOf(change.before, change.recordBefore) !== "emerging" && await stageOf(change.after, change.recordAfter) !== "emerging") continue;
    const open = (change.recordAfter?.questions ?? []).some((asked: any) => !asked.answer && !asked.withdrawn);
    const why = open ? "has a question that is neither answered nor withdrawn" : "has no answered question round";
    throw fail("round_unanswered", `${change.item} is an emerging work item whose shaping ${why}, so it cannot cite ${pending.join(", ")}, which ${pending.length === 1 ? "is" : "are"} not Approved: ask a round with update_work_item ask_round and cite once the person has answered it; nothing changed.`, { item: change.item });
  }
}

// The roadmap entry of an item, refusing an identifier that names none.
async function roadmapEntry(projectRoot: string, item: string) {
  const roadmap = await readRoadmapRecord(projectRoot);
  if (!roadmap.valid) throw fail("invalid_roadmap", "The roadmap record is invalid, so its work items cannot be read.", { errors: roadmap.errors });
  const entries = roadmap.record?.initiatives ?? [];
  const entry = entries.find((candidate: any) => candidate.id === item);
  if (!entry) throw fail("item_unknown", `The roadmap has no entry ${item}, so it names no work item.`, { item });
  return { roadmap, entries, entry };
}

const STATUS_LINE = /^Status:[ \t]*(\S.*?)[ \t]*$/m;

/**
 * What the work items of a project read about the artifacts they cite, each read once per call: recorded statuses in a project with a store, Status: lines in one without,
 * and the other items' shaping records for whom else cites an ADR.
 */
export function citationContext(projectRoot: string, config: any, entries: any[]) {
  const store = (config.workspace?.store ?? null) !== null;
  let statuses: Promise<Map<string, any[]>> | null = null;
  let records: Promise<Map<string, any>> | null = null;
  const storeStatuses = () => statuses ??= storeArtifactStatuses(projectRoot).then((listed: any[]) => {
    const byPath = new Map<string, any[]>();
    for (const entry of listed) byPath.set(entry.path, [...(byPath.get(entry.path) ?? []), entry]);
    return byPath;
  });
  const shapingRecords = () => records ??= (async () => {
    const found = new Map();
    const ids = new Set(entries.map((entry: any) => entry.id));
    for (const id of await listWorkItemRecords(projectRoot)) {
      if (!ids.has(id)) continue;
      const read = await readShapingRecord(projectRoot, id).catch(() => null);
      if (read?.record) found.set(id, read.record);
    }
    return found;
  })();
  return {
    projectRoot, config, entries, store, shapingRecords,
    // The copies of a cited file: one { scope, status } per seen scope that holds it, or one with scope and status null when none does.
    async copies(file: string) {
      if (store) {
        const held = (await storeStatuses()).get(file) ?? [];
        return held.length ? held.map((entry: any) => ({ scope: entry.scope, status: entry.status })) : [{ scope: null, status: null }];
      }
      const content = await readFile(path.join(projectRoot, file), "utf8").catch(() => null);
      return [{ scope: null, status: content === null ? null : STATUS_LINE.exec(content)?.[1] ?? null }];
    },
    // The bytes of a cited file, or null when it cannot be read as one copy.
    async bytes(file: string) {
      if (!store) return readFile(path.join(projectRoot, file)).catch(() => null);
      const copy = await storeArtifactCopy(projectRoot, file).catch(() => null);
      return copy?.held?.bytes ?? null;
    }
  };
}

/** The artifacts an item cites: { path, scope, kind, status, citedBy } for each copy of each requirement file its entry references and each ADR its record cites. */
export async function citedArtifacts(context: any, entry: any, record: any) {
  const files: [string, string][] = [];
  for (const reference of Array.isArray(entry.requirements) ? entry.requirements : []) {
    const file = referenceFile(reference);
    if (!files.some(([known, kind]) => known === file && kind === "requirements")) files.push([file, "requirements"]);
  }
  for (const file of record?.adrs ?? []) if (!files.some(([known, kind]) => known === file && kind === "adrs")) files.push([file, "adrs"]);
  const others = context.entries.filter((candidate: any) => candidate.id !== entry.id);
  const records = files.some(([, kind]) => kind === "adrs") ? await context.shapingRecords() : new Map();
  const cited = [];
  for (const [file, kind] of files) {
    const citedBy = kind === "requirements"
      ? others.filter((candidate: any) => (candidate.requirements ?? []).some((reference: string) => referenceFile(reference) === file)).map((candidate: any) => candidate.id)
      : others.filter((candidate: any) => (records.get(candidate.id)?.adrs ?? []).includes(file)).map((candidate: any) => candidate.id);
    for (const copy of await context.copies(file)) cited.push({ path: file, scope: copy.scope, kind, status: copy.status, citedBy });
  }
  return cited;
}

/**
 * The unmet readiness conditions of an open item, in order: no Approved requirement file, each one that is not Approved, each Draft ADR that breaks the ADR format,
 * and each blocking question of its shaping record that is neither answered nor withdrawn.
 */
export async function unmetConditions(context: any, cited: any[], record: any) {
  const requirements = cited.filter((artifact) => artifact.kind === "requirements");
  const unmet: any[] = [];
  if (!requirements.some((artifact) => artifact.status === "Approved")) unmet.push({ code: "no_approved_requirement" });
  for (const artifact of requirements) if (artifact.status !== "Approved") unmet.push({ code: "requirement_not_approved", path: artifact.path, scope: artifact.scope, status: artifact.status });
  for (const artifact of cited.filter((candidate) => candidate.kind === "adrs" && candidate.status === "Draft")) {
    const bytes = await context.bytes(artifact.path);
    if (bytes === null) continue;
    const { findings } = await checkArtifactContent({ path: artifact.path, type: "adr", bytes, status: "Draft" });
    if (findings.length) unmet.push({ code: "draft_adr_nonconforming", path: artifact.path, scope: artifact.scope, findings });
  }
  for (const asked of record?.questions ?? []) if (asked.blocking && !asked.answer && !asked.withdrawn) unmet.push({ code: "question_unanswered", question: asked.id, text: asked.question });
  return unmet;
}

/** An item's stage: the decision's kind for a decided entry, else emerging while it cites no Approved requirement file or has a shaping record without a ready mark, else ready. */
export function itemStage(entry: any, record: any, cited: any[]) {
  if (entry.decision) return entry.decision.kind;
  const approved = cited.some((artifact) => artifact.kind === "requirements" && artifact.status === "Approved");
  return !approved || (record && !record.ready) ? "emerging" : "ready";
}

async function describeItem(context: any, entry: any, record: any) {
  const cited = await citedArtifacts(context, entry, record);
  const stage = itemStage(entry, record, cited);
  return { cited, stage, unmet: entry.decision ? [] : await unmetConditions(context, cited, record) };
}

/**
 * The stage and unmet readiness conditions of each roadmap entry, by id, as get_roadmap adds them to its derived entries: { stage, unmet },
 * with problem { code, message } in place of conditions when the item's records cannot be read.
 */
export async function workItemStages(projectRoot: string, config: any, entries: any[]) {
  const context = citationContext(projectRoot, config, entries);
  const stages = new Map();
  for (const entry of entries) {
    try {
      const { record } = await readShapingRecord(projectRoot, entry.id);
      const { stage, unmet } = await describeItem(context, entry, record);
      stages.set(entry.id, { stage, unmet });
    } catch (error) {
      stages.set(entry.id, { stage: entry.decision ? entry.decision.kind : "emerging", unmet: [], problem: { code: error?.code ?? "work_item_unreadable", message: error?.message ?? String(error) } });
    }
  }
  return stages;
}

// Every comment that people left on an item's cited store artifacts after the record last changed, or every one before the record exists, oldest first.
async function commentsSince(context: any, record: any, cited: any[]) {
  if (!context.store) return [];
  const since = record?.changedAt ?? null;
  const comments = [];
  const read = new Set();
  for (const artifact of cited) {
    if (artifact.scope === null) continue;
    const key = `${artifact.scope.label}\0${artifact.path}`;
    if (read.has(key)) continue;
    read.add(key);
    for (const comment of await storeArtifactComments(context.projectRoot, artifact.path, artifact.scope.label)) {
      if (since !== null && !(comment.at > since)) continue;
      comments.push({ artifact: { path: artifact.path, scope: artifact.scope }, id: comment.id, line: comment.line, text: comment.text, author: comment.author, at: comment.at });
    }
  }
  return comments.sort((left, right) => left.at < right.at ? -1 : left.at > right.at ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** Read one work item: its entry's facts, stage and unmet conditions, shaping record and revision, cited artifacts, and the comments made on them since the record changed. */
export async function getWorkItem(input: any) {
  validateInput(GET_WORK_ITEM_SCHEMA, input);
  const config = await readWorkflowConfig(input.projectRoot);
  const { entries, entry } = await roadmapEntry(input.projectRoot, input.item);
  const { revision, record } = await readShapingRecord(input.projectRoot, entry.id);
  const context = citationContext(input.projectRoot, config, entries);
  const { cited, stage, unmet } = await describeItem(context, entry, record);
  return {
    item: entry.id, title: entry.title, intent: entry.intent, band: entry.band, stage, unmet, revision, record,
    requirements: [...(entry.requirements ?? [])], cited, comments: await commentsSince(context, record, cited), proposal: record?.proposal ?? null
  };
}

/**
 * Apply revision-checked operations to an item's shaping record, all or none: the record is written only when its own fields change, with changedAt the time of the update,
 * and requirement references that cite and uncite name land on the item's roadmap entry through update_roadmap.
 */
export async function updateWorkItem(input: any) {
  validateInput(UPDATE_WORK_ITEM_SCHEMA, input);
  const config = await readWorkflowConfig(input.projectRoot);
  const { entry: named } = await roadmapEntry(input.projectRoot, input.item);
  return withRecordLock(input.projectRoot, { kind: "work-item", initiative: named.id }, async (located: any) => {
    let bytes;
    try { bytes = await readStoreFileBytes(located.target, RECORD_MAX_BYTES); }
    catch (error) { if (!error?.tooLarge) throw error; throw fail("invalid_work_item", `The shaping record of ${named.id} is larger than its bound, so it was not changed.`, { item: named.id }); }
    const current = parseShapingRecord(named.id, bytes);
    if (current.revision !== input.expectedRevision) {
      throw fail("revision_conflict", revisionMismatch("shaping record", input.expectedRevision, current.revision), { currentRevision: current.revision });
    }
    // An update_roadmap that lands between this read of the roadmap and its write applies the operations again to the entry it left,
    // because the revision a caller holds is the shaping record's, which no roadmap write changes.
    for (let attempt = 1; ; attempt++) {
      const { roadmap, entries, entry } = await roadmapEntry(input.projectRoot, named.id);
      if (entry.decision) throw fail("item_closed", `${entry.id} has a ${entry.decision.kind} decision, so its work item is closed and nothing changed.`, { item: entry.id, decision: entry.decision.kind });
      const at = new Date().toISOString();
      const held = [...(entry.requirements ?? [])];
      const applied = applyOperations(config, current.record, held, input.operations, at);
      // A request for readiness is checked against the record as it is, and records the proposal whose gate it opens below.
      const opening: { gate: any; purpose: string }[] = applied.asks.map((asked: any) => ({ gate: questionGate(entry, asked), purpose: "question" }));
      if (applied.readyRequested) {
        const readContext = citationContext(input.projectRoot, config, entries);
        const { cited, unmet } = await describeItem(readContext, entry, applied.record);
        if (unmet.length) throw fail("readiness_unmet", `${entry.id} cannot be confirmed ready, so no gate was opened. ${describeUnmet(unmet)}`, { item: entry.id, unmet });
        applied.record.proposal = { kind: "ready", gate: GATE_PENDING };
        opening.push({ gate: readyGate(entry, cited), purpose: "ready" });
      }
      const requirementsChanged = canonicalJson(applied.requirements) !== canonicalJson(held);
      // Requirement references live on the roadmap entry, so a change to them alone neither creates the shaping record nor rewrites it, except to clear a ready mark or a pending proposal.
      const recordChanged = canonicalJson({ ...applied.record, changedAt: null }) !== canonicalJson({ ...(current.record ?? emptyShapingRecord()), changedAt: null });
      const updatedEntry = { ...entry, requirements: applied.requirements };
      const context = citationContext(input.projectRoot, config, entries.map((candidate: any) => candidate.id === entry.id ? updatedEntry : candidate));
      const afterRecord = recordChanged ? applied.record : current.record;
      await refuseUnansweredRounds(context, [{ item: entry.id, before: entry, after: updatedEntry, recordBefore: current.record, recordAfter: afterRecord, added: applied.added }]);
      let { revision, record } = current;
      let contents = null;
      if (recordChanged) {
        record = { ...applied.record, changedAt: at };
        contents = serialize(record);
        if (Buffer.byteLength(contents) > RECORD_MAX_BYTES) throw fail("artifact_too_large", `The shaping record of ${entry.id} would exceed its bound, so nothing changed.`, { item: entry.id });
      }
      // The roadmap is written after every check of the record and before the record, so a refused citation, such as of a requirement file that breaks its format, leaves the shaping record as it was.
      const writeReferences = async (requirements: string[], expectedRevision: string | null, shaping: any) => updateRoadmap(
        { projectRoot: input.projectRoot, expectedRevision, actor: input.actor ?? "agent", operations: [{ op: "update_initiative", id: entry.id, requirements }] },
        { shapingRecords: new Map([[entry.id, shaping]]) }
      );
      let written: any = null;
      if (requirementsChanged) {
        try {
          written = await writeReferences(applied.requirements, roadmap.revision, afterRecord);
        } catch (error) {
          if (!(error instanceof RoadmapError && error.code === "revision_conflict")) throw error;
          if (attempt < ROADMAP_ATTEMPTS) continue;
          throw fail("revision_conflict", `The roadmap changed during each of ${ROADMAP_ATTEMPTS} attempts to write ${entry.id}'s requirement references, so nothing changed; retry at the shaping record's current revision.`, { currentRevision: current.revision });
        }
      }
      // A later step that fails puts the entry's references back as they were, so the update stays all or none.
      const restoreReferences = async () => {
        if (written === null) return;
        await writeReferences(held, written.revision as string, current.record).catch(() => {});
      };
      let opened: any[] = [];
      try {
        opened = await changeGates(input.projectRoot, entry, opening.map((item) => item.gate), applied.withdrawals);
      } catch (error) {
        await restoreReferences();
        throw error;
      }
      if (contents !== null) {
        applied.asks.forEach((asked: any, index: number) => {
          const question = record.questions.find((candidate: any) => candidate.id === asked.id);
          question.gate = opened[index].id;
        });
        if (applied.readyRequested) record.proposal = { kind: "ready", gate: opened[applied.asks.length].id };
        contents = serialize(record);
        try {
          await writeRecord(input.projectRoot, { kind: "work-item", initiative: entry.id }, contents);
        } catch (error) {
          await withdrawGates(input.projectRoot, entry.id, opened.map((gate) => gate.id), "The work item update that asked this question failed, so the question was withdrawn.").catch(() => {});
          await restoreReferences();
          throw error;
        }
        revision = revisionOf(Buffer.from(contents, "utf8"));
      }
      const { stage, unmet } = await describeItem(context, updatedEntry, record);
      return { item: entry.id, revision, previousRevision: current.revision, record, stage, unmet, openedGates: opened.map((gate, index) => ({ id: gate.id, kind: gate.kind, purpose: opening[index].purpose })) };
    }
  }, fail);
}

const WITHDRAWN_QUESTION = "The question was withdrawn from the work item's shaping, so it needs no answer.";
const WITHDRAWN_PROPOSAL = "The work item's shaping changed after this was asked, so it was withdrawn; a new confirmation covers the record as it is now.";
const STATE_ATTEMPTS = 5;

// The context of a question's gate: the item it shapes, what the answer settles, and whether the item can become ready without it.
function questionContext(entry: any, asked: any) {
  return [
    `Shaping the work item ${entry.title} (${entry.id}): ${entry.intent}`,
    `What the answer settles: ${asked.settles}`,
    asked.blocking ? "The item cannot become ready until this question is answered." : "The item can become ready without an answer to this question.",
    "Choose the recommended answer, adding a note if you want, or answer in your own words with a note alone."
  ].join("\n\n");
}

// The decision gate of an asked question.
function questionGate(entry: any, asked: any) {
  return {
    op: "ask",
    kind: "decision",
    question: asked.question,
    context: questionContext(entry, asked),
    artifacts: [],
    options: [{ id: "recommended", label: asked.recommended, consequence: "Shaping goes on with the recommended answer, and with your note when you add one." }],
    recommended: { option: "recommended", reason: "This is the answer that shaping recommends; to give another, answer with a note instead." }
  };
}

const scopeLabel = (scope: any) => scope?.label ? ` (${scope.label})` : "";

// The decision gate that asks the person to confirm an item ready, listing each artifact it cites with its status.
function readyGate(entry: any, cited: any[]) {
  const listed = cited.map((artifact) => `- ${artifact.path}${scopeLabel(artifact.scope)}: ${artifact.status ?? "missing"}`);
  return {
    op: "ask",
    kind: "decision",
    question: `Is the work item ${entry.title} ready for design?`,
    context: [
      `Shaping the work item ${entry.title} (${entry.id}): ${entry.intent}`,
      `It cites:\n${listed.join("\n")}`,
      "Confirming it ready lets design start on it; any later change to its shaping asks for a new confirmation."
    ].join("\n\n"),
    artifacts: [],
    options: [
      { id: "ready", label: "Ready", consequence: "The item is ready, and design may start on it." },
      { id: "not-ready", label: "Not ready", consequence: "The item stays emerging, and your note says what it still needs." }
    ],
    recommended: { option: "ready", reason: "Every readiness condition that Prism checks is met." }
  };
}

/** One sentence per unmet readiness condition, naming its file or question. */
export function describeUnmet(unmet: any[]) {
  return unmet.map((condition) => {
    switch (condition.code) {
      case "no_approved_requirement": return "It cites no Approved requirement file.";
      case "requirement_not_approved": return `It cites ${condition.path}${scopeLabel(condition.scope)}, which is ${condition.status ?? "missing"} rather than Approved.`;
      case "draft_adr_nonconforming": return `It cites the Draft ADR ${condition.path}${scopeLabel(condition.scope)}, which breaks the ADR format.`;
      case "question_unanswered": return `Its blocking question ${JSON.stringify(condition.text)} (${condition.question}) is neither answered nor withdrawn.`;
      case "not_confirmed": return "The person has not confirmed it ready; ask with update_work_item request_ready.";
      default: return `It has the unmet condition ${condition.code}.`;
    }
  }).join(" ");
}

// The gates an update opens, in the item's coordination state as the calling session asks any gate, and each withdrawn gate that is still open closed: the opened gates, in order.
async function changeGates(projectRoot: string, entry: any, asking: any[], withdrawals: { id: string; reason: string }[]) {
  if (!asking.length && !withdrawals.length) return [];
  for (let attempt = 1; ; attempt++) {
    const state = await readCoordinationState({ projectRoot, initiative: entry.id });
    const pending = new Set((state.state?.pending ?? []).map((gate: any) => gate?.id));
    const closing = withdrawals.filter(({ id }) => pending.has(id)).map(({ id, reason }) => ({ op: "resolve", id, reason }));
    if (!asking.length && !closing.length) return [];
    try {
      const result = await updateCoordinationState({ projectRoot, initiative: entry.id, expectedRevision: state.revision, changes: { gateOperations: [...closing, ...asking] } });
      return result.openedGates;
    } catch (error) {
      if (error?.code !== "revision_conflict" || attempt >= STATE_ATTEMPTS) throw error;
    }
  }
}

// Close gates that a failed update opened, so it leaves no question behind.
async function withdrawGates(projectRoot: string, item: string, ids: string[], reason: string) {
  if (!ids.length) return;
  const state = await readCoordinationState({ projectRoot, initiative: item });
  const pending = new Set((state.state?.pending ?? []).map((gate: any) => gate?.id));
  const closing = ids.filter((id) => pending.has(id)).map((id) => ({ op: "resolve", id, reason }));
  if (closing.length) await updateCoordinationState({ projectRoot, initiative: item, expectedRevision: state.revision, changes: { gateOperations: closing } });
}

/**
 * Record a person's answer to a work item's gate in the review app action that answers it: write() records the answer on the gate and returns the action's
 * history entry, or null when nothing changed. When the gate is an unanswered question of the item's shaping record, the question records
 * answer { text, choice, answeredAt, by }, with text the note for a free answer and the recommended answer followed by the note for recommended.
 * When it is the gate of the pending ready proposal, ready records ready { gate, at, by } while no readiness condition is unmet and otherwise closes the proposal
 * with outcome unmet and the conditions, not-ready closes it with the note, and a free answer closes it as declined with the note.
 * Both happen under the record's lock and leave changedAt as it was. Returns what write() returned.
 */
export async function recordWorkItemAnswer({ projectRoot, item, gate, write }: { projectRoot: string; item: string; gate: string; write: () => Promise<any> }) {
  const asking = (record: any) => (record?.questions ?? []).find((asked: any) => asked.gate === gate && !asked.answer && !asked.withdrawn) ?? null;
  const proposing = (record: any) => record?.proposal?.gate === gate ? record.proposal : null;
  const seen = await readShapingRecord(projectRoot, item).catch(() => null);
  if (!asking(seen?.record) && !proposing(seen?.record)) return write();
  return withRecordLock(projectRoot, { kind: "work-item", initiative: item }, async (located: any) => {
    const current = parseShapingRecord(item, await readStoreFileBytes(located.target, RECORD_MAX_BYTES));
    const entry = await write();
    const asked = asking(current.record);
    const proposal = proposing(current.record);
    if (!entry || (!asked && !proposal)) return entry;
    const choice = entry.after?.choice ?? null;
    const note = typeof entry.after?.note === "string" && entry.after.note.trim() ? entry.after.note.trim() : null;
    const record = structuredClone(current.record);
    if (asked) {
      const text = choice === "recommended" ? [asked.recommended, note].filter(Boolean).join(" ") : note ?? "";
      const question = record.questions.find((candidate: any) => candidate.id === asked.id);
      question.answer = { text, choice, answeredAt: entry.at, by: entry.by };
    } else {
      const closed = { at: entry.at, by: entry.by, ...(note === null ? {} : { note }) };
      if (choice === null) closeProposal(record, { outcome: "declined", ...closed });
      else if (proposal.kind === "ready" && choice === "not-ready") closeProposal(record, { outcome: "not-ready", ...closed });
      else if (proposal.kind === "ready" && choice === "ready") {
        // The conditions are read again at the answer, so a requirement that lost its approval since the gate was asked leaves the item emerging.
        const config = await readWorkflowConfig(projectRoot);
        const { entries, entry: roadmapItem } = await roadmapEntry(projectRoot, item);
        const context = citationContext(projectRoot, config, entries);
        const unmet = roadmapItem.decision ? [] : await unmetConditions(context, await citedArtifacts(context, roadmapItem, record), record);
        if (unmet.length) closeProposal(record, { outcome: "unmet", unmet, ...closed });
        else {
          closeProposal(record, { outcome: "ready", ...closed });
          record.ready = { gate, at: entry.at, by: entry.by };
        }
      } else return entry;
    }
    await writeRecord(projectRoot, { kind: "work-item", initiative: item }, serialize(record));
    return entry;
  }, fail);
}

/**
 * Why design may not start on a roadmap entry: { item, unmet, message } while the entry is an open emerging work item, where unmet lists its readiness conditions
 * and not_confirmed when its shaping record has no ready mark, or null when the entry is ready, decided, or no roadmap entry has the identifier.
 */
export async function emergingRefusal(projectRoot: string, initiative: string) {
  const roadmap = await readRoadmapRecord(projectRoot);
  if (!roadmap.valid) return null;
  const entries = roadmap.record?.initiatives ?? [];
  const entry = entries.find((candidate: any) => candidate.id === initiative);
  if (!entry || entry.decision) return null;
  const config = await readWorkflowConfig(projectRoot);
  const { record } = await readShapingRecord(projectRoot, entry.id);
  const { stage, unmet } = await describeItem(citationContext(projectRoot, config, entries), entry, record);
  if (stage !== "emerging") return null;
  const conditions = [...unmet, ...(record && !record.ready ? [{ code: "not_confirmed" }] : [])];
  return { item: entry.id, unmet: conditions, message: `${entry.id} is an emerging work item, so design cannot start on it. ${describeUnmet(conditions)} Shape it with update_work_item until the person confirms it ready; nothing changed.` };
}

const ROADMAP_ATTEMPTS = 5;

export const WORK_ITEM_TOOLS = [
  {
    name: "get_work_item",
    description: "Read one work item, a roadmap entry addressed by its roadmap identifier as item, refusing an identifier that names no entry with item_unknown. Returns item, title, intent, band, stage (emerging while the entry cites no Approved requirement file or has a shaping record without a ready mark, ready otherwise, or the decision's kind for a decided entry), unmet (the readiness conditions it does not meet, in order: no_approved_requirement, requirement_not_approved with path, scope, and status per cited requirement file that is not Approved, draft_adr_nonconforming with path, scope, and findings per cited Draft ADR that breaks the ADR format, and question_unanswered with question and text per blocking question that is neither answered nor withdrawn), revision (the SHA-256 of the shaping record, or null before it has one, which update_work_item takes as expectedRevision), record (the shaping record { inputs, questions, findings, gaps, adrs, ready, origin, merges, splitInto, mergedInto, kill, changedAt }, or null), requirements (the entry's requirement references), cited ({ path, scope, kind, status, citedBy } per cited requirement file and ADR, with status null for a file that does not exist and citedBy the other work items that cite it), comments (every comment people left on a cited store artifact after the record's changedAt, or every one while it has none, oldest first, as { artifact: { path, scope }, id, line, text, author, at }), and proposal (the pending proposal, such as { kind: \"ready\", gate }, or null). Read the comments as the person's input to the item.",
    inputSchema: GET_WORK_ITEM_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_work_item",
    description: "Apply 1 to 50 operations to a work item's shaping record at expectedRevision, the revision get_work_item returned, all or none: add_input { link, note } records a link, a URI with a scheme such as https://… or notion://…, or a project-relative path, with a one-line note of at most 300 characters, and never the linked content; add_finding { text, source } records a finding with the link it came from, refusing one without a source with source_missing; add_research_gap { note } records research that could not reach outside sources, never as a finding; cite { requirements?, adrs? } adds requirement references, written as the roadmap writes them such as billing.md§2, to the item's roadmap entry and ADR paths below the configured ADRs folder to the record, ignoring ones already cited, and uncite removes them. ask_round { questions } asks a round of 1 to 5 questions, each { question, recommended (at most 200 characters), settles (at most 1000, what the answer settles), blocking (true when the item cannot become ready without the answer) }, recording each as { id, round, question, recommended, settles, blocking, gate, askedAt, answer: null, withdrawn: false } and opening one decision gate per question in the item's coordination state, which you ask the person and wait on with wait_for_user_gate like any gate; when the person answers in the review app, Prism records answer { text, choice, answeredAt, by } on the question. withdraw_question { question } withdraws an unanswered question by its id and closes its gate, refusing an answered one with question_answered. request_ready {} stands alone in its update: while no readiness condition is unmet it opens a decision gate with the options ready and not-ready, recommending ready, whose context lists each cited artifact with its status, and records proposal { kind: \"ready\", gate }; with any unmet it is refused with readiness_unmet and unmet, opening no gate. When the person answers ready and every condition is still met, the record holds ready { gate, at, by } and the item is ready; a condition that became unmet closes the proposal with outcome unmet, not-ready closes it with the person's note, and a free answer closes it as declined. Any other update that changes the record or the entry's requirement references clears the ready mark and withdraws a pending proposal, closing its gates, so a confirmation covers the record as the person saw it; closed proposals stay under the record's proposals with their outcomes. Design starts on an item only once it is ready: update_initiative create and a design claim are refused with item_emerging while it is emerging. A cite, or an update_roadmap, that adds a reference to a requirement file that is not Approved to an emerging item is refused with round_unanswered while the item has no answered round, one whose questions are each answered or withdrawn with at least one answered, or has a question that is neither answered nor withdrawn. A link of any other form is refused with link_invalid, an ADR path outside the ADRs folder and any other operation or field with validation_failed, an identifier that names no roadmap entry with item_unknown, a stale expectedRevision with revision_conflict and currentRevision, and any operation on a decided entry with item_closed naming the decision; a requirement reference to a file that breaks its format is refused with artifact_nonconforming as update_roadmap refuses it. No operation records an answer or anything a person said: the person adds to an item by answering its gates and commenting on what it cites. Returns { item, revision, previousRevision, record, stage, unmet, openedGates }, where each entry carries an id that Prism assigns and changedAt is the time of the last update that changed the record, and openedGates lists { id, kind, purpose } for each gate the update opened.",
    inputSchema: UPDATE_WORK_ITEM_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];
