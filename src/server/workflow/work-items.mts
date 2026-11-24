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
/** The lists of a shaping record whose entries carry an identifier that Prism assigns, with the prefix of that identifier. */
const ENTRY_LISTS = Object.freeze([["inputs", "input"], ["questions", "question"], ["findings", "finding"], ["gaps", "gap"]]);
const ENTRY_ID = /^(input|question|finding|gap)-[0-9a-f]{8}$/;
const NOTE_MAX = 300;

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
    object({ op: { const: "uncite" }, requirements: paths, adrs: paths }, ["op"])
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

async function readShapingRecord(projectRoot: string, item: string) {
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

/** Apply operations to a copy of a shaping record and an entry's requirement references, refusing any that is invalid: { record, requirements }. */
function applyOperations(config: any, current: any, references: string[], operations: any[], at: string) {
  const record = structuredClone(current ?? emptyShapingRecord());
  let requirements = [...references];
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
          for (const reference of cited) if (!requirements.includes(reference)) requirements.push(reference);
          for (const file of adrs) if (!record.adrs.includes(file)) record.adrs.push(file);
        } else {
          requirements = requirements.filter((reference) => !cited.includes(reference));
          record.adrs = record.adrs.filter((file: string) => !adrs.includes(file));
        }
        break;
      }
      default:
        throw fail("validation_failed", `Unsupported operation ${operation.op}.`);
    }
  }
  return { record, requirements };
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

/** The unmet readiness conditions of an open item's cited artifacts, in order: no Approved requirement file, each one that is not Approved, and each Draft ADR that breaks the ADR format. */
export async function unmetConditions(context: any, cited: any[]) {
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
  return { cited, stage, unmet: entry.decision ? [] : await unmetConditions(context, cited) };
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
      const requirementsChanged = canonicalJson(applied.requirements) !== canonicalJson(held);
      // Requirement references live on the roadmap entry, so a change to them alone neither creates nor rewrites the shaping record.
      const recordChanged = canonicalJson({ ...applied.record, changedAt: null }) !== canonicalJson({ ...(current.record ?? emptyShapingRecord()), changedAt: null });
      let { revision, record } = current;
      let contents = null;
      if (recordChanged) {
        record = { ...applied.record, changedAt: at };
        contents = serialize(record);
        if (Buffer.byteLength(contents) > RECORD_MAX_BYTES) throw fail("artifact_too_large", `The shaping record of ${entry.id} would exceed its bound, so nothing changed.`, { item: entry.id });
      }
      // The roadmap is written after every check of the record and before the record, so a refused citation, such as of a requirement file that breaks its format, leaves the shaping record as it was.
      if (requirementsChanged) {
        try {
          await updateRoadmap({ projectRoot: input.projectRoot, expectedRevision: roadmap.revision, actor: input.actor ?? "agent", operations: [{ op: "update_initiative", id: entry.id, requirements: applied.requirements }] });
        } catch (error) {
          if (!(error instanceof RoadmapError && error.code === "revision_conflict")) throw error;
          if (attempt < ROADMAP_ATTEMPTS) continue;
          throw fail("revision_conflict", `The roadmap changed during each of ${ROADMAP_ATTEMPTS} attempts to write ${entry.id}'s requirement references, so nothing changed; retry at the shaping record's current revision.`, { currentRevision: current.revision });
        }
      }
      if (contents !== null) {
        await writeRecord(input.projectRoot, { kind: "work-item", initiative: entry.id }, contents);
        revision = revisionOf(Buffer.from(contents, "utf8"));
      }
      const updatedEntry = { ...entry, requirements: applied.requirements };
      const context = citationContext(input.projectRoot, config, entries.map((candidate: any) => candidate.id === entry.id ? updatedEntry : candidate));
      const { stage, unmet } = await describeItem(context, updatedEntry, record);
      return { item: entry.id, revision, previousRevision: current.revision, record, stage, unmet, openedGates: [] };
    }
  }, fail);
}

const ROADMAP_ATTEMPTS = 5;

export const WORK_ITEM_TOOLS = [
  {
    name: "get_work_item",
    description: "Read one work item, a roadmap entry addressed by its roadmap identifier as item, refusing an identifier that names no entry with item_unknown. Returns item, title, intent, band, stage (emerging while the entry cites no Approved requirement file or has a shaping record without a ready mark, ready otherwise, or the decision's kind for a decided entry), unmet (the readiness conditions it does not meet, in order: no_approved_requirement, requirement_not_approved with path, scope, and status per cited requirement file that is not Approved, and draft_adr_nonconforming with path, scope, and findings per cited Draft ADR that breaks the ADR format), revision (the SHA-256 of the shaping record, or null before it has one, which update_work_item takes as expectedRevision), record (the shaping record { inputs, questions, findings, gaps, adrs, ready, origin, merges, splitInto, mergedInto, kill, changedAt }, or null), requirements (the entry's requirement references), cited ({ path, scope, kind, status, citedBy } per cited requirement file and ADR, with status null for a file that does not exist and citedBy the other work items that cite it), comments (every comment people left on a cited store artifact after the record's changedAt, or every one while it has none, oldest first, as { artifact: { path, scope }, id, line, text, author, at }), and proposal (null). Read the comments as the person's input to the item.",
    inputSchema: GET_WORK_ITEM_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_work_item",
    description: "Apply 1 to 50 operations to a work item's shaping record at expectedRevision, the revision get_work_item returned, all or none: add_input { link, note } records a link, a URI with a scheme such as https://… or notion://…, or a project-relative path, with a one-line note of at most 300 characters, and never the linked content; add_finding { text, source } records a finding with the link it came from, refusing one without a source with source_missing; add_research_gap { note } records research that could not reach outside sources, never as a finding; cite { requirements?, adrs? } adds requirement references, written as the roadmap writes them such as billing.md§2, to the item's roadmap entry and ADR paths below the configured ADRs folder to the record, ignoring ones already cited, and uncite removes them. A link of any other form is refused with link_invalid, an ADR path outside the ADRs folder and any other operation or field with validation_failed, an identifier that names no roadmap entry with item_unknown, a stale expectedRevision with revision_conflict and currentRevision, and any operation on a decided entry with item_closed naming the decision; a requirement reference to a file that breaks its format is refused with artifact_nonconforming as update_roadmap refuses it. No operation records an answer or anything a person said: the person adds to an item by commenting on what it cites. Returns { item, revision, previousRevision, record, stage, unmet, openedGates }, where each entry carries an id that Prism assigns and changedAt is the time of the last update that changed the record.",
    inputSchema: UPDATE_WORK_ITEM_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];
