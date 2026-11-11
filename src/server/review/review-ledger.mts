import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { withArtifactLock, withFileLock, writeAtomically } from "../workflow/artifact-store.mjs";
import { assertInput, describeErrors } from "../workflow/artifact-schema.mjs";
import { resolveArtifactPath, readChangeMapDocument } from "../conservation/change-map.mjs";
import { locateRecord, moveLegacyRecords, sameRecord, sliceDocumentFolder, writeRecord } from "../workflow/record-store.mjs";
import { regularBytes } from "../repository-intelligence/native-semantic-runtime.mjs";
import { acceptedDesign, latestVerification } from "../workflow/slice-design.mjs";
import { readCoordinationState } from "../workflow/state.mjs";
import { refuseShipped } from "../workflow/shipped-history.mjs";
import { conservationStore, canonical, digest, conservationError, withinScope } from "../conservation/conservation-store.mjs";
import { assessDeltaReadiness, resolveReference, COMPARISON_VERSION } from "../conservation/conservation-analysis.mjs";
import { objectSchema as obj, arraySchema as arr, textField as str, hashField, referenceSchema, justificationSchema } from "../conservation/conservation-schema.mjs";
import type { ComparisonEvidence, DeltaDocument, Evidence, GrowthJustification, Observation, Reference, SnapshotEvidence } from "../conservation/conservation-types.mjs";

type Mode = "design-audit" | "implementation-review";
type Status = "OPEN" | "IN PROGRESS" | "FIXED" | "VERIFIED" | "REOPENED" | "DEFERRED";
// A deferred finding stays on record, closed by the user's decision gate with a follow-up in the project's tracker.
interface Deferral { gate: string; followUp: string; wave: string; actor: string; at: string }
interface Actor { id: string; role: "coordinator" | "delivery" | "reviewer" }
interface Finding { id: string; localId: string; lane: string; mode: Mode; title: string; severity: string; affectedPath: string; evidence: string; conditionToClose: string; aliases: string[]; escalationTarget: string; probe?: string; clause?: string; status: Status; deferral?: Deferral; implementerEvidence: string; history: { actor: string; status: Status; wave: string; at: string; evidence: string; revised?: Revision }[] }
// A revision of a finding keeps the old and new value of each changed field; a cleared clause has no new value.
interface Revision { clause?: { from?: string; to?: string }; conditionToClose?: { from: string; to: string } }
interface Lane { id: string; reviewer: string; coverage: string[]; result?: { status: "CLEAN" | "FINDINGS"; digest: string; reviewer: string } }
// A wave of a slice with an accepted design reviews the verified tree and its diff from a base, without change map evidence.
interface Wave { id: string; mode: Mode; deltaRevision: string; baselineId: string; snapshotId: string; comparisonId: string; tree?: string; base?: string; startedAt?: string; afterGate?: string; lanes: Lane[]; accepted?: { evidenceDigest: string; actor: string; at: string } }
const verifiedTreeWave = (wave: Wave) => Boolean(wave.tree) && !wave.comparisonId;
interface Assessment { id: string; wave: string; lane: string; kind: "manual" | "implementation-detail" | "growth" | "convergence"; reason: string; evidence: Reference[]; author: string; acceptedBy?: string; observationIds?: string[]; conceptId?: string; growthIds?: string[]; justification?: GrowthJustification; section?: Reference; decision?: string; conceptIds?: string[]; coverage?: { requirement: Reference; targets: Reference[] }[] }
interface Conflict { id: string; wave: string; lanes: string[]; reason: string; resolved?: { actor: string; reason: string } }
export interface ReviewRecord { schemaVersion: 1; deltaPath: string; coordinator: string; delivery: string; deliveryWorkers: string[]; baselineId?: string; waves: Wave[]; findings: Finding[]; assessments: Assessment[]; conflicts: Conflict[]; exchangeWorkers: string[]; legacy: { path: string; hash: string; content: string }[]; history: { actor: string; operation: string; at: string }[] }
const revisionField = { oneOf: [hashField, { type: "null" }] };
const sliceIdentity = { projectRoot: str, initiative: str, slice: str };
const common = { ...sliceIdentity, expectedRevision: revisionField };
const laneSchema = obj({ id: str, reviewer: str, coverage: arr(str) });
const assessmentCommon = { id: str, lane: str, reason: str, evidence: arr(referenceSchema) };
const assessmentSchema = { oneOf: [
  obj({ ...assessmentCommon, kind: { const: "manual" }, observationIds: arr(str) }),
  obj({ ...assessmentCommon, kind: { const: "implementation-detail" }, observationIds: arr(str), conceptId: str }),
  obj({ ...assessmentCommon, kind: { const: "growth" }, growthIds: arr(str), justification: justificationSchema }),
  obj({ ...assessmentCommon, kind: { const: "convergence" }, section: referenceSchema, decision: { enum: ["retain", "replace", "consolidate", "delete"] }, conceptIds: arr(str), coverage: arr(obj({ requirement: referenceSchema, targets: arr(referenceSchema) })) })
] };
export const GET_REVIEW_SCHEMA = obj({ ...common, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 }, section: { enum: ["findings", "waves", "assessments", "conflicts", "legacy", "history"] }, wave: str }, ["projectRoot", "initiative", "slice"]);
export const UPDATE_REVIEW_SCHEMA = obj({ ...common, delivery: str, actor: obj({ id: str, role: { enum: ["coordinator", "delivery", "reviewer"] } }), operations: arr({ oneOf: [
  obj({ op: { const: "start_wave" }, id: str, mode: { enum: ["design-audit", "implementation-review"] }, deltaRevision: hashField, snapshotId: hashField, comparisonId: hashField, base: str, lanes: arr(laneSchema), afterGate: str }, ["op", "id", "mode", "lanes"]),
  obj({ op: { const: "assign_delivery" }, worker: str }),
  obj({ op: { const: "open_finding" }, lane: str, localId: str, title: str, severity: { enum: ["blocker", "high", "medium", "low"] }, affectedPath: str, evidence: str, conditionToClose: str, aliases: arr(str), escalationTarget: str, probe: str, clause: str }, ["op", "lane", "localId", "title", "severity", "affectedPath", "evidence", "conditionToClose"]),
  obj({ op: { const: "revise_finding" }, id: str, clause: str, clearClause: { const: true }, conditionToClose: str, reason: str }, ["op", "id", "reason"]),
  obj({ op: { const: "set_finding_status" }, id: str, status: { enum: ["IN PROGRESS", "FIXED", "VERIFIED", "REOPENED"] }, evidence: str }),
  obj({ op: { const: "record_assessment" }, assessment: assessmentSchema }),
  obj({ op: { const: "accept_assessment" }, id: str }),
  obj({ op: { const: "record_exchange" }, reviewer: str }),
  obj({ op: { const: "open_conflict" }, id: str, lanes: arr(str), reason: str }),
  obj({ op: { const: "resolve_conflict" }, id: str, reason: str }),
  obj({ op: { const: "submit_lane" }, lane: str, status: { enum: ["CLEAN", "FINDINGS"] } }),
  obj({ op: { const: "carry_lane" }, lane: str, fromWave: str }),
  obj({ op: { const: "carry_assessments" }, lane: str, fromWave: str, ids: arr(str) }, ["op", "lane", "fromWave"]),
  obj({ op: { const: "accept_wave" }, gate: str, deferrals: { ...arr(obj({ finding: str, followUp: { type: "string" } }), 100), minItems: 1 } }, ["op"]),
  obj({ op: { const: "import_legacy" }, path: str }),
  obj({ op: { const: "regenerate_markdown" } })
] }) }, ["projectRoot", "initiative", "slice", "expectedRevision", "actor", "operations"]);
export const CHECK_REVIEW_GATE_SCHEMA = obj({ ...sliceIdentity, expectedRevision: hashField, gate: { enum: ["implementation", "completion"] } }, ["projectRoot", "initiative", "slice", "gate"]);

interface Operation { op: string; [key: string]: unknown }
interface SliceInput { projectRoot: string; initiative: string; slice: string }
interface UpdateInput extends SliceInput { expectedRevision: string | null; actor: Actor; delivery?: string; operations: Operation[] }
const lastWave = (review: ReviewRecord) => review.waves.at(-1);

// Implementation review waves that run without the user's say before the review loop stops for a decision.
const FREE_REVIEW_WAVES = 2;
interface GateRecord { id: string; kind: string; slice?: string; askedAt?: string; answer?: { choice?: string | null }; closedAt?: string; choice?: string; options?: { id: string }[] }
const UNRESOLVED: Status[] = ["OPEN", "IN PROGRESS", "FIXED", "REOPENED"];
// The implementation-review findings that still need a fix, a verification, or the user's decision.
export const unresolvedFindings = (review: ReviewRecord) => review.findings.filter(item => item.mode === "implementation-review" && UNRESOLVED.includes(item.status));
// A finding is closed once a reviewer verified it or the user's decision gate deferred it.
const closedFinding = (finding: Finding) => finding.status === "VERIFIED" || finding.status === "DEFERRED";
// The implementation-review waves since the design was accepted, in start order; a wave without a start time started when the design was accepted.
export const reviewWaves = (review: ReviewRecord, acceptedAt: string) => review.waves.filter(item => item.mode === "implementation-review" && (item.startedAt ?? acceptedAt) >= acceptedAt);
// A decision gate chose an option through its browser answer or through the choice that resolve recorded when the user answered in conversation;
// resolve may only repeat a browser answer's option, so a stored choice that contradicts one never outweighs the user's own answer.
export const gateChose = (gate: GateRecord, option: string) => typeof gate.answer?.choice === "string" ? gate.answer.choice === option : gate.choice === option;
async function sliceGates(input: SliceInput) {
  const state = (await readCoordinationState({ projectRoot: input.projectRoot, initiative: input.initiative })).state as { pending?: GateRecord[]; closed?: GateRecord[] } | null;
  return [...(state?.pending ?? []), ...(state?.closed ?? [])];
}
// A current gate is a decision gate of the slice, pending or closed, asked at or after the start of the latest review wave.
export async function currentGate(input: SliceInput, review: ReviewRecord, acceptedAt: string, id: string) {
  const latest = reviewWaves(review, acceptedAt).at(-1), start = latest ? latest.startedAt ?? acceptedAt : acceptedAt;
  const gate = (await sliceGates(input)).find(item => item.id === id);
  return gate && gate.kind === "decision" && gate.slice === input.slice && (gate.askedAt ?? "") >= start ? gate : null;
}

// A finding that a contract clause itself causes is fixed in design, not in another implementation round, and a review that keeps
// finding problems stops for the user's decision, because both point at a contract or a slice that fixing forward will not repair.
async function assertReviewMayContinue(input: SliceInput, review: ReviewRecord, next: { afterGate?: string }, acceptedAt: string) {
  const fromContract = review.findings.filter(item => item.mode === "implementation-review" && item.clause && !closedFinding(item) && (item.history[0]?.at ?? "") >= acceptedAt);
  if (fromContract.length) {
    const clauses = [...new Set(fromContract.map(item => item.clause))].join(", ");
    throw conservationError("gate_blocked", `Findings ${fromContract.map(item => item.id).join(", ")} name contract clauses (${clauses}), so the contract needs revision: call verify_slice with contractDefects for those clauses and return the slice to design instead of starting another wave.`, { problems: fromContract.map(item => ({ code: "contract_defect_found", finding: item.id, clause: item.clause })) });
  }
  const waves = reviewWaves(review, acceptedAt);
  if (waves.length < FREE_REVIEW_WAVES) return;
  if (!next.afterGate) throw conservationError("gate_blocked", `The slice had ${waves.length} review waves since its design was accepted. Ask the user a decision gate for this slice whether to continue the review, return the slice to design, or narrow it, and pass the answered gate's id as afterGate.`, { problems: [{ code: "review_loop_limit", waves: waves.length }] });
  if (review.waves.some(item => item.afterGate === next.afterGate)) throw conservationError("gate_blocked", "Each further review wave needs its own answered decision gate.");
  const gate = (await sliceGates(input)).find(item => item.id === next.afterGate);
  const asked = gate?.askedAt ?? "", lastStart = waves.at(-1)?.startedAt ?? acceptedAt;
  if (!gate || gate.kind !== "decision" || gate.slice !== input.slice || !(gate.answer || gate.closedAt) || asked < lastStart) throw conservationError("gate_blocked", `afterGate must name a decision gate for slice ${input.slice} that was asked after the last review wave started and that the user answered.`);
}

// Accepting a wave with deferrals needs the user's current gate that chose accept-deferred and a follow-up for every unresolved finding, each of them low.
const FOLLOW_UP_LIMIT = 500;
async function deferFindings(input: SliceInput, review: ReviewRecord, wave: Wave, gateId: string, deferrals: { finding: string; followUp: string }[], actor: string, at: string) {
  const design = await acceptedDesign(input.projectRoot, input.initiative, input.slice) as { acceptedAt?: string } | null;
  const gate = await currentGate(input, review, design?.acceptedAt ?? "", gateId);
  const unresolved = unresolvedFindings(review), named = new Map(deferrals.map(item => [item.finding, item]));
  const position = (id: string) => { const index = review.findings.findIndex(item => item.id === id); return index === -1 ? review.findings.length + deferrals.findIndex(item => item.finding === id) : index; };
  const groups: Record<string, { code: string; finding: string; message: string }[]> = { gate_invalid: [], finding_not_unresolved: [], severity_not_low: [], follow_up_missing: [] };
  const add = (code: string, finding: string, message: string) => groups[code].push({ code, finding, message });
  if (!gate || !gateChose(gate, "accept-deferred")) for (const item of deferrals) add("gate_invalid", item.finding, `the gate ${gateId} is not a decision gate of slice ${input.slice}, asked since the latest review wave started, that chose accept-deferred`);
  for (const item of deferrals) {
    const finding = unresolved.find(entry => entry.id === item.finding);
    if (!finding) add("finding_not_unresolved", item.finding, "the finding is not an unresolved implementation-review finding of this slice");
    else if (finding.severity !== "low") add("severity_not_low", item.finding, `the finding has ${finding.severity} severity, and only low findings can be deferred`);
  }
  for (const finding of unresolved) {
    const followUp = named.get(finding.id)?.followUp.trim();
    if (followUp === undefined) add("follow_up_missing", finding.id, "the unresolved finding is not deferred, so it needs a deferral with a follow-up or a fix");
    else if (!followUp || followUp.length > FOLLOW_UP_LIMIT) add("follow_up_missing", finding.id, `the follow-up must be a non-empty reference of at most ${FOLLOW_UP_LIMIT} characters`);
  }
  const problems = Object.values(groups).flatMap(group => group.sort((a, b) => position(a.finding) - position(b.finding)));
  if (problems.length) throw conservationError("deferral_refused", `The review wave cannot be accepted with these deferrals: ${problems.map(item => `${item.finding}: ${item.message}`).join("; ")}.`, { problems });
  for (const item of deferrals) {
    const finding = review.findings.find(entry => entry.id === item.finding)!, followUp = item.followUp.trim();
    finding.status = "DEFERRED";
    finding.deferral = { gate: gateId, followUp, wave: wave.id, actor, at };
    finding.history.push({ actor, status: "DEFERRED", wave: wave.id, at, evidence: followUp });
  }
}
// A deferred finding stays closed with its decision; reopening or revising it would contradict the user's gate.
function refuseDeferred(finding: Finding) {
  if (finding.status === "DEFERRED") throw conservationError("gate_blocked", `The finding ${finding.id} was deferred by the decision gate ${finding.deferral?.gate} with the follow-up ${finding.deferral?.followUp}, so it cannot change status or be revised.`);
}
export const deferredFindings = (review: ReviewRecord) => review.findings.filter(item => item.status === "DEFERRED").map(item => ({ id: item.id, severity: item.severity, title: item.title, gate: item.deferral?.gate, followUp: item.deferral?.followUp, wave: item.deferral?.wave }));
// A lane passes with its submitted FINDINGS result once the user's gate deferred every finding of the lane that a reviewer did not verify.
function deferredLane(review: ReviewRecord, wave: Wave, lane: Lane) {
  const open = review.findings.filter(item => item.mode === wave.mode && item.lane === lane.id && item.status !== "VERIFIED");
  return open.length > 0 && open.every(item => item.status === "DEFERRED");
}
// A lane's result digests a deferred finding as its reviewer last saw it, so the deferral leaves the submitted result current.
function asReviewed(finding: Finding) {
  if (finding.status !== "DEFERRED") return finding;
  const { deferral: _, ...rest } = finding, history = finding.history.filter(entry => entry.status !== "DEFERRED");
  return { ...rest, status: history.at(-1)?.status ?? "OPEN", history };
}
const raisedIn = (finding: Finding) => finding.history[0]?.wave;
const laneOf = (wave: Wave, lane: string) => { const value = wave.lanes.find(item => item.id === lane); if (!value) throw conservationError("validation_failed", "The review lane is not assigned."); return value; };
const requireRole = (review: ReviewRecord, actor: Actor, role: Actor["role"]) => {
  if (actor.role !== role || (role === "coordinator" && actor.id !== review.coordinator) || (role === "delivery" && actor.id !== review.delivery)) throw conservationError("gate_blocked", "This worker does not own the requested review change.");
};
function reviewer(review: ReviewRecord, wave: Wave, actor: Actor, lane: string, fresh = false) {
  requireRole(review, actor, "reviewer");
  if (laneOf(wave, lane).reviewer !== actor.id || actor.id === review.coordinator || review.deliveryWorkers.includes(actor.id) || (fresh && review.exchangeWorkers.includes(actor.id))) throw conservationError("gate_blocked", "A fresh assigned reviewer must make this decision.");
}
function laneDigest(review: ReviewRecord, wave: Wave, lane: Lane) {
  return digest(canonical({ inputs: verifiedTreeWave(wave) ? [wave.tree, wave.base ?? null] : [wave.deltaRevision, wave.baselineId, wave.snapshotId, wave.comparisonId], lane: { id: lane.id, reviewer: lane.reviewer, coverage: lane.coverage },
    independent: lane.reviewer !== review.coordinator && !review.deliveryWorkers.includes(lane.reviewer) && !review.exchangeWorkers.includes(lane.reviewer),
    findings: review.findings.filter(item => item.mode === wave.mode && item.lane === lane.id).map(asReviewed),
    assessments: review.assessments.filter(item => item.wave === wave.id && item.lane === lane.id),
    conflicts: review.conflicts.filter(item => item.wave === wave.id && item.lanes.includes(lane.id)) }));
}
function waveDigest(review: ReviewRecord, wave: Wave) { return digest(canonical(wave.lanes.map(lane => ({ lane: lane.id, digest: laneDigest(review, wave, lane), result: lane.result })))); }
// Implementation review needs the latest design audit accepted for the same delta revision and baseline, with unchanged accepted inputs.
// A slice whose design was accepted on its initiative record has no design-audit wave, so its accepted design stands in for one.
function designAudited(review: ReviewRecord, wave: Pick<Wave, "deltaRevision" | "baselineId">, designAccepted = false) {
  if (designAccepted) return true;
  const audit = [...review.waves].reverse().find(item => item.mode === "design-audit");
  return Boolean(audit?.accepted && audit.deltaRevision === wave.deltaRevision && audit.baselineId === wave.baselineId && audit.accepted.evidenceDigest === waveDigest(review, audit));
}
const STATUSES = ["OPEN", "IN PROGRESS", "FIXED", "VERIFIED", "REOPENED", "DEFERRED"];
const recordSchema = obj({
  schemaVersion: { const: 1 }, deltaPath: str, coordinator: str, delivery: str, deliveryWorkers: arr(str, 10000), baselineId: hashField,
  waves: arr(obj({ id: str, mode: { enum: ["design-audit", "implementation-review"] }, deltaRevision: hashField, baselineId: hashField, snapshotId: hashField, comparisonId: hashField, tree: str, base: str, startedAt: str, afterGate: str,
    lanes: arr(obj({ ...laneSchema.properties, result: obj({ status: { enum: ["CLEAN", "FINDINGS"] }, digest: hashField, reviewer: str }) }, ["id", "reviewer", "coverage"])),
    accepted: obj({ evidenceDigest: hashField, actor: str, at: str }) }, ["id", "mode", "lanes"]), 1000),
  findings: arr(obj({ id: str, localId: str, lane: str, mode: { enum: ["design-audit", "implementation-review"] }, title: str, severity: { enum: ["blocker", "high", "medium", "low"] }, affectedPath: str, evidence: str, conditionToClose: str, aliases: arr(str), escalationTarget: str, probe: str, clause: str, status: { enum: STATUSES }, deferral: obj({ gate: str, followUp: str, wave: str, actor: str, at: str }), implementerEvidence: { type: "string" }, history: arr(obj({ actor: str, status: { enum: STATUSES }, wave: str, at: str, evidence: str, revised: obj({ clause: obj({ from: str, to: str }, []), conditionToClose: obj({ from: str, to: str }) }, []) }, ["actor", "status", "wave", "at", "evidence"]), 10000) }, ["id", "localId", "lane", "mode", "title", "severity", "affectedPath", "evidence", "conditionToClose", "aliases", "escalationTarget", "status", "implementerEvidence", "history"]), 10000),
  assessments: arr({ oneOf: assessmentSchema.oneOf.map(schema => obj({ ...schema.properties, wave: str, author: str, acceptedBy: str }, [...schema.required, "wave", "author"])) }, 10000),
  conflicts: arr(obj({ id: str, wave: str, lanes: arr(str), reason: str, resolved: obj({ actor: str, reason: str }) }, ["id", "wave", "lanes", "reason"]), 10000),
  exchangeWorkers: arr(str, 10000), legacy: arr(obj({ path: str, hash: hashField, content: { type: "string", maxLength: 1024 * 1024 } })),
  history: arr(obj({ actor: str, operation: str, at: str }), 10000)
}, ["schemaVersion", "deltaPath", "coordinator", "delivery", "deliveryWorkers", "waves", "findings", "assessments", "conflicts", "exchangeWorkers", "legacy", "history"]);
// Only accept_wave defers a finding, and a lane digest reads a deferred finding as its reviewer saw it, so a record whose deferral
// that operation could not have written is refused rather than read as a closed finding.
function assertDeferrals(review: ReviewRecord) {
  const errors: string[] = [];
  review.findings.forEach((finding, index) => {
    const field = `review.findings[${index}]`, deferredAt = finding.history.findIndex(entry => entry.status === "DEFERRED"), last = finding.history.at(-1);
    if (finding.status !== "DEFERRED") {
      if (finding.deferral) errors.push(`${field}.deferral: is allowed only on a DEFERRED finding`);
      if (deferredAt !== -1) errors.push(`${field}.history: has a DEFERRED entry on a finding that is not DEFERRED`);
      return;
    }
    if (finding.mode !== "implementation-review") errors.push(`${field}.status: DEFERRED is allowed only on an implementation-review finding`);
    if (finding.severity !== "low") errors.push(`${field}.status: DEFERRED is allowed only on a low finding`);
    const followUp = finding.deferral?.followUp ?? "";
    if (!finding.deferral) errors.push(`${field}.deferral: is required on a DEFERRED finding`);
    else if (!followUp.trim() || followUp !== followUp.trim() || followUp.length > FOLLOW_UP_LIMIT) errors.push(`${field}.deferral.followUp: must be a trimmed reference of 1 to ${FOLLOW_UP_LIMIT} characters`);
    if (deferredAt !== finding.history.length - 1 || last?.wave !== finding.deferral?.wave || last?.evidence !== followUp || last?.actor !== finding.deferral?.actor || last?.at !== finding.deferral?.at) errors.push(`${field}.history: must end with the one DEFERRED entry of its deferral`);
    if (!review.waves.some(wave => wave.id === finding.deferral?.wave && wave.mode === "implementation-review")) errors.push(`${field}.deferral.wave: must name an implementation-review wave of the review`);
  });
  if (errors.length) throw conservationError("validation_failed", `The review record holds deferrals that accept_wave did not write: ${describeErrors(errors)}`, { errors });
}
export async function loadReview(projectRoot: string, initiative: string, slice: string) {
  const resolved = await locateRecord(projectRoot, { kind: "review", initiative, slice });
  try {
    const bytes = await regularBytes(resolved.target, 4 * 1024 * 1024), document = JSON.parse(bytes.toString()) as ReviewRecord;
    assertInput(recordSchema, document);
    assertDeferrals(document);
    return { resolved, exists: true, revision: digest(bytes), document };
  } catch (error) { if (error.code === "ENOENT") return { resolved, exists: false, revision: null, document: null }; throw error; }
}
async function comparisonFor(projectRoot: string, review: ReviewRecord, wave: Wave) {
  const comparison = await conservationStore.get<ComparisonEvidence>(projectRoot, wave.comparisonId, "comparison");
  if (comparison.versions.comparison !== COMPARISON_VERSION) throw conservationError("evidence_missing", "Regenerate comparison evidence with the current identity and growth checks.");
  const fields = [["deltaPath", comparison.deltaPath, review.deltaPath], ["deltaRevision", comparison.deltaRevision, wave.deltaRevision], ["baselineId", comparison.baselineId, wave.baselineId], ["snapshotId", comparison.resultSnapshotId, wave.snapshotId]] as const;
  const mismatched = [];
  // Stored change map paths can predate the move to .prism, so they compare by the record they name.
  for (const [field, compared, given] of fields) if (field === "deltaPath" ? !(await sameRecord(projectRoot, compared, given)) : compared !== given) mismatched.push({ code: "comparison_input_mismatch", field, message: `the comparison has ${compared}, and the review has ${given}` });
  if (mismatched.length) throw conservationError("evidence_missing", "The review inputs do not match the immutable comparison. Compare the change map again with the review inputs, or start the wave with the inputs of the comparison.", { problems: mismatched });
  for (const id of [wave.baselineId, wave.snapshotId]) {
    const snapshot = await conservationStore.get<SnapshotEvidence>(projectRoot, id, "snapshot");
    for (const file of snapshot.files.filter(file => withinScope(file.file, comparison.scope))) await conservationStore.bytes(projectRoot, file);
  }
  return comparison;
}
const targetFiles = (comparison: ComparisonEvidence) => [...new Set([...comparison.units.before, ...comparison.units.after].filter(unit => unit.kind === "file").map(unit => unit.file))];
const describe = (reference: Reference) => reference.selector === undefined ? reference.path : `${reference.path} (${typeof reference.selector === "string" ? reference.selector : `${reference.selector.type} ${"value" in reference.selector ? JSON.stringify(reference.selector.value) : `${reference.selector.start}:${reference.selector.end}`}`})`;
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
    if (first.status !== "resolved" && second.status !== "resolved") throw conservationError("evidence_missing", `The cited evidence reference ${describe(reference)} does not resolve in the baseline or the result snapshot.`, { problems: [{ code: first.status, message: first.reason || second.reason || `The reference is ${first.status}.` }] });
  }
  if (["manual", "implementation-detail"].includes(assessment.kind)) {
    if (!assessment.observationIds?.length) throw conservationError("validation_failed", "Name the checks addressed by the assessment.");
    for (const id of assessment.observationIds) {
      const observation = comparison.observations.find(item => item.id === id);
      if (!observation || observation.severity === "failure") throw conservationError("gate_blocked", "A manual assessment cannot waive a known mechanical failure.");
      if (assessment.kind === "implementation-detail") {
        if (observation.code !== "unclassified_unit" || observation.unit?.public === true || !document.concepts.some(entry => entry.id === assessment.conceptId && ["MODIFY", "REPLACE", "ADD"].includes(entry.action))) throw conservationError("gate_blocked", "Attribute only private implementation detail to a planned ADD, MODIFY, or REPLACE change.");
        for (const entry of document.concepts.filter(entry => entry.action === "DELETE")) for (const reference of entry.before) {
          const deleted = await resolveReference(projectRoot, before, reference, a);
          if (deleted.units.some(target => target.key === observation.unit?.key || comparison.units.before.some(unit => unit.key === observation.unit?.key && unit.file === target.file && unit.start >= target.start && unit.end <= target.end))) throw conservationError("gate_blocked", "An explicitly deleted item cannot become implementation detail of another change.");
        }
      } else if (observation.code === "unclassified_unit") throw conservationError("gate_blocked", `The observation ${id} reports the unclassified unit ${observation.unit ? `${observation.unit.file}:${observation.unit.selector}` : observation.file || "in the comparison"}. Record an implementation-detail assessment that names its planned change, or revise the design so that a change map entry covers it.`);
    }
  }
  const boundRequirement = (reference: Reference) => document.requirements?.some(item => item.path === reference.path && (item.selector === undefined || canonical(item) === canonical(reference)));
  if (assessment.kind === "growth") {
    const justification = assessment.justification;
    const missing = [
      ...(assessment.growthIds?.length ? [] : ["growthIds is empty"]),
      ...(justification?.requirements.length ? [] : ["justification.requirements is empty"]),
      ...(justification?.requirements || []).filter(ref => !boundRequirement(ref)).map(ref => `the requirement ${describe(ref)} is not in the delta requirements`),
      ...(justification?.conceptIds.length ? [] : ["justification.conceptIds is empty"]),
      ...(justification?.conceptIds || []).filter(id => !document.concepts.some(entry => entry.id === id)).map(id => `the change ${id} is not in the change map`)];
    if (missing.length) throw conservationError("gate_blocked", "Growth needs governing requirements and the changes that cause it.", { problems: missing.map(message => ({ code: "growth_justification_invalid", message })) });
    for (const id of assessment.growthIds!) {
      const growth = comparison.growth.find(item => item.id === id);
      if (!growth) throw conservationError("validation_failed", `The comparison has no growth ${id}.`);
      if (!justification!.dimensions.includes(growth.dimension)) throw conservationError("validation_failed", `The growth justification does not cover the measured increase of ${growth.dimension}. Add it to justification.dimensions.`);
    }
    for (const requirement of justification!.requirements) {
      const resolved = await resolveReference(projectRoot, after, requirement, b);
      if (resolved.status !== "resolved") throw conservationError("evidence_missing", `The growth requirement ${describe(requirement)} is ${resolved.status} in the resulting source.${resolved.reason ? ` ${resolved.reason}` : ""}`);
    }
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

// Hosts show agents the error message, not its data, so refusals summarize their problems by code with example ids.
export function summarizeProblems(problems: { code: string; message: string; id?: string }[]) {
  const groups = new Map<string, { message: string; ids: string[]; count: number }>();
  for (const problem of problems) {
    const group = groups.get(problem.code) ?? { message: problem.message, ids: [], count: 0 };
    group.count += 1;
    if (problem.id && group.ids.length < 3) group.ids.push(problem.id);
    groups.set(problem.code, group);
  }
  return [...groups].map(([code, group]) => `${code} x${group.count}: ${group.message}${group.ids.length ? ` (for example ${group.ids.join(", ")})` : ""}`).join("; ");
}

// Changed text sections of in-scope Markdown files that no accepted convergence assessment covers.
async function uncoveredText(projectRoot: string, comparison: ComparisonEvidence, accepted: Assessment[], document: DeltaDocument, before: SnapshotEvidence, after: SnapshotEvidence) {
  const uncovered: { file: string; side: "before" | "after"; start: number; end: number }[] = [];
  const changedText = [...new Set([...before.files, ...after.files].filter(file => /\.(md|markdown)$/i.test(file.file) && withinScope(file.file, document.scope)).map(file => file.file))]
    .filter(file => before.files.find(item => item.file === file)?.hash !== after.files.find(item => item.file === file)?.hash);
  for (const file of changedText) {
    const assessments = accepted.filter(item => item.kind === "convergence" && item.section?.path === file);
    for (const side of ["before", "after"] as const) {
      const snapshot = side === "before" ? before : after, analysis = await boundAnalysis(projectRoot, comparison, side);
      const changed = comparison.units[side].filter(unit => unit.file === file && unit.kind !== "file" && !comparison.units[side === "before" ? "after" : "before"].some(other => other.key === unit.key && other.hash === unit.hash));
      const targets = changed.length ? changed.filter(unit => !changed.some(child => child !== unit && child.start >= unit.start && child.end <= unit.end && (child.start !== unit.start || child.end !== unit.end))) : comparison.units[side].filter(unit => unit.file === file && unit.kind === "file");
      const spans = (await Promise.all(assessments.map(item => resolveReference(projectRoot, snapshot, item.section!, analysis)))).filter(result => result.status === "resolved").flatMap(result => result.units);
      for (const target of targets) if (!spans.some(span => span.start <= target.start && span.end >= target.end)) uncovered.push({ file, side, start: target.start, end: target.end });
    }
  }
  return uncovered;
}
// Files whose captured bytes differ between two snapshots, including files added or removed.
const changedFiles = (earlier: SnapshotEvidence, current: SnapshotEvidence, files = [...new Set([...earlier.files, ...current.files].map(item => item.file))]) =>
  files.filter(file => canonical(earlier.files.find(item => item.file === file) ?? null) !== canonical(current.files.find(item => item.file === file) ?? null));
const acceptedIn = (review: ReviewRecord, wave: Wave) => review.assessments.filter(item => item.wave === wave.id && item.acceptedBy && !review.exchangeWorkers.includes(item.acceptedBy));

// An accepted assessment of an earlier wave carries into the current wave only while its judgment rests on unchanged evidence:
// every observation it names is still reported, each measured growth it justifies is still measured and has not increased,
// every file it cites or that its observations point at has the same bytes, and it passes the current wave's validation.
// File-level observation IDs stay the same when the file changes, so the file check is what makes a carried judgment current.
async function carryCandidates(projectRoot: string, review: ReviewRecord, wave: Wave, from: Wave, lane: string, acceptedBy: string) {
  if (from.id === wave.id || from.baselineId !== wave.baselineId) throw conservationError("gate_blocked", "Assessments carry forward only from an earlier wave of the same baseline.");
  laneOf(wave, lane); laneOf(from, lane);
  const comparison = await comparisonFor(projectRoot, review, wave), previous = await conservationStore.get<ComparisonEvidence>(projectRoot, from.comparisonId, "comparison");
  const earlier = await conservationStore.get<SnapshotEvidence>(projectRoot, from.snapshotId, "snapshot"), current = await conservationStore.get<SnapshotEvidence>(projectRoot, wave.snapshotId, "snapshot");
  const document = (await readChangeMapDocument(projectRoot, review.deltaPath, wave.deltaRevision)).document as DeltaDocument;
  const carried: Assessment[] = [], notCarried: { id: string; reason: string }[] = [];
  for (const assessment of acceptedIn(review, from).filter(item => item.lane === lane)) {
    const id = `${wave.id}/${assessment.id.startsWith(`${from.id}/`) ? assessment.id.slice(from.id.length + 1) : assessment.id}`;
    const skip = (reason: string) => notCarried.push({ id: assessment.id, reason });
    if (review.assessments.some(item => item.id === id)) { skip("It is already in this wave."); continue; }
    const observations = (assessment.observationIds || []).map(item => previous.observations.find(observation => observation.id === item));
    const missing = (assessment.observationIds || []).filter(item => !comparison.observations.some(observation => observation.id === item));
    if (missing.length) { skip(`The comparison no longer reports ${missing.join(", ")}.`); continue; }
    const growthIds: string[] = [];
    for (const item of assessment.growthIds || []) {
      const old = previous.growth.find(growth => growth.id === item), next = old && comparison.growth.find(growth => growth.dimension === old.dimension);
      if (next && next.increase <= old!.increase) growthIds.push(next.id);
    }
    if (growthIds.length !== (assessment.growthIds || []).length) { skip("A justified growth is no longer measured or has increased."); continue; }
    const references = [...assessment.evidence, ...(assessment.section ? [assessment.section] : []), ...(assessment.coverage || []).flatMap(item => [item.requirement, ...item.targets]), ...(assessment.justification?.requirements || [])];
    // An observation without a file, such as an unsupported measurement, judges the whole change, so every in-scope file must be unchanged.
    const whole = observations.some(observation => !observation?.file && !observation?.unit?.file) ? [...earlier.files, ...current.files].map(file => file.file).filter(file => withinScope(file, comparison.scope)) : [];
    const files = new Set([...references.map(reference => reference.path), ...whole, ...observations.flatMap(observation => [observation?.file, observation?.unit?.file]).filter((file): file is string => Boolean(file))]);
    const changed = changedFiles(earlier, current, [...files]);
    if (changed.length) { skip(`Its files changed: ${changed.join(", ")}.`); continue; }
    const copy: Assessment = { ...assessment, id, wave: wave.id, acceptedBy, ...(assessment.growthIds ? { growthIds } : {}) };
    try { await assessmentValid(projectRoot, review, wave, copy, comparison, document); } catch (error) { skip((error as Error).message); continue; }
    carried.push(copy);
  }
  return { carried, notCarried };
}

// A ready-to-fill batch for what the gate still needs, so the next round writes it directly.
// Placeholders in angle brackets are the reviewer's to fill; every ID, path and coverage requirement is already bound.
async function assessmentSkeleton(projectRoot: string, review: ReviewRecord, wave: Wave) {
  const comparison = await comparisonFor(projectRoot, review, wave), accepted = acceptedIn(review, wave);
  const document = (await readChangeMapDocument(projectRoot, review.deltaPath, wave.deltaRevision)).document as DeltaDocument;
  const before = await conservationStore.get<SnapshotEvidence>(projectRoot, wave.baselineId, "snapshot"), after = await conservationStore.get<SnapshotEvidence>(projectRoot, wave.snapshotId, "snapshot");
  const laneFor = (file?: string) => (file && wave.lanes.find(lane => withinScope(file, lane.coverage)) || wave.lanes[0]).id;
  const groups = new Map<string, { lane: string; kind: "manual" | "implementation-detail"; code: string; ids: string[]; files: Set<string> }>();
  for (const observation of comparison.observations) {
    if (deferredDesignObservation(wave, observation) || observation.severity === "failure" || accepted.some(item => item.observationIds?.includes(observation.id))) continue;
    const file = observation.unit?.file || observation.file, kind = observation.code === "unclassified_unit" ? "implementation-detail" : "manual", lane = laneFor(file);
    const key = canonical([lane, kind, kind === "manual" ? observation.code : file]);
    const group = groups.get(key) ?? { lane, kind, code: observation.code, ids: [], files: new Set<string>() };
    group.ids.push(observation.id); if (file) group.files.add(file); groups.set(key, group);
  }
  const operations: Operation[] = [];
  const evidence = (files: Iterable<string>) => { const list = [...files].map(path => ({ path })); return list.length ? list : [{ path: "<file you checked>" }]; };
  for (const group of groups.values()) for (let index = 0; index < group.ids.length; index += 100) operations.push({ op: "record_assessment", assessment: {
    id: `<${group.kind === "manual" ? group.code : "detail"} id>`, lane: group.lane, kind: group.kind, observationIds: group.ids.slice(index, index + 100), evidence: evidence(group.files),
    ...(group.kind === "implementation-detail" ? { conceptId: "<planned ADD, MODIFY, or REPLACE change ID>" } : {}), reason: `<what you checked for ${group.code}>` } });
  const growth = comparison.growth.filter(item => !accepted.some(assessment => assessment.kind === "growth" && assessment.growthIds?.includes(item.id)));
  if (growth.length) operations.push({ op: "record_assessment", assessment: { id: "<growth id>", lane: wave.lanes[0].id, kind: "growth", growthIds: growth.map(item => item.id), evidence: [{ path: "<file you checked>" }],
    justification: { dimensions: [...new Set(growth.map(item => item.dimension))], conceptIds: ["<IDs of the changes that cause the growth>"], requirements: document.requirements?.length ? document.requirements : [{ path: "<governing requirement>" }], reason: "<why the requirement needs the growth>" }, reason: "<what you checked>" } });
  for (const file of new Set((await uncoveredText(projectRoot, comparison, accepted, document, before, after)).map(item => item.file))) operations.push({ op: "record_assessment", assessment: {
    id: `<convergence id for ${file}>`, lane: laneFor(file), kind: "convergence", section: { path: file }, decision: "<retain|replace|consolidate|delete>", evidence: [{ path: file }],
    conceptIds: document.concepts.filter(entry => ["rule", "exception", "prohibition"].includes(entry.kind) && [...entry.before, ...entry.after].some(ref => ref.path === file)).map(entry => entry.id),
    coverage: (document.requirements || []).map(requirement => ({ requirement, targets: [{ path: "<resulting target>" }] })), reason: "<meaning, coverage and preserved obligations>" } });
  return operations;
}

async function waveProblems(projectRoot: string, review: ReviewRecord, wave: Wave, requireLaneResults: boolean, designAccepted = false) {
  const problems: { code: string; message: string; id?: string }[] = [];
  const add = (code: string, message: string, id?: string) => problems.push({ code, message, ...(id ? { id } : {}) });
  if (verifiedTreeWave(wave)) return reviewerProblems(review, wave, requireLaneResults, problems);
  const loaded = await readChangeMapDocument(projectRoot, review.deltaPath, wave.deltaRevision), document = loaded.document as DeltaDocument;
  if (document.baselineId !== review.baselineId || wave.baselineId !== review.baselineId) add("baseline_changed", "The original baseline must remain unchanged.");
  for (const item of await assessDeltaReadiness(projectRoot, document)) if (item.blocking !== false) add(item.code, item.message, item.id);
  const comparison = await comparisonFor(projectRoot, review, wave);
  const accepted = acceptedIn(review, wave);
  for (const assessment of accepted) await assessmentValid(projectRoot, review, wave, assessment, comparison, document);
  for (const observation of comparison.observations) {
    if (deferredDesignObservation(wave, observation)) continue;
    if (observation.severity === "failure") add(observation.code, observation.message, observation.id);
    else if (!accepted.some(item => item.observationIds?.includes(observation.id))) add("manual_evidence_missing", observation.message, observation.id);
  }
  for (const growth of comparison.growth) if (!accepted.some(item => item.kind === "growth" && item.growthIds?.includes(growth.id))) add("growth_justification_missing", `Justify the increase in ${growth.dimension}.`, growth.id);
  const before = await conservationStore.get<SnapshotEvidence>(projectRoot, wave.baselineId, "snapshot"), after = await conservationStore.get<SnapshotEvidence>(projectRoot, wave.snapshotId, "snapshot");
  for (const target of await uncoveredText(projectRoot, comparison, accepted, document, before, after)) add("convergence_missing", "Each changed text section needs a reviewed convergence assessment that covers its exact source. A section that names only the file path covers the whole file.", `${target.file}:${target.side}:${target.start}:${target.end}`);
  for (const file of targetFiles(comparison)) if (!wave.lanes.some(lane => withinScope(file, lane.coverage))) add("review_coverage_missing", "Assign each original and resulting target file to a review lane.", file);
  reviewerProblems(review, wave, requireLaneResults, problems);
  if (wave.mode === "implementation-review" && !designAudited(review, wave, designAccepted)) add("design_audit_missing", "Implementation review requires the latest accepted design revision.");
  await conservationStore.assertCurrent(projectRoot, wave.snapshotId);
  return problems;
}

// The checks every wave needs: resolved findings and conflicts, current CLEAN lane results, and independent reviewers.
function reviewerProblems(review: ReviewRecord, wave: Wave, requireLaneResults: boolean, problems: { code: string; message: string; id?: string }[]) {
  const add = (code: string, message: string, id?: string) => problems.push({ code, message, ...(id ? { id } : {}) });
  for (const finding of review.findings.filter(item => item.mode === wave.mode && !closedFinding(item))) add("finding_unresolved", finding.title, finding.id);
  for (const conflict of review.conflicts.filter(item => !item.resolved)) add("review_conflict", conflict.reason, conflict.id);
  if (requireLaneResults) for (const lane of wave.lanes) if (!lane.result || !(lane.result.status === "CLEAN" || deferredLane(review, wave, lane)) || lane.result.digest !== laneDigest(review, wave, lane)) add("lane_result_stale", "Every assigned lane needs a current CLEAN result, or a current FINDINGS result whose unverified findings are all deferred.", lane.id);
  for (const lane of wave.lanes) if (lane.reviewer === review.coordinator || review.deliveryWorkers.includes(lane.reviewer) || review.exchangeWorkers.includes(lane.reviewer)) add("reviewer_not_independent", "A correction participant cannot verify the correction.", lane.id);
  return problems;
}

// What the next round can write: assessments that carry forward unchanged, then a skeleton for the rest.
// Each lane carries from the latest earlier wave of the same mode and baseline that holds accepted assessments in that lane,
// because a correction can follow a wave of the other mode or a wave that only fixed findings.
async function nextSteps(projectRoot: string, review: ReviewRecord, wave: Wave) {
  if (verifiedTreeWave(wave)) return {};
  const earlier = review.waves.slice(0, review.waves.indexOf(wave)).reverse(), carryable: { lane: string; fromWave: string; ids: string[] }[] = [];
  for (const lane of wave.lanes) {
    const from = earlier.find(item => item.mode === wave.mode && item.baselineId === wave.baselineId && acceptedIn(review, item).some(assessment => assessment.lane === lane.id));
    if (!from) continue;
    const { carried } = await carryCandidates(projectRoot, review, wave, from, lane.id, lane.reviewer).catch(() => ({ carried: [] as Assessment[] }));
    if (carried.length) carryable.push({ lane: lane.id, fromWave: from.id, ids: carried.map(item => item.id.slice(wave.id.length + 1)) });
  }
  const skeleton = await assessmentSkeleton(projectRoot, review, wave).catch(() => []);
  const scope = await correctionScope(projectRoot, review, wave).catch(() => undefined);
  return { ...(scope ? { correctionScope: scope } : {}), ...(carryable.length ? { carryable } : {}), ...(skeleton.length ? { assessmentSkeleton: skeleton } : {}) };
}

// A correction wave re-reviews what changed since the previous wave of its mode: each lane gets the files whose bytes changed in its coverage.
// Snapshots record file digests, not text, so the scope names whole files that the reviewer reads in full.
async function correctionScope(projectRoot: string, review: ReviewRecord, wave: Wave) {
  const previous = review.waves.slice(0, review.waves.indexOf(wave)).reverse().find(item => item.mode === wave.mode);
  if (!previous) return undefined;
  const changed = changedFiles(await conservationStore.get<SnapshotEvidence>(projectRoot, previous.snapshotId, "snapshot"), await conservationStore.get<SnapshotEvidence>(projectRoot, wave.snapshotId, "snapshot"));
  return { fromWave: previous.id, deltaChanged: previous.deltaRevision !== wave.deltaRevision, lanes: wave.lanes.map(lane => ({ lane: lane.id, changedFiles: changed.filter(file => withinScope(file, lane.coverage)) })) };
}

export async function checkReviewGate(input: SliceInput & { expectedRevision?: string; gate: "implementation" | "completion" }) {
  assertInput(CHECK_REVIEW_GATE_SCHEMA, input);
  const loaded = await loadReview(input.projectRoot, input.initiative, input.slice);
  if (input.expectedRevision && input.expectedRevision !== loaded.revision) throw conservationError("revision_conflict", "The review record changed.", { currentRevision: loaded.revision });
  const review = loaded.document;
  if (!review) return { ready: false, problems: [{ code: "evidence_missing", message: "The review record is missing." }] };
  const designAccepted = Boolean(await acceptedDesign(input.projectRoot, input.initiative, input.slice));
  const mode = input.gate === "implementation" ? "design-audit" : "implementation-review", wave = [...review.waves].reverse().find(item => item.mode === mode);
  if (!wave?.accepted) {
    const blockers = wave ? await waveProblems(input.projectRoot, review, wave, true, designAccepted).catch(() => []) : [];
    const message = blockers.length ? `The required review wave ${wave!.id} has no accepted result, and accepting it now would fail on: ${summarizeProblems(blockers)}.` : "The required review wave has no accepted result.";
    return { ready: false, revision: loaded.revision, problems: [{ code: "review_not_accepted", message }], ...(wave ? await nextSteps(input.projectRoot, review, wave) : {}) };
  }
  const problems = await waveProblems(input.projectRoot, review, wave, true, designAccepted);
  if (wave.accepted.evidenceDigest !== waveDigest(review, wave)) problems.push({ code: "review_result_stale", message: "The accepted review inputs changed." });
  if (input.gate === "completion" && !designAccepted) {
    const audit = [...review.waves].reverse().find(item => item.mode === "design-audit");
    if (!audit?.accepted || audit.baselineId !== wave.baselineId || audit.deltaRevision !== wave.deltaRevision) problems.push({ code: "design_audit_missing", message: "Completion requires the latest accepted design revision." });
  }
  return { ready: problems.length === 0, revision: loaded.revision, wave: wave.id, ...(wave.tree ? { tree: wave.tree } : {}), deltaRevision: wave.deltaRevision, baselineId: wave.baselineId,
    snapshotId: wave.snapshotId, comparisonId: wave.comparisonId, evidenceDigest: wave.accepted.evidenceDigest, problems };
}

function markdown(review: ReviewRecord) {
  const lines = ["# Slice review", "", "This file is a generated view of review.json.", ""];
  for (const wave of review.waves) { lines.push(`## ${wave.mode}: ${wave.id}`, "", ...(verifiedTreeWave(wave) ? [`Verified tree: ${wave.tree}`, ...(wave.base ? [`Base: ${wave.base}`] : [])] : [`Change map revision: ${wave.deltaRevision}`, `Source snapshot: ${wave.snapshotId}`, `Comparison: ${wave.comparisonId}`]), "");
    for (const lane of wave.lanes) lines.push(`- ${lane.id}: ${lane.result?.status || "PENDING"} (${lane.reviewer})`); lines.push(""); }
  for (const finding of review.findings) lines.push(`## ${finding.id}: ${finding.title}`, "", `- Status: ${finding.status}`, ...(finding.deferral ? [`- Deferred: gate ${finding.deferral.gate}, follow-up ${finding.deferral.followUp}`] : []), `- Severity: ${finding.severity}`, `- Evidence: ${finding.evidence}`, `- Condition to close: ${finding.conditionToClose}`, `- Implementer evidence: ${finding.implementerEvidence || "none"}`, "");
  return lines.join("\n") + "\n";
}
// The generated review.md stays beside slice.md, where people read it in pull requests.
async function reviewProjection(input: SliceInput) {
  const folder = await sliceDocumentFolder(input.projectRoot, input.initiative, input.slice);
  if (folder === null) throw conservationError("invalid_path", "The workflow config disables the plans path.");
  return resolveArtifactPath(input.projectRoot, `${folder}/review.md`, false, "review.md");
}
function compactHistory(finding: Finding) {
  let previous = finding.evidence;
  const history = finding.history.map(({ evidence, ...entry }) => {
    const same = evidence === previous;
    previous = evidence;
    return same ? entry : { ...entry, evidence };
  });
  return { ...finding, history };
}
const titleWords = (title: string) => new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2));
// Another unverified finding of the same wave on the same path whose title shares most of its words is probably the same defect from an overlapping lane.
function likelyDuplicates(review: ReviewRecord, wave: Wave, finding: Finding) {
  const words = titleWords(finding.title);
  return review.findings.filter(item => item !== finding && !closedFinding(item) && item.affectedPath === finding.affectedPath && raisedIn(item) === wave.id).filter(item => {
    const other = titleWords(item.title);
    const shared = [...words].filter(word => other.has(word)).length;
    return shared / Math.max(1, Math.min(words.size, other.size)) >= 0.6;
  }).map(item => item.id);
}
export async function getReview(input: SliceInput & { expectedRevision?: string | null; offset?: number; limit?: number; section?: keyof Pick<ReviewRecord, "findings" | "waves" | "assessments" | "conflicts" | "legacy" | "history">; wave?: string }) {
  assertInput(GET_REVIEW_SCHEMA, input);
  const loaded = await loadReview(input.projectRoot, input.initiative, input.slice);
  if (input.expectedRevision !== undefined && loaded.revision !== input.expectedRevision) throw conservationError("revision_conflict", "The review record changed.", { currentRevision: loaded.revision });
  if (!loaded.document) return { exists: false, revision: null };
  const section = input.section || "findings", offset = input.offset || 0, limit = input.limit || 50;
  if (input.wave !== undefined && (section === "legacy" || section === "history")) throw conservationError("validation_failed", "The wave filter applies to findings, waves, assessments, and conflicts.");
  const list: unknown[] = input.wave === undefined ? loaded.document[section] : section === "findings" ? loaded.document.findings.filter(item => raisedIn(item) === input.wave)
    : section === "waves" ? loaded.document.waves.filter(item => item.id === input.wave) : (loaded.document[section] as { wave: string }[]).filter(item => item.wave === input.wave);
  let projectionStale = true;
  try { const projection = await reviewProjection(input); projectionStale = (await regularBytes(projection.target, 4 * 1024 * 1024)).toString() !== markdown(loaded.document); } catch { /* The authoritative record remains readable. */ }
  const entries = list.slice(offset, offset + limit), current = lastWave(loaded.document);
  // A waves page that holds the current wave names it instead of repeating it, and a finding's history repeats evidence only when it changed.
  const currentWave = section === "waves" && current && entries.includes(current) ? { id: current.id } : current;
  return { exists: true, revision: loaded.revision, schemaVersion: 1, deltaPath: loaded.document.deltaPath, baselineId: loaded.document.baselineId,
    coordinator: loaded.document.coordinator, delivery: loaded.document.delivery, currentWave, section, entries: section === "findings" ? (entries as Finding[]).map(compactHistory) : entries, totalCount: list.length, deferred: deferredFindings(loaded.document),
    nextOffset: offset + limit < list.length ? offset + limit : null, projectionStale };
}

export async function updateReview(input: UpdateInput) {
  assertInput(UPDATE_REVIEW_SCHEMA, input);
  // A review of a shipped initiative's slice is history, so a change to it is refused after argument validation and before any other check.
  await refuseShipped(input.projectRoot, input.initiative);
  await moveLegacyRecords(input.projectRoot);
  const resolved = await locateRecord(input.projectRoot, { kind: "review", initiative: input.initiative, slice: input.slice });
  const deltaTarget = await locateRecord(input.projectRoot, { kind: "change-map", initiative: input.initiative, slice: input.slice });
  await mkdir(path.dirname(resolved.target), { recursive: true });
  return withArtifactLock(resolved.target, () => withFileLock(resolved.target, async () => {
    // A ship that landed after the first check refuses the update too, so the review never changes after the initiative shipped.
    await refuseShipped(input.projectRoot, input.initiative);
    const loaded = await loadReview(input.projectRoot, input.initiative, input.slice);
    if (loaded.revision !== input.expectedRevision) throw conservationError("revision_conflict", "The review record changed.", { currentRevision: loaded.revision });
    if (!loaded.document && (!input.delivery || input.actor.role !== "coordinator")) throw conservationError("validation_failed", "The first update of a slice's review creates it, so it needs the coordinator as actor and the implementer's worker id as delivery.");
    return withArtifactLock(deltaTarget.target, () => withFileLock(deltaTarget.target, async () => {
    const review: ReviewRecord = structuredClone(loaded.document || { schemaVersion: 1, deltaPath: deltaTarget.path, coordinator: input.actor.id, delivery: input.delivery!, deliveryWorkers: [input.delivery!], waves: [], findings: [], assessments: [], conflicts: [], exchangeWorkers: [], legacy: [], history: [] });
    if (!(await sameRecord(input.projectRoot, review.deltaPath, deltaTarget.path))) throw conservationError("invalid_path", "A review and its change map must belong to the same slice.");
    const designAccepted = Boolean(await acceptedDesign(input.projectRoot, input.initiative, input.slice));
    const now = () => new Date().toISOString(), carry = { carried: [] as string[], notCarried: [] as { id: string; reason: string }[] };
    const warnings: { code: string; finding: string; duplicates: string[]; message: string }[] = [];
    for (const operation of input.operations) {
      const wave = lastWave(review), op = operation.op;
      if (op === "start_wave") {
        requireRole(review, input.actor, "coordinator");
        const next = operation as unknown as { id: string; mode: Mode; deltaRevision?: string; snapshotId?: string; comparisonId?: string; base?: string; lanes: Lane[] };
        if (review.waves.some(item => item.id === next.id) || !next.lanes.length || new Set(next.lanes.map(lane => lane.id)).size !== next.lanes.length || next.lanes.some(lane => !lane.coverage.length || lane.reviewer === review.coordinator || review.deliveryWorkers.includes(lane.reviewer))) throw conservationError("validation_failed", "Assign distinct review lanes and independent reviewers.");
        const requiredLanes = review.waves.filter(item => item.mode === next.mode).flatMap(item => item.lanes.map(lane => lane.id));
        if (requiredLanes.some(id => !next.lanes.some(lane => lane.id === id))) throw conservationError("gate_blocked", "A correction wave must retain every required lane from earlier waves in this review mode.");
        const design = await acceptedDesign(input.projectRoot, input.initiative, input.slice) as { acceptedAt?: string } | null;
        if (next.mode === "implementation-review" && design?.acceptedAt) await assertReviewMayContinue(input, review, next as { afterGate?: string }, design.acceptedAt);
        const started = { startedAt: now(), ...((next as { afterGate?: string }).afterGate ? { afterGate: (next as { afterGate?: string }).afterGate } : {}) };
        const evidenceFields = [next.deltaRevision, next.snapshotId, next.comparisonId].filter(Boolean).length;
        if (evidenceFields === 0) {
          if (!designAccepted || next.mode !== "implementation-review") throw conservationError("validation_failed", "A wave without change map evidence reviews the implementation of a slice with an accepted design; other waves need deltaRevision, snapshotId, and comparisonId.");
          const verified = await latestVerification(input.projectRoot, input.initiative, input.slice);
          if (!verified?.passed) throw conservationError("gate_blocked", "Run verify_slice until it passes before starting the review, so the review reads a verified result.");
          review.waves.push({ id: next.id, mode: next.mode, tree: verified.tree, ...(next.base ? { base: next.base } : {}), ...started, lanes: next.lanes } as Wave);
        } else {
        if (evidenceFields !== 3) throw conservationError("validation_failed", "Pass deltaRevision, snapshotId, and comparisonId together.");
        const delta = await readChangeMapDocument(input.projectRoot, review.deltaPath, next.deltaRevision);
        const baselineId = (delta.document as DeltaDocument | null)?.baselineId;
        if (!baselineId || (review.baselineId && review.baselineId !== baselineId)) throw conservationError("gate_blocked", "A review must preserve its original retained baseline.");
        const created: Wave = { id: next.id, mode: next.mode, deltaRevision: next.deltaRevision!, snapshotId: next.snapshotId!, comparisonId: next.comparisonId!, baselineId, ...started, lanes: next.lanes };
        // Such a wave could never be accepted, so its review work would be lost.
        if (created.mode === "implementation-review" && !designAudited(review, created, designAccepted)) throw conservationError("gate_blocked", `Implementation review requires the latest accepted design revision. Start and accept a design-audit wave for delta revision ${created.deltaRevision} before ${created.id}.`, { problems: [{ code: "design_audit_missing", message: "Implementation review requires the latest accepted design revision." }] });
        const comparison = await comparisonFor(input.projectRoot, review, created);
        const uncovered = targetFiles(comparison).filter(file => !created.lanes.some(lane => withinScope(file, lane.coverage)));
        if (uncovered.length) throw conservationError("validation_failed", "Lane coverage holds project-relative path prefixes, such as src/server/session, and each target file of the comparison needs a lane.", { problems: uncovered.map(file => ({ code: "review_coverage_missing", file, message: "no lane covers this target file" })) });
        await conservationStore.assertCurrent(input.projectRoot, next.snapshotId!);
        review.baselineId = baselineId; review.waves.push(created);
        }
      } else if (op === "assign_delivery") { requireRole(review, input.actor, "coordinator"); if (review.waves.some(item => item.lanes.some(lane => lane.reviewer === operation.worker))) throw conservationError("gate_blocked", "A reviewer cannot become delivery for its own review."); review.delivery = operation.worker as string; review.deliveryWorkers = [...new Set([...review.deliveryWorkers, review.delivery])];
      } else if (op === "import_legacy") {
        requireRole(review, input.actor, "coordinator");
        const legacy = await resolveArtifactPath(input.projectRoot, operation.path as string, false, "findings.md");
        const bytes = await regularBytes(legacy.target, 1024 * 1024);
        if (!review.legacy.some(item => item.hash === digest(bytes))) review.legacy.push({ path: operation.path as string, hash: digest(bytes), content: bytes.toString() });
      } else if (op === "regenerate_markdown") { requireRole(review, input.actor, "coordinator");
      } else {
        if (!wave) throw conservationError("validation_failed", "Start a review wave before recording review evidence.");
        if (verifiedTreeWave(wave) && ["record_assessment", "accept_assessment", "carry_assessments"].includes(op)) throw conservationError("validation_failed", "Assessments belong to change map reviews; a review of a verified result records findings and lane results only.");
        if (op === "open_finding") {
          const fields = operation as unknown as Omit<Finding, "id" | "mode" | "status" | "implementerEvidence" | "history">;
          reviewer(review, wave, input.actor, fields.lane);
          const id = `${wave.mode}/${fields.lane}/${fields.localId}`;
          if (review.findings.some(item => item.id === id)) throw conservationError("validation_failed", "The finding ID already exists.");
          review.findings.push({ id, localId: fields.localId, lane: fields.lane, mode: wave.mode, title: fields.title, severity: fields.severity, affectedPath: fields.affectedPath,
            evidence: fields.evidence, conditionToClose: fields.conditionToClose, aliases: fields.aliases || [], escalationTarget: fields.escalationTarget || "NONE", ...(fields.probe ? { probe: fields.probe } : {}), ...(fields.clause ? { clause: fields.clause } : {}),
            status: "OPEN", implementerEvidence: "", history: [{ actor: input.actor.id, status: "OPEN", wave: wave.id, at: now(), evidence: fields.evidence }] });
          const duplicates = likelyDuplicates(review, wave, review.findings.at(-1)!);
          if (duplicates.length) warnings.push({ code: "likely_duplicate", finding: id, duplicates, message: `${id} looks like ${duplicates.join(", ")}: same affected path and a similar title in wave ${wave.id}. Read those findings and keep one.` });
        } else if (op === "revise_finding") {
          // A wrong clause would stop every later implementation-review wave, and a wrong close condition can contradict another finding,
          // so the coordinator may correct either, and the opening lane's reviewer may correct the close condition, with a reason the history keeps.
          const finding = review.findings.find(item => item.id === operation.id);
          if (!finding) throw conservationError("validation_failed", "The finding does not exist.");
          refuseDeferred(finding);
          if (finding.status === "VERIFIED") throw conservationError("gate_blocked", "A verified finding is closed; reopen it before revising it.");
          const changesClause = operation.clause !== undefined || operation.clearClause === true;
          if (operation.clause !== undefined && operation.clearClause === true) throw conservationError("validation_failed", "Pass clause to change the clause or clearClause to remove it, not both.");
          if (!changesClause && operation.conditionToClose === undefined) throw conservationError("validation_failed", "Pass clause, clearClause, or conditionToClose to revise.");
          if (changesClause || input.actor.role !== "reviewer") requireRole(review, input.actor, "coordinator");
          else if (finding.mode !== wave.mode) throw conservationError("validation_failed", "The finding does not belong to the current review mode.");
          else reviewer(review, wave, input.actor, finding.lane);
          const revised: Revision = {};
          if (changesClause) {
            const to = operation.clearClause === true ? undefined : operation.clause as string;
            if (to !== finding.clause) revised.clause = { ...(finding.clause ? { from: finding.clause } : {}), ...(to ? { to } : {}) };
            if (to) finding.clause = to; else delete finding.clause;
          }
          if (operation.conditionToClose !== undefined && operation.conditionToClose !== finding.conditionToClose) {
            revised.conditionToClose = { from: finding.conditionToClose, to: operation.conditionToClose as string };
            finding.conditionToClose = operation.conditionToClose as string;
          }
          if (!Object.keys(revised).length) throw conservationError("validation_failed", "The revision changes nothing.");
          finding.history.push({ actor: input.actor.id, status: finding.status, wave: wave.id, at: now(), evidence: operation.reason as string, revised });
        } else if (op === "set_finding_status") {
          const finding = review.findings.find(item => item.id === operation.id), status = operation.status as Status;
          if (!finding || finding.mode !== wave.mode) throw conservationError("validation_failed", "The finding does not belong to the current review mode.");
          refuseDeferred(finding);
          if (["IN PROGRESS", "FIXED"].includes(status)) { requireRole(review, input.actor, "delivery"); if (finding.status === "VERIFIED") throw conservationError("gate_blocked", "A reviewer must reopen a verified finding."); finding.implementerEvidence = operation.evidence as string; }
          else { reviewer(review, wave, input.actor, finding.lane, true); if (status === "VERIFIED" && finding.status !== "FIXED") throw conservationError("gate_blocked", "Only a corrected FIXED finding can be verified."); }
          finding.status = status; finding.history.push({ actor: input.actor.id, status, wave: wave.id, at: now(), evidence: operation.evidence as string });
        } else if (op === "record_assessment") {
          const data = operation.assessment as Omit<Assessment, "wave" | "author" | "acceptedBy">;
          laneOf(wave, data.lane);
          if (review.assessments.some(item => item.id === data.id)) throw conservationError("validation_failed", "The assessment ID already exists.");
          if (input.actor.role === "delivery") requireRole(review, input.actor, "delivery"); else reviewer(review, wave, input.actor, data.lane, true);
          const assessment = { ...data, wave: wave.id, author: input.actor.id, ...(input.actor.role === "reviewer" ? { acceptedBy: input.actor.id } : {}) };
          const delta = await readChangeMapDocument(input.projectRoot, review.deltaPath, wave.deltaRevision);
          await assessmentValid(input.projectRoot, review, wave, assessment, await comparisonFor(input.projectRoot, review, wave), delta.document as DeltaDocument);
          review.assessments.push(assessment);
        } else if (op === "accept_assessment") {
          const assessment = review.assessments.find(item => item.id === operation.id && item.wave === wave.id);
          if (!assessment) throw conservationError("validation_failed", "The assessment is not part of this wave.");
          reviewer(review, wave, input.actor, assessment.lane, true);
          const delta = await readChangeMapDocument(input.projectRoot, review.deltaPath, wave.deltaRevision);
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
          if (operation.status === "CLEAN" && review.findings.some(item => item.mode === wave.mode && item.lane === lane.id && !closedFinding(item))) throw conservationError("gate_blocked", "Unresolved findings prevent a CLEAN lane result.");
          if (!verifiedTreeWave(wave)) await conservationStore.assertCurrent(input.projectRoot, wave.snapshotId);
          lane.result = { status: operation.status as "CLEAN" | "FINDINGS", reviewer: input.actor.id, digest: laneDigest(review, wave, lane) };
        } else if (op === "carry_lane") {
          requireRole(review, input.actor, "coordinator");
          const previous = review.waves.find(item => item.id === operation.fromWave && item.id !== wave.id), lane = laneOf(wave, operation.lane as string);
          const old = previous?.lanes.find(item => item.id === lane.id);
          if (!previous || !old || old.result?.status !== "CLEAN" || old.result.digest !== laneDigest(review, previous, old)
            || canonical([previous.mode, previous.deltaRevision, previous.baselineId, previous.snapshotId, previous.comparisonId, previous.tree ?? null, previous.base ?? null]) !== canonical([wave.mode, wave.deltaRevision, wave.baselineId, wave.snapshotId, wave.comparisonId, wave.tree ?? null, wave.base ?? null])
            || canonical([old.reviewer, old.coverage]) !== canonical([lane.reviewer, lane.coverage]) || review.exchangeWorkers.includes(lane.reviewer)) throw conservationError("gate_blocked", "A lane can carry forward only with unchanged inputs, coverage, findings and an independent reviewer.");
          if (review.assessments.some(item => item.wave === wave.id && item.lane === lane.id)) throw conservationError("gate_blocked", "A current lane assessment prevents carry-forward.");
          for (const assessment of review.assessments.filter(item => item.wave === previous.id && item.lane === lane.id)) review.assessments.push({ ...assessment, id: `${wave.id}/${assessment.id}`, wave: wave.id });
          lane.result = { status: "CLEAN", reviewer: lane.reviewer, digest: laneDigest(review, wave, lane) };
        } else if (op === "carry_assessments") {
          reviewer(review, wave, input.actor, operation.lane as string, true);
          const from = review.waves.find(item => item.id === operation.fromWave);
          if (!from) throw conservationError("validation_failed", "The source wave does not exist.");
          const requested = operation.ids as string[] | undefined;
          const { carried, notCarried } = await carryCandidates(input.projectRoot, review, wave, from, operation.lane as string, input.actor.id);
          const unknown = (requested || []).filter(id => !carried.some(item => item.id === `${wave.id}/${id.startsWith(`${from.id}/`) ? id.slice(from.id.length + 1) : id}`) && !notCarried.some(item => item.id === id));
          if (unknown.length) throw conservationError("validation_failed", `The source wave has no accepted assessment ${unknown.join(", ")} in this lane.`);
          const refused = notCarried.filter(item => requested?.includes(item.id));
          if (refused.length) throw conservationError("gate_blocked", `These assessments cannot carry forward: ${refused.map(item => `${item.id}: ${item.reason}`).join("; ")}`, { problems: refused.map(item => ({ code: "carry_refused", id: item.id, message: item.reason })) });
          const chosen = requested ? carried.filter(item => requested.some(id => item.id === `${wave.id}/${id.startsWith(`${from.id}/`) ? id.slice(from.id.length + 1) : id}`)) : carried;
          review.assessments.push(...chosen);
          carry.carried.push(...chosen.map(item => item.id)); if (!requested) carry.notCarried.push(...notCarried);
        } else if (op === "accept_wave") {
          requireRole(review, input.actor, "coordinator");
          const gate = operation.gate as string | undefined, deferrals = operation.deferrals as { finding: string; followUp: string }[] | undefined;
          if ((gate === undefined) !== (deferrals === undefined)) throw conservationError("validation_failed", "Pass gate and deferrals together: the decision gate whose answer chose accept-deferred, and a follow-up for each unresolved finding.");
          if (deferrals) {
            if (new Set(deferrals.map(item => item.finding)).size !== deferrals.length) throw conservationError("validation_failed", "Name each deferred finding once.");
            if (wave.mode !== "implementation-review") throw conservationError("validation_failed", "Only an implementation review wave accepts deferred findings.");
            await deferFindings(input, review, wave, gate!, deferrals, input.actor.id, now());
          }
          const problems = await waveProblems(input.projectRoot, review, wave, true, designAccepted);
          if (problems.length) throw conservationError("gate_blocked", `The review wave does not satisfy its acceptance gate: ${summarizeProblems(problems)}. check_review_gate lists the assessments that can carry forward from the previous wave and a ready-to-fill skeleton for the rest.`, { problems });
          wave.accepted = { evidenceDigest: waveDigest(review, wave), actor: input.actor.id, at: now() };
        }
      }
      if (op !== "regenerate_markdown") review.history.push({ actor: input.actor.id, operation: op, at: now() });
    }
    await conservationStore.registerSlice(input.projectRoot, input.initiative, input.slice);
    assertInput(recordSchema, review);
    assertDeferrals(review);
    const contents = canonical(review) + "\n";
    if (Buffer.byteLength(contents) > 4 * 1024 * 1024) throw conservationError("resource_limit", "The review record exceeds 4 MiB.");
    const changed = canonical(review) !== canonical(loaded.document);
    if (changed) await writeRecord(input.projectRoot, { kind: "review", initiative: input.initiative, slice: input.slice }, contents);
    let projectionStale = false;
    try { const projection = await reviewProjection(input); await mkdir(path.dirname(projection.target), { recursive: true }); await conservationStore.writeManaged(resolved.root, projection.target, markdown(review)); } catch { projectionStale = true; }
    const wave = lastWave(review);
    return { exists: true, revision: changed ? digest(contents) : loaded.revision, previousRevision: loaded.revision, projectionStale, currentWave: wave?.id, accepted: Boolean(wave?.accepted && wave.accepted.evidenceDigest === waveDigest(review, wave)),
      ...(input.operations.some(item => item.op === "carry_assessments") ? { carry } : {}), ...(warnings.length ? { warnings } : {}) };
    }, undefined, { renew: true }));
  }, undefined, { renew: true }));
}
