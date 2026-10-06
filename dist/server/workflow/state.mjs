import { createHash } from "node:crypto";
import { applyActiveOperations, withReviewGatesLocked } from "./active-operations.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { mkdir, readFile, realpath, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { withArtifactLock as withStateLock, withFileLock, writeAtomically } from "./artifact-store.mjs";

const SCHEMA_VERSION = 1;

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "settings", "active", "pending", "next", "evidence"]);
const SETTING_KEYS = new Set(["autonomy", "agentFlow", "commit", "push", "continuation", "models"]);
const ACTIVE_KEYS = new Set(["slice", "activity", "label", "workers", "workspace", "reviewLanes", "findingsPath", "reviewPath"]);
const SETTING_VALUES = {
  autonomy: new Set(["conservative", "broad", "full"]),
  agentFlow: new Set(["mono", "multi"]),
  commit: new Set(["on", "off"]),
  push: new Set(["on", "off"]),
  continuation: new Set(["auto", "stepwise"])
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

function normalizedStatePath(statePath) {
  if (typeof statePath !== "string" || !statePath || path.isAbsolute(statePath)) {
    throw error("invalid_path", "The statePath argument must be a non-empty path relative to the project root.");
  }
  const normalized = path.normalize(statePath);
  if (path.basename(normalized) !== "state.json") {
    throw error("invalid_path", "The statePath argument must name a state.json file.");
  }
  return normalized;
}

async function assertNearestExistingPathInside(root, target) {
  let current = target;
  while (true) {
    try {
      const resolved = await realpath(current);
      if (!isInside(root, resolved)) {
        throw error("invalid_path", "The state path resolves outside the project root.");
      }
      return;
    } catch (caught) {
      if (caught.code !== "ENOENT") {
        throw caught;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error("invalid_path", "The state path cannot be resolved inside the project root.");
      }
      current = parent;
    }
  }
}

async function resolveStatePath(projectRoot, statePath, createParent = false) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw error("invalid_project_root", "The project root must be an absolute path.");
  }
  const root = await realpath(projectRoot);
  const relativePath = normalizedStatePath(statePath);
  const candidate = path.resolve(root, relativePath);
  if (!isInside(root, candidate)) {
    throw error("invalid_path", "The state path leaves the project root.");
  }
  const parent = path.dirname(candidate);
  await assertNearestExistingPathInside(root, parent);
  if (createParent) {
    await mkdir(parent, { recursive: true });
  }
  let resolvedParent;
  try {
    resolvedParent = await realpath(parent);
  } catch (caught) {
    if (caught.code === "ENOENT" && !createParent) {
      return {
        root,
        path: candidate,
        displayPath: path.relative(root, candidate).split(path.sep).join("/")
      };
    }
    throw caught;
  }
  if (!isInside(root, resolvedParent)) {
    throw error("invalid_path", "The state path resolves outside the project root.");
  }
  let target = candidate;
  try {
    const fileInfo = await lstat(candidate);
    if (fileInfo.isSymbolicLink()) {
      throw error("invalid_path", "The state file must not be a symbolic link.");
    }
    target = await realpath(candidate);
    if (!isInside(root, target)) {
      throw error("invalid_path", "The state path resolves outside the project root.");
    }
  } catch (caught) {
    if (caught.code !== "ENOENT") {
      throw caught;
    }
  }
  return {
    root,
    path: target,
    displayPath: path.relative(root, target).split(path.sep).join("/")
  };
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
  for (const key of Object.keys(value)) {
    if (!requiredRoles.includes(key)) {
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
  for (const key of ["pending", "next", "evidence"]) {
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
    if ((!TOP_LEVEL_KEYS.has(key) && key !== "activeOperations") || key === "schemaVersion") {
      throw error("invalid_changes", `The state field ${key} cannot be changed through this capability.`);
    }
  }
  if (changes.settings !== undefined && !isRecord(changes.settings)) {
    throw error("invalid_changes", "The changes.settings field must be an object.");
  }
  for (const key of ["active", "pending", "next", "evidence"]) {
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
    statePath: resolved.displayPath,
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

export async function readCoordinationState({ projectRoot, statePath }) {
  const resolved = await resolveStatePath(projectRoot, statePath);
  return publicStateResult(resolved, await loadState(resolved.path));
}

export async function validateCoordinationState({ projectRoot, statePath }) {
  return readCoordinationState({ projectRoot, statePath });
}

export async function updateCoordinationState({ projectRoot, statePath, expectedRevision, changes }) {
  validateChanges(changes);
  if (expectedRevision !== null && typeof expectedRevision !== "string") {
    throw error("invalid_revision", "The expectedRevision argument must be a state revision string or null.");
  }
  const resolved = await resolveStatePath(projectRoot, statePath, true);
  await conservationStore.registerCoordinationOutputs(resolved.root, [resolved.displayPath]);
  return withStateLock(resolved.path, () => withFileLock(resolved.path, async () => applyStateChange(resolved, expectedRevision, changes), error, { renew: Boolean(changes.activeOperations?.length) }));
}

async function applyStateChange(resolved, expectedRevision, changes) {
    const current = await loadState(resolved.path);
    if (current.revision !== expectedRevision) {
      throw error("revision_conflict", "The state changed since it was read. Read it again and retry with its current revision.", { current: publicStateResult(resolved, current) });
    }
    if (current.exists && !current.valid) {
      throw error("invalid_state", "The existing state is invalid and was not changed.", { validation: publicStateResult(resolved, current) });
    }
    const before = current.state ?? defaultState();
    if (changes.active !== undefined && JSON.stringify(changes.active) !== JSON.stringify(before.active)) throw error("gate_blocked", "Use typed activeOperations to change active work; array replacement cannot bypass review gates.");
    return withReviewGatesLocked(resolved.root, before.active, changes.activeOperations ?? [], async () => {
    const activeResult = await applyActiveOperations(resolved.root, before.active, changes.activeOperations ?? []);
    const candidate = normalizeState({
      ...before,
      active: activeResult.active,
      ...(changes.settings === undefined ? {} : { settings: { ...before.settings, ...changes.settings } }),
      ...(changes.pending === undefined ? {} : { pending: changes.pending }),
      ...(changes.next === undefined ? {} : { next: changes.next }),
      ...(changes.evidence === undefined ? {} : { evidence: changes.evidence })
    });
    const validation = validateStateValue(candidate);
    if (validation.errors.length > 0) {
      throw error("invalid_state", "The proposed state is invalid and was not written.", { errors: validation.errors, warnings: validation.warnings });
    }
    const contents = `${JSON.stringify(candidate, null, 2)}\n`;
    await conservationStore.registerCoordinationOutputs(resolved.root, [resolved.displayPath]);
    if (!current.exists || contents !== current.contents) {
      await conservationStore.writeManaged(resolved.root, resolved.path, contents);
    }
    const updated = await loadState(resolved.path);
    return {
      ...publicStateResult(resolved, updated),
      created: !current.exists,
      changedFields: changedFields(before, updated.state),
      previousRevision: current.revision
      ,completions: activeResult.completions
    };
    });
}

export async function checkpointPause({ projectRoot, statePath, expectedRevision, activeSlice, recoveryPath, recoveryContent, changes }) {
  validateChanges(changes);
  if (typeof activeSlice !== "string" || !activeSlice || typeof recoveryContent !== "string" || !recoveryContent.trim() || Buffer.byteLength(recoveryContent) > 65536) {
    throw error("invalid_pause", "An active slice and a recovery note of at most 64 KiB are required.");
  }
  if (typeof recoveryPath !== "string" || path.isAbsolute(recoveryPath) || path.basename(recoveryPath) !== "recovery.md") {
    throw error("invalid_path", "The recoveryPath must name a project-relative recovery.md file.");
  }
  const resolved = await resolveStatePath(projectRoot, statePath, true);
  const recovery = path.resolve(resolved.root, recoveryPath);
  if (!isInside(resolved.root, recovery) || path.dirname(recovery) === resolved.root || !recoveryPath.split(/[\\/]/).includes(activeSlice)) {
    throw error("invalid_path", "The recovery note must be inside a slice directory.");
  }
  await assertNearestExistingPathInside(resolved.root, path.dirname(recovery));
  return withStateLock(resolved.path, () => withFileLock(resolved.path, async () => {
    const current = await loadState(resolved.path);
    if (current.revision !== expectedRevision) {
      throw error("revision_conflict", "The state changed since it was read. Read it again and retry with its current revision.", { current: publicStateResult(resolved, current) });
    }
    if (!current.valid || !current.state?.active.some((item) => item.slice === activeSlice)) {
      throw error("invalid_pause", "The slice is not active in the current coordination state.");
    }
    const recoveryRelative = path.relative(resolved.root, recovery).split(path.sep).join("/");
    const stateRelativeRecovery = path.relative(path.dirname(resolved.path), recovery).split(path.sep).join("/");
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
