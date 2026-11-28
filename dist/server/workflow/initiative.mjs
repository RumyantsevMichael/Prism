// Generated from src/server/workflow/initiative.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertInput, describeErrors } from "./artifact-schema.mjs";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { analyzeInitiative, LEAF_STATUSES, parseLegacyMap, SLUG_PATTERN } from "./initiative-graph.mjs";
import { artifactKinds, initiativeDirectory, readWorkflowConfig, roadmapPaths } from "./workflow-config.mjs";
import { componentOf, dependentsOf, findComponent, readComponents, underSharedPath } from "./components.mjs";
import { resolveArtifactPath } from "../conservation/change-map.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { generatedNotice, writeProjection } from "./projection.mjs";
import { revisionMismatch } from "./revision.mjs";
import { inArtifactStore, listClaimRecords, listInitiatives, listStoreArtifacts, locateRecord, moveLegacyRecords, oversizedRevision, readArtifactText, readRecord, readStoreFileBytes, recordStoreOf, removeInitiativeRecords, removeRecord, withRecordLock, writeRecord } from "./record-store.mjs";
import { ARTIFACT_LOCATION_BYTES_MAX, ARTIFACT_NAME_FORM, artifactAddress as artifactAddressOf, collideInLetterCase, locationExcess, locationLimits, STORE_NAME_BYTES_MAX, wellFormedName } from "./artifact-paths.mjs";
import { acceptArtifactVersions, ArtifactError, storeArtifactLocation } from "./store-artifacts.mjs";
import { syncRecordStoreNow } from "./record-store-sync.mjs";
import { readAgentModel } from "../session/agent-models.mjs";
import { blockingClaim, callIsMainAgent, claimedMessage, claimHolder, claimHost, claimSession, claimLabel, claimView, dropClaim, holdClaim, isLive, newClaim, parseClaim, pendClaim, renewal, serializeClaim, settleClaim, takeLostClaims, adoptClaims } from "./slice-claims.mjs";
import { mergeHistory, mergeKeyed, mergeUnit, MergeConflict, parseVersions } from "./record-merge.mjs";
import { CONTRACT_TOKEN_BUDGET, designProblems, digestFrozenTests, installFrozenTests, latestDependentsRun, measureContract, restageFrozenTests, REVIEW_MARKS, stageFrozenTests, verifiedCode, withdrawFrozenTests } from "./slice-design.mjs";
import { effectiveSettings, readCoordinationState } from "./state.mjs";
import { checkFolderViews, listedViews, uncheckedViews, viewProblems } from "./diagram-check.mjs";
import { drawnKind, readSplitAssessment, readViews } from "./view-declarations.mjs";
import { denseCounts, isDense } from "./view-limits.mjs";
import { refuseShipped, shippedHistory } from "./shipped-history.mjs";
import { contractClauses, plannedChanges } from "./design-view.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { deferredFindings, loadReview } from "../review/review-ledger.mjs";
import { checkCitations } from "./artifact-citations.mjs";
import { sessionFields } from "../session/session-links.mjs";
const RECORD_NAME = "initiative.json";
const PROJECTION_NAME = "initiative.md";
const RECORD_MAX_BYTES = 1024 * 1024;
const HISTORY_LIMIT = 500;
class InitiativeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "InitiativeError";
    this.code = code;
    Object.assign(this, details);
  }
}
const fail = (code, message, details) => new InitiativeError(code, message, details);
const text = { type: "string", minLength: 1, maxLength: 2e3 };
const slug = { type: "string", minLength: 1, maxLength: 120 };
const strings = { type: "array", maxItems: 200, items: text };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const childSchema = object({ slug, title: text, outcome: text, requirements: strings }, ["slug", "title", "requirements"]);
const SPLIT_EVIDENCE_KINDS = Object.freeze(["contract_size", "unfrozen", "user_gate"]);
const evidenceSchema = { oneOf: [
  object({ kind: { const: "contract_size" }, files: { type: "array", minItems: 1, maxItems: 400, items: text } }),
  object({ kind: { const: "unfrozen" }, assumption: text, settledBy: slug }),
  object({ kind: { const: "user_gate" }, gate: text }, ["kind"])
] };
const splitOperation = object({ op: { const: "split" }, parent: slug, children: { type: "array", minItems: 1, maxItems: 50, items: childSchema }, evidence: evidenceSchema }, ["op", "parent", "children"]);
const dependenciesOperation = object({ op: { const: "set_dependencies" }, slug, dependencies: { type: "array", maxItems: 200, items: slug } });
const updateSliceOperation = object({ op: { const: "update_slice" }, slug, title: text, outcome: text }, ["op", "slug"]);
const acceptDesignOperation = object({ op: { const: "accept_design" }, slug, frozenTests: { type: "array", minItems: 1, maxItems: 200, items: text }, review: { enum: REVIEW_MARKS }, component: { type: "string", minLength: 1, maxLength: 200 } }, ["op", "slug", "frozenTests", "review"]);
const requirementsList = { type: "array", minItems: 1, maxItems: 200, items: text };
const addFixOperation = object({ op: { const: "add_fix" }, slug, defects: { type: "array", minItems: 1, maxItems: 50, items: slug }, fix: object({ slug, title: text, outcome: text, requirements: requirementsList }) });
const STANDALONE = /* @__PURE__ */ new Set(["remove_records", "propose_design", "accept_proposal"]);
const LOCAL_SYNC = /* @__PURE__ */ new Set(["no_upstream", "not_a_repository"]);
const GET_INITIATIVE_SCHEMA = object({ projectRoot: text, initiative: slug }, ["projectRoot", "initiative"]);
const UPDATE_INITIATIVE_SCHEMA = object({
  projectRoot: text,
  initiative: slug,
  expectedRevision: { oneOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
  actor: text,
  operations: { type: "array", minItems: 1, maxItems: 50, items: { oneOf: [
    object({ op: { const: "create" }, slug, title: text, outcome: text, requirements: strings }, ["op", "slug", "title", "requirements"]),
    splitOperation,
    object({ op: { const: "set_status" }, slug, status: { enum: LEAF_STATUSES } }),
    dependenciesOperation,
    updateSliceOperation,
    acceptDesignOperation,
    object({ op: { const: "propose_design" }, slug, operations: { type: "array", minItems: 1, maxItems: 50, items: { oneOf: [splitOperation, dependenciesOperation, updateSliceOperation, acceptDesignOperation, addFixOperation] } } }),
    addFixOperation,
    object({ op: { const: "report_defect" }, slug, requirements: requirementsList, summary: text }),
    object({ op: { const: "accept_proposal" }, slug, reviewRequired: { type: "array", maxItems: 200, items: slug }, gate: text }, ["op", "slug", "reviewRequired"]),
    object({ op: { const: "restore_tests" }, slug }),
    object({ op: { const: "report_contract_defects" }, slug, defects: { type: "array", minItems: 1, maxItems: 50, items: object({ clause: text, reason: text }) } }),
    object({ op: { const: "claim" }, slug }),
    object({ op: { const: "release_claim" }, slug }),
    object({ op: { const: "import_map" }, path: text }),
    object({ op: { const: "regenerate_markdown" } }),
    object({ op: { const: "remove_records" } })
  ] } }
}, ["projectRoot", "initiative", "expectedRevision", "operations"]);
function validateInput(schema, input) {
  try {
    assertInput(schema, input);
  } catch (error) {
    throw fail("validation_failed", `The initiative arguments are invalid: ${describeErrors(error.errors)}`, { errors: error.errors });
  }
}
async function resolveInitiative(projectRoot, initiative, createParent = false) {
  if (!SLUG_PATTERN.test(initiative ?? "")) {
    throw fail("invalid_path", "The initiative identifier must use letters, digits, hyphens, or underscores.");
  }
  const config = await readWorkflowConfig(projectRoot);
  const directory = initiativeDirectory(config, initiative);
  if (directory === null) {
    throw fail("invalid_config", "The workflow config disables the plans path, so initiatives have no location.");
  }
  const record = await locateRecord(projectRoot, { kind: "initiative", initiative });
  const store = (config.workspace?.store ?? null) !== null;
  const projectionPath = `${directory}/${PROJECTION_NAME}`;
  const inStore = store && await inArtifactStore(projectRoot, projectionPath);
  const projection = inStore ? { deltaPath: projectionPath } : await resolveArtifactPath(projectRoot, projectionPath, createParent, PROJECTION_NAME);
  return { root: record.root, initiative, directory, config, store, requirementsDirectory: config.paths.requirements, recordPath: record.path, target: record.target, projectionPath: projection.deltaPath, projectionInStore: inStore };
}
function revisionOf(contents) {
  return createHash("sha256").update(contents).digest("hex");
}
function canonicalRecord(record) {
  const slices = {};
  for (const key of Object.keys(record.slices).sort()) {
    const slice = record.slices[key];
    slices[key] = {
      title: slice.title,
      ...slice.outcome ? { outcome: slice.outcome } : {},
      status: slice.status,
      parent: slice.parent,
      ...slice.fixes ? { fixes: { slice: slice.fixes.slice, defects: [...slice.fixes.defects] } } : {},
      requirements: [...slice.requirements].sort(),
      dependencies: [...slice.dependencies].sort(),
      ...slice.component ? { component: slice.component } : {},
      ...slice.design ? { design: { acceptedAt: slice.design.acceptedAt, frozenTests: [...slice.design.frozenTests].sort((left, right) => left.path.localeCompare(right.path)), review: slice.design.review, ...slice.design.views ? { views: slice.design.views.map(({ path: file, kind, elements, relations, dense }) => ({ path: file, kind, elements, relations, dense })) } : {}, ...slice.design.baselineId ? { baselineId: slice.design.baselineId } : {}, ...slice.design.staged ? { staged: true } : {}, ...startOf(slice.design) } } : {},
      ...slice.splitEvidence ? { splitEvidence: slice.splitEvidence } : {},
      ...slice.contractDefects ? { contractDefects: slice.contractDefects } : {},
      ...slice.defects?.length ? { defects: slice.defects.map((item) => ({ id: item.id, requirements: [...item.requirements], summary: item.summary, reportedAt: item.reportedAt })) } : {}
    };
  }
  const proposals = Object.fromEntries(Object.keys(record.proposals ?? {}).sort().map((key) => [key, record.proposals[key]]));
  return { schemaVersion: 1, id: record.id, slices, ...Object.keys(proposals).length ? { proposals } : {}, history: record.history.slice(-HISTORY_LIMIT) };
}
function serialize(record) {
  return `${JSON.stringify(canonicalRecord(record), null, 2)}
`;
}
const COMPONENT_IDENTITY = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
function validateRecord(raw, initiative) {
  const errors = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: ["The initiative record must be a JSON object."] };
  }
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (raw.id !== initiative) errors.push(`id must equal the initiative folder name ${initiative}.`);
  if (!Array.isArray(raw.history)) errors.push("history must be an array.");
  for (const [key, slice] of Object.entries(raw.slices ?? {})) {
    for (const problem of designProblems(slice?.design)) errors.push(`${key}: ${problem}`);
    if (slice?.contractDefects !== void 0 && (!Array.isArray(slice.contractDefects) || slice.contractDefects.some((item) => typeof item?.clause !== "string" || typeof item?.reason !== "string"))) errors.push(`${key}: contractDefects must list { clause, reason } entries.`);
    if (slice?.component !== void 0 && (typeof slice.component !== "string" || !COMPONENT_IDENTITY.test(slice.component) || slice.status === "split")) errors.push(`${key}: component must be a <repository>/<component> identity on a slice that is not split.`);
    if (slice?.splitEvidence !== void 0 && (slice.status !== "split" || !SPLIT_EVIDENCE_KINDS.includes(slice.splitEvidence?.kind))) errors.push(`${key}: splitEvidence belongs to a split slice and names its kind.`);
    errors.push(...defectProblems(raw.slices, key));
  }
  if (raw.proposals !== void 0) {
    if (raw.proposals === null || typeof raw.proposals !== "object" || Array.isArray(raw.proposals)) errors.push("proposals must be an object keyed by scope.");
    else for (const [key, proposal] of Object.entries(raw.proposals)) if (!Object.hasOwn(raw.slices ?? {}, key) || !Array.isArray(proposal?.operations)) errors.push(`proposals.${key} must name a slice and list its operations.`);
  }
  let analysis = null;
  try {
    analysis = analyzeInitiative(raw.slices);
  } catch (error) {
    errors.push(error.message);
  }
  return { errors, analysis };
}
const DEFECT_ID = /^d[1-9][0-9]*$/;
function defectProblems(slices, key) {
  const slice = slices?.[key];
  const problems = [];
  if (slice?.defects !== void 0) {
    const valid = Array.isArray(slice.defects) && slice.defects.every((item) => DEFECT_ID.test(item?.id ?? "") && Array.isArray(item.requirements) && item.requirements.length > 0 && item.requirements.every((reference) => typeof reference === "string") && typeof item.summary === "string" && item.summary.length > 0 && typeof item.reportedAt === "string");
    if (!valid || new Set(slice.defects.map((item) => item.id)).size !== slice.defects.length) problems.push(`${key}: defects must list { id, requirements, summary, reportedAt } entries with distinct d<n> ids.`);
    if (slice.status !== "done") problems.push(`${key}: defects belong to a done slice.`);
  }
  if (slice?.fixes !== void 0) {
    const fixed = slices?.[slice.fixes?.slice];
    const held = new Set(Array.isArray(fixed?.defects) ? fixed.defects.map((item) => item?.id) : []);
    const defects = Array.isArray(slice.fixes?.defects) ? slice.fixes.defects : [];
    if (!defects.length || defects.some((id) => !held.has(id))) problems.push(`${key}: fixes must name defects that ${slice.fixes?.slice} holds.`);
    const shared = defects.filter((id) => Object.entries(slices).some(([other, value]) => other !== key && value?.fixes?.slice === slice.fixes.slice && Array.isArray(value.fixes.defects) && value.fixes.defects.includes(id)));
    if (shared.length) problems.push(`${key}: another fix slice of ${slice.fixes.slice} already fixes ${shared.join(", ")}.`);
  }
  return problems;
}
function unfinishedFixes(record) {
  const slices = record?.slices && typeof record.slices === "object" ? record.slices : {};
  const number = (id) => Number(String(id).slice(1));
  const found = [];
  for (const key of Object.keys(slices).sort()) {
    const defects = Array.isArray(slices[key]?.defects) ? [...slices[key].defects].sort((left, right) => number(left.id) - number(right.id)) : [];
    for (const defect of defects) {
      const fix = Object.keys(slices).sort().find((other) => slices[other]?.fixes?.slice === key && Array.isArray(slices[other].fixes.defects) && slices[other].fixes.defects.includes(defect.id));
      if (!fix) found.push({ slice: key, defect: defect.id, fix: null, status: "not-designed" });
      else if (slices[fix].status !== "done") found.push({ slice: key, defect: defect.id, fix, status: slices[fix].status });
    }
  }
  return found;
}
function unfinishedFixesMessage(initiative, fixes) {
  const named = fixes.map((item) => item.fix === null ? `${item.slice} ${item.defect} (no fix slice designed)` : `${item.slice} ${item.defect} (fix ${item.fix} is ${item.status})`);
  return `The initiative ${initiative} cannot ship while fixes to its done work are unfinished: ${named.join("; ")}. Design a fix slice for each defect and finish it before shipping.`;
}
function mergeInitiativeRecord(versions) {
  const initiative = versions.path.split("/")[1];
  try {
    const { base, local, upstream } = parseVersions(versions, () => ({ schemaVersion: 1, id: initiative, slices: {}, history: [] }));
    if ([base, local, upstream].some((record) => !record || typeof record !== "object" || Array.isArray(record) || !record.slices || typeof record.slices !== "object" || !Array.isArray(record.history))) throw new MergeConflict("A version of the initiative record has no slices or history.");
    const [b, l, u] = [base, local, upstream].map((record) => ({ ...canonicalRecord(record), schemaVersion: record.schemaVersion, proposals: record.proposals ?? {} }));
    const merged = {
      schemaVersion: mergeUnit("schemaVersion", b.schemaVersion, l.schemaVersion, u.schemaVersion),
      id: mergeUnit("id", b.id, l.id, u.id),
      slices: mergeKeyed("Slice", b.slices, l.slices, u.slices),
      proposals: mergeKeyed("Proposal", b.proposals, l.proposals, u.proposals),
      history: mergeHistory(base.history, local.history, upstream.history, HISTORY_LIMIT)
    };
    const contents = serialize(merged);
    if (Buffer.byteLength(contents) > RECORD_MAX_BYTES) return { conflict: "The merged initiative record exceeds 1 MiB." };
    const raw = parseStoreJson(contents);
    const { errors } = validateRecord(raw, initiative);
    if (merged.schemaVersion !== 1) errors.unshift("schemaVersion must be 1.");
    if (errors.length) return { conflict: `The merged initiative record is invalid: ${errors[0]}` };
    return { contents };
  } catch (error) {
    return { conflict: error instanceof MergeConflict ? error.message : `The initiative record versions could not be merged: ${error.message}` };
  }
}
async function loadRecord(resolved) {
  let contents;
  try {
    contents = await readStoreFileBytes(resolved.target, RECORD_MAX_BYTES);
  } catch (error) {
    if (error.tooLarge) return { exists: true, revision: oversizedRevision(error), text: "", record: null, valid: false, errors: [error.message], analysis: null };
    throw error;
  }
  if (contents === null) return { exists: false, revision: null, record: null, valid: true, errors: [], analysis: null };
  const spelledAs = await recordSpelling(resolved);
  if (spelledAs !== null) return { exists: false, revision: null, record: null, valid: true, errors: [], analysis: null, spelledAs };
  const revision = revisionOf(contents);
  const text2 = contents.toString("utf8");
  let raw;
  try {
    raw = parseStoreJson(text2);
  } catch {
    return { exists: true, revision, text: text2, record: null, valid: false, errors: ["The initiative record must contain valid JSON."], analysis: null };
  }
  const { errors, analysis } = validateRecord(raw, resolved.initiative);
  return { exists: true, revision, text: text2, record: raw, valid: errors.length === 0, errors, analysis };
}
async function recordSpelling(resolved) {
  const folder = path.dirname(resolved.target);
  if (path.basename(folder) !== resolved.initiative) return null;
  const names = await readdir(path.dirname(folder)).catch(() => null);
  if (names === null || names.includes(resolved.initiative)) return null;
  return names.find((name) => name.toLowerCase() === resolved.initiative.toLowerCase()) ?? null;
}
function derived(analysis, record) {
  if (!analysis) return null;
  const { slices, ...rest } = analysis;
  const fixes = unfinishedFixes(record);
  return { ...rest, unfinishedFixes: fixes, readyToShip: analysis.complete[analysis.root] === true && fixes.length === 0 };
}
function publicResult(resolved, loaded) {
  return {
    initiative: resolved.initiative,
    recordPath: resolved.recordPath,
    projectionPath: resolved.projectionPath,
    exists: loaded.exists,
    revision: loaded.revision,
    valid: loaded.valid,
    errors: loaded.errors,
    record: loaded.record,
    derived: derived(loaded.analysis, loaded.record)
  };
}
async function readInitiative(projectRoot, initiative) {
  const resolved = await resolveInitiative(projectRoot, initiative);
  return { resolved, loaded: await loadRecord(resolved) };
}
async function getInitiative(input) {
  validateInput(GET_INITIATIVE_SCHEMA, input);
  const { resolved, loaded } = await readInitiative(input.projectRoot, input.initiative);
  const code = {};
  for (const slug2 of Object.keys(loaded.record?.slices ?? {})) {
    const checkout = await verifiedCode(resolved.root, resolved.initiative, slug2).catch(() => null);
    if (checkout) code[slug2] = checkout;
  }
  const dependents = {};
  for (const scope of fitScopes(loaded.record)) {
    const latest = await latestDependentsRun(resolved.root, resolved.initiative, scope).catch(() => null);
    if (latest) dependents[scope] = { status: latest.entry.passed === true ? "passed" : "blocked", run: latest.path, finishedAt: latest.entry.finishedAt ?? null, blocked: Array.isArray(latest.entry.blocked) ? latest.entry.blocked : [] };
  }
  const view = await claimsView(resolved, loaded);
  const result = publicResult(resolved, view.loaded);
  if (result.derived) {
    const deferred = {};
    for (const slug2 of Object.keys(view.loaded.record?.slices ?? {})) {
      const review = await loadReview(resolved.root, resolved.initiative, slug2).catch(() => null);
      const entries = review?.document ? deferredFindings(review.document) : [];
      if (entries.length) deferred[slug2] = entries;
    }
    result.derived.deferredFindings = deferred;
  }
  const history = await shippedHistory(resolved.root, resolved.initiative);
  return { ...result, ...Object.keys(code).length ? { code } : {}, ...Object.keys(dependents).length ? { dependents } : {}, ...view.fields, ...history ? { shippedHistory: history } : {} };
}
function fitScopes(record) {
  const slices = record?.slices && typeof record.slices === "object" ? record.slices : {};
  return Object.keys(slices).filter((slug2) => {
    const slice = slices[slug2];
    if (slice?.status === "split") return !slice.splitEvidence;
    return slice?.parent == null || Boolean(slices[slice.parent]?.splitEvidence);
  }).sort();
}
function scopeLeaves(record, scope) {
  const slices = record?.slices && typeof record.slices === "object" ? record.slices : {};
  const children = (slug2, fixes) => Object.keys(slices).filter((key) => slices[key]?.parent === slug2 && Boolean(slices[key]?.fixes) === fixes);
  const leaves = (slug2, seen = /* @__PURE__ */ new Set()) => {
    if (seen.has(slug2)) return [];
    seen.add(slug2);
    const own = children(slug2, false);
    return [...own.length ? own.flatMap((child) => leaves(child, seen)) : [slug2], ...children(slug2, true).flatMap((child) => leaves(child, seen))];
  };
  return Object.hasOwn(slices, scope) ? [...new Set(leaves(scope))].sort() : [];
}
function scopeDependents(record, scope, declaration) {
  const recorded = scopeLeaves(record, scope).map((leaf) => record.slices[leaf]?.component).filter((identity) => typeof identity === "string");
  return dependentsOf(declaration, recorded.map((identity) => findComponent(declaration, identity)).filter(Boolean));
}
async function readClaims(resolved) {
  const claims = /* @__PURE__ */ new Map();
  const problems = [];
  for (const { slice, bytes } of await listClaimRecords(resolved.root, resolved.initiative)) {
    const parsed = parseClaim(slice, bytes);
    if (parsed.claim) claims.set(slice, parsed.claim);
    else problems.push(parsed.problem);
  }
  return { claims, problems };
}
async function claimsView(resolved, loaded, { report = true } = {}) {
  const { claims, problems } = await readClaims(resolved);
  const now = Date.now();
  const holder = claimHolder();
  const listed = {};
  let record = loaded.record;
  if (record?.slices && typeof record.slices === "object") {
    record = { ...record, slices: { ...record.slices } };
    for (const [slug2, claim] of claims) {
      if (!isLive(claim, now) || !Object.hasOwn(record.slices, slug2)) continue;
      record.slices[slug2] = { ...record.slices[slug2], claim: { holder: claim.holder, label: claim.label, ...claim.host ? { host: claim.host } : {}, ...claim.model ? { model: claim.model } : {}, ...sessionFields(claim), activity: claim.activity, claimedAt: claim.claimedAt, renewedAt: claim.renewedAt, expiresAt: claim.expiresAt } };
      listed[slug2] = { label: claim.label, ...claim.host ? { host: claim.host } : {}, ...claim.model ? { model: claim.model } : {}, activity: claim.activity, expiresAt: claim.expiresAt, heldHere: claim.holder === holder };
    }
  }
  if (report) adoptClaims(resolved.root, resolved.initiative, claims, now);
  const lost = report ? takeLostClaims(resolved.root, resolved.initiative, claims, now) : [];
  return { loaded: { ...loaded, record }, claims, fields: { ...Object.keys(listed).length ? { claims: listed } : {}, ...lost.length ? { lostClaims: lost } : {}, ...problems.length ? { claimProblems: problems } : {} } };
}
async function readInitiativeWithClaims(projectRoot, initiative) {
  const { resolved, loaded } = await readInitiative(projectRoot, initiative);
  return { resolved, loaded: (await claimsView(resolved, loaded, { report: false })).loaded };
}
const CLAIMED_WORK = /* @__PURE__ */ new Set(["propose_design", "accept_proposal", "restore_tests", "report_contract_defects"]);
const UNCLAIMED_OPERATIONS = /* @__PURE__ */ new Set(["create", "claim", "release_claim", "import_map", "regenerate_markdown", "remove_records"]);
const claimCovers = (slices, claim, slug2) => {
  for (let current = slug2, depth = 0; current !== null && current !== void 0 && depth < 1e3; current = slices[current]?.parent, depth += 1) if (current === claim.slug) return true;
  return false;
};
function workSlug(record, slug2) {
  if (Object.hasOwn(record.slices, slug2)) return slug2;
  for (const [scope, proposal] of Object.entries(record.proposals ?? {})) {
    const created = (proposal?.operations ?? []).flatMap((operation) => operation.op === "split" ? (operation.children ?? []).map((child) => child.slug) : operation.op === "add_fix" ? [operation.fix?.slug] : []);
    if (created.includes(slug2) && Object.hasOwn(record.slices, scope)) return scope;
  }
  return null;
}
function initiativeWork(operations, record) {
  const work = [];
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (!operation || UNCLAIMED_OPERATIONS.has(operation.op)) continue;
    const slug2 = operation.op === "split" ? operation.parent : operation.slug;
    if (typeof slug2 !== "string") continue;
    const status = record?.slices?.[slug2]?.status;
    const own = CLAIMED_WORK.has(operation.op) || operation.op === "set_status" && operation.status !== "in-progress" && status === "in-progress";
    work.push({ slug: slug2, op: operation.op, own });
  }
  return work;
}
async function requireClaimedWork({ projectRoot, initiative, tool, work, claimedHere = [] }) {
  if (!work.length) return;
  try {
    await refuseShipped(projectRoot, initiative);
  } catch {
    return;
  }
  let resolved, loaded;
  try {
    ({ resolved, loaded } = await readInitiative(projectRoot, initiative));
  } catch {
    return;
  }
  const record = loaded?.record;
  if (!record?.slices || typeof record.slices !== "object") return;
  const { claims } = await readClaims(resolved);
  const holder = claimHolder();
  const now = Date.now();
  for (const item of work) {
    const slug2 = workSlug(record, item.slug);
    if (slug2 === null) continue;
    if (claimedHere.some((claimed) => claimCovers(record.slices, { slug: claimed }, slug2))) continue;
    const blocking = blockingClaim(record.slices, claims, slug2, holder, now);
    if (blocking) throw fail("slice_claimed", claimedMessage(slug2, blocking), { claim: claimView(blocking) });
    if (!item.own) continue;
    const covering = [...claims.values()].filter((claim) => claim.holder === holder && claimCovers(record.slices, claim, slug2));
    if (covering.some((claim) => isLive(claim, now))) continue;
    const lapsed = covering.sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0];
    const why = lapsed ? `This session's claim on ${lapsed.slug} expired at ${lapsed.expiresAt}` : `No live claim of this session covers ${slug2}`;
    throw fail("claim_required", `${why}, so ${tool}${item.op ? ` ${item.op}` : ""} was not applied: work on a slice needs its holder's live claim. Call update_initiative with a claim operation for ${slug2}, or for the scope that contains it, then call again; Prism refuses the claim with slice_claimed when another agent took the slice meanwhile.`, { slice: slug2, ...lapsed ? { claim: claimView(lapsed) } : {} });
  }
}
const claimedByUpdate = (operations) => (Array.isArray(operations) ? operations : []).filter((operation) => operation?.op === "claim" || operation?.op === "set_status" && operation.status === "in-progress").map((operation) => operation.slug).filter((slug2) => typeof slug2 === "string");
function markdown(record) {
  const analysis = analyzeInitiative(record.slices);
  const lines = [`# Initiative: ${record.id}`, "", generatedNotice(RECORD_NAME), ""];
  const visit = (slugValue, depth) => {
    const slice = analysis.slices[slugValue];
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- **${slice.title}** (\`${slugValue}\`): ${slice.status}`);
    if (slice.outcome) lines.push(`${indent}  - Outcome: ${slice.outcome}`);
    lines.push(`${indent}  - Requirements: ${slice.requirements.join(", ")}`);
    if (slice.dependencies.length) lines.push(`${indent}  - Depends on: ${slice.dependencies.map((item) => `\`${item}\``).join(", ")}`);
    if (slice.fixes) lines.push(`${indent}  - Fixes \`${slice.fixes.slice}\`: ${slice.fixes.defects.join(", ")}`);
    for (const defect of record.slices[slugValue].defects ?? []) lines.push(`${indent}  - Defect ${defect.id} reported ${defect.reportedAt.slice(0, 10)} (${defect.requirements.join(", ")}): ${defect.summary}`);
    const design = record.slices[slugValue].design;
    if (design) lines.push(`${indent}  - Design accepted ${design.acceptedAt.slice(0, 10)}: ${design.frozenTests.length} frozen test files${design.staged ? " staged until the slice starts" : ""}, review ${design.review === "required" ? "required" : "not required"}`);
    for (const child of analysis.children[slugValue]) visit(child, depth + 1);
  };
  visit(analysis.root, 0);
  return `${lines.join("\n")}
`;
}
function normalizeRequirementReference(requirementsDirectory, reference) {
  const cited = /^([^\s/#§]+\.md)§([^\s#§]+)$/.exec(reference);
  if (cited && requirementsDirectory) return { reference: `${requirementsDirectory}/${cited[1]}#${cited[2]}` };
  if (!/^[^\s#]+#[^\s#]+$/.test(reference)) {
    return { problem: `Invalid requirement reference ${JSON.stringify(reference)}: use <requirements path>.md#<number>, such as ${requirementsDirectory ?? "docs/requirements"}/capability.md#1, or <file>.md\xA7<number>.` };
  }
  const file = reference.split("#")[0];
  if (!normalizedRelative(file)) {
    return { problem: `Invalid requirement reference ${JSON.stringify(reference)}: its path must be a normalized project-relative path, such as ${requirementsDirectory ?? "docs/requirements"}/capability.md#1, without ./, .., or repeated slashes.` };
  }
  return { reference };
}
const normalizedRelative = (file) => !file.includes("\\") && !path.posix.isAbsolute(file) && !/^[A-Za-z]:/.test(file) && path.posix.normalize(file) === file && file !== ".." && !file.startsWith("../");
function normalizeRequirements(resolved, references) {
  return references.map((reference) => {
    const normalized2 = normalizeRequirementReference(resolved.requirementsDirectory, reference);
    if (normalized2.problem) throw fail("validation_failed", normalized2.problem);
    return normalized2.reference;
  });
}
function sliceFolder(directory, slices, slugValue) {
  return slices?.[slugValue]?.parent === null ? directory : `${directory}/${slugValue}`;
}
const LONGEST_PLAN_FILE = PROJECTION_NAME;
async function checkPlanFolders(resolved, slices, slug2, { names = [], siblings = [], initiative = true } = {}) {
  if (!resolved.store) return;
  const root = slug2 === null || slices?.[slug2]?.parent === null;
  if (!root && initiative) await checkPlanFolders(resolved, slices, null);
  const folder = root ? resolved.directory : sliceFolder(resolved.directory, slices, slug2);
  const own = root ? [resolved.initiative] : [slug2];
  const invalid = [...own, ...names].find((name) => !wellFormedName(name));
  if (invalid !== void 0) {
    throw new ArtifactError("artifact_name_invalid", `The ${own.includes(invalid) && root ? "initiative identifier" : "slice slug"} ${JSON.stringify(invalid)} names a plan folder in the record store, which does not accept that name: ${ARTIFACT_NAME_FORM}. Choose an identifier of that form; nothing changed.`, { invalidName: invalid, path: folder });
  }
  const others = root ? (await listInitiatives(resolved.root)).filter((id) => id !== resolved.initiative).map((id) => initiativeDirectory(resolved.config, id)) : [...Object.keys(slices ?? {}).filter((key) => key !== slug2 && slices[key]?.parent !== null).map((key) => `${resolved.directory}/${key}`), ...siblings];
  let other = others.find((candidate) => collideInLetterCase(folder, candidate));
  if (other === void 0) {
    const stored = await listStoreArtifacts(resolved.root, resolved.config.paths.plans) ?? [];
    other = stored.filter((entry) => entry.kind === "plans").map((entry) => entry.path).find((file) => collideInLetterCase(folder, file));
  }
  if (other !== void 0) {
    throw new ArtifactError("artifact_name_conflict", `The plan folder ${folder} differs only in letter case from ${other}, and the two would be one folder on a file system that ignores letter case, as macOS and Windows do by default; nothing changed. Choose another ${root ? "initiative identifier" : "slice slug"}.`, { path: other });
  }
  const { location } = await storeArtifactLocation(resolved.root, `${folder}/${LONGEST_PLAN_FILE}`);
  const excess = locationExcess(location);
  if (excess !== null) {
    throw new ArtifactError("artifact_path_too_long", `${location}, the location of ${folder}/${LONGEST_PLAN_FILE} in the record store, ${excess}, so some machine could not write it or its comments; nothing changed. Choose a shorter ${root ? "initiative identifier" : "slice slug"}.`, locationLimits(location));
  }
}
function checkFrozenTestPaths(resolved, slug2, files) {
  if (!resolved.store) return;
  const kinds = artifactKinds(resolved.config);
  const stored = files.filter((file) => {
    const normalized2 = path.posix.normalize(String(file).replaceAll("\\", "/")).replace(/\/+$/, "");
    return artifactAddressOf(kinds, normalized2) !== null;
  });
  if (stored.length) throw fail("frozen_test_in_store", `The design of ${slug2} was not accepted: ${stored.join(", ")} ${stored.length === 1 ? "is a descriptive artifact path" : "are descriptive artifact paths"}, which live in the record store, where verification never runs them. Keep each frozen test in the checkout, outside the configured Requirements, ADRs, and Plans folders and the Glossary and Roadmap files.`, { slice: slug2, paths: stored });
}
async function sliceOutcome(resolved, slices, slugValue) {
  try {
    const source = await readArtifactText(resolved.root, `${sliceFolder(resolved.directory, slices, slugValue)}/slice.md`) ?? "";
    const section = source.split(/^## Outcome\s*$/m)[1]?.split(/^#{1,2} /m)[0] ?? "";
    const sentence = section.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return sentence || void 0;
  } catch {
    return void 0;
  }
}
const START_FIELDS = ["startTree", "startRecordedAt", "startDeclaration"];
const startOf = (design) => Object.fromEntries(START_FIELDS.filter((key) => design?.[key] !== void 0).map((key) => [key, design[key]]));
async function startContent(root, identity) {
  const { contentTree, startDeclaration } = await import("./slice-gate.mjs");
  let config;
  try {
    config = await readWorkflowConfig(root);
  } catch {
    return null;
  }
  const startTree = await contentTree(root, config).catch(() => null);
  if (!startTree) return null;
  let declared = null;
  try {
    const declaration = readComponents(config);
    if (findComponent(declaration, identity)) declared = startDeclaration(declaration);
  } catch {
    declared = null;
  }
  return { startTree, startRecordedAt: (/* @__PURE__ */ new Date()).toISOString(), ...declared ? { startDeclaration: declared } : {} };
}
async function completionGate(resolved, slugValue) {
  const { checkSliceGate } = await import("./slice-gate.mjs");
  try {
    return await checkSliceGate({ projectRoot: resolved.root, initiative: resolved.initiative, slice: slugValue, gate: "completion" });
  } catch (error) {
    return { ready: false, problems: [{ code: error.code ?? "evidence_missing", message: error.message }] };
  }
}
async function captureBaseline(root, initiative, slice) {
  try {
    return (await conservationStore.capture(root, { initiative, slice })).snapshotId;
  } catch {
    return null;
  }
}
const STARTED = /* @__PURE__ */ new Set(["in-progress", "blocked"]);
function claimedTests(slices, slugValue, frozenTests, staging) {
  return frozenTests.map((item) => item.path).filter((file) => Object.entries(slices).some(([key, other]) => key !== slugValue && (staging || other.status !== "done") && other.design?.frozenTests.some((test) => test.path === file)));
}
const normalized = (value) => value.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
async function splitEvidence(resolved, slices, operation, effects) {
  const refuse = (reason) => fail("split_unjustified", `The split of ${operation.parent} was not recorded: ${reason}`);
  const evidence = operation.evidence;
  if (!evidence) throw refuse("design it as one contract first. A split into parts needs evidence: contract files measured above the contract budget, an Unprobed assumption that one part settles, or a user gate where the person asked for the split. A split whose every part takes accept_design in the same update is a slice plan and needs none.");
  if (evidence.kind === "contract_size") {
    const { tokens, missing } = await measureContract(resolved.root, evidence.files);
    if (missing.length) throw refuse(`${missing.join(", ")} does not exist.`);
    if (tokens <= CONTRACT_TOKEN_BUDGET) throw refuse(`the named files hold about ${tokens} tokens, within the contract budget of ${CONTRACT_TOKEN_BUDGET}, so design the scope as one contract.`);
    return { kind: evidence.kind, tokens, files: [...new Set(evidence.files)].sort() };
  }
  if (evidence.kind === "unfrozen") {
    if (!operation.children.some((child) => child.slug === evidence.settledBy)) throw refuse(`${evidence.settledBy} is not one of its parts.`);
    const quoted = normalized(evidence.assumption);
    if (quoted.length < 12) throw refuse("quote the Unprobed assumption from the scope's slice.md.");
    const source = await readArtifactText(resolved.root, `${sliceFolder(resolved.directory, slices, operation.parent)}/slice.md`).catch(() => null) ?? "";
    const section = source.split(/^## Assumptions\s*$/m)[1]?.split(/^#{1,2} /m)[0] ?? "";
    if (!section.split(/\r?\n/).some((line) => /unprobed/i.test(line) && normalized(line).includes(quoted))) throw refuse(`the Assumptions of its slice.md list no Unprobed assumption that contains ${JSON.stringify(evidence.assumption)}.`);
    return { kind: evidence.kind, assumption: evidence.assumption, settledBy: evidence.settledBy };
  }
  const gateId = evidence.gate ?? effects.gate;
  if (!gateId) {
    if (effects.dryRun) return { kind: evidence.kind };
    throw refuse("name the user gate where the person approved the split.");
  }
  const { state } = await readCoordinationState({ projectRoot: resolved.root, initiative: resolved.initiative });
  const gate = (Array.isArray(state?.pending) ? state.pending : []).find((item) => item?.id === gateId);
  if (!gate?.answer) throw refuse(`the user gate ${gateId} is not pending with an answer from the person.`);
  if (gate.answer.choice === "request-changes") throw refuse(`the person requested changes at ${gateId}.`);
  if (gate.slice !== void 0 && gate.slice !== operation.parent) throw refuse(`the user gate ${gateId} is about ${gate.slice}.`);
  return { kind: evidence.kind, gate: gateId };
}
async function checkContractBudget(resolved, slices, operations) {
  const planOf = new Map(operations.filter((operation) => operation.op === "split").flatMap((operation) => operation.children.map((child) => [child.slug, operation.parent])));
  const contracts = /* @__PURE__ */ new Map();
  for (const operation of operations.filter((item) => item.op === "accept_design")) {
    const scope = planOf.get(operation.slug) ?? operation.slug;
    if (!contracts.has(scope)) contracts.set(scope, /* @__PURE__ */ new Set([`${sliceFolder(resolved.directory, slices, scope)}/slice.md`]));
    for (const file of operation.frozenTests) contracts.get(scope).add(file);
  }
  for (const [scope, files] of contracts) {
    const { tokens, missing } = await measureContract(resolved.root, [...files]);
    if (tokens > CONTRACT_TOKEN_BUDGET) {
      const measured = [...files].filter((file) => !missing.includes(file)).sort();
      throw fail("contract_too_large", `The design of ${scope} was not accepted: its contract and frozen tests hold about ${tokens} tokens, more than the contract budget of ${CONTRACT_TOKEN_BUDGET} that one implementer reads. Split ${scope} into parts, citing these files as contract_size evidence.`, { scope, tokens, budget: CONTRACT_TOKEN_BUDGET, files: measured });
    }
  }
}
function proposalOutside(slices, scope, operations) {
  const created = new Set(operations.flatMap((item) => item.op === "split" ? item.children.map((child) => child.slug) : item.op === "add_fix" ? [item.fix.slug] : []));
  const inside = (key) => {
    if (created.has(key)) return true;
    for (let current = key, depth = 0; current !== null && current !== void 0 && depth < 1e3; current = slices[current]?.parent, depth += 1) if (current === scope) return true;
    return false;
  };
  return [...new Set(operations.flatMap((item) => item.op === "split" ? item.parent === scope ? [] : [item.parent] : inside(item.slug) ? [] : [item.slug]))];
}
function takeClaim(record, slugValue, activity, effects, operation) {
  const claims = effects.claims;
  if (claims.mode !== "plan") return;
  const blocking = blockingClaim(record.slices, claims.files, slugValue, claims.holder, claims.now);
  if (blocking) throw fail("slice_claimed", claimedMessage(slugValue, blocking), { claim: claimView(blocking) });
  const previous = claims.files.get(slugValue);
  if (previous && previous.holder !== claims.holder) {
    claims.expired.push(claimView(previous));
    effects.notes.set(operation, { replacedClaim: { holder: previous.holder, label: previous.label, activity: previous.activity, expiresAt: previous.expiresAt } });
  }
  claims.files.set(slugValue, newClaim(previous, { slug: slugValue, holder: claims.holder, label: claims.label, host: claims.host, model: claims.model, session: claims.session, activity, now: claims.now }));
}
function endClaim(slugValue, effects) {
  const claims = effects.claims;
  if (!claims?.files.has(slugValue)) return;
  if (claims.mode === "plan") claims.files.delete(slugValue);
  else claims.ended.add(slugValue);
}
async function declarationOf(resolved, effects) {
  effects.components ??= readWorkflowConfig(resolved.root).then((config) => ({ config, declaration: readComponents(config) }));
  return effects.components;
}
async function designComponent(resolved, operation, effects) {
  const { config, declaration } = await declarationOf(resolved, effects);
  const given = operation.component;
  const found = given === void 0 ? declaration.declared.length ? null : declaration.root : findComponent(declaration, given);
  if (found === null || !declaration.declared.length && found !== declaration.root) {
    const identities = declaration.components.map((item) => item.identity);
    throw fail("component_unknown", `The design of ${operation.slug} was not accepted: ${given === void 0 ? "it names no component" : `${given} is not a component of this repository`}. Name one of ${identities.join(", ")} as its component.`, { slice: operation.slug, component: given ?? null, components: identities });
  }
  return { component: found, declaration, config };
}
function prismOwned(config, file) {
  const within = (folder) => folder !== null && folder !== "" && (file === folder || file.startsWith(`${folder}/`));
  const roadmap = roadmapPaths(config);
  return within(".prism") || within(config.paths.plans) || roadmap !== null && (file === roadmap.record || file === roadmap.projection);
}
function checkBoundary({ component, declaration, config }, slug2, files) {
  const crossing = [...new Set(files.map((file) => file.replace(/\/$/, "")))].filter((file) => !prismOwned(config, file) && componentOf(declaration, file) !== component && !underSharedPath(declaration, file)).sort();
  if (crossing.length) throw fail("component_boundary", `The design of ${slug2} was not accepted: its planned changes and frozen tests leave its component ${component.identity} at ${crossing.join(", ")}. Keep each slice inside one component or under a shared path.`, { slice: slug2, component: component.identity, paths: crossing });
}
async function refuseEmerging(resolved, effects) {
  const { emergingRefusal } = await import("./work-items.mjs");
  effects.emerging ??= emergingRefusal(resolved.root, resolved.initiative);
  const refusal = await effects.emerging;
  if (refusal) throw fail("item_emerging", refusal.message, { item: refusal.item, unmet: refusal.unmet });
}
function linkedPath(folder, href) {
  const bare = href.split("#")[0].split("?")[0];
  if (!bare) return null;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
  }
  const normalized2 = path.posix.normalize(path.posix.join(folder, decoded));
  return normalized2 === "." || normalized2 === ".." || normalized2.startsWith("../") ? null : normalized2;
}
async function refuseDraftAdrs(resolved, slices, slugs) {
  const folder = resolved.config.paths?.adrs ?? null;
  if (folder === null) return;
  const designs = /* @__PURE__ */ new Set();
  for (const slugValue of slugs) {
    for (let key = slugValue, depth = 0; key !== null && key !== void 0 && Object.hasOwn(slices, key) && depth < 1e3; key = slices[key]?.parent, depth += 1) designs.add(`${sliceFolder(resolved.directory, slices, key)}/slice.md`);
  }
  const linked = /* @__PURE__ */ new Set();
  const { markdownLinks } = await import("../review/artifact-links.mjs");
  for (const design of designs) {
    const text2 = await readArtifactText(resolved.root, design).catch(() => null);
    if (text2 === null) continue;
    for (const { href } of markdownLinks(text2)) {
      const file = linkedPath(path.posix.dirname(design), href);
      if (file !== null && file.startsWith(`${folder}/`) && file.endsWith(".md")) linked.add(file);
    }
  }
  if (!linked.size) return;
  const { citationContext } = await import("./work-items.mjs");
  const context = citationContext(resolved.root, resolved.config, []);
  const drafts = [];
  for (const file of linked) for (const copy of await context.copies(file)) if (copy.status === "Draft") drafts.push({ path: file, scope: copy.scope });
  if (!drafts.length) return;
  const named = [...new Set(drafts.map((adr) => adr.path))].join(", ");
  throw fail("adr_draft", `The design links the Draft ADR${drafts.length === 1 ? "" : "s"} ${named}, so it was not recorded: decide each with update_artifact decide, choosing one of its options, then propose again; nothing changed.`, { adrs: drafts });
}
async function applyOperation(resolved, record, operation, effects) {
  const slices = record.slices;
  const requireSlice = (slugValue) => {
    if (!Object.hasOwn(slices, slugValue)) throw fail("validation_failed", `The slice ${slugValue} does not exist.`);
    return slices[slugValue];
  };
  if (operation.op === "create" || operation.op === "import_map") {
    if (Object.keys(slices).length) throw fail("validation_failed", `${operation.op} requires a new initiative record.`);
  }
  switch (operation.op) {
    case "create":
      await refuseEmerging(resolved, effects);
      await checkPlanFolders(resolved, slices, null, { names: [operation.slug] });
      slices[operation.slug] = { title: operation.title, ...operation.outcome ? { outcome: operation.outcome } : {}, status: "not-started", parent: null, requirements: normalizeRequirements(resolved, operation.requirements), dependencies: [] };
      break;
    case "import_map": {
      const stored = resolved.store && await inArtifactStore(resolved.root, operation.path);
      const source = stored ? await readArtifactText(resolved.root, operation.path) : await readFile((await resolveArtifactPath(resolved.root, operation.path, false, path.posix.basename(operation.path))).target, "utf8");
      if (source === null) throw fail("validation_failed", `The map ${operation.path} does not exist in the record store.`);
      const imported = parseLegacyMap(source);
      if (imported.id !== resolved.initiative) throw fail("validation_failed", `The map names initiative ${imported.id}, not ${resolved.initiative}.`);
      await checkPlanFolders(resolved, {}, null, { names: Object.keys(imported.slices) });
      for (const key of Object.keys(imported.slices)) if (imported.slices[key]?.parent !== null) await checkPlanFolders(resolved, imported.slices, key, { initiative: false });
      for (const [key, slice] of Object.entries(imported.slices)) {
        const outcome = await sliceOutcome(resolved, imported.slices, key);
        slices[key] = { ...slice, ...outcome ? { outcome } : {} };
      }
      break;
    }
    case "split": {
      const parent = requireSlice(operation.parent);
      if (parent.status === "split") throw fail("validation_failed", "The parent is already split.");
      if (parent.status === "done") throw fail("validation_failed", "A done slice cannot split.");
      if (parent.fixes) throw fail("validation_failed", `The fix slice ${operation.parent} cannot split; design another fix slice for the defects it leaves.`);
      for (const child of operation.children) {
        if (Object.hasOwn(slices, child.slug)) throw fail("validation_failed", `The slice slug ${child.slug} is already used in this initiative.`);
        const siblings = operation.children.filter((other) => other !== child).map((other) => `${resolved.directory}/${other.slug}`);
        await checkPlanFolders(resolved, slices, child.slug, { siblings });
      }
      for (const child of operation.children) {
        slices[child.slug] = { title: child.title, ...child.outcome ? { outcome: child.outcome } : {}, status: "not-started", parent: operation.parent, requirements: normalizeRequirements(resolved, child.requirements), dependencies: [] };
      }
      const evidence = operation.children.every((child) => effects.accepted.has(child.slug)) ? null : await splitEvidence(resolved, slices, operation, effects);
      parent.status = "split";
      delete parent.design;
      delete parent.component;
      if (evidence) parent.splitEvidence = evidence;
      break;
    }
    case "set_status": {
      const slice = requireSlice(operation.slug);
      if (slice.status === "split") throw fail("validation_failed", "A split parent keeps the split status permanently.");
      if (slice.status === "done" && operation.status !== "done") throw fail("slice_done", `The slice ${operation.slug} is done and stays done; report a defect with report_defect and design a fix as new work.`, { slice: operation.slug });
      if (operation.status === "in-progress" && slice.status === "not-started") {
        const analysis = analyzeInitiative(slices);
        const waiting = (analysis.effectiveDependencies[operation.slug] ?? []).filter((target) => !analysis.complete[target]);
        if (waiting.length) throw fail("dependencies_incomplete", `The slice ${operation.slug} cannot start before the slices it depends on are done: ${waiting.join(", ")}.`, { slice: operation.slug, waiting });
      }
      if (operation.status === "in-progress") takeClaim(record, operation.slug, "implementation", effects, operation);
      else endClaim(operation.slug, effects);
      if (operation.status === "in-progress" && slice.design?.staged) {
        if (!effects.staged.some((item) => item.slice === operation.slug) && !effects.dryRun) effects.installed.push(...await installFrozenTests(resolved.root, resolved.initiative, operation.slug, slice.design.frozenTests));
        const baselineId = effects.dryRun ? null : await captureBaseline(resolved.root, resolved.initiative, operation.slug);
        delete slice.design.staged;
        if (baselineId) slice.design.baselineId = baselineId;
        else delete slice.design.baselineId;
      }
      if (operation.status === "in-progress" && slice.status !== "in-progress" && slice.component && slice.design && !slice.design.startTree && !effects.dryRun) {
        const start = await startContent(resolved.root, slice.component);
        if (start) {
          Object.assign(slice.design, start);
          effects.refs.push({ slice: operation.slug, start: start.startTree });
        }
      }
      if (operation.status === "not-started" && (slice.design?.startTree || STARTED.has(slice.status))) {
        if (slice.design) for (const key of START_FIELDS) delete slice.design[key];
        if (!effects.dryRun) effects.refs.push({ slice: operation.slug, drop: true });
      }
      if (operation.status === "not-started" && STARTED.has(slice.status) && slice.design && !slice.design.staged && !claimedTests(slices, operation.slug, slice.design.frozenTests, true).length) {
        if (!effects.dryRun) effects.staged.push(await restageFrozenTests(resolved.root, resolved.initiative, operation.slug, slice.design.frozenTests));
        slice.design.staged = true;
        delete slice.design.baselineId;
      }
      if (operation.status === "done" && slice.status !== "done") {
        const gate = await completionGate(resolved, operation.slug);
        if (!gate.ready) {
          const reasons = (gate.problems ?? []).map((problem) => problem.message).filter(Boolean).join(" ");
          throw fail("gate_blocked", `The slice ${operation.slug} has no passing completion gate in its review.${reasons ? ` ${reasons}` : ""}`, { slice: operation.slug, problems: gate.problems });
        }
      }
      slice.status = operation.status;
      break;
    }
    case "set_dependencies":
      requireSlice(operation.slug).dependencies = [...operation.dependencies];
      break;
    case "update_slice": {
      const slice = requireSlice(operation.slug);
      if (operation.title !== void 0) slice.title = operation.title;
      if (operation.outcome !== void 0) slice.outcome = operation.outcome;
      break;
    }
    case "accept_design": {
      const slice = requireSlice(operation.slug);
      if (slice.status === "split") throw fail("validation_failed", "A split slice is designed through its children.");
      if (slice.status === "done") throw fail("validation_failed", "A done slice cannot take a new design.");
      checkFrozenTestPaths(resolved, operation.slug, operation.frozenTests);
      await checkPlanFolders(resolved, slices, operation.slug);
      await refuseDraftAdrs(resolved, slices, [operation.slug]);
      const component = await designComponent(resolved, operation, effects);
      const review = await reviewPolicy(resolved, effects) === "all" ? "required" : operation.review;
      const frozenTests = await digestFrozenTests(resolved.root, operation.frozenTests);
      const staging = !STARTED.has(slice.status);
      const claimed = claimedTests(slices, operation.slug, frozenTests, staging);
      if (claimed.length) throw fail("validation_failed", `${claimed.join(", ")} already belongs to another slice${staging ? "" : " that is not done"}; give each slice its own test files.`);
      const folders = [];
      for (let key = operation.slug; key !== null && key !== void 0; key = slices[key]?.parent) folders.push(sliceFolder(resolved.directory, slices, key));
      const views = [];
      const checked = /* @__PURE__ */ new Map();
      for (const folder of new Set(folders.filter((item) => !effects.checkedFolders.has(item)))) {
        effects.checkedFolders.add(folder);
        checked.set(folder, effects.viewCache.get(folder) ?? await checkFolderViews(resolved.root, folder, await viewScope(resolved)));
        views.push(...checked.get(folder));
      }
      const problems = viewProblems(views);
      if (problems.length) throw fail("view_problems", `The design of ${operation.slug} was not accepted: ${problems.join(" ")}`, { problems });
      const ownFolder = folders[0];
      const ownViews = listedViews(checked.get(ownFolder) ?? effects.viewCache.get(ownFolder) ?? await checkFolderViews(resolved.root, ownFolder, await viewScope(resolved))).map((view) => ({ ...view, dense: isDense(view.kind, view) })).sort((left, right) => left.path.localeCompare(right.path));
      const dense = ownViews.filter((view) => view.dense);
      if (dense.length) {
        const ownDesign = await readArtifactText(resolved.root, `${ownFolder}/slice.md`).catch(() => null);
        const assessed = readSplitAssessment(ownDesign ?? "", ownFolder);
        const unassessed = dense.filter((view) => !assessed.has(view.path));
        if (unassessed.length) {
          const named = unassessed.map((view) => `${view.path} shows ${denseCounts(view.kind, view).join(" and ")}.`).join(" ");
          throw fail("split_assessment_missing", `The design of ${operation.slug} was not accepted: ${named} A view this dense suggests the slice may be too large to stay whole, so ${ownFolder}/slice.md either splits the slice or says why it stays whole in a ## Split assessment item \`<file>\`: <why the slice stays whole> for each such view.`, { slice: operation.slug, views: unassessed.map(({ path: file, kind, elements, relations }) => ({ path: file, kind, elements, relations })) });
        }
      }
      const designFile = (slug2) => `${sliceFolder(resolved.directory, slices, slug2)}/slice.md`;
      const designOf = (slug2) => readArtifactText(resolved.root, designFile(slug2)).catch((error) => {
        if (resolved.store && error?.name === "ArtifactError") throw error;
        return null;
      });
      const designText = await designOf(operation.slug);
      if (designText === null && resolved.store && await readFile(path.join(resolved.root, designFile(operation.slug))).then(() => true, () => false)) {
        throw fail("artifact_not_found", `The design of ${operation.slug} was not accepted: the record store holds no ${designFile(operation.slug)}, while the checkout holds a file at that path, which Prism does not read in a project with a record store. Write the design with update_artifact, then accept it again.`, { slice: operation.slug, path: designFile(operation.slug) });
      }
      let contractText = designText;
      for (let parent = slices[operation.slug]?.parent, seen = /* @__PURE__ */ new Set([operation.slug]); designText !== null && !contractClauses(contractText ?? "").length && parent && !seen.has(parent); parent = slices[parent]?.parent) {
        seen.add(parent);
        contractText = await designOf(parent);
      }
      const planned = designText === null ? { changes: [], problems: [] } : plannedChanges(designText, contractText ?? designText);
      const changeProblems = planned.problems;
      if (changeProblems.length) throw fail("validation_failed", `The design of ${operation.slug} was not accepted: ${changeProblems.join(" ")}`, { problems: changeProblems });
      checkBoundary(component, operation.slug, [...planned.changes.map((change) => change.path), ...frozenTests.map((test) => test.path)]);
      effects.views.push(...views);
      const acceptedAt = (/* @__PURE__ */ new Date()).toISOString();
      delete slice.contractDefects;
      slice.component = component.component.identity;
      if (effects.dryRun) {
        slice.design = { acceptedAt, frozenTests, review, views: ownViews, ...staging ? { staged: true } : {} };
        break;
      }
      effects.staged = effects.staged.filter((item) => item.slice !== operation.slug);
      if (!staging) {
        const baselineId = await captureBaseline(resolved.root, resolved.initiative, operation.slug);
        slice.design = { acceptedAt, frozenTests, review, views: ownViews, ...baselineId ? { baselineId } : {}, ...startOf(slice.design) };
      } else {
        effects.staged.push(await stageFrozenTests(resolved.root, operation.slug, frozenTests));
        slice.design = { acceptedAt, frozenTests, review, views: ownViews, staged: true };
      }
      break;
    }
    case "restore_tests": {
      requireSlice(operation.slug);
      const leaves = Object.keys(slices).filter((key) => {
        for (let current = key; current !== null && current !== void 0; current = slices[current]?.parent) if (current === operation.slug) return true;
        return false;
      }).filter((key) => slices[key].design?.staged);
      if (!effects.dryRun) for (const key of leaves) effects.installed.push(...await installFrozenTests(resolved.root, resolved.initiative, key, slices[key].design.frozenTests));
      break;
    }
    case "report_contract_defects": {
      const slice = requireSlice(operation.slug);
      if (!STARTED.has(slice.status) || !slice.design) throw fail("validation_failed", `Contract defects are reported for a started slice with an accepted design, and ${operation.slug} is ${slice.status}.`);
      const reportedAt = (/* @__PURE__ */ new Date()).toISOString();
      slice.contractDefects = operation.defects.map((item) => ({ clause: item.clause, reason: item.reason, reportedAt }));
      slice.status = "blocked";
      endClaim(operation.slug, effects);
      break;
    }
    case "claim": {
      const slice = requireSlice(operation.slug);
      const activity = slice.status === "in-progress" ? "implementation" : "design";
      if (activity === "design") await refuseEmerging(resolved, effects);
      takeClaim(record, operation.slug, activity, effects, operation);
      break;
    }
    case "release_claim": {
      requireSlice(operation.slug);
      const claims = effects.claims;
      if (claims.mode !== "plan") break;
      const claim = claims.files.get(operation.slug);
      if (!claim) throw fail("validation_failed", `The slice ${operation.slug} holds no claim.`);
      claims.released.push(claimView(claim));
      claims.releasedSlugs.add(operation.slug);
      effects.notes.set(operation, { released: { holder: claim.holder, label: claim.label, activity: claim.activity, expiresAt: claim.expiresAt }, releasedBy: { holder: claims.holder, label: claims.label } });
      claims.files.delete(operation.slug);
      break;
    }
    case "propose_design": {
      const scope = requireSlice(operation.slug);
      if (scope.status === "done") checkFixProposal(operation);
      await refuseDraftAdrs(resolved, slices, [operation.slug]);
      await checkPlanFolders(resolved, slices, operation.slug);
      const outside = proposalOutside(slices, operation.slug, operation.operations);
      if (outside.length) throw fail("validation_failed", `A design proposal changes only its scope ${operation.slug} and the slices inside it, not ${outside.join(", ")}.`);
      const trial = { slices: Object.assign(/* @__PURE__ */ Object.create(null), structuredClone(slices)) };
      const accepted = new Set(operation.operations.filter((item) => item.op === "accept_design").map((item) => item.slug));
      await checkOverview(resolved, slices, operation);
      const trialEffects = { staged: [], installed: [], refs: [], views: [], checkedFolders: /* @__PURE__ */ new Set(), viewCache: effects.viewCache, accepted, applied: [], dryRun: true, components: effects.components, proposal: operation.slug };
      for (const inner of operation.operations) await applyOperation(resolved, trial, inner, trialEffects);
      try {
        analyzeInitiative(trial.slices);
      } catch (error) {
        throw fail("invalid_initiative", `The design proposal of ${operation.slug} was not recorded: ${error.message}`, { errors: [error.message] });
      }
      await checkContractBudget(resolved, trial.slices, operation.operations);
      record.proposals[operation.slug] = { operations: structuredClone(operation.operations), proposedAt: (/* @__PURE__ */ new Date()).toISOString(), ...effects.actor ? { actor: effects.actor } : {} };
      effects.views.push(...trialEffects.views);
      break;
    }
    case "accept_proposal": {
      const proposal = record.proposals[operation.slug];
      if (!proposal) throw fail("validation_failed", `The scope ${operation.slug} has no pending design proposal.`);
      await refuseDraftAdrs(resolved, slices, [operation.slug]);
      const required = new Set(operation.reviewRequired);
      const policy = await reviewPolicy(resolved, effects);
      const marked = (inner) => policy === "all" || required.has(inner.slug) || policy === "recommended" && inner.review === "required";
      const replay = proposal.operations.map((inner) => inner.op === "accept_design" ? { ...inner, review: marked(inner) ? "required" : "none" } : inner);
      const unmarked = [...required].filter((key) => !replay.some((inner) => inner.op === "accept_design" && inner.slug === key));
      if (unmarked.length) throw fail("validation_failed", `${unmarked.join(", ")} takes no design in this proposal, so it cannot be marked for review.`);
      for (const inner of replay) if (inner.op === "accept_design") effects.accepted.add(inner.slug);
      effects.gate = operation.gate;
      effects.proposal = operation.slug;
      for (const inner of replay) {
        await applyOperation(resolved, record, inner, effects);
        effects.applied.push(inner);
      }
      delete effects.proposal;
      delete record.proposals[operation.slug];
      if (effects.claims?.files.get(operation.slug)?.activity === "design") endClaim(operation.slug, effects);
      break;
    }
    case "report_defect": {
      const slice = requireSlice(operation.slug);
      if (slice.status !== "done") throw fail("validation_failed", `A defect is reported on a done slice, and ${operation.slug} is ${slice.status}, so its work is fixed in place.`);
      const defects = slice.defects ?? [];
      const highest = defects.reduce((max, item) => Math.max(max, Number(DEFECT_ID.test(item?.id ?? "") ? item.id.slice(1) : 0)), 0);
      slice.defects = [...defects, { id: `d${highest + 1}`, requirements: normalizeRequirements(resolved, operation.requirements), summary: operation.summary, reportedAt: (/* @__PURE__ */ new Date()).toISOString() }];
      break;
    }
    case "add_fix": {
      if (effects.proposal !== operation.slug) throw fail("validation_failed", "add_fix stands only inside the propose_design of the done scope that it names.");
      const fixed = requireSlice(operation.slug);
      if (fixed.status !== "done") throw fail("validation_failed", `add_fix fixes a done slice, and ${operation.slug} is ${fixed.status}.`);
      const fix = operation.fix;
      if (Object.hasOwn(slices, fix.slug)) throw fail("validation_failed", `The slice slug ${fix.slug} is already used in this initiative.`);
      await checkPlanFolders(resolved, slices, fix.slug);
      if (new Set(operation.defects).size !== operation.defects.length) throw fail("validation_failed", "add_fix names each defect once.");
      const held = new Set((fixed.defects ?? []).map((item) => item.id));
      const unknown = operation.defects.filter((id) => !held.has(id));
      if (unknown.length) throw fail("validation_failed", `The slice ${operation.slug} holds no defect ${unknown.join(", ")}; report it with report_defect first.`);
      const named = operation.defects.filter((id) => Object.values(slices).some((other) => other.fixes?.slice === operation.slug && other.fixes.defects.includes(id)));
      if (named.length) throw fail("validation_failed", `Another fix slice of ${operation.slug} already fixes ${named.join(", ")}.`);
      slices[fix.slug] = { title: fix.title, outcome: fix.outcome, status: "not-started", parent: operation.slug, fixes: { slice: operation.slug, defects: [...operation.defects] }, requirements: normalizeRequirements(resolved, fix.requirements), dependencies: [] };
      break;
    }
    case "regenerate_markdown":
      break;
    case "remove_records":
      throw fail("validation_failed", "remove_records must be the only operation of its update.");
    default:
      throw fail("validation_failed", `Unsupported operation ${operation.op}.`);
  }
}
function checkFixProposal(operation) {
  const refuse = (reason) => fail("validation_failed", `The design proposal of the done slice ${operation.slug} was not recorded: ${reason}`);
  const fixes = operation.operations.filter((item) => item.op === "add_fix");
  if (fixes.length !== 1 || fixes[0].slug !== operation.slug) throw refuse("a done slice is designed as exactly one add_fix that names it.");
  const fixSlug = fixes[0].fix.slug;
  const other = operation.operations.filter((item) => item.op !== "add_fix" && !(["set_dependencies", "update_slice", "accept_design"].includes(item.op) && item.slug === fixSlug));
  if (other.length) throw refuse(`it takes only set_dependencies, update_slice, and accept_design of the fix slice ${fixSlug}, not ${other.map((item) => `${item.op} of ${item.slug ?? item.parent}`).join(", ")}.`);
  if (operation.operations.filter((item) => item.op === "accept_design").length !== 1) throw refuse(`it takes exactly one accept_design of the fix slice ${fixSlug}.`);
}
async function removeRecords(input) {
  const { readRoadmap } = await import("./roadmap.mjs");
  const resolved = await resolveInitiative(input.projectRoot, input.initiative);
  const current = await loadRecord(resolved);
  if (current.revision !== input.expectedRevision) {
    throw fail("revision_conflict", revisionMismatch("initiative record", input.expectedRevision, current.revision), { currentRevision: current.revision });
  }
  const roadmap = await readRoadmap(input.projectRoot);
  const decision = roadmap.loaded.record?.initiatives?.find((item) => item.id === input.initiative)?.decision;
  if (decision?.kind !== "superseded") throw fail("gate_blocked", `Record the superseded decision for ${input.initiative} on the roadmap before removing its records; a shipped initiative keeps its records as history.`);
  await removeInitiativeRecords(resolved.root, input.initiative);
  return { initiative: input.initiative, removed: true, decision: decision.kind };
}
async function viewScope(resolved) {
  return { top: resolved.directory, initiative: resolved.initiative, plans: (await readWorkflowConfig(resolved.root)).paths?.plans ?? null };
}
async function checkOverview(resolved, slices, operation) {
  const planned = [...new Set(operation.operations.filter((item) => item.op === "accept_design").map((item) => item.slug))];
  if (planned.length < 2) return;
  const folder = sliceFolder(resolved.directory, slices, operation.slug);
  const overview = `${folder}/overview.puml`;
  const refuse = (reason, details = {}) => fail("overview_missing", `The design proposal of ${operation.slug} was not recorded: it plans ${planned.length} slices, so ${reason}`, { path: overview, ...details });
  const design = await readArtifactText(resolved.root, `${folder}/slice.md`).catch(() => null) ?? "";
  const view = readViews(design, folder).views.find((item) => item.path === overview);
  if (!view) throw refuse(`the Views section of ${folder}/slice.md declares ${overview}, a component view that names every planned slice: ${planned.join(", ")}.`);
  if (view.kind !== "component") throw refuse(`${overview} must be a component view, and ${folder}/slice.md declares it as ${view.kind}.`);
  const source = await readArtifactText(resolved.root, overview).catch(() => null);
  if (source === null || drawnKind(overview, source) !== "component" && drawnKind(overview, source) !== "deployment") return;
  const named = (slugValue) => new RegExp(`(?:^|[^A-Za-z0-9_-])${slugValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9_-])`, "m").test(source.replace(/^\s*'.*$/gm, ""));
  const missing = planned.filter((slugValue) => !named(slugValue));
  if (missing.length) throw refuse(`${overview} names every planned slice by its slug, as an element name, alias, or label, and it leaves out ${missing.join(", ")}.`, { missing });
}
async function precheckViews(resolved, input) {
  const cache = /* @__PURE__ */ new Map();
  if (!input.some((operation) => ["accept_design", "propose_design", "accept_proposal"].includes(operation.op))) return cache;
  const current = await loadRecord(resolved).catch(() => null);
  const operations = input.flatMap((operation) => operation.op === "propose_design" ? operation.operations : operation.op === "accept_proposal" ? current?.record?.proposals?.[operation.slug]?.operations ?? [] : [operation]);
  const accepted = operations.filter((operation) => operation.op === "accept_design").map((operation) => operation.slug);
  const parents = new Map(Object.entries(current?.record?.slices ?? {}).map(([key, slice]) => [key, slice?.parent ?? null]));
  for (const operation of operations) {
    if (operation.op === "create") parents.set(operation.slug, null);
    if (operation.op === "split") for (const child of operation.children) parents.set(child.slug, operation.parent);
    if (operation.op === "add_fix") parents.set(operation.fix.slug, operation.slug);
  }
  const folders = /* @__PURE__ */ new Set();
  for (const slug2 of accepted) {
    for (let key = slug2, depth = 0; key !== null && key !== void 0 && depth < 100; key = parents.get(key), depth += 1) {
      folders.add(parents.has(key) && parents.get(key) === null ? resolved.directory : `${resolved.directory}/${key}`);
    }
  }
  const scope = await viewScope(resolved);
  for (const folder of folders) cache.set(folder, await checkFolderViews(resolved.root, folder, scope));
  return cache;
}
async function updateInitiative(input) {
  validateInput(UPDATE_INITIATIVE_SCHEMA, input);
  await checkCitations(input.projectRoot, await updateCitations(input));
  await refuseShipped(input.projectRoot, input.initiative);
  const result = input.operations.some(takesClaims) ? await claimingUpdate(input) : await finishUpdate(await writeInitiative(input));
  if (result.removed || !input.operations.some((operation) => operation.op === "claim" || operation.op === "set_status")) return result;
  const state = await readCoordinationState({ projectRoot: input.projectRoot, initiative: input.initiative }).catch(() => null);
  return { ...result, settings: effectiveSettings(state?.valid ? state.state : null) };
}
async function updateCitations(input) {
  const references = [];
  const documents = /* @__PURE__ */ new Set();
  const files = /* @__PURE__ */ new Set();
  let resolved = null;
  let slices = null;
  const folderOf = async (slugValue) => {
    resolved ??= await resolveInitiative(input.projectRoot, input.initiative);
    slices ??= (await loadRecord(resolved).catch(() => null))?.record?.slices ?? {};
    return sliceFolder(resolved.directory, slices, slugValue);
  };
  const visit = async (operation, inProposal) => {
    const requirements = operation.op === "create" || operation.op === "report_defect" ? operation.requirements : operation.op === "split" ? operation.children.flatMap((child) => child.requirements) : operation.op === "add_fix" ? operation.fix.requirements : [];
    references.push(...requirements);
    if (operation.op === "accept_design") {
      documents.add(`${await folderOf(operation.slug)}/slice.md`);
      for (const file of operation.frozenTests) if (file.endsWith(".feature")) files.add(file);
    }
    if (operation.op === "propose_design" && !inProposal) {
      documents.add(`${await folderOf(operation.slug)}/slice.md`);
      for (const inner of operation.operations) await visit(inner, true);
    }
  };
  for (const operation of input.operations) await visit(operation, false);
  if (!references.length && !documents.size && !files.size) return {};
  const config = resolved?.config ?? await readWorkflowConfig(input.projectRoot);
  const normalized2 = references.map((reference) => normalizeRequirementReference(config.paths.requirements, reference).reference).filter(Boolean);
  return { references: normalized2, documents: [...documents], files: [...files] };
}
async function reviewPolicy(resolved, effects) {
  if (effects.reviewPolicy === void 0) {
    const state = await readCoordinationState({ projectRoot: resolved.root, initiative: resolved.initiative }).catch(() => null);
    effects.reviewPolicy = effectiveSettings(state?.valid ? state.state : null).review;
  }
  return effects.reviewPolicy;
}
const takesClaims = (operation) => operation.op === "claim" || operation.op === "release_claim" || operation.op === "set_status" && operation.status === "in-progress";
async function claimContext(resolved, mode, label = null) {
  const { claims } = await readClaims(resolved);
  const holder = claimHolder();
  const model = mode === "plan" && callIsMainAgent() ? await readAgentModel(holder) : null;
  return { mode, holder, label, host: claimHost(), model, session: claimSession(), now: Date.now(), files: claims, initial: new Map(claims), expired: [], released: [], releasedSlugs: /* @__PURE__ */ new Set(), ended: /* @__PURE__ */ new Set() };
}
async function withClaimsLock(resolved, action) {
  const folder = path.dirname((await locateRecord(resolved.root, { kind: "claim", initiative: resolved.initiative, slice: "x" })).target);
  await mkdir(path.dirname(folder), { recursive: true });
  return withArtifactLock(folder, () => withFileLock(folder, action, fail));
}
async function withInitiativeWriteLocks(projectRoot, initiative, action) {
  if (!SLUG_PATTERN.test(initiative ?? "")) throw fail("invalid_path", "The initiative identifier must use letters, digits, hyphens, or underscores.");
  const resolved = { root: projectRoot, initiative };
  return withClaimsLock(resolved, () => withRecordLock(projectRoot, { kind: "initiative", initiative }, () => withRecordLock(projectRoot, { kind: "state", initiative }, action, fail), fail));
}
const claimKey = (resolved, slug2) => ({ kind: "claim", initiative: resolved.initiative, slice: slug2 });
async function readClaim(resolved, slug2) {
  const { bytes } = await readRecord(resolved.root, claimKey(resolved, slug2)).catch((error) => {
    if (error.tooLarge) return { bytes: null };
    throw error;
  });
  return bytes === null ? null : parseClaim(slug2, bytes).claim ?? null;
}
async function changeClaim(resolved, slug2, decide) {
  return withRecordLock(resolved.root, claimKey(resolved, slug2), async () => {
    const current = await readClaim(resolved, slug2);
    const next = await decide(current);
    if (next === null) await removeRecord(resolved.root, claimKey(resolved, slug2));
    else if (next !== void 0) await writeRecord(resolved.root, claimKey(resolved, slug2), serializeClaim(next));
    return next;
  }, fail);
}
async function prepare(input) {
  const standalone = input.operations.find((operation) => STANDALONE.has(operation.op));
  if (standalone && input.operations.length > 1) throw fail("validation_failed", `${standalone.op} must be the only operation of its update.`);
  await moveLegacyRecords(input.projectRoot);
  if (standalone?.op === "remove_records") return { removed: await removeRecords(input) };
  const resolved = await resolveInitiative(input.projectRoot, input.initiative, true);
  const viewCache = await precheckViews(resolved, input.operations);
  if (!resolved.projectionInStore) await conservationStore.registerCoordinationOutputs(resolved.root, [resolved.projectionPath]);
  await mkdir(path.dirname(resolved.target), { recursive: true });
  return { resolved, viewCache };
}
async function checkSpelling(resolved, current) {
  if (current.spelledAs === void 0) return;
  await checkPlanFolders(resolved, {}, null);
  throw fail("revision_conflict", `The initiative ${resolved.initiative} differs only in letter case from the initiative ${current.spelledAs}, whose records this file system, which ignores letter case, finds under the same name; nothing changed. Choose another initiative identifier.`, { initiative: current.spelledAs });
}
function checkRevision(current, input) {
  if (current.revision !== input.expectedRevision) {
    throw fail(input.expectedRevision === "null" ? "invalid_revision" : "revision_conflict", revisionMismatch("initiative record", input.expectedRevision, current.revision), { currentRevision: current.revision });
  }
  if (current.exists && !current.valid) {
    throw fail("invalid_initiative", "The existing initiative record is invalid and was not changed.", { errors: current.errors });
  }
}
const workingCopy = (current, resolved) => current.record ? { id: current.record.id, slices: Object.assign(/* @__PURE__ */ Object.create(null), structuredClone(current.record.slices)), proposals: Object.assign(/* @__PURE__ */ Object.create(null), structuredClone(current.record.proposals ?? {})), history: [...current.record.history] } : { id: resolved.initiative, slices: /* @__PURE__ */ Object.create(null), proposals: /* @__PURE__ */ Object.create(null), history: [] };
async function applyAll(resolved, record, input, effects) {
  for (const operation of input.operations) {
    await applyOperation(resolved, record, operation, effects);
    if (!STANDALONE.has(operation.op)) effects.applied.push(operation);
  }
  await checkContractBudget(resolved, record.slices, effects.applied);
  try {
    analyzeInitiative(record.slices);
  } catch (error) {
    throw fail("invalid_initiative", `The proposed initiative record is invalid and was not written: ${error.message}`, { errors: [error.message] });
  }
}
const newEffects = (input, viewCache, claims, notes, dryRun) => ({ staged: [], installed: [], refs: [], views: [], checkedFolders: /* @__PURE__ */ new Set(), viewCache, accepted: new Set(input.operations.filter((operation) => operation.op === "accept_design").map((operation) => operation.slug)), applied: [], actor: input.actor, claims, notes, dryRun });
async function writeInitiative(input, plan = null) {
  const prepared = plan?.prepared ?? await prepare(input);
  if (prepared.removed) return { removed: prepared.removed };
  const { resolved, viewCache } = prepared;
  const written = await withArtifactLock(resolved.target, () => withFileLock(resolved.target, async () => {
    await refuseShipped(input.projectRoot, input.initiative);
    const current = await loadRecord(resolved);
    await checkSpelling(resolved, current);
    checkRevision(current, input);
    const record = workingCopy(current, resolved);
    const effects = newEffects(input, viewCache, await claimContext(resolved, "apply"), plan?.notes ?? /* @__PURE__ */ new Map(), false);
    await applyAll(resolved, record, input, effects);
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const actor = input.actor ?? "agent";
    const recorded = input.operations.filter((operation) => operation.op !== "regenerate_markdown" && (operation.op !== "claim" || effects.notes.has(operation)));
    for (const operation of recorded) record.history.push({ actor, operation: operation.op, ...operation.slug ? { slug: operation.slug } : operation.parent ? { slug: operation.parent } : {}, at, ...effects.notes.get(operation) });
    const contents = serialize(record);
    const changed = recorded.length > 0 && (!current.exists || contents !== current.text);
    if (changed) await writeRecord(resolved.root, { kind: "initiative", initiative: resolved.initiative }, contents);
    if (changed && resolved.store && input.operations[0]?.op === "accept_proposal") await acceptPlanVersions(resolved, record, effects.accepted, at);
    const withdrawn = [];
    for (const staged of effects.staged) if (record.slices[staged.slice]?.design?.staged) withdrawn.push(...await withdrawFrozenTests(resolved.root, resolved.initiative, staged));
    if (changed && effects.refs.length) {
      const { dropSliceRefs, setSliceRef } = await import("./slice-gate.mjs");
      for (const item of effects.refs) {
        if (item.drop) await dropSliceRefs(resolved.root, resolved.initiative, item.slice);
        else await setSliceRef(resolved.root, resolved.initiative, item.slice, "start", item.start);
      }
    }
    let projectionStale = false;
    try {
      await checkPlanFolders(resolved, record.slices, null);
      projectionStale = !(await writeProjection(resolved.root, resolved.projectionPath, markdown(canonicalRecord(record)), RECORD_NAME)).written;
    } catch {
      projectionStale = true;
    }
    const updated = await loadRecord(resolved);
    return { result: { ...publicResult(resolved, updated), created: !current.exists, previousRevision: current.revision, projectionStale, withdrawn, installed: effects.installed, views: effects.views }, ended: [...effects.claims.ended].map((slug2) => effects.claims.files.get(slug2)) };
  }, fail));
  return { ...written, resolved };
}
async function acceptPlanVersions(resolved, record, accepted, at) {
  const slugs = [...accepted].filter((slug2) => Object.hasOwn(record.slices, slug2));
  if (!slugs.length) return;
  const folders = slugs.map((slug2) => sliceFolder(resolved.directory, record.slices, slug2));
  const exclude = Object.keys(record.slices).filter((slug2) => record.slices[slug2].parent !== null && !accepted.has(slug2)).map((slug2) => sliceFolder(resolved.directory, record.slices, slug2));
  await acceptArtifactVersions(resolved.root, folders, { exclude, event: { event: "design_accepted", initiative: resolved.initiative, slices: slugs, at } }).catch(() => []);
}
async function finishUpdate(written, plan = null) {
  if (written.removed) return written.removed;
  const { resolved } = written;
  const taken = new Set((plan?.writes ?? []).map((item) => item.slug));
  const ended = written.ended.filter((claim) => !taken.has(claim.slug));
  if (ended.length) {
    await withClaimsLock(resolved, async () => {
      for (const claim of ended) await changeClaim(resolved, claim.slug, (current) => current?.nonce === claim.nonce ? null : void 0);
    });
  }
  for (const claim of ended) dropClaim(resolved.root, resolved.initiative, claim.slug);
  for (const item of plan?.releases ?? []) dropClaim(resolved.root, resolved.initiative, item.slug);
  for (const item of plan?.writes ?? []) holdClaim(resolved.root, resolved.initiative, item.claim);
  const view = await claimsView(resolved, await loadRecord(resolved));
  return {
    ...written.result,
    record: view.loaded.record,
    claims: { taken: (plan?.writes ?? []).map((item) => claimView(item.claim)), expired: plan?.expired ?? [], released: plan?.released ?? [], ended: ended.map(claimView), confirmation: plan?.confirmation ?? null },
    ...view.fields.lostClaims ? { lostClaims: view.fields.lostClaims } : {}
  };
}
async function claimingUpdate(input) {
  const prepared = await prepare(input);
  const { resolved, viewCache } = prepared;
  const store = await recordStoreOf(resolved.root);
  const label = await claimLabel(store.external ? store.base : store.root);
  const plan = await withClaimsLock(resolved, async () => {
    await refuseShipped(input.projectRoot, input.initiative);
    const current = await loadRecord(resolved);
    await checkSpelling(resolved, current);
    checkRevision(current, input);
    const record = workingCopy(current, resolved);
    const claims = await claimContext(resolved, "plan", label);
    const effects = newEffects(input, viewCache, claims, /* @__PURE__ */ new Map(), true);
    await applyAll(resolved, record, input, effects);
    const writes = [];
    const releases = [];
    for (const slug2 of /* @__PURE__ */ new Set([...claims.initial.keys(), ...claims.files.keys()])) {
      const before = claims.initial.get(slug2), after = claims.files.get(slug2);
      if (after && after.nonce !== before?.nonce) writes.push({ slug: slug2, claim: after, previous: before ?? null });
      else if (!after && before && claims.releasedSlugs.has(slug2)) releases.push({ slug: slug2, previous: before });
    }
    for (const item of writes) pendClaim(resolved.root, resolved.initiative, item.slug, item.claim.nonce);
    for (const item of writes) await changeClaim(resolved, item.slug, () => item.claim);
    for (const item of releases) await changeClaim(resolved, item.slug, () => null);
    const needsWrite = input.operations.some((operation) => operation.op !== "claim") || effects.notes.size > 0;
    return { prepared, slices: record.slices, writes, releases, expired: claims.expired, released: claims.released, notes: effects.notes, needsWrite, holder: claims.holder };
  });
  plan.confirmation = await confirmClaims(resolved, store, plan);
  if (!plan.needsWrite) {
    try {
      await refuseShipped(input.projectRoot, input.initiative);
    } catch (error) {
      await undoClaims(resolved, plan);
      throw error;
    }
    const current = await loadRecord(resolved);
    return finishUpdate({ resolved, ended: [], result: { ...publicResult(resolved, current), created: false, previousRevision: current.revision, projectionStale: false, withdrawn: [], installed: [], views: [] } }, plan);
  }
  let written;
  try {
    written = await writeInitiative(input, plan);
  } catch (error) {
    await undoClaims(resolved, plan);
    throw error;
  }
  return finishUpdate(written, plan);
}
async function confirmClaims(resolved, store, plan) {
  if (!store.sync) return "local";
  const status = await syncRecordStoreNow(store.base);
  if (LOCAL_SYNC.has(status.state)) return "local";
  if (status.state !== "ok" && status.state !== "conflicts") {
    await undoClaims(resolved, plan);
    const reason = String(status.message ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const slugs = [...plan.writes, ...plan.releases].map((item) => item.slug).join(", ");
    throw fail("claim_unconfirmed", `The claims on ${slugs} could not be confirmed with the record store's remote (${status.state}${reason ? `: ${reason}` : ""}), so they were withdrawn and this update was not applied. Try again once the remote is reachable.`, { syncState: status.state });
  }
  const { claims } = await readClaims(resolved);
  const now = Date.now();
  for (const item of plan.writes) {
    const found = claims.get(item.slug);
    const winner = found && found.nonce !== item.claim.nonce ? found : blockingClaim(plan.slices, claims, item.slug, plan.holder, now);
    if (found?.nonce === item.claim.nonce && !winner) continue;
    await undoClaims(resolved, plan);
    if (winner) throw fail("slice_claimed", `${claimedMessage(item.slug, winner)} Another machine claimed it first.`, { claim: claimView(winner) });
    throw fail("revision_conflict", `Another machine released or changed the claim on ${item.slug} while this update took it, so this update was not applied. Read the initiative again and retry.`, { currentRevision: (await loadRecord(resolved)).revision });
  }
  for (const item of plan.releases) {
    const found = claims.get(item.slug);
    if (!found) continue;
    await undoClaims(resolved, plan);
    throw fail("slice_claimed", `The claim on ${item.slug} was renewed or taken by ${found.label} for ${found.activity} on another machine while this release was synced, so it holds the slice until ${found.expiresAt} and this update was not applied.`, { claim: claimView(found) });
  }
  return "sync";
}
async function undoClaims(resolved, plan) {
  await withClaimsLock(resolved, async () => {
    const now = Date.now();
    for (const item of plan.writes) {
      await changeClaim(resolved, item.slug, (current) => current?.nonce !== item.claim.nonce ? void 0 : item.previous?.holder === plan.holder && isLive(item.previous, now) ? item.previous : null);
      settleClaim(resolved.root, resolved.initiative, item.slug, item.claim.nonce);
    }
    for (const item of plan.releases) await changeClaim(resolved, item.slug, async (current) => current === null && (await readRecord(resolved.root, claimKey(resolved, item.slug))).bytes === null ? item.previous : void 0);
  });
}
async function renewClaim(entry) {
  const resolved = await resolveInitiative(entry.root, entry.initiative);
  const model = entry.main ? await readAgentModel(entry.holder) : null;
  return withClaimsLock(resolved, async () => {
    let decided;
    await changeClaim(resolved, entry.slug, (current) => {
      decided = renewal(entry, current, Date.now(), model);
      return decided.lost ? void 0 : decided.claim;
    });
    return decided.lost ? decided : { renewed: decided.claim };
  });
}
function touchedSlugs(operations, slices) {
  const within = (scope) => Object.keys(slices).filter((key) => {
    for (let current = key, depth = 0; current !== null && current !== void 0 && depth < 1e3; current = slices[current]?.parent, depth += 1) if (current === scope) return true;
    return false;
  });
  return [...new Set(operations.flatMap((operation) => operation.op === "split" ? [operation.parent, ...operation.children.map((child) => child.slug)] : operation.op === "accept_proposal" ? within(operation.slug) : operation.slug ? [operation.slug] : []))];
}
function initiativeAcknowledgement(result, operations) {
  if (result.removed) return result;
  const slices = result.record?.slices ?? {};
  const touched = Object.fromEntries(touchedSlugs(operations, slices).filter((key) => slices[key]).map((key) => [key, {
    status: slices[key].status,
    ...slices[key].design ? { design: slices[key].design.staged ? "staged" : "accepted", frozenTests: slices[key].design.frozenTests.length, review: slices[key].design.review } : {},
    ...slices[key].splitEvidence ? { splitEvidence: slices[key].splitEvidence.kind } : {},
    ...result.record?.proposals?.[key] ? { proposal: "pending" } : {},
    ...slices[key].contractDefects ? { contractDefects: slices[key].contractDefects.length } : {},
    ...slices[key].defects?.length ? { defects: slices[key].defects.map((item) => item.id) } : {},
    ...slices[key].fixes ? { fixes: slices[key].fixes } : {},
    // A new design answers the defects but does not restart the slice, because restarting takes an implementation claim.
    ...slices[key].status === "blocked" && slices[key].design && !slices[key].contractDefects ? { next: "The design answers the contract defects, and the slice stays blocked until set_status in-progress restarts it." } : {},
    ...slices[key].claim ? { claim: { label: slices[key].claim.label, activity: slices[key].claim.activity, expiresAt: slices[key].claim.expiresAt } } : {}
  }]));
  const claims = result.claims ?? { taken: [], expired: [], released: [] };
  const listed = listedViews(result.views ?? []);
  const unchecked = uncheckedViews(result.views ?? []);
  return {
    initiative: result.initiative,
    revision: result.revision,
    previousRevision: result.previousRevision,
    ...result.created ? { created: true } : {},
    ...result.valid ? {} : { valid: false, errors: result.errors },
    slices: touched,
    ...result.derived?.readyToShip ? { readyToShip: true } : {},
    ...result.withdrawn.length ? { stagedTests: result.withdrawn } : {},
    ...result.installed.length ? { installedTests: result.installed } : {},
    ...listed.length ? { views: listed } : {},
    ...unchecked.length ? { viewsUnchecked: unchecked } : {},
    ...result.projectionStale ? { projectionStale: true } : {},
    ...claims.taken.length ? { claimConfirmation: claims.confirmation } : {},
    ...claims.expired.length ? { replacedClaims: claims.expired } : {},
    ...claims.released.length ? { releasedClaims: claims.released } : {},
    ...result.lostClaims ? { lostClaims: result.lostClaims } : {},
    ...result.settings ? { settings: result.settings } : {}
  };
}
const INITIATIVE_TOOLS = [
  {
    name: "get_initiative",
    description: "Read an initiative's MCP-managed slice record with derived leaves, effective dependencies, completion, design candidates, fixes (each slice with fix slices mapped to their slugs), unfinishedFixes ({ slice, defect, fix, status } for each defect whose fix slice is missing, with fix null and status not-designed, or not done), deferredFindings (each slice whose review deferred findings, mapped to { id, severity, title, gate, followUp, wave } per deferred finding), and readiness to ship, which unfinished fixes hold false, plus run totals computed from run records for each slice, each split parent with its descendants, and the initiative, and each live claim: on its slice in the record view and under claims with its label, activity, and expiry, where heldHere marks this server's claims; lostClaims lists, once, claims this server held that expired or were released or taken over. Reads never create files. A shipped initiative, also one without a record, adds shippedHistory: { initiative, shippedAt, message, documents, changedAfterShip, laterFixes }, where documents lists the slice documents its ship decision recorded, changedAfterShip each one changed, removed, or added since, ignoring the history mark, and laterFixes each roadmap entry whose corrects names the initiative ({ initiative, title, state, slices }, in roadmap order); the first read of an initiative that shipped before its documents were recorded records them, writes the history mark into each, and lists them under marked; a document in the checkout is to be committed apart from the task's changes, while one in the record store is shared by its sync and needs no commit.",
    inputSchema: GET_INITIATIVE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_initiative",
    description: "Apply revision-checked initiative operations: create the root slice, split a slice, set leaf status, set dependencies, update a slice title or outcome, accept a slice design with its frozen acceptance tests and review mark, or import a map.puml. Design proposes its result with propose_design, whose split, set_dependencies, update_slice, and accept_design operations change only the scope and the slices inside it: Prism checks them on a copy of the record, refuses with the same errors as a direct update, and keeps the proposal pending without changing any slice; after the design gate, accept_proposal applies it with the slugs whose review is required and, for a user_gate split, the gate where the person approved it. Both operations stand alone in their update. A split whose every part takes accept_design in the same update is a contract's slice plan; any other split into parts needs evidence: contract_size names contract files whose estimated tokens exceed the contract budget, unfrozen quotes an Unprobed assumption from the scope's slice.md and names the part that settles it, and user_gate names a pending gate the person answered, which a proposed split names at accept_proposal. Accepting designs refuses a contract whose slice.md and frozen tests exceed that budget with contract_too_large, listing the measured files. Accepting the design of a slice that has not started stages its frozen tests: Prism keeps them and takes them out of the work tree, and set_status in-progress puts them back when the slice starts, while a started slice set back to not-started stages them again; restore_tests puts the staged tests of a slice and its descendants back for a design revision, and accepting each design again stages them again. report_contract_defects, which verify_slice sends for an implementer, blocks a started slice and keeps the defects on it until its next accepted design, which clears them but leaves the slice blocked until set_status in-progress restarts it. Accepting a design also checks the views of the slice's folder and each ancestor's folder, which each folder's slice.md declares in a ## Views section, one item per view: `<file>` <kind> (\xA7<n>, \u2026): <question?>, where kind is one of sequence, activity, state, component, data-model, deployment, wireframe, code, or api, and only an api view may name a project-relative path outside the folder; it refuses with view_problems an undeclared PlantUML file, a Views line of another form, an unknown kind, a missing question, a view that cites no clause or a clause beyond the governing contract, a view file that does not exist, a view whose source draws another kind than it declares, a PlantUML view that does not parse, an api view that is not JSON holding an OpenAPI 3.0 or 3.1 document with info and paths or an AsyncAPI 2 or 3 document with info and channels, and a view beyond a readability limit of its kind: a sequence of more than 10 participants or 30 messages, an activity of more than 30 actions and decisions, a state view of more than 20 states or 40 transitions, a component, deployment, code, or data-model view of more than 30 elements or 50 relations, a wireframe of more than 60 widgets, or an api view of more than 30 operations; the result lists the checked views as views ({ path, kind, elements, relations }) and the views whose check could not run as viewsUnchecked. When no view problem remains, a view of the slice's own folder whose count exceeds two thirds of a limit of its kind is dense, and accept_design refuses it with split_assessment_missing unless that folder's slice.md has a ## Split assessment item `<file>`: <why the slice stays whole> for it; the accepted design records the views of the slice's own folder as design.views ([{ path, kind, elements, relations, dense }], sorted by path), and an ancestor's views are not the slice's. A propose_design that accepts the designs of more than one slice is refused with overview_missing, data.path naming <scope folder>/overview.puml, unless the scope folder's Views section declares overview.puml as a component view that names every planned slice's slug, and data.missing lists the slugs it leaves out; a refused proposal records nothing. Accepting a design also refuses a slice.md Changes line that is not add, change, or remove followed by comma-separated paths in backticks and a colon with the note. accept_design takes the slice's component, bare or as <repository>/<component>, records it as <repository>/<component>, and may leave it out only in a repository that declares no components under ## Components in .prism/workflow.md, which records the root component; acceptance refuses an invalid declaration with component_invalid, component_overlap, component_dependency_unknown, or component_cycle, a component that is not this repository's with component_unknown, listing its components, and a slice whose Changes paths or frozen tests belong to another component and lie under no shared path with component_boundary, listing the paths. set_status in-progress refuses to start a not-started slice with dependencies_incomplete, naming them, until every slice it depends on directly or through an ancestor is done. Done transitions require a passing completion gate: a fresh passing verify_slice run for a slice with an accepted design, plus an accepted implementation review when that design requires review; verify_slice records done itself when no review is marked. A slice has at most one holder, the host session that claimed it, or the Prism server process when the host names no session, across every checkout and machine that shares the records: set_status in-progress takes an implementation claim, claim takes a design claim on a scope before design starts, or an implementation claim on a slice that is in-progress, such as after the caller's claim lapsed, and a claim covers the slice's descendants. An agent's call that works on a slice, namely propose_design, accept_proposal, restore_tests, report_contract_defects, set_status moving a slice out of in-progress, verify_slice except a dependents' run, update_review, update_change_map, and update_design_view, is refused with claim_required before it changes anything unless a live claim of the caller is on the slice or an ancestor, saying whether its own claim expired; an operation may work on a slice that an earlier operation of the same update claims or starts. Any other change to a slice is refused with slice_claimed while another holder's live claim covers it. Taking a claim is refused with slice_claimed, naming the holder's label, activity, and expiry, while another holder's live claim covers the slice, an ancestor, or a descendant; an expired claim is replaced and the result names it under replacedClaims. An update that takes or releases claims is checked whole, writes its claims first, and where store sync is on waits for a sync before anything else is written: another machine's claim or renewal that won refuses it with slice_claimed, and an unreachable remote refuses it with claim_unconfirmed; a refused update applies none of its operations. The holding server renews its live claims every 10 minutes, a server the host restarts in the same session renews them after its first read or update of the initiative, a claim expires 30 minutes after its last renewal, and an expired claim is never renewed. A claim ends when its slice leaves in-progress, when the scope's proposal is accepted, or through release_claim, which anyone may send and which the history records. Design starts only on a ready work item: create, and a claim that takes a design claim, are refused with item_emerging, the item, and unmet, its readiness conditions with not_confirmed while its shaping record has no ready mark, while the initiative's roadmap entry is an emerging work item, and an initiative without a roadmap entry is not refused. propose_design, accept_design, and accept_proposal are refused with adr_draft and adrs ([{ path, scope }]) while the scope's slice.md, a slice.md of a scope above it, or an accepted slice's slice.md links an ADR whose status is Draft, which design decides first with update_artifact decide. A defect in done work is fixed as new work: report_defect ({ slug, requirements, summary }) records a defect d<n> on a done slice and refuses any other slice with validation_failed; claim takes a design claim on a done slice; propose_design on a done scope takes exactly one add_fix ({ slug, defects, fix: { slug, title, outcome, requirements } }) naming that scope, set_dependencies and update_slice on the fix slug, and one accept_design of the fix slug, refusing with validation_failed any other operation, a defect the scope does not hold or another fix slice names, and a used slug, while add_fix outside propose_design refuses too; accept_proposal adds the fix as a not-started slice below the done slice, with fixes { slice, defects }, whose slice.md sits in its own folder, and leaves the done slice's records unchanged. A fix slice is a leaf of the done slice's ancestors, cannot split, starts after the dependencies of the done slice and its ancestors, and holds the dependents of the done slice until it is done. set_status changing a done slice to another status refuses with slice_done. With a record store named in .prism/workflow.md, Prism reads each slice.md and PlantUML file from the store, never from the checkout, and writes initiative.md there: accepting a design whose slice.md only the checkout holds is refused with artifact_not_found, a frozen test under the configured Requirements, ADRs, or Plans folder or at the Glossary or Roadmap path with frozen_test_in_store, and create, import_map, split, add_fix, propose_design, and accept_design refuse a slug whose plan folder breaks the artifact name form with artifact_name_invalid, differs only in letter case from another initiative's or slice's plan folder or a stored plan file with artifact_name_conflict and data.path, or whose location in the store with /initiative.md holds more than " + ARTIFACT_LOCATION_BYTES_MAX + " bytes, or a name of more than " + STORE_NAME_BYTES_MAX + ", with artifact_path_too_long and data.location. Every write validates the whole slice graph and regenerates initiative.md. The result acknowledges the new revision and the touched slices; get_initiative reads the whole record. A shipped initiative's state is history: every operation on it, remove_records included, is refused with initiative_shipped, naming the initiative and its ship time, before every check except argument validation and the citation check, and changes no record, while a roadmap record that cannot be read or parsed refuses it with invalid_roadmap; start new work on it as a new initiative. Work that cites an artifact breaking its format is refused, whole and changing nothing, with artifact_nonconforming before every other check except argument validation: the requirement files that create, split, report_defect, and add_fix reference, also inside propose_design, and, for propose_design and accept_design, each requirement file, ADR, glossary, or feature file that check_artifacts lists and that a Markdown link in the scope's or a planned slice's slice.md resolves to, and each frozen test that is a .feature file; the result is an error whose artifacts lists { path, scope, type, findings, migration }, with migration { run, status, reason } of the artifact's format migration run as check_artifacts reports it, or null, and whose text names each artifact, with its scope label for a store artifact, its broken rule ids, and the state of its format migration: Prism migrating it in a run, the run waiting for the person's answers on Attention or for an available host, the run failed with its reason, Prism not migrating feature files, or no run started yet; the refusal offers no migration. A <type>.unknown finding, an unknown value in a requirement file that is not a Draft or an ADR that is not Proposed, refuses like any other finding, while a cited file that does not exist and an unknown value in a Draft requirement file or a Proposed ADR refuse nothing, and records that already cite a nonconforming artifact still load. After the roadmap records the initiative as superseded, remove_records alone deletes the initiative's coordination records during cleanup and keeps its run entries.",
    inputSchema: UPDATE_INITIATIVE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];
export {
  GET_INITIATIVE_SCHEMA,
  INITIATIVE_TOOLS,
  InitiativeError,
  SPLIT_EVIDENCE_KINDS,
  UPDATE_INITIATIVE_SCHEMA,
  claimedByUpdate,
  fitScopes,
  getInitiative,
  initiativeAcknowledgement,
  initiativeWork,
  mergeInitiativeRecord,
  normalizeRequirementReference,
  readInitiative,
  readInitiativeWithClaims,
  renewClaim,
  requireClaimedWork,
  resolveInitiative,
  scopeDependents,
  scopeLeaves,
  sliceFolder,
  unfinishedFixes,
  unfinishedFixesMessage,
  updateInitiative,
  withInitiativeWriteLocks
};
