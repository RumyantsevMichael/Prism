import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertInput, describeErrors } from "./artifact-schema.mjs";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { fitScopes, normalizeRequirementReference, readInitiative, scopeDependents, withInitiativeWriteLocks } from "./initiative.mjs";
import { generatedNotice, writeProjection } from "./projection.mjs";
import { readCoordinationState } from "./state.mjs";
import { readWorkflowConfig, roadmapPaths } from "./workflow-config.mjs";
import { resolveArtifactPath } from "../conservation/change-map.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { revisionMismatch } from "./revision.mjs";
import { locateRecord, moveLegacyRecords, readRecord, writeRecord } from "./record-store.mjs";
import { mergeHistory, mergeKeyed, mergeOrder, mergeScalars, MergeConflict, parseVersions } from "./record-merge.mjs";
import { ComponentError, listComponents, listsComponents, readComponents } from "./components.mjs";
import { latestDependentsRun } from "./slice-design.mjs";
import { proposeComponents } from "./workspace-manifests.mjs";
import { documentDigests, entryShippedDecision, hasOpenWork, openWork, openWorkMessage, readSliceDocuments, recordEarlierShips, ShippedHistoryError, writeHistoryMarks } from "./shipped-history.mjs";

export const BANDS = Object.freeze(["Now", "Next", "Later", "Parked"]);
export const DISPLAY_BANDS = Object.freeze([...BANDS, "Shipped"]);
const RECORD_MAX_BYTES = 1024 * 1024;
const HISTORY_LIMIT = 500;

export class RoadmapError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RoadmapError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code, message, details) => new RoadmapError(code, message, details);
const text = { type: "string", minLength: 1, maxLength: 4000 };
const id = { type: "string", minLength: 1, maxLength: 120 };
const ids = { type: "array", maxItems: 200, items: id };
const references = { type: "array", maxItems: 200, items: text };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const band = { enum: BANDS };
const position = { type: "integer", minimum: 0, maximum: 10000 };

// A workspace name is a short label for people, so it stays on one line; an empty name clears it.
export const WORKSPACE_NAME_MAX = 64;

function workspaceNameProblem(value) {
  if (typeof value !== "string") return "workspaceName must be a string.";
  if (value !== value.trim() || !value) return "workspaceName must be non-empty and have no leading or trailing spaces.";
  if (value.length > WORKSPACE_NAME_MAX) return `workspaceName must have at most ${WORKSPACE_NAME_MAX} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return "workspaceName must be one line without control characters.";
  return null;
}

export const GET_ROADMAP_SCHEMA = object({ projectRoot: text }, ["projectRoot"]);
export const UPDATE_ROADMAP_SCHEMA = object({
  projectRoot: text,
  expectedRevision: { oneOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
  actor: text,
  operations: { type: "array", minItems: 1, maxItems: 100, items: { oneOf: [
    object({ op: { const: "set_serves" }, serves: text }),
    object({ op: { const: "set_workspace_name" }, name: { type: "string", maxLength: WORKSPACE_NAME_MAX } }, ["op", "name"]),
    object({ op: { const: "add_initiative" }, id, title: text, intent: text, pillar: text, band, position, requirements: references, requires: ids, rationale: text }, ["op", "id", "title", "intent", "band"]),
    object({ op: { const: "update_initiative" }, id, title: text, intent: text, pillar: text, requirements: references, rationale: text }, ["op", "id"]),
    object({ op: { const: "place" }, id, band, position }, ["op", "id", "band"]),
    object({ op: { const: "set_requires" }, id, requires: ids }),
    object({ op: { const: "ship" }, id }),
    object({ op: { const: "supersede" }, id, by: id, reason: text }),
    object({ op: { const: "set_open_questions" }, questions: { type: "array", maxItems: 100, items: text } }),
    object({ op: { const: "replace_hand_written_projection" } }),
    object({ op: { const: "regenerate_markdown" } })
  ] } }
}, ["projectRoot", "expectedRevision", "operations"]);

function validateInput(schema, input) {
  try {
    assertInput(schema, input);
  } catch (error) {
    throw fail("validation_failed", `The roadmap arguments are invalid: ${describeErrors(error.errors)}`, { errors: error.errors });
  }
}

async function resolveRoadmap(projectRoot, createParent = false) {
  const config = await readWorkflowConfig(projectRoot);
  const paths = roadmapPaths(config);
  if (!paths) throw fail("invalid_config", "The workflow config disables the roadmap path.");
  const record = await locateRecord(projectRoot, { kind: "roadmap" });
  const projection = await resolveArtifactPath(projectRoot, paths.projection, createParent, path.posix.basename(paths.projection));
  return { root: record.root, config, recordPath: record.path, target: record.target, projectionPath: projection.deltaPath, projectionTarget: projection.target, recordName: path.posix.basename(paths.record) };
}

function emptyRoadmap() {
  return { schemaVersion: 1, serves: "", initiatives: [], openQuestions: [], history: [] };
}

function validateRoadmap(raw) {
  const errors = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return ["The roadmap record must be a JSON object."];
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (typeof raw.serves !== "string") errors.push("serves must be a string.");
  if (raw.workspaceName !== undefined && workspaceNameProblem(raw.workspaceName)) errors.push(workspaceNameProblem(raw.workspaceName));
  if (!Array.isArray(raw.openQuestions) || raw.openQuestions.some((item) => typeof item !== "string")) errors.push("openQuestions must be an array of strings.");
  if (!Array.isArray(raw.history)) errors.push("history must be an array.");
  if (!Array.isArray(raw.initiatives)) return [...errors, "initiatives must be an array."];
  const known = new Set();
  for (const [index, item] of raw.initiatives.entries()) {
    const field = `initiatives[${index}]`;
    if (!item || typeof item !== "object") { errors.push(`${field} must be an object.`); continue; }
    if (typeof item.id !== "string" || !SLUG_PATTERN.test(item.id)) errors.push(`${field}.id must use letters, digits, hyphens, or underscores.`);
    else if (known.has(item.id)) errors.push(`${field}.id duplicates ${item.id}.`);
    known.add(item.id);
    if (typeof item.title !== "string" || !item.title.trim()) errors.push(`${field}.title must be a non-empty string.`);
    if (typeof item.intent !== "string" || !item.intent.trim()) errors.push(`${field}.intent must be a non-empty string.`);
    if (!BANDS.includes(item.band)) errors.push(`${field}.band must be one of ${BANDS.join(", ")}.`);
    for (const key of ["requirements", "requires"]) if (!Array.isArray(item[key]) || item[key].some((value) => typeof value !== "string")) errors.push(`${field}.${key} must be an array of strings.`);
    if (item.decision !== null && !["shipped", "superseded"].includes(item.decision?.kind)) errors.push(`${field}.decision must be null, shipped, or superseded.`);
    else if (item.decision?.kind === "shipped") errors.push(...shippedDocumentErrors(item.decision, `${field}.decision`));
  }
  for (const item of raw.initiatives) {
    for (const target of item.requires ?? []) {
      if (target === item.id) errors.push(`${item.id} cannot require itself.`);
      else if (!known.has(target)) errors.push(`${item.id} requires unknown initiative ${target}.`);
    }
    if (item.decision?.kind === "superseded" && !known.has(item.decision.by)) errors.push(`${item.id} is superseded by unknown initiative ${item.decision.by}.`);
  }
  if (errors.length === 0) {
    const graph = new Map(raw.initiatives.map((item) => [item.id, item.requires]));
    const visiting = new Set();
    const done = new Set();
    const visit = (node) => {
      if (done.has(node)) return;
      if (visiting.has(node)) throw fail("invalid_roadmap", `Initiative requirements form a cycle through ${node}.`);
      visiting.add(node);
      graph.get(node).forEach(visit);
      visiting.delete(node);
      done.add(node);
    };
    try { graph.forEach((_, node) => visit(node)); } catch (error) { errors.push(error.message); }
  }
  return errors;
}

// A shipped decision records its slice documents once: documents with each path and SHA-256, when they were recorded, and whether at ship or at a first read.
function shippedDocumentErrors(decision, field) {
  const errors = [];
  if (decision.documents !== undefined && (!Array.isArray(decision.documents) || decision.documents.some((item) => typeof item?.path !== "string" || !/^[0-9a-f]{64}$/.test(item?.sha256 ?? "")))) errors.push(`${field}.documents must be an array of { path, sha256 }.`);
  if (decision.documentsRecordedAt !== undefined && typeof decision.documentsRecordedAt !== "string") errors.push(`${field}.documentsRecordedAt must be a string.`);
  if (decision.documentsFrom !== undefined && !["ship", "first-read"].includes(decision.documentsFrom)) errors.push(`${field}.documentsFrom must be ship or first-read.`);
  return errors;
}

function serializeRoadmap(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Merge three versions of the roadmap record by structure for store sync: each initiative entry by id, their order, open questions, and each scalar.
 * Returns { contents } with the canonical bytes of a valid merged record, or { conflict } when a unit changed differently on both sides or the result is invalid.
 */
export function mergeRoadmapRecord(versions) {
  try {
    const { base, local, upstream } = parseVersions(versions, emptyRoadmap);
    if ([base, local, upstream].some((record) => !record || typeof record !== "object" || Array.isArray(record) || !Array.isArray(record.initiatives) || !Array.isArray(record.history))) throw new MergeConflict("A version of the roadmap record has no initiatives or history list.");
    const byId = (record) => Object.fromEntries(record.initiatives.map((item) => [item?.id, item]));
    const ids = (record) => record.initiatives.map((item) => item?.id);
    const entries = mergeKeyed("Initiative", byId(base), byId(local), byId(upstream));
    const order = mergeOrder("The initiative order", ids(base), ids(local), ids(upstream), new Set(Object.keys(entries)));
    // The open questions are one unit, like a scalar, and the merged record keeps the upstream's key order, as a tool write would.
    const scalars = mergeScalars(base, local, upstream, ["initiatives", "history"]);
    const merged = {};
    for (const key of new Set([...Object.keys(upstream), ...Object.keys(local), ...Object.keys(base)])) {
      if (key === "initiatives") merged.initiatives = order.map((id) => entries[id]);
      else if (key === "history") merged.history = mergeHistory(base.history, local.history, upstream.history, HISTORY_LIMIT);
      else if (Object.hasOwn(scalars, key)) merged[key] = scalars[key];
    }
    const errors = validateRoadmap(merged);
    if (errors.length) return { conflict: `The merged roadmap record is invalid: ${errors[0]}` };
    const contents = serializeRoadmap(merged);
    if (Buffer.byteLength(contents) > RECORD_MAX_BYTES) return { conflict: "The merged roadmap record exceeds 1 MiB." };
    return { contents };
  } catch (error) {
    return { conflict: error instanceof MergeConflict ? error.message : `The roadmap record versions could not be merged: ${error.message}` };
  }
}

async function loadRoadmap(resolved) {
  let contents;
  try {
    contents = await readFile(resolved.target);
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, revision: null, record: null, valid: true, errors: [] };
    throw error;
  }
  if (contents.length > RECORD_MAX_BYTES) throw fail("artifact_too_large", "The roadmap record exceeds 1 MiB.");
  const revision = createHash("sha256").update(contents).digest("hex");
  let raw;
  try {
    raw = JSON.parse(contents.toString("utf8"));
  } catch {
    return { exists: true, revision, record: null, valid: false, errors: ["The roadmap record must contain valid JSON."] };
  }
  const errors = validateRoadmap(raw);
  return { exists: true, revision, record: raw, valid: errors.length === 0, errors };
}

/**
 * What keeps a finished initiative from shipping by its components: { problem } with the refusal of an invalid ## Components declaration,
 * or { scopes }, each fit scope { scope, blocked, reason } whose dependents by the current declaration have no passing run of every one of them,
 * where reason is failed when the latest dependents' run failed or declined one of them and not_run otherwise, and blocked names those dependents in run order.
 * A leaf without a component, or with one the repository no longer declares, adds no dependents, so a repository that declares no components ships as before.
 */
export async function dependentsBlockers(projectRoot, config, initiative, record) {
  let declaration;
  try {
    declaration = readComponents(config);
  } catch (error) {
    if (error instanceof ComponentError) return { problem: error, scopes: [] };
    throw error;
  }
  const scopes = [];
  for (const scope of fitScopes(record)) {
    const dependents = scopeDependents(record, scope, declaration).map((component) => component.identity);
    if (!dependents.length) continue;
    const latest = await latestDependentsRun(projectRoot, initiative, scope).catch(() => null);
    // A dependent passed when the latest run ran it and did not block it; one the run blocked failed, and one it never ran has not run.
    const ran = new Set((Array.isArray(latest?.entry?.components) ? latest.entry.components : []).map((component) => component?.name));
    const red = new Set(Array.isArray(latest?.entry?.blocked) ? latest.entry.blocked : []);
    const blocked = dependents.filter((name) => !ran.has(name) || red.has(name));
    if (!blocked.length) continue;
    const reason = blocked.some((name) => ran.has(name) && red.has(name)) ? "failed" : "not_run";
    scopes.push({ scope, blocked, reason });
  }
  return { scopes };
}

const dependentsMessage = (scopes) => `The initiative cannot ship while the dependents of a finished scope are red or have not run: ${scopes.map((item) => `${item.scope} (${item.reason === "failed" ? "failed or declined" : "not run"}: ${item.blocked.join(", ")})`).join("; ")}. Run verify_slice with dependents for each scope, and fix or allow what it reports.`;

// Open work refuses ship before any leaf check, so it is reported whether or not the leaves are done or the initiative record is readable.
async function withOpenWork(projectRoot, item, result, options = {}) {
  const work = await openWork(projectRoot, item.id, options).catch(() => null);
  if (!work || !hasOpenWork(work)) return null;
  const { derived } = result;
  const diagnostic = { code: "open_work", message: openWorkMessage(item.id, work), ...work };
  return { derived: { ...derived, readyToShip: false, diagnostics: [...derived.diagnostics, diagnostic] }, blocker: derived.readyToShip ? { open: work } : result.blocker };
}

// The facts of an initiative and what keeps it from shipping: blocker is null, { leaves: true } while a leaf is not done, { open } for open work, { problem } for an invalid declaration, or { scopes } for blocked dependents.
async function deriveItem(projectRoot, config, item) {
  const base = { id: item.id, band: item.band, state: "envisioned", readyToShip: false, progress: null, active: [], diagnostics: [] };
  const leaves = { leaves: true };
  if (item.decision?.kind === "shipped") return { derived: { ...base, band: "Shipped", state: "shipped" }, blocker: null };
  if (item.decision?.kind === "superseded") return { derived: { ...base, state: "superseded", supersededBy: item.decision.by }, blocker: leaves };
  let initiative;
  try {
    initiative = await readInitiative(projectRoot, item.id);
  } catch (error) {
    const result = { derived: { ...base, diagnostics: [{ code: error.code ?? "initiative_unreadable", message: error.message }] }, blocker: leaves };
    return await withOpenWork(projectRoot, item, result) ?? result;
  }
  const { loaded } = initiative;
  if (!loaded.exists) {
    const result = { derived: base, blocker: leaves };
    return await withOpenWork(projectRoot, item, result) ?? result;
  }
  if (!loaded.valid) {
    const result = { derived: { ...base, state: "planned", diagnostics: loaded.errors.map((message) => ({ code: "invalid_initiative", message })) }, blocker: leaves };
    return await withOpenWork(projectRoot, item, result) ?? result;
  }
  const analysis = loaded.analysis;
  const progress = { leaves: analysis.leaves.length, ...analysis.counts };
  let active = [];
  let state;
  try {
    state = await readCoordinationState({ projectRoot, initiative: item.id });
    active = state.state?.active ?? [];
  } catch (error) {
    base.diagnostics.push({ code: error.code ?? "state_unreadable", message: error.message });
  }
  const started = analysis.leaves.some((slug) => analysis.slices[slug].status !== "not-started") || active.length > 0;
  const derived = { ...base, state: started ? "in-progress" : "planned", readyToShip: analysis.complete[analysis.root] === true, progress, active, root: analysis.root };
  if (state) {
    const open = await withOpenWork(projectRoot, item, { derived, blocker: leaves }, { record: loaded.record, state });
    if (open) return open;
  }
  if (!derived.readyToShip) return { derived, blocker: leaves };
  // A finished initiative is ready to ship only once ship would succeed: its declaration is valid and every finished scope's dependents passed.
  const found = await dependentsBlockers(projectRoot, config, item.id, loaded.record);
  if (found.problem) return { derived: { ...derived, readyToShip: false, diagnostics: [...derived.diagnostics, { code: found.problem.code, message: found.problem.message }] }, blocker: { problem: found.problem } };
  if (found.scopes.length) return { derived: { ...derived, readyToShip: false, diagnostics: [...derived.diagnostics, { code: "dependents_blocked", message: dependentsMessage(found.scopes), scopes: found.scopes }] }, blocker: { scopes: found.scopes } };
  return { derived, blocker: null };
}

// Progress states come from the initiative record and coordination state; only shipped and superseded are recorded decisions.
export async function deriveInitiative(projectRoot, config, item) {
  return (await deriveItem(projectRoot, config, item)).derived;
}

function publicResult(resolved, loaded, derivedItems = null) {
  return {
    recordPath: resolved.recordPath,
    projectionPath: resolved.projectionPath,
    exists: loaded.exists,
    revision: loaded.revision,
    valid: loaded.valid,
    errors: loaded.errors,
    record: loaded.record,
    ...(derivedItems ? { derived: derivedItems } : {})
  };
}

export async function readRoadmap(projectRoot) {
  const resolved = await resolveRoadmap(projectRoot);
  const loaded = await loadRoadmap(resolved);
  const derivedItems = loaded.valid && loaded.record
    ? await Promise.all(loaded.record.initiatives.map((item) => deriveInitiative(resolved.root, resolved.config, item)))
    : [];
  return { resolved, loaded, derived: derivedItems };
}

/**
 * The repository's components as get_roadmap reports them, never refusing an invalid declaration: { repository, declared, problem?, proposal? },
 * where proposal is a ## Components block built from the workspace manifests when the configuration lists no component, which Prism never writes.
 */
export async function roadmapComponents(projectRoot, config) {
  const listed = listComponents(config);
  if (listsComponents(config)) return listed;
  const proposed = await proposeComponents(projectRoot, { rootName: listed.repository ?? "root" });
  if (proposed === null) return listed;
  // The proposed block is checked as the declaration it would become, in place of whatever ## Components holds now.
  const block = proposed.markdown.split("\n").slice(1, -1);
  let problem;
  try {
    readComponents({ ...config, lines: { ...config?.lines, Components: block } });
  } catch (error) {
    if (!(error instanceof ComponentError)) throw error;
    problem = { code: error.code, message: error.message };
  }
  return { ...listed, proposal: { ...proposed, ...(problem ? { problem } : {}) } };
}

/** The workspace name kept in the roadmap record of the project's record store, or null when none is set or the record cannot be read. */
export async function readWorkspaceName(projectRoot) {
  try {
    const { bytes } = await readRecord(projectRoot, { kind: "roadmap" });
    if (!bytes) return null;
    const name = JSON.parse(bytes.toString("utf8"))?.workspaceName;
    return typeof name === "string" && !workspaceNameProblem(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * Read the roadmap; a shipped entry whose decision has no recorded slice documents has them recorded and marked by this read,
 * and markedHistory lists { initiative, marked } for each entry whose documents it marked.
 */
export async function getRoadmap(input) {
  validateInput(GET_ROADMAP_SCHEMA, input);
  let { resolved, loaded, derived } = await readRoadmap(input.projectRoot);
  const recorded = loaded.valid && loaded.record ? await recordEarlierShips(resolved.root, loaded.record.initiatives) : [];
  if (recorded.length) ({ resolved, loaded, derived } = await readRoadmap(input.projectRoot));
  const markedHistory = recorded.filter((item) => item.marked.length);
  return { ...publicResult(resolved, loaded, derived), components: await roadmapComponents(resolved.root, resolved.config), ...(markedHistory.length ? { markedHistory } : {}) };
}

function markdown(record, recordName) {
  const lines = ["# Roadmap", "", generatedNotice(recordName), "Current progress is derived from initiative records, so read it through `get_roadmap` or the review browser.", ""];
  if (record.workspaceName) lines.push(`Workspace: ${record.workspaceName}`, "");
  if (record.serves) lines.push(`Serves: ${record.serves}`, "");
  const titles = new Map(record.initiatives.map((item) => [item.id, item.title]));
  const entry = (item) => {
    const parts = [`- **${item.title}** (\`${item.id}\`): ${item.intent}`];
    if (item.requires.length) parts.push(`Requires ${item.requires.map((target) => `\`${target}\``).join(", ")}.`);
    return parts.join(" ");
  };
  lines.push("## Initiative index", "");
  const open = record.initiatives.filter((item) => !item.decision);
  for (const name of BANDS) {
    const members = open.filter((item) => item.band === name);
    if (members.length) lines.push(`### ${name}`, "", ...members.map(entry), "");
  }
  const shipped = record.initiatives.filter((item) => item.decision?.kind === "shipped");
  if (shipped.length) lines.push("### Shipped", "", ...shipped.map((item) => `${entry(item)} Shipped ${item.decision.at.slice(0, 10)}.`), "");
  const rationale = open.filter((item) => item.rationale && item.band !== "Parked");
  lines.push("## Sequencing rationale", "", ...(rationale.length ? rationale.map((item) => `- **${item.title}**: ${item.rationale}`) : ["No sequencing rationale is recorded."]), "");
  const parked = open.filter((item) => item.band === "Parked");
  if (parked.length) lines.push("## Parked context", "", ...parked.map((item) => `- **${item.title}**: ${item.rationale ?? "No reason is recorded."}`), "");
  const superseded = record.initiatives.filter((item) => item.decision?.kind === "superseded");
  if (superseded.length) lines.push("## Superseded context", "", ...superseded.map((item) => `- **${item.title}** was superseded by **${titles.get(item.decision.by)}**: ${item.decision.reason}`), "");
  lines.push("## Open questions", "", ...(record.openQuestions.length ? record.openQuestions.map((question) => `- ${question}`) : ["No open questions are recorded."]), "");
  lines.push("## Lifecycle", "", "`envisioned`, `planned`, and `in-progress` are derived from initiative records and coordination state.", "`shipped` and `superseded` are recorded decisions.", "");
  return `${lines.join("\n")}`;
}

function findInitiative(record, value) {
  const item = record.initiatives.find((candidate) => candidate.id === value);
  if (!item) throw fail("validation_failed", `The roadmap has no initiative ${value}.`);
  return item;
}

function insertInBand(record, item, targetBand, positionValue) {
  record.initiatives = record.initiatives.filter((candidate) => candidate !== item);
  item.band = targetBand;
  const members = record.initiatives.filter((candidate) => candidate.band === targetBand && !candidate.decision);
  const anchor = positionValue === undefined || positionValue >= members.length ? null : members[positionValue];
  const index = anchor ? record.initiatives.indexOf(anchor) : (() => {
    const last = members.at(-1);
    return last ? record.initiatives.indexOf(last) + 1 : record.initiatives.length;
  })();
  record.initiatives.splice(index, 0, item);
}

// Only references an operation adds or changes are checked, so a roadmap written before this check still loads and updates.
function roadmapRequirements(resolved, references) {
  return references.map((reference) => {
    const normalized = normalizeRequirementReference(resolved.config.paths.requirements, reference);
    if (normalized.problem) throw fail("validation_failed", normalized.problem);
    return normalized.reference;
  });
}

async function applyOperation(resolved, record, operation, actor, at, marks) {
  // A shipped entry keeps its content as history, so a change to it is refused before its arguments are normalized.
  if (operation.op === "update_initiative" || operation.op === "set_requires") {
    const shipped = entryShippedDecision(record.initiatives.find((candidate) => candidate.id === operation.id));
    if (shipped) throw new ShippedHistoryError(operation.id, shipped.at);
  }
  if (operation.requirements !== undefined && (operation.op === "add_initiative" || operation.op === "update_initiative")) operation = { ...operation, requirements: roadmapRequirements(resolved, operation.requirements) };
  switch (operation.op) {
    case "set_serves":
      record.serves = operation.serves;
      break;
    case "set_workspace_name": {
      const name = operation.name.trim().replace(/\s+/g, " ");
      if (!name) {
        delete record.workspaceName;
        break;
      }
      const problem = workspaceNameProblem(name);
      if (problem) throw fail("validation_failed", problem.replace("workspaceName", "The workspace name"));
      record.workspaceName = name;
      break;
    }
    case "add_initiative": {
      if (!SLUG_PATTERN.test(operation.id)) throw fail("validation_failed", "Initiative identifiers use letters, digits, hyphens, or underscores.");
      if (record.initiatives.some((item) => item.id === operation.id)) throw fail("validation_failed", `The roadmap already has initiative ${operation.id}.`);
      const item = { id: operation.id, title: operation.title, intent: operation.intent, ...(operation.pillar ? { pillar: operation.pillar } : {}), band: operation.band, requirements: operation.requirements ?? [], requires: operation.requires ?? [], ...(operation.rationale ? { rationale: operation.rationale } : {}), decision: null };
      insertInBand(record, item, operation.band, operation.position);
      break;
    }
    case "update_initiative": {
      const item = findInitiative(record, operation.id);
      for (const key of ["title", "intent", "pillar", "requirements", "rationale"]) if (operation[key] !== undefined) item[key] = operation[key];
      break;
    }
    case "place": {
      const item = findInitiative(record, operation.id);
      if (item.decision) throw fail("validation_failed", "A shipped or superseded initiative keeps its place in history.");
      insertInBand(record, item, operation.band, operation.position);
      break;
    }
    case "set_requires":
      findInitiative(record, operation.id).requires = [...operation.requires];
      break;
    case "ship": {
      const item = findInitiative(record, operation.id);
      if (item.decision) throw fail("validation_failed", `Initiative ${item.id} already has a ${item.decision.kind} decision.`);
      // Work still open when an initiative ships could never be finished, because its state is then history.
      const work = await openWork(resolved.root, item.id);
      if (hasOpenWork(work)) throw fail("open_work", openWorkMessage(item.id, work), work);
      const { derived, blocker } = await deriveItem(resolved.root, resolved.config, item);
      if (blocker?.open) throw fail("open_work", openWorkMessage(item.id, blocker.open), blocker.open);
      if (blocker?.leaves) throw fail("gate_blocked", "Every leaf slice in the initiative record must be done before the initiative ships.", { state: derived.state, progress: derived.progress, diagnostics: derived.diagnostics });
      // Shipping reads the components after the leaf check: an invalid declaration refuses with its own code and fields, and a red or unproven dependent blocks it.
      if (blocker?.problem) throw blocker.problem;
      if (blocker?.scopes) throw fail("dependents_blocked", dependentsMessage(blocker.scopes), { scopes: blocker.scopes });
      // Ship records each slice document's content without the mark; the marks are written once the record is.
      const { documents, problems } = await readSliceDocuments(resolved.root, item.id);
      item.decision = { kind: "shipped", at, actor, documents: documentDigests(documents), documentsRecordedAt: at, documentsFrom: "ship" };
      marks.push({ initiative: item.id, decision: item.decision, documents, problems });
      break;
    }
    case "supersede": {
      const item = findInitiative(record, operation.id);
      if (item.decision) throw fail("validation_failed", `Initiative ${item.id} already has a ${item.decision.kind} decision.`);
      if (operation.by === operation.id) throw fail("validation_failed", "An initiative cannot supersede itself.");
      findInitiative(record, operation.by);
      item.decision = { kind: "superseded", by: operation.by, reason: operation.reason, at, actor };
      break;
    }
    case "set_open_questions":
      record.openQuestions = [...operation.questions];
      break;
    case "replace_hand_written_projection":
    case "regenerate_markdown":
      break;
    default:
      throw fail("validation_failed", `Unsupported operation ${operation.op}.`);
  }
}

export async function updateRoadmap(input) {
  validateInput(UPDATE_ROADMAP_SCHEMA, input);
  await moveLegacyRecords(input.projectRoot);
  const resolved = await resolveRoadmap(input.projectRoot, true);
  const managed = [resolved.projectionPath].filter((file) => path.posix.basename(file) === "roadmap.md");
  if (managed.length) await conservationStore.registerCoordinationOutputs(resolved.root, managed);
  await mkdir(path.dirname(resolved.target), { recursive: true });
  // A ship holds the write locks of each initiative it ships, in id order and before the roadmap lock, from its open-work read until its decision is written,
  // so a gate, claim, or proposal added meanwhile is either seen as open work or refused by its writer's re-check under the same lock.
  const shipping = [...new Set(input.operations.filter((operation) => operation.op === "ship" && SLUG_PATTERN.test(operation.id ?? "")).map((operation) => operation.id))].sort();
  const holdShipLocks = (index, action) => index === shipping.length ? action() : withInitiativeWriteLocks(resolved.root, shipping[index], () => holdShipLocks(index + 1, action));
  return holdShipLocks(0, () => withArtifactLock(resolved.target, () => withFileLock(resolved.target, async () => {
    const current = await loadRoadmap(resolved);
    if (current.revision !== input.expectedRevision) {
      throw fail(input.expectedRevision === "null" ? "invalid_revision" : "revision_conflict", revisionMismatch("roadmap record", input.expectedRevision, current.revision), { currentRevision: current.revision });
    }
    if (current.exists && !current.valid) throw fail("invalid_roadmap", "The existing roadmap record is invalid and was not changed.", { errors: current.errors });
    const record = current.record ? structuredClone(current.record) : emptyRoadmap();
    const at = new Date().toISOString();
    const actor = input.actor ?? "agent";
    const marks = [];
    for (const operation of input.operations) await applyOperation(resolved, record, operation, actor, at, marks);
    const errors = validateRoadmap(record);
    if (errors.length) throw fail("invalid_roadmap", `The proposed roadmap is invalid and was not written: ${errors[0]}`, { errors });
    const mutating = input.operations.filter((operation) => !["regenerate_markdown", "replace_hand_written_projection"].includes(operation.op));
    for (const operation of mutating) record.history.push({ actor, operation: operation.op, ...(operation.id ? { id: operation.id } : {}), at });
    record.history = record.history.slice(-HISTORY_LIMIT);
    const contents = serializeRoadmap(record);
    if (mutating.length && contents !== (await readFile(resolved.target, "utf8").catch(() => null))) {
      await writeRecord(resolved.root, { kind: "roadmap" }, contents);
    }
    const projection = markdown(record, resolved.recordName);
    let projectionStale = false;
    try {
      if (input.operations.some((operation) => operation.op === "replace_hand_written_projection")) {
        await conservationStore.writeManaged(resolved.root, resolved.projectionTarget, projection);
      } else {
        projectionStale = !(await writeProjection(resolved.root, resolved.projectionTarget, projection, resolved.recordName)).written;
      }
    } catch {
      projectionStale = true;
    }
    const history = await markShipped(resolved.root, marks);
    const { loaded, derived } = await readRoadmap(input.projectRoot);
    return { ...publicResult(resolved, loaded, derived), created: !current.exists, previousRevision: current.revision, projectionStale, ...history };
  }, fail)));
}

// After a ship is written, each slice document it recorded takes the history mark; one it could not read or write is a problem, never a refusal.
async function markShipped(root, marks) {
  if (!marks.length) return {};
  const historyMarks = [];
  const historyMarkProblems = [];
  for (const { initiative, decision, documents, problems } of marks) {
    const written = await writeHistoryMarks(root, initiative, decision, documents);
    historyMarks.push(...written.marked);
    historyMarkProblems.push(...problems, ...written.problems);
  }
  historyMarkProblems.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { historyMarks: historyMarks.sort(), historyMarkProblems };
}

export const ROADMAP_TOOLS = [
  {
    name: "get_roadmap",
    description: "Read the MCP-managed roadmap record with each initiative's derived lifecycle state, band, slice progress, active work, and readiness to ship, and the repository's components: its repository name, the declared components by identity <repository>/<component> with their folder, test command, and dependencies, the declaration's problem when it is invalid, and, when the configuration lists no component and a root workspace manifest (package.json, pnpm-workspace.yaml, Cargo.toml, or go.work) gives workspace patterns, a proposal of a ## Components block with its components, shared paths, skipped manifests, and problem. Reads never create files, and the proposal is never written; offer it to the person to commit. The one exception is a shipped entry whose decision has not recorded its slice documents: the read records them with documentsFrom first-read, writes the history mark into each, and lists them under markedHistory ({ initiative, marked }) to commit apart from the task's changes.",
    inputSchema: GET_ROADMAP_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_roadmap",
    description: "Apply revision-checked roadmap operations: set what the roadmap serves, set the workspace name that every checkout sharing the record store shows (one line of at most 64 characters, an empty name clears it), add or update initiatives, place them in Now, Next, Later, or Parked, set required initiatives, record ship or supersede decisions, and set open questions. A shipped initiative's entry keeps its title, intent, requirements, and required initiatives: update_initiative and set_requires naming it refuse with initiative_shipped, with its initiative and shippedAt. Ship refuses an existing decision with validation_failed, then refuses with open_work, listing gates ({ id, slice, question, answered }), claims ({ slice, label, activity, expiresAt }), and proposals (scope slugs), while the initiative has a pending user gate, answered or not, a live slice claim, or a pending design proposal. Ship then requires every leaf slice to be done, refusing with gate_blocked first; it then reads the ## Components declaration, refusing an invalid one with its own code, and refuses with dependents_blocked, listing each scope with its blocked dependents and reason failed or not_run, while a finished scope has dependents without a passing dependents' run of every one of them; readyToShip in get_roadmap is true only when ship would succeed, with a diagnostic saying why otherwise. Ship records each slice document of the initiative in its decision as documents ({ path, sha256 } of its content without the history mark), with documentsRecordedAt and documentsFrom ship, writes the history mark into each, and lists the marked paths under historyMarks and each document it could not read or write under historyMarkProblems ({ path, reason }) without failing. Every write regenerates the roadmap Markdown without overwriting a hand-written file.",
    inputSchema: UPDATE_ROADMAP_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];
