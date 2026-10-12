import { randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import path from "node:path";
import {
  SESSION_TRACE_SCHEMA_VERSION,
  createSessionTraceIdentity,
  hashSessionTraceValue,
  validateSessionTraceEvent
} from "./session-trace.mjs";
import { LOCK_STALE_MS, createPrivateSessionStore, defaultIsProcessAlive } from "./private-session-store.mjs";

const TRACE_DIRECTORY = "session-traces";
const MAX_TRACE_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_TRACE_EVENTS = 4096;
export const SESSION_TRACE_MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
export const SESSION_TRACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_KEYS = ["schemaVersion", "sessionDigest", "projectDigest", "limitReached", "events"];
const EVENT_TYPE_ORDER = new Map([
  ["session_start", 0],
  ["model_switch", 1],
  ["coverage_gap", 2],
  ["search", 3],
  ["source_read", 3],
  ["test", 3],
  ["compaction", 3],
  ["edit_attempt", 4],
  ["edit", 5],
  ["first_edit", 6],
  ["session_end", 7]
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
  DIRECT_FIRST_EDIT: "DIRECT_FIRST_EDIT"
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
  [SESSION_TRACE_REASON.DIRECT_FIRST_EDIT]: "The trace store creates first_edit events from successful edit events."
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
    const finalRecord = /^[a-f0-9]{64}\.json$/.test(entry.name);
    const temporaryRecord = /^[a-f0-9]{64}\.json\..+\.tmp$/.test(entry.name);
    if (!finalRecord && !temporaryRecord) {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    if (finalRecord && filePath === target) {
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
        evictable: finalRecord
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
  const retained = [];
  for (const record of await traceFileRecords(directory, target, nowMs, fileSystem, assertOwnership)) {
    if (record.evictable && record.mtimeMs < cutoff) {
      await assertOwnership();
      await fileSystem.unlink(record.path);
    } else {
      retained.push(record);
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
    await assertOwnership();
    await fileSystem.unlink(record.path);
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

    const priorFirstEdit = state.events.find((stored) => stored.eventType === "first_edit");
    const candidate = { ...state, events: orderTraceEvents([...state.events, event]) };
    const nextFirstEdit = candidate.events.find((stored) => stored.eventType === "first_edit");
    const appendedEventTypes = [event.eventType];
    if (event.eventType === "edit" && priorFirstEdit?.occurredAt !== nextFirstEdit?.occurredAt) {
      appendedEventTypes.push("first_edit");
    }
    if (candidate.events.length > MAX_TRACE_EVENTS || stateBytes(candidate) > MAX_TRACE_BYTES) {
      if (!state.limitReached) {
        await writeState(target, store.directory, { ...state, limitReached: true }, fileSystem, {
          assertOwnership
        });
      }
      return ignored(SESSION_TRACE_REASON.TRACE_LIMIT_REACHED);
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

export async function summarizeSessionConsumption(options = {}) {
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
