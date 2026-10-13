import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertInput } from "./artifact-schema.mjs";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { readInitiative } from "./initiative.mjs";
import { generatedNotice, writeProjection } from "./projection.mjs";
import { readCoordinationState } from "./state.mjs";
import { initiativeDirectory, readWorkflowConfig, roadmapPaths } from "./workflow-config.mjs";
import { resolveArtifactPath } from "../conservation/concept-delta.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";

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

export const GET_ROADMAP_SCHEMA = object({ projectRoot: text }, ["projectRoot"]);
export const UPDATE_ROADMAP_SCHEMA = object({
  projectRoot: text,
  expectedRevision: { oneOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
  actor: text,
  operations: { type: "array", minItems: 1, maxItems: 100, items: { oneOf: [
    object({ op: { const: "set_serves" }, serves: text }),
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
    throw fail("validation_failed", "The roadmap arguments are invalid.", { errors: error.errors });
  }
}

async function resolveRoadmap(projectRoot, createParent = false) {
  const config = await readWorkflowConfig(projectRoot);
  const paths = roadmapPaths(config);
  if (!paths) throw fail("invalid_config", "The workflow config disables the roadmap path.");
  const record = await resolveArtifactPath(projectRoot, paths.record, createParent, path.posix.basename(paths.record));
  const projection = await resolveArtifactPath(projectRoot, paths.projection, false, path.posix.basename(paths.projection));
  return { root: record.root, config, recordPath: record.deltaPath, target: record.target, projectionPath: projection.deltaPath, projectionTarget: projection.target, recordName: path.posix.basename(paths.record) };
}

function emptyRoadmap() {
  return { schemaVersion: 1, serves: "", initiatives: [], openQuestions: [], history: [] };
}

function validateRoadmap(raw) {
  const errors = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return ["The roadmap record must be a JSON object."];
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (typeof raw.serves !== "string") errors.push("serves must be a string.");
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

// Progress states come from the initiative record and coordination state; only shipped and superseded are recorded decisions.
export async function deriveInitiative(projectRoot, config, item) {
  const base = { id: item.id, band: item.band, state: "envisioned", readyToShip: false, progress: null, active: [], diagnostics: [] };
  if (item.decision?.kind === "shipped") return { ...base, band: "Shipped", state: "shipped" };
  if (item.decision?.kind === "superseded") return { ...base, state: "superseded", supersededBy: item.decision.by };
  let initiative;
  try {
    initiative = await readInitiative(projectRoot, item.id);
  } catch (error) {
    return { ...base, diagnostics: [{ code: error.code ?? "initiative_unreadable", message: error.message }] };
  }
  const { loaded } = initiative;
  if (!loaded.exists) return base;
  if (!loaded.valid) return { ...base, state: "planned", diagnostics: loaded.errors.map((message) => ({ code: "invalid_initiative", message })) };
  const analysis = loaded.analysis;
  const progress = { leaves: analysis.leaves.length, ...analysis.counts };
  let active = [];
  const directory = initiativeDirectory(config, item.id);
  try {
    const state = await readCoordinationState({ projectRoot, statePath: `${directory}/state.json` });
    active = state.state?.active ?? [];
  } catch (error) {
    base.diagnostics.push({ code: error.code ?? "state_unreadable", message: error.message });
  }
  const started = analysis.leaves.some((slug) => analysis.slices[slug].status !== "not-started") || active.length > 0;
  return { ...base, state: started ? "in-progress" : "planned", readyToShip: analysis.complete[analysis.root] === true, progress, active, root: analysis.root };
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

export async function getRoadmap(input) {
  validateInput(GET_ROADMAP_SCHEMA, input);
  const { resolved, loaded, derived } = await readRoadmap(input.projectRoot);
  return publicResult(resolved, loaded, derived);
}

function markdown(record, recordName) {
  const lines = ["# Roadmap", "", generatedNotice(recordName), "Current progress is derived from initiative records, so read it through `get_roadmap` or the review browser.", ""];
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

async function applyOperation(resolved, record, operation, actor, at) {
  switch (operation.op) {
    case "set_serves":
      record.serves = operation.serves;
      break;
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
      const derived = await deriveInitiative(resolved.root, resolved.config, item);
      if (!derived.readyToShip) throw fail("gate_blocked", "Every leaf slice in the initiative record must be done before the initiative ships.", { state: derived.state, progress: derived.progress, diagnostics: derived.diagnostics });
      item.decision = { kind: "shipped", at, actor };
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
  const resolved = await resolveRoadmap(input.projectRoot, true);
  const managed = [resolved.recordPath, resolved.projectionPath].filter((file) => ["roadmap.json", "roadmap.md"].includes(path.posix.basename(file)));
  if (managed.length) await conservationStore.registerCoordinationOutputs(resolved.root, managed);
  return withArtifactLock(resolved.target, () => withFileLock(resolved.target, async () => {
    const current = await loadRoadmap(resolved);
    if (current.revision !== input.expectedRevision) {
      throw fail("revision_conflict", "The roadmap changed since it was read. Read it again and retry with its current revision.", { currentRevision: current.revision });
    }
    if (current.exists && !current.valid) throw fail("invalid_roadmap", "The existing roadmap record is invalid and was not changed.", { errors: current.errors });
    const record = current.record ? structuredClone(current.record) : emptyRoadmap();
    const at = new Date().toISOString();
    const actor = input.actor ?? "agent";
    for (const operation of input.operations) await applyOperation(resolved, record, operation, actor, at);
    const errors = validateRoadmap(record);
    if (errors.length) throw fail("invalid_roadmap", `The proposed roadmap is invalid and was not written: ${errors[0]}`, { errors });
    const mutating = input.operations.filter((operation) => !["regenerate_markdown", "replace_hand_written_projection"].includes(operation.op));
    for (const operation of mutating) record.history.push({ actor, operation: operation.op, ...(operation.id ? { id: operation.id } : {}), at });
    record.history = record.history.slice(-HISTORY_LIMIT);
    const contents = `${JSON.stringify(record, null, 2)}\n`;
    if (mutating.length && contents !== (await readFile(resolved.target, "utf8").catch(() => null))) {
      await conservationStore.writeManaged(resolved.root, resolved.target, contents);
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
    const { loaded, derived } = await readRoadmap(input.projectRoot);
    return { ...publicResult(resolved, loaded, derived), created: !current.exists, previousRevision: current.revision, projectionStale };
  }, fail));
}

export const ROADMAP_TOOLS = [
  {
    name: "get_roadmap",
    description: "Read the MCP-managed roadmap record with each initiative's derived lifecycle state, band, slice progress, active work, and readiness to ship. Reads never create files.",
    inputSchema: GET_ROADMAP_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_roadmap",
    description: "Apply revision-checked roadmap operations: set what the roadmap serves, add or update initiatives, place them in Now, Next, Later, or Parked, set required initiatives, record ship or supersede decisions, and set open questions. Ship requires every leaf slice to be done, and every write regenerates the roadmap Markdown without overwriting a hand-written file.",
    inputSchema: UPDATE_ROADMAP_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];
