import { createHash, randomBytes } from "node:crypto";
import { applyActiveOperations, withReviewGatesLocked } from "./active-operations.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { mkdir, readFile, realpath, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { withArtifactLock as withStateLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { inArtifactStore, locateRecord, moveLegacyRecords, oversizedRevision, readArtifactText, readStoreFileBytes, sliceDocumentFolder, STORE_FILE_BOUNDS, writeArtifactText, writeRecord } from "./record-store.mjs";
import { canonicalJson, mergeOrder, mergeScalars, mergeUnit, MergeConflict, parseVersions } from "./record-merge.mjs";
import { revisionMismatch } from "./revision.mjs";
import { initiativeDirectory, readWorkflowConfig } from "./workflow-config.mjs";
import { parseStoreJson } from "./store-json.mjs";

const SCHEMA_VERSION = 1;

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "settings", "active", "pending", "next", "evidence", "closed", "history", "personSettings"]);
// Only the review app's action registry writes the person's history and setting marks, so agents' state changes never carry them.
const REGISTRY_KEYS = new Set(["history", "personSettings"]);
// The initiative settings that coordination state accepts, in the order the review app lists their actions.
export const INITIATIVE_SETTINGS = Object.freeze(["autonomy", "commit", "push", "continuation", "review", "models"]);
const SETTING_KEYS = new Set(INITIATIVE_SETTINGS);

/** The six effective setting values, each stored or else its default, and personSettings, the names of the settings the person set. */
export function effectiveSettings(state) {
  const stored = isRecord(state?.settings) ? state.settings : {};
  const autonomy = stored.autonomy ?? "conservative";
  return {
    autonomy,
    commit: stored.commit ?? (autonomy === "full" ? "on" : "off"),
    push: stored.push ?? "off",
    continuation: stored.continuation ?? "auto",
    review: stored.review ?? "marked",
    models: stored.models === undefined || stored.models === "defaults" ? "host defaults" : stored.models,
    personSettings: INITIATIVE_SETTINGS.filter((name) => isRecord(state?.personSettings) && Object.hasOwn(state.personSettings, name))
  };
}

// An agent's settings write keeps each setting the person changed in the review app, and lists what it kept.
function keepPersonSettings(before, requested) {
  const marks = isRecord(before.personSettings) ? before.personSettings : {};
  const settings = { ...requested };
  const kept = [];
  for (const [name, value] of Object.entries(requested)) {
    if (!Object.hasOwn(marks, name) || !Object.hasOwn(before.settings, name) || JSON.stringify(value) === JSON.stringify(before.settings[name])) continue;
    settings[name] = before.settings[name];
    kept.push({ setting: name, kept: before.settings[name], requested: value });
  }
  return { settings, kept };
}
const ACTIVE_KEYS = new Set(["slice", "activity", "label", "workers", "workspace", "reviewLanes", "findingsPath", "reviewPath"]);
const GATE_KINDS = new Set(["visual-review", "correctness", "decision", "assistance"]);
const GATE_KEYS = new Set(["id", "kind", "slice", "question", "context", "artifacts", "options", "recommended", "askedAt", "answer"]);
const ASK_KEYS = ["op", "kind", "slice", "question", "context", "artifacts", "options", "recommended"];
const OPTION_KEYS = new Set(["id", "label", "consequence"]);
const RECOMMENDED_KEYS = new Set(["option", "reason"]);
const CONTEXT_LIMIT = 8000;
const CONSEQUENCE_LIMIT = 300;
const RECOMMENDATION_LIMIT = 500;
// A person who has not followed the run decides from the gate alone, so a choice or an action carries its situation.
const CONTEXT_KINDS = new Set(["decision", "assistance"]);
const GATE_ID = /^gate-[0-9a-f]{8,32}$/;
const OPTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ANSWER_KEYS = new Set(["choice", "note", "via", "answeredAt", "by", "entry"]);
const ENTRY_ID = /^[0-9a-f]{32}$/;
const ENTRY_KEYS = new Set(["id", "action", "target", "before", "after", "at", "by", "via"]);
const AUTHOR_KEYS = new Set(["name", "email", "checkout"]);
export const HISTORY_LIMIT = 200;
// Closed gates stay readable so the user can see what they answered and why a question went away.
const CLOSED_LIMIT = 20;
const REASON_LIMIT = 1000;
const REVIEW_CHOICES = new Set(["approve", "request-changes"]);
const STATE_MAX_BYTES = 1024 * 1024;
const SETTING_VALUES = {
  autonomy: new Set(["conservative", "broad", "full"]),
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

// Every child now runs in a fresh agent, so a stored agent flow from an older Prism is dropped on read.
const RETIRED_SETTINGS = new Set(["agentFlow"]);

function withoutRetiredSettings(settings) {
  if (!isRecord(settings)) {
    return settings;
  }
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !RETIRED_SETTINGS.has(key)));
}

function normalizeState(raw) {
  if (!isRecord(raw)) {
    return raw;
  }
  const state = {
    schemaVersion: raw.schemaVersion ?? SCHEMA_VERSION,
    settings: withoutRetiredSettings(raw.settings ?? {}),
    active: raw.active ?? [],
    pending: raw.pending ?? [],
    next: raw.next ?? [],
    evidence: raw.evidence ?? [],
    ...(raw.closed === undefined ? {} : { closed: raw.closed }),
    ...(raw.history === undefined ? {} : { history: raw.history }),
    ...(raw.personSettings === undefined ? {} : { personSettings: raw.personSettings })
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

function boundedText(value, limit) {
  return typeof value === "string" && value.trim() !== "" && value.length <= limit;
}

// A new question must stand on its own; gates recorded before these fields existed stay valid as they are.
function askProblems(gate) {
  const problems = [];
  if (CONTEXT_KINDS.has(gate.kind) && gate.context === undefined) {
    problems.push("context is required for a decision or assistance gate: in plain language, say what happened, what was tried, what the choice changes, and give a concrete example, so a person who has not followed the run can decide from the gate alone");
  }
  if (gate.kind !== "decision") return problems;
  const missing = (gate.options ?? []).filter((option) => isRecord(option) && option.consequence === undefined).map((option) => option.id);
  if (missing.length) problems.push(`each option needs a consequence, one sentence on what happens if the person picks it; missing for ${missing.join(", ")}`);
  if (gate.recommended === undefined) {
    problems.push(gate.options?.length
      ? "recommended is required: { option, reason } naming the option you recommend and why"
      : "recommended is required: { reason } with the answer you recommend and why");
  }
  return problems;
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
        if (!isRecord(option) || Object.keys(option).some((key) => !OPTION_KEYS.has(key)) || !OPTION_ID.test(option.id ?? "") || typeof option.label !== "string" || !option.label.trim() || option.label.length > 200) {
          addError(errors, `${entryPath}.options[${index}]`, "must be { id, label, consequence } with a lowercase slug id and a label of at most 200 characters");
        } else if (option.consequence !== undefined && !boundedText(option.consequence, CONSEQUENCE_LIMIT)) {
          addError(errors, `${entryPath}.options[${index}].consequence`, `must be non-empty text of at most ${CONSEQUENCE_LIMIT} characters`);
        } else if (ids.has(option.id)) {
          addError(errors, `${entryPath}.options[${index}].id`, "must not duplicate another option");
        } else {
          ids.add(option.id);
        }
      });
    }
  }
  if (entry.context !== undefined && !boundedText(entry.context, CONTEXT_LIMIT)) {
    addError(errors, `${entryPath}.context`, `must be non-empty Markdown of at most ${CONTEXT_LIMIT} characters`);
  }
  if (entry.recommended !== undefined) {
    const recommended = entry.recommended;
    if (entry.kind !== "decision") {
      addError(errors, `${entryPath}.recommended`, "is allowed only for decision gates");
    } else if (!isRecord(recommended) || Object.keys(recommended).some((key) => !RECOMMENDED_KEYS.has(key)) || !boundedText(recommended.reason, RECOMMENDATION_LIMIT)) {
      addError(errors, `${entryPath}.recommended`, `must be { option, reason } with a reason of at most ${RECOMMENDATION_LIMIT} characters`);
    } else if (recommended.option !== undefined && !(entry.options ?? []).some((option) => isRecord(option) && option.id === recommended.option)) {
      addError(errors, `${entryPath}.recommended.option`, "must name one of the gate's options");
    }
  }
  if (typeof entry.askedAt !== "string" || Number.isNaN(Date.parse(entry.askedAt))) {
    addError(errors, `${entryPath}.askedAt`, "must be an ISO timestamp");
  }
  if (entry.answer !== undefined) {
    if (!isRecord(entry.answer) || Object.keys(entry.answer).some((key) => !ANSWER_KEYS.has(key))) {
      addError(errors, `${entryPath}.answer`, "must contain only choice, note, via, answeredAt, by, and entry");
    } else {
      const problem = answerProblem(entry, entry.answer.choice, entry.answer.note);
      if (problem) addError(errors, `${entryPath}.answer`, problem);
      if (entry.answer.via !== "browser") addError(errors, `${entryPath}.answer.via`, "must be browser");
      if (typeof entry.answer.answeredAt !== "string" || Number.isNaN(Date.parse(entry.answer.answeredAt))) addError(errors, `${entryPath}.answer.answeredAt`, "must be an ISO timestamp");
      if (entry.answer.by !== undefined && !validAuthor(entry.answer.by)) addError(errors, `${entryPath}.answer.by`, "must be an author { name, email, checkout }");
      if (entry.answer.entry !== undefined && (typeof entry.answer.entry !== "string" || !ENTRY_ID.test(entry.answer.entry))) addError(errors, `${entryPath}.answer.entry`, "must be a history entry id of 32 lowercase hexadecimal characters");
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

function validateClosed(value, errors) {
  if (!Array.isArray(value) || value.length > CLOSED_LIMIT) {
    addError(errors, "closed", `must be an array of at most ${CLOSED_LIMIT} closed user gates`);
    return;
  }
  value.forEach((entry, index) => {
    const entryPath = `closed[${index}]`;
    if (!isRecord(entry)) {
      addError(errors, entryPath, "must be a closed user gate");
      return;
    }
    const { closedAt, reason, ...gate } = entry;
    validateGate(gate, entryPath, errors);
    if (typeof closedAt !== "string" || Number.isNaN(Date.parse(closedAt))) addError(errors, `${entryPath}.closedAt`, "must be an ISO timestamp");
    if (reason !== undefined && (typeof reason !== "string" || !reason.trim() || reason.length > REASON_LIMIT)) addError(errors, `${entryPath}.reason`, `must be a non-empty reason of at most ${REASON_LIMIT} characters`);
  });
}

function closedGate(gate, reason) {
  return { ...gate, closedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
}

// Replacing the pending list may drop answered gates, but an unanswered question is withdrawn only through resolve with a reason.
function droppedGates(before, replacement) {
  if (replacement === undefined) return [];
  const kept = new Set(replacement.filter(isRecord).map((gate) => gate.id));
  const dropped = before.filter((gate) => isRecord(gate) && !kept.has(gate.id));
  const unanswered = dropped.find((gate) => !gate.answer);
  if (unanswered) {
    throw error("invalid_changes", `The pending list drops the unanswered gate ${unanswered.id}; withdraw it with a resolve operation and a reason.`);
  }
  return dropped.map((gate) => closedGate(gate, null));
}

function applyGateOperations(pending, operations) {
  const next = [...pending];
  const opened = [];
  const closed = [];
  operations.forEach((operation, index) => {
    if (!isRecord(operation)) {
      throw error("invalid_changes", `gateOperations[${index}] must be an object.`);
    }
    if (operation.op === "ask") {
      const unknown = Object.keys(operation).filter((key) => !ASK_KEYS.includes(key));
      if (unknown.length) {
        throw error("invalid_changes", `gateOperations[${index}] has unsupported fields: ${unknown.join(", ")}.`);
      }
      const gate = {
        id: `gate-${randomBytes(6).toString("hex")}`,
        kind: operation.kind,
        ...(operation.slice === undefined ? {} : { slice: operation.slice }),
        question: operation.question,
        ...(operation.context === undefined ? {} : { context: operation.context }),
        artifacts: operation.artifacts ?? [],
        ...(operation.options === undefined ? {} : { options: operation.options }),
        ...(operation.recommended === undefined ? {} : { recommended: operation.recommended }),
        askedAt: new Date().toISOString()
      };
      const errors = [];
      validateGate(gate, `gateOperations[${index}]`, errors);
      const problems = errors.length ? [] : askProblems(gate);
      if (problems.length) {
        throw error("gate_context_missing", `The question cannot be asked yet: ${problems.join("; ")}.`, { errors: problems });
      }
      if (errors.length) {
        throw error("invalid_changes", `The user gate is invalid: ${errors.join("; ")}.`, { errors });
      }
      next.push(gate);
      opened.push({ id: gate.id, kind: gate.kind, slice: gate.slice ?? null });
    } else if (operation.op === "resolve") {
      const unknown = Object.keys(operation).filter((key) => !["op", "id", "reason"].includes(key));
      if (unknown.length) {
        throw error("invalid_changes", `gateOperations[${index}] has unsupported fields: ${unknown.join(", ")}.`);
      }
      const position = next.findIndex((item) => isRecord(item) && item.id === operation.id);
      if (position === -1) {
        throw error("unknown_gate", `No pending user gate has the id ${operation.id}.`);
      }
      const reason = typeof operation.reason === "string" ? operation.reason.trim() : "";
      if (operation.reason !== undefined && (!reason || reason.length > REASON_LIMIT)) {
        throw error("invalid_changes", `gateOperations[${index}].reason must be a non-empty reason of at most ${REASON_LIMIT} characters.`);
      }
      if (!next[position].answer && !reason) {
        throw error("invalid_changes", `gateOperations[${index}] resolves the unanswered gate ${operation.id}; give a reason, such as the user's answer in the conversation or why the question no longer applies.`);
      }
      closed.push(closedGate(next[position], reason));
      next.splice(position, 1);
    } else {
      throw error("invalid_changes", `gateOperations[${index}].op must be ask or resolve.`);
    }
  });
  return { pending: next, opened, closed };
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

const nullableText = (value) => value === null || (typeof value === "string" && value.length <= 200);

function validAuthor(value) {
  return isRecord(value) && Object.keys(value).every((key) => AUTHOR_KEYS.has(key)) && nullableText(value.name) && nullableText(value.email) && typeof value.checkout === "string" && value.checkout.trim() !== "" && value.checkout.length <= 400;
}

const validTime = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** The order of a history: ascending by the time of the machine that applied each entry, and then by id. */
export function historyOrder(left, right) {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** A history with one more entry at its place in history order, keeping the newest entries within the limit. */
export function insertHistoryEntry(history, entry, limit = HISTORY_LIMIT) {
  const entries = [...(history ?? [])];
  let position = entries.length;
  while (position > 0 && historyOrder(entries[position - 1], entry) > 0) position -= 1;
  entries.splice(position, 0, entry);
  return entries.slice(-limit);
}

/** The problem of a history entry, or null when it is well formed. */
export function historyEntryProblem(entry) {
  if (!isRecord(entry) || Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))) return "must contain only id, action, target, before, after, at, by, and via";
  if (typeof entry.id !== "string" || !ENTRY_ID.test(entry.id)) return "id must be 32 lowercase hexadecimal characters";
  for (const key of ["action", "target", "via"]) if (typeof entry[key] !== "string" || !entry[key].trim() || entry[key].length > 400) return `${key} must be a non-empty text`;
  if (!Object.hasOwn(entry, "before") || !Object.hasOwn(entry, "after")) return "before and after must be present";
  if (!validTime(entry.at)) return "at must be an ISO timestamp";
  if (!validAuthor(entry.by)) return "by must be an author { name, email, checkout }";
  return null;
}

function validateHistory(value, errors) {
  if (!Array.isArray(value) || value.length > HISTORY_LIMIT) {
    addError(errors, "history", `must be an array of at most ${HISTORY_LIMIT} history entries`);
    return;
  }
  const seen = new Set();
  value.forEach((entry, index) => {
    const problem = historyEntryProblem(entry);
    if (problem) {
      addError(errors, `history[${index}]`, problem);
      return;
    }
    if (seen.has(entry.id)) addError(errors, `history[${index}].id`, "must not duplicate another entry");
    seen.add(entry.id);
    if (index > 0 && historyEntryProblem(value[index - 1]) === null && historyOrder(value[index - 1], entry) > 0) addError(errors, `history[${index}]`, "must follow the entries before it by time and then by id");
  });
}

function validatePersonSettings(value, errors) {
  if (!isRecord(value)) {
    addError(errors, "personSettings", "must be an object");
    return;
  }
  for (const [key, mark] of Object.entries(value)) {
    if (!SETTING_KEYS.has(key)) addError(errors, `personSettings.${key}`, "is not an initiative setting");
    else if (!isRecord(mark) || Object.keys(mark).some((name) => name !== "at" && name !== "entry") || !validTime(mark.at) || typeof mark.entry !== "string" || !ENTRY_ID.test(mark.entry)) addError(errors, `personSettings.${key}`, "must be { at, entry } with an ISO time and a history entry id");
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
  if (raw.closed !== undefined) {
    validateClosed(raw.closed, errors);
  }
  if (raw.history !== undefined) {
    validateHistory(raw.history, errors);
  }
  if (raw.personSettings !== undefined) {
    validatePersonSettings(raw.personSettings, errors);
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
    if (REGISTRY_KEYS.has(key)) {
      throw error("invalid_changes", `The state field ${key} records the person's changes in the review app, so only the review app's actions write it.`);
    }
    if ((!TOP_LEVEL_KEYS.has(key) && key !== "activeOperations" && key !== "gateOperations") || key === "schemaVersion" || key === "closed") {
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
    // The state is read without following a link and only within its kind's bound, so a larger file reads as a damaged one, unread.
    const bytes = await readStoreFileBytes(statePath, STORE_FILE_BOUNDS.state);
    if (bytes === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    contents = bytes.toString("utf8");
  } catch (caught) {
    if (caught.tooLarge) return { exists: true, revision: oversizedRevision(caught), contents: "", state: null, valid: false, errors: [`state: ${caught.message}`], warnings: [] };
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
    raw = parseStoreJson(contents);
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

const serialize = (state) => `${JSON.stringify(state, null, 2)}\n`;
const fits = (contents) => Buffer.byteLength(contents) <= STATE_MAX_BYTES;

// The smallest count in [0, max] whose drop makes the state fit, or null when even max does not; a larger drop never grows the state.
function fewestDrops(max, contentsAfter) {
  if (!fits(contentsAfter(max))) return null;
  let [low, high] = [0, max];
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(contentsAfter(middle))) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * A coordination state fitted to 1 MiB: the oldest history entries other than `keep` give way first, and then the oldest closed gates,
 * so pending gates, settings, the person's marks, and every other part stay. Null when the state exceeds the limit with both dropped.
 */
function fitState(state, keep = null) {
  const contents = serialize(state);
  if (fits(contents)) return { state, contents };
  const history = Array.isArray(state.history) ? state.history : [];
  const droppable = history.filter((item) => item?.id !== keep);
  const withoutHistory = (count) => {
    const gone = new Set(droppable.slice(0, count));
    return { ...state, ...(state.history === undefined ? {} : { history: history.filter((item) => !gone.has(item)) }) };
  };
  const historyDrops = fewestDrops(droppable.length, (count) => serialize(withoutHistory(count)));
  if (historyDrops !== null) {
    const fitted = withoutHistory(historyDrops);
    return { state: fitted, contents: serialize(fitted) };
  }
  const trimmed = withoutHistory(droppable.length);
  const closed = Array.isArray(state.closed) ? state.closed : [];
  const withoutClosed = (count) => ({ ...trimmed, ...(state.closed === undefined ? {} : { closed: closed.slice(count) }) });
  const closedDrops = fewestDrops(closed.length, (count) => serialize(withoutClosed(count)));
  if (closedDrops === null) return null;
  const fitted = withoutClosed(closedDrops);
  return { state: fitted, contents: serialize(fitted) };
}

// Every coordination state write serializes through here, so no state that a writer accepts exceeds the limit a merge applies.
function stateContents(state, keep = null) {
  const fitted = fitState(state, keep);
  if (fitted === null) throw error("artifact_too_large", "The coordination state exceeds 1 MiB with its history and closed gates dropped and was not written.");
  return fitted.contents;
}

function changedFields(before, after) {
  return ["settings", "active", "pending", "next", "evidence", "closed"].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after[key]));
}

const ABSENT = Symbol("absent");
const sameJson = (left, right) => (left === ABSENT ? "\0absent" : canonicalJson(left)) === (right === ABSENT ? "\0absent" : canonicalJson(right));
const valueOf = (record, key) => isRecord(record) && Object.hasOwn(record, key) ? record[key] : ABSENT;

// A person's mark orders by its time and then by its entry id; a side without a mark comes before any mark.
function laterMark(left, right) {
  if (left === ABSENT || right === ABSENT) return left === ABSENT ? (right === ABSENT ? 0 : -1) : 1;
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  return left.entry < right.entry ? -1 : left.entry > right.entry ? 1 : 0;
}

// Each setting merges with its person mark: a setting both sides changed differently takes the side the person changed later.
function mergeSettings(base, local, upstream) {
  const names = [...new Set([...Object.keys(upstream.settings), ...Object.keys(local.settings), ...Object.keys(base.settings)])];
  const settings = {};
  const marks = {};
  const marksOf = (state) => isRecord(state.personSettings) ? state.personSettings : {};
  const [baseMarks, localMarks, upstreamMarks] = [base, local, upstream].map(marksOf);
  for (const name of [...new Set([...names, ...Object.keys(upstreamMarks), ...Object.keys(localMarks), ...Object.keys(baseMarks)])]) {
    const pair = (state, stateMarks) => ({ value: valueOf(state.settings, name), mark: valueOf(stateMarks, name) });
    const [b, l, u] = [pair(base, baseMarks), pair(local, localMarks), pair(upstream, upstreamMarks)];
    const same = (left, right) => sameJson(left.value, right.value) && sameJson(left.mark, right.mark);
    let chosen;
    if (same(l, u) || same(u, b)) chosen = l;
    else if (same(l, b)) chosen = u;
    else if (!sameJson(l.mark, b.mark) || !sameJson(u.mark, b.mark)) {
      const order = laterMark(l.mark, u.mark);
      if (order === 0) throw new MergeConflict(`The setting ${name} changed differently on both sides.`);
      chosen = order > 0 ? l : u;
    } else {
      throw new MergeConflict(`The setting ${name} changed differently on both sides.`);
    }
    if (chosen.value !== ABSENT) settings[name] = chosen.value;
    if (chosen.mark !== ABSENT) marks[name] = chosen.mark;
  }
  return { settings, personSettings: marks };
}

const gateKey = (item) => isRecord(item) ? item.id : item;
const askedPart = (gate) => {
  if (!isRecord(gate)) return gate;
  const { answer, ...asked } = gate;
  return asked;
};

// A gate keeps what it was asked with; answers on both sides keep the earlier one, and the upstream's on equal times.
function mergeGate(id, base, local, upstream) {
  if (!sameJson(askedPart(local), askedPart(upstream))) throw new MergeConflict(`The user gate ${id} differs between the sides.`);
  if (!isRecord(local)) return local;
  const [b, l, u] = [base, local, upstream].map((gate) => valueOf(gate, "answer"));
  let answer;
  if (sameJson(l, u) || sameJson(u, b)) answer = l;
  else if (sameJson(l, b)) answer = u;
  else if (isRecord(l) && isRecord(u)) answer = String(l.answeredAt) < String(u.answeredAt) ? l : u;
  else throw new MergeConflict(`The user gate ${id} changed differently on both sides.`);
  const { answer: _, ...asked } = local;
  return answer === ABSENT ? asked : { ...asked, answer };
}

// Merge a list of items keyed by id: an item one side removed stays removed, and the merged order follows mergeOrder with upstream additions first.
function mergeList(label, base, local, upstream, keyOf, mergeItem) {
  const index = (list) => new Map(list.map((item) => [keyOf(item), item]));
  const [b, l, u] = [base, local, upstream].map(index);
  const merged = new Map();
  for (const key of new Set([...u.keys(), ...l.keys(), ...b.keys()])) {
    const inBase = b.has(key);
    if (inBase && (!l.has(key) || !u.has(key))) continue;
    if (!l.has(key)) merged.set(key, u.get(key));
    else if (!u.has(key)) merged.set(key, l.get(key));
    else merged.set(key, mergeItem(key, inBase ? b.get(key) : ABSENT, l.get(key), u.get(key)));
  }
  const ids = (map) => [...map.keys()];
  return mergeOrder(label, ids(b), ids(l), ids(u), new Set(merged.keys()), { upstreamFirst: true }).map((key) => merged.get(key));
}

// Entries of either side once by id, except a base entry that either side dropped, ordered by `order` and cut to the newest `limit`.
function mergeUnion(base, local, upstream, keyOf, order, limit) {
  const held = (list) => new Set(list.map(keyOf));
  const [inLocal, inUpstream] = [held(local), held(upstream)];
  const dropped = new Set(base.map(keyOf).filter((key) => !inLocal.has(key) || !inUpstream.has(key)));
  const entries = new Map();
  for (const item of [...local, ...upstream]) if (!dropped.has(keyOf(item))) entries.set(keyOf(item), item);
  return [...entries.values()].sort(order).slice(-limit);
}

const closedOrder = (left, right) => {
  if (left.closedAt !== right.closedAt) return String(left.closedAt) < String(right.closedAt) ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

const STRUCTURED = ["settings", "personSettings", "pending", "history", "active", "closed", "evidence"];

/**
 * The structural merge of a coordination state that changed on two machines: { path, base, local, upstream } as UTF-8 text,
 * base null for a state new on both sides, answering { contents } or { conflict }.
 */
export function mergeCoordinationState(versions) {
  try {
    const parsed = parseVersions(versions, defaultState);
    if (Object.values(parsed).some((state) => !isRecord(state))) throw new MergeConflict("A version of the coordination state is not a JSON object.");
    const [base, local, upstream] = [parsed.base, parsed.local, parsed.upstream].map(normalizeState);
    for (const state of [base, local, upstream]) {
      if (!isRecord(state.settings) || (state.personSettings !== undefined && !isRecord(state.personSettings))) throw new MergeConflict("A version of the coordination state has malformed settings.");
      for (const key of ["active", "pending", "evidence", "closed", "history"]) {
        if (state[key] !== undefined && !Array.isArray(state[key])) throw new MergeConflict(`A version of the coordination state has a malformed ${key}.`);
      }
    }
    const list = (state, key) => state[key] ?? [];
    const has = (key) => [base, local, upstream].some((state) => state[key] !== undefined);
    const { settings, personSettings } = mergeSettings(base, local, upstream);
    const pending = mergeList("The pending user gates", base.pending, local.pending, upstream.pending, gateKey, mergeGate);
    const active = mergeList("The active work", base.active, local.active, upstream.active, (item) => isRecord(item) ? item.slice : item,
      (slice, b, l, u) => mergeUnit(`The active work of ${slice}`, b, l, u));
    const history = mergeUnion(list(base, "history"), list(local, "history"), list(upstream, "history"), (item) => item?.id, historyOrder, HISTORY_LIMIT);
    const closed = mergeUnion(list(base, "closed"), list(local, "closed"), list(upstream, "closed"), (item) => item?.id, closedOrder, CLOSED_LIMIT);
    const removed = new Set(base.evidence.filter((item) => !local.evidence.includes(item) || !upstream.evidence.includes(item)));
    const evidence = [...upstream.evidence.filter((item) => !removed.has(item)), ...local.evidence.filter((item) => !removed.has(item) && !upstream.evidence.includes(item))];
    const rest = mergeScalars(base, local, upstream, STRUCTURED);
    const merged = normalizeState({
      ...rest,
      settings,
      active,
      pending,
      evidence,
      ...(has("closed") || closed.length ? { closed } : {}),
      ...(has("history") ? { history } : {}),
      ...(has("personSettings") || Object.keys(personSettings).length ? { personSettings } : {})
    });
    // No entry is protected here, so both machines fit the same three versions to the same bytes.
    const fitted = fitState(merged);
    if (fitted === null) return { conflict: "The merged coordination state exceeds 1 MiB with its history and closed gates dropped." };
    const { contents } = fitted;
    const { errors } = validateStateValue(parseStoreJson(contents));
    if (errors.length) return { conflict: `The merged coordination state is invalid: ${errors[0]}` };
    return { contents };
  } catch (caught) {
    return { conflict: caught instanceof MergeConflict ? caught.message : `The coordination state versions could not be merged: ${caught.message}` };
  }
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
  await moveLegacyRecords(projectRoot);
  const resolved = await resolveState(projectRoot, initiative);
  await mkdir(path.dirname(resolved.path), { recursive: true });
  return withStateLock(resolved.path, () => withFileLock(resolved.path, async () => applyStateChange(resolved, expectedRevision, changes), error, { renew: Boolean(changes.activeOperations?.length) }));
}

// Resolving a gate by its id removes only that gate, so it holds after any other change, such as the browser answer that prompted it.
function resolvesGatesOnly(changes) {
  const keys = Object.keys(changes ?? {});
  return keys.length === 1 && keys[0] === "gateOperations" && changes.gateOperations.length > 0 && changes.gateOperations.every((operation) => operation?.op === "resolve");
}

async function applyStateChange(resolved, expectedRevision, changes) {
    const current = await loadState(resolved.path);
    if (current.revision !== expectedRevision && !(current.exists && resolvesGatesOnly(changes))) {
      throw error(expectedRevision === "null" ? "invalid_revision" : "revision_conflict", revisionMismatch("coordination state", expectedRevision, current.revision), { current: publicStateResult(resolved, current) });
    }
    if (current.exists && !current.valid) {
      throw error("invalid_state", "The existing state is invalid and was not changed.", { validation: publicStateResult(resolved, current) });
    }
    const before = current.state ?? defaultState();
    if (changes.active !== undefined && JSON.stringify(changes.active) !== JSON.stringify(before.active)) throw error("gate_blocked", "Use typed activeOperations to change active work; array replacement cannot bypass review gates.");
    return withReviewGatesLocked(resolved.root, resolved.initiative, before.active, changes.activeOperations ?? [], async () => {
    const activeResult = await applyActiveOperations(resolved.root, resolved.initiative, before.active, changes.activeOperations ?? []);
    const dropped = droppedGates(before.pending, changes.pending);
    const gateResult = applyGateOperations(changes.pending ?? before.pending, changes.gateOperations ?? []);
    assertAnswersUnchanged(before.pending, gateResult.pending);
    const closed = [...(before.closed ?? []), ...dropped, ...gateResult.closed].slice(-CLOSED_LIMIT);
    const requested = changes.settings === undefined ? null : keepPersonSettings(before, changes.settings);
    const candidate = normalizeState({
      ...before,
      active: activeResult.active,
      ...(requested === null ? {} : { settings: { ...before.settings, ...requested.settings } }),
      pending: gateResult.pending,
      ...(changes.next === undefined ? {} : { next: changes.next }),
      ...(changes.evidence === undefined ? {} : { evidence: changes.evidence }),
      ...(closed.length ? { closed } : {})
    });
    const validation = validateStateValue(candidate);
    if (validation.errors.length > 0) {
      throw error("invalid_state", "The proposed state is invalid and was not written.", { errors: validation.errors, warnings: validation.warnings });
    }
    const contents = stateContents(candidate);
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
      openedGates: gateResult.opened,
      ...(requested?.kept.length ? { keptSettings: requested.kept } : {})
    };
    });
}

export async function answerUserGate({ projectRoot, initiative, id, choice = null, note = null, write = writeRecord }) {
  await moveLegacyRecords(projectRoot);
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
    await write(resolved.root, { kind: "state", initiative: resolved.initiative }, stateContents(candidate));
    const updated = await loadState(resolved.path);
    return { ...publicStateResult(resolved, updated), gate: pending[position] };
  }, error));
}

/**
 * The review app's one write of a person's action on coordination state, under the state lock.
 * prepare(current) sees { exists, revision, state, valid } as the lock found it and returns null to change nothing,
 * or { entry, setting?: { name, value }, answer?: { id, choice, note } }: a setting is stored and marked in personSettings, an answer is recorded on its gate with its author and entry,
 * and the entry joins history at its place, in the same write.
 */
export async function recordPersonAction({ projectRoot, initiative, prepare }) {
  const decide = async (resolved, current) => {
    const change = await prepare({ exists: current.exists, revision: current.revision, state: current.state, valid: current.valid });
    if (change !== null && current.exists && !current.valid) {
      throw error("invalid_state", "The existing state is invalid and was not changed.", { validation: publicStateResult(resolved, current) });
    }
    return change;
  };
  // The checks run first on the state as it is read, so a refused or unchanged action moves no legacy record and creates no folder.
  const preview = await resolveState(projectRoot, initiative);
  const previewed = await loadState(preview.path);
  if (await decide(preview, previewed) === null) return { ...publicStateResult(preview, previewed), entry: null };
  await moveLegacyRecords(projectRoot);
  const resolved = await resolveState(projectRoot, initiative);
  await mkdir(path.dirname(resolved.path), { recursive: true });
  return withStateLock(resolved.path, () => withFileLock(resolved.path, async () => {
    const current = await loadState(resolved.path);
    const change = await decide(resolved, current);
    if (change === null) return { ...publicStateResult(resolved, current), entry: null };
    const { entry, setting, answer } = change;
    const problem = historyEntryProblem(entry);
    if (problem) throw error("invalid_changes", `The history entry is invalid: ${problem}.`);
    const before = current.state ?? defaultState();
    const candidate = { ...before, history: insertHistoryEntry(before.history, entry) };
    if (setting) {
      if (!SETTING_KEYS.has(setting.name)) throw error("invalid_changes", `${setting.name} is not an initiative setting.`);
      candidate.settings = { ...before.settings, [setting.name]: setting.value };
      candidate.personSettings = { ...(before.personSettings ?? {}), [setting.name]: { at: entry.at, entry: entry.id } };
    }
    if (answer) {
      const position = before.pending.findIndex((item) => isRecord(item) && item.id === answer.id);
      if (position === -1) throw error("unknown_gate", "The question is no longer open; the agent resolved or withdrew it.");
      if (before.pending[position].answer) throw error("gate_answered", "The question already has an answer.");
      const answerProblemText = answerProblem(before.pending[position], answer.choice, answer.note);
      if (answerProblemText) throw error("invalid_answer", `The answer is invalid: ${answerProblemText}.`);
      candidate.pending = [...before.pending];
      candidate.pending[position] = { ...before.pending[position], answer: { choice: answer.choice, note: answer.note, via: "browser", answeredAt: entry.at, by: entry.by, entry: entry.id } };
    }
    const normalized = normalizeState(candidate);
    const validation = validateStateValue(normalized);
    if (validation.errors.length > 0) {
      throw error("invalid_state", "The changed state is invalid and was not written.", { errors: validation.errors });
    }
    await writeRecord(resolved.root, { kind: "state", initiative: resolved.initiative }, stateContents(normalized, entry.id));
    return { ...publicStateResult(resolved, await loadState(resolved.path)), created: !current.exists, entry };
  }, error));
}

// The recovery note is a human document, so it sits in the slice's plans folder beside slice.md, in the record store when the project names one.
export async function checkpointPause({ projectRoot, initiative, expectedRevision, activeSlice, recoveryContent, changes }) {
  validateChanges(changes);
  if (typeof activeSlice !== "string" || !SLUG_PATTERN.test(activeSlice) || typeof recoveryContent !== "string" || !recoveryContent.trim() || Buffer.byteLength(recoveryContent) > 65536) {
    throw error("invalid_pause", "An active slice and a recovery note of at most 64 KiB are required.");
  }
  await moveLegacyRecords(projectRoot);
  const resolved = await resolveState(projectRoot, initiative);
  const folder = await sliceDocumentFolder(resolved.root, resolved.initiative, activeSlice);
  if (folder === null || resolved.directory === null) {
    throw error("invalid_config", "The workflow config disables the plans path, so the recovery note has no location.");
  }
  const recovery = path.resolve(resolved.root, folder, "recovery.md");
  if (!isInside(resolved.root, recovery)) {
    throw error("invalid_path", "The recovery note must be inside the project root.");
  }
  const recoveryRelative = path.relative(resolved.root, recovery).split(path.sep).join("/");
  const inStore = await inArtifactStore(resolved.root, recoveryRelative);
  if (!inStore) await assertNearestExistingPathInside(resolved.root, path.dirname(recovery));
  await mkdir(path.dirname(resolved.path), { recursive: true });
  return withStateLock(resolved.path, () => withFileLock(resolved.path, async () => {
    const current = await loadState(resolved.path);
    if (current.revision !== expectedRevision) {
      throw error(expectedRevision === "null" ? "invalid_revision" : "revision_conflict", revisionMismatch("coordination state", expectedRevision, current.revision), { current: publicStateResult(resolved, current) });
    }
    if (!current.valid || !current.state?.active.some((item) => item.slice === activeSlice)) {
      throw error("invalid_pause", "The slice is not active in the current coordination state.");
    }
    const stateRelativeRecovery = path.relative(path.resolve(resolved.root, resolved.directory), recovery).split(path.sep).join("/");
    const remainingActive = current.state.active.filter((item) => item.slice !== activeSlice);
    if (changes.active !== undefined && JSON.stringify(changes.active) !== JSON.stringify(remainingActive)) {
      throw error("invalid_pause", "The pause must preserve every other active slice.");
    }
    if (changes.activeOperations !== undefined) throw error("invalid_pause", "A pause releases only its named slice; other active operations are not allowed.");
    let previous;
    if (inStore) previous = await readArtifactText(resolved.root, recoveryRelative);
    else {
      const existing = await lstat(recovery).catch((caught) => caught.code === "ENOENT" ? null : Promise.reject(caught));
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw error("invalid_path", "The recovery note must be a regular file.");
      previous = existing ? await readFile(recovery, "utf8") : null;
    }
    try {
      if (!inStore) await conservationStore.registerCoordinationOutputs(resolved.root, [recoveryRelative]);
      await writeArtifactText(resolved.root, recoveryRelative, recoveryContent.endsWith("\n") ? recoveryContent : `${recoveryContent}\n`, { write: (target, text) => conservationStore.writeManaged(resolved.root, target, text) });
      const result = await applyStateChange(resolved, expectedRevision, {
        ...changes,
        active: undefined,
        activeOperations: [{ op: "release", slice: activeSlice }],
        evidence: [...new Set([...current.state.evidence, ...(changes.evidence ?? []), stateRelativeRecovery])]
      });
      return { ...result, recoveryPath: recoveryRelative, recoveryDigest: createHash("sha256").update(recoveryContent.endsWith("\n") ? recoveryContent : `${recoveryContent}\n`).digest("hex"), pausedSlice: activeSlice };
    } catch (caught) {
      if (inStore) await writeArtifactText(resolved.root, recoveryRelative, previous).catch(() => {});
      else if (previous === null) await rm(recovery, { force: true }).catch(() => {});
      else await writeAtomically(recovery, previous).catch(() => {});
      throw caught;
    }
  }, error));
}
