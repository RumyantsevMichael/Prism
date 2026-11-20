// Generated from src/server/session/run-records.mts by scripts/native-build/compile.mjs.
import { lstat } from "node:fs/promises";
import { attributeRunCost, splitRuns, summarizeRunMeasures } from "./run-measures.mjs";
import { readRunStatisticsCollection } from "./prism-call-target.mjs";
import { SESSION_TRACE_SCHEMA_VERSION, hashSessionTraceValue } from "./session-trace.mjs";
import {
  appendSessionTraceEvent,
  clearRunsPending,
  listRunsPending,
  readRunStatisticsSession,
  runSealedByTraceLimit
} from "./session-trace-store.mjs";
import { SLUG_PATTERN } from "../workflow/initiative-graph.mjs";
import { appendRecord, listRecordEntries, recordPath, resolveRecordFile } from "../workflow/record-store.mjs";
const RUN_RECORD_SCHEMA_VERSION = 1;
const QUIET_SESSION_MS = 30 * 60 * 1e3;
const ENTRY_LOCK_STALE_MS = 30 * 1e3;
const { idleThresholdMs: IDLE_THRESHOLD_MS } = summarizeRunMeasures([], {});
const HOSTS = /* @__PURE__ */ new Set(["claude-code", "codex"]);
const ROLES = /* @__PURE__ */ new Set(["coordinator", "delivery", "reviewer"]);
const COVERAGE = /* @__PURE__ */ new Set(["exact", "approximate", "partial", "unavailable"]);
const MEASURE_KEYS = ["wallTimeMs", "activeTimeMs", "inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens", "toolCalls"];
const RECORD_KEYS = ["schemaVersion", "runId", "host", "initiative", "slice", "startedAt", "endedAt", "idleThresholdMs", "segments"];
const RUN_ID_PATTERN = /^[a-f0-9]{64}$/;
const WAVE_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const MAX_SLUG_LENGTH = 120;
const MAX_ACTIVE_INTERVALS = 512;
function invalid(message) {
  return new Error(`Invalid run record: ${message}`);
}
function assertKeys(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw invalid(`${name} has other keys`);
}
function assertSlug(value, name) {
  if (typeof value !== "string" || value.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(value)) throw invalid(`${name} must be a slug`);
}
function assertTimestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw invalid(`${name} must be an ISO timestamp`);
  }
}
function assertMeasure(value, name, valid) {
  assertKeys(value, ["value", "coverage"], name);
  if (!COVERAGE.has(value.coverage)) throw invalid(`${name}.coverage is invalid`);
  if (value.coverage === "unavailable" ? value.value !== null : !valid(value.value)) throw invalid(`${name}.value is invalid`);
}
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const intervals = (value) => Array.isArray(value) && value.length <= MAX_ACTIVE_INTERVALS && value.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every(count) && pair[0] <= pair[1]);
function assertRunRecord(record) {
  assertKeys(record, RECORD_KEYS, "record");
  if (record.schemaVersion !== RUN_RECORD_SCHEMA_VERSION) throw invalid("schemaVersion is unsupported");
  if (typeof record.runId !== "string" || !RUN_ID_PATTERN.test(record.runId)) throw invalid("runId must be 64 hex");
  if (!HOSTS.has(record.host)) throw invalid("host is invalid");
  assertSlug(record.initiative, "initiative");
  assertSlug(record.slice, "slice");
  assertTimestamp(record.startedAt, "startedAt");
  assertTimestamp(record.endedAt, "endedAt");
  if (record.idleThresholdMs !== IDLE_THRESHOLD_MS) throw invalid("idleThresholdMs is invalid");
  if (!Array.isArray(record.segments) || record.segments.length === 0) throw invalid("segments must be a nonempty list");
  for (const [index, segment] of record.segments.entries()) {
    const name = `segments[${index}]`;
    const targetKeys = segment?.kind === "wave" ? ["wave"] : segment?.kind === "design-run" ? ["designRun"] : [];
    if (!["wave", "design-run", "slice"].includes(segment?.kind)) throw invalid(`${name}.kind is invalid`);
    assertKeys(segment, ["kind", ...targetKeys, "role", "attribution", ...MEASURE_KEYS, "activeIntervals"], name);
    if (segment.kind === "wave" && (typeof segment.wave !== "string" || !WAVE_ID_PATTERN.test(segment.wave))) throw invalid(`${name}.wave is invalid`);
    if (segment.kind === "design-run" && (!Number.isSafeInteger(segment.designRun) || segment.designRun < 1)) throw invalid(`${name}.designRun is invalid`);
    if (!ROLES.has(segment.role)) throw invalid(`${name}.role is invalid`);
    if (!COVERAGE.has(segment.attribution)) throw invalid(`${name}.attribution is invalid`);
    for (const key of MEASURE_KEYS) assertMeasure(segment[key], `${name}.${key}`, count);
    assertMeasure(segment.activeIntervals, `${name}.activeIntervals`, intervals);
  }
  return record;
}
async function readRunRecords(projectRoot, key) {
  let entries;
  try {
    entries = await listRecordEntries(projectRoot, key);
  } catch {
    return { records: [], readable: false, invalid: 0 };
  }
  const records = [];
  let invalidCount = 0;
  for (const { id, entry } of entries) {
    try {
      assertRunRecord(entry);
      if (entry.runId !== id || entry.initiative !== key.initiative || entry.slice !== key.slice) throw invalid("record does not match its key");
      records.push(entry);
    } catch {
      invalidCount += 1;
    }
  }
  return { records, readable: true, invalid: invalidCount };
}
function segmentOf(entry) {
  const { target } = entry;
  return {
    kind: target.kind,
    ...target.kind === "wave" ? { wave: target.wave } : {},
    ...target.kind === "design-run" ? { designRun: target.designRun } : {},
    role: entry.role,
    attribution: entry.attribution,
    ...Object.fromEntries(MEASURE_KEYS.map((key) => [key, { value: entry[key].value, coverage: entry[key].coverage }])),
    activeIntervals: { value: entry.activeIntervals.value, coverage: entry.activeIntervals.coverage }
  };
}
function recordsOf(run, host, attribution, hookProjectRoot) {
  const groups = /* @__PURE__ */ new Map();
  for (const entry of attribution.targets) {
    const projectRoot = entry.projectRoot ?? hookProjectRoot;
    const key = JSON.stringify([projectRoot, entry.target.initiative, entry.target.slice]);
    if (!groups.has(key)) groups.set(key, { projectRoot, initiative: entry.target.initiative, slice: entry.target.slice, entries: [] });
    groups.get(key).entries.push(entry);
  }
  const times = run.events.map((event) => event.occurredAt).sort();
  return [...groups.values()].map((group) => ({
    projectRoot: group.projectRoot,
    key: { kind: "runs", initiative: group.initiative, slice: group.slice },
    record: assertRunRecord({
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId: run.runId,
      host,
      initiative: group.initiative,
      slice: group.slice,
      startedAt: times[0],
      endedAt: times.at(-1),
      idleThresholdMs: IDLE_THRESHOLD_MS,
      segments: group.entries.map(segmentOf)
    })
  }));
}
function runEndFor(run) {
  const start = run.events.find((event) => event.eventType === "run_start");
  const last = run.events.at(-1);
  return {
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionDigest: start.sessionDigest,
    projectDigest: start.projectDigest,
    eventIdDigest: hashSessionTraceValue(`run_end\0run-end:${run.runId}`, "eventId"),
    eventType: "run_end",
    occurredAt: last.occurredAt,
    sourceLocation: null,
    counts: {},
    hashes: { run: run.runId },
    coverage: null,
    gapReason: null,
    provenance: { ...start.provenance }
  };
}
async function entryLocked(projectRoot, key, runId, nowMs) {
  try {
    const info = await lstat((await resolveRecordFile(projectRoot, `${recordPath(key)}/${runId}.json.lock`)).target);
    return nowMs - info.mtimeMs <= ENTRY_LOCK_STALE_MS;
  } catch {
    return false;
  }
}
async function appendRunRecords(records, { deadline, now }) {
  const stored = [];
  const failed = { outcome: "failed", stored: [] };
  for (const { projectRoot, key, record } of records) {
    if (performance.now() > deadline) return failed;
    const collection = await readRunStatisticsCollection(projectRoot, { deadline });
    if (collection === "off") continue;
    if (collection !== "on") return failed;
    if (performance.now() > deadline || await entryLocked(projectRoot, key, record.runId, now())) return failed;
    try {
      await appendRecord(projectRoot, key, record.runId, record);
    } catch (error) {
      if (error?.code !== "entry_exists") return failed;
    }
    stored.push({ projectRoot, key, runId: record.runId });
  }
  return { outcome: "recorded", stored };
}
function attributionExecutions(session, execution, run, earlier, ceiling) {
  const root = session.executions[0];
  const own = { kind: execution.kind, digest: execution.digest, events: run.events, contextEvents: earlier, ceiling };
  if (execution.kind === "root" || root.trace.status !== "SUPPORTED") return [own];
  return [{ kind: "root", digest: root.digest, events: root.trace.events, ceiling: root.ceiling }, own];
}
async function finalizeSession({ dataDirectory, projectRoot, sessionDigest, at, deadline, now, fileSystem }) {
  if (performance.now() > deadline) return { host: null, unrecorded: [], recorded: [], settled: false };
  const session = await readRunStatisticsSession({ dataDirectory, projectRoot, correlationKey: sessionDigest, fileSystem });
  if (session === null || session.host === null) return { host: null, unrecorded: [], recorded: [], settled: false };
  const { host } = session;
  const unrecorded = [];
  const recorded = [];
  let settled = true;
  for (const execution of session.executions) {
    if (execution.trace.status !== "SUPPORTED") continue;
    const pending = [];
    const earlier = [];
    let blocked = false;
    for (const run of splitRuns(execution.trace.events, { host, traceDigest: execution.digest, at })) {
      const context = [...earlier];
      earlier.push(...run.events);
      if (run.runId === null) continue;
      if (blocked || run.closed === null || performance.now() > deadline) {
        pending.push({ run, context, failed: false });
        blocked ||= run.closed !== null;
        continue;
      }
      let ceiling = execution.ceiling;
      if (run.closed !== "sealed") {
        const sealed = await appendSessionTraceEvent(runEndFor(run), { dataDirectory, fileSystem });
        const trace = { limitReached: execution.trace.limitReached || sealed.limitReached === true };
        if (sealed.status !== "appended" && sealed.status !== "duplicate" && runSealedByTraceLimit(trace, run)) {
          ceiling = "partial";
        } else if (!["appended", "duplicate"].includes(sealed.status)) {
          pending.push({ run, context, failed: false });
          blocked = true;
          continue;
        }
      }
      let outcome = "failed";
      let stored = [];
      try {
        const attribution = attributeRunCost(attributionExecutions(session, execution, run, context, ceiling), {
          host,
          sessionDigest,
          counted: /* @__PURE__ */ new Set([execution.digest])
        });
        ({ outcome, stored } = await appendRunRecords(recordsOf(run, host, attribution, projectRoot), { deadline, now }));
      } catch {
        outcome = "failed";
      }
      if (outcome === "recorded") recorded.push(...stored);
      else pending.push({ run, context, failed: true });
    }
    if (pending.length > 0) settled = false;
    for (const { run, context, failed } of pending) {
      unrecorded.push({
        executions: attributionExecutions(session, execution, run, context, failed ? "partial" : execution.ceiling),
        counted: /* @__PURE__ */ new Set([execution.digest])
      });
    }
  }
  return { host, unrecorded, recorded, settled };
}
async function recordFinishedRuns({
  dataDirectory,
  projectRoot,
  sessionDigest,
  sweep = false,
  own = true,
  deadline = Number.POSITIVE_INFINITY,
  now = () => Date.now(),
  fileSystem
} = {}) {
  const context = { dataDirectory, projectRoot, deadline, now, fileSystem };
  let result = { host: null, unrecorded: [], recorded: [] };
  if (own) {
    const finalized = await finalizeSession({ ...context, sessionDigest, at: null });
    if (finalized.settled) await clearRunsPending({ dataDirectory, projectRoot, sessionDigest, at: null, fileSystem });
    result = { host: finalized.host, unrecorded: finalized.unrecorded, recorded: finalized.recorded };
  }
  if (!sweep) return result;
  const quiet = await listRunsPending({ dataDirectory, projectRoot, before: now() - QUIET_SESSION_MS, fileSystem });
  for (const other of quiet.filter((digest) => digest !== sessionDigest)) {
    if (performance.now() > deadline) break;
    const at = now();
    const finalized = await finalizeSession({ ...context, sessionDigest: other, at });
    if (finalized.settled) await clearRunsPending({ dataDirectory, projectRoot, sessionDigest: other, at, fileSystem });
  }
  return result;
}
export {
  readRunRecords,
  recordFinishedRuns
};
