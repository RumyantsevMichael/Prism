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
import { refuseShipped } from "./shipped-history.mjs";
import { initiativeDirectory, readWorkflowConfig } from "./workflow-config.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { HOSTS } from "../session/launch-hosts.mjs";
import { NAME_RULE_MESSAGES, RUN_KINDS, validEffort, validModel, validProvider } from "../session/run-options.mjs";

const SCHEMA_VERSION = 1;

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "settings", "active", "pending", "next", "evidence", "closed", "history", "personSettings"]);
// Only the review app's action registry writes the person's history and setting marks, so agents' state changes never carry them.
const REGISTRY_KEYS = new Set(["history", "personSettings"]);
// The initiative settings that coordination state accepts, in the order the review app lists their actions.
export const INITIATIVE_SETTINGS = Object.freeze(["host", "autonomy", "commit", "push", "continuation", "review", "models"]);
const SETTING_KEYS = new Set(INITIATIVE_SETTINGS);

// The models setting keeps one entry per supported host: a provider and a run choice { model, effort, typed } per kind, each part
// left out for the host default, so the stored value is compact and a host the person never chose for holds nothing.
const RUN_HOSTS: string[] = HOSTS.map(({ host }) => host);
const KIND_NAMES: string[] = RUN_KINDS.map(({ kind }) => kind);
const AGENT_KINDS: string[] = RUN_KINDS.filter(({ purpose }) => purpose === "agents").map(({ kind }) => kind);
// The earlier models value named one model per role for every host; each role is now an agent kind, and each name a typed choice,
// or an earlier name where it breaks the model rule.
const EARLIER_ROLES: Readonly<Record<string, string>> = Object.freeze({ delivery: "designImplementation", review: "codeReview", securityReview: "securityReview", examples: "gateSummary" });
const EARLIER_DEFAULTS = new Set(["defaults", "host defaults"]);
const EARLIER_NAME_LIMIT = 200;
const EARLIER_NAME = /^[^\s\p{Cc}]+(?: [^\s\p{Cc}]+)*$/u;

/** Whether a name keeps the earlier-name rule: 1 to 200 characters, no control character, and only single spaces between its words. */
export function validEarlierName(name: unknown) {
  return typeof name === "string" && EARLIER_NAME.test(name) && [...name].length <= EARLIER_NAME_LIMIT;
}

/** Why an earlier name is not offered: no host takes it as a model, so it is shown and refused until the person replaces it. */
export const earlierReason = (hostLabel: string, earlier: string) => `Prism kept the earlier model name ${earlier}, which ${hostLabel} cannot take as a model.`;

// An earlier name keeps its words: each run of white space and control characters is one space, with none at either end, and at most 200 characters.
function earlierName(name: string) {
  return [...name.replace(/[\s\p{Cc}]+/gu, " ").trim()].slice(0, EARLIER_NAME_LIMIT).join("").trimEnd();
}

function earlierAssignment(value: any) {
  return isRecord(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, name]) => Object.hasOwn(EARLIER_ROLES, key) && typeof name === "string");
}

// One earlier name as a run choice: a typed model where it keeps the model rule once trimmed, else an earlier name, and null when nothing is left.
function earlierChoice(name: string) {
  if (validModel(name.trim())) return { model: name.trim(), typed: true };
  const earlier = earlierName(name);
  return earlier ? { earlier } : null;
}

/** A models value in the per-host shape: an earlier host defaults value reads as no choice, and an earlier assignment as the choices of every host. */
export function migratedModels(value: any) {
  if (typeof value === "string" && EARLIER_DEFAULTS.has(value)) return {};
  if (!earlierAssignment(value)) return value;
  const entry = () => Object.fromEntries(Object.entries(EARLIER_ROLES).filter(([role]) => Object.hasOwn(value, role)).map(([role, kind]) => [kind, earlierChoice(value[role])]).filter(([, choice]) => choice !== null));
  return Object.fromEntries(RUN_HOSTS.map((host) => [host, entry()]));
}

/** The seven effective setting values, each stored or else its default, and personSettings, the names of the settings the person set. */
export function effectiveSettings(state: any) {
  const stored = isRecord(state?.settings) ? state.settings : {};
  const autonomy = stored.autonomy ?? "conservative";
  return {
    host: stored.host ?? null,
    autonomy,
    commit: stored.commit ?? (autonomy === "full" ? "on" : "off"),
    push: stored.push ?? "off",
    continuation: stored.continuation ?? "auto",
    review: stored.review ?? "marked",
    models: stored.models === undefined ? {} : migratedModels(stored.models),
    personSettings: INITIATIVE_SETTINGS.filter((name) => isRecord(state?.personSettings) && Object.hasOwn(state.personSettings, name))
  };
}

// An agent's settings write keeps each setting the person changed in the review app, and lists what it kept.
function keepPersonSettings(before: any, requested: any) {
  const marks = isRecord(before.personSettings) ? before.personSettings : {};
  const settings = { ...requested };
  const kept = [];
  for (const [name, value] of Object.entries<any>(requested)) {
    if (!Object.hasOwn(marks, name) || !Object.hasOwn(before.settings, name) || JSON.stringify(value) === JSON.stringify(before.settings[name])) continue;
    settings[name] = before.settings[name];
    kept.push({ setting: name, kept: before.settings[name], requested: value });
  }
  return { settings, kept };
}
const ACTIVE_KEYS = new Set(["slice", "activity", "label", "workers", "workspace", "reviewLanes", "findingsPath", "reviewPath"]);
const GATE_KINDS = new Set(["visual-review", "correctness", "decision", "assistance"]);
const GATE_KEYS = new Set(["id", "kind", "slice", "question", "context", "artifacts", "options", "recommended", "askedAt", "standing", "answer"]);
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
const SETTING_VALUES: Record<string, Set<string>> = {
  host: new Set(RUN_HOSTS),
  autonomy: new Set(["conservative", "broad", "full"]),
  commit: new Set(["on", "off"]),
  push: new Set(["on", "off"]),
  continuation: new Set(["auto", "stepwise"]),
  review: new Set(["marked", "recommended", "all"])
};

export class CoordinationStateError extends Error {
  declare code: string;
  [detail: string]: unknown;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CoordinationStateError";
    this.code = code;
    Object.assign(this, details);
  }
}

function error(code: any, message: any, details = {}) {
  return new CoordinationStateError(code, message, details);
}

function isRecord(value: any) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertNearestExistingPathInside(root: string, target: string) {
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
async function resolveState(projectRoot: string, initiative: string) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw error("invalid_project_root", "The project root must be an absolute path.");
  }
  if (typeof initiative !== "string" || !SLUG_PATTERN.test(initiative)) {
    throw error("invalid_path", "The initiative identifier must use letters, digits, hyphens, or underscores.");
  }
  const located = await locateRecord(projectRoot, { kind: "state", initiative });
  const config = await readWorkflowConfig(located.root);
  return { root: located.root, initiative, path: located.target, displayPath: located.path, directory: initiativeDirectory(config, initiative), store: (config.workspace?.store ?? null) !== null };
}

function revisionOf(contents: any) {
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

// An earlier models value reads and writes migrated, like a retired setting that is dropped.
function withoutRetiredSettings(settings: any) {
  if (!isRecord(settings)) {
    return settings;
  }
  const kept: any = Object.fromEntries(Object.entries<any>(settings).filter(([key]) => !RETIRED_SETTINGS.has(key)));
  if (kept.models !== undefined) kept.models = migratedModels(kept.models);
  return kept;
}

function normalizeState(raw: any) {
  if (!isRecord(raw)) {
    return raw;
  }
  const state: Record<string, any> = {
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
  for (const [key, value] of Object.entries<any>(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      state[key] = value;
    }
  }
  return state;
}

function addError(errors: any, pathValue: any, message: any) {
  errors.push(`${pathValue}: ${message}`);
}

function addWarning(warnings: any, pathValue: any, message: any) {
  warnings.push(`${pathValue}: ${message}`);
}

function validateStringArray(value: any, pathValue: any, errors: any) {
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

function validateModels(value: any, errors: any) {
  if (typeof value === "string") {
    if (!EARLIER_DEFAULTS.has(value)) addError(errors, "settings.models", "must be an object keyed by host");
    return;
  }
  if (!isRecord(value)) {
    addError(errors, "settings.models", "must be an object keyed by host");
    return;
  }
  // Every name of an earlier assignment migrates, to a typed choice, an earlier name, or the host default.
  if (earlierAssignment(value)) return;
  for (const [host, entry] of Object.entries(value)) {
    const at = `settings.models.${host}`;
    if (!RUN_HOSTS.includes(host)) {
      addError(errors, at, `is not a supported host; the hosts are ${RUN_HOSTS.join(", ")}`);
      continue;
    }
    if (!isRecord(entry)) {
      addError(errors, at, "must be an object of a provider and run choices");
      continue;
    }
    for (const [key, item] of Object.entries(entry as Record<string, unknown>)) {
      if (key === "provider") {
        if (!validProvider(item)) addError(errors, `${at}.provider`, NAME_RULE_MESSAGES.provider);
      } else if (!KIND_NAMES.includes(key)) {
        addError(errors, `${at}.${key}`, `is not a kind of run choice; the kinds are ${KIND_NAMES.join(", ")}`);
      } else {
        validateRunChoice(item, `${at}.${key}`, errors, AGENT_KINDS.includes(key));
      }
    }
  }
}

// A stored run choice leaves out each host default, so typed appears only as true and only with a model; an agent kind's choice
// may instead keep an earlier name alone.
function validateRunChoice(value: any, at: any, errors: any, agent: any) {
  if (!isRecord(value)) {
    addError(errors, at, "must be an object of model, effort, and typed");
    return;
  }
  if (Object.hasOwn(value, "earlier")) {
    if (!agent) addError(errors, `${at}.earlier`, "is kept only by an agent's choice, never the coordinator's");
    else if (Object.keys(value).length > 1) addError(errors, `${at}.earlier`, "stands alone in its choice, without a model, an effort, or typed");
    else if (!validEarlierName(value.earlier)) addError(errors, `${at}.earlier`, "has 1 to 200 characters, no control character, and only single spaces between its words");
    return;
  }
  for (const key of Object.keys(value)) {
    if (!["model", "effort", "typed"].includes(key)) addError(errors, `${at}.${key}`, "is not a part of a run choice; its parts are model, effort, typed, and on an agent's choice an earlier name alone");
  }
  if (value.model !== undefined && !validModel(value.model)) addError(errors, `${at}.model`, NAME_RULE_MESSAGES.model);
  if (value.effort !== undefined && !validEffort(value.effort)) addError(errors, `${at}.effort`, NAME_RULE_MESSAGES.effort);
  if (value.typed !== undefined && (value.typed !== true || value.model === undefined)) addError(errors, `${at}.typed`, "is true only beside a model name the person typed, and left out otherwise");
}

function validateSettings(value: any, errors: any, warnings: any) {
  if (!isRecord(value)) {
    addError(errors, "settings", "must be an object");
    return;
  }
  for (const [key, setting] of Object.entries<any>(value)) {
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

function validateActive(value: any, errors: any, warnings: any) {
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
      entry.workers.forEach((worker: any, workerIndex: any) => {
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

function validGatePath(value: any) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.includes("\\")) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.startsWith("../");
}

function boundedText(value: any, limit: number) {
  return typeof value === "string" && value.trim() !== "" && value.length <= limit;
}

// A new question must stand on its own; gates recorded before these fields existed stay valid as they are.
function askProblems(gate: any) {
  const problems = [];
  if (CONTEXT_KINDS.has(gate.kind) && gate.context === undefined) {
    problems.push("context is required for a decision or assistance gate: in plain language, say what happened, what was tried, what the choice changes, and give a concrete example, so a person who has not followed the run can decide from the gate alone");
  }
  if (gate.kind !== "decision") return problems;
  const missing = (gate.options ?? []).filter((option: any) => isRecord(option) && option.consequence === undefined).map((option: any) => option.id);
  if (missing.length) problems.push(`each option needs a consequence, one sentence on what happens if the person picks it; missing for ${missing.join(", ")}`);
  if (gate.recommended === undefined) {
    problems.push(gate.options?.length
      ? "recommended is required: { option, reason } naming the option you recommend and why"
      : "recommended is required: { reason } with the answer you recommend and why");
  }
  return problems;
}

function validateGate(entry: any, entryPath: any, errors: any) {
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
    entry.artifacts.forEach((item: any, index: number) => {
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
      entry.options.forEach((option: any, index: number) => {
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
    } else if (recommended.option !== undefined && !(entry.options ?? []).some((option: any) => isRecord(option) && option.id === recommended.option)) {
      addError(errors, `${entryPath}.recommended.option`, "must name one of the gate's options");
    }
  }
  if (typeof entry.askedAt !== "string" || Number.isNaN(Date.parse(entry.askedAt))) {
    addError(errors, `${entryPath}.askedAt`, "must be an ISO timestamp");
  }
  if (entry.standing !== undefined) {
    if (entry.kind !== "correctness") addError(errors, `${entryPath}.standing`, "is recorded only on a correctness gate");
    else if (!wellFormedStanding(entry.standing)) addError(errors, `${entryPath}.standing`, "must be { runs, slices, repositories, adrs } as the ask operation records it");
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

const STANDING_ITEMS_MAX = 1000;
const exactly = (value: any, keys: any) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key: any) => Object.hasOwn(value, key));
const shortText = (value: any, max: any) => typeof value === "string" && value !== "" && value.length <= max;

// What an initiative stood at when a correctness gate was asked: each leaf's latest passing run id, or null, each slice.md's version,
// the repositories that each slice's links resolve in, and the version of each ADR that its ship would accept.
function wellFormedStanding(value: any) {
  const listed = (key: any) => Array.isArray(value[key]) && value[key].length <= STANDING_ITEMS_MAX;
  const version = (item: any) => exactly(item, ["scope", "path", "version"]) && shortText(item.scope, 200) && shortText(item.path, 1000) && /^sha256:[0-9a-f]{64}$/.test(item.version);
  if (!exactly(value, ["runs", "slices", "repositories", "adrs"]) || !["runs", "slices", "repositories", "adrs"].every(listed)) return false;
  return value.runs.every((item: any) => exactly(item, ["slice", "run"]) && shortText(item.slice, 200) && (item.run === null || shortText(item.run, 200)))
    && value.slices.every(version)
    && value.repositories.every((item: any) => exactly(item, ["folder", "repositories"]) && shortText(item.folder, 1000) && Array.isArray(item.repositories) && item.repositories.length <= STANDING_ITEMS_MAX && item.repositories.every((name: string) => shortText(name, 200)))
    && value.adrs.every(version);
}

// Each gate kind accepts its own choices; a note carries the reason whenever the answer is not a plain acceptance.
function answerProblem(gate: any, choice: any, note: any) {
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
    } else if (!(gate.options ?? []).some((option: any) => option.id === choice)) {
      return "choice must be one of the gate options or null";
    }
  }
  return null;
}

function validatePending(value: any, errors: any) {
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

function validateClosed(value: any, errors: any) {
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
    const { closedAt, reason, choice, ...gate } = entry;
    validateGate(gate, entryPath, errors);
    if (choice !== undefined && (gate.kind !== "decision" || !(gate.options ?? []).some((option: any) => option?.id === choice))) addError(errors, `${entryPath}.choice`, "must be the id of one of the decision gate's options");
    else if (choice !== undefined && conflictingChoice(gate.answer, choice)) addError(errors, `${entryPath}.choice`, "must match the option of the gate's browser answer");
    if (typeof closedAt !== "string" || Number.isNaN(Date.parse(closedAt))) addError(errors, `${entryPath}.closedAt`, "must be an ISO timestamp");
    if (reason !== undefined && (typeof reason !== "string" || !reason.trim() || reason.length > REASON_LIMIT)) addError(errors, `${entryPath}.reason`, `must be a non-empty reason of at most ${REASON_LIMIT} characters`);
  });
}

// A browser answer that chose an option leaves no room for a different choice on the closed gate.
const conflictingChoice = (answer: any, choice: any) => isRecord(answer) && typeof answer.choice === "string" && answer.choice !== choice;

function closedGate(gate: any, reason: string | null, choice?: any) {
  return { ...gate, closedAt: new Date().toISOString(), ...(reason ? { reason } : {}), ...(choice === undefined ? {} : { choice }) };
}

// Replacing the pending list may drop answered gates, but an unanswered question is withdrawn only through resolve with a reason.
function droppedGates(before: any, replacement: any) {
  if (replacement === undefined) return [];
  const kept = new Set(replacement.filter(isRecord).map((gate: any) => gate.id));
  const dropped = before.filter((gate: any) => isRecord(gate) && !kept.has(gate.id));
  const unanswered = dropped.find((gate: any) => !gate.answer);
  if (unanswered) {
    throw error("invalid_changes", `The pending list drops the unanswered gate ${unanswered.id}; withdraw it with a resolve operation and a reason.`);
  }
  return dropped.map((gate: any) => closedGate(gate, null));
}

function applyGateOperations(pending: any, operations: any, standing = null) {
  const next = [...pending];
  const opened: any[] = [];
  const closed: any[] = [];
  const superseded: any[] = [];
  operations.forEach((operation: any, index: number) => {
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
        askedAt: new Date().toISOString(),
        // With a record store, a correctness gate records what the initiative stands at, which a ship that it confirms compares with the initiative then.
        ...(operation.kind === "correctness" && standing !== null ? { standing } : {})
      };
      const errors: any[] = [];
      validateGate(gate, `gateOperations[${index}]`, errors);
      const problems = errors.length ? [] : askProblems(gate);
      if (problems.length) {
        throw error("gate_context_missing", `The question cannot be asked yet: ${problems.join("; ")}.`, { errors: problems });
      }
      if (errors.length) {
        throw error("invalid_changes", `The user gate is invalid: ${errors.join("; ")}.`, { errors });
      }
      // A new correctness gate asks the person to confirm the initiative as it stands now, so it supersedes each earlier one the person already answered,
      // which closes with a reason naming the new gate, and a ship never meets an answered question that no one acts on; an unanswered one stays the person's question.
      if (gate.kind === "correctness") {
        const answered = next.filter((earlier) => isRecord(earlier) && earlier.kind === "correctness" && earlier.answer);
        for (const earlier of answered) {
          closed.push(closedGate(earlier, `The newer correctness gate ${gate.id} supersedes this answered one.`));
          superseded.push(earlier.id);
          next.splice(next.indexOf(earlier), 1);
        }
      }
      next.push(gate);
      opened.push({ id: gate.id, kind: gate.kind, slice: gate.slice ?? null });
    } else if (operation.op === "resolve") {
      const unknown = Object.keys(operation).filter((key) => !["op", "id", "reason", "choice"].includes(key));
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
      // A choice the user gave in the conversation stays on the closed gate, so a later operation can act on it.
      if (operation.choice !== undefined && (next[position].kind !== "decision" || !(next[position].options ?? []).some((option: any) => option?.id === operation.choice))) {
        throw error("invalid_changes", `gateOperations[${index}].choice must be the id of one of the options of the decision gate ${operation.id}.`);
      }
      // The user's browser answer is their decision, so a choice from the conversation may repeat it but never replace it.
      if (operation.choice !== undefined && conflictingChoice(next[position].answer, operation.choice)) {
        throw error("invalid_changes", `gateOperations[${index}].choice ${operation.choice} differs from the option ${next[position].answer.choice} that the user chose for the gate ${operation.id} in the review browser.`);
      }
      closed.push(closedGate(next[position], reason, operation.choice));
      next.splice(position, 1);
    } else {
      throw error("invalid_changes", `gateOperations[${index}].op must be ask or resolve.`);
    }
  });
  return { pending: next, opened, closed, superseded: superseded.sort() };
}

// Only the review browser records answers, so agent updates may keep an answer but never add or change one,
// and a gate that has an answer stays as the person was shown it: an update may drop it, which closes it, but changes nothing else about it.
// What a correctness gate records the initiative stood at is Prism's own, so only the ask operation that opens the gate records it.
function assertAnsweredGatesUnchanged(before: any, after: any, opened: any) {
  const previous = new Map<string, any>(before.filter(isRecord).map((gate: any) => [gate.id, gate]));
  const asked = new Set(opened.map((gate: any) => gate.id));
  for (const gate of after.filter(isRecord)) {
    if (asked.has(gate.id)) continue;
    const earlier = previous.get(gate.id);
    if (gate.answer !== undefined && JSON.stringify(earlier?.answer ?? null) !== JSON.stringify(gate.answer)) {
      throw error("invalid_changes", `The user gate ${gate.id} has an answer that only the review browser can record.`);
    }
    if (earlier?.answer !== undefined && canonicalJson(earlier) !== canonicalJson(gate)) {
      throw error("invalid_changes", `The user gate ${gate.id} has an answer, so it stays as the person was shown it: drop it from pending to close it, or ask a new question with a gateOperations ask.`);
    }
    if (canonicalJson(gate.standing ?? null) !== canonicalJson(earlier?.standing ?? null)) {
      throw error("invalid_changes", `The user gate ${gate.id} would record what the initiative stood at, which only Prism records when a gateOperations ask opens a correctness gate.`);
    }
  }
}

// A correctness gate asked in a project with a record store records what the initiative stands at, read before the state lock is taken, so the read never waits on a store sync while holding it.
async function askedStanding(resolved: any, changes: any) {
  if (!resolved.store || !(changes.gateOperations ?? []).some((operation: any) => isRecord(operation) && operation.op === "ask" && operation.kind === "correctness")) return null;
  const { initiativeStanding } = await import("./ship-standing.mjs");
  // A gate whose standing could not be read, as one asked while the store is unreadable, or that is more than a gate records, is still asked, and confirms no ship: the ship then asks for a new one.
  const standing = await initiativeStanding(resolved.root, resolved.initiative).catch(() => null);
  return standing !== null && wellFormedStanding(standing) ? standing : null;
}

const nullableText = (value: any) => value === null || (typeof value === "string" && value.length <= 200);

function validAuthor(value: any) {
  return isRecord(value) && Object.keys(value).every((key) => AUTHOR_KEYS.has(key)) && nullableText(value.name) && nullableText(value.email) && typeof value.checkout === "string" && value.checkout.trim() !== "" && value.checkout.length <= 400;
}

const validTime = (value: any) => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** The order of a history: ascending by the time of the machine that applied each entry, and then by id. */
export function historyOrder(left: any, right: any) {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** A history with one more entry at its place in history order, keeping the newest entries within the limit. */
export function insertHistoryEntry(history: any, entry: any, limit = HISTORY_LIMIT) {
  const entries = [...(history ?? [])];
  let position = entries.length;
  while (position > 0 && historyOrder(entries[position - 1], entry) > 0) position -= 1;
  entries.splice(position, 0, entry);
  return entries.slice(-limit);
}

/** The problem of a history entry, or null when it is well formed. */
export function historyEntryProblem(entry: any) {
  if (!isRecord(entry) || Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))) return "must contain only id, action, target, before, after, at, by, and via";
  if (typeof entry.id !== "string" || !ENTRY_ID.test(entry.id)) return "id must be 32 lowercase hexadecimal characters";
  for (const key of ["action", "target", "via"]) if (typeof entry[key] !== "string" || !entry[key].trim() || entry[key].length > 400) return `${key} must be a non-empty text`;
  if (!Object.hasOwn(entry, "before") || !Object.hasOwn(entry, "after")) return "before and after must be present";
  if (!validTime(entry.at)) return "at must be an ISO timestamp";
  if (!validAuthor(entry.by)) return "by must be an author { name, email, checkout }";
  return null;
}

function validateHistory(value: any, errors: any) {
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

function validatePersonSettings(value: any, errors: any) {
  if (!isRecord(value)) {
    addError(errors, "personSettings", "must be an object");
    return;
  }
  for (const [key, mark] of Object.entries<any>(value)) {
    if (!SETTING_KEYS.has(key)) addError(errors, `personSettings.${key}`, "is not an initiative setting");
    else if (!isRecord(mark) || Object.keys(mark).some((name) => name !== "at" && name !== "entry") || !validTime(mark.at) || typeof mark.entry !== "string" || !ENTRY_ID.test(mark.entry)) addError(errors, `personSettings.${key}`, "must be { at, entry } with an ISO time and a history entry id");
  }
}

function validateStateValue(raw: any) {
  const errors: any[] = [];
  const warnings: any[] = [];
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

function validateChanges(changes: any) {
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

async function loadState(statePath: any) {
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

function publicStateResult(resolved: any, loaded: any) {
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

const serialize = (state: any) => `${JSON.stringify(state, null, 2)}\n`;
const fits = (contents: any) => Buffer.byteLength(contents) <= STATE_MAX_BYTES;

// The smallest count in [0, max] whose drop makes the state fit, or null when even max does not; a larger drop never grows the state.
function fewestDrops(max: any, contentsAfter: any) {
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
function fitState(state: any, keep = null) {
  const contents = serialize(state);
  if (fits(contents)) return { state, contents };
  const history = Array.isArray(state.history) ? state.history : [];
  const droppable = history.filter((item: any) => item?.id !== keep);
  const withoutHistory = (count: number) => {
    const gone = new Set(droppable.slice(0, count));
    return { ...state, ...(state.history === undefined ? {} : { history: history.filter((item: any) => !gone.has(item)) }) };
  };
  const historyDrops = fewestDrops(droppable.length, (count: number) => serialize(withoutHistory(count)));
  if (historyDrops !== null) {
    const fitted = withoutHistory(historyDrops);
    return { state: fitted, contents: serialize(fitted) };
  }
  const trimmed = withoutHistory(droppable.length);
  const closed = Array.isArray(state.closed) ? state.closed : [];
  const withoutClosed = (count: number) => ({ ...trimmed, ...(state.closed === undefined ? {} : { closed: closed.slice(count) }) });
  const closedDrops = fewestDrops(closed.length, (count: number) => serialize(withoutClosed(count)));
  if (closedDrops === null) return null;
  const fitted = withoutClosed(closedDrops);
  return { state: fitted, contents: serialize(fitted) };
}

// Every coordination state write serializes through here, so no state that a writer accepts exceeds the limit a merge applies.
function stateContents(state: any, keep = null) {
  const fitted = fitState(state, keep);
  if (fitted === null) throw error("artifact_too_large", "The coordination state exceeds 1 MiB with its history and closed gates dropped and was not written.");
  return fitted.contents;
}

function changedFields(before: any, after: any) {
  return ["settings", "active", "pending", "next", "evidence", "closed"].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after[key]));
}

const ABSENT = Symbol("absent");
const sameJson = (left: any, right: any) => (left === ABSENT ? "\0absent" : canonicalJson(left)) === (right === ABSENT ? "\0absent" : canonicalJson(right));
const valueOf = (record: any, key: any) => isRecord(record) && Object.hasOwn(record, key) ? record[key] : ABSENT;

// A person's mark orders by its time and then by its entry id; a side without a mark comes before any mark.
function laterMark(left: any, right: any) {
  if (left === ABSENT || right === ABSENT) return left === ABSENT ? (right === ABSENT ? 0 : -1) : 1;
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  return left.entry < right.entry ? -1 : left.entry > right.entry ? 1 : 0;
}

// Each setting merges with its person mark: a setting both sides changed differently takes the side the person changed later.
function mergeSettings(base: any, local: any, upstream: any) {
  const names = [...new Set([...Object.keys(upstream.settings), ...Object.keys(local.settings), ...Object.keys(base.settings)])];
  const settings: Record<string, any> = {};
  const marks: Record<string, any> = {};
  const marksOf = (state: any) => isRecord(state.personSettings) ? state.personSettings : {};
  const [baseMarks, localMarks, upstreamMarks] = [base, local, upstream].map(marksOf);
  for (const name of [...new Set([...names, ...Object.keys(upstreamMarks), ...Object.keys(localMarks), ...Object.keys(baseMarks)])]) {
    const pair = (state: any, stateMarks: any) => ({ value: valueOf(state.settings, name), mark: valueOf(stateMarks, name) });
    const [b, l, u] = [pair(base, baseMarks), pair(local, localMarks), pair(upstream, upstreamMarks)];
    const same = (left: any, right: any) => sameJson(left.value, right.value) && sameJson(left.mark, right.mark);
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

const gateKey = (item: any) => isRecord(item) ? item.id : item;
const askedPart = (gate: any) => {
  if (!isRecord(gate)) return gate;
  const { answer, ...asked } = gate;
  return asked;
};

// A gate keeps what it was asked with; answers on both sides keep the earlier one, and the upstream's on equal times.
function mergeGate(id: string, base: any, local: any, upstream: any) {
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
function mergeList(label: string, base: any, local: any, upstream: any, keyOf: any, mergeItem: any) {
  const index = (list: any) => new Map(list.map((item: any) => [keyOf(item), item]));
  const [b, l, u] = [base, local, upstream].map(index);
  const merged = new Map();
  for (const key of new Set([...u.keys(), ...l.keys(), ...b.keys()])) {
    const inBase = b.has(key);
    if (inBase && (!l.has(key) || !u.has(key))) continue;
    if (!l.has(key)) merged.set(key, u.get(key));
    else if (!u.has(key)) merged.set(key, l.get(key));
    else merged.set(key, mergeItem(key, inBase ? b.get(key) : ABSENT, l.get(key), u.get(key)));
  }
  const ids = (map: any) => [...map.keys()];
  return mergeOrder(label, ids(b), ids(l), ids(u), new Set(merged.keys()), { upstreamFirst: true }).map((key) => merged.get(key));
}

// Entries of either side once by id, except a base entry that either side dropped, ordered by `order` and cut to the newest `limit`.
function mergeUnion(base: any, local: any, upstream: any, keyOf: any, order: any, limit: number) {
  const held = (list: any) => new Set(list.map(keyOf));
  const [inLocal, inUpstream] = [held(local), held(upstream)];
  const dropped = new Set(base.map(keyOf).filter((key: any) => !inLocal.has(key) || !inUpstream.has(key)));
  const entries = new Map();
  for (const item of [...local, ...upstream]) if (!dropped.has(keyOf(item))) entries.set(keyOf(item), item);
  return [...entries.values()].sort(order).slice(-limit);
}

const closedOrder = (left: any, right: any) => {
  if (left.closedAt !== right.closedAt) return String(left.closedAt) < String(right.closedAt) ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

const STRUCTURED = ["settings", "personSettings", "pending", "history", "active", "closed", "evidence"];

/**
 * The structural merge of a coordination state that changed on two machines: { path, base, local, upstream } as UTF-8 text,
 * base null for a state new on both sides, answering { contents } or { conflict }.
 */
export function mergeCoordinationState(versions: any) {
  try {
    const parsed = parseVersions(versions, defaultState);
    if (Object.values<any>(parsed).some((state) => !isRecord(state))) throw new MergeConflict("A version of the coordination state is not a JSON object.");
    const [base, local, upstream] = [parsed.base, parsed.local, parsed.upstream].map(normalizeState);
    for (const state of [base, local, upstream]) {
      if (!isRecord(state.settings) || (state.personSettings !== undefined && !isRecord(state.personSettings))) throw new MergeConflict("A version of the coordination state has malformed settings.");
      for (const key of ["active", "pending", "evidence", "closed", "history"]) {
        if (state[key] !== undefined && !Array.isArray(state[key])) throw new MergeConflict(`A version of the coordination state has a malformed ${key}.`);
      }
    }
    const list = (state: any, key: any) => state[key] ?? [];
    const has = (key: any) => [base, local, upstream].some((state) => state[key] !== undefined);
    const { settings, personSettings } = mergeSettings(base, local, upstream);
    const pending = mergeList("The pending user gates", base.pending, local.pending, upstream.pending, gateKey, mergeGate);
    const active = mergeList("The active work", base.active, local.active, upstream.active, (item: any) => isRecord(item) ? item.slice : item,
      (slice: string, b: any, l: any, u: any) => mergeUnit(`The active work of ${slice}`, b, l, u));
    const history = mergeUnion(list(base, "history"), list(local, "history"), list(upstream, "history"), (item: any) => item?.id, historyOrder, HISTORY_LIMIT);
    const closed = mergeUnion(list(base, "closed"), list(local, "closed"), list(upstream, "closed"), (item: any) => item?.id, closedOrder, CLOSED_LIMIT);
    const removed = new Set(base.evidence.filter((item: any) => !local.evidence.includes(item) || !upstream.evidence.includes(item)));
    const evidence = [...upstream.evidence.filter((item: any) => !removed.has(item)), ...local.evidence.filter((item: any) => !removed.has(item) && !upstream.evidence.includes(item))];
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

export async function readCoordinationState({ projectRoot, initiative }: { projectRoot: string; initiative: string }) {
  const resolved = await resolveState(projectRoot, initiative);
  return publicStateResult(resolved, await loadState(resolved.path));
}

export async function validateCoordinationState({ projectRoot, initiative }: { projectRoot: string; initiative: string }) {
  return readCoordinationState({ projectRoot, initiative });
}

export async function updateCoordinationState({ projectRoot, initiative, expectedRevision, changes }: { projectRoot: string; initiative: string; expectedRevision: any; changes: any }) {
  validateChanges(changes);
  if (expectedRevision !== null && typeof expectedRevision !== "string") {
    throw error("invalid_revision", "The expectedRevision argument must be a state revision string or null.");
  }
  // A shipped initiative's coordination state is history, so a change to it is refused after argument validation and before any other check or write.
  await refuseShipped(projectRoot, initiative);
  await moveLegacyRecords(projectRoot);
  const resolved = await resolveState(projectRoot, initiative);
  await mkdir(path.dirname(resolved.path), { recursive: true });
  const standing = await askedStanding(resolved, changes);
  const result = await withStateLock(resolved.path, () => withFileLock(resolved.path, async () => {
    // A ship that landed after the first check refuses the change too, so the state never changes after the initiative shipped.
    await refuseShipped(projectRoot, initiative);
    return applyStateChange(resolved, expectedRevision, changes, standing);
  }, error, { renew: Boolean(changes.activeOperations?.length) }));
  await markLaunchedGates(projectRoot, initiative, result.openedGates);
  return result;
}

// A gate asked by a launched session of this machine, whose environment names its launch, is marked in that launch folder once the
// ask is written; the gate record stays as it is, and a mark that cannot be written leaves the ask as it succeeded.
async function markLaunchedGates(projectRoot: string, initiative: string, opened: any) {
  if (typeof process.env.PRISM_LAUNCH !== "string" || !process.env.PRISM_LAUNCH || !Array.isArray(opened) || !opened.length) return;
  try {
    const { markLaunchGates } = await import("../session/launched-sessions.mjs");
    await markLaunchGates({ projectRoot, initiative, gates: opened.map((gate) => gate?.id), env: process.env });
  } catch {
    // The launched session then shows no wait for the gate, and the person resumes it after answering.
  }
}

// Resolving a gate by its id removes only that gate, so it holds after any other change, such as the browser answer that prompted it.
function resolvesGatesOnly(changes: any) {
  const keys = Object.keys(changes ?? {});
  return keys.length === 1 && keys[0] === "gateOperations" && changes.gateOperations.length > 0 && changes.gateOperations.every((operation: any) => operation?.op === "resolve");
}

async function applyStateChange(resolved: any, expectedRevision: any, changes: any, standing = null) {
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
    // A replacement pending list keeps an answered gate as it stands too, so a resolve in the same change cannot close a reworded copy.
    if (Array.isArray(changes.pending)) assertAnsweredGatesUnchanged(before.pending, changes.pending, []);
    const dropped = droppedGates(before.pending, changes.pending);
    const gateResult = applyGateOperations(changes.pending ?? before.pending, changes.gateOperations ?? [], standing);
    assertAnsweredGatesUnchanged(before.pending, gateResult.pending, gateResult.opened);
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
      ...(gateResult.superseded.length ? { supersededGates: gateResult.superseded } : {}),
      ...(requested?.kept.length ? { keptSettings: requested.kept } : {})
    };
    });
}

/**
 * Close the pending gate that confirmed a ship, which the caller holds the state record's lock for, as update_roadmap does while it ships:
 * the gate moves to closed with its answer, and a gate that is already closed or gone leaves the state as it is.
 */
export async function closeShipGate(projectRoot: string, initiative: string, id: string) {
  const resolved = await resolveState(projectRoot, initiative);
  const current = await loadState(resolved.path);
  if (!current.exists || !current.valid) return false;
  const position = current.state.pending.findIndex((item: any) => isRecord(item) && item.id === id);
  if (position === -1) return false;
  const pending = [...current.state.pending];
  const [gate] = pending.splice(position, 1);
  const closed = [...(current.state.closed ?? []), closedGate(gate, "The initiative shipped with this gate's approval.")].slice(-CLOSED_LIMIT);
  const candidate = normalizeState({ ...current.state, pending, closed });
  const validation = validateStateValue(candidate);
  if (validation.errors.length > 0) {
    throw error("invalid_state", "The state without the ship's gate is invalid and was not written.", { errors: validation.errors });
  }
  await writeRecord(resolved.root, { kind: "state", initiative: resolved.initiative }, stateContents(candidate));
  return true;
}

export async function answerUserGate({ projectRoot, initiative, id, choice = null, note = null, write = writeRecord }: { projectRoot: string; initiative: string; id: string; choice?: any; note?: any; write?: any }) {
  await refuseShipped(projectRoot, initiative);
  await moveLegacyRecords(projectRoot);
  const resolved = await resolveState(projectRoot, initiative);
  await mkdir(path.dirname(resolved.path), { recursive: true });
  return withStateLock(resolved.path, () => withFileLock(resolved.path, async () => {
    await refuseShipped(projectRoot, initiative);
    const current = await loadState(resolved.path);
    if (!current.exists || !current.valid) {
      throw error("invalid_state", "The coordination state is missing or invalid.");
    }
    const position = current.state.pending.findIndex((item: any) => isRecord(item) && item.id === id);
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
export async function recordPersonAction({ projectRoot, initiative, prepare }: { projectRoot: string; initiative: string; prepare: any }) {
  const decide = async (resolved: any, current: any) => {
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
  // The action's own checks answer first, so the review browser can say why an action is unavailable; a change that passes them is still refused for a shipped initiative.
  await refuseShipped(projectRoot, initiative);
  await moveLegacyRecords(projectRoot);
  const resolved = await resolveState(projectRoot, initiative);
  await mkdir(path.dirname(resolved.path), { recursive: true });
  return withStateLock(resolved.path, () => withFileLock(resolved.path, async () => {
    const current = await loadState(resolved.path);
    const change = await decide(resolved, current);
    if (change === null) return { ...publicStateResult(resolved, current), entry: null };
    // A ship that landed after the first check refuses the action too, so the state never changes after the initiative shipped.
    await refuseShipped(projectRoot, initiative);
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
      const position = before.pending.findIndex((item: any) => isRecord(item) && item.id === answer.id);
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
export async function checkpointPause({ projectRoot, initiative, expectedRevision, activeSlice, recoveryContent, changes }: { projectRoot: string; initiative: string; expectedRevision: any; activeSlice: any; recoveryContent: any; changes: any }) {
  validateChanges(changes);
  if (typeof activeSlice !== "string" || !SLUG_PATTERN.test(activeSlice) || typeof recoveryContent !== "string" || !recoveryContent.trim() || Buffer.byteLength(recoveryContent) > 65536) {
    throw error("invalid_pause", "An active slice and a recovery note of at most 64 KiB are required.");
  }
  // A shipped initiative's state is history, so the pause is refused before the recovery note or any record is written.
  await refuseShipped(projectRoot, initiative);
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
  const standing = await askedStanding(resolved, changes);
  const paused = await withStateLock(resolved.path, () => withFileLock(resolved.path, async () => {
    // A ship that landed after the first check refuses the pause too, before the recovery note is written.
    await refuseShipped(projectRoot, initiative);
    const current = await loadState(resolved.path);
    if (current.revision !== expectedRevision) {
      throw error(expectedRevision === "null" ? "invalid_revision" : "revision_conflict", revisionMismatch("coordination state", expectedRevision, current.revision), { current: publicStateResult(resolved, current) });
    }
    if (!current.valid || !current.state?.active.some((item: any) => item.slice === activeSlice)) {
      throw error("invalid_pause", "The slice is not active in the current coordination state.");
    }
    const stateRelativeRecovery = path.relative(path.resolve(resolved.root, resolved.directory!), recovery).split(path.sep).join("/");
    const remainingActive = current.state.active.filter((item: any) => item.slice !== activeSlice);
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
      }, standing);
      return { ...result, recoveryPath: recoveryRelative, recoveryDigest: createHash("sha256").update(recoveryContent.endsWith("\n") ? recoveryContent : `${recoveryContent}\n`).digest("hex"), pausedSlice: activeSlice };
    } catch (caught) {
      if (inStore) await writeArtifactText(resolved.root, recoveryRelative, previous).catch(() => {});
      else if (previous === null) await rm(recovery, { force: true }).catch(() => {});
      else await writeAtomically(recovery, previous).catch(() => {});
      throw caught;
    }
  }, error));
  await markLaunchedGates(projectRoot, initiative, paused.openedGates);
  return paused;
}
