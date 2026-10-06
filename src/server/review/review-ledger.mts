import path from "node:path";
import { readFile } from "node:fs/promises";
import { withArtifactLock, withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { assertInput } from "../workflow/artifact-schema.mjs";
import { resolveArtifactPath, readConceptDeltaDocument } from "../conservation/concept-delta.mjs";
import { regularBytes } from "../repository-intelligence/native-semantic-runtime.mjs";
import { conservationStore, canonical, digest, conservationError, withinScope } from "../conservation/conservation-store.mjs";
import { assessDeltaReadiness, resolveReference, COMPARISON_VERSION } from "../conservation/conservation-analysis.mjs";
import { objectSchema as obj, arraySchema as arr, textField as str, hashField, referenceSchema, justificationSchema } from "../conservation/conservation-schema.mjs";
import type { ComparisonEvidence, DeltaDocument, Evidence, GrowthJustification, Observation, Reference, SnapshotEvidence } from "../conservation/conservation-types.mjs";

type Mode = "design-audit" | "implementation-review";
type Status = "OPEN" | "IN PROGRESS" | "FIXED" | "VERIFIED" | "REOPENED";
interface Actor { id: string; role: "coordinator" | "delivery" | "reviewer" }
interface Finding { id: string; localId: string; lane: string; mode: Mode; title: string; severity: string; affectedPath: string; evidence: string; conditionToClose: string; aliases: string[]; escalationTarget: string; probe?: string; status: Status; implementerEvidence: string; history: { actor: string; status: Status; wave: string; at: string; evidence: string }[] }
interface Lane { id: string; reviewer: string; coverage: string[]; result?: { status: "CLEAN" | "FINDINGS"; digest: string; reviewer: string } }
interface Wave { id: string; mode: Mode; deltaRevision: string; baselineId: string; snapshotId: string; comparisonId: string; lanes: Lane[]; accepted?: { evidenceDigest: string; actor: string; at: string } }
interface Assessment { id: string; wave: string; lane: string; kind: "manual" | "implementation-detail" | "growth" | "convergence"; reason: string; evidence: Reference[]; author: string; acceptedBy?: string; observationIds?: string[]; conceptId?: string; growthIds?: string[]; justification?: GrowthJustification; section?: Reference; decision?: string; conceptIds?: string[]; coverage?: { requirement: Reference; targets: Reference[] }[] }
interface Conflict { id: string; wave: string; lanes: string[]; reason: string; resolved?: { actor: string; reason: string } }
export interface ReviewRecord { schemaVersion: 1; deltaPath: string; coordinator: string; delivery: string; deliveryWorkers: string[]; baselineId?: string; waves: Wave[]; findings: Finding[]; assessments: Assessment[]; conflicts: Conflict[]; exchangeWorkers: string[]; legacy: { path: string; hash: string; content: string }[]; history: { actor: string; operation: string; at: string }[] }
const revisionField = { oneOf: [hashField, { type: "null" }] };
const common = { projectRoot: str, reviewPath: str, expectedRevision: revisionField };
const laneSchema = obj({ id: str, reviewer: str, coverage: arr(str) });
const assessmentCommon = { id: str, lane: str, reason: str, evidence: arr(referenceSchema) };
const assessmentSchema = { oneOf: [
  obj({ ...assessmentCommon, kind: { const: "manual" }, observationIds: arr(str) }),
  obj({ ...assessmentCommon, kind: { const: "implementation-detail" }, observationIds: arr(str), conceptId: str }),
  obj({ ...assessmentCommon, kind: { const: "growth" }, growthIds: arr(str), justification: justificationSchema }),
  obj({ ...assessmentCommon, kind: { const: "convergence" }, section: referenceSchema, decision: { enum: ["retain", "replace", "consolidate", "delete"] }, conceptIds: arr(str), coverage: arr(obj({ requirement: referenceSchema, targets: arr(referenceSchema) })) })
] };
export const GET_REVIEW_SCHEMA = obj({ ...common, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 }, section: { enum: ["findings", "waves", "assessments", "conflicts", "legacy", "history"] } }, ["projectRoot", "reviewPath"]);
export const UPDATE_REVIEW_SCHEMA = obj({ ...common, deltaPath: str, delivery: str, actor: obj({ id: str, role: { enum: ["coordinator", "delivery", "reviewer"] } }), operations: arr({ oneOf: [
  obj({ op: { const: "start_wave" }, id: str, mode: { enum: ["design-audit", "implementation-review"] }, deltaRevision: hashField, snapshotId: hashField, comparisonId: hashField, lanes: arr(laneSchema) }),
  obj({ op: { const: "assign_delivery" }, worker: str }),
  obj({ op: { const: "open_finding" }, lane: str, localId: str, title: str, severity: { enum: ["blocker", "high", "medium", "low"] }, affectedPath: str, evidence: str, conditionToClose: str, aliases: arr(str), escalationTarget: str, probe: str }, ["op", "lane", "localId", "title", "severity", "affectedPath", "evidence", "conditionToClose"]),
  obj({ op: { const: "set_finding_status" }, id: str, status: { enum: ["IN PROGRESS", "FIXED", "VERIFIED", "REOPENED"] }, evidence: str }),
  obj({ op: { const: "record_assessment" }, assessment: assessmentSchema }),
  obj({ op: { const: "accept_assessment" }, id: str }),
  obj({ op: { const: "record_exchange" }, reviewer: str }),
  obj({ op: { const: "open_conflict" }, id: str, lanes: arr(str), reason: str }),
  obj({ op: { const: "resolve_conflict" }, id: str, reason: str }),
  obj({ op: { const: "submit_lane" }, lane: str, status: { enum: ["CLEAN", "FINDINGS"] } }),
  obj({ op: { const: "carry_lane" }, lane: str, fromWave: str }),
  obj({ op: { const: "accept_wave" } }),
  obj({ op: { const: "import_legacy" }, path: str }),
  obj({ op: { const: "regenerate_markdown" } })
] }) }, ["projectRoot", "reviewPath", "expectedRevision", "actor", "operations"]);
export const CHECK_REVIEW_GATE_SCHEMA = obj({ projectRoot: str, reviewPath: str, expectedRevision: hashField, gate: { enum: ["implementation", "completion"] } }, ["projectRoot", "reviewPath", "gate"]);

interface Operation { op: string; [key: string]: unknown }
interface UpdateInput { projectRoot: string; reviewPath: string; expectedRevision: string | null; actor: Actor; deltaPath?: string; delivery?: string; operations: Operation[] }
const lastWave = (review: ReviewRecord) => review.waves.at(-1);
const laneOf = (wave: Wave, lane: string) => { const value = wave.lanes.find(item => item.id === lane); if (!value) throw conservationError("validation_failed", "The review lane is not assigned."); return value; };
const requireRole = (review: ReviewRecord, actor: Actor, role: Actor["role"]) => {
  if (actor.role !== role || (role === "coordinator" && actor.id !== review.coordinator) || (role === "delivery" && actor.id !== review.delivery)) throw conservationError("gate_blocked", "This worker does not own the requested review change.");
};
function reviewer(review: ReviewRecord, wave: Wave, actor: Actor, lane: string, fresh = false) {
  requireRole(review, actor, "reviewer");
  if (laneOf(wave, lane).reviewer !== actor.id || actor.id === review.coordinator || review.deliveryWorkers.includes(actor.id) || (fresh && review.exchangeWorkers.includes(actor.id))) throw conservationError("gate_blocked", "A fresh assigned reviewer must make this decision.");
}
function laneDigest(review: ReviewRecord, wave: Wave, lane: Lane) {
  return digest(canonical({ inputs: [wave.deltaRevision, wave.baselineId, wave.snapshotId, wave.comparisonId], lane: { id: lane.id, reviewer: lane.reviewer, coverage: lane.coverage },
    independent: lane.reviewer !== review.coordinator && !review.deliveryWorkers.includes(lane.reviewer) && !review.exchangeWorkers.includes(lane.reviewer),
    findings: review.findings.filter(item => item.mode === wave.mode && item.lane === lane.id),
    assessments: review.assessments.filter(item => item.wave === wave.id && item.lane === lane.id),
    conflicts: review.conflicts.filter(item => item.wave === wave.id && item.lanes.includes(lane.id)) }));
}
function waveDigest(review: ReviewRecord, wave: Wave) { return digest(canonical(wave.lanes.map(lane => ({ lane: lane.id, digest: laneDigest(review, wave, lane), result: lane.result })))); }
const recordSchema = obj({
  schemaVersion: { const: 1 }, deltaPath: str, coordinator: str, delivery: str, deliveryWorkers: arr(str, 10000), baselineId: hashField,
  waves: arr(obj({ id: str, mode: { enum: ["design-audit", "implementation-review"] }, deltaRevision: hashField, baselineId: hashField, snapshotId: hashField, comparisonId: hashField,
    lanes: arr(obj({ ...laneSchema.properties, result: obj({ status: { enum: ["CLEAN", "FINDINGS"] }, digest: hashField, reviewer: str }) }, ["id", "reviewer", "coverage"])),
    accepted: obj({ evidenceDigest: hashField, actor: str, at: str }) }, ["id", "mode", "deltaRevision", "baselineId", "snapshotId", "comparisonId", "lanes"]), 1000),
  findings: arr(obj({ id: str, localId: str, lane: str, mode: { enum: ["design-audit", "implementation-review"] }, title: str, severity: { enum: ["blocker", "high", "medium", "low"] }, affectedPath: str, evidence: str, conditionToClose: str, aliases: arr(str), escalationTarget: str, probe: str, status: { enum: ["OPEN", "IN PROGRESS", "FIXED", "VERIFIED", "REOPENED"] }, implementerEvidence: { type: "string" }, history: arr(obj({ actor: str, status: { enum: ["OPEN", "IN PROGRESS", "FIXED", "VERIFIED", "REOPENED"] }, wave: str, at: str, evidence: str }), 10000) }, ["id", "localId", "lane", "mode", "title", "severity", "affectedPath", "evidence", "conditionToClose", "aliases", "escalationTarget", "status", "implementerEvidence", "history"]), 10000),
  assessments: arr({ oneOf: assessmentSchema.oneOf.map(schema => obj({ ...schema.properties, wave: str, author: str, acceptedBy: str }, [...schema.required, "wave", "author"])) }, 10000),
  conflicts: arr(obj({ id: str, wave: str, lanes: arr(str), reason: str, resolved: obj({ actor: str, reason: str }) }, ["id", "wave", "lanes", "reason"]), 10000),
  exchangeWorkers: arr(str, 10000), legacy: arr(obj({ path: str, hash: hashField, content: { type: "string", maxLength: 1024 * 1024 } })),
  history: arr(obj({ actor: str, operation: str, at: str }), 10000)
}, ["schemaVersion", "deltaPath", "coordinator", "delivery", "deliveryWorkers", "waves", "findings", "assessments", "conflicts", "exchangeWorkers", "legacy", "history"]);
export async function loadReview(projectRoot: string, reviewPath: string) {
  const resolved = await resolveArtifactPath(projectRoot, reviewPath, false, "review.json");
  try {
    const bytes = await regularBytes(resolved.target, 4 * 1024 * 1024), document = JSON.parse(bytes.toString()) as ReviewRecord;
    assertInput(recordSchema, document);
    return { resolved, exists: true, revision: digest(bytes), document };
  } catch (error) { if (error.code === "ENOENT") return { resolved, exists: false, revision: null, document: null }; throw error; }
}
async function comparisonFor(projectRoot: string, review: ReviewRecord, wave: Wave) {
  const comparison = await conservationStore.get<ComparisonEvidence>(projectRoot, wave.comparisonId, "comparison");
  if (comparison.versions.comparison !== COMPARISON_VERSION) throw conservationError("evidence_missing", "Regenerate comparison evidence with the current identity and growth checks.");
  if (comparison.deltaPath !== review.deltaPath || comparison.deltaRevision !== wave.deltaRevision || comparison.baselineId !== wave.baselineId || comparison.resultSnapshotId !== wave.snapshotId) throw conservationError("evidence_missing", "The review inputs do not match the immutable comparison.");
  for (const id of [wave.baselineId, wave.snapshotId]) {
    const snapshot = await conservationStore.get<SnapshotEvidence>(projectRoot, id, "snapshot");
    for (const file of snapshot.files.filter(file => withinScope(file.file, comparison.scope))) await conservationStore.bytes(projectRoot, file);
  }
  return comparison;
}
function deferredDesignObservation(wave: Wave, observation: Observation) { return wave.mode === "design-audit" && (observation.code === "retained_source" || observation.code === "deletion_unknown" || (observation.code === "missing_target" && observation.side === "after")); }
async function boundAnalysis(projectRoot: string, comparison: ComparisonEvidence, side: "before" | "after") {
  const id = comparison.analysisIds?.[side];
  return id ? conservationStore.get<Extract<Evidence, { kind: "analysis" }>>(projectRoot, id, "analysis") : null;
}
async function assessmentValid(projectRoot: string, review: ReviewRecord, wave: Wave, assessment: Assessment, comparison: ComparisonEvidence, document: DeltaDocument) {
  if (!assessment.reason.trim() || !assessment.evidence.length) throw conservationError("validation_failed", "An assessment needs cited evidence and a reason.");
  const before = await conservationStore.get<SnapshotEvidence>(projectRoot, wave.baselineId, "snapshot"), after = await conservationStore.get<SnapshotEvidence>(projectRoot, wave.snapshotId, "snapshot");
  const a = await boundAnalysis(projectRoot, comparison, "before"), b = await boundAnalysis(projectRoot, comparison, "after");
  for (const reference of assessment.evidence) {
    const first = await resolveReference(projectRoot, after, reference, b), second = await resolveReference(projectRoot, before, reference, a);
    if (first.status !== "resolved" && second.status !== "resolved") throw conservationError("evidence_missing", "A cited evidence reference must resolve in a bound snapshot.");
  }
  if (["manual", "implementation-detail"].includes(assessment.kind)) {
    if (!assessment.observationIds?.length) throw conservationError("validation_failed", "Name the checks addressed by the assessment.");
    for (const id of assessment.observationIds) {
      const observation = comparison.observations.find(item => item.id === id);
      if (!observation || observation.severity === "failure") throw conservationError("gate_blocked", "A manual assessment cannot waive a known mechanical failure.");
      if (assessment.kind === "implementation-detail") {
        if (observation.code !== "unclassified_unit" || observation.unit?.public === true || !document.concepts.some(entry => entry.id === assessment.conceptId && ["MODIFY", "REPLACE", "ADD"].includes(entry.action))) throw conservationError("gate_blocked", "Attribute only private implementation detail to a changed planned concept.");
        for (const entry of document.concepts.filter(entry => entry.action === "DELETE")) for (const reference of entry.before) {
          const deleted = await resolveReference(projectRoot, before, reference, a);
          if (deleted.units.some(target => target.key === observation.unit?.key || comparison.units.before.some(unit => unit.key === observation.unit?.key && unit.file === target.file && unit.start >= target.start && unit.end <= target.end))) throw conservationError("gate_blocked", "An explicitly deleted concept cannot become another concept's implementation detail.");
        }
      } else if (observation.code === "unclassified_unit") throw conservationError("gate_blocked", "An unclassified unit requires a concept attribution or a design revision.");
    }
  }
  const boundRequirement = (reference: Reference) => document.requirements?.some(item => item.path === reference.path && (item.selector === undefined || canonical(item) === canonical(reference)));
  if (assessment.kind === "growth") {
    const justification = assessment.justification;
    if (!assessment.growthIds?.length || !justification?.requirements.length || justification.requirements.some(ref => !boundRequirement(ref))
      || !justification.conceptIds.length || justification.conceptIds.some(id => !document.concepts.some(entry => entry.id === id))) throw conservationError("gate_blocked", "Growth needs governing requirements and affected concepts.");
    for (const id of assessment.growthIds) {
      const growth = comparison.growth.find(item => item.id === id);
      if (!growth || !justification.dimensions.includes(growth.dimension)) throw conservationError("validation_failed", "The growth justification does not cover the measured increase.");
    }
    for (const requirement of justification.requirements) if ((await resolveReference(projectRoot, after, requirement, b)).status !== "resolved") throw conservationError("evidence_missing", "Each growth requirement must resolve in the resulting source.");
  }
  if (assessment.kind === "convergence") {
    if (!assessment.section || (await resolveReference(projectRoot, after, assessment.section, b)).status !== "resolved" && (await resolveReference(projectRoot, before, assessment.section, a)).status !== "resolved") throw conservationError("evidence_missing", "The convergence section must resolve without ambiguity in a bound snapshot.");
    for (const requirement of document.requirements || []) if (!assessment.coverage?.some(item => canonical(item.requirement) === canonical(requirement))) throw conservationError("gate_blocked", "The convergence assessment must retain every governing requirement.");
    for (const item of assessment.coverage || []) {
      if (!boundRequirement(item.requirement) || !item.targets.length) throw conservationError("gate_blocked", "Requirement coverage needs bound requirements and resulting targets.");
      for (const reference of item.targets) if ((await resolveReference(projectRoot, after, reference, b)).status !== "resolved") throw conservationError("evidence_missing", "A requirement coverage target must resolve in the result.");
    }
    const obligations = document.concepts.filter(entry => ["rule", "exception", "prohibition"].includes(entry.kind) && [...entry.before, ...entry.after].some(ref => ref.path === assessment.section!.path));
    if (obligations.some(entry => !assessment.conceptIds?.includes(entry.id))) throw conservationError("gate_blocked", "The convergence assessment must account for each identified obligation in the section.");
  }
}

async function waveProblems(projectRoot: string, review: ReviewRecord, wave: Wave, requireLaneResults: boolean) {
  const problems: { code: string; message: string; id?: string }[] = [];
  const add = (code: string, message: string, id?: string) => problems.push({ code, message, ...(id ? { id } : {}) });
  const loaded = await readConceptDeltaDocument(projectRoot, review.deltaPath, wave.deltaRevision), document = loaded.document as DeltaDocument;
  if (document.baselineId !== review.baselineId || wave.baselineId !== review.baselineId) add("baseline_changed", "The original baseline must remain unchanged.");
  for (const item of await assessDeltaReadiness(projectRoot, document)) if (item.blocking !== false) add(item.code, item.message, item.id);
  const comparison = await comparisonFor(projectRoot, review, wave);
  const accepted = review.assessments.filter(item => item.wave === wave.id && item.acceptedBy && !review.exchangeWorkers.includes(item.acceptedBy));
  for (const assessment of accepted) await assessmentValid(projectRoot, review, wave, assessment, comparison, document);
  for (const observation of comparison.observations) {
    if (deferredDesignObservation(wave, observation)) continue;
    if (observation.severity === "failure") add(observation.code, observation.message, observation.id);
    else if (!accepted.some(item => item.observationIds?.includes(observation.id))) add("manual_evidence_missing", observation.message, observation.id);
  }
  for (const growth of comparison.growth) if (!accepted.some(item => item.kind === "growth" && item.growthIds?.includes(growth.id))) add("growth_justification_missing", `Justify the increase in ${growth.dimension}.`, growth.id);
  const before = await conservationStore.get<SnapshotEvidence>(projectRoot, wave.baselineId, "snapshot"), after = await conservationStore.get<SnapshotEvidence>(projectRoot, wave.snapshotId, "snapshot");
  const changedText = [...new Set([...before.files, ...after.files].filter(file => /\.(md|markdown)$/i.test(file.file) && withinScope(file.file, document.scope)).map(file => file.file))]
    .filter(file => before.files.find(item => item.file === file)?.hash !== after.files.find(item => item.file === file)?.hash);
  for (const file of changedText) {
    const assessments = accepted.filter(item => item.kind === "convergence" && item.section?.path === file);
    for (const side of ["before", "after"] as const) {
      const snapshot = side === "before" ? before : after, analysis = await boundAnalysis(projectRoot, comparison, side);
      const changed = comparison.units[side].filter(unit => unit.file === file && unit.kind !== "file" && !comparison.units[side === "before" ? "after" : "before"].some(other => other.key === unit.key && other.hash === unit.hash));
      const targets = changed.length ? changed.filter(unit => !changed.some(child => child !== unit && child.start >= unit.start && child.end <= unit.end && (child.start !== unit.start || child.end !== unit.end))) : comparison.units[side].filter(unit => unit.file === file && unit.kind === "file");
      const spans = (await Promise.all(assessments.map(item => resolveReference(projectRoot, snapshot, item.section!, analysis)))).filter(result => result.status === "resolved").flatMap(result => result.units);
      for (const target of targets) if (!spans.some(span => span.start <= target.start && span.end >= target.end)) add("convergence_missing", "Each changed text section needs a reviewed convergence assessment that covers its exact source.", `${file}:${side}:${target.start}:${target.end}`);
    }
  }
  for (const finding of review.findings.filter(item => item.mode === wave.mode && item.status !== "VERIFIED")) add("finding_unresolved", finding.title, finding.id);
  for (const conflict of review.conflicts.filter(item => !item.resolved)) add("review_conflict", conflict.reason, conflict.id);
  const targetFiles = new Set([...comparison.units.before, ...comparison.units.after].filter(unit => unit.kind === "file").map(unit => unit.file));
  for (const file of targetFiles) if (!wave.lanes.some(lane => withinScope(file, lane.coverage))) add("review_coverage_missing", "Assign each original and resulting target file to a review lane.", file);
  if (requireLaneResults) for (const lane of wave.lanes) if (lane.result?.status !== "CLEAN" || lane.result.digest !== laneDigest(review, wave, lane)) add("lane_result_stale", "Every assigned lane needs a current CLEAN result.", lane.id);
  for (const lane of wave.lanes) if (lane.reviewer === review.coordinator || review.deliveryWorkers.includes(lane.reviewer) || review.exchangeWorkers.includes(lane.reviewer)) add("reviewer_not_independent", "A correction participant cannot verify the correction.", lane.id);
  const latestAudit = [...review.waves].reverse().find(item => item.mode === "design-audit");
  if (wave.mode === "implementation-review" && (!latestAudit?.accepted || latestAudit.deltaRevision !== wave.deltaRevision || latestAudit.baselineId !== wave.baselineId || latestAudit.accepted.evidenceDigest !== waveDigest(review, latestAudit))) add("design_audit_missing", "Implementation review requires the latest accepted design revision.");
  await conservationStore.assertCurrent(projectRoot, wave.snapshotId);
  return problems;
}

export async function checkReviewGate(input: { projectRoot: string; reviewPath: string; expectedRevision?: string; gate: "implementation" | "completion" }) {
  assertInput(CHECK_REVIEW_GATE_SCHEMA, input);
  const loaded = await loadReview(input.projectRoot, input.reviewPath);
  if (input.expectedRevision && input.expectedRevision !== loaded.revision) throw conservationError("revision_conflict", "The review record changed.", { currentRevision: loaded.revision });
  const review = loaded.document;
  if (!review) return { ready: false, problems: [{ code: "evidence_missing", message: "The review record is missing." }] };
  const mode = input.gate === "implementation" ? "design-audit" : "implementation-review", wave = [...review.waves].reverse().find(item => item.mode === mode);
  if (!wave?.accepted) return { ready: false, revision: loaded.revision, problems: [{ code: "review_not_accepted", message: "The required review wave has no accepted result." }] };
  const problems = await waveProblems(input.projectRoot, review, wave, true);
  if (wave.accepted.evidenceDigest !== waveDigest(review, wave)) problems.push({ code: "review_result_stale", message: "The accepted review inputs changed." });
  if (input.gate === "completion") {
    const audit = [...review.waves].reverse().find(item => item.mode === "design-audit");
    if (!audit?.accepted || audit.baselineId !== wave.baselineId || audit.deltaRevision !== wave.deltaRevision) problems.push({ code: "design_audit_missing", message: "Completion requires the latest accepted design revision." });
  }
  return { ready: problems.length === 0, revision: loaded.revision, wave: wave.id, deltaRevision: wave.deltaRevision, baselineId: wave.baselineId,
    snapshotId: wave.snapshotId, comparisonId: wave.comparisonId, evidenceDigest: wave.accepted.evidenceDigest, problems };
}

function markdown(review: ReviewRecord) {
  const lines = ["# Slice review", "", "This file is a generated view of review.json.", ""];
  for (const wave of review.waves) { lines.push(`## ${wave.mode}: ${wave.id}`, "", `Concept delta revision: ${wave.deltaRevision}`, `Source snapshot: ${wave.snapshotId}`, `Comparison: ${wave.comparisonId}`, "");
    for (const lane of wave.lanes) lines.push(`- ${lane.id}: ${lane.result?.status || "PENDING"} (${lane.reviewer})`); lines.push(""); }
  for (const finding of review.findings) lines.push(`## ${finding.id}: ${finding.title}`, "", `- Status: ${finding.status}`, `- Severity: ${finding.severity}`, `- Evidence: ${finding.evidence}`, `- Condition to close: ${finding.conditionToClose}`, `- Implementer evidence: ${finding.implementerEvidence || "none"}`, "");
  return lines.join("\n") + "\n";
}
export async function getReview(input: { projectRoot: string; reviewPath: string; expectedRevision?: string | null; offset?: number; limit?: number; section?: keyof Pick<ReviewRecord, "findings" | "waves" | "assessments" | "conflicts" | "legacy" | "history"> }) {
  assertInput(GET_REVIEW_SCHEMA, input);
  const loaded = await loadReview(input.projectRoot, input.reviewPath);
  if (input.expectedRevision !== undefined && loaded.revision !== input.expectedRevision) throw conservationError("revision_conflict", "The review record changed.", { currentRevision: loaded.revision });
  if (!loaded.document) return { exists: false, revision: null };
  const section = input.section || "findings", list = loaded.document[section], offset = input.offset || 0, limit = input.limit || 50;
  let projectionStale = true;
  try { const projection = await resolveArtifactPath(input.projectRoot, input.reviewPath.replace(/\.json$/, ".md"), false, "review.md"); projectionStale = (await regularBytes(projection.target, 4 * 1024 * 1024)).toString() !== markdown(loaded.document); } catch { /* The authoritative record remains readable. */ }
  return { exists: true, revision: loaded.revision, schemaVersion: 1, deltaPath: loaded.document.deltaPath, baselineId: loaded.document.baselineId,
    coordinator: loaded.document.coordinator, delivery: loaded.document.delivery, currentWave: lastWave(loaded.document), section, entries: list.slice(offset, offset + limit), totalCount: list.length,
    nextOffset: offset + limit < list.length ? offset + limit : null, projectionStale };
}

export async function updateReview(input: UpdateInput) {
  assertInput(UPDATE_REVIEW_SCHEMA, input);
  const resolved = await resolveArtifactPath(input.projectRoot, input.reviewPath, true, "review.json");
  return withArtifactLock(resolved.target, () => withFileLock(resolved.target, async () => {
    const loaded = await loadReview(input.projectRoot, input.reviewPath);
    if (loaded.revision !== input.expectedRevision) throw conservationError("revision_conflict", "The review record changed.", { currentRevision: loaded.revision });
    if (!loaded.document && (!input.deltaPath || !input.delivery || input.actor.role !== "coordinator")) throw conservationError("validation_failed", "Review creation requires the coordinator, delivery worker, and delta path.");
    const deltaTarget = await resolveArtifactPath(input.projectRoot, loaded.document?.deltaPath || input.deltaPath!, false);
    return withArtifactLock(deltaTarget.target, () => withFileLock(deltaTarget.target, async () => {
    const review: ReviewRecord = structuredClone(loaded.document || { schemaVersion: 1, deltaPath: input.deltaPath!, coordinator: input.actor.id, delivery: input.delivery!, deliveryWorkers: [input.delivery!], waves: [], findings: [], assessments: [], conflicts: [], exchangeWorkers: [], legacy: [], history: [] });
    if (path.posix.dirname(review.deltaPath) !== path.posix.dirname(input.reviewPath) || (input.deltaPath && input.deltaPath !== review.deltaPath)) throw conservationError("invalid_path", "A review and its concept delta must share the slice directory.");
    const now = () => new Date().toISOString();
    for (const operation of input.operations) {
      const wave = lastWave(review), op = operation.op;
      if (op === "start_wave") {
        requireRole(review, input.actor, "coordinator");
        const next = operation as unknown as { id: string; mode: Mode; deltaRevision: string; snapshotId: string; comparisonId: string; lanes: Lane[] };
        if (review.waves.some(item => item.id === next.id) || !next.lanes.length || new Set(next.lanes.map(lane => lane.id)).size !== next.lanes.length || next.lanes.some(lane => !lane.coverage.length || lane.reviewer === review.coordinator || review.deliveryWorkers.includes(lane.reviewer))) throw conservationError("validation_failed", "Assign distinct review lanes and independent reviewers.");
        const requiredLanes = review.waves.filter(item => item.mode === next.mode).flatMap(item => item.lanes.map(lane => lane.id));
        if (requiredLanes.some(id => !next.lanes.some(lane => lane.id === id))) throw conservationError("gate_blocked", "A correction wave must retain every required lane from earlier waves in this review mode.");
        const delta = await readConceptDeltaDocument(input.projectRoot, review.deltaPath, next.deltaRevision);
        const baselineId = (delta.document as DeltaDocument | null)?.baselineId;
        if (!baselineId || (review.baselineId && review.baselineId !== baselineId)) throw conservationError("gate_blocked", "A review must preserve its original retained baseline.");
        const created: Wave = { id: next.id, mode: next.mode, deltaRevision: next.deltaRevision, snapshotId: next.snapshotId, comparisonId: next.comparisonId, baselineId, lanes: next.lanes };
        await comparisonFor(input.projectRoot, review, created);
        await conservationStore.assertCurrent(input.projectRoot, next.snapshotId);
        review.baselineId = baselineId; review.waves.push(created);
      } else if (op === "assign_delivery") { requireRole(review, input.actor, "coordinator"); if (review.waves.some(item => item.lanes.some(lane => lane.reviewer === operation.worker))) throw conservationError("gate_blocked", "A reviewer cannot become delivery for its own review."); review.delivery = operation.worker as string; review.deliveryWorkers = [...new Set([...review.deliveryWorkers, review.delivery])];
      } else if (op === "import_legacy") {
        requireRole(review, input.actor, "coordinator");
        const legacy = await resolveArtifactPath(input.projectRoot, operation.path as string, false, "findings.md");
        const bytes = await regularBytes(legacy.target, 1024 * 1024);
        if (!review.legacy.some(item => item.hash === digest(bytes))) review.legacy.push({ path: operation.path as string, hash: digest(bytes), content: bytes.toString() });
      } else if (op === "regenerate_markdown") { requireRole(review, input.actor, "coordinator");
      } else {
        if (!wave) throw conservationError("validation_failed", "Start a review wave before recording review evidence.");
        if (op === "open_finding") {
          const fields = operation as unknown as Omit<Finding, "id" | "mode" | "status" | "implementerEvidence" | "history">;
          reviewer(review, wave, input.actor, fields.lane);
          const id = `${wave.mode}/${fields.lane}/${fields.localId}`;
          if (review.findings.some(item => item.id === id)) throw conservationError("validation_failed", "The finding ID already exists.");
          review.findings.push({ id, localId: fields.localId, lane: fields.lane, mode: wave.mode, title: fields.title, severity: fields.severity, affectedPath: fields.affectedPath,
            evidence: fields.evidence, conditionToClose: fields.conditionToClose, aliases: fields.aliases || [], escalationTarget: fields.escalationTarget || "NONE", ...(fields.probe ? { probe: fields.probe } : {}),
            status: "OPEN", implementerEvidence: "", history: [{ actor: input.actor.id, status: "OPEN", wave: wave.id, at: now(), evidence: fields.evidence }] });
        } else if (op === "set_finding_status") {
          const finding = review.findings.find(item => item.id === operation.id), status = operation.status as Status;
          if (!finding || finding.mode !== wave.mode) throw conservationError("validation_failed", "The finding does not belong to the current review mode.");
          if (["IN PROGRESS", "FIXED"].includes(status)) { requireRole(review, input.actor, "delivery"); if (finding.status === "VERIFIED") throw conservationError("gate_blocked", "A reviewer must reopen a verified finding."); finding.implementerEvidence = operation.evidence as string; }
          else { reviewer(review, wave, input.actor, finding.lane, true); if (status === "VERIFIED" && finding.status !== "FIXED") throw conservationError("gate_blocked", "Only a corrected FIXED finding can be verified."); }
          finding.status = status; finding.history.push({ actor: input.actor.id, status, wave: wave.id, at: now(), evidence: operation.evidence as string });
        } else if (op === "record_assessment") {
          const data = operation.assessment as Omit<Assessment, "wave" | "author" | "acceptedBy">;
          laneOf(wave, data.lane);
          if (review.assessments.some(item => item.id === data.id)) throw conservationError("validation_failed", "The assessment ID already exists.");
          if (input.actor.role === "delivery") requireRole(review, input.actor, "delivery"); else reviewer(review, wave, input.actor, data.lane, true);
          const assessment = { ...data, wave: wave.id, author: input.actor.id, ...(input.actor.role === "reviewer" ? { acceptedBy: input.actor.id } : {}) };
          const delta = await readConceptDeltaDocument(input.projectRoot, review.deltaPath, wave.deltaRevision);
          await assessmentValid(input.projectRoot, review, wave, assessment, await comparisonFor(input.projectRoot, review, wave), delta.document as DeltaDocument);
          review.assessments.push(assessment);
        } else if (op === "accept_assessment") {
          const assessment = review.assessments.find(item => item.id === operation.id && item.wave === wave.id);
          if (!assessment) throw conservationError("validation_failed", "The assessment is not part of this wave.");
          reviewer(review, wave, input.actor, assessment.lane, true);
          const delta = await readConceptDeltaDocument(input.projectRoot, review.deltaPath, wave.deltaRevision);
          await assessmentValid(input.projectRoot, review, wave, assessment, await comparisonFor(input.projectRoot, review, wave), delta.document as DeltaDocument);
          assessment.acceptedBy = input.actor.id;
        } else if (op === "record_exchange") { requireRole(review, input.actor, "coordinator"); if (!wave.lanes.some(lane => lane.reviewer === operation.reviewer)) throw conservationError("validation_failed", "The exchange worker is not a current reviewer."); review.exchangeWorkers = [...new Set([...review.exchangeWorkers, operation.reviewer as string])];
        } else if (op === "open_conflict") {
          const lanes = operation.lanes as string[];
          if (input.actor.role === "coordinator") requireRole(review, input.actor, "coordinator"); else { requireRole(review, input.actor, "reviewer"); if (!lanes.some(lane => laneOf(wave, lane).reviewer === input.actor.id)) throw conservationError("gate_blocked", "Only an assigned reviewer can open this conflict."); }
          if (!lanes.length || review.conflicts.some(item => item.id === operation.id)) throw conservationError("validation_failed", "A conflict requires assigned lanes and an unused ID.");
          lanes.forEach(lane => laneOf(wave, lane)); review.conflicts.push({ id: operation.id as string, wave: wave.id, lanes, reason: operation.reason as string });
        } else if (op === "resolve_conflict") { requireRole(review, input.actor, "coordinator"); const conflict = review.conflicts.find(item => item.id === operation.id); if (!conflict) throw conservationError("validation_failed", "The conflict does not exist."); conflict.resolved = { actor: input.actor.id, reason: operation.reason as string };
        } else if (op === "submit_lane") {
          const lane = laneOf(wave, operation.lane as string); reviewer(review, wave, input.actor, lane.id, operation.status === "CLEAN");
          if (operation.status === "CLEAN" && review.findings.some(item => item.mode === wave.mode && item.lane === lane.id && item.status !== "VERIFIED")) throw conservationError("gate_blocked", "Unresolved findings prevent a CLEAN lane result.");
          await conservationStore.assertCurrent(input.projectRoot, wave.snapshotId);
          lane.result = { status: operation.status as "CLEAN" | "FINDINGS", reviewer: input.actor.id, digest: laneDigest(review, wave, lane) };
        } else if (op === "carry_lane") {
          requireRole(review, input.actor, "coordinator");
          const previous = review.waves.find(item => item.id === operation.fromWave && item.id !== wave.id), lane = laneOf(wave, operation.lane as string);
          const old = previous?.lanes.find(item => item.id === lane.id);
          if (!previous || !old || old.result?.status !== "CLEAN" || old.result.digest !== laneDigest(review, previous, old)
            || canonical([previous.mode, previous.deltaRevision, previous.baselineId, previous.snapshotId, previous.comparisonId]) !== canonical([wave.mode, wave.deltaRevision, wave.baselineId, wave.snapshotId, wave.comparisonId])
            || canonical([old.reviewer, old.coverage]) !== canonical([lane.reviewer, lane.coverage]) || review.exchangeWorkers.includes(lane.reviewer)) throw conservationError("gate_blocked", "A lane can carry forward only with unchanged inputs, coverage, findings and an independent reviewer.");
          if (review.assessments.some(item => item.wave === wave.id && item.lane === lane.id)) throw conservationError("gate_blocked", "A current lane assessment prevents carry-forward.");
          for (const assessment of review.assessments.filter(item => item.wave === previous.id && item.lane === lane.id)) review.assessments.push({ ...assessment, id: `${wave.id}/${assessment.id}`, wave: wave.id });
          lane.result = { status: "CLEAN", reviewer: lane.reviewer, digest: laneDigest(review, wave, lane) };
        } else if (op === "accept_wave") {
          requireRole(review, input.actor, "coordinator");
          const problems = await waveProblems(input.projectRoot, review, wave, true);
          if (problems.length) throw conservationError("gate_blocked", "The review wave does not satisfy its acceptance gate.", { problems });
          wave.accepted = { evidenceDigest: waveDigest(review, wave), actor: input.actor.id, at: now() };
        }
      }
      if (op !== "regenerate_markdown") review.history.push({ actor: input.actor.id, operation: op, at: now() });
    }
    await conservationStore.registerSlice(input.projectRoot, review.deltaPath);
    assertInput(recordSchema, review);
    const contents = canonical(review) + "\n";
    if (Buffer.byteLength(contents) > 4 * 1024 * 1024) throw conservationError("resource_limit", "The review record exceeds 4 MiB.");
    const changed = canonical(review) !== canonical(loaded.document);
    if (changed) await conservationStore.writeManaged(resolved.root, resolved.target, contents);
    let projectionStale = false;
    try { const projection = await resolveArtifactPath(input.projectRoot, input.reviewPath.replace(/\.json$/, ".md"), false, "review.md"); await conservationStore.writeManaged(resolved.root, projection.target, markdown(review)); } catch { projectionStale = true; }
    const wave = lastWave(review);
    return { exists: true, revision: changed ? digest(contents) : loaded.revision, previousRevision: loaded.revision, projectionStale, currentWave: wave?.id, accepted: Boolean(wave?.accepted && wave.accepted.evidenceDigest === waveDigest(review, wave)) };
    }, undefined, { renew: true }));
  }, undefined, { renew: true }));
}
