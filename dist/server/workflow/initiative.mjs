import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertInput } from "./artifact-schema.mjs";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { analyzeInitiative, LEAF_STATUSES, parseLegacyMap, SLUG_PATTERN } from "./initiative-graph.mjs";
import { initiativeDirectory, readWorkflowConfig } from "./workflow-config.mjs";
import { resolveArtifactPath } from "../conservation/concept-delta.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { generatedNotice, writeProjection } from "./projection.mjs";

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

export const GET_INITIATIVE_SCHEMA = object({ projectRoot: text, initiative: slug }, ["projectRoot", "initiative"]);
export const UPDATE_INITIATIVE_SCHEMA = object({
  projectRoot: text,
  initiative: slug,
  expectedRevision: { oneOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
  actor: text,
  operations: { type: "array", minItems: 1, maxItems: 50, items: { oneOf: [
    object({ op: { const: "create" }, slug, title: text, outcome: text, requirements: strings }, ["op", "slug", "title", "requirements"]),
    object({ op: { const: "split" }, parent: slug, children: { type: "array", minItems: 1, maxItems: 50, items: childSchema } }),
    object({ op: { const: "set_status" }, slug, status: { enum: LEAF_STATUSES } }),
    object({ op: { const: "set_dependencies" }, slug, dependencies: { type: "array", maxItems: 200, items: slug } }),
    object({ op: { const: "update_slice" }, slug, title: text, outcome: text }, ["op", "slug"]),
    object({ op: { const: "import_map" }, path: text }),
    object({ op: { const: "regenerate_markdown" } })
  ] } }
}, ["projectRoot", "initiative", "expectedRevision", "operations"]);

function validateInput(schema, input) {
  try {
    assertInput(schema, input);
  } catch (error) {
    throw fail("validation_failed", "The initiative arguments are invalid.", { errors: error.errors });
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
  const record = await resolveArtifactPath(projectRoot, `${directory}/${RECORD_NAME}`, createParent, RECORD_NAME);
  const projection = await resolveArtifactPath(projectRoot, `${directory}/${PROJECTION_NAME}`, false, PROJECTION_NAME);
  return { root: record.root, initiative, directory, recordPath: record.deltaPath, target: record.target, projectionPath: projection.deltaPath, projectionTarget: projection.target };
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
      requirements: [...slice.requirements].sort(),
      dependencies: [...slice.dependencies].sort()
    };
  }
  return { schemaVersion: 1, id: record.id, slices, history: record.history.slice(-HISTORY_LIMIT) };
}

function serialize(record) {
  return `${JSON.stringify(canonicalRecord(record), null, 2)}\n`;
}

function validateRecord(raw, initiative) {
  const errors = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: ["The initiative record must be a JSON object."] };
  }
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (raw.id !== initiative) errors.push(`id must equal the initiative folder name ${initiative}.`);
  if (!Array.isArray(raw.history)) errors.push("history must be an array.");
  let analysis = null;
  try {
    analysis = analyzeInitiative(raw.slices);
  } catch (error) {
    errors.push(error.message);
  }
  return { errors, analysis };
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
  let raw;
  try {
    raw = JSON.parse(contents.toString("utf8"));
  } catch {
    return { exists: true, revision, record: null, valid: false, errors: ["The initiative record must contain valid JSON."], analysis: null };
  }
  const { errors, analysis } = validateRecord(raw, resolved.initiative);
  return { exists: true, revision, record: raw, valid: errors.length === 0, errors, analysis };
}

function derived(analysis) {
  if (!analysis) return null;
  const { slices, ...rest } = analysis;
  return { ...rest, readyToShip: analysis.complete[analysis.root] === true };
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
    derived: derived(loaded.analysis)
  };
}

export async function readInitiative(projectRoot, initiative) {
  const resolved = await resolveInitiative(projectRoot, initiative);
  return { resolved, loaded: await loadRecord(resolved) };
}

export async function getInitiative(input) {
  validateInput(GET_INITIATIVE_SCHEMA, input);
  const { resolved, loaded } = await readInitiative(input.projectRoot, input.initiative);
  return publicResult(resolved, loaded);
}

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
    for (const child of analysis.children[slugValue]) visit(child, depth + 1);
  };
  visit(analysis.root, 0);
  return `${lines.join("\n")}\n`;
}

async function sliceOutcome(resolved, slugValue) {
  try {
    const source = await readFile(path.join(resolved.root, resolved.directory, slugValue, "slice.md"), "utf8");
    const section = source.split(/^## Outcome\s*$/m)[1]?.split(/^#{1,2} /m)[0] ?? "";
    const sentence = section.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return sentence || undefined;
  } catch {
    return undefined;
  }
}

async function completionGate(resolved, slugValue) {
  const { checkReviewGate } = await import("../review/review-ledger.mjs");
  const reviewPath = `${resolved.directory}/${slugValue}/review.json`;
  try {
    return await checkReviewGate({ projectRoot: resolved.root, reviewPath, gate: "completion" });
  } catch (error) {
    return { ready: false, problems: [{ code: error.code ?? "evidence_missing", message: error.message }] };
  }
}

async function applyOperation(resolved, record, operation) {
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
      slices[operation.slug] = { title: operation.title, ...(operation.outcome ? { outcome: operation.outcome } : {}), status: "not-started", parent: null, requirements: [...operation.requirements], dependencies: [] };
      break;
    case "import_map": {
      const source = await readFile((await resolveArtifactPath(resolved.root, operation.path, false, path.posix.basename(operation.path))).target, "utf8");
      const imported = parseLegacyMap(source);
      if (imported.id !== resolved.initiative) throw fail("validation_failed", `The map names initiative ${imported.id}, not ${resolved.initiative}.`);
      for (const [key, slice] of Object.entries(imported.slices)) {
        const outcome = await sliceOutcome(resolved, key);
        slices[key] = { ...slice, ...(outcome ? { outcome } : {}) };
      }
      break;
    }
    case "split": {
      const parent = requireSlice(operation.parent);
      if (parent.status === "split") throw fail("validation_failed", "The parent is already split.");
      if (parent.status === "done") throw fail("validation_failed", "A done slice cannot split.");
      for (const child of operation.children) {
        if (Object.hasOwn(slices, child.slug)) throw fail("validation_failed", `The slice slug ${child.slug} is already used in this initiative.`);
        slices[child.slug] = { title: child.title, ...(child.outcome ? { outcome: child.outcome } : {}), status: "not-started", parent: operation.parent, requirements: [...child.requirements], dependencies: [] };
      }
      parent.status = "split";
      break;
    }
    case "set_status": {
      const slice = requireSlice(operation.slug);
      if (slice.status === "split") throw fail("validation_failed", "A split parent keeps the split status permanently.");
      if (operation.status === "done" && slice.status !== "done") {
        const gate = await completionGate(resolved, operation.slug);
        if (!gate.ready) throw fail("gate_blocked", "The slice has no passing completion gate.", { problems: gate.problems });
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
    case "regenerate_markdown":
      break;
    default:
      throw fail("validation_failed", `Unsupported operation ${operation.op}.`);
  }
}

export async function updateInitiative(input) {
  validateInput(UPDATE_INITIATIVE_SCHEMA, input);
  const resolved = await resolveInitiative(input.projectRoot, input.initiative, true);
  await conservationStore.registerCoordinationOutputs(resolved.root, [resolved.recordPath, resolved.projectionPath]);
  return withArtifactLock(resolved.target, () => withFileLock(resolved.target, async () => {
    const current = await loadRecord(resolved);
    if (current.revision !== input.expectedRevision) {
      throw fail("revision_conflict", "The initiative record changed since it was read. Read it again and retry with its current revision.", { currentRevision: current.revision });
    }
    if (current.exists && !current.valid) {
      throw fail("invalid_initiative", "The existing initiative record is invalid and was not changed.", { errors: current.errors });
    }
    const record = current.record
      ? { id: current.record.id, slices: Object.assign(Object.create(null), structuredClone(current.record.slices)), history: [...current.record.history] }
      : { id: resolved.initiative, slices: Object.create(null), history: [] };
    for (const operation of input.operations) {
      await applyOperation(resolved, record, operation);
    }
    try {
      analyzeInitiative(record.slices);
    } catch (error) {
      throw fail("invalid_initiative", `The proposed initiative record is invalid and was not written: ${error.message}`, { errors: [error.message] });
    }
    const at = new Date().toISOString();
    const actor = input.actor ?? "agent";
    const mutating = input.operations.filter((operation) => operation.op !== "regenerate_markdown");
    for (const operation of mutating) record.history.push({ actor, operation: operation.op, ...(operation.slug ? { slug: operation.slug } : operation.parent ? { slug: operation.parent } : {}), at });
    const contents = serialize(record);
    const changed = mutating.length > 0 && (!current.exists || contents !== (await readFile(resolved.target, "utf8").catch(() => null)));
    if (changed) await conservationStore.writeManaged(resolved.root, resolved.target, contents);
    let projectionStale = false;
    try {
      projectionStale = !(await writeProjection(resolved.root, resolved.projectionTarget, markdown(canonicalRecord(record)), RECORD_NAME)).written;
    } catch {
      projectionStale = true;
    }
    const updated = await loadRecord(resolved);
    return { ...publicResult(resolved, updated), created: !current.exists, previousRevision: current.revision, projectionStale };
  }, fail));
}

export const INITIATIVE_TOOLS = [
  {
    name: "get_initiative",
    description: "Read an initiative's MCP-managed slice record with derived leaves, effective dependencies, completion, design candidates, and readiness to ship. Reads never create files.",
    inputSchema: GET_INITIATIVE_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_initiative",
    description: "Apply revision-checked initiative operations: create the root slice, split a slice, set leaf status, set dependencies, update a slice title or outcome, or import a legacy map.puml. Done transitions require a passing completion gate, and every write validates the whole slice graph and regenerates initiative.md.",
    inputSchema: UPDATE_INITIATIVE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];
