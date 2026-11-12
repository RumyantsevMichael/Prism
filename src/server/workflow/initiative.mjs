import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertInput, describeErrors } from "./artifact-schema.mjs";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { analyzeInitiative, LEAF_STATUSES, parseLegacyMap, SLUG_PATTERN } from "./initiative-graph.mjs";
import { initiativeDirectory, readWorkflowConfig, roadmapPaths } from "./workflow-config.mjs";
import { componentOf, dependentsOf, findComponent, readComponents, underSharedPath } from "./components.mjs";
import { resolveArtifactPath } from "../conservation/change-map.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { generatedNotice, writeProjection } from "./projection.mjs";
import { revisionMismatch } from "./revision.mjs";
import { listClaimRecords, locateRecord, moveLegacyRecords, readRecord, recordStoreOf, removeInitiativeRecords, removeRecord, withRecordLock, writeRecord } from "./record-store.mjs";
import { syncRecordStoreNow } from "./record-store-sync.mjs";
import { blockingClaim, claimedMessage, claimHolder, claimLabel, claimView, dropClaim, holdClaim, isLive, newClaim, parseClaim, pendClaim, renewal, serializeClaim, settleClaim, takeLostClaims, adoptClaims } from "./slice-claims.mjs";
import { mergeHistory, mergeKeyed, mergeUnit, MergeConflict, parseVersions } from "./record-merge.mjs";
import { CONTRACT_TOKEN_BUDGET, designProblems, digestFrozenTests, installFrozenTests, latestDependentsRun, measureContract, restageFrozenTests, REVIEW_MARKS, stageFrozenTests, verifiedCode, withdrawFrozenTests } from "./slice-design.mjs";
import { effectiveSettings, readCoordinationState } from "./state.mjs";
import { checkFolderDiagrams, diagramProblems } from "./diagram-check.mjs";
import { refuseShipped, shippedHistory } from "./shipped-history.mjs";
import { contractClauses, plannedChanges } from "./design-view.mjs";
import { deferredFindings, loadReview } from "../review/review-ledger.mjs";

const RECORD_NAME = "initiative.json";
const PROJECTION_NAME = "initiative.md";
const RECORD_MAX_BYTES = 1024 * 1024;
const HISTORY_LIMIT = 500;

export class InitiativeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "InitiativeError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code, message, details) => new InitiativeError(code, message, details);
const text = { type: "string", minLength: 1, maxLength: 2000 };
const slug = { type: "string", minLength: 1, maxLength: 120 };
const strings = { type: "array", maxItems: 200, items: text };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const childSchema = object({ slug, title: text, outcome: text, requirements: strings }, ["slug", "title", "requirements"]);
export const SPLIT_EVIDENCE_KINDS = Object.freeze(["contract_size", "unfrozen", "user_gate"]);
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
const STANDALONE = new Set(["remove_records", "propose_design", "accept_proposal"]);
// Sync outcomes that mean nothing else shares the record, so a claim is confirmed locally.
const LOCAL_SYNC = new Set(["no_upstream", "not_a_repository"]);

export const GET_INITIATIVE_SCHEMA = object({ projectRoot: text, initiative: slug }, ["projectRoot", "initiative"]);
export const UPDATE_INITIATIVE_SCHEMA = object({
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

export async function resolveInitiative(projectRoot, initiative, createParent = false) {
  if (!SLUG_PATTERN.test(initiative ?? "")) {
    throw fail("invalid_path", "The initiative identifier must use letters, digits, hyphens, or underscores.");
  }
  const config = await readWorkflowConfig(projectRoot);
  const directory = initiativeDirectory(config, initiative);
  if (directory === null) {
    throw fail("invalid_config", "The workflow config disables the plans path, so initiatives have no location.");
  }
  const record = await locateRecord(projectRoot, { kind: "initiative", initiative });
  const projection = await resolveArtifactPath(projectRoot, `${directory}/${PROJECTION_NAME}`, createParent, PROJECTION_NAME);
  return { root: record.root, initiative, directory, requirementsDirectory: config.paths.requirements, recordPath: record.path, target: record.target, projectionPath: projection.deltaPath, projectionTarget: projection.target };
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
      ...(slice.outcome ? { outcome: slice.outcome } : {}),
      status: slice.status,
      parent: slice.parent,
      ...(slice.fixes ? { fixes: { slice: slice.fixes.slice, defects: [...slice.fixes.defects] } } : {}),
      requirements: [...slice.requirements].sort(),
      dependencies: [...slice.dependencies].sort(),
      ...(slice.component ? { component: slice.component } : {}),
      ...(slice.design ? { design: { acceptedAt: slice.design.acceptedAt, frozenTests: [...slice.design.frozenTests].sort((left, right) => left.path.localeCompare(right.path)), review: slice.design.review, ...(slice.design.baselineId ? { baselineId: slice.design.baselineId } : {}), ...(slice.design.staged ? { staged: true } : {}), ...startOf(slice.design) } } : {}),
      ...(slice.splitEvidence ? { splitEvidence: slice.splitEvidence } : {}),
      ...(slice.contractDefects ? { contractDefects: slice.contractDefects } : {}),
      ...(slice.defects?.length ? { defects: slice.defects.map((item) => ({ id: item.id, requirements: [...item.requirements], summary: item.summary, reportedAt: item.reportedAt })) } : {})
    };
  }
  const proposals = Object.fromEntries(Object.keys(record.proposals ?? {}).sort().map((key) => [key, record.proposals[key]]));
  return { schemaVersion: 1, id: record.id, slices, ...(Object.keys(proposals).length ? { proposals } : {}), history: record.history.slice(-HISTORY_LIMIT) };
}

function serialize(record) {
  return `${JSON.stringify(canonicalRecord(record), null, 2)}\n`;
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
    if (slice?.contractDefects !== undefined && (!Array.isArray(slice.contractDefects) || slice.contractDefects.some((item) => typeof item?.clause !== "string" || typeof item?.reason !== "string"))) errors.push(`${key}: contractDefects must list { clause, reason } entries.`);
    if (slice?.component !== undefined && (typeof slice.component !== "string" || !COMPONENT_IDENTITY.test(slice.component) || slice.status === "split")) errors.push(`${key}: component must be a <repository>/<component> identity on a slice that is not split.`);
    if (slice?.splitEvidence !== undefined && (slice.status !== "split" || !SPLIT_EVIDENCE_KINDS.includes(slice.splitEvidence?.kind))) errors.push(`${key}: splitEvidence belongs to a split slice and names its kind.`);
    errors.push(...defectProblems(raw.slices, key));
  }
  if (raw.proposals !== undefined) {
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

// A done slice keeps the defects reported on it, and each of its fix slices names defects it holds that no other fix slice names.
function defectProblems(slices, key) {
  const slice = slices?.[key];
  const problems = [];
  if (slice?.defects !== undefined) {
    const valid = Array.isArray(slice.defects) && slice.defects.every((item) => DEFECT_ID.test(item?.id ?? "") && Array.isArray(item.requirements) && item.requirements.length > 0 && item.requirements.every((reference) => typeof reference === "string") && typeof item.summary === "string" && item.summary.length > 0 && typeof item.reportedAt === "string");
    if (!valid || new Set(slice.defects.map((item) => item.id)).size !== slice.defects.length) problems.push(`${key}: defects must list { id, requirements, summary, reportedAt } entries with distinct d<n> ids.`);
    if (slice.status !== "done") problems.push(`${key}: defects belong to a done slice.`);
  }
  if (slice?.fixes !== undefined) {
    const fixed = slices?.[slice.fixes?.slice];
    const held = new Set(Array.isArray(fixed?.defects) ? fixed.defects.map((item) => item?.id) : []);
    const defects = Array.isArray(slice.fixes?.defects) ? slice.fixes.defects : [];
    if (!defects.length || defects.some((id) => !held.has(id))) problems.push(`${key}: fixes must name defects that ${slice.fixes?.slice} holds.`);
    const shared = defects.filter((id) => Object.entries(slices).some(([other, value]) => other !== key && value?.fixes?.slice === slice.fixes.slice && Array.isArray(value.fixes.defects) && value.fixes.defects.includes(id)));
    if (shared.length) problems.push(`${key}: another fix slice of ${slice.fixes.slice} already fixes ${shared.join(", ")}.`);
  }
  return problems;
}

/**
 * Each defect reported on a done slice whose fix is unfinished, in slice then defect order: { slice, defect, fix, status },
 * where fix is the fix slice that names the defect and status its status, or null and not-designed while no fix slice names it.
 */
export function unfinishedFixes(record) {
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

/** The refusal message of a ship that waits for fixes, naming each unfinished one. */
export function unfinishedFixesMessage(initiative, fixes) {
  const named = fixes.map((item) => item.fix === null ? `${item.slice} ${item.defect} (no fix slice designed)` : `${item.slice} ${item.defect} (fix ${item.fix} is ${item.status})`);
  return `The initiative ${initiative} cannot ship while fixes to its done work are unfinished: ${named.join("; ")}. Design a fix slice for each defect and finish it before shipping.`;
}

/**
 * Merge three versions of an initiative record by structure for store sync: each slice by slug, each proposal by scope, and each scalar.
 * Returns { contents } with the canonical bytes of a merged record that passes validation and graph analysis, or { conflict } otherwise.
 */
export function mergeInitiativeRecord(versions) {
  const initiative = versions.path.split("/")[1];
  try {
    const { base, local, upstream } = parseVersions(versions, () => ({ schemaVersion: 1, id: initiative, slices: {}, history: [] }));
    if ([base, local, upstream].some((record) => !record || typeof record !== "object" || Array.isArray(record) || !record.slices || typeof record.slices !== "object" || !Array.isArray(record.history))) throw new MergeConflict("A version of the initiative record has no slices or history.");
    // Slices compare in their canonical form, so a reordered requirement or dependency list is no change.
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
    const raw = JSON.parse(contents);
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
    contents = await readFile(resolved.target);
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, revision: null, record: null, valid: true, errors: [], analysis: null };
    throw error;
  }
  if (contents.length > RECORD_MAX_BYTES) throw fail("artifact_too_large", "The initiative record exceeds 1 MiB.");
  const revision = revisionOf(contents);
  const text = contents.toString("utf8");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { exists: true, revision, text, record: null, valid: false, errors: ["The initiative record must contain valid JSON."], analysis: null };
  }
  const { errors, analysis } = validateRecord(raw, resolved.initiative);
  return { exists: true, revision, text, record: raw, valid: errors.length === 0, errors, analysis };
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

export async function readInitiative(projectRoot, initiative) {
  const resolved = await resolveInitiative(projectRoot, initiative);
  return { resolved, loaded: await loadRecord(resolved) };
}

export async function getInitiative(input) {
  validateInput(GET_INITIATIVE_SCHEMA, input);
  const { resolved, loaded } = await readInitiative(input.projectRoot, input.initiative);
  // Each slice with a passing run names the checkout it was verified in, since records in a shared store do not travel with a branch.
  const code = {};
  for (const slug of Object.keys(loaded.record?.slices ?? {})) {
    const checkout = await verifiedCode(resolved.root, resolved.initiative, slug).catch(() => null);
    if (checkout) code[slug] = checkout;
  }
  // Each fit scope with a recorded dependents' run shows its latest one, read from the run records alone, never from the components.
  const dependents = {};
  for (const scope of fitScopes(loaded.record)) {
    const latest = await latestDependentsRun(resolved.root, resolved.initiative, scope).catch(() => null);
    if (latest) dependents[scope] = { status: latest.entry.passed === true ? "passed" : "blocked", run: latest.path, finishedAt: latest.entry.finishedAt ?? null, blocked: Array.isArray(latest.entry.blocked) ? latest.entry.blocked : [] };
  }
  const view = await claimsView(resolved, loaded);
  const result = publicResult(resolved, view.loaded);
  // Each slice whose review deferred findings lists them, so a reader sees them apart from the unresolved ones; an unreadable review is left out.
  if (result.derived) {
    const deferred = {};
    for (const slug of Object.keys(view.loaded.record?.slices ?? {})) {
      const review = await loadReview(resolved.root, resolved.initiative, slug).catch(() => null);
      const entries = review?.document ? deferredFindings(review.document) : [];
      if (entries.length) deferred[slug] = entries;
    }
    result.derived.deferredFindings = deferred;
  }
  // A shipped initiative's read says that its state is history, also when it has no initiative record.
  const history = await shippedHistory(resolved.root, resolved.initiative);
  return { ...result, ...(Object.keys(code).length ? { code } : {}), ...(Object.keys(dependents).length ? { dependents } : {}), ...view.fields, ...(history ? { shippedHistory: history } : {}) };
}

/**
 * The fit scopes of an initiative record, in slug order: each split slice without split evidence, whose design accepted a slice plan,
 * and each leaf whose parent is null or has split evidence, which is a scope of its own.
 */
export function fitScopes(record) {
  const slices = record?.slices && typeof record.slices === "object" ? record.slices : {};
  return Object.keys(slices).filter((slug) => {
    const slice = slices[slug];
    if (slice?.status === "split") return !slice.splitEvidence;
    return slice?.parent == null || Boolean(slices[slice.parent]?.splitEvidence);
  }).sort();
}

/** The leaves of a scope in slug order: the leaves below its planned slices, which are the planned slices themselves unless one was split, or the leaf itself. */
export function scopeLeaves(record, scope) {
  const slices = record?.slices && typeof record.slices === "object" ? record.slices : {};
  // A fix slice is a leaf beside the done slice it fixes, so the done slice stays a leaf of its scope too.
  const children = (slug, fixes) => Object.keys(slices).filter((key) => slices[key]?.parent === slug && Boolean(slices[key]?.fixes) === fixes);
  const leaves = (slug, seen = new Set()) => {
    if (seen.has(slug)) return [];
    seen.add(slug);
    const own = children(slug, false);
    return [...(own.length ? own.flatMap((child) => leaves(child, seen)) : [slug]), ...children(slug, true).flatMap((child) => leaves(child, seen))];
  };
  return Object.hasOwn(slices, scope) ? [...new Set(leaves(scope))].sort() : [];
}

/**
 * The dependents of a scope by a valid declaration, in run order: every component that depends on a component its leaves record.
 * A leaf without a component, or with one the declaration no longer holds, adds none, so the dependents' run and ship judge a scope alike.
 */
export function scopeDependents(record, scope, declaration) {
  const recorded = scopeLeaves(record, scope).map((leaf) => record.slices[leaf]?.component).filter((identity) => typeof identity === "string");
  return dependentsOf(declaration, recorded.map((identity) => findComponent(declaration, identity)).filter(Boolean));
}

/** The claim records of an initiative by slice, with the problems of any that cannot be read. */
async function readClaims(resolved) {
  const claims = new Map();
  const problems = [];
  for (const { slice, bytes } of await listClaimRecords(resolved.root, resolved.initiative)) {
    const parsed = parseClaim(slice, bytes);
    if (parsed.claim) claims.set(slice, parsed.claim);
    else problems.push(parsed.problem);
  }
  return { claims, problems };
}

/**
 * Show the live claims with an initiative read: the record view gives each claimed slice its claim, and claims lists each live claim's label, activity, and expiry,
 * where heldHere marks this server's claims; claims this server lost since its last report for the initiative are listed once under lostClaims.
 */
async function claimsView(resolved, loaded, { report = true } = {}) {
  const { claims, problems } = await readClaims(resolved);
  const now = Date.now();
  const holder = claimHolder();
  const listed = {};
  let record = loaded.record;
  if (record?.slices && typeof record.slices === "object") {
    record = { ...record, slices: { ...record.slices } };
    for (const [slug, claim] of claims) {
      if (!isLive(claim, now) || !Object.hasOwn(record.slices, slug)) continue;
      record.slices[slug] = { ...record.slices[slug], claim: { holder: claim.holder, label: claim.label, ...(claim.host ? { host: claim.host } : {}), activity: claim.activity, claimedAt: claim.claimedAt, renewedAt: claim.renewedAt, expiresAt: claim.expiresAt } };
      listed[slug] = { label: claim.label, ...(claim.host ? { host: claim.host } : {}), activity: claim.activity, expiresAt: claim.expiresAt, heldHere: claim.holder === holder };
    }
  }
  if (report) adoptClaims(resolved.root, resolved.initiative, claims, now);
  const lost = report ? takeLostClaims(resolved.root, resolved.initiative, claims, now) : [];
  return { loaded: { ...loaded, record }, claims, fields: { ...(Object.keys(listed).length ? { claims: listed } : {}), ...(lost.length ? { lostClaims: lost } : {}), ...(problems.length ? { claimProblems: problems } : {}) } };
}

/** An initiative read with each slice's live claim in the record view, for readers such as the review browser. */
export async function readInitiativeWithClaims(projectRoot, initiative) {
  const { resolved, loaded } = await readInitiative(projectRoot, initiative);
  return { resolved, loaded: (await claimsView(resolved, loaded, { report: false })).loaded };
}

// Work on a slice belongs to the holder whose live claim covers it, so an agent that never claimed the slice, or whose claim lapsed, was released, or was replaced, is refused before it changes anything.
// These operations are such work; set_status is too when it moves a slice out of in-progress, and every other operation that changes a slice is refused only while another holder's claim covers it.
const CLAIMED_WORK = new Set(["propose_design", "accept_proposal", "restore_tests", "report_contract_defects"]);
// These operations change no slice's work, or take the claim themselves.
const UNCLAIMED_OPERATIONS = new Set(["create", "claim", "release_claim", "import_map", "regenerate_markdown", "remove_records"]);

const claimCovers = (slices, claim, slug) => {
  for (let current = slug, depth = 0; current !== null && current !== undefined && depth < 1000; current = slices[current]?.parent, depth += 1) if (current === claim.slug) return true;
  return false;
};

// A slug that only a pending proposal creates belongs to the scope that proposed it, such as a part that a design view describes before its proposal is accepted.
function workSlug(record, slug) {
  if (Object.hasOwn(record.slices, slug)) return slug;
  for (const [scope, proposal] of Object.entries(record.proposals ?? {})) {
    const created = (proposal?.operations ?? []).flatMap((operation) => operation.op === "split" ? (operation.children ?? []).map((child) => child.slug) : operation.op === "add_fix" ? [operation.fix?.slug] : []);
    if (created.includes(slug) && Object.hasOwn(record.slices, scope)) return scope;
  }
  return null;
}

/** The work a tool call does on an initiative's slices: { slug, own } for each slice it changes, where own means the caller must hold a live claim that covers the slice. */
export function initiativeWork(operations, record) {
  const work = [];
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (!operation || UNCLAIMED_OPERATIONS.has(operation.op)) continue;
    const slug = operation.op === "split" ? operation.parent : operation.slug;
    if (typeof slug !== "string") continue;
    const status = record?.slices?.[slug]?.status;
    const own = CLAIMED_WORK.has(operation.op) || (operation.op === "set_status" && operation.status !== "in-progress" && status === "in-progress");
    work.push({ slug, op: operation.op, own });
  }
  return work;
}

/**
 * Refuse a tool call that works on slices without the caller's claim: slice_claimed while another holder's live claim covers a slice it changes,
 * and claim_required while a slice it works on has no live claim of the caller on the slice or an ancestor.
 * work lists { slug, own, op }, and claimedHere the slugs the same call claims or starts first, which count as the caller's.
 * Records that cannot be read, a shipped initiative, and a slug the record does not hold are left to the tool, which refuses them with its own error.
 */
export async function requireClaimedWork({ projectRoot, initiative, tool, work, claimedHere = [] }) {
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
    const slug = workSlug(record, item.slug);
    if (slug === null) continue;
    if (claimedHere.some((claimed) => claimCovers(record.slices, { slug: claimed }, slug))) continue;
    const blocking = blockingClaim(record.slices, claims, slug, holder, now);
    if (blocking) throw fail("slice_claimed", claimedMessage(slug, blocking), { claim: claimView(blocking) });
    if (!item.own) continue;
    const covering = [...claims.values()].filter((claim) => claim.holder === holder && claimCovers(record.slices, claim, slug));
    if (covering.some((claim) => isLive(claim, now))) continue;
    const lapsed = covering.sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0];
    const why = lapsed ? `This session's claim on ${lapsed.slug} expired at ${lapsed.expiresAt}` : `No live claim of this session covers ${slug}`;
    throw fail("claim_required", `${why}, so ${tool}${item.op ? ` ${item.op}` : ""} was not applied: work on a slice needs its holder's live claim. Call update_initiative with a claim operation for ${slug}, or for the scope that contains it, then call again; Prism refuses the claim with slice_claimed when another agent took the slice meanwhile.`, { slice: slug, ...(lapsed ? { claim: claimView(lapsed) } : {}) });
  }
}

/** The slugs an update claims or starts itself, which its other operations may work on. */
export const claimedByUpdate = (operations) => (Array.isArray(operations) ? operations : [])
  .filter((operation) => operation?.op === "claim" || (operation?.op === "set_status" && operation.status === "in-progress"))
  .map((operation) => operation.slug)
  .filter((slug) => typeof slug === "string");

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
  return `${lines.join("\n")}\n`;
}

// Requirement files cite obligations as <file>.md§<n>, so that form is accepted and stored as <requirements dir>/<file>.md#<n>.
// The roadmap validates its references the same way, so an initiative created from a roadmap item never refuses them.
export function normalizeRequirementReference(requirementsDirectory, reference) {
  const cited = /^([^\s/#§]+\.md)§([^\s#§]+)$/.exec(reference);
  if (cited && requirementsDirectory) return { reference: `${requirementsDirectory}/${cited[1]}#${cited[2]}` };
  if (!/^[^\s#]+#[^\s#]+$/.test(reference)) {
    return { problem: `Invalid requirement reference ${JSON.stringify(reference)}: use <requirements path>.md#<number>, such as ${requirementsDirectory ?? "docs/requirements"}/capability.md#1, or <file>.md§<number>.` };
  }
  return { reference };
}

function normalizeRequirements(resolved, references) {
  return references.map((reference) => {
    const normalized = normalizeRequirementReference(resolved.requirementsDirectory, reference);
    if (normalized.problem) throw fail("validation_failed", normalized.problem);
    return normalized.reference;
  });
}

// The initiative directory is the root slice's folder; every other slice folder sits directly under it.
export function sliceFolder(directory, slices, slugValue) {
  return slices?.[slugValue]?.parent === null ? directory : `${directory}/${slugValue}`;
}

async function sliceOutcome(resolved, slices, slugValue) {
  try {
    const source = await readFile(path.join(resolved.root, sliceFolder(resolved.directory, slices, slugValue), "slice.md"), "utf8");
    const section = source.split(/^## Outcome\s*$/m)[1]?.split(/^#{1,2} /m)[0] ?? "";
    const sentence = section.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return sentence || undefined;
  } catch {
    return undefined;
  }
}

// A started slice's start content: its content tree, when Prism recorded it, and the ## Components declaration in force then.
const START_FIELDS = ["startTree", "startRecordedAt", "startDeclaration"];
const startOf = (design) => Object.fromEntries(START_FIELDS.filter((key) => design?.[key] !== undefined).map((key) => [key, design[key]]));

/**
 * The start content of a slice, hashed as a verification run hashes the project so the two trees compare path by path, with its time and the declaration in force, or null when Git cannot hash the work tree.
 * Starting a slice reads no components for a refusal, so an invalid declaration, or one without the slice's component, records the content without a declaration.
 */
async function startContent(root, identity) {
  const { contentTree, startDeclaration } = await import("./slice-gate.mjs");
  let config;
  try { config = await readWorkflowConfig(root); }
  catch { return null; }
  const startTree = await contentTree(root, config).catch(() => null);
  if (!startTree) return null;
  let declared = null;
  try {
    const declaration = readComponents(config);
    if (findComponent(declaration, identity)) declared = startDeclaration(declaration);
  } catch { declared = null; }
  return { startTree, startRecordedAt: new Date().toISOString(), ...(declared ? { startDeclaration: declared } : {}) };
}

async function completionGate(resolved, slugValue) {
  const { checkSliceGate } = await import("./slice-gate.mjs");
  try {
    return await checkSliceGate({ projectRoot: resolved.root, initiative: resolved.initiative, slice: slugValue, gate: "completion" });
  } catch (error) {
    return { ready: false, problems: [{ code: error.code ?? "evidence_missing", message: error.message }] };
  }
}

// The source at design acceptance is the baseline that the slice's derived change map compares with its verified result.
// Capture is best effort: without a baseline the derived change map is unavailable, and nothing else depends on it.
async function captureBaseline(root, initiative, slice) {
  try { return (await conservationStore.capture(root, { initiative, slice })).snapshotId; }
  catch { return null; }
}

const STARTED = new Set(["in-progress", "blocked"]);

// A frozen test file belongs to one unfinished slice, because each slice's tests go in place only when that slice starts.
// A staged slice owns its files outright, since staging takes them out of the work tree, so it never shares one even with a done slice.
function claimedTests(slices, slugValue, frozenTests, staging) {
  return frozenTests.map((item) => item.path).filter((file) => Object.entries(slices).some(([key, other]) => key !== slugValue && (staging || other.status !== "done") && other.design?.frozenTests.some((test) => test.path === file)));
}

const normalized = (value) => value.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();

// Models judging a scope's size split it long before one contract stopped working, so a split into parts
// that each get their own contract needs evidence that the server can check.
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
    const source = await readFile(path.join(resolved.root, sliceFolder(resolved.directory, slices, operation.parent), "slice.md"), "utf8").catch(() => "");
    const section = source.split(/^## Assumptions\s*$/m)[1]?.split(/^#{1,2} /m)[0] ?? "";
    if (!section.split(/\r?\n/).some((line) => /unprobed/i.test(line) && normalized(line).includes(quoted))) throw refuse(`the Assumptions of its slice.md list no Unprobed assumption that contains ${JSON.stringify(evidence.assumption)}.`);
    return { kind: evidence.kind, assumption: evidence.assumption, settledBy: evidence.settledBy };
  }
  // Only the review browser records a gate answer, so an answered gate is the person's own call.
  // A proposed split waits for that answer: accept_proposal names the gate where the person approved it.
  const gateId = evidence.gate ?? effects.gate;
  if (!gateId) {
    if (effects.dryRun) return { kind: evidence.kind };
    throw refuse("name the user gate where the person approved the split.");
  }
  const { state } = await readCoordinationState({ projectRoot: resolved.root, initiative: resolved.initiative });
  const gate = (Array.isArray(state?.pending) ? state.pending : []).find((item) => item?.id === gateId);
  if (!gate?.answer) throw refuse(`the user gate ${gateId} is not pending with an answer from the person.`);
  if (gate.answer.choice === "request-changes") throw refuse(`the person requested changes at ${gateId}.`);
  if (gate.slice !== undefined && gate.slice !== operation.parent) throw refuse(`the user gate ${gateId} is about ${gate.slice}.`);
  return { kind: evidence.kind, gate: gateId };
}

// One implementer reads the contract and the frozen tests of its slices, so a fit design above the budget splits instead.
// The contract is the slice.md of the scope that this update splits into its slice plan, or of the accepted slice itself.
async function checkContractBudget(resolved, slices, operations) {
  const planOf = new Map(operations.filter((operation) => operation.op === "split").flatMap((operation) => operation.children.map((child) => [child.slug, operation.parent])));
  const contracts = new Map();
  for (const operation of operations.filter((item) => item.op === "accept_design")) {
    const scope = planOf.get(operation.slug) ?? operation.slug;
    if (!contracts.has(scope)) contracts.set(scope, new Set([`${sliceFolder(resolved.directory, slices, scope)}/slice.md`]));
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

// The slugs a proposal changes outside its scope: it may split only the scope and change only the scope, the slices inside it, and the parts it creates.
function proposalOutside(slices, scope, operations) {
  const created = new Set(operations.flatMap((item) => item.op === "split" ? item.children.map((child) => child.slug) : item.op === "add_fix" ? [item.fix.slug] : []));
  const inside = (key) => {
    if (created.has(key)) return true;
    for (let current = key, depth = 0; current !== null && current !== undefined && depth < 1000; current = slices[current]?.parent, depth += 1) if (current === scope) return true;
    return false;
  };
  return [...new Set(operations.flatMap((item) => item.op === "split" ? (item.parent === scope ? [] : [item.parent]) : inside(item.slug) ? [] : [item.slug]))];
}

// Claim operations read and change the claim records, never the initiative record.
// While an update is planned, a claim is checked against every live claim of another holder on the slice, its ancestors, and its descendants, and an expired claim of
// another holder is replaced and named; when the update is applied, its claims are already in place and only the claims it ends are noted.
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
  claims.files.set(slugValue, newClaim(previous, { slug: slugValue, holder: claims.holder, label: claims.label, activity, now: claims.now }));
}

function endClaim(slugValue, effects) {
  const claims = effects.claims;
  if (!claims?.files.has(slugValue)) return;
  if (claims.mode === "plan") claims.files.delete(slugValue);
  else claims.ended.add(slugValue);
}

// An accepted design records the component that holds the slice, so every accept_design of an update reads the repository's declaration once, refusing an invalid one.
async function declarationOf(resolved, effects) {
  effects.components ??= readWorkflowConfig(resolved.root).then((config) => ({ config, declaration: readComponents(config) }));
  return effects.components;
}

// A repository that declares no components is one root component, which a design may leave unnamed; otherwise each design names a component of this repository, bare or qualified.
async function designComponent(resolved, operation, effects) {
  const { config, declaration } = await declarationOf(resolved, effects);
  const given = operation.component;
  const found = given === undefined ? (declaration.declared.length ? null : declaration.root) : findComponent(declaration, given);
  if (found === null || (!declaration.declared.length && found !== declaration.root)) {
    const identities = declaration.components.map((item) => item.identity);
    throw fail("component_unknown", `The design of ${operation.slug} was not accepted: ${given === undefined ? "it names no component" : `${given} is not a component of this repository`}. Name one of ${identities.join(", ")} as its component.`, { slice: operation.slug, component: given ?? null, components: identities });
  }
  return { component: found, declaration, config };
}

// Prism's own files belong to no component: .prism, the plans folder, and the roadmap record and projection.
function prismOwned(config, file) {
  const within = (folder) => folder !== null && folder !== "" && (file === folder || file.startsWith(`${folder}/`));
  const roadmap = roadmapPaths(config);
  return within(".prism") || within(config.paths.plans) || (roadmap !== null && (file === roadmap.record || file === roadmap.projection));
}

function checkBoundary({ component, declaration, config }, slug, files) {
  const crossing = [...new Set(files.map((file) => file.replace(/\/$/, "")))].filter((file) => !prismOwned(config, file) && componentOf(declaration, file) !== component && !underSharedPath(declaration, file)).sort();
  if (crossing.length) throw fail("component_boundary", `The design of ${slug} was not accepted: its planned changes and frozen tests leave its component ${component.identity} at ${crossing.join(", ")}. Keep each slice inside one component or under a shared path.`, { slice: slug, component: component.identity, paths: crossing });
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
      slices[operation.slug] = { title: operation.title, ...(operation.outcome ? { outcome: operation.outcome } : {}), status: "not-started", parent: null, requirements: normalizeRequirements(resolved, operation.requirements), dependencies: [] };
      break;
    case "import_map": {
      const source = await readFile((await resolveArtifactPath(resolved.root, operation.path, false, path.posix.basename(operation.path))).target, "utf8");
      const imported = parseLegacyMap(source);
      if (imported.id !== resolved.initiative) throw fail("validation_failed", `The map names initiative ${imported.id}, not ${resolved.initiative}.`);
      for (const [key, slice] of Object.entries(imported.slices)) {
        const outcome = await sliceOutcome(resolved, imported.slices, key);
        slices[key] = { ...slice, ...(outcome ? { outcome } : {}) };
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
        slices[child.slug] = { title: child.title, ...(child.outcome ? { outcome: child.outcome } : {}), status: "not-started", parent: operation.parent, requirements: normalizeRequirements(resolved, child.requirements), dependencies: [] };
      }
      // A split whose every part takes its design in the same update is a contract's slice plan; any other split needs evidence.
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
      // A done slice keeps the evidence of its passing verification, so a defect in it is fixed as new work.
      if (slice.status === "done" && operation.status !== "done") throw fail("slice_done", `The slice ${operation.slug} is done and stays done; report a defect with report_defect and design a fix as new work.`, { slice: operation.slug });
      // A slice starts only after every slice it depends on, directly or through an ancestor, is done.
      if (operation.status === "in-progress" && slice.status === "not-started") {
        const analysis = analyzeInitiative(slices);
        const waiting = (analysis.effectiveDependencies[operation.slug] ?? []).filter((target) => !analysis.complete[target]);
        if (waiting.length) throw fail("dependencies_incomplete", `The slice ${operation.slug} cannot start before the slices it depends on are done: ${waiting.join(", ")}.`, { slice: operation.slug, waiting });
      }
      // Starting a slice claims it, and a slice that leaves in-progress ends its claim.
      if (operation.status === "in-progress") takeClaim(record, operation.slug, "implementation", effects, operation);
      else endClaim(operation.slug, effects);
      if (operation.status === "in-progress" && slice.design?.staged) {
        // Tests staged earlier in the same update are still in the work tree, so only earlier updates' tests need installing.
        if (!effects.staged.some((item) => item.slice === operation.slug) && !effects.dryRun) effects.installed.push(...await installFrozenTests(resolved.root, resolved.initiative, operation.slug, slice.design.frozenTests));
        const baselineId = effects.dryRun ? null : await captureBaseline(resolved.root, resolved.initiative, operation.slug);
        delete slice.design.staged;
        if (baselineId) slice.design.baselineId = baselineId;
        else delete slice.design.baselineId;
      }
      // A slice that records a component keeps the project's content at its start, with its frozen tests in place, so verification can find the changes that leave the component.
      // A slice restarted after a block, or already in progress, keeps the content it started from, and a work tree that Git cannot hash records none.
      // The content stays under this checkout's local ref once the record is written, so git gc keeps it.
      if (operation.status === "in-progress" && slice.status !== "in-progress" && slice.component && slice.design && !slice.design.startTree && !effects.dryRun) {
        const start = await startContent(resolved.root, slice.component);
        if (start) {
          Object.assign(slice.design, start);
          effects.refs.push({ slice: operation.slug, start: start.startTree });
        }
      }
      // A slice back at not-started drops its start content and its refs, so starting it again records new start content.
      if (operation.status === "not-started" && (slice.design?.startTree || STARTED.has(slice.status))) {
        if (slice.design) for (const key of START_FIELDS) delete slice.design[key];
        if (!effects.dryRun) effects.refs.push({ slice: operation.slug, drop: true });
      }
      // A started slice that returns to not-started stages its frozen tests again, so other slices' verification never runs them,
      // unless another slice shares a test file, which staging would take from that slice too.
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
      if (operation.title !== undefined) slice.title = operation.title;
      if (operation.outcome !== undefined) slice.outcome = operation.outcome;
      break;
    }
    case "accept_design": {
      const slice = requireSlice(operation.slug);
      if (slice.status === "split") throw fail("validation_failed", "A split slice is designed through its children.");
      if (slice.status === "done") throw fail("validation_failed", "A done slice cannot take a new design.");
      const component = await designComponent(resolved, operation, effects);
      const review = await reviewPolicy(resolved, effects) === "all" ? "required" : operation.review;
      const frozenTests = await digestFrozenTests(resolved.root, operation.frozenTests);
      const staging = !STARTED.has(slice.status);
      const claimed = claimedTests(slices, operation.slug, frozenTests, staging);
      if (claimed.length) throw fail("validation_failed", `${claimed.join(", ")} already belongs to another slice${staging ? "" : " that is not done"}; give each slice its own test files.`);
      // A slice's code view sits in its folder and each contract's overview in the folder of the slice that owns the contract; each folder is checked once per update.
      const folders = [];
      for (let key = operation.slug; key !== null && key !== undefined; key = slices[key]?.parent) folders.push(sliceFolder(resolved.directory, slices, key));
      const diagrams = [];
      for (const folder of new Set(folders.filter((item) => !effects.checkedFolders.has(item)))) {
        effects.checkedFolders.add(folder);
        diagrams.push(...(effects.diagramCache.get(folder) ?? await checkFolderDiagrams(resolved.root, folder)));
      }
      const problems = diagramProblems(diagrams);
      if (problems.length) throw fail("diagram_problems", `The design of ${operation.slug} was not accepted: ${problems.join(" ")}`, { problems });
      // The person reads Changes as the plan, so a line Prism cannot read is refused here, while design can still fix it.
      const designOf = (slug) => readFile(path.join(resolved.root, sliceFolder(resolved.directory, slices, slug), "slice.md"), "utf8").catch(() => null);
      const designText = await designOf(operation.slug);
      // A slice of a split scope cites the Contract of the nearest ancestor design that has one.
      let contractText = designText;
      for (let parent = slices[operation.slug]?.parent, seen = new Set([operation.slug]); designText !== null && !contractClauses(contractText ?? "").length && parent && !seen.has(parent); parent = slices[parent]?.parent) {
        seen.add(parent);
        contractText = await designOf(parent);
      }
      const planned = designText === null ? { changes: [], problems: [] } : plannedChanges(designText, contractText ?? designText);
      const changeProblems = planned.problems;
      if (changeProblems.length) throw fail("validation_failed", `The design of ${operation.slug} was not accepted: ${changeProblems.join(" ")}`, { problems: changeProblems });
      checkBoundary(component, operation.slug, [...planned.changes.map((change) => change.path), ...frozenTests.map((test) => test.path)]);
      effects.diagrams.push(...diagrams);
      const acceptedAt = new Date().toISOString();
      // A new design answers the contract defects reported against the old one, and names the slice's component anew.
      delete slice.contractDefects;
      slice.component = component.component.identity;
      if (effects.dryRun) {
        slice.design = { acceptedAt, frozenTests, review, ...(staging ? { staged: true } : {}) };
        break;
      }
      effects.staged = effects.staged.filter((item) => item.slice !== operation.slug);
      if (!staging) {
        const baselineId = await captureBaseline(resolved.root, resolved.initiative, operation.slug);
        // A new design of a started slice keeps the content the slice started from, so the changes made before the revision still count.
        slice.design = { acceptedAt, frozenTests, review, ...(baselineId ? { baselineId } : {}), ...startOf(slice.design) };
      } else {
        effects.staged.push(await stageFrozenTests(resolved.root, operation.slug, frozenTests));
        slice.design = { acceptedAt, frozenTests, review, staged: true };
      }
      break;
    }
    case "restore_tests": {
      // A design revision needs the staged tests of the slices it revises in the work tree; accepting each design again stages them again.
      requireSlice(operation.slug);
      const leaves = Object.keys(slices).filter((key) => {
        for (let current = key; current !== null && current !== undefined; current = slices[current]?.parent) if (current === operation.slug) return true;
        return false;
      }).filter((key) => slices[key].design?.staged);
      if (!effects.dryRun) for (const key of leaves) effects.installed.push(...await installFrozenTests(resolved.root, resolved.initiative, key, slices[key].design.frozenTests));
      break;
    }
    case "report_contract_defects": {
      // An implementer that finds the contract wrong stops, and the slice waits for design with the defects on its record.
      const slice = requireSlice(operation.slug);
      if (!STARTED.has(slice.status) || !slice.design) throw fail("validation_failed", `Contract defects are reported for a started slice with an accepted design, and ${operation.slug} is ${slice.status}.`);
      const reportedAt = new Date().toISOString();
      slice.contractDefects = operation.defects.map((item) => ({ clause: item.clause, reason: item.reason, reportedAt }));
      slice.status = "blocked";
      endClaim(operation.slug, effects);
      break;
    }
    case "claim": {
      // Design claims its scope before it starts, and the claim ends when its proposal is accepted; a slice in progress is claimed for implementation,
      // so an agent whose claim lapsed takes the slice back unless another agent took it meanwhile.
      const slice = requireSlice(operation.slug);
      takeClaim(record, operation.slug, slice.status === "in-progress" ? "implementation" : "design", effects, operation);
      break;
    }
    case "release_claim": {
      // Anyone may end a claim, such as one whose holder stopped working, and the history keeps who released whose claim.
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
      // Design proposes its result itself, so Prism's refusals reach the designer while it can still fix them;
      // the proposal is checked on a copy of the record and waits for the orchestrator to accept it after the design gate.
      const scope = requireSlice(operation.slug);
      if (scope.status === "done") checkFixProposal(operation);
      const outside = proposalOutside(slices, operation.slug, operation.operations);
      if (outside.length) throw fail("validation_failed", `A design proposal changes only its scope ${operation.slug} and the slices inside it, not ${outside.join(", ")}.`);
      const trial = { slices: Object.assign(Object.create(null), structuredClone(slices)) };
      const accepted = new Set(operation.operations.filter((item) => item.op === "accept_design").map((item) => item.slug));
      const trialEffects = { staged: [], installed: [], refs: [], diagrams: [], checkedFolders: new Set(), diagramCache: effects.diagramCache, accepted, applied: [], dryRun: true, components: effects.components, proposal: operation.slug };
      for (const inner of operation.operations) await applyOperation(resolved, trial, inner, trialEffects);
      try {
        analyzeInitiative(trial.slices);
      } catch (error) {
        throw fail("invalid_initiative", `The design proposal of ${operation.slug} was not recorded: ${error.message}`, { errors: [error.message] });
      }
      await checkContractBudget(resolved, trial.slices, operation.operations);
      record.proposals[operation.slug] = { operations: structuredClone(operation.operations), proposedAt: new Date().toISOString(), ...(effects.actor ? { actor: effects.actor } : {}) };
      effects.diagrams.push(...trialEffects.diagrams);
      break;
    }
    case "accept_proposal": {
      const proposal = record.proposals[operation.slug];
      if (!proposal) throw fail("validation_failed", `The scope ${operation.slug} has no pending design proposal.`);
      const required = new Set(operation.reviewRequired);
      // The review setting at acceptance decides which marks count: all marks every design, recommended adds design's own recommendation.
      const policy = await reviewPolicy(resolved, effects);
      const marked = (inner) => policy === "all" || required.has(inner.slug) || (policy === "recommended" && inner.review === "required");
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
      // A defect found in done work is recorded on the done slice, which keeps its status, design, frozen tests, runs, and review.
      const slice = requireSlice(operation.slug);
      if (slice.status !== "done") throw fail("validation_failed", `A defect is reported on a done slice, and ${operation.slug} is ${slice.status}, so its work is fixed in place.`);
      const defects = slice.defects ?? [];
      const highest = defects.reduce((max, item) => Math.max(max, Number(DEFECT_ID.test(item?.id ?? "") ? item.id.slice(1) : 0)), 0);
      slice.defects = [...defects, { id: `d${highest + 1}`, requirements: normalizeRequirements(resolved, operation.requirements), summary: operation.summary, reportedAt: new Date().toISOString() }];
      break;
    }
    case "add_fix": {
      // A fix to done work is a new slice below the done slice, added only through that scope's design proposal.
      if (effects.proposal !== operation.slug) throw fail("validation_failed", "add_fix stands only inside the propose_design of the done scope that it names.");
      const fixed = requireSlice(operation.slug);
      if (fixed.status !== "done") throw fail("validation_failed", `add_fix fixes a done slice, and ${operation.slug} is ${fixed.status}.`);
      const fix = operation.fix;
      if (Object.hasOwn(slices, fix.slug)) throw fail("validation_failed", `The slice slug ${fix.slug} is already used in this initiative.`);
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

// A done scope takes one fix as its design: one add_fix naming the scope, the fix slice's dependencies and title or outcome, and the fix slice's accepted design.
function checkFixProposal(operation) {
  const refuse = (reason) => fail("validation_failed", `The design proposal of the done slice ${operation.slug} was not recorded: ${reason}`);
  const fixes = operation.operations.filter((item) => item.op === "add_fix");
  if (fixes.length !== 1 || fixes[0].slug !== operation.slug) throw refuse("a done slice is designed as exactly one add_fix that names it.");
  const fixSlug = fixes[0].fix.slug;
  const other = operation.operations.filter((item) => item.op !== "add_fix" && !(["set_dependencies", "update_slice", "accept_design"].includes(item.op) && item.slug === fixSlug));
  if (other.length) throw refuse(`it takes only set_dependencies, update_slice, and accept_design of the fix slice ${fixSlug}, not ${other.map((item) => `${item.op} of ${item.slug ?? item.parent}`).join(", ")}.`);
  if (operation.operations.filter((item) => item.op === "accept_design").length !== 1) throw refuse(`it takes exactly one accept_design of the fix slice ${fixSlug}.`);
}

// Coordination cleanup removes an initiative's records only after the roadmap keeps its superseded decision; a shipped initiative keeps them as history.
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

// Parsing diagrams takes about a second per folder, so it runs before the record lock, which other writers wait on only briefly.
// The folders come from the record as it is now plus this update's splits; a folder the record changes under it is checked again inside the lock.
async function precheckDiagrams(resolved, input) {
  const cache = new Map();
  if (!input.some((operation) => ["accept_design", "propose_design", "accept_proposal"].includes(operation.op))) return cache;
  const current = await loadRecord(resolved).catch(() => null);
  // A proposal's operations are checked when it is proposed and again when it is accepted.
  const operations = input.flatMap((operation) => operation.op === "propose_design" ? operation.operations : operation.op === "accept_proposal" ? current?.record?.proposals?.[operation.slug]?.operations ?? [] : [operation]);
  const accepted = operations.filter((operation) => operation.op === "accept_design").map((operation) => operation.slug);
  const parents = new Map(Object.entries(current?.record?.slices ?? {}).map(([key, slice]) => [key, slice?.parent ?? null]));
  for (const operation of operations) {
    if (operation.op === "create") parents.set(operation.slug, null);
    if (operation.op === "split") for (const child of operation.children) parents.set(child.slug, operation.parent);
    if (operation.op === "add_fix") parents.set(operation.fix.slug, operation.slug);
  }
  const folders = new Set();
  for (const slug of accepted) {
    for (let key = slug, depth = 0; key !== null && key !== undefined && depth < 100; key = parents.get(key), depth += 1) {
      folders.add(parents.has(key) && parents.get(key) === null ? resolved.directory : `${resolved.directory}/${key}`);
    }
  }
  for (const folder of folders) cache.set(folder, await checkFolderDiagrams(resolved.root, folder));
  return cache;
}

export async function updateInitiative(input) {
  validateInput(UPDATE_INITIATIVE_SCHEMA, input);
  // A shipped initiative's state is history, so every operation, remove_records included, is refused before the revision and claim checks.
  await refuseShipped(input.projectRoot, input.initiative);
  const result = input.operations.some(takesClaims) ? await claimingUpdate(input) : await finishUpdate(await writeInitiative(input));
  // An agent that claims a scope or starts a slice learns the settings it works under, including the ones the person set.
  if (result.removed || !input.operations.some((operation) => operation.op === "claim" || operation.op === "set_status")) return result;
  const state = await readCoordinationState({ projectRoot: input.projectRoot, initiative: input.initiative }).catch(() => null);
  return { ...result, settings: effectiveSettings(state?.valid ? state.state : null) };
}

// The initiative's review setting, read once per update when a design is accepted; an unset or unreadable setting keeps the marks as given.
async function reviewPolicy(resolved, effects) {
  if (effects.reviewPolicy === undefined) {
    const state = await readCoordinationState({ projectRoot: resolved.root, initiative: resolved.initiative }).catch(() => null);
    effects.reviewPolicy = effectiveSettings(state?.valid ? state.state : null).review;
  }
  return effects.reviewPolicy;
}

// An update that takes or releases a claim runs in two phases: its claim records first, confirmed with the store's remote, then the rest of the update.
const takesClaims = (operation) => operation.op === "claim" || operation.op === "release_claim" || (operation.op === "set_status" && operation.status === "in-progress");

async function claimContext(resolved, mode, label = null) {
  const { claims } = await readClaims(resolved);
  return { mode, holder: claimHolder(), label, now: Date.now(), files: claims, initial: new Map(claims), expired: [], released: [], releasedSlugs: new Set(), ended: new Set() };
}

// Claim records change one process at a time per initiative, so two local starts never both pass the check for overlapping claims.
async function withClaimsLock(resolved, action) {
  const folder = path.dirname((await locateRecord(resolved.root, { kind: "claim", initiative: resolved.initiative, slice: "x" })).target);
  await mkdir(path.dirname(folder), { recursive: true });
  return withArtifactLock(folder, () => withFileLock(folder, action, fail));
}

/**
 * Run an action while holding the locks under which an initiative's open work is written: its claims lock, its initiative record lock, and its coordination state lock, in that order.
 * Ship holds them while it reads open work and writes its decision, so a writer that adds a gate, a claim, or a proposal either lands before ship reads it or re-checks the decision after ship.
 * No path takes these locks while it holds the roadmap lock, so ship takes them before the roadmap lock.
 */
export async function withInitiativeWriteLocks(projectRoot, initiative, action) {
  if (!SLUG_PATTERN.test(initiative ?? "")) throw fail("invalid_path", "The initiative identifier must use letters, digits, hyphens, or underscores.");
  const resolved = { root: projectRoot, initiative };
  return withClaimsLock(resolved, () => withRecordLock(projectRoot, { kind: "initiative", initiative }, () => withRecordLock(projectRoot, { kind: "state", initiative }, action, fail), fail));
}

const claimKey = (resolved, slug) => ({ kind: "claim", initiative: resolved.initiative, slice: slug });

async function readClaim(resolved, slug) {
  const { bytes } = await readRecord(resolved.root, claimKey(resolved, slug), { maxBytes: 64 * 1024 });
  return bytes === null ? null : parseClaim(slug, bytes).claim ?? null;
}

// Every change to a claim record holds that record's own lock, the one the store's sync takes before it replaces the file, so a merge never overwrites a claim change it did not see.
// The claims lock is always taken first and one record lock at a time, so the sync, which takes only record locks, cannot deadlock with it.
// The action gets the record's current claim and returns the claim to write, null to remove the record, or undefined to leave it.
async function changeClaim(resolved, slug, decide) {
  return withRecordLock(resolved.root, claimKey(resolved, slug), async () => {
    const current = await readClaim(resolved, slug);
    const next = await decide(current);
    if (next === null) await removeRecord(resolved.root, claimKey(resolved, slug));
    else if (next !== undefined) await writeRecord(resolved.root, claimKey(resolved, slug), serializeClaim(next));
    return next;
  }, fail);
}

async function prepare(input) {
  const standalone = input.operations.find((operation) => STANDALONE.has(operation.op));
  if (standalone && input.operations.length > 1) throw fail("validation_failed", `${standalone.op} must be the only operation of its update.`);
  await moveLegacyRecords(input.projectRoot);
  if (standalone?.op === "remove_records") return { removed: await removeRecords(input) };
  const resolved = await resolveInitiative(input.projectRoot, input.initiative, true);
  const diagramCache = await precheckDiagrams(resolved, input.operations);
  await conservationStore.registerCoordinationOutputs(resolved.root, [resolved.projectionPath]);
  await mkdir(path.dirname(resolved.target), { recursive: true });
  return { resolved, diagramCache };
}

function checkRevision(current, input) {
  if (current.revision !== input.expectedRevision) {
    throw fail(input.expectedRevision === "null" ? "invalid_revision" : "revision_conflict", revisionMismatch("initiative record", input.expectedRevision, current.revision), { currentRevision: current.revision });
  }
  if (current.exists && !current.valid) {
    throw fail("invalid_initiative", "The existing initiative record is invalid and was not changed.", { errors: current.errors });
  }
}

const workingCopy = (current, resolved) => current.record
  ? { id: current.record.id, slices: Object.assign(Object.create(null), structuredClone(current.record.slices)), proposals: Object.assign(Object.create(null), structuredClone(current.record.proposals ?? {})), history: [...current.record.history] }
  : { id: resolved.initiative, slices: Object.create(null), proposals: Object.create(null), history: [] };

// Apply every operation to a working copy and check the result as a whole: graph analysis and the contract budget.
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

const newEffects = (input, diagramCache, claims, notes, dryRun) => ({ staged: [], installed: [], refs: [], diagrams: [], checkedFolders: new Set(), diagramCache, accepted: new Set(input.operations.filter((operation) => operation.op === "accept_design").map((operation) => operation.slug)), applied: [], actor: input.actor, claims, notes, dryRun });

// The initiative write: revision check, record lock, validation, history, and projection; the claims it ends are noted for removal after the write.
async function writeInitiative(input, plan = null) {
  const prepared = plan?.prepared ?? await prepare(input);
  if (prepared.removed) return { removed: prepared.removed };
  const { resolved, diagramCache } = prepared;
  const written = await withArtifactLock(resolved.target, () => withFileLock(resolved.target, async () => {
    // A ship that landed after the first check refuses the update too, so the record never changes after the initiative shipped.
    await refuseShipped(input.projectRoot, input.initiative);
    const current = await loadRecord(resolved);
    checkRevision(current, input);
    const record = workingCopy(current, resolved);
    const effects = newEffects(input, diagramCache, await claimContext(resolved, "apply"), plan?.notes ?? new Map(), false);
    await applyAll(resolved, record, input, effects);
    const at = new Date().toISOString();
    const actor = input.actor ?? "agent";
    // Taking a claim writes no history; replacing another holder's expired claim and releasing a claim do.
    const recorded = input.operations.filter((operation) => operation.op !== "regenerate_markdown" && (operation.op !== "claim" || effects.notes.has(operation)));
    for (const operation of recorded) record.history.push({ actor, operation: operation.op, ...(operation.slug ? { slug: operation.slug } : operation.parent ? { slug: operation.parent } : {}), at, ...effects.notes.get(operation) });
    const contents = serialize(record);
    const changed = recorded.length > 0 && (!current.exists || contents !== current.text);
    if (changed) await writeRecord(resolved.root, { kind: "initiative", initiative: resolved.initiative }, contents);
    // Staged tests leave the work tree only after the initiative record is written, and only for slices still staged at the end of the update.
    const withdrawn = [];
    for (const staged of effects.staged) if (record.slices[staged.slice]?.design?.staged) withdrawn.push(...await withdrawFrozenTests(resolved.root, resolved.initiative, staged));
    // The slices' local refs follow the written record, in the order the update set and dropped them.
    if (changed && effects.refs.length) {
      const { dropSliceRefs, setSliceRef } = await import("./slice-gate.mjs");
      for (const item of effects.refs) {
        if (item.drop) await dropSliceRefs(resolved.root, resolved.initiative, item.slice);
        else await setSliceRef(resolved.root, resolved.initiative, item.slice, "start", item.start);
      }
    }
    let projectionStale = false;
    try {
      projectionStale = !(await writeProjection(resolved.root, resolved.projectionTarget, markdown(canonicalRecord(record)), RECORD_NAME)).written;
    } catch {
      projectionStale = true;
    }
    const updated = await loadRecord(resolved);
    return { result: { ...publicResult(resolved, updated), created: !current.exists, previousRevision: current.revision, projectionStale, withdrawn, installed: effects.installed, diagrams: effects.diagrams }, ended: [...effects.claims.ended].map((slug) => effects.claims.files.get(slug)) };
  }, fail));
  return { ...written, resolved };
}

// After the initiative write, the claims the update ended are removed, unless another attempt replaced them meanwhile.
async function finishUpdate(written, plan = null) {
  if (written.removed) return written.removed;
  const { resolved } = written;
  const taken = new Set((plan?.writes ?? []).map((item) => item.slug));
  const ended = written.ended.filter((claim) => !taken.has(claim.slug));
  if (ended.length) {
    await withClaimsLock(resolved, async () => {
      for (const claim of ended) await changeClaim(resolved, claim.slug, (current) => current?.nonce === claim.nonce ? null : undefined);
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
    ...(view.fields.lostClaims ? { lostClaims: view.fields.lostClaims } : {})
  };
}

/**
 * An update that takes or releases claims. It is checked whole without writing anything, its claim records are written with a fresh nonce for each claim taken,
 * and where the store syncs it waits for a sync of its own and confirms that each record still holds this attempt's nonce, or is still absent for a release.
 * A refusal undoes only this attempt's claim records; otherwise the rest of the update is written with the caller's revision, and a failure there undoes the claims too.
 */
async function claimingUpdate(input) {
  const prepared = await prepare(input);
  const { resolved, diagramCache } = prepared;
  const store = await recordStoreOf(resolved.root);
  const label = await claimLabel(store.external ? store.base : store.root);
  const plan = await withClaimsLock(resolved, async () => {
    await refuseShipped(input.projectRoot, input.initiative);
    const current = await loadRecord(resolved);
    checkRevision(current, input);
    const record = workingCopy(current, resolved);
    const claims = await claimContext(resolved, "plan", label);
    const effects = newEffects(input, diagramCache, claims, new Map(), true);
    await applyAll(resolved, record, input, effects);
    const writes = [];
    const releases = [];
    for (const slug of new Set([...claims.initial.keys(), ...claims.files.keys()])) {
      const before = claims.initial.get(slug), after = claims.files.get(slug);
      if (after && after.nonce !== before?.nonce) writes.push({ slug, claim: after, previous: before ?? null });
      else if (!after && before && claims.releasedSlugs.has(slug)) releases.push({ slug, previous: before });
    }
    // A claim this process already holds keeps being renewed while the attempt that replaces it waits for confirmation.
    for (const item of writes) pendClaim(resolved.root, resolved.initiative, item.slug, item.claim.nonce);
    for (const item of writes) await changeClaim(resolved, item.slug, () => item.claim);
    for (const item of releases) await changeClaim(resolved, item.slug, () => null);
    const needsWrite = input.operations.some((operation) => operation.op !== "claim") || effects.notes.size > 0;
    return { prepared, slices: record.slices, writes, releases, expired: claims.expired, released: claims.released, notes: effects.notes, needsWrite, holder: claims.holder };
  });
  plan.confirmation = await confirmClaims(resolved, store, plan);
  if (!plan.needsWrite) {
    // A ship decision that arrived while the claims were written or synced withdraws them, so a shipped initiative keeps no new claim.
    try {
      await refuseShipped(input.projectRoot, input.initiative);
    } catch (error) {
      await undoClaims(resolved, plan);
      throw error;
    }
    const current = await loadRecord(resolved);
    return finishUpdate({ resolved, ended: [], result: { ...publicResult(resolved, current), created: false, previousRevision: current.revision, projectionStale: false, withdrawn: [], installed: [], diagrams: [] } }, plan);
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

/**
 * Confirm an update's claim records with the store's remote. Without sync, or where nothing else shares the store, they hold locally.
 * Otherwise the update waits for a sync of its own: another holder's record or an overlapping live claim that won refuses it with slice_claimed,
 * and a remote that cannot be reached refuses it with claim_unconfirmed; a refusal undoes only this attempt's claim records.
 */
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

// Undo an attempt's claim records: a claim record that still holds this attempt's nonce goes back to this holder's own earlier live claim or is removed,
// and a released claim whose record is still absent is put back.
async function undoClaims(resolved, plan) {
  await withClaimsLock(resolved, async () => {
    const now = Date.now();
    for (const item of plan.writes) {
      await changeClaim(resolved, item.slug, (current) => current?.nonce !== item.claim.nonce ? undefined : item.previous?.holder === plan.holder && isLive(item.previous, now) ? item.previous : null);
      settleClaim(resolved.root, resolved.initiative, item.slug, item.claim.nonce);
    }
    for (const item of plan.releases) await changeClaim(resolved, item.slug, async (current) => current === null && (await readRecord(resolved.root, claimKey(resolved, item.slug))).bytes === null ? item.previous : undefined);
  });
}

/** Renew one claim this process holds by rewriting only its claim record; returns { renewed } or { lost } with the reason. */
export async function renewClaim(entry) {
  const resolved = await resolveInitiative(entry.root, entry.initiative);
  return withClaimsLock(resolved, async () => {
    let decided;
    await changeClaim(resolved, entry.slug, (current) => {
      decided = renewal(entry, current);
      return decided.lost ? undefined : decided.claim;
    });
    return decided.lost ? decided : { renewed: decided.claim };
  });
}

// The slugs an update names, so its acknowledgement reports only what the caller touched.
function touchedSlugs(operations, slices) {
  const within = (scope) => Object.keys(slices).filter((key) => {
    for (let current = key, depth = 0; current !== null && current !== undefined && depth < 1000; current = slices[current]?.parent, depth += 1) if (current === scope) return true;
    return false;
  });
  return [...new Set(operations.flatMap((operation) => operation.op === "split" ? [operation.parent, ...operation.children.map((child) => child.slug)] : operation.op === "accept_proposal" ? within(operation.slug) : operation.slug ? [operation.slug] : []))];
}

/**
 * What an agent needs back from an update: the new revision and the state of the slices it touched, not the whole record,
 * which get_initiative reads when it is needed.
 */
export function initiativeAcknowledgement(result, operations) {
  if (result.removed) return result;
  const slices = result.record?.slices ?? {};
  const touched = Object.fromEntries(touchedSlugs(operations, slices).filter((key) => slices[key]).map((key) => [key, {
    status: slices[key].status,
    ...(slices[key].design ? { design: slices[key].design.staged ? "staged" : "accepted", frozenTests: slices[key].design.frozenTests.length, review: slices[key].design.review } : {}),
    ...(slices[key].splitEvidence ? { splitEvidence: slices[key].splitEvidence.kind } : {}),
    ...(result.record?.proposals?.[key] ? { proposal: "pending" } : {}),
    ...(slices[key].contractDefects ? { contractDefects: slices[key].contractDefects.length } : {}),
    ...(slices[key].defects?.length ? { defects: slices[key].defects.map((item) => item.id) } : {}),
    ...(slices[key].fixes ? { fixes: slices[key].fixes } : {}),
    // A new design answers the defects but does not restart the slice, because restarting takes an implementation claim.
    ...(slices[key].status === "blocked" && slices[key].design && !slices[key].contractDefects ? { next: "The design answers the contract defects, and the slice stays blocked until set_status in-progress restarts it." } : {}),
    ...(slices[key].claim ? { claim: { label: slices[key].claim.label, activity: slices[key].claim.activity, expiresAt: slices[key].claim.expiresAt } } : {})
  }]));
  const claims = result.claims ?? { taken: [], expired: [], released: [] };
  const unchecked = result.diagrams.filter((item) => !item.checked);
  return {
    initiative: result.initiative,
    revision: result.revision,
    previousRevision: result.previousRevision,
    ...(result.created ? { created: true } : {}),
    ...(result.valid ? {} : { valid: false, errors: result.errors }),
    slices: touched,
    ...(result.derived?.readyToShip ? { readyToShip: true } : {}),
    ...(result.withdrawn.length ? { stagedTests: result.withdrawn } : {}),
    ...(result.installed.length ? { installedTests: result.installed } : {}),
    ...(result.diagrams.length ? { diagrams: result.diagrams.filter((item) => item.checked).map(({ path: file, elements, relations }) => ({ path: file, elements, relations })) } : {}),
    ...(unchecked.length ? { diagramsUnchecked: unchecked.map((item) => `${item.path}: ${item.message}`) } : {}),
    ...(result.projectionStale ? { projectionStale: true } : {}),
    ...(claims.taken.length ? { claimConfirmation: claims.confirmation } : {}),
    ...(claims.expired.length ? { replacedClaims: claims.expired } : {}),
    ...(claims.released.length ? { releasedClaims: claims.released } : {}),
    ...(result.lostClaims ? { lostClaims: result.lostClaims } : {}),
    ...(result.settings ? { settings: result.settings } : {})
  };
}

export const INITIATIVE_TOOLS = [
  {
    name: "get_initiative",
    description: "Read an initiative's MCP-managed slice record with derived leaves, effective dependencies, completion, design candidates, fixes (each slice with fix slices mapped to their slugs), unfinishedFixes ({ slice, defect, fix, status } for each defect whose fix slice is missing, with fix null and status not-designed, or not done), deferredFindings (each slice whose review deferred findings, mapped to { id, severity, title, gate, followUp, wave } per deferred finding), and readiness to ship, which unfinished fixes hold false, plus run totals computed from run records for each slice, each split parent with its descendants, and the initiative, and each live claim: on its slice in the record view and under claims with its label, activity, and expiry, where heldHere marks this server's claims; lostClaims lists, once, claims this server held that expired or were released or taken over. Reads never create files. A shipped initiative, also one without a record, adds shippedHistory: { initiative, shippedAt, message, documents, changedAfterShip, laterFixes }, where documents lists the slice documents its ship decision recorded, changedAfterShip each one changed, removed, or added since, ignoring the history mark, and laterFixes each roadmap entry whose corrects names the initiative ({ initiative, title, state, slices }, in roadmap order); the first read of an initiative that shipped before its documents were recorded records them, writes the history mark into each, and lists them under marked, to commit apart from the task's changes.",
    inputSchema: GET_INITIATIVE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_initiative",
    description: "Apply revision-checked initiative operations: create the root slice, split a slice, set leaf status, set dependencies, update a slice title or outcome, accept a slice design with its frozen acceptance tests and review mark, or import a legacy map.puml. Design proposes its result with propose_design, whose split, set_dependencies, update_slice, and accept_design operations change only the scope and the slices inside it: Prism checks them on a copy of the record, refuses with the same errors as a direct update, and keeps the proposal pending without changing any slice; after the design gate, accept_proposal applies it with the slugs whose review is required and, for a user_gate split, the gate where the person approved it. Both operations stand alone in their update. A split whose every part takes accept_design in the same update is a contract's slice plan; any other split into parts needs evidence: contract_size names contract files whose estimated tokens exceed the contract budget, unfrozen quotes an Unprobed assumption from the scope's slice.md and names the part that settles it, and user_gate names a pending gate the person answered, which a proposed split names at accept_proposal. Accepting designs refuses a contract whose slice.md and frozen tests exceed that budget with contract_too_large, listing the measured files. Accepting the design of a slice that has not started stages its frozen tests: Prism keeps them and takes them out of the work tree, and set_status in-progress puts them back when the slice starts, while a started slice set back to not-started stages them again; restore_tests puts the staged tests of a slice and its descendants back for a design revision, and accepting each design again stages them again. report_contract_defects, which verify_slice sends for an implementer, blocks a started slice and keeps the defects on it until its next accepted design, which clears them but leaves the slice blocked until set_status in-progress restarts it. Accepting a design also checks the PlantUML files of the slice and the initiative overview and refuses one that does not parse or shows more than 30 elements, and refuses a slice.md Changes line that is not add, change, or remove followed by comma-separated paths in backticks and a colon with the note. accept_design takes the slice's component, bare or as <repository>/<component>, records it as <repository>/<component>, and may leave it out only in a repository that declares no components under ## Components in .prism/workflow.md, which records the root component; acceptance refuses an invalid declaration with component_invalid, component_overlap, component_dependency_unknown, or component_cycle, a component that is not this repository's with component_unknown, listing its components, and a slice whose Changes paths or frozen tests belong to another component and lie under no shared path with component_boundary, listing the paths. set_status in-progress refuses to start a not-started slice with dependencies_incomplete, naming them, until every slice it depends on directly or through an ancestor is done. Done transitions require a passing completion gate: a fresh passing verify_slice run for a slice with an accepted design, plus an accepted implementation review when that design requires review; verify_slice records done itself when no review is marked. A slice has at most one holder, the host session that claimed it, or the Prism server process when the host names no session, across every checkout and machine that shares the records: set_status in-progress takes an implementation claim, claim takes a design claim on a scope before design starts, or an implementation claim on a slice that is in-progress, such as after the caller's claim lapsed, and a claim covers the slice's descendants. An agent's call that works on a slice, namely propose_design, accept_proposal, restore_tests, report_contract_defects, set_status moving a slice out of in-progress, verify_slice except a dependents' run, update_review, update_change_map, and update_design_view, is refused with claim_required before it changes anything unless a live claim of the caller is on the slice or an ancestor, saying whether its own claim expired; an operation may work on a slice that an earlier operation of the same update claims or starts. Any other change to a slice is refused with slice_claimed while another holder's live claim covers it. Taking a claim is refused with slice_claimed, naming the holder's label, activity, and expiry, while another holder's live claim covers the slice, an ancestor, or a descendant; an expired claim is replaced and the result names it under replacedClaims. An update that takes or releases claims is checked whole, writes its claims first, and where store sync is on waits for a sync before anything else is written: another machine's claim or renewal that won refuses it with slice_claimed, and an unreachable remote refuses it with claim_unconfirmed; a refused update applies none of its operations. The holding server renews its live claims every 10 minutes, a server the host restarts in the same session renews them after its first read or update of the initiative, a claim expires 30 minutes after its last renewal, and an expired claim is never renewed. A claim ends when its slice leaves in-progress, when the scope's proposal is accepted, or through release_claim, which anyone may send and which the history records. A defect in done work is fixed as new work: report_defect ({ slug, requirements, summary }) records a defect d<n> on a done slice and refuses any other slice with validation_failed; claim takes a design claim on a done slice; propose_design on a done scope takes exactly one add_fix ({ slug, defects, fix: { slug, title, outcome, requirements } }) naming that scope, set_dependencies and update_slice on the fix slug, and one accept_design of the fix slug, refusing with validation_failed any other operation, a defect the scope does not hold or another fix slice names, and a used slug, while add_fix outside propose_design refuses too; accept_proposal adds the fix as a not-started slice below the done slice, with fixes { slice, defects }, whose slice.md sits in its own folder, and leaves the done slice's records unchanged. A fix slice is a leaf of the done slice's ancestors, cannot split, starts after the dependencies of the done slice and its ancestors, and holds the dependents of the done slice until it is done. set_status changing a done slice to another status refuses with slice_done. Every write validates the whole slice graph and regenerates initiative.md. The result acknowledges the new revision and the touched slices; get_initiative reads the whole record. A shipped initiative's state is history: every operation on it, remove_records included, is refused with initiative_shipped, naming the initiative and its ship time, before every check except argument validation, and changes no record, while a roadmap record that cannot be read or parsed refuses it with invalid_roadmap; start new work on it as a new initiative. After the roadmap records the initiative as superseded, remove_records alone deletes the initiative's coordination records during cleanup and keeps its run entries.",
    inputSchema: UPDATE_INITIATIVE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];
