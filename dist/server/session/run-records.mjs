// Finished runs become immutable, content-free run records in the project whose records each Prism call read.
// The finalizer runs in the trace hook under a host time limit and in session consumption reads, so every wait is bounded.
import { lstat } from "node:fs/promises";
import path from "node:path";
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
import { appendRecord, listRecordEntries, recordPath } from "../workflow/record-store.mjs";

const RUN_RECORD_SCHEMA_VERSION = 1;
const QUIET_SESSION_MS = 30 * 60 * 1000;
// appendRecord waits up to 5 s for an entry lock that is younger than this, which never fits inside the hook limit.
const ENTRY_LOCK_STALE_MS = 30 * 1000;
const { idleThresholdMs: IDLE_THRESHOLD_MS } = summarizeRunMeasures([], {});
const HOSTS = new Set(["claude-code", "codex"]);
const ROLES = new Set(["coordinator", "delivery", "reviewer"]);
const COVERAGE = new Set(["exact", "approximate", "partial", "unavailable"]);
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
const intervals = (value) => Array.isArray(value) && value.length <= MAX_ACTIVE_INTERVALS
  && value.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every(count) && pair[0] <= pair[1]);

// The record contract: only allowlisted counts, durations, timestamps, coverage marks, host, role, and identifiers,
// so a builder defect fails here before anything is appended.
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

/**
 * Reads the run records of one `{ kind: "runs", initiative, slice }` key only through the record store seam.
 * Returns `{ records, readable, invalid }`: an entry outside the record contract, or whose run, initiative, or slice does
 * not match its id and key, is skipped and counted in `invalid`, and a key the seam cannot read gives `readable: false`.
 */
export async function readRunRecords(projectRoot, key) {
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
    ...(target.kind === "wave" ? { wave: target.wave } : {}),
    ...(target.kind === "design-run" ? { designRun: target.designRun } : {}),
    role: entry.role,
    attribution: entry.attribution,
    ...Object.fromEntries(MEASURE_KEYS.map((key) => [key, { value: entry[key].value, coverage: entry[key].coverage }])),
    activeIntervals: { value: entry.activeIntervals.value, coverage: entry.activeIntervals.coverage }
  };
}

// One record per destination project, initiative, and slice that the run's attributed cost served.
function recordsOf(run, host, attribution, hookProjectRoot) {
  const groups = new Map();
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

// The run_end that seals a run at its last event time, so a later event for it is refused instead of vanishing.
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

// A young entry lock means a live writer, and appendRecord would wait for it longer than the hook may run.
async function entryLocked(projectRoot, key, runId, nowMs) {
  try {
    const info = await lstat(path.join(projectRoot, recordPath(key), `${runId}.json.lock`));
    return nowMs - info.mtimeMs <= ENTRY_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

// Appends every record of one run; "recorded" when each is appended, already exists, or its destination is off.
// `stored` lists the destinations whose record was appended or already existed.
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

// The run's own events are counted, and its execution's earlier events are context, so the target current at the run's
// start carries into it; a subagent also inherits the root segment current at its start link from the root's full events.
function attributionExecutions(session, execution, run, earlier, ceiling) {
  const root = session.executions[0];
  const own = { kind: execution.kind, digest: execution.digest, events: run.events, contextEvents: earlier, ceiling };
  if (execution.kind === "root" || root.trace.status !== "SUPPORTED") return [own];
  return [{ kind: "root", digest: root.digest, events: root.trace.events, ceiling: root.ceiling }, own];
}

// Records one session's closed runs and returns its unrecorded runs as attribution replays, each with the executions and
// context the finalizer replays it with, so in-progress counts follow the same targets the finalizer records.
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
      // A refused seal leaves this run and every later run of the trace pending, so runs are sealed in order.
      // A trace at its own limit refuses the seal and every later event, so its closed run is sealed by that limit and
      // recorded with a partial ceiling; a full shared directory sets no trace limit and leaves the run pending.
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
          counted: new Set([execution.digest])
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
        counted: new Set([execution.digest])
      });
    }
  }
  return { host, unrecorded, recorded, settled };
}

/**
 * Records the calling session's closed runs and, with `sweep`, the closed runs of the project's other sessions that have
 * been quiet for over 30 minutes. The calling session closes runs only by seal, its own end, or a later run.
 * Starts no trace read and no append after `deadline` (a `performance.now()` time); whatever remains stays pending.
 * Returns `{ host, unrecorded, recorded }`: the calling session's unrecorded runs as `attributeRunCost` replays with the
 * same executions and context the finalizer uses, where a run whose append failed has a partial ceiling, and
 * `[{ projectRoot, key, runId }]` for each record of its runs whose records were all appended or already existed.
 */
export async function recordFinishedRuns({
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
