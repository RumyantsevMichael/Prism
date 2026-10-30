import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertInput, describeErrors } from "./artifact-schema.mjs";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { analyzeInitiative, LEAF_STATUSES, parseLegacyMap, SLUG_PATTERN } from "./initiative-graph.mjs";
import { initiativeDirectory, readWorkflowConfig } from "./workflow-config.mjs";
import { resolveArtifactPath } from "../conservation/change-map.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { generatedNotice, writeProjection } from "./projection.mjs";
import { revisionMismatch } from "./revision.mjs";
import { locateRecord, removeInitiativeRecords, writeRecord } from "./record-store.mjs";
import { CONTRACT_TOKEN_BUDGET, designProblems, digestFrozenTests, installFrozenTests, measureContract, REVIEW_MARKS, stageFrozenTests, withdrawFrozenTests } from "./slice-design.mjs";
import { readCoordinationState } from "./state.mjs";
import { checkFolderDiagrams, diagramProblems } from "./diagram-check.mjs";

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
const acceptDesignOperation = object({ op: { const: "accept_design" }, slug, frozenTests: { type: "array", minItems: 1, maxItems: 200, items: text }, review: { enum: REVIEW_MARKS } });
const STANDALONE = new Set(["remove_records", "propose_design", "accept_proposal"]);

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
    object({ op: { const: "propose_design" }, slug, operations: { type: "array", minItems: 1, maxItems: 50, items: { oneOf: [splitOperation, dependenciesOperation, updateSliceOperation, acceptDesignOperation] } } }),
    object({ op: { const: "accept_proposal" }, slug, reviewRequired: { type: "array", maxItems: 200, items: slug }, gate: text }, ["op", "slug", "reviewRequired"]),
    object({ op: { const: "restore_tests" }, slug }),
    object({ op: { const: "report_contract_defects" }, slug, defects: { type: "array", minItems: 1, maxItems: 50, items: object({ clause: text, reason: text }) } }),
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
      requirements: [...slice.requirements].sort(),
      dependencies: [...slice.dependencies].sort(),
      ...(slice.design ? { design: { acceptedAt: slice.design.acceptedAt, frozenTests: [...slice.design.frozenTests].sort((left, right) => left.path.localeCompare(right.path)), review: slice.design.review, ...(slice.design.baselineId ? { baselineId: slice.design.baselineId } : {}), ...(slice.design.staged ? { staged: true } : {}) } } : {}),
      ...(slice.splitEvidence ? { splitEvidence: slice.splitEvidence } : {}),
      ...(slice.contractDefects ? { contractDefects: slice.contractDefects } : {})
    };
  }
  const proposals = Object.fromEntries(Object.keys(record.proposals ?? {}).sort().map((key) => [key, record.proposals[key]]));
  return { schemaVersion: 1, id: record.id, slices, ...(Object.keys(proposals).length ? { proposals } : {}), history: record.history.slice(-HISTORY_LIMIT) };
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
  for (const [key, slice] of Object.entries(raw.slices ?? {})) {
    for (const problem of designProblems(slice?.design)) errors.push(`${key}: ${problem}`);
    if (slice?.contractDefects !== undefined && (!Array.isArray(slice.contractDefects) || slice.contractDefects.some((item) => typeof item?.clause !== "string" || typeof item?.reason !== "string"))) errors.push(`${key}: contractDefects must list { clause, reason } entries.`);
    if (slice?.splitEvidence !== undefined && (slice.status !== "split" || !SPLIT_EVIDENCE_KINDS.includes(slice.splitEvidence?.kind))) errors.push(`${key}: splitEvidence belongs to a split slice and names its kind.`);
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
    const design = record.slices[slugValue].design;
    if (design) lines.push(`${indent}  - Design accepted ${design.acceptedAt.slice(0, 10)}: ${design.frozenTests.length} frozen test files${design.staged ? " staged until the slice starts" : ""}, review ${design.review === "required" ? "required" : "not required"}`);
    for (const child of analysis.children[slugValue]) visit(child, depth + 1);
  };
  visit(analysis.root, 0);
  return `${lines.join("\n")}\n`;
}

// Requirement files cite obligations as <file>.md§<n>, so that form is accepted and stored as <requirements dir>/<file>.md#<n>.
function normalizeRequirements(resolved, references) {
  return references.map((reference) => {
    const cited = /^([^\s/#§]+\.md)§([^\s#§]+)$/.exec(reference);
    if (cited && resolved.requirementsDirectory) return `${resolved.requirementsDirectory}/${cited[1]}#${cited[2]}`;
    if (!/^[^\s#]+#[^\s#]+$/.test(reference)) {
      throw fail("validation_failed", `Invalid requirement reference ${JSON.stringify(reference)}: use <requirements path>.md#<number>, such as ${resolved.requirementsDirectory ?? "docs/requirements"}/capability.md#1, or <file>.md§<number>.`);
    }
    return reference;
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
  const created = new Set(operations.filter((item) => item.op === "split").flatMap((item) => item.children.map((child) => child.slug)));
  const inside = (key) => {
    if (created.has(key)) return true;
    for (let current = key, depth = 0; current !== null && current !== undefined && depth < 1000; current = slices[current]?.parent, depth += 1) if (current === scope) return true;
    return false;
  };
  return [...new Set(operations.flatMap((item) => item.op === "split" ? (item.parent === scope ? [] : [item.parent]) : inside(item.slug) ? [] : [item.slug]))];
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
      for (const child of operation.children) {
        if (Object.hasOwn(slices, child.slug)) throw fail("validation_failed", `The slice slug ${child.slug} is already used in this initiative.`);
        slices[child.slug] = { title: child.title, ...(child.outcome ? { outcome: child.outcome } : {}), status: "not-started", parent: operation.parent, requirements: normalizeRequirements(resolved, child.requirements), dependencies: [] };
      }
      // A split whose every part takes its design in the same update is a contract's slice plan; any other split needs evidence.
      const evidence = operation.children.every((child) => effects.accepted.has(child.slug)) ? null : await splitEvidence(resolved, slices, operation, effects);
      parent.status = "split";
      delete parent.design;
      if (evidence) parent.splitEvidence = evidence;
      break;
    }
    case "set_status": {
      const slice = requireSlice(operation.slug);
      if (slice.status === "split") throw fail("validation_failed", "A split parent keeps the split status permanently.");
      if (operation.status === "in-progress" && slice.design?.staged) {
        // Tests staged earlier in the same update are still in the work tree, so only earlier updates' tests need installing.
        if (!effects.staged.some((item) => item.slice === operation.slug)) effects.installed.push(...await installFrozenTests(resolved.root, resolved.initiative, operation.slug, slice.design.frozenTests));
        const baselineId = await captureBaseline(resolved.root, resolved.initiative, operation.slug);
        delete slice.design.staged;
        if (baselineId) slice.design.baselineId = baselineId;
        else delete slice.design.baselineId;
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
      effects.diagrams.push(...diagrams);
      const acceptedAt = new Date().toISOString();
      // A new design answers the contract defects reported against the old one.
      delete slice.contractDefects;
      if (effects.dryRun) {
        slice.design = { acceptedAt, frozenTests, review: operation.review, ...(staging ? { staged: true } : {}) };
        break;
      }
      effects.staged = effects.staged.filter((item) => item.slice !== operation.slug);
      if (!staging) {
        const baselineId = await captureBaseline(resolved.root, resolved.initiative, operation.slug);
        slice.design = { acceptedAt, frozenTests, review: operation.review, ...(baselineId ? { baselineId } : {}) };
      } else {
        effects.staged.push(await stageFrozenTests(resolved.root, operation.slug, frozenTests));
        slice.design = { acceptedAt, frozenTests, review: operation.review, staged: true };
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
      for (const key of leaves) effects.installed.push(...await installFrozenTests(resolved.root, resolved.initiative, key, slices[key].design.frozenTests));
      break;
    }
    case "report_contract_defects": {
      // An implementer that finds the contract wrong stops, and the slice waits for design with the defects on its record.
      const slice = requireSlice(operation.slug);
      if (!STARTED.has(slice.status) || !slice.design) throw fail("validation_failed", `Contract defects are reported for a started slice with an accepted design, and ${operation.slug} is ${slice.status}.`);
      const reportedAt = new Date().toISOString();
      slice.contractDefects = operation.defects.map((item) => ({ clause: item.clause, reason: item.reason, reportedAt }));
      slice.status = "blocked";
      break;
    }
    case "propose_design": {
      // Design proposes its result itself, so Prism's refusals reach the designer while it can still fix them;
      // the proposal is checked on a copy of the record and waits for the orchestrator to accept it after the design gate.
      const scope = requireSlice(operation.slug);
      if (scope.status === "done") throw fail("validation_failed", "A done slice cannot take a new design.");
      const outside = proposalOutside(slices, operation.slug, operation.operations);
      if (outside.length) throw fail("validation_failed", `A design proposal changes only its scope ${operation.slug} and the slices inside it, not ${outside.join(", ")}.`);
      const trial = { slices: Object.assign(Object.create(null), structuredClone(slices)) };
      const accepted = new Set(operation.operations.filter((item) => item.op === "accept_design").map((item) => item.slug));
      const trialEffects = { staged: [], installed: [], diagrams: [], checkedFolders: new Set(), diagramCache: effects.diagramCache, accepted, applied: [], dryRun: true };
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
      const replay = proposal.operations.map((inner) => inner.op === "accept_design" ? { ...inner, review: required.has(inner.slug) ? "required" : "none" } : inner);
      const unmarked = [...required].filter((key) => !replay.some((inner) => inner.op === "accept_design" && inner.slug === key));
      if (unmarked.length) throw fail("validation_failed", `${unmarked.join(", ")} takes no design in this proposal, so it cannot be marked for review.`);
      for (const inner of replay) if (inner.op === "accept_design") effects.accepted.add(inner.slug);
      effects.gate = operation.gate;
      for (const inner of replay) {
        await applyOperation(resolved, record, inner, effects);
        effects.applied.push(inner);
      }
      delete record.proposals[operation.slug];
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

// Coordination cleanup removes an initiative's records only after the roadmap keeps its shipped or superseded decision.
async function removeRecords(input) {
  const { readRoadmap } = await import("./roadmap.mjs");
  const resolved = await resolveInitiative(input.projectRoot, input.initiative);
  const current = await loadRecord(resolved);
  if (current.revision !== input.expectedRevision) {
    throw fail("revision_conflict", revisionMismatch("initiative record", input.expectedRevision, current.revision), { currentRevision: current.revision });
  }
  const roadmap = await readRoadmap(input.projectRoot);
  const decision = roadmap.loaded.record?.initiatives?.find((item) => item.id === input.initiative)?.decision;
  if (!decision) throw fail("gate_blocked", `Record the shipped or superseded decision for ${input.initiative} on the roadmap before removing its records.`);
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
  const standalone = input.operations.find((operation) => STANDALONE.has(operation.op));
  if (standalone && input.operations.length > 1) throw fail("validation_failed", `${standalone.op} must be the only operation of its update.`);
  if (standalone?.op === "remove_records") return removeRecords(input);
  const resolved = await resolveInitiative(input.projectRoot, input.initiative, true);
  const diagramCache = await precheckDiagrams(resolved, input.operations);
  await conservationStore.registerCoordinationOutputs(resolved.root, [resolved.projectionPath]);
  await mkdir(path.dirname(resolved.target), { recursive: true });
  return withArtifactLock(resolved.target, () => withFileLock(resolved.target, async () => {
    const current = await loadRecord(resolved);
    if (current.revision !== input.expectedRevision) {
      throw fail(input.expectedRevision === "null" ? "invalid_revision" : "revision_conflict", revisionMismatch("initiative record", input.expectedRevision, current.revision), { currentRevision: current.revision });
    }
    if (current.exists && !current.valid) {
      throw fail("invalid_initiative", "The existing initiative record is invalid and was not changed.", { errors: current.errors });
    }
    const record = current.record
      ? { id: current.record.id, slices: Object.assign(Object.create(null), structuredClone(current.record.slices)), proposals: Object.assign(Object.create(null), structuredClone(current.record.proposals ?? {})), history: [...current.record.history] }
      : { id: resolved.initiative, slices: Object.create(null), proposals: Object.create(null), history: [] };
    const accepted = new Set(input.operations.filter((operation) => operation.op === "accept_design").map((operation) => operation.slug));
    const effects = { staged: [], installed: [], diagrams: [], checkedFolders: new Set(), diagramCache, accepted, applied: [], actor: input.actor };
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
    const at = new Date().toISOString();
    const actor = input.actor ?? "agent";
    const mutating = input.operations.filter((operation) => operation.op !== "regenerate_markdown");
    for (const operation of mutating) record.history.push({ actor, operation: operation.op, ...(operation.slug ? { slug: operation.slug } : operation.parent ? { slug: operation.parent } : {}), at });
    const contents = serialize(record);
    const changed = mutating.length > 0 && (!current.exists || contents !== (await readFile(resolved.target, "utf8").catch(() => null)));
    if (changed) await writeRecord(resolved.root, { kind: "initiative", initiative: resolved.initiative }, contents);
    // Staged tests leave the work tree only after the initiative record is written, and only for slices still staged at the end of the update.
    const withdrawn = [];
    for (const staged of effects.staged) if (record.slices[staged.slice]?.design?.staged) withdrawn.push(...await withdrawFrozenTests(resolved.root, resolved.initiative, staged));
    let projectionStale = false;
    try {
      projectionStale = !(await writeProjection(resolved.root, resolved.projectionTarget, markdown(canonicalRecord(record)), RECORD_NAME)).written;
    } catch {
      projectionStale = true;
    }
    const updated = await loadRecord(resolved);
    return { ...publicResult(resolved, updated), created: !current.exists, previousRevision: current.revision, projectionStale, withdrawn, installed: effects.installed, diagrams: effects.diagrams };
  }, fail));
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
    ...(slices[key].contractDefects ? { contractDefects: slices[key].contractDefects.length } : {})
  }]));
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
    ...(result.projectionStale ? { projectionStale: true } : {})
  };
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
    description: "Apply revision-checked initiative operations: create the root slice, split a slice, set leaf status, set dependencies, update a slice title or outcome, accept a slice design with its frozen acceptance tests and review mark, or import a legacy map.puml. Design proposes its result with propose_design, whose split, set_dependencies, update_slice, and accept_design operations change only the scope and the slices inside it: Prism checks them on a copy of the record, refuses with the same errors as a direct update, and keeps the proposal pending without changing any slice; after the design gate, accept_proposal applies it with the slugs whose review is required and, for a user_gate split, the gate where the person approved it. Both operations stand alone in their update. A split whose every part takes accept_design in the same update is a contract's slice plan; any other split into parts needs evidence: contract_size names contract files whose estimated tokens exceed the contract budget, unfrozen quotes an Unprobed assumption from the scope's slice.md and names the part that settles it, and user_gate names a pending gate the person answered, which a proposed split names at accept_proposal. Accepting designs refuses a contract whose slice.md and frozen tests exceed that budget with contract_too_large, listing the measured files. Accepting the design of a slice that has not started stages its frozen tests: Prism keeps them and takes them out of the work tree, and set_status in-progress puts them back when the slice starts; restore_tests puts the staged tests of a slice and its descendants back for a design revision, and accepting each design again stages them again. report_contract_defects, which verify_slice sends for an implementer, blocks a started slice and keeps the defects on it until its next accepted design. Accepting a design also checks the PlantUML files of the slice and the initiative overview and refuses one that does not parse or shows more than 30 elements. Done transitions require a passing completion gate: a fresh passing verify_slice run for a slice with an accepted design, plus an accepted implementation review when that design requires review; verify_slice records done itself when no review is marked. Every write validates the whole slice graph and regenerates initiative.md. The result acknowledges the new revision and the touched slices; get_initiative reads the whole record. After the roadmap records the initiative as shipped or superseded, remove_records alone deletes the initiative's coordination records during cleanup and keeps its run entries.",
    inputSchema: UPDATE_INITIATIVE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];
