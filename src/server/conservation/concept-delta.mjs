import { referenceSchema, deltaMetadata } from "./conservation-schema.mjs";
import { assertInput, checkSchema } from "../workflow/artifact-schema.mjs";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { normalizeRepositorySourcePath } from "../repository-intelligence/repository-source-path.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";

export const CONCEPT_DELTA_LIMITS = Object.freeze({ operations: 100, bytes: 1024 * 1024, page: 100, defaultPage: 50 });
export const CONCEPT_ACTIONS = ["KEEP", "MODIFY", "REPLACE", "DELETE", "ADD"];
const string = { type: "string", minLength: 1 };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const array = (items, extra = {}) => ({ type: "array", items, ...extra });
const evidenceSchema = object({
  method: string,
  receiptIds: array({ type: "string", pattern: "^[a-f0-9]{64}$" }),
  candidates: array(object({ reference: referenceSchema, candidateId: string, receiptId: string, disposition: { enum: ["REUSE", "REJECT", "PARTIAL"] }, reason: string }, ["reference", "disposition", "reason"])),
  justification: string, emptyResultReason: string
}, ["candidates", "justification"]);
const entryProperties = {
  id: string, kind: string, label: string, action: { enum: CONCEPT_ACTIONS },
  before: array(referenceSchema), after: array(referenceSchema), reason: string, reuseEvidence: evidenceSchema, requirements: array(referenceSchema)
};
const entrySchema = object(entryProperties, Object.keys(entryProperties).filter((key) => !["reuseEvidence", "requirements"].includes(key)));
const scopeSchema = array(string, { minItems: 1 });
const revisionSchema = { oneOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] };
const commonProperties = { projectRoot: string, deltaPath: string, expectedRevision: revisionSchema };
export const GET_CONCEPT_DELTA_SCHEMA = object({
  ...commonProperties, ids: array(string), offset: { type: "integer", minimum: 0 },
  limit: { type: "integer", minimum: 1, maximum: CONCEPT_DELTA_LIMITS.page }
}, ["projectRoot", "deltaPath"]);
export const UPDATE_CONCEPT_DELTA_SCHEMA = object({
  ...commonProperties, scope: scopeSchema, ...deltaMetadata, migrate: { type: "boolean" },
  operations: array({ oneOf: [
    object({ op: { const: "insert" }, entry: entrySchema }),
    object({ op: { const: "update" }, id: string, set: { ...object(Object.fromEntries(Object.entries(entryProperties).filter(([key]) => key !== "id")), []), minProperties: 1 } }),
    object({ op: { const: "remove" }, id: string })
  ] }, { maxItems: CONCEPT_DELTA_LIMITS.operations })
}, ["projectRoot", "deltaPath", "expectedRevision", "operations"]);
const documentSchema = object({ schemaVersion: { enum: [1, 2] }, scope: scopeSchema, concepts: array(entrySchema), ...deltaMetadata }, ["schemaVersion", "scope", "concepts"]);

export class ConceptDeltaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ConceptDeltaError";
    this.code = code;
    Object.assign(this, details);
  }
}
const failure = (code, message, details) => new ConceptDeltaError(code, message, details);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function safePath(value) {
  try { return normalizeRepositorySourcePath(value); }
  catch { throw failure("invalid_path", "Use a safe project-relative path."); }
}
const referenceKey = (ref) => JSON.stringify([ref.path, ref.selector ?? null]);
function canonicalReference(ref) {
  const selector = ref.selector && typeof ref.selector === "object" ? Object.fromEntries(Object.entries(ref.selector).sort(([a], [b]) => compare(a, b))) : ref.selector;
  return { path: safePath(ref.path), ...(selector === undefined ? {} : { selector }) };
}
function canonicalDocument(doc) {
  return {
    schemaVersion: doc.schemaVersion,
    ...Object.fromEntries(Object.keys(deltaMetadata).filter(key => doc[key] !== undefined).map(key => [key, doc[key]])),
    ...(doc.requirements === undefined ? {} : { requirements: doc.requirements.map(canonicalReference) }),
    ...(doc.growthJustifications === undefined ? {} : { growthJustifications: doc.growthJustifications.map(item => ({ ...item, requirements: item.requirements.map(canonicalReference) })) }),
    scope: doc.scope.map(safePath).sort(compare),
    concepts: doc.concepts.map((entry) => ({
      id: entry.id, kind: entry.kind, label: entry.label, action: entry.action,
      before: entry.before.map(canonicalReference).sort((a, b) => compare(referenceKey(a), referenceKey(b))),
      after: entry.after.map(canonicalReference).sort((a, b) => compare(referenceKey(a), referenceKey(b))),
      reason: entry.reason,
      ...(entry.requirements === undefined ? {} : { requirements: entry.requirements.map(canonicalReference) }),
      ...(entry.reuseEvidence === undefined ? {} : { reuseEvidence: {
        ...(entry.reuseEvidence.method === undefined ? {} : { method: entry.reuseEvidence.method }),
        ...(entry.reuseEvidence.receiptIds === undefined ? {} : { receiptIds: [...new Set(entry.reuseEvidence.receiptIds)].sort() }),
        ...(entry.reuseEvidence.emptyResultReason === undefined ? {} : { emptyResultReason: entry.reuseEvidence.emptyResultReason }),
        candidates: entry.reuseEvidence.candidates.map((candidate) => ({ ...(candidate.candidateId === undefined ? {} : { candidateId: candidate.candidateId }), ...(candidate.receiptId === undefined ? {} : { receiptId: candidate.receiptId }), reference: canonicalReference(candidate.reference), disposition: candidate.disposition, reason: candidate.reason })),
        justification: entry.reuseEvidence.justification
      } })
    })).sort((a, b) => compare(a.id, b.id))
  };
}
function validateDocument(raw) {
  const errors = [];
  const diagnostics = [];
  checkSchema(documentSchema, raw, "delta", errors);
  if (errors.length) return { valid: false, ready: false, errors, diagnostics, document: null };
  let document;
  try { document = canonicalDocument(raw); }
  catch (error) { return { valid: false, ready: false, errors: [error.message], diagnostics, document: null }; }
  if (new Set(document.scope).size !== document.scope.length) errors.push("delta.scope: contains duplicate paths");
  const ids = new Set();
  const owners = new Map();
  for (const entry of document.concepts) {
    const field = `concepts[${entry.id}]`;
    if (ids.has(entry.id)) errors.push(`${field}.id: is duplicated`);
    ids.add(entry.id);
    for (const side of ["before", "after"]) {
      const seen = new Set();
      for (const ref of entry[side]) {
        const key = referenceKey(ref);
        if (document.schemaVersion === 2 && !document.scope.some(prefix => ref.path === prefix || ref.path.startsWith(prefix + "/"))) errors.push(`${field}.${side}: ${ref.path} is outside the declared scope`);
        if (seen.has(key)) errors.push(`${field}.${side}: contains a duplicate reference`);
        seen.add(key);
        if (side === "before") {
          if (owners.has(key)) errors.push(`${field}.before: conflicts with ${owners.get(key)}`);
          else owners.set(key, entry.id);
        }
      }
    }
    const before = entry.before.length;
    const after = entry.after.length;
    if (entry.action === "ADD" && (before || !after)) errors.push(`${field}: ADD requires empty before and nonempty after`);
    if (entry.action === "DELETE" && (!before || after)) errors.push(`${field}: DELETE requires nonempty before and empty after`);
    if (entry.action === "REPLACE" && (!before || !after)) errors.push(`${field}: REPLACE requires nonempty before and after`);
    const identityRefs = refs => refs.map(ref => ({ path: ref.path, selector: typeof ref.selector === "object" && ref.selector.type === "span" ? { type: "span" } : ref.selector }));
    const sameIdentity = entry.action === "MODIFY" ? JSON.stringify(identityRefs(entry.before)) === JSON.stringify(identityRefs(entry.after)) : JSON.stringify(entry.before) === JSON.stringify(entry.after);
    if (["KEEP", "MODIFY"].includes(entry.action) && (!before || !sameIdentity)) {
      errors.push(`${field}: ${entry.action} requires the same nonempty before and after references`);
    }
    if (entry.action === "ADD" && entry.reuseEvidence === undefined) {
      diagnostics.push({ code: "addition_evidence_missing", id: entry.id, field: `${field}.reuseEvidence`, message: "Record a reuse search and an addition justification before FIT." });
    }
  }
  return { valid: !errors.length, ready: !errors.length && !diagnostics.length, errors, diagnostics, document };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export async function resolveArtifactPath(projectRoot, deltaPath, createParent = false, artifactName = "concept-delta.json") {
  if (!path.isAbsolute(projectRoot)) throw failure("invalid_path", "The project root must be absolute.");
  const root = await realpath(projectRoot);
  const relative = safePath(deltaPath);
  if (path.posix.basename(relative) !== artifactName || (["concept-delta.json", "review.json", "review.md"].includes(artifactName) && !relative.includes("/"))) {
    throw failure("invalid_path", "The deltaPath must name a slice concept-delta.json file.");
  }
  const target = path.resolve(root, relative);
  let ancestor = path.dirname(target);
  while (true) {
    try {
      if (!isInside(root, await realpath(ancestor))) throw failure("invalid_path", "The artifact parent resolves outside the project root.");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  if (createParent) await mkdir(path.dirname(target), { recursive: true });
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw failure("invalid_path", "The concept delta must be a regular file.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { root, target, deltaPath: relative };
}
async function loadDelta(resolved) {
  let handle;
  try { handle = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === "ENOENT") return { exists: false, revision: null, document: null, valid: true, ready: false, errors: [], diagnostics: [{ code: "delta_missing", message: "Create the concept delta before FIT." }] };
    throw error;
  }
  let contents;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw failure("invalid_path", "The concept delta must be a regular file.");
    if (info.size > CONCEPT_DELTA_LIMITS.bytes) throw failure("artifact_too_large", "The concept delta exceeds 1 MiB.");
    const buffer = Buffer.alloc(CONCEPT_DELTA_LIMITS.bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > CONCEPT_DELTA_LIMITS.bytes) throw failure("artifact_too_large", "The concept delta exceeds 1 MiB.");
    contents = buffer.subarray(0, length);
  } finally { await handle.close(); }
  const revision = createHash("sha256").update(contents).digest("hex");
  let raw;
  try { raw = JSON.parse(contents.toString("utf8")); }
  catch { return { exists: true, revision, document: null, valid: false, ready: false, errors: ["The concept delta must contain valid JSON."], diagnostics: [] }; }
  return { exists: true, revision, ...validateDocument(raw) };
}
async function assess(resolved, loaded) {
  if (!loaded.document || !loaded.valid) return loaded;
  if (loaded.document.schemaVersion === 1) return { ...loaded, ready: false, diagnostics: [...loaded.diagnostics, { code: "legacy_evidence", message: "Migrate the delta with a retained baseline before a new audit." }] };
  const { assessDeltaReadiness } = await import("./conservation-analysis.mjs");
  const diagnostics = await assessDeltaReadiness(resolved.root, loaded.document);
  return { ...loaded, ready: loaded.ready && diagnostics.every(item => item.blocking === false), diagnostics: [...loaded.diagnostics, ...diagnostics] };
}
function summary(resolved, loaded) {
  const counts = Object.fromEntries(CONCEPT_ACTIONS.map((action) => [action, 0]));
  for (const entry of loaded.document?.concepts ?? []) counts[entry.action]++;
  return { deltaPath: resolved.deltaPath, exists: loaded.exists, revision: loaded.revision, schemaVersion: loaded.document?.schemaVersion ?? null,
    ...Object.fromEntries(Object.keys(deltaMetadata).filter(key => loaded.document?.[key] !== undefined).map(key => [key, loaded.document[key]])),
    scope: loaded.document?.scope ?? [], totalCount: loaded.document?.concepts.length ?? 0, counts,
    valid: loaded.valid, ready: loaded.ready, errors: loaded.errors.slice(0, 50), diagnostics: loaded.diagnostics.slice(0, 50), totalDiagnostics: loaded.diagnostics.length };
}
function checkRevision(expected, loaded) {
  if (expected !== loaded.revision) throw failure("revision_conflict", "The concept delta changed. Read it again before retrying.", { currentRevision: loaded.revision });
}
export async function getConceptDelta(input) {
  assertInput(GET_CONCEPT_DELTA_SCHEMA, input);
  const resolved = await resolveArtifactPath(input.projectRoot, input.deltaPath);
  const loaded = await assess(resolved, await loadDelta(resolved));
  if (Object.hasOwn(input, "expectedRevision")) checkRevision(input.expectedRevision, loaded);
  const selected = (loaded.document?.concepts ?? []).filter((entry) => input.ids === undefined || input.ids.includes(entry.id));
  const offset = input.offset ?? 0;
  const limit = input.limit ?? CONCEPT_DELTA_LIMITS.defaultPage;
  return { ...summary(resolved, loaded), concepts: selected.slice(offset, offset + limit), selectedCount: selected.length,
    nextOffset: offset + limit < selected.length ? offset + limit : null };
}
export async function updateConceptDelta(input) {
  assertInput(UPDATE_CONCEPT_DELTA_SCHEMA, input);
  const resolved = await resolveArtifactPath(input.projectRoot, input.deltaPath, true);
  const { conservationStore } = await import("./conservation-store.mjs");
  if (input.expectedRevision === null || input.migrate) await conservationStore.registerSlice(resolved.root, resolved.deltaPath, input.migrate ? input.expectedRevision : undefined);
  return withArtifactLock(resolved.target, () => withFileLock(resolved.target, async () => {
    await resolveArtifactPath(input.projectRoot, input.deltaPath);
    const current = await loadDelta(resolved);
    checkRevision(input.expectedRevision, current);
    if (!current.valid) throw failure("invalid_delta", "The existing concept delta is invalid and was not changed.", { errors: current.errors });
    if (current.document?.schemaVersion === 1 && input.migrate !== true) throw failure("validation_failed", "Use migrate with a retained baseline before changing a legacy delta.");
    if (current.document?.baselineId && input.baselineId && current.document.baselineId !== input.baselineId) throw failure("validation_failed", "Corrections must preserve the original baseline.");
    const entries = new Map((current.document?.concepts ?? []).map((entry) => [entry.id, entry]));
    for (const [index, operation] of input.operations.entries()) {
      const field = `operations[${index}]`;
      if (operation.op === "insert") {
        if (entries.has(operation.entry.id)) throw failure("validation_failed", "The entry ID already exists.", { errors: [`${field}.entry.id: already exists`] });
        entries.set(operation.entry.id, operation.entry);
      } else {
        if (!entries.has(operation.id)) throw failure("validation_failed", "The entry ID does not exist.", { errors: [`${field}.id: does not exist`] });
        if (operation.op === "remove") entries.delete(operation.id);
        else entries.set(operation.id, { ...entries.get(operation.id), ...operation.set });
      }
    }
    const candidate = validateDocument({ schemaVersion: 2, scope: input.scope ?? current.document?.scope, concepts: [...entries.values()], ...Object.fromEntries(Object.keys(deltaMetadata).filter(key => input[key] !== undefined || current.document?.[key] !== undefined).map(key => [key, input[key] ?? current.document[key]])) });
    if (!candidate.valid) throw failure("validation_failed", "The proposed concept delta is invalid and was not written.", { errors: candidate.errors });
    const { conservationStore } = await import("./conservation-store.mjs");
    const outputs = [...await conservationStore.outputs(resolved.root), resolved.deltaPath, `${path.posix.dirname(resolved.deltaPath)}/review.json`, `${path.posix.dirname(resolved.deltaPath)}/review.md`];
    if (candidate.document.concepts.some(entry => [...entry.before, ...entry.after].some(ref => outputs.includes(ref.path)))) throw failure("invalid_path", "Managed evidence outputs cannot be target concepts.");
    const assessed = await assess(resolved, candidate);
    const contents = `${JSON.stringify(candidate.document, null, 2)}\n`;
    if (Buffer.byteLength(contents) > CONCEPT_DELTA_LIMITS.bytes) throw failure("artifact_too_large", "The concept delta exceeds 1 MiB.");
    let migrationEvidenceId;
    if (input.migrate && current.document?.schemaVersion === 1) {
      const { regularBytes } = await import("../repository-intelligence/native-semantic-runtime.mjs");
      const bytes = await regularBytes(resolved.target, CONCEPT_DELTA_LIMITS.bytes);
      migrationEvidenceId = await conservationStore.put(resolved.root, { kind: "migration", schemaVersion: 1, project: resolved.root, artifactPath: resolved.deltaPath, revision: current.revision, lines: bytes.toString().split("\n") });
    }
    await conservationStore.registerSlice(resolved.root, resolved.deltaPath, input.migrate ? current.revision : undefined);
    const changedIds = [...new Set([...entries.keys(), ...(current.document?.concepts ?? []).map((entry) => entry.id)])]
      .filter((id) => JSON.stringify(current.document?.concepts.find((entry) => entry.id === id)) !== JSON.stringify(candidate.document.concepts.find((entry) => entry.id === id))).sort(compare);
    const changed = !current.exists || JSON.stringify(current.document) !== JSON.stringify(candidate.document);
    if (changed) {
      await resolveArtifactPath(input.projectRoot, input.deltaPath);
      await conservationStore.writeManaged(resolved.root, resolved.target, contents);
    }
    const updated = { ...assessed, exists: true, revision: changed ? createHash("sha256").update(contents).digest("hex") : current.revision };
    return { ...summary(resolved, updated), created: !current.exists, previousRevision: current.revision, changedIds, ...(migrationEvidenceId ? { migrationEvidenceId } : {}) };
  }, failure));
}

export async function readConceptDeltaDocument(projectRoot, deltaPath, expectedRevision) {
  const resolved = await resolveArtifactPath(projectRoot, deltaPath);
  const loaded = await loadDelta(resolved);
  if (expectedRevision !== undefined) checkRevision(expectedRevision, loaded);
  if (!loaded.exists || !loaded.valid) throw failure("validation_failed", "The concept delta is missing or invalid.", { errors: loaded.errors });
  return { document: loaded.document, revision: loaded.revision };
}
