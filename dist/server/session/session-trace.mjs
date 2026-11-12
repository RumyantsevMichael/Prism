import { createHash } from "node:crypto";
import path from "node:path";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";

export const SESSION_TRACE_SCHEMA_VERSION = 1;
export const SESSION_TRACE_EVENT_TYPES = Object.freeze([
  "session_start",
  "model_switch",
  "search",
  "source_read",
  "edit_attempt",
  "first_edit",
  "edit",
  "test",
  "compaction",
  "coverage_gap",
  "session_end",
  "tool_start",
  "tool_end",
  "usage",
  "subagent_start",
  "subagent_stop",
  "prism_call",
  "run_start",
  "run_end"
]);
export const SESSION_TRACE_COVERAGE = Object.freeze(["exact", "partial", "unavailable"]);
export const SESSION_TRACE_GAP_REASONS = Object.freeze([
  "unsupported-event",
  "unsupported-read-path",
  "unsupported-mutation-path",
  "unproved-mutation-success",
  "missing-token-count",
  "estimated-token-count",
  "malformed-host-event",
  "observation-disabled",
  "observation-incomplete",
  "usage-unavailable"
]);
export const SESSION_TRACE_PROVENANCE = Object.freeze([
  "codex-hook",
  "claude-code-hook",
  "host-hook",
  "prism-mcp",
  "test"
]);
export const SESSION_TRACE_HOST_EVENTS = Object.freeze([
  "SessionStart",
  "PostModelSwitch",
  "ModelSwitch",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "Custom",
  "Unknown"
]);

const EVENT_KEYS = [
  "schemaVersion",
  "sessionDigest",
  "projectDigest",
  "eventIdDigest",
  "eventType",
  "occurredAt",
  "sourceLocation",
  "counts",
  "hashes",
  "coverage",
  "gapReason",
  "provenance"
];
// prismCall is an optional event field, present exactly on prism_call events, so stored schema-version-1 traces stay valid.
// A null prismCall records a call whose target could not be collected.
const OPTIONAL_EVENT_KEYS = ["prismCall"];
const PRISM_CALL_KEYS = ["initiative", "slice", "role", "namesSlice", "openWave", "designRun", "activeSlices", "facts"];
// The canonical project root whose records the call read stays in the local trace and never enters a record or output.
const OPTIONAL_PRISM_CALL_KEYS = ["projectRoot"];
const MAX_PRISM_PROJECT_ROOT_BYTES = 4096;
const PRISM_CALL_ROLES = new Set(["coordinator", "delivery", "reviewer"]);
const PRISM_CALL_FACTS = new Set(["exact", "partial"]);
const MAX_PRISM_SLUG_LENGTH = 120;
const MAX_PRISM_ACTIVE_SLICES = 32;
const PRISM_WAVE_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const SOURCE_LOCATION_KEYS = ["path", "startLine", "endLine"];
const COUNT_KEYS = [
  "renderedTokens",
  "resultCount",
  "byteCount",
  "durationMs",
  "exitCode",
  "inputTokens",
  "cacheWriteTokens",
  "cacheReadTokens",
  "outputTokens",
  "messageCount"
];
const HASH_KEYS = ["model", "tool", "execution", "call", "run"];
const PROVENANCE_KEYS = ["collector", "hostEvent"];
const EVENT_TYPE_SET = new Set(SESSION_TRACE_EVENT_TYPES);
const COVERAGE_SET = new Set(SESSION_TRACE_COVERAGE);
const GAP_REASON_SET = new Set(SESSION_TRACE_GAP_REASONS);
const PROVENANCE_SET = new Set(SESSION_TRACE_PROVENANCE);
const HOST_EVENT_SET = new Set(SESSION_TRACE_HOST_EVENTS);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_IDENTIFIER_BYTES = 1024;
const MAX_RELATIVE_PATH_BYTES = 4096;
const MAX_LINE_NUMBER = 100_000_000;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, allowed, required, name) {
  if (!isObject(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${name} contains an unknown property: ${key}.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${name}.${key} is required.`);
    }
  }
}

function assertDigest(value, name) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${name} must be a SHA-256 digest.`);
  }
}

function assertIsoDate(value, name) {
  if (typeof value !== "string") {
    throw new Error(`${name} must be an ISO date string.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${name} must be an ISO date string.`);
  }
}

function assertNullableLine(value, name) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > MAX_LINE_NUMBER)) {
    throw new Error(`${name} must be null or a positive line number.`);
  }
}

function assertCount(value, name) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer.`);
  }
  if (name.endsWith(".exitCode")) {
    if (value < -255 || value > 255) {
      throw new Error(`${name} is outside the supported range.`);
    }
    return;
  }
  if (value < 0) {
    throw new Error(`${name} must not be negative.`);
  }
}

function normalizedIdentifier(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > MAX_IDENTIFIER_BYTES) {
    throw new Error(`${name} is too large.`);
  }
  return normalized;
}

function normalizedProjectRoot(value) {
  const normalized = normalizedIdentifier(value, "projectRoot");
  if (!path.isAbsolute(normalized)) {
    throw new Error("projectRoot must be an absolute path.");
  }
  return path.normalize(normalized);
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashSessionTraceValue(value, name = "value") {
  return digest(normalizedIdentifier(value, name));
}

export function createSessionTraceIdentity({ sessionId, projectRoot }) {
  return {
    sessionDigest: digest(normalizedIdentifier(sessionId, "sessionId")),
    projectDigest: digest(normalizedProjectRoot(projectRoot))
  };
}

export function normalizeTraceSourcePath(value, projectRoot) {
  const root = normalizedProjectRoot(projectRoot);
  const input = normalizedIdentifier(value, "sourceLocation.path");
  const relative = path.isAbsolute(input) ? path.relative(root, path.normalize(input)) : input;
  const portable = relative.split(path.sep).join("/");
  const normalized = path.posix.normalize(portable);
  if (
    !normalized
    || normalized === "."
    || path.posix.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("\0")
  ) {
    throw new Error("sourceLocation.path must stay inside the project root.");
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_RELATIVE_PATH_BYTES) {
    throw new Error("sourceLocation.path is too large.");
  }
  return normalized;
}

function normalizeSourceLocation(value, projectRoot) {
  if (value === null || value === undefined) {
    return null;
  }
  assertExactKeys(value, SOURCE_LOCATION_KEYS, ["path"], "sourceLocation");
  const startLine = value.startLine ?? null;
  const endLine = value.endLine ?? null;
  assertNullableLine(startLine, "sourceLocation.startLine");
  assertNullableLine(endLine, "sourceLocation.endLine");
  if (startLine === null && endLine !== null) {
    throw new Error("sourceLocation.endLine requires sourceLocation.startLine.");
  }
  if (startLine !== null && endLine !== null && endLine < startLine) {
    throw new Error("sourceLocation.endLine must not precede sourceLocation.startLine.");
  }
  return {
    path: normalizeTraceSourcePath(value.path, projectRoot),
    startLine,
    endLine
  };
}

function normalizeCounts(value = {}) {
  assertExactKeys(value, COUNT_KEYS, [], "counts");
  const counts = {};
  for (const key of COUNT_KEYS) {
    if (Object.hasOwn(value, key)) {
      assertCount(value[key], `counts.${key}`);
      counts[key] = value[key];
    }
  }
  return counts;
}

function normalizeHashes(value = {}) {
  assertExactKeys(value, HASH_KEYS, [], "hashValues");
  const hashes = {};
  for (const key of HASH_KEYS) {
    if (Object.hasOwn(value, key)) {
      hashes[key] = hashSessionTraceValue(value[key], `hashValues.${key}`);
    }
  }
  return hashes;
}

function normalizeProvenance(value = {}) {
  assertExactKeys(value, PROVENANCE_KEYS, ["collector", "hostEvent"], "provenance");
  if (!PROVENANCE_SET.has(value.collector)) {
    throw new Error("provenance.collector is invalid.");
  }
  if (value.hostEvent !== null && !HOST_EVENT_SET.has(value.hostEvent)) {
    throw new Error("provenance.hostEvent is invalid.");
  }
  return { collector: value.collector, hostEvent: value.hostEvent };
}

function assertPrismSlug(value, name) {
  if (typeof value !== "string" || value.length > MAX_PRISM_SLUG_LENGTH || !SLUG_PATTERN.test(value)) {
    throw new Error(`${name} must be a slug.`);
  }
}

// A prism_call event stores only target identifiers, a role enum, numbers, and a bounded slug list.
function assertPrismCall(value) {
  assertExactKeys(value, [...PRISM_CALL_KEYS, ...OPTIONAL_PRISM_CALL_KEYS], PRISM_CALL_KEYS, "sessionTraceEvent.prismCall");
  if (Object.hasOwn(value, "projectRoot") && (
    typeof value.projectRoot !== "string"
    || !path.isAbsolute(value.projectRoot)
    || path.normalize(value.projectRoot) !== value.projectRoot
    || Buffer.byteLength(value.projectRoot, "utf8") > MAX_PRISM_PROJECT_ROOT_BYTES
  )) {
    throw new Error("sessionTraceEvent.prismCall.projectRoot must be an absolute normalized path.");
  }
  assertPrismSlug(value.initiative, "sessionTraceEvent.prismCall.initiative");
  assertPrismSlug(value.slice, "sessionTraceEvent.prismCall.slice");
  if (value.role !== null && !PRISM_CALL_ROLES.has(value.role)) {
    throw new Error("sessionTraceEvent.prismCall.role is invalid.");
  }
  if (typeof value.namesSlice !== "boolean") {
    throw new Error("sessionTraceEvent.prismCall.namesSlice must be a boolean.");
  }
  if (value.openWave !== null && (typeof value.openWave !== "string" || !PRISM_WAVE_ID_PATTERN.test(value.openWave))) {
    throw new Error("sessionTraceEvent.prismCall.openWave is invalid.");
  }
  if (value.designRun !== null && (!Number.isSafeInteger(value.designRun) || value.designRun < 1)) {
    throw new Error("sessionTraceEvent.prismCall.designRun must be null or a positive integer.");
  }
  if (value.activeSlices !== null) {
    if (!Array.isArray(value.activeSlices) || value.activeSlices.length > MAX_PRISM_ACTIVE_SLICES) {
      throw new Error("sessionTraceEvent.prismCall.activeSlices must be null or at most 32 slugs.");
    }
    value.activeSlices.forEach((slug, index) => assertPrismSlug(slug, `sessionTraceEvent.prismCall.activeSlices[${index}]`));
  }
  if (!PRISM_CALL_FACTS.has(value.facts)) {
    throw new Error("sessionTraceEvent.prismCall.facts is invalid.");
  }
}

function normalizePrismCall(value) {
  if (value === null) return null;
  if (!isObject(value)) {
    throw new TypeError("prismCall must be an object.");
  }
  assertExactKeys(value, [...PRISM_CALL_KEYS, ...OPTIONAL_PRISM_CALL_KEYS], PRISM_CALL_KEYS, "prismCall");
  return {
    ...(Object.hasOwn(value, "projectRoot") ? { projectRoot: value.projectRoot } : {}),
    initiative: value.initiative,
    slice: value.slice,
    role: value.role,
    namesSlice: value.namesSlice,
    openWave: value.openWave,
    designRun: value.designRun,
    activeSlices: Array.isArray(value.activeSlices) ? [...value.activeSlices].sort() : value.activeSlices,
    facts: value.facts
  };
}

export function validateSessionTraceEvent(event) {
  assertExactKeys(event, [...EVENT_KEYS, ...OPTIONAL_EVENT_KEYS], EVENT_KEYS, "sessionTraceEvent");
  if (event.schemaVersion !== SESSION_TRACE_SCHEMA_VERSION) {
    throw new Error(`Unsupported session trace schema version: ${event.schemaVersion}.`);
  }
  assertDigest(event.sessionDigest, "sessionTraceEvent.sessionDigest");
  assertDigest(event.projectDigest, "sessionTraceEvent.projectDigest");
  assertDigest(event.eventIdDigest, "sessionTraceEvent.eventIdDigest");
  if (!EVENT_TYPE_SET.has(event.eventType)) {
    throw new Error("sessionTraceEvent.eventType is invalid.");
  }
  assertIsoDate(event.occurredAt, "sessionTraceEvent.occurredAt");

  if (event.sourceLocation !== null) {
    assertExactKeys(event.sourceLocation, SOURCE_LOCATION_KEYS, SOURCE_LOCATION_KEYS, "sessionTraceEvent.sourceLocation");
    if (
      typeof event.sourceLocation.path !== "string"
      || !event.sourceLocation.path
      || path.posix.isAbsolute(event.sourceLocation.path)
      || event.sourceLocation.path === ".."
      || event.sourceLocation.path.startsWith("../")
      || path.posix.normalize(event.sourceLocation.path) !== event.sourceLocation.path
      || Buffer.byteLength(event.sourceLocation.path, "utf8") > MAX_RELATIVE_PATH_BYTES
    ) {
      throw new Error("sessionTraceEvent.sourceLocation.path is invalid.");
    }
    assertNullableLine(event.sourceLocation.startLine, "sessionTraceEvent.sourceLocation.startLine");
    assertNullableLine(event.sourceLocation.endLine, "sessionTraceEvent.sourceLocation.endLine");
    if (event.sourceLocation.startLine === null && event.sourceLocation.endLine !== null) {
      throw new Error("The trace source end line requires a start line.");
    }
    if (
      event.sourceLocation.startLine !== null
      && event.sourceLocation.endLine !== null
      && event.sourceLocation.endLine < event.sourceLocation.startLine
    ) {
      throw new Error("The trace source end line must not precede the start line.");
    }
  }

  assertExactKeys(event.counts, COUNT_KEYS, [], "sessionTraceEvent.counts");
  for (const [key, value] of Object.entries(event.counts)) {
    assertCount(value, `sessionTraceEvent.counts.${key}`);
  }
  assertExactKeys(event.hashes, HASH_KEYS, [], "sessionTraceEvent.hashes");
  for (const [key, value] of Object.entries(event.hashes)) {
    assertDigest(value, `sessionTraceEvent.hashes.${key}`);
  }
  if (event.coverage !== null && !COVERAGE_SET.has(event.coverage)) {
    throw new Error("sessionTraceEvent.coverage is invalid.");
  }
  if (event.gapReason !== null && !GAP_REASON_SET.has(event.gapReason)) {
    throw new Error("sessionTraceEvent.gapReason is invalid.");
  }
  assertExactKeys(event.provenance, PROVENANCE_KEYS, PROVENANCE_KEYS, "sessionTraceEvent.provenance");
  if (!PROVENANCE_SET.has(event.provenance.collector)) {
    throw new Error("sessionTraceEvent.provenance.collector is invalid.");
  }
  if (event.provenance.hostEvent !== null && !HOST_EVENT_SET.has(event.provenance.hostEvent)) {
    throw new Error("sessionTraceEvent.provenance.hostEvent is invalid.");
  }

  if (event.eventType === "prism_call") {
    if (!Object.hasOwn(event, "prismCall")) {
      throw new Error("A prism_call event requires prismCall.");
    }
    if (event.prismCall !== null) assertPrismCall(event.prismCall);
  } else if (Object.hasOwn(event, "prismCall")) {
    throw new Error("Only prism_call events can contain prismCall.");
  }

  if (event.eventType === "session_start") {
    if (event.coverage === null) {
      throw new Error("A session_start event requires coverage.");
    }
    if (event.gapReason !== null) {
      throw new Error("A session_start event cannot contain a gap reason.");
    }
  } else if (event.eventType === "coverage_gap") {
    if (event.coverage !== "partial" && event.coverage !== "unavailable") {
      throw new Error("A coverage_gap event requires partial or unavailable coverage.");
    }
    if (event.gapReason === null) {
      throw new Error("A coverage_gap event requires a gap reason.");
    }
  } else if (event.coverage !== null || event.gapReason !== null) {
    throw new Error("Only session_start and coverage_gap events can set coverage fields.");
  }
  return true;
}

export function createSessionTraceEvent({
  sessionId,
  projectRoot,
  eventId,
  eventType,
  occurredAt,
  sourceLocation = null,
  counts = {},
  hashValues = {},
  coverage = null,
  gapReason = null,
  provenance,
  executionKey = null,
  prismCall = null
}) {
  const normalizedRoot = normalizedProjectRoot(projectRoot);
  const normalizedEventId = normalizedIdentifier(eventId, "eventId");
  if (!EVENT_TYPE_SET.has(eventType)) {
    throw new Error("eventType is invalid.");
  }
  const identity = createSessionTraceIdentity({ sessionId, projectRoot: normalizedRoot });
  const event = {
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionDigest: executionKey === null
      ? identity.sessionDigest
      : hashSessionTraceValue(executionKey, "executionKey"),
    projectDigest: identity.projectDigest,
    eventIdDigest: digest(`${eventType}\0${normalizedEventId}`),
    eventType,
    occurredAt,
    sourceLocation: normalizeSourceLocation(sourceLocation, normalizedRoot),
    counts: normalizeCounts(counts),
    hashes: normalizeHashes(hashValues),
    coverage,
    gapReason,
    provenance: normalizeProvenance(provenance),
    ...(eventType === "prism_call" ? { prismCall: normalizePrismCall(prismCall) } : {})
  };
  validateSessionTraceEvent(event);
  return event;
}
