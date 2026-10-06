import assert from "node:assert/strict";
import * as defaultFileSystem from "node:fs/promises";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SESSION_TRACE_GAP_REASONS,
  createSessionTraceEvent,
  validateSessionTraceEvent
} from "../../dist/server/session/session-trace.mjs";
import {
  SESSION_TRACE_COVERAGE_REASON,
  SESSION_TRACE_REASON,
  appendSessionTraceEvent,
  readSessionTraceEvents,
  summarizeSessionConsumption
} from "../../dist/server/session/session-trace-store.mjs";

const sessionId = "private-session-identifier";
const projectRoot = "/workspace/private-project";
const occurredAt = "2026-09-19T12:00:00.000Z";

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function traceEvent(eventType, overrides = {}) {
  return createSessionTraceEvent({
    sessionId: overrides.sessionId ?? sessionId,
    projectRoot: overrides.projectRoot ?? projectRoot,
    eventId: `${eventType}-${overrides.eventSuffix ?? "1"}`,
    eventType,
    occurredAt: overrides.occurredAt ?? occurredAt,
    sourceLocation: overrides.sourceLocation ?? null,
    counts: overrides.counts ?? {},
    hashValues: overrides.hashValues ?? {},
    coverage: overrides.coverage ?? (eventType === "session_start" ? "exact" : null),
    gapReason: overrides.gapReason ?? null,
    provenance: overrides.provenance ?? { collector: "test", hostEvent: "Custom" }
  });
}

test("creates content-free events with hashed identities and relative source locations", () => {
  const event = traceEvent("source_read", {
    sourceLocation: {
      path: "/workspace/private-project/server/private-source.mjs",
      startLine: 4,
      endLine: 12
    },
    counts: { renderedTokens: 91, byteCount: 418 },
    hashValues: { model: "private-model-name", tool: "Read" }
  });

  assert.equal(validateSessionTraceEvent(event), true);
  assert.deepEqual(event.sourceLocation, {
    path: "server/private-source.mjs",
    startLine: 4,
    endLine: 12
  });
  assert.match(event.sessionDigest, /^[a-f0-9]{64}$/);
  assert.match(event.projectDigest, /^[a-f0-9]{64}$/);
  assert.match(event.hashes.model, /^[a-f0-9]{64}$/);

  const serialized = JSON.stringify(event);
  for (const privateValue of [sessionId, projectRoot, "private-model-name", "/workspace/private-project"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("rejects unknown properties and source locations outside the project", () => {
  assert.throws(() => createSessionTraceEvent({
    sessionId,
    projectRoot,
    eventId: "outside-read",
    eventType: "source_read",
    occurredAt,
    sourceLocation: { path: "/workspace/other-project/secret.mjs" },
    provenance: { collector: "test", hostEvent: "Custom" }
  }), /stay inside/);

  const event = traceEvent("search");
  assert.throws(() => validateSessionTraceEvent({ ...event, prompt: "private prompt" }), /unknown property/);
});

test("stores events with private permissions and adds one first_edit marker", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-trace-");
  const start = traceEvent("session_start");
  const attempt = traceEvent("edit_attempt");
  const edit = traceEvent("edit", {
    sourceLocation: { path: "server/change.mjs", startLine: null, endLine: null },
    occurredAt: "2026-09-19T12:01:00.000Z"
  });

  assert.equal((await appendSessionTraceEvent(start, { dataDirectory })).status, "appended");
  assert.equal((await appendSessionTraceEvent(attempt, { dataDirectory })).status, "appended");
  const editResult = await appendSessionTraceEvent(edit, { dataDirectory });
  assert.deepEqual(editResult.appendedEventTypes, ["edit", "first_edit"]);
  assert.equal((await appendSessionTraceEvent(edit, { dataDirectory })).status, "duplicate");

  const trace = await readSessionTraceEvents({ dataDirectory, sessionId, projectRoot });
  assert.equal(trace.status, "SUPPORTED");
  assert.equal(trace.events.filter((event) => event.eventType === "first_edit").length, 1);
  assert.deepEqual(trace.events.map((event) => event.eventType), [
    "session_start",
    "edit_attempt",
    "edit",
    "first_edit"
  ]);

  const traceDirectory = path.join(dataDirectory, "session-traces");
  const storedNames = await readdir(traceDirectory);
  const traceName = storedNames.find((name) => name.endsWith(".json"));
  const target = path.join(traceDirectory, traceName);
  assert.equal((await stat(traceDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  const stored = await readFile(target, "utf8");
  assert.equal(stored.includes(sessionId), false);
  assert.equal(stored.includes(projectRoot), false);
});

test("does not close the pre-edit window after failed edit attempts", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-attempt-");
  await appendSessionTraceEvent(traceEvent("session_start"), { dataDirectory });
  await appendSessionTraceEvent(traceEvent("edit_attempt"), { dataDirectory });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(summary.status, "SUPPORTED");
  assert.equal(summary.coverage, "exact");
  assert.equal(summary.preEdit.window, "open");
  assert.equal(summary.preEdit.firstEditAt, null);
  assert.equal(summary.preEdit.renderedTokens, 0);
});

test("deduplicates contained source ranges before it totals rendered tokens", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-ranges-");
  const events = [
    traceEvent("session_start"),
    traceEvent("source_read", {
      eventSuffix: "wide",
      sourceLocation: { path: "server/source.mjs", startLine: 1, endLine: 20 },
      counts: { renderedTokens: 200 }
    }),
    traceEvent("source_read", {
      eventSuffix: "contained",
      sourceLocation: { path: "server/source.mjs", startLine: 5, endLine: 10 },
      counts: { renderedTokens: 60 }
    }),
    traceEvent("compaction", {
      occurredAt: "2026-09-19T12:00:30.000Z"
    }),
    traceEvent("edit", {
      occurredAt: "2026-09-19T12:01:00.000Z",
      sourceLocation: { path: "server/source.mjs", startLine: 9, endLine: 9 }
    }),
    traceEvent("source_read", {
      eventSuffix: "after-edit",
      occurredAt: "2026-09-19T12:02:00.000Z",
      sourceLocation: { path: "server/late.mjs", startLine: 1, endLine: 2 },
      counts: { renderedTokens: 50 }
    })
  ];
  for (const event of events) {
    await appendSessionTraceEvent(event, { dataDirectory });
  }

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(summary.coverage, "exact");
  assert.equal(summary.preEdit.window, "closed");
  assert.equal(summary.preEdit.renderedTokens, 200);
  assert.deepEqual(summary.preEdit.sourceRanges, [{
    path: "server/source.mjs",
    startLine: 1,
    endLine: 20,
    renderedTokens: 200
  }]);
  assert.equal(summary.compaction.countBeforeFirstEdit, 1);
  assert.equal(summary.compaction.firstBeforeFirstEditAt, "2026-09-19T12:00:30.000Z");
});

test("reports partial coverage and null consumption when observations are incomplete", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-partial-");
  await appendSessionTraceEvent(traceEvent("session_start", { coverage: "partial" }), { dataDirectory });
  await appendSessionTraceEvent(traceEvent("edit", {
    occurredAt: "2026-09-19T12:01:00.000Z"
  }), { dataDirectory });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(summary.coverage, "partial");
  assert.equal(summary.preEdit.renderedTokens, null);
  assert.ok(summary.reasonCodes.includes(SESSION_TRACE_COVERAGE_REASON.INITIAL_COVERAGE_PARTIAL));
});

test("returns unavailable coverage instead of zero when no trace exists", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-missing-");
  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });

  assert.equal(summary.status, "UNSUPPORTED");
  assert.equal(summary.coverage, "unavailable");
  assert.equal(summary.reasonCode, SESSION_TRACE_REASON.NO_SESSION_TRACE);
  assert.equal(summary.preEdit.renderedTokens, null);
  assert.equal(summary.preEdit.sourceReadCount, null);
});

test("reads a trace by its validated session correlation key", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-correlation-");
  const start = traceEvent("session_start");
  await appendSessionTraceEvent(start, { dataDirectory });

  const supported = await readSessionTraceEvents({
    dataDirectory,
    correlationKey: start.sessionDigest,
    projectRoot
  });
  assert.equal(supported.status, "SUPPORTED");

  const invalid = await readSessionTraceEvents({
    dataDirectory,
    correlationKey: "not-a-digest",
    projectRoot
  });
  assert.equal(invalid.reasonCode, SESSION_TRACE_REASON.INVALID_CORRELATION_KEY);

  const missing = await readSessionTraceEvents({
    dataDirectory,
    correlationKey: "",
    projectRoot
  });
  assert.equal(missing.reasonCode, SESSION_TRACE_REASON.NO_CORRELATION_KEY);
});

test("isolates an invalid stored trace", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-invalid-");
  const start = traceEvent("session_start");
  await appendSessionTraceEvent(start, { dataDirectory });
  const target = path.join(dataDirectory, "session-traces", `${start.sessionDigest}.json`);
  await writeFile(target, "{}\n", { mode: 0o600 });

  const result = await appendSessionTraceEvent(traceEvent("search"), { dataDirectory });
  assert.equal(result.reasonCode, SESSION_TRACE_REASON.INVALID_SESSION_TRACE);
  assert.equal(await readFile(target, "utf8"), "{}\n");
});

test("the canonical validator enforces persisted event variants", () => {
  const start = traceEvent("session_start");
  assert.throws(
    () => validateSessionTraceEvent({ ...start, gapReason: "unsupported-event" }),
    /session_start event cannot contain a gap reason/
  );

  const gap = traceEvent("coverage_gap", {
    coverage: "partial",
    gapReason: "unsupported-event"
  });
  assert.throws(
    () => validateSessionTraceEvent({ ...gap, gapReason: null }),
    /requires a gap reason/
  );
  assert.throws(
    () => validateSessionTraceEvent({ ...traceEvent("search"), coverage: "partial" }),
    /Only session_start and coverage_gap events/
  );
  for (const [index, gapReason] of SESSION_TRACE_GAP_REASONS.entries()) {
    assert.equal(validateSessionTraceEvent(traceEvent("coverage_gap", {
      eventSuffix: `reason-${index}`,
      coverage: "partial",
      gapReason
    })), true);
  }
});

test("uses the JavaScript validator as the only persisted event contract", async () => {
  await assert.rejects(
    access(new URL("../../dist/server/session-trace.schema.json", import.meta.url)),
    (error) => error?.code === "ENOENT"
  );
});

test("removes expired traces when another event is stored", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-expiry-");
  const expired = traceEvent("session_start", { sessionId: "expired-session" });
  const retained = traceEvent("session_start", { sessionId: "retained-session" });
  await appendSessionTraceEvent(expired, { dataDirectory });
  await appendSessionTraceEvent(retained, { dataDirectory });

  const traceDirectory = path.join(dataDirectory, "session-traces");
  const expiredPath = path.join(traceDirectory, `${expired.sessionDigest}.json`);
  await utimes(expiredPath, new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z"));
  const trigger = traceEvent("session_start", { sessionId: "trigger-session" });
  await appendSessionTraceEvent(trigger, {
    dataDirectory,
    now: () => new Date("2026-09-19T12:00:00.000Z")
  });

  const names = await readdir(traceDirectory);
  assert.equal(names.includes(`${expired.sessionDigest}.json`), false);
  assert.equal(names.includes(`${retained.sessionDigest}.json`), true);
  assert.equal(names.includes(`${trigger.sessionDigest}.json`), true);
});

test("removes the oldest eligible trace to enforce the aggregate byte quota", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-quota-");
  const first = traceEvent("session_start", { sessionId: "quota-session-a" });
  const second = traceEvent("session_start", { sessionId: "quota-session-b" });
  const third = traceEvent("session_start", { sessionId: "quota-session-c" });
  for (const event of [first, second, third]) {
    await appendSessionTraceEvent(event, { dataDirectory });
  }

  const traceDirectory = path.join(dataDirectory, "session-traces");
  const tracePath = (event) => path.join(traceDirectory, `${event.sessionDigest}.json`);
  await utimes(tracePath(first), new Date("2026-09-16T00:00:00.000Z"), new Date("2026-09-16T00:00:00.000Z"));
  await utimes(tracePath(second), new Date("2026-09-16T00:00:00.000Z"), new Date("2026-09-16T00:00:00.000Z"));
  await utimes(tracePath(third), new Date("2026-09-18T00:00:00.000Z"), new Date("2026-09-18T00:00:00.000Z"));
  const traceSize = (await stat(tracePath(first))).size;
  const fourth = traceEvent("session_start", { sessionId: "quota-session-d" });
  await appendSessionTraceEvent(fourth, {
    dataDirectory,
    maxDirectoryBytes: traceSize * 3,
    maxTraceAgeMs: Number.MAX_SAFE_INTEGER,
    now: () => new Date("2026-09-19T12:00:00.000Z")
  });

  const names = await readdir(traceDirectory);
  const [evicted, retainedTie] = [first, second].sort((left, right) => (
    left.sessionDigest < right.sessionDigest ? -1 : 1
  ));
  assert.equal(names.includes(`${evicted.sessionDigest}.json`), false);
  for (const event of [retainedTie, third, fourth]) {
    assert.equal(names.includes(`${event.sessionDigest}.json`), true);
  }
});

test("serializes concurrent append cleanup under the aggregate quota", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-concurrent-quota-");
  const first = traceEvent("session_start", { sessionId: "concurrent-session-a" });
  const second = traceEvent("session_start", { sessionId: "concurrent-session-b" });
  const third = traceEvent("session_start", { sessionId: "concurrent-session-c" });
  await appendSessionTraceEvent(first, { dataDirectory });

  const traceDirectory = path.join(dataDirectory, "session-traces");
  const firstPath = path.join(traceDirectory, `${first.sessionDigest}.json`);
  await utimes(firstPath, new Date("2026-09-01T00:00:00.000Z"), new Date("2026-09-01T00:00:00.000Z"));
  const traceSize = (await stat(firstPath)).size;
  const results = await Promise.all([
    appendSessionTraceEvent(second, {
      dataDirectory,
      maxDirectoryBytes: traceSize * 2,
      maxTraceAgeMs: Number.MAX_SAFE_INTEGER
    }),
    appendSessionTraceEvent(third, {
      dataDirectory,
      maxDirectoryBytes: traceSize * 2,
      maxTraceAgeMs: Number.MAX_SAFE_INTEGER
    })
  ]);

  assert.deepEqual(results.map((result) => result.status), ["appended", "appended"]);
  const names = await readdir(traceDirectory);
  assert.equal(names.includes(`${first.sessionDigest}.json`), false);
  assert.equal(names.includes(`${second.sessionDigest}.json`), true);
  assert.equal(names.includes(`${third.sessionDigest}.json`), true);
});

test("orders delayed observations by occurrence time before deriving the first edit", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-out-of-order-");
  await appendSessionTraceEvent(traceEvent("session_start", {
    occurredAt: "2026-09-19T12:00:00.000Z"
  }), { dataDirectory });
  await appendSessionTraceEvent(traceEvent("edit", {
    occurredAt: "2026-09-19T12:02:00.000Z"
  }), { dataDirectory });
  await appendSessionTraceEvent(traceEvent("source_read", {
    occurredAt: "2026-09-19T12:01:00.000Z",
    sourceLocation: { path: "server/late-arrival.mjs", startLine: 1, endLine: 3 },
    counts: { renderedTokens: 21 }
  }), { dataDirectory });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(summary.coverage, "exact");
  assert.equal(summary.preEdit.firstEditAt, "2026-09-19T12:02:00.000Z");
  assert.equal(summary.preEdit.sourceReadCount, 1);
  assert.equal(summary.preEdit.renderedTokens, 21);
});

test("moves the derived first-edit boundary when an earlier edit arrives late", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-late-edit-");
  await appendSessionTraceEvent(traceEvent("session_start", {
    occurredAt: "2026-09-19T12:00:00.000Z"
  }), { dataDirectory });
  await appendSessionTraceEvent(traceEvent("edit", {
    eventSuffix: "later",
    occurredAt: "2026-09-19T12:03:00.000Z"
  }), { dataDirectory });
  await appendSessionTraceEvent(traceEvent("source_read", {
    occurredAt: "2026-09-19T12:02:00.000Z",
    sourceLocation: { path: "server/after-actual-edit.mjs", startLine: 1, endLine: 2 },
    counts: { renderedTokens: 13 }
  }), { dataDirectory });
  const result = await appendSessionTraceEvent(traceEvent("edit", {
    eventSuffix: "earlier-late-arrival",
    occurredAt: "2026-09-19T12:01:00.000Z"
  }), { dataDirectory });

  assert.deepEqual(result.appendedEventTypes, ["edit", "first_edit"]);
  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(summary.preEdit.firstEditAt, "2026-09-19T12:01:00.000Z");
  assert.equal(summary.preEdit.sourceReadCount, 0);
  assert.equal(summary.preEdit.renderedTokens, 0);
});

test("rejects a symbolic-link trace directory without changing its target", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-directory-link-");
  const outsideDirectory = await temporaryDirectory(context, "prism-session-directory-target-");
  const marker = path.join(outsideDirectory, "marker.txt");
  await writeFile(marker, "outside\n", { mode: 0o600 });
  await symlink(outsideDirectory, path.join(dataDirectory, "session-traces"), "dir");

  const result = await appendSessionTraceEvent(traceEvent("session_start"), { dataDirectory });
  assert.equal(result.reasonCode, SESSION_TRACE_REASON.TRACE_UNAVAILABLE);
  assert.equal(await readFile(marker, "utf8"), "outside\n");
  assert.equal((await stat(outsideDirectory)).mode & 0o777, 0o700);
});

test("removes stale trace temporary files before enforcing the aggregate quota", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-temp-quota-");
  const directory = path.join(dataDirectory, "session-traces");
  await mkdir(directory, { mode: 0o700 });
  const temporary = path.join(directory, `${"a".repeat(64)}.json.123.crash.tmp`);
  await writeFile(temporary, "x".repeat(4096), { mode: 0o600 });
  const staleTime = new Date("2026-09-19T10:00:00.000Z");
  await utimes(temporary, staleTime, staleTime);

  const result = await appendSessionTraceEvent(traceEvent("session_start"), {
    dataDirectory,
    maxDirectoryBytes: 1024,
    now: () => new Date("2026-09-19T12:00:00.000Z")
  });
  assert.equal(result.status, "appended");
  await assert.rejects(access(temporary), (error) => error.code === "ENOENT");
  const names = await readdir(directory);
  const totalBytes = (await Promise.all(names
    .filter((name) => name.endsWith(".json") || name.endsWith(".tmp"))
    .map(async (name) => (await stat(path.join(directory, name))).size)))
    .reduce((total, size) => total + size, 0);
  assert.ok(totalBytes <= 1024);
});

test("counts fresh trace temporary files against the aggregate quota", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-fresh-temp-quota-");
  const directory = path.join(dataDirectory, "session-traces");
  await mkdir(directory, { mode: 0o700 });
  const temporary = path.join(directory, `${"b".repeat(64)}.json.123.active.tmp`);
  await writeFile(temporary, "x".repeat(4096), { mode: 0o600 });
  const activeTime = new Date("2026-09-19T12:00:00.000Z");
  await utimes(temporary, activeTime, activeTime);

  const result = await appendSessionTraceEvent(traceEvent("session_start"), {
    dataDirectory,
    maxDirectoryBytes: 1024,
    now: () => activeTime
  });
  assert.equal(result.reasonCode, SESSION_TRACE_REASON.TRACE_LIMIT_REACHED);
  assert.equal((await stat(temporary)).size, 4096);
});

test("rejects a symbolic-link trace record without reading or replacing its target", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-record-link-");
  const outsideDirectory = await temporaryDirectory(context, "prism-session-record-target-");
  const start = traceEvent("session_start");
  await appendSessionTraceEvent(start, { dataDirectory });
  const target = path.join(dataDirectory, "session-traces", `${start.sessionDigest}.json`);
  const outside = path.join(outsideDirectory, "outside.json");
  await writeFile(outside, "outside\n", { mode: 0o600 });
  await rm(target);
  await symlink(outside, target);

  const append = await appendSessionTraceEvent(traceEvent("search"), { dataDirectory });
  assert.equal(append.reasonCode, SESSION_TRACE_REASON.TRACE_UNAVAILABLE);
  const read = await readSessionTraceEvents({ dataDirectory, sessionId, projectRoot });
  assert.equal(read.reasonCode, SESSION_TRACE_REASON.INVALID_SESSION_TRACE);
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("does not take over an aged lock while its owner is still alive", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-live-lock-");
  const directory = path.join(dataDirectory, "session-traces");
  const lockDirectory = path.join(directory, ".retention.lock");
  const token = "11111111-1111-4111-8111-111111111111";
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lockDirectory, `owner-${token}`), `${JSON.stringify({ token, pid: process.pid })}\n`, {
    mode: 0o600
  });
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(lockDirectory, staleTime, staleTime);

  const result = await appendSessionTraceEvent(traceEvent("session_start"), {
    dataDirectory,
    isProcessAlive: async () => true
  });
  assert.equal(result.reasonCode, SESSION_TRACE_REASON.LOCK_UNAVAILABLE);
  assert.equal((await readdir(lockDirectory)).length, 1);
});

test("reclaims an aged lock only when its token owner is confirmed dead", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-dead-lock-");
  const directory = path.join(dataDirectory, "session-traces");
  const lockDirectory = path.join(directory, ".retention.lock");
  const token = "22222222-2222-4222-8222-222222222222";
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lockDirectory, `owner-${token}`), `${JSON.stringify({ token, pid: 999999 })}\n`, {
    mode: 0o600
  });
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(lockDirectory, staleTime, staleTime);

  const result = await appendSessionTraceEvent(traceEvent("session_start"), {
    dataDirectory,
    isProcessAlive: async () => false
  });
  assert.equal(result.status, "appended");
});

test("a writer that loses lock ownership neither commits nor acknowledges its event", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-session-lost-lock-");
  const successorToken = "33333333-3333-4333-8333-333333333333";
  let replacedOwner = false;
  const fileSystem = {
    ...defaultFileSystem,
    async open(target, flags, mode) {
      const handle = await defaultFileSystem.open(target, flags, mode);
      if (!target.endsWith(".tmp")) return handle;
      return {
        writeFile: handle.writeFile.bind(handle),
        sync: handle.sync.bind(handle),
        async close() {
          await handle.close();
          if (replacedOwner) return;
          replacedOwner = true;
          const lockDirectory = path.join(dataDirectory, "session-traces", ".retention.lock");
          const [ownerName] = await defaultFileSystem.readdir(lockDirectory);
          await defaultFileSystem.unlink(path.join(lockDirectory, ownerName));
          await defaultFileSystem.writeFile(
            path.join(lockDirectory, `owner-${successorToken}`),
            `${JSON.stringify({ token: successorToken, pid: process.pid })}\n`,
            { mode: 0o600 }
          );
        }
      };
    }
  };
  const start = traceEvent("session_start");
  const result = await appendSessionTraceEvent(start, { dataDirectory, fileSystem });
  assert.equal(result.reasonCode, SESSION_TRACE_REASON.LOCK_UNAVAILABLE);
  const target = path.join(dataDirectory, "session-traces", `${start.sessionDigest}.json`);
  await assert.rejects(access(target), (error) => error.code === "ENOENT");
  assert.deepEqual(await readdir(path.join(dataDirectory, "session-traces", ".retention.lock")), [
    `owner-${successorToken}`
  ]);
});
