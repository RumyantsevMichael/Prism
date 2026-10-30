import { createHash, randomBytes } from "node:crypto";
import { applyActiveOperations, withReviewGatesLocked } from "./active-operations.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { mkdir, readFile, realpath, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { withArtifactLock as withStateLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { locateRecord, sliceDocumentFolder, writeRecord } from "./record-store.mjs";
import { revisionMismatch } from "./revision.mjs";
import { initiativeDirectory, readWorkflowConfig } from "./workflow-config.mjs";

const SCHEMA_VERSION = 1;

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "settings", "active", "pending", "next", "evidence"]);
const SETTING_KEYS = new Set(["autonomy", "agentFlow", "commit", "push", "continuation", "review", "models"]);
const ACTIVE_KEYS = new Set(["slice", "activity", "label", "workers", "workspace", "reviewLanes", "findingsPath", "reviewPath"]);
const GATE_KINDS = new Set(["visual-review", "correctness", "decision", "assistance"]);
const GATE_KEYS = new Set(["id", "kind", "slice", "question", "artifacts", "options", "askedAt", "answer"]);
const GATE_ID = /^gate-[0-9a-f]{8,32}$/;
const OPTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ANSWER_KEYS = new Set(["choice", "note", "via", "answeredAt"]);
const REVIEW_CHOICES = new Set(["approve", "request-changes"]);
const SETTING_VALUES = {
  autonomy: new Set(["conservative", "broad", "full"]),
  agentFlow: new Set(["mono", "multi"]),
  commit: new Set(["on", "off"]),
  push: new Set(["on", "off"]),
  continuation: new Set(["auto", "stepwise"]),
  review: new Set(["marked", "recommended", "all"])
};

export class CoordinationStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CoordinationStateError";
    this.code = code;
    Object.assign(this, details);
  }
}

function error(code, message, details = {}) {
  return new CoordinationStateError(code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertNearestExistingPathInside(root, target) {
  let current = target;
  while (true) {
    try {
      const resolved = await realpath(current);
      if (!isInside(root, resolved)) {
        throw error("invalid_path", "The recovery path resolves outside the project root.");
      }
      return;
    } catch (caught) {
      if (caught.code !== "ENOENT") {
        throw caught;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error("invalid_path", "The recovery path cannot be resolved inside the project root.");
      }
      current = parent;
    }
  }
}

// Coordination state is an initiative's record; evidence paths in it stay relative to the initiative's plans folder.
async function resolveState(projectRoot, initiative) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw error("invalid_project_root", "The project root must be an absolute path.");
  }
  if (typeof initiative !== "string" || !SLUG_PATTERN.test(initiative)) {
    throw error("invalid_path", "The initiative identifier must use letters, digits, hyphens, or underscores.");
  }
  const located = await locateRecord(projectRoot, { kind: "state", initiative });
  const config = await readWorkflowConfig(located.root);
  return { root: located.root, initiative, path: located.target, displayPath: located.path, directory: initiativeDirectory(config, initiative) };
}

function revisionOf(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {},
    active: [],
    pending: [],
    next: [],
    evidence: []
  };
}

function normalizeState(raw) {
  if (!isRecord(raw)) {
    return raw;
  }
  const state = {
    schemaVersion: raw.schemaVersion ?? SCHEMA_VERSION,
    settings: raw.settings ?? {},
    active: raw.active ?? [],
    pending: raw.pending ?? [],
    next: raw.next ?? [],
    evidence: raw.evidence ?? []
  };
  for (const [key, value] of Object.entries(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      state[key] = value;
    }
  }
  return state;
}

function addError(errors, pathValue, message) {
  errors.push(`${pathValue}: ${message}`);
}

function addWarning(warnings, pathValue, message) {
  warnings.push(`${pathValue}: ${message}`);
}

function validateStringArray(value, pathValue, errors) {
  if (!Array.isArray(value)) {
    addError(errors, pathValue, "must be an array of strings");
    return;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      addError(errors, `${pathValue}[${index}]`, "must be a non-empty string");
      return;
    }
    if (seen.has(item)) {
      addError(errors, `${pathValue}[${index}]`, "must not duplicate another item");
    }
    seen.add(item);
  });
}

function validateModels(value, errors) {
  if (typeof value === "string") {
    if (value !== "defaults" && value !== "host defaults") {
      addError(errors, "settings.models", "must be defaults, host defaults, or a model assignment object");
    }
    return;
  }
  if (!isRecord(value)) {
    addError(errors, "settings.models", "must be a supported defaults value or an object");
    return;
  }
  const requiredRoles = ["delivery", "review", "securityReview"];
  for (const role of requiredRoles) {
    if (typeof value[role] !== "string" || !value[role].trim()) {
      addError(errors, `settings.models.${role}`, "must be a non-empty model name");
    }
  }
  if (value.examples !== undefined && (typeof value.examples !== "string" || !value.examples.trim())) {
    addError(errors, "settings.models.examples", "must be a non-empty model name when present");
  }
  for (const key of Object.keys(value)) {
    if (!requiredRoles.includes(key) && key !== "examples") {
      addError(errors, `settings.models.${key}`, "is not a supported model role");
    }
  }
}

function validateSettings(value, errors, warnings) {
  if (!isRecord(value)) {
    addError(errors, "settings", "must be an object");
    return;
  }
  for (const [key, setting] of Object.entries(value)) {
    if (!SETTING_KEYS.has(key)) {
      addWarning(warnings, `settings.${key}`, "is not managed by the coordination state capability and will be preserved");
      continue;
    }
    if (key === "models") {
      validateModels(setting, errors);
      continue;
    }
    if (typeof setting !== "string" || !SETTING_VALUES[key].has(setting)) {
      addError(errors, `settings.${key}`, `must be one of ${[...SETTING_VALUES[key]].join(", ")}`);
    }
  }
}

function validateActive(value, errors, warnings) {
  if (!Array.isArray(value)) {
    addError(errors, "active", "must be an array of active work records");
    return;
  }
  const slices = new Set();
  const workers = new Set();
  value.forEach((entry, index) => {
    const entryPath = `active[${index}]`;
    if (!isRecord(entry)) {
      addError(errors, entryPath, "must be an object");
      return;
    }
    if (typeof entry.slice !== "string" || !entry.slice.trim()) {
      addError(errors, `${entryPath}.slice`, "must be a non-empty string");
    } else if (slices.has(entry.slice)) {
      addError(errors, `${entryPath}.slice`, "must identify a unique active slice");
    } else {
      slices.add(entry.slice);
    }
    if (typeof entry.activity !== "string" || !entry.activity.trim()) {
      addError(errors, `${entryPath}.activity`, "must be a non-empty string");
    }
    if (!Array.isArray(entry.workers) || entry.workers.length === 0) {
      addError(errors, `${entryPath}.workers`, "must contain at least one worker");
    } else {
      const localWorkers = new Set();
      entry.workers.forEach((worker, workerIndex) => {
        if (typeof worker !== "string" || !worker.trim()) {
          addError(errors, `${entryPath}.workers[${workerIndex}]`, "must be a non-empty string");
        } else if (localWorkers.has(worker) || workers.has(worker)) {
          addError(errors, `${entryPath}.workers[${workerIndex}]`, "must identify a worker that is not active elsewhere");
        } else {
          localWorkers.add(worker);
          workers.add(worker);
        }
      });
    }
    if (typeof entry.workspace !== "string" || !entry.workspace.trim()) {
      addError(errors, `${entryPath}.workspace`, "must be a non-empty path");
    }
    if (entry.reviewLanes !== undefined && !Array.isArray(entry.reviewLanes)) {
      addError(errors, `${entryPath}.reviewLanes`, "must be an array when present");
    }
    if (entry.findingsPath !== undefined && (typeof entry.findingsPath !== "string" || !entry.findingsPath.trim())) {
      addError(errors, `${entryPath}.findingsPath`, "must be a non-empty path when present");
    }
    for (const key of Object.keys(entry)) {
      if (!ACTIVE_KEYS.has(key)) {
        addWarning(warnings, `${entryPath}.${key}`, "is not managed by the coordination state capability and will be preserved");
      }
    }
  });
}

function validGatePath(value) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.includes("\\")) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.startsWith("../");
}

function validateGate(entry, entryPath, errors) {
  for (const key of Object.keys(entry)) {
    if (!GATE_KEYS.has(key)) {
      addError(errors, `${entryPath}.${key}`, "is not a user gate field");
    }
  }
  if (typeof entry.id !== "string" || !GATE_ID.test(entry.id)) {
    addError(errors, `${entryPath}.id`, "must be a gate id assigned by the ask operation");
  }
  if (!GATE_KINDS.has(entry.kind)) {
    addError(errors, `${entryPath}.kind`, `must be one of ${[...GATE_KINDS].join(", ")}`);
  }
  if (entry.slice !== undefined && (typeof entry.slice !== "string" || !entry.slice.trim())) {
    addError(errors, `${entryPath}.slice`, "must be a non-empty slice slug when present");
  }
  if (typeof entry.question !== "string" || !entry.question.trim() || entry.question.length > 4000) {
    addError(errors, `${entryPath}.question`, "must be a non-empty question of at most 4000 characters");
  }
  if (!Array.isArray(entry.artifacts) || entry.artifacts.length > 50) {
    addError(errors, `${entryPath}.artifacts`, "must be an array of at most 50 project-relative paths");
  } else {
    entry.artifacts.forEach((item, index) => {
      if (!validGatePath(item)) {
        addError(errors, `${entryPath}.artifacts[${index}]`, "must be a normalized project-relative path");
      }
    });
  }
  if (entry.options !== undefined) {
    if (entry.kind !== "decision") {
      addError(errors, `${entryPath}.options`, "is allowed only for decision gates; visual-review and correctness answers are approve or request-changes, and assistance answers are done");
    } else if (!Array.isArray(entry.options) || entry.options.length === 0 || entry.options.length > 8) {
      addError(errors, `${entryPath}.options`, "must list one to eight options");
    } else {
      const ids = new Set();
      entry.options.forEach((option, index) => {
        if (!isRecord(option) || Object.keys(option).some((key) => key !== "id" && key !== "label") || !OPTION_ID.test(option.id ?? "") || typeof option.label !== "string" || !option.label.trim() || option.label.length > 200) {
          addError(errors, `${entryPath}.options[${index}]`, "must be { id, label } with a lowercase slug id and a label of at most 200 characters");
        } else if (ids.has(option.id)) {
          addError(errors, `${entryPath}.options[${index}].id`, "must not duplicate another option");
        } else {
          ids.add(option.id);
        }
      });
    }
  }
  if (typeof entry.askedAt !== "string" || Number.isNaN(Date.parse(entry.askedAt))) {
    addError(errors, `${entryPath}.askedAt`, "must be an ISO timestamp");
  }
  if (entry.answer !== undefined) {
    if (!isRecord(entry.answer) || Object.keys(entry.answer).some((key) => !ANSWER_KEYS.has(key))) {
      addError(errors, `${entryPath}.answer`, "must contain only choice, note, via, and answeredAt");
    } else {
      const problem = answerProblem(entry, entry.answer.choice, entry.answer.note);
      if (problem) addError(errors, `${entryPath}.answer`, problem);
      if (entry.answer.via !== "browser") addError(errors, `${entryPath}.answer.via`, "must be browser");
      if (typeof entry.answer.answeredAt !== "string" || Number.isNaN(Date.parse(entry.answer.answeredAt))) addError(errors, `${entryPath}.answer.answeredAt`, "must be an ISO timestamp");
    }
  }
}

// Each gate kind accepts its own choices; a note carries the reason whenever the answer is not a plain acceptance.
function answerProblem(gate, choice, note) {
  if (note !== null && (typeof note !== "string" || !note.trim() || note.length > 4000)) {
    return "note must be null or a non-empty text of at most 4000 characters";
  }
  if (gate.kind === "visual-review" || gate.kind === "correctness") {
    if (!REVIEW_CHOICES.has(choice)) return "choice must be approve or request-changes";
    if (choice === "request-changes" && note === null) return "a request for changes needs a note";
  } else if (gate.kind === "assistance") {
    if (choice !== "done") return "choice must be done";
  } else if (gate.kind === "decision") {
    if (choice === null) {
      if (note === null) return "an answer without a listed option needs a note";
    } else if (!(gate.options ?? []).some((option) => option.id === choice)) {
      return "choice must be one of the gate options or null";
    }
  }
  return null;
}

function validatePending(value, errors) {
  if (!Array.isArray(value)) {
    addError(errors, "pending", "must be an array of strings or user gates");
    return;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    const entryPath = `pending[${index}]`;
    if (isRecord(item)) {
      validateGate(item, entryPath, errors);
      if (seen.has(item.id)) {
        addError(errors, `${entryPath}.id`, "must not duplicate another gate");
      }
      seen.add(item.id);
      return;
    }
    if (typeof item !== "string" || !item.trim()) {
      addError(errors, entryPath, "must be a non-empty string or a user gate");
      return;
    }
    if (seen.has(item)) {
      addError(errors, entryPath, "must not duplicate another item");
    }
    seen.add(item);
  });
}

function applyGateOperations(pending, operations) {
  const next = [...pending];
  const opened = [];
  operations.forEach((operation, index) => {
    if (!isRecord(operation)) {
      throw error("invalid_changes", `gateOperations[${index}] must be an object.`);
    }
    if (operation.op === "ask") {
      const unknown = Object.keys(operation).filter((key) => !["op", "kind", "slice", "question", "artifacts", "options"].includes(key));
      if (unknown.length) {
        throw error("invalid_changes", `gateOperations[${index}] has unsupported fields: ${unknown.join(", ")}.`);
      }
      const gate = {
        id: `gate-${randomBytes(6).toString("hex")}`,
        kind: operation.kind,
        ...(operation.slice === undefined ? {} : { slice: operation.slice }),
        question: operation.question,
        artifacts: operation.artifacts ?? [],
        ...(operation.options === undefined ? {} : { options: operation.options }),
        askedAt: new Date().toISOString()
      };
      const errors = [];
      validateGate(gate, `gateOperations[${index}]`, errors);
      if (errors.length) {
        throw error("invalid_changes", `The user gate is invalid: ${errors.join("; ")}.`, { errors });
      }
      next.push(gate);
      opened.push({ id: gate.id, kind: gate.kind, slice: gate.slice ?? null });
    } else if (operation.op === "resolve") {
      const position = next.findIndex((item) => isRecord(item) && item.id === operation.id);
      if (position === -1) {
        throw error("unknown_gate", `No pending user gate has the id ${operation.id}.`);
      }
      next.splice(position, 1);
    } else {
      throw error("invalid_changes", `gateOperations[${index}].op must be ask or resolve.`);
    }
  });
  return { pending: next, opened };
}

// Only the review browser records answers, so agent updates may keep an answer but never add or change one.
function assertAnswersUnchanged(before, after) {
  const previous = new Map(before.filter(isRecord).map((gate) => [gate.id, JSON.stringify(gate.answer ?? null)]));
  for (const gate of after.filter(isRecord)) {
    if (gate.answer !== undefined && previous.get(gate.id) !== JSON.stringify(gate.answer)) {
      throw error("invalid_changes", `The user gate ${gate.id} has an answer that only the review browser can record.`);
    }
  }
}

function validateStateValue(raw) {
  const errors = [];
  const warnings = [];
  if (!isRecord(raw)) {
    return { errors: ["state: must be a JSON object"], warnings };
  }
  if (raw.schemaVersion === undefined) {
    addWarning(warnings, "schemaVersion", "is missing and will be added on the next update");
  } else if (raw.schemaVersion !== SCHEMA_VERSION) {
    addError(errors, "schemaVersion", `must equal ${SCHEMA_VERSION}`);
  }
  if (raw.settings !== undefined) {
    validateSettings(raw.settings, errors, warnings);
  }
  if (raw.active !== undefined) {
    validateActive(raw.active, errors, warnings);
  }
  if (raw.pending !== undefined) {
    validatePending(raw.pending, errors);
  }
  for (const key of ["next", "evidence"]) {
    if (raw[key] !== undefined) {
      validateStringArray(raw[key], key, errors);
    }
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      addWarning(warnings, key, "is not managed by the coordination state capability and will be preserved");
    }
  }
  return { errors, warnings };
}

function validateChanges(changes) {
  if (!isRecord(changes) || Object.keys(changes).length === 0) {
    throw error("invalid_changes", "The changes argument must contain at least one managed state field.");
  }
  for (const key of Object.keys(changes)) {
    if ((!TOP_LEVEL_KEYS.has(key) && key !== "activeOperations" && key !== "gateOperations") || key === "schemaVersion") {
      throw error("invalid_changes", `The state field ${key} cannot be changed through this capability.`);
    }
  }
  if (changes.settings !== undefined && !isRecord(changes.settings)) {
    throw error("invalid_changes", "The changes.settings field must be an object.");
  }
  for (const key of ["active", "pending", "next", "evidence", "gateOperations"]) {
    if (changes[key] !== undefined && !Array.isArray(changes[key])) {
      throw error("invalid_changes", `The changes.${key} field must be an array.`);
    }
  }
}

async function loadState(statePath) {
  let contents;
  try {
    contents = await readFile(statePath, "utf8");
  } catch (caught) {
    if (caught.code === "ENOENT") {
      return {
        exists: false,
        revision: null,
        contents: null,
        state: null,
        valid: true,
        errors: [],
        warnings: []
      };
    }
    throw caught;
  }
  const revision = revisionOf(contents);
  let raw;
  try {
    raw = JSON.parse(contents);
  } catch (caught) {
    return {
      exists: true,
      revision,
      contents,
      state: null,
      valid: false,
      errors: [`state: must contain valid JSON (${caught.message})`],
      warnings: []
    };
  }
  const validation = validateStateValue(raw);
  const state = normalizeState(raw);
  return {
    exists: true,
    revision,
    contents,
    state,
    valid: validation.errors.length === 0,
    errors: validation.errors,
    warnings: validation.warnings
  };
}

function publicStateResult(resolved, loaded) {
  return {
    initiative: resolved.initiative,
    exists: loaded.exists,
    revision: loaded.revision,
    state: loaded.state,
    valid: loaded.valid,
    errors: loaded.errors,
    warnings: loaded.warnings
  };
}

function changedFields(before, after) {
  return ["settings", "active", "pending", "next", "evidence"].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after[key]));
}

export async function readCoordinationState({ projectRoot, initiative }) {
  const resolved = await resolveState(projectRoot, initiative);
  return publicStateResult(resolved, await loadState(resolved.path));
}

export async function validateCoordinationState({ projectRoot, initiative }) {
  return readCoordinationState({ projectRoot, initiative });
}

export async function updateCoordinationState({ projectRoot, initiative, expectedRevision, changes }) {
  validateChanges(changes);
  if (expectedRevision !== null && typeof expectedRevision !== "string") {
    throw error("invalid_revision", "The expectedRevision argument must be a state revision string or null.");
  }
  const resolved = await resolveState(projectRoot, initiative);
  await mkdir(path.dirname(resolved.path), { recursive: true });
  return withStateLock(resolved.path, () => withFileLock(resolved.path, async () => applyStateChange(resolved, expectedRevision, changes), error, { renew: Boolean(changes.activeOperations?.length) }));
}

async function applyStateChange(resolved, expectedRevision, changes) {
    const current = await loadState(resolved.path);
    if (current.revision !== expectedRevision) {
      throw error(expectedRevision === "null" ? "invalid_revision" : "revision_conflict", revisionMismatch("coordination state", expectedRevision, current.revision), { current: publicStateResult(resolved, current) });
    }
    if (current.exists && !current.valid) {
      throw error("invalid_state", "The existing state is invalid and was not changed.", { validation: publicStateResult(resolved, current) });
    }
    const before = current.state ?? defaultState();
    if (changes.active !== undefined && JSON.stringify(changes.active) !== JSON.stringify(before.active)) throw error("gate_blocked", "Use typed activeOperations to change active work; array replacement cannot bypass review gates.");
    return withReviewGatesLocked(resolved.root, resolved.initiative, before.active, changes.activeOperations ?? [], async () => {
    const activeResult = await applyActiveOperations(resolved.root, resolved.initiative, before.active, changes.activeOperations ?? []);
    const gateResult = applyGateOperations(changes.pending ?? before.pending, changes.gateOperations ?? []);
    assertAnswersUnchanged(before.pending, gateResult.pending);
    const candidate = normalizeState({
      ...before,
      active: activeResult.active,
      ...(changes.settings === undefined ? {} : { settings: { ...before.settings, ...changes.settings } }),
      pending: gateResult.pending,
      ...(changes.next === undefined ? {} : { next: changes.next }),
      ...(changes.evidence === undefined ? {} : { evidence: changes.evidence })
    });
    const validation = validateStateValue(candidate);
    if (validation.errors.length > 0) {
      throw error("invalid_state", "The proposed state is invalid and was not written.", { errors: validation.errors, warnings: validation.warnings });
    }
    const contents = `${JSON.stringify(candidate, null, 2)}\n`;
    if (!current.exists || contents !== current.contents) {
      await writeRecord(resolved.root, { kind: "state", initiative: resolved.initiative }, contents);
    }
    const updated = await loadState(resolved.path);
    return {
      ...publicStateResult(resolved, updated),
      created: !current.exists,
      changedFields: changedFields(before, updated.state),
      previousRevision: current.revision
      ,completions: activeResult.completions,
      openedGates: gateResult.opened
    };
    });
}

export async function answerUserGate({ projectRoot, initiative, id, choice = null, note = null, write = writeRecord }) {
  const resolved = await resolveState(projectRoot, initiative);
  await mkdir(path.dirname(resolved.path), { recursive: true });
  return withStateLock(resolved.path, () => withFileLock(resolved.path, async () => {
    const current = await loadState(resolved.path);
    if (!current.exists || !current.valid) {
      throw error("invalid_state", "The coordination state is missing or invalid.");
    }
    const position = current.state.pending.findIndex((item) => isRecord(item) && item.id === id);
    if (position === -1) {
      throw error("unknown_gate", "The question is no longer open; the agent resolved or withdrew it.");
    }
    const gate = current.state.pending[position];
    if (gate.answer) {
      throw error("gate_answered", "The question already has an answer.");
    }
    const normalizedNote = typeof note === "string" && note.trim() ? note.trim() : null;
    const problem = answerProblem(gate, choice, normalizedNote);
    if (problem) {
      throw error("invalid_answer", `The answer is invalid: ${problem}.`);
    }
    const pending = [...current.state.pending];
    pending[position] = { ...gate, answer: { choice, note: normalizedNote, via: "browser", answeredAt: new Date().toISOString() } };
    const candidate = normalizeState({ ...current.state, pending });
    const validation = validateStateValue(candidate);
    if (validation.errors.length > 0) {
      throw error("invalid_state", "The answered state is invalid and was not written.", { errors: validation.errors });
    }
    await write(resolved.root, { kind: "state", initiative: resolved.initiative }, `${JSON.stringify(candidate, null, 2)}\n`);
    const updated = await loadState(resolved.path);
    return { ...publicStateResult(resolved, updated), gate: pending[position] };
  }, error));
}

// The recovery note is a human document, so it sits in the slice's plans folder beside slice.md.
export async function checkpointPause({ projectRoot, initiative, expectedRevision, activeSlice, recoveryContent, changes }) {
  validateChanges(changes);
  if (typeof activeSlice !== "string" || !SLUG_PATTERN.test(activeSlice) || typeof recoveryContent !== "string" || !recoveryContent.trim() || Buffer.byteLength(recoveryContent) > 65536) {
    throw error("invalid_pause", "An active slice and a recovery note of at most 64 KiB are required.");
  }
  const resolved = await resolveState(projectRoot, initiative);
  const folder = await sliceDocumentFolder(resolved.root, resolved.initiative, activeSlice);
  if (folder === null || resolved.directory === null) {
    throw error("invalid_config", "The workflow config disables the plans path, so the recovery note has no location.");
  }
  const recovery = path.resolve(resolved.root, folder, "recovery.md");
  if (!isInside(resolved.root, recovery)) {
    throw error("invalid_path", "The recovery note must be inside the project root.");
  }
  await assertNearestExistingPathInside(resolved.root, path.dirname(recovery));
  await mkdir(path.dirname(resolved.path), { recursive: true });
  return withStateLock(resolved.path, () => withFileLock(resolved.path, async () => {
    const current = await loadState(resolved.path);
    if (current.revision !== expectedRevision) {
      throw error(expectedRevision === "null" ? "invalid_revision" : "revision_conflict", revisionMismatch("coordination state", expectedRevision, current.revision), { current: publicStateResult(resolved, current) });
    }
    if (!current.valid || !current.state?.active.some((item) => item.slice === activeSlice)) {
      throw error("invalid_pause", "The slice is not active in the current coordination state.");
    }
    const recoveryRelative = path.relative(resolved.root, recovery).split(path.sep).join("/");
    const stateRelativeRecovery = path.relative(path.resolve(resolved.root, resolved.directory), recovery).split(path.sep).join("/");
    const remainingActive = current.state.active.filter((item) => item.slice !== activeSlice);
    if (changes.active !== undefined && JSON.stringify(changes.active) !== JSON.stringify(remainingActive)) {
      throw error("invalid_pause", "The pause must preserve every other active slice.");
    }
    if (changes.activeOperations !== undefined) throw error("invalid_pause", "A pause releases only its named slice; other active operations are not allowed.");
    const existing = await lstat(recovery).catch((caught) => caught.code === "ENOENT" ? null : Promise.reject(caught));
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw error("invalid_path", "The recovery note must be a regular file.");
    const previous = existing ? await readFile(recovery, "utf8") : null;
    try {
      await conservationStore.registerCoordinationOutputs(resolved.root, [recoveryRelative]);
      await mkdir(path.dirname(recovery), { recursive: true });
      await conservationStore.writeManaged(resolved.root, recovery, recoveryContent.endsWith("\n") ? recoveryContent : `${recoveryContent}\n`);
      const result = await applyStateChange(resolved, expectedRevision, {
        ...changes,
        active: undefined,
        activeOperations: [{ op: "release", slice: activeSlice }],
        evidence: [...new Set([...current.state.evidence, ...(changes.evidence ?? []), stateRelativeRecovery])]
      });
      return { ...result, recoveryPath: recoveryRelative, recoveryDigest: createHash("sha256").update(recoveryContent.endsWith("\n") ? recoveryContent : `${recoveryContent}\n`).digest("hex"), pausedSlice: activeSlice };
    } catch (caught) {
      if (previous === null) await rm(recovery, { force: true }).catch(() => {});
      else await writeAtomically(recovery, previous).catch(() => {});
      throw caught;
    }
  }, error));
}
