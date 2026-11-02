import { randomBytes, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import path from "node:path";
import {
  SESSION_TRACE_SCHEMA_VERSION,
  createSessionTraceIdentity,
  hashSessionTraceValue,
  validateSessionTraceEvent
} from "./session-trace.mjs";
import { LOCK_STALE_MS, createPrivateSessionStore, defaultIsProcessAlive } from "./private-session-store.mjs";
import { attributeRunCost, splitRuns, summarizeRunMeasures, totalRunSegments } from "./run-measures.mjs";
import { recordFinishedRuns } from "./run-records.mjs";
import { readSessionRunTotals } from "./run-totals.mjs";
import { readWorkflowConfig, runStatisticsCollection } from "../workflow/workflow-config.mjs";

const TRACE_DIRECTORY = "session-traces";
const MAX_TRACE_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_TRACE_EVENTS = 4096;
export const SESSION_TRACE_MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
export const SESSION_TRACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_KEYS = ["schemaVersion", "sessionDigest", "projectDigest", "limitReached", "events"];
const EVENT_TYPE_ORDER = new Map([
  ["run_start", -1],
  ["session_start", 0],
  ["subagent_start", 1],
  ["model_switch", 1],
  ["coverage_gap", 2],
  ["search", 3],
  ["source_read", 3],
  ["test", 3],
  ["compaction", 3],
  ["tool_start", 3],
  ["usage", 3],
  ["tool_end", 4],
  ["prism_call", 4],
  ["edit_attempt", 4],
  ["edit", 5],
  ["first_edit", 6],
  ["subagent_stop", 7],
  ["session_end", 7],
  ["run_end", 8]
]);

export const SESSION_TRACE_REASON = Object.freeze({
  NO_DATA_DIRECTORY: "NO_DATA_DIRECTORY",
  NO_CORRELATION_KEY: "NO_CORRELATION_KEY",
  INVALID_CORRELATION_KEY: "INVALID_CORRELATION_KEY",
  NO_SESSION_ID: "NO_SESSION_ID",
  NO_PROJECT_ROOT: "NO_PROJECT_ROOT",
  INVALID_PROJECT_ROOT: "INVALID_PROJECT_ROOT",
  NO_SESSION_TRACE: "NO_SESSION_TRACE",
  INVALID_EVENT: "INVALID_EVENT",
  EVENT_TOO_LARGE: "EVENT_TOO_LARGE",
  INVALID_SESSION_TRACE: "INVALID_SESSION_TRACE",
  SESSION_MISMATCH: "SESSION_MISMATCH",
  PROJECT_MISMATCH: "PROJECT_MISMATCH",
  TRACE_LIMIT_REACHED: "TRACE_LIMIT_REACHED",
  TRACE_UNAVAILABLE: "TRACE_UNAVAILABLE",
  LOCK_UNAVAILABLE: "LOCK_UNAVAILABLE",
  DIRECT_FIRST_EDIT: "DIRECT_FIRST_EDIT",
  RUN_SEALED: "RUN_SEALED"
});

export const SESSION_TRACE_COVERAGE_REASON = Object.freeze({
  NO_SESSION_START: "NO_SESSION_START",
  INITIAL_COVERAGE_PARTIAL: "INITIAL_COVERAGE_PARTIAL",
  INITIAL_COVERAGE_UNAVAILABLE: "INITIAL_COVERAGE_UNAVAILABLE",
  COVERAGE_GAP: "COVERAGE_GAP",
  MISSING_RENDERED_TOKEN_COUNT: "MISSING_RENDERED_TOKEN_COUNT",
  OVERLAPPING_TOKEN_COUNTS: "OVERLAPPING_TOKEN_COUNTS",
  TRACE_LIMIT_REACHED: "TRACE_LIMIT_REACHED"
});

const REASON_MESSAGES = Object.freeze({
  [SESSION_TRACE_REASON.NO_DATA_DIRECTORY]: "The plugin data directory is unavailable.",
  [SESSION_TRACE_REASON.NO_CORRELATION_KEY]: "The active host session correlation key is unavailable.",
  [SESSION_TRACE_REASON.INVALID_CORRELATION_KEY]: "The active host session correlation key is invalid.",
  [SESSION_TRACE_REASON.NO_SESSION_ID]: "The active host session identifier is unavailable.",
  [SESSION_TRACE_REASON.NO_PROJECT_ROOT]: "The active project root is unavailable.",
  [SESSION_TRACE_REASON.INVALID_PROJECT_ROOT]: "The active project root is invalid.",
  [SESSION_TRACE_REASON.NO_SESSION_TRACE]: "No trace exists for the active host session.",
  [SESSION_TRACE_REASON.INVALID_EVENT]: "The session trace event is invalid.",
  [SESSION_TRACE_REASON.EVENT_TOO_LARGE]: "The session trace event is too large.",
  [SESSION_TRACE_REASON.INVALID_SESSION_TRACE]: "The stored session trace is invalid.",
  [SESSION_TRACE_REASON.SESSION_MISMATCH]: "The stored trace belongs to another host session.",
  [SESSION_TRACE_REASON.PROJECT_MISMATCH]: "The stored trace belongs to another project root.",
  [SESSION_TRACE_REASON.TRACE_LIMIT_REACHED]: "The session trace reached its storage limit.",
  [SESSION_TRACE_REASON.TRACE_UNAVAILABLE]: "The session trace cannot be read.",
  [SESSION_TRACE_REASON.LOCK_UNAVAILABLE]: "The session trace is busy.",
  [SESSION_TRACE_REASON.DIRECT_FIRST_EDIT]: "The trace store creates first_edit events from successful edit events.",
  [SESSION_TRACE_REASON.RUN_SEALED]: "The event belongs to a run that is already recorded."
});

class LostSessionTraceLockError extends Error {
  constructor(message) {
    super(message);
    this.code = "LOST_SESSION_TRACE_LOCK";
  }
}

const traceStore = createPrivateSessionStore({
  directoryName: TRACE_DIRECTORY,
  subject: "session trace",
  unsafePathCode: "UNSAFE_SESSION_TRACE_PATH",
  maxLockOwnerBytes: 256,
  lockProtocol: "direct"
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value)
    && Object.keys(value).every((key) => keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key));
}

function ignored(reasonCode) {
  return { status: "ignored", reasonCode, reason: REASON_MESSAGES[reasonCode] };
}

// A refusal by the trace's own limit reports `limitReached`; a full shared directory refuses without it.
function traceLimitRefused() {
  return { ...ignored(SESSION_TRACE_REASON.TRACE_LIMIT_REACHED), limitReached: true };
}

/**
 * Whether a run counts as sealed by its trace's own limit: the trace's persisted `limitReached` is set and the run closed.
 * The finalizer and `clearRunsPending` both use this predicate, so a full shared directory never seals a run.
 */
export function runSealedByTraceLimit(trace, run) {
  return trace?.limitReached === true && run.closed !== null;
}

function unsupported(reasonCode) {
  return {
    status: "UNSUPPORTED",
    coverage: "unavailable",
    reasonCode,
    reason: REASON_MESSAGES[reasonCode]
  };
}

function validDataDirectory(value) {
  return typeof value === "string" && path.isAbsolute(value);
}

function tracePath(directory, sessionDigest) {
  return path.join(directory, `${sessionDigest}.json`);
}

// A loss marker is an empty file named "<trace digest>.<project digest>.loss[.<linked execution digest>]".
// It is created without the directory lock, so a writer whose append was refused can still record the loss.
const LOSS_MARKER_PATTERN = /^([a-f0-9]{64})\.([a-f0-9]{64})\.loss(?:\.([a-f0-9]{64}))?$/;
// A pending marker "<session digest>.<project digest>.pending" names a session with an unrecorded run; its modification time
// is the session's latest event time. A finalizer renames it to "<marker>.claim" while it clears the session.
const PENDING_MARKER_PATTERN = /^([a-f0-9]{64})\.([a-f0-9]{64})\.pending(\.claim)?$/;

function rootTraceDigest(sessionDigest) {
  return hashSessionTraceValue(`${sessionDigest}\0root`, "executionKey");
}

function isRunStatisticsEvent(event) {
  return Object.hasOwn(event.hashes, "execution") || event.eventType === "run_start" || event.eventType === "run_end";
}

// The run_start that opens a run at `event`'s time, with a random identifier from 32 random bytes.
function runStartFor(event) {
  const runId = hashSessionTraceValue(randomBytes(32).toString("hex"), "run");
  const start = {
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionDigest: event.sessionDigest,
    projectDigest: event.projectDigest,
    eventIdDigest: hashSessionTraceValue(`run_start\0run-start:${runId}`, "eventId"),
    eventType: "run_start",
    occurredAt: event.occurredAt,
    sourceLocation: null,
    counts: {},
    hashes: { run: runId },
    coverage: null,
    gapReason: null,
    provenance: { ...event.provenance }
  };
  validateSessionTraceEvent(start);
  return start;
}

// A run-statistics event either joins the latest open run, opens a new run with its own run_start, or is refused when it
// would sort before the trace's latest run_end, so a late event never vanishes into a recorded run.
function placeRunEvent(events, event) {
  if (!isRunStatisticsEvent(event)) return { events: [...events, event] };
  if (event.eventType === "run_start") return { events: [...events, event] };
  const latestEnd = events.findLast((stored) => stored.eventType === "run_end");
  if (latestEnd && compareTraceEvents(event, latestEnd) < 0) return { refused: true };
  if (event.eventType === "run_end") return { events: [...events, event] };
  const host = RUN_MEASURE_HOSTS.get(event.provenance.collector) ?? null;
  const runs = splitRuns(events, { host, traceDigest: event.sessionDigest, at: Date.parse(event.occurredAt) });
  const latest = runs.at(-1);
  const opens = !latest || latest.runId === null || (latest.closed !== null
    && (latest.events.length === 0 || compareTraceEvents(event, latest.events.at(-1)) >= 0));
  return opens ? { events: [...events, runStartFor(event), event], opened: true } : { events: [...events, event] };
}

function eventBytes(event) {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function stateBytes(state) {
  return Buffer.byteLength(`${JSON.stringify(state)}\n`, "utf8");
}

function clone(value) {
  return structuredClone(value);
}

function compareTraceEvents(left, right) {
  return left.occurredAt.localeCompare(right.occurredAt)
    || (EVENT_TYPE_ORDER.get(left.eventType) ?? Number.MAX_SAFE_INTEGER)
      - (EVENT_TYPE_ORDER.get(right.eventType) ?? Number.MAX_SAFE_INTEGER)
    || left.eventIdDigest.localeCompare(right.eventIdDigest);
}

function orderTraceEvents(events) {
  const observed = events
    .filter((event) => event.eventType !== "first_edit")
    .map(clone)
    .sort(compareTraceEvents);
  const firstEditIndex = observed.findIndex((event) => event.eventType === "edit");
  if (firstEditIndex !== -1) {
    observed.splice(firstEditIndex + 1, 0, firstEditFrom(observed[firstEditIndex]));
  }
  return observed;
}

function validateTraceState(state) {
  if (!exactKeys(state, STATE_KEYS)) {
    throw new Error("The session trace has invalid properties.");
  }
  if (state.schemaVersion !== SESSION_TRACE_SCHEMA_VERSION) {
    throw new Error("The session trace schema version is unsupported.");
  }
  if (typeof state.sessionDigest !== "string" || !/^[a-f0-9]{64}$/.test(state.sessionDigest)) {
    throw new Error("The session trace identifier is invalid.");
  }
  if (typeof state.projectDigest !== "string" || !/^[a-f0-9]{64}$/.test(state.projectDigest)) {
    throw new Error("The session trace project identifier is invalid.");
  }
  if (typeof state.limitReached !== "boolean" || !Array.isArray(state.events)) {
    throw new Error("The session trace state is invalid.");
  }
  if (state.events.length > MAX_TRACE_EVENTS) {
    throw new Error("The session trace contains too many events.");
  }

  const eventIds = new Set();
  let firstEditIndex = -1;
  for (const [index, event] of state.events.entries()) {
    validateSessionTraceEvent(event);
    if (event.sessionDigest !== state.sessionDigest || event.projectDigest !== state.projectDigest) {
      throw new Error("The session trace contains an event for another identity.");
    }
    if (eventIds.has(event.eventIdDigest)) {
      throw new Error("The session trace contains a duplicate event.");
    }
    eventIds.add(event.eventIdDigest);
    if (event.eventType === "first_edit") {
      if (firstEditIndex !== -1) {
        throw new Error("The session trace contains more than one first_edit event.");
      }
      const prior = state.events[index - 1];
      if (!prior || prior.eventType !== "edit" || prior.occurredAt !== event.occurredAt) {
        throw new Error("The first_edit event does not follow a successful edit event.");
      }
      firstEditIndex = index;
    }
  }
  const ordered = orderTraceEvents(state.events);
  if (
    ordered.length !== state.events.length
    || ordered.some((event, index) => event.eventIdDigest !== state.events[index].eventIdDigest)
  ) {
    throw new Error("The session trace events are not in canonical occurrence order.");
  }
  return true;
}

async function writeState(target, directory, state, fileSystem, { assertOwnership = async () => true } = {}) {
  validateTraceState(state);
  if (stateBytes(state) > MAX_TRACE_BYTES) {
    throw new Error("The session trace is too large.");
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  traceStore.assertDirectChild(directory, temporary, "The temporary session trace path");
  let handle;
  try {
    handle = await traceStore.openPrivateFile(temporary, fileSystem);
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    if (typeof handle.sync === "function") {
      await handle.sync();
    }
    await handle.close();
    handle = null;
    if (!await assertOwnership()) {
      throw new LostSessionTraceLockError("The session trace writer lost its lock before commit.");
    }
    await traceStore.inspectRegularFile(target, directory, fileSystem, { missing: true });
    await fileSystem.rename(temporary, target);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (typeof fileSystem.unlink === "function") {
      await fileSystem.unlink(temporary).catch(() => {});
    }
    throw error;
  }
}

async function readState(target, directory, fileSystem, { missing = false } = {}) {
  const opened = await traceStore.openExistingRegularFile(target, directory, fileSystem, { missing });
  if (opened === null) return null;
  if (opened.metadata.size > MAX_TRACE_BYTES) {
    await opened.handle.close();
    throw new Error("The stored session trace has an invalid size.");
  }
  try {
    const state = JSON.parse(await opened.handle.readFile("utf8"));
    validateTraceState(state);
    return state;
  } finally {
    await opened.handle.close();
  }
}

function positiveSafeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function clockMilliseconds(now) {
  try {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
  } catch {
    return Date.now();
  }
}

async function traceFileRecords(directory, target, nowMs, fileSystem, assertOwnership) {
  const records = [];
  const staleTemporaryCutoff = nowMs - LOCK_STALE_MS;
  for (const entry of await fileSystem.readdir(directory, { withFileTypes: true })) {
    const traceRecord = /^[a-f0-9]{64}\.json$/.test(entry.name);
    const pendingOwner = PENDING_MARKER_PATTERN.exec(entry.name)?.[1];
    // A pending marker belongs to its session's root trace, so it leaves with that trace or ages out like a loss marker.
    const markerOwner = LOSS_MARKER_PATTERN.exec(entry.name)?.[1] ?? (pendingOwner ? rootTraceDigest(pendingOwner) : undefined);
    const temporaryRecord = /^[a-f0-9]{64}\.json\..+\.tmp$/.test(entry.name);
    if (!traceRecord && !markerOwner && !temporaryRecord) {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    if (traceRecord && filePath === target) {
      continue;
    }
    try {
      const metadata = await traceStore.inspectRegularFile(filePath, directory, fileSystem);
      if (temporaryRecord && metadata.mtimeMs < staleTemporaryCutoff) {
        await assertOwnership();
        await fileSystem.unlink(filePath);
        continue;
      }
      records.push({
        name: entry.name,
        path: filePath,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        evictable: traceRecord,
        ...(markerOwner ? { markerOwner } : {})
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return records;
}

async function enforceDirectoryLimits({
  directory,
  target,
  candidateBytes,
  maxDirectoryBytes,
  maxTraceAgeMs,
  now,
  fileSystem,
  assertOwnership
}) {
  const nowMs = clockMilliseconds(now);
  const cutoff = nowMs - maxTraceAgeMs;
  const records = await traceFileRecords(directory, target, nowMs, fileSystem, assertOwnership);
  // A loss marker is never evicted on its own: it leaves with its trace, or ages out once that trace is gone.
  const markers = records.filter((record) => record.markerOwner);
  const traceDigests = new Set([path.basename(target, ".json")]);
  const removeTrace = async (record) => {
    await assertOwnership();
    await fileSystem.unlink(record.path);
    const digest = path.basename(record.path, ".json");
    for (const marker of markers.filter((item) => item.markerOwner === digest && !item.removed)) {
      await fileSystem.unlink(marker.path).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      marker.removed = true;
    }
  };
  const retained = [];
  for (const record of records.filter((item) => !item.markerOwner)) {
    if (record.evictable && record.mtimeMs < cutoff) {
      await removeTrace(record);
    } else {
      retained.push(record);
      if (record.evictable) traceDigests.add(path.basename(record.path, ".json"));
    }
  }
  for (const marker of markers.filter((item) => !item.removed && !traceDigests.has(item.markerOwner))) {
    if (marker.mtimeMs < cutoff) {
      await assertOwnership();
      await fileSystem.unlink(marker.path);
      marker.removed = true;
    }
  }
  if (candidateBytes > maxDirectoryBytes) {
    return false;
  }
  retained.sort((left, right) => {
    if (left.mtimeMs !== right.mtimeMs) {
      return left.mtimeMs - right.mtimeMs;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  let aggregateBytes = candidateBytes + retained.reduce((total, record) => total + record.size, 0);
  for (const record of retained.filter((item) => item.evictable)) {
    if (aggregateBytes <= maxDirectoryBytes) {
      break;
    }
    await removeTrace(record);
    aggregateBytes -= record.size;
  }
  return aggregateBytes <= maxDirectoryBytes;
}

function firstEditFrom(editEvent) {
  const event = {
    ...clone(editEvent),
    eventIdDigest: hashSessionTraceValue(`${editEvent.sessionDigest}:first-edit`, "firstEditEventId"),
    eventType: "first_edit",
    counts: {},
    hashes: {}
  };
  validateSessionTraceEvent(event);
  return event;
}

export async function appendSessionTraceEvent(event, {
  dataDirectory,
  fileSystem = defaultFileSystem,
  isProcessAlive = defaultIsProcessAlive,
  maxDirectoryBytes = SESSION_TRACE_MAX_DIRECTORY_BYTES,
  maxTraceAgeMs = SESSION_TRACE_MAX_AGE_MS,
  now = () => new Date()
} = {}) {
  try {
    validateSessionTraceEvent(event);
  } catch {
    return ignored(SESSION_TRACE_REASON.INVALID_EVENT);
  }
  if (event.eventType === "first_edit") {
    return ignored(SESSION_TRACE_REASON.DIRECT_FIRST_EDIT);
  }
  if (eventBytes(event) > MAX_EVENT_BYTES) {
    return ignored(SESSION_TRACE_REASON.EVENT_TOO_LARGE);
  }
  if (!validDataDirectory(dataDirectory)) {
    return ignored(SESSION_TRACE_REASON.NO_DATA_DIRECTORY);
  }

  let store;
  try {
    store = await traceStore.resolveDirectory(dataDirectory, { create: true, fileSystem });
  } catch {
    return ignored(SESSION_TRACE_REASON.TRACE_UNAVAILABLE);
  }

  const target = tracePath(store.directory, event.sessionDigest);
  const directoryByteLimit = positiveSafeInteger(maxDirectoryBytes, SESSION_TRACE_MAX_DIRECTORY_BYTES);
  const traceAgeLimit = positiveSafeInteger(maxTraceAgeMs, SESSION_TRACE_MAX_AGE_MS);
  let directoryLock = null;
  try {
    directoryLock = await traceStore.acquireLock(store.directory, fileSystem, isProcessAlive);
    if (!directoryLock) {
      return ignored(SESSION_TRACE_REASON.LOCK_UNAVAILABLE);
    }
    const assertOwnership = async () => {
      await traceStore.assertDirectory(store, fileSystem);
      if (!await traceStore.ownsLock(directoryLock, store.directory, fileSystem)) {
        throw new LostSessionTraceLockError("The session trace writer lost its lock.");
      }
      return true;
    };
    if (!await assertOwnership()) {
      return ignored(SESSION_TRACE_REASON.LOCK_UNAVAILABLE);
    }
    await traceStore.assertDirectory(store, fileSystem);
    let state;
    try {
      state = await readState(target, store.directory, fileSystem, { missing: true });
    } catch (error) {
      if (traceStore.isUnsafePath(error)) throw error;
      return ignored(SESSION_TRACE_REASON.INVALID_SESSION_TRACE);
    }
    if (state === null) {
      state = {
        schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
        sessionDigest: event.sessionDigest,
        projectDigest: event.projectDigest,
        limitReached: false,
        events: []
      };
    }
    if (state.sessionDigest !== event.sessionDigest) {
      return ignored(SESSION_TRACE_REASON.SESSION_MISMATCH);
    }
    if (state.projectDigest !== event.projectDigest) {
      return ignored(SESSION_TRACE_REASON.PROJECT_MISMATCH);
    }
    if (state.events.some((stored) => stored.eventIdDigest === event.eventIdDigest)) {
      return { status: "duplicate", appendedEventTypes: [] };
    }

    // A run-statistics trace that reached its own limit accepts no later event, so nothing lands inside a run sealed by
    // that limit; the root pre-edit trace keeps accepting a later event that fits.
    const runStatistics = isRunStatisticsEvent(event);
    if (state.limitReached && runStatistics) {
      return traceLimitRefused();
    }
    const placed = placeRunEvent(state.events, event);
    if (placed.refused) {
      return ignored(SESSION_TRACE_REASON.RUN_SEALED);
    }
    const priorFirstEdit = state.events.find((stored) => stored.eventType === "first_edit");
    const candidate = { ...state, events: orderTraceEvents(placed.events) };
    const nextFirstEdit = candidate.events.find((stored) => stored.eventType === "first_edit");
    const appendedEventTypes = placed.opened ? ["run_start", event.eventType] : [event.eventType];
    if (event.eventType === "edit" && priorFirstEdit?.occurredAt !== nextFirstEdit?.occurredAt) {
      appendedEventTypes.push("first_edit");
    }
    if (candidate.events.length > MAX_TRACE_EVENTS || stateBytes(candidate) > MAX_TRACE_BYTES) {
      if (!state.limitReached) {
        await writeState(target, store.directory, { ...state, limitReached: true }, fileSystem, {
          assertOwnership
        });
      }
      return runStatistics ? traceLimitRefused() : ignored(SESSION_TRACE_REASON.TRACE_LIMIT_REACHED);
    }
    if (!await assertOwnership()) {
      return ignored(SESSION_TRACE_REASON.LOCK_UNAVAILABLE);
    }
    const withinDirectoryLimits = await enforceDirectoryLimits({
      directory: store.directory,
      target,
      candidateBytes: stateBytes(candidate),
      maxDirectoryBytes: directoryByteLimit,
      maxTraceAgeMs: traceAgeLimit,
      now,
      fileSystem,
      assertOwnership
    });
    if (!withinDirectoryLimits) {
      return ignored(SESSION_TRACE_REASON.TRACE_LIMIT_REACHED);
    }
    await writeState(target, store.directory, candidate, fileSystem, { assertOwnership });
    if (!await assertOwnership()) {
      return ignored(SESSION_TRACE_REASON.LOCK_UNAVAILABLE);
    }
    return {
      status: "appended",
      appendedEventTypes
    };
  } catch (error) {
    if (error instanceof LostSessionTraceLockError) {
      return ignored(SESSION_TRACE_REASON.LOCK_UNAVAILABLE);
    }
    return ignored(SESSION_TRACE_REASON.TRACE_UNAVAILABLE);
  } finally {
    if (directoryLock) {
      await traceStore.releaseLock(directoryLock, store.directory, fileSystem).catch(() => {});
    }
  }
}

/**
 * Durably records that an event of the trace `event.sessionDigest` was not stored, without taking the directory lock.
 * A refused link event also names the execution it links, so a reader can still find that execution's trace.
 * The marker is idempotent per trace and linked execution, holds no content, and stays while its trace stays.
 */
export async function recordSessionTraceLoss(event, { dataDirectory, fileSystem = defaultFileSystem } = {}) {
  const digestPattern = /^[a-f0-9]{64}$/;
  if (!isObject(event) || !digestPattern.test(event.sessionDigest ?? "") || !digestPattern.test(event.projectDigest ?? "")) {
    return ignored(SESSION_TRACE_REASON.INVALID_EVENT);
  }
  if (!validDataDirectory(dataDirectory)) {
    return ignored(SESSION_TRACE_REASON.NO_DATA_DIRECTORY);
  }
  const linked = ["subagent_start", "subagent_stop"].includes(event.eventType) && digestPattern.test(event.hashes?.execution ?? "")
    ? `.${event.hashes.execution}`
    : "";
  try {
    const store = await traceStore.resolveDirectory(dataDirectory, { create: true, fileSystem });
    const target = path.join(store.directory, `${event.sessionDigest}.${event.projectDigest}.loss${linked}`);
    traceStore.assertDirectChild(store.directory, target, "The session trace loss marker path");
    const handle = await traceStore.openPrivateFile(target, fileSystem);
    await handle.close();
    return { status: "recorded" };
  } catch (error) {
    return error?.code === "EEXIST" ? { status: "duplicate" } : ignored(SESSION_TRACE_REASON.TRACE_UNAVAILABLE);
  }
}

// Reads the loss markers of one project: the traces that lost an event and the executions named by lost links.
async function readSessionTraceLosses({ dataDirectory, projectDigest, fileSystem = defaultFileSystem }) {
  const lost = new Set();
  const linked = new Map();
  try {
    const store = await traceStore.resolveDirectory(dataDirectory, { create: false, fileSystem });
    await traceStore.assertDirectory(store, fileSystem);
    for (const name of await fileSystem.readdir(store.directory)) {
      const match = LOSS_MARKER_PATTERN.exec(name);
      if (!match || match[2] !== projectDigest) continue;
      lost.add(match[1]);
      if (match[3]) {
        if (!linked.has(match[1])) linked.set(match[1], new Set());
        linked.get(match[1]).add(match[3]);
      }
    }
  } catch {
    // An unreadable directory leaves the trace reads to report their own status.
  }
  return { lost, linked };
}

function identityResult({ sessionId, correlationKey, correlationProvided, projectRoot }) {
  if (correlationProvided) {
    if (correlationKey === undefined || correlationKey === null || correlationKey === "") {
      return { error: SESSION_TRACE_REASON.NO_CORRELATION_KEY };
    }
    if (typeof correlationKey !== "string" || !/^[a-f0-9]{64}$/.test(correlationKey)) {
      return { error: SESSION_TRACE_REASON.INVALID_CORRELATION_KEY };
    }
  }
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    if (!correlationProvided) {
      return { error: SESSION_TRACE_REASON.NO_SESSION_ID };
    }
  }
  if (typeof projectRoot !== "string" || !projectRoot.trim()) {
    return { error: SESSION_TRACE_REASON.NO_PROJECT_ROOT };
  }
  if (!path.isAbsolute(projectRoot.trim())) {
    return { error: SESSION_TRACE_REASON.INVALID_PROJECT_ROOT };
  }
  try {
    const identity = createSessionTraceIdentity({
      sessionId: correlationProvided ? "correlation-key-project-identity" : sessionId,
      projectRoot
    });
    return {
      identity: {
        ...identity,
        ...(correlationProvided ? { sessionDigest: correlationKey } : {})
      }
    };
  } catch {
    return { error: SESSION_TRACE_REASON.INVALID_PROJECT_ROOT };
  }
}

export async function readSessionTraceEvents(options = {}) {
  const {
    dataDirectory,
    sessionId,
    correlationKey,
    projectRoot,
    fileSystem = defaultFileSystem
  } = options;
  if (!validDataDirectory(dataDirectory)) {
    return unsupported(SESSION_TRACE_REASON.NO_DATA_DIRECTORY);
  }
  const resolved = identityResult({
    sessionId,
    correlationKey,
    correlationProvided: Object.hasOwn(options, "correlationKey"),
    projectRoot
  });
  if (resolved.error) {
    return unsupported(resolved.error);
  }
  let store;
  try {
    store = await traceStore.resolveDirectory(dataDirectory, { create: false, fileSystem });
    await traceStore.assertDirectory(store, fileSystem);
  } catch (error) {
    return unsupported(error?.code === "ENOENT"
      ? SESSION_TRACE_REASON.NO_SESSION_TRACE
      : SESSION_TRACE_REASON.INVALID_SESSION_TRACE);
  }
  const target = tracePath(store.directory, resolved.identity.sessionDigest);
  let state;
  try {
    state = await readState(target, store.directory, fileSystem, { missing: true });
  } catch {
    return unsupported(SESSION_TRACE_REASON.INVALID_SESSION_TRACE);
  }
  if (state === null) {
    return unsupported(SESSION_TRACE_REASON.NO_SESSION_TRACE);
  }
  if (state.sessionDigest !== resolved.identity.sessionDigest) {
    return unsupported(SESSION_TRACE_REASON.SESSION_MISMATCH);
  }
  if (state.projectDigest !== resolved.identity.projectDigest) {
    return unsupported(SESSION_TRACE_REASON.PROJECT_MISMATCH);
  }
  return {
    status: "SUPPORTED",
    events: clone(state.events),
    limitReached: state.limitReached
  };
}

function lineStart(location) {
  return location.startLine ?? 1;
}

function lineEnd(location) {
  return location.endLine ?? Number.POSITIVE_INFINITY;
}

function outputLocation(range) {
  return {
    path: range.path,
    startLine: range.wholeFile ? null : range.start,
    endLine: range.wholeFile || range.end === Number.POSITIVE_INFINITY ? null : range.end,
    renderedTokens: range.renderedTokens
  };
}

function deduplicateSourceReads(events) {
  const inputs = events.map((event) => ({
    path: event.sourceLocation.path,
    start: lineStart(event.sourceLocation),
    end: lineEnd(event.sourceLocation),
    wholeFile: event.sourceLocation.startLine === null,
    renderedTokens: event.counts.renderedTokens ?? null
  })).sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.start - right.start
    || right.end - left.end
  ));

  const ranges = [];
  let ambiguousTokens = false;
  for (const input of inputs) {
    const current = ranges.at(-1);
    if (!current || current.path !== input.path || input.start > current.end) {
      ranges.push({ ...input });
      continue;
    }

    const sameRange = current.start === input.start && current.end === input.end;
    if (sameRange) {
      if (current.renderedTokens === null) {
        current.renderedTokens = input.renderedTokens;
      } else if (input.renderedTokens !== null && current.renderedTokens !== input.renderedTokens) {
        current.renderedTokens = null;
        ambiguousTokens = true;
      }
      current.wholeFile ||= input.wholeFile;
      continue;
    }

    if (current.end >= input.end) {
      if (current.renderedTokens === null) {
        ambiguousTokens = true;
      }
      current.wholeFile ||= input.wholeFile;
      continue;
    }

    const sameStart = current.start === input.start;
    current.end = input.end;
    current.wholeFile ||= input.wholeFile;
    if (sameStart && input.renderedTokens !== null) {
      current.renderedTokens = input.renderedTokens;
    } else {
      current.renderedTokens = null;
      ambiguousTokens = true;
    }
  }
  return { ranges: ranges.map(outputLocation), ambiguousTokens };
}

function lowerCoverage(current, next) {
  const rank = { exact: 2, partial: 1, unavailable: 0 };
  return rank[next] < rank[current] ? next : current;
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

// An execution without readable events reports every measure as unavailable, with the idle threshold it would use.
const { idleThresholdMs: IDLE_THRESHOLD_MS, ...UNAVAILABLE_MEASURES } = summarizeRunMeasures([], {});
const RUN_MEASURE_HOSTS = new Map([["claude-code-hook", "claude-code"], ["codex-hook", "codex"]]);
// Without readable executions, attribution reports no targets and an unavailable unattributed bucket.
function unavailableAttribution() {
  return attributeRunCost([], {});
}

// Replays every execution's events, or each `{ executions, counted }` replay, through attribution; a replay failure leaves
// the execution rows as they are.
function runAttribution(executions, host, sessionDigest) {
  try {
    return attributeRunCost(executions, { host, sessionDigest });
  } catch {
    return unavailableAttribution();
  }
}

function attributionInput(kind, digest, trace, lost) {
  return {
    kind,
    digest,
    events: trace?.status === "SUPPORTED" ? trace.events : [],
    ceiling: trace?.status === "SUPPORTED" && !trace.limitReached && !lost.has(digest) ? "exact" : "partial"
  };
}

function sessionDigestFor(options) {
  if (Object.hasOwn(options, "correlationKey")) {
    return typeof options.correlationKey === "string" && /^[a-f0-9]{64}$/.test(options.correlationKey)
      ? options.correlationKey
      : null;
  }
  try {
    return hashSessionTraceValue(options.sessionId, "sessionId");
  } catch {
    return null;
  }
}

function readExecutionTrace(options, executionDigest) {
  return readSessionTraceEvents({
    dataDirectory: options.dataDirectory,
    correlationKey: executionDigest,
    projectRoot: options.projectRoot,
    fileSystem: options.fileSystem
  });
}

function runMeasureRow(execution, executionDigest, host, events, { ended, limitReached, lost }) {
  const measures = summarizeRunMeasures(events, { host, ended, limitReached: limitReached || lost.has(executionDigest) });
  const { idleThresholdMs, ...fields } = measures;
  return {
    execution,
    executionDigest,
    host,
    ...fields,
    ...(host === "codex" ? { belowSession: "partial" } : {})
  };
}

function projectDigestFor(projectRoot) {
  return createSessionTraceIdentity({ sessionId: "run-statistics-loss", projectRoot }).projectDigest;
}

/**
 * Reads one session's run-statistics traces: the root execution's trace and each Claude subagent trace it links,
 * found by stored link events and by the loss markers of refused links.
 * Returns null without a session digest, else `{ host, sessionDigest, rootDigest, lost, executions }`, where each execution is
 * `{ kind, digest, trace, ceiling }` and `ceiling` is "partial" after a trace limit or a recorded loss.
 * `host` is null when the root trace is absent, unreadable, or has no run-statistics collector.
 */
export async function readRunStatisticsSession(options) {
  const sessionDigest = sessionDigestFor(options);
  if (!sessionDigest) return null;
  // Run-statistics traces are keyed by the digest of "<session digest>\0root" or "<session digest>\0agent:<id>".
  const rootDigest = rootTraceDigest(sessionDigest);
  const { lost, linked } = await readSessionTraceLosses({
    dataDirectory: options.dataDirectory,
    projectDigest: projectDigestFor(options.projectRoot),
    fileSystem: options.fileSystem
  });
  const execution = (kind, digest, trace) => ({ kind, digest, trace, ceiling: attributionInput(kind, digest, trace, lost).ceiling });
  const root = await readExecutionTrace(options, rootDigest);
  const session = { host: null, sessionDigest, rootDigest, lost, executions: [execution("root", rootDigest, root)] };
  if (root.status !== "SUPPORTED") return session;
  const collector = root.events.find((event) => RUN_MEASURE_HOSTS.has(event.provenance.collector))?.provenance.collector;
  session.host = RUN_MEASURE_HOSTS.get(collector) ?? null;
  if (session.host !== "claude-code") return session;
  const subagentDigests = [...new Set([
    ...root.events
      .filter((event) => ["subagent_start", "subagent_stop"].includes(event.eventType) && event.hashes.execution)
      .map((event) => event.hashes.execution),
    ...(linked.get(rootDigest) ?? [])
  ])];
  for (const digest of subagentDigests) {
    session.executions.push(execution("subagent", digest, await readExecutionTrace(options, digest)));
  }
  return session;
}

async function pendingStore(dataDirectory, fileSystem, create) {
  if (!validDataDirectory(dataDirectory)) return null;
  const store = await traceStore.resolveDirectory(dataDirectory, { create, fileSystem });
  await traceStore.assertDirectory(store, fileSystem);
  return store;
}

function pendingMarkerPath(store, sessionDigest, projectRoot) {
  const target = path.join(store.directory, `${sessionDigest}.${projectDigestFor(projectRoot)}.pending`);
  traceStore.assertDirectChild(store.directory, target, "The pending run marker path");
  return target;
}

/**
 * Marks a session as holding an unrecorded run, without the directory lock, and sets the marker's modification time to
 * `at`, the latest event time of the invocation; an existing marker only moves forward.
 */
export async function markRunsPending({ dataDirectory, projectRoot, sessionDigest, at, fileSystem = defaultFileSystem } = {}) {
  try {
    if (!/^[a-f0-9]{64}$/.test(sessionDigest ?? "") || !Number.isFinite(at)) return ignored(SESSION_TRACE_REASON.INVALID_EVENT);
    const store = await pendingStore(dataDirectory, fileSystem, true);
    if (!store) return ignored(SESSION_TRACE_REASON.NO_DATA_DIRECTORY);
    const target = pendingMarkerPath(store, sessionDigest, projectRoot);
    const when = new Date(at);
    let handle;
    try {
      handle = await traceStore.openPrivateFile(target, fileSystem);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const opened = await traceStore.openExistingRegularFile(target, store.directory, fileSystem);
      handle = opened.handle;
      if (opened.metadata.mtimeMs >= at) {
        await handle.close();
        return { status: "duplicate" };
      }
    }
    try {
      await handle.utimes(when, when);
    } finally {
      await handle.close();
    }
    return { status: "recorded" };
  } catch {
    return ignored(SESSION_TRACE_REASON.TRACE_UNAVAILABLE);
  }
}

/**
 * Returns the session digests of one project whose pending marker or claim is older than `before`, in digest order.
 * A marker or claim whose root trace is absent is removed.
 */
export async function listRunsPending({ dataDirectory, projectRoot, before, fileSystem = defaultFileSystem } = {}) {
  const sessions = new Set();
  try {
    const store = await pendingStore(dataDirectory, fileSystem, false);
    if (!store) return [];
    const projectDigest = projectDigestFor(projectRoot);
    for (const name of await fileSystem.readdir(store.directory)) {
      const match = PENDING_MARKER_PATTERN.exec(name);
      if (!match || match[2] !== projectDigest) continue;
      const filePath = path.join(store.directory, name);
      try {
        const metadata = await traceStore.inspectRegularFile(filePath, store.directory, fileSystem);
        const rootTrace = await traceStore.inspectRegularFile(tracePath(store.directory, rootTraceDigest(match[1])), store.directory, fileSystem, { missing: true });
        if (rootTrace === null) {
          await fileSystem.unlink(filePath);
          continue;
        }
        if (metadata.mtimeMs < before) sessions.add(match[1]);
      } catch {
        // An unreadable marker is skipped; directory cleanup ages it out.
      }
    }
  } catch {
    return [];
  }
  return [...sessions].sort();
}

/**
 * Clears a session's pending state after every run is recorded: renames the marker to a claim, re-reads the session,
 * marks it pending again when a run is open or unsealed, and then removes the claim.
 * A closed run in a trace at its own limit counts as sealed by that limit, with closures evaluated at `at` as the finalizer did.
 * A finalizer killed between the rename and the removal leaves a claim that later sweeps treat as pending.
 */
export async function clearRunsPending({ dataDirectory, projectRoot, sessionDigest, at = null, fileSystem = defaultFileSystem } = {}) {
  try {
    const store = await pendingStore(dataDirectory, fileSystem, false);
    if (!store) return ignored(SESSION_TRACE_REASON.NO_DATA_DIRECTORY);
    const marker = pendingMarkerPath(store, sessionDigest, projectRoot);
    const claim = `${marker}.claim`;
    const markerMetadata = await traceStore.inspectRegularFile(marker, store.directory, fileSystem, { missing: true });
    if (markerMetadata !== null) await fileSystem.rename(marker, claim);
    const session = await readRunStatisticsSession({ dataDirectory, projectRoot, correlationKey: sessionDigest, fileSystem });
    let latest = null;
    let unsettled = session === null;
    for (const execution of session?.executions ?? []) {
      if (execution.trace.status !== "SUPPORTED") continue;
      const events = execution.trace.events;
      if (events.length > 0) latest = Math.max(latest ?? 0, Date.parse(events.at(-1).occurredAt));
      unsettled ||= splitRuns(events, { host: session.host, traceDigest: execution.digest, at })
        .some((run) => run.runId !== null && run.closed !== "sealed" && !runSealedByTraceLimit(execution.trace, run));
    }
    if (unsettled && latest !== null) {
      await markRunsPending({ dataDirectory, projectRoot, sessionDigest, at: latest, fileSystem });
    }
    await fileSystem.unlink(claim).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return { status: unsettled ? "pending" : "cleared" };
  } catch {
    return ignored(SESSION_TRACE_REASON.TRACE_UNAVAILABLE);
  }
}

// Recorded totals with every measure unavailable, including runs, when collection is off or unknown or finalization failed.
function unavailableRecorded() {
  return totalRunSegments([{ unavailable: true }]);
}

// Session totals and attribution read only run-statistics traces; finished runs are recorded first, the calling session's
// recorded runs are totaled from their run records, and its unrecorded runs are reported in progress.
async function summarizeRunStatistics(options) {
  let collection = "unknown";
  try {
    if (typeof options.projectRoot === "string" && path.isAbsolute(options.projectRoot)) {
      collection = runStatisticsCollection(await readWorkflowConfig(options.projectRoot));
    }
  } catch {
    collection = "unknown";
  }
  const result = {
    collection,
    idleThresholdMs: IDLE_THRESHOLD_MS,
    executions: [],
    attribution: unavailableAttribution(),
    inProgress: unavailableAttribution(),
    recorded: unavailableRecorded()
  };
  const sessionDigest = sessionDigestFor(options);
  if (collection !== "on" || !sessionDigest) return result;
  let finalized = null;
  try {
    finalized = await recordFinishedRuns({
      dataDirectory: options.dataDirectory,
      projectRoot: options.projectRoot,
      sessionDigest,
      sweep: true,
      fileSystem: options.fileSystem
    });
  } catch {
    finalized = null;
  }
  if (finalized !== null && finalized.host !== null) {
    result.recorded = await readSessionRunTotals(finalized.recorded).catch(unavailableRecorded);
  }
  const session = await readRunStatisticsSession(options);
  const [root, ...subagents] = session.executions;
  if (root.trace.status !== "SUPPORTED") {
    // A root trace whose every append was refused still reports a row, so the loss is not silent.
    if (root.trace.reasonCode !== SESSION_TRACE_REASON.NO_SESSION_TRACE || session.lost.has(root.digest)) {
      result.executions.push({ execution: "root", executionDigest: root.digest, host: null, ...UNAVAILABLE_MEASURES });
    }
    return result;
  }
  const { host, lost } = session;
  if (host === null) return result;
  const attributionInputs = session.executions.map((execution) => attributionInput(execution.kind, execution.digest, execution.trace, lost));
  result.executions.push(runMeasureRow("root", root.digest, host, root.trace.events, {
    ended: host === "codex" ? null : "session_end",
    limitReached: root.trace.limitReached,
    lost
  }));
  for (const subagent of subagents) {
    result.executions.push(subagent.trace.status === "SUPPORTED"
      ? runMeasureRow("subagent", subagent.digest, host, subagent.trace.events, { ended: "subagent_stop", limitReached: subagent.trace.limitReached, lost })
      : { execution: "subagent", executionDigest: subagent.digest, host, ...UNAVAILABLE_MEASURES });
  }
  result.attribution = publicAttribution(runAttribution(attributionInputs, host, sessionDigest));
  if (finalized !== null && finalized.host === host) {
    result.inProgress = publicAttribution(runAttribution(finalized.unrecorded, host, sessionDigest));
  }
  return result;
}

// The destination project root and active intervals stay local, so no path reaches MCP output.
function publicAttribution(attribution) {
  return {
    targets: attribution.targets.map(({ projectRoot, activeIntervals, ...entry }) => entry),
    unattributed: attribution.unattributed
  };
}

export async function summarizeSessionConsumption(options = {}) {
  const [summary, runMeasures] = await Promise.all([
    summarizePreEditConsumption(options),
    summarizeRunStatistics(options).catch(() => ({
      collection: "unknown",
      idleThresholdMs: IDLE_THRESHOLD_MS,
      executions: [],
      attribution: unavailableAttribution(),
      inProgress: unavailableAttribution(),
      recorded: unavailableRecorded()
    }))
  ]);
  return { ...summary, runMeasures };
}

// The pre-edit summary reads only the root session trace, so run-statistics events never enter it.
async function summarizePreEditConsumption(options) {
  const trace = await readSessionTraceEvents(options);
  if (trace.status !== "SUPPORTED") {
    return {
      ...trace,
      preEdit: {
        window: "unknown",
        firstEditAt: null,
        sourceRanges: [],
        renderedTokens: null,
        sourceReadCount: null,
        searchCount: null
      },
      compaction: {
        count: null,
        countBeforeFirstEdit: null,
        firstObservedAt: null,
        firstBeforeFirstEditAt: null
      }
    };
  }

  const orderedEvents = orderTraceEvents(trace.events);
  const firstEditIndex = orderedEvents.findIndex((event) => event.eventType === "first_edit");
  const preEditEvents = firstEditIndex === -1 ? orderedEvents : orderedEvents.slice(0, firstEditIndex);
  const firstEdit = firstEditIndex === -1 ? null : orderedEvents[firstEditIndex];
  const sessionStart = preEditEvents.find((event) => event.eventType === "session_start");
  const reasons = [];
  let coverage = sessionStart?.coverage ?? "partial";
  if (!sessionStart) {
    addReason(reasons, SESSION_TRACE_COVERAGE_REASON.NO_SESSION_START);
  } else if (sessionStart.coverage === "partial") {
    addReason(reasons, SESSION_TRACE_COVERAGE_REASON.INITIAL_COVERAGE_PARTIAL);
  } else if (sessionStart.coverage === "unavailable") {
    addReason(reasons, SESSION_TRACE_COVERAGE_REASON.INITIAL_COVERAGE_UNAVAILABLE);
  }

  for (const event of preEditEvents) {
    if (event.eventType === "coverage_gap") {
      coverage = lowerCoverage(coverage, event.coverage);
      addReason(reasons, SESSION_TRACE_COVERAGE_REASON.COVERAGE_GAP);
    }
  }
  if (trace.limitReached) {
    coverage = lowerCoverage(coverage, "partial");
    addReason(reasons, SESSION_TRACE_COVERAGE_REASON.TRACE_LIMIT_REACHED);
  }

  const sourceReads = preEditEvents.filter((event) => event.eventType === "source_read" && event.sourceLocation);
  const searches = preEditEvents.filter((event) => event.eventType === "search");
  const missingSourceTokens = sourceReads.some((event) => event.counts.renderedTokens === undefined);
  const missingSearchTokens = searches.some((event) => event.counts.renderedTokens === undefined);
  if (missingSourceTokens || missingSearchTokens) {
    coverage = lowerCoverage(coverage, "partial");
    addReason(reasons, SESSION_TRACE_COVERAGE_REASON.MISSING_RENDERED_TOKEN_COUNT);
  }

  const deduplicated = deduplicateSourceReads(sourceReads);
  if (deduplicated.ambiguousTokens) {
    coverage = lowerCoverage(coverage, "partial");
    addReason(reasons, SESSION_TRACE_COVERAGE_REASON.OVERLAPPING_TOKEN_COUNTS);
  }
  const rangeTokensKnown = deduplicated.ranges.every((range) => range.renderedTokens !== null);
  const searchTokensKnown = searches.every((event) => event.counts.renderedTokens !== undefined);
  const observedContext = sourceReads.length > 0 || searches.length > 0;
  let renderedTokens = null;
  if (rangeTokensKnown && searchTokensKnown && (observedContext || coverage === "exact")) {
    renderedTokens = deduplicated.ranges.reduce((total, range) => total + range.renderedTokens, 0)
      + searches.reduce((total, event) => total + event.counts.renderedTokens, 0);
  }
  if (coverage === "unavailable") {
    renderedTokens = null;
  }

  const compactions = orderedEvents.filter((event) => event.eventType === "compaction");
  const preEditCompactions = preEditEvents.filter((event) => event.eventType === "compaction");
  return {
    status: "SUPPORTED",
    coverage,
    reasonCodes: reasons,
    preEdit: {
      window: firstEdit ? "closed" : "open",
      firstEditAt: firstEdit?.occurredAt ?? null,
      sourceRanges: deduplicated.ranges,
      renderedTokens,
      sourceReadCount: sourceReads.length,
      searchCount: searches.length
    },
    compaction: {
      count: compactions.length,
      countBeforeFirstEdit: preEditCompactions.length,
      firstObservedAt: compactions[0]?.occurredAt ?? null,
      firstBeforeFirstEditAt: preEditCompactions[0]?.occurredAt ?? null
    },
    provenance: {
      source: "local-session-trace",
      eventCount: trace.events.length,
      limitReached: trace.limitReached
    }
  };
}
