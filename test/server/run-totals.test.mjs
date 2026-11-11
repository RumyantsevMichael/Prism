import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";
import { readSliceRunTotals } from "../../dist/server/session/run-totals.mjs";
import { hashSessionTraceValue } from "../../dist/server/session/session-trace.mjs";
import { appendRecord, listRecordEntries } from "../../dist/server/workflow/record-store.mjs";
import { BASE, SECOND, runRecord, segment } from "./fixtures/run-records.mjs";
import { defer } from "./fixtures/teardown.mjs";

// Requirements: docs/requirements/run-statistics.md §3, §11, §12, §19.
// Feature: docs/Features/F-run-totals-reads.feature.
// Records are seeded through the record store seam, and every total is read back through the three MCP reads.

const SERVER = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const NO_NATIVE = fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url));
const PRISM = "mcp__plugin_prism_prism-review__";
const MINUTE = 60 * SECOND;
const HASH = "0".repeat(64);
const MEASURES = ["wallTimeMs", "elapsedActiveTimeMs", "summedActiveTimeMs", "inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens", "toolCalls"];
const RUN = { a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64), d: "d".repeat(64), e: "e".repeat(64), f: "f".repeat(64) };
const REVIEW_PATH = ".prism/initiatives/demo/slices/alpha-one/review.json";

async function scratch(context, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  defer(context, () => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

const sliceEntry = (title, parent, status) => ({ title, status, parent, requirements: ["docs/requirements/run-statistics.md#11"], dependencies: [] });
const INITIATIVE = {
  schemaVersion: 1,
  id: "demo",
  slices: {
    demo: sliceEntry("Demo", null, "split"),
    alpha: sliceEntry("Alpha", "demo", "split"),
    "alpha-one": sliceEntry("Alpha one", "alpha", "in-progress"),
    beta: sliceEntry("Beta", "demo", "not-started"),
    gamma: sliceEntry("Gamma", "demo", "not-started")
  },
  history: []
};
const WAVE = {
  id: "design-1",
  mode: "design-audit",
  deltaRevision: HASH,
  baselineId: HASH,
  snapshotId: HASH,
  comparisonId: HASH,
  lanes: [{ id: "design", reviewer: "reviewer-1", coverage: ["src"] }],
  accepted: { evidenceDigest: HASH, actor: "coordinator-1", at: "2026-10-23T09:00:00.000Z" }
};
const LEDGER = {
  schemaVersion: 1,
  deltaPath: ".prism/initiatives/demo/slices/alpha-one/change-map.json",
  coordinator: "coordinator-1",
  delivery: "delivery-1",
  deliveryWorkers: ["delivery-1"],
  waves: [WAVE],
  findings: [],
  assessments: [],
  conflicts: [],
  exchangeWorkers: [],
  legacy: [],
  history: []
};

// Initiative demo: split root demo, split parent alpha with leaf alpha-one, leaves beta (no records) and gamma (unreadable).
async function seededProject(context) {
  const root = await scratch(context, "prism-run-totals-project-");
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "# Workflow config\n\n## Run statistics\n- Collection: on\n");
  await mkdir(path.join(root, ".prism", "initiatives", "demo", "slices", "alpha-one"), { recursive: true });
  await writeFile(path.join(root, ".prism", "initiatives", "demo", "initiative.json"), `${JSON.stringify(INITIATIVE, null, 2)}\n`);
  await writeFile(path.join(root, REVIEW_PATH), JSON.stringify(LEDGER));
  const key = (slice) => ({ kind: "runs", initiative: "demo", slice });
  await appendRecord(root, key("alpha-one"), RUN.a, runRecord(RUN.a, "alpha-one", [
    segment({ kind: "wave", wave: "design-1" }, { role: "coordinator", wall: 120, from: 0, to: 60, tokens: [10, 0, 5, 3], tools: 2 }),
    segment({ kind: "design-run", designRun: 1 }, { role: "delivery", wall: 90, from: 30, to: 90, tokens: [20, 0, 0, 4], tools: 3 })
  ], [0, 120]));
  await appendRecord(root, key("alpha-one"), RUN.b, runRecord(RUN.b, "alpha-one", [
    segment({ kind: "slice" }, { role: "delivery", wall: 30, from: 600, to: 630, tokens: [1, 0, 0, 1], tools: 1 })
  ]));
  await appendRecord(root, key("alpha"), RUN.c, runRecord(RUN.c, "alpha", [
    segment({ kind: "slice" }, { role: "coordinator", wall: 60, from: 60, to: 120, tokens: [100, 0, 0, 10], tools: 4 })
  ]));
  await appendRecord(root, key("demo"), RUN.e, runRecord(RUN.e, "demo", [
    segment({ kind: "slice" }, { role: "coordinator", wall: 10, from: 1000, to: 1010, tokens: [7, 0, 0, 1], tools: 1 })
  ]));
  // A record outside the allowlisted shape is skipped, and one over the 1 MiB entry bound makes gamma's key unreadable.
  const outside = { ...runRecord(RUN.f, "demo", [segment({ kind: "slice" }, { role: "coordinator", wall: 1, from: 2000, to: 2001, tokens: [1, 0, 0, 1], tools: 1 })]), prompt: "private" };
  await appendRecord(root, key("demo"), RUN.f, outside);
  const gamma = path.join(root, ".prism", "initiatives", "demo", "slices", "gamma", "runs");
  await mkdir(gamma, { recursive: true });
  await writeFile(path.join(gamma, `${RUN.d}.json`), JSON.stringify({ padding: "x".repeat(1024 * 1024) }));
  return root;
}

// A JSON-RPC client over the built MCP server's stdio that resolves each response by its request id.
function mcpClient(context, root, environment = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: root,
    env: { ...process.env, PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: NO_NATIVE, CLAUDE_PROJECT_DIR: root, ...environment },
    stdio: ["pipe", "pipe", "inherit"]
  });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (text) => {
    const message = JSON.parse(text);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  defer(context, () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.stdin.end();
  }));
  let nextId = 0;
  const request = (method, params) => new Promise((resolve) => {
    nextId += 1;
    pending.set(nextId, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params })}\n`);
  });
  return {
    start: () => request("initialize", { protocolVersion: "2025-06-18", capabilities: {} }),
    tools: async () => (await request("tools/list", {})).result.tools,
    async call(name, args) {
      const response = await request("tools/call", { name, arguments: args });
      assert.equal(response.error, undefined, `${name} must succeed: ${JSON.stringify(response.error)}`);
      return response.result;
    }
  };
}

const known = (value, coverage) => ({ value, coverage });
const UNAVAILABLE = known(null, "unavailable");

// Expected totals: times in seconds and tokens as [input, cache-write, cache-read, output].
// Wall time is the first-to-last span; a wave or design run has no stored segment times, so its span is approximate.
function totals({ runs, wall, elapsed, summed, tokens, tools }, coverage = "exact", wallCoverage = coverage) {
  return {
    runs: known(runs, coverage),
    wallTimeMs: known(wall * SECOND, wallCoverage),
    elapsedActiveTimeMs: known(elapsed * SECOND, coverage),
    summedActiveTimeMs: known(summed * SECOND, coverage),
    inputTokens: known(tokens[0], coverage),
    cacheWriteTokens: known(tokens[1], coverage),
    cacheReadTokens: known(tokens[2], coverage),
    outputTokens: known(tokens[3], coverage),
    toolCalls: known(tools, coverage),
    idleThresholdMs: 300000
  };
}

function withoutMeasures(runs) {
  return { runs, ...Object.fromEntries(MEASURES.map((name) => [name, UNAVAILABLE])), idleThresholdMs: 300000 };
}

const ALPHA_ONE = {
  slice: totals({ runs: 2, wall: 630, elapsed: 120, summed: 150, tokens: [31, 0, 5, 8], tools: 6 }),
  waves: [{ wave: "design-1", totals: totals({ runs: 1, wall: 60, elapsed: 60, summed: 60, tokens: [10, 0, 5, 3], tools: 2 }, "exact", "approximate") }],
  designRuns: [{ designRun: 1, totals: totals({ runs: 1, wall: 60, elapsed: 60, summed: 60, tokens: [20, 0, 0, 4], tools: 3 }, "exact", "approximate") }]
};

test("a review read keeps its content and adds the slice, wave, and design-run totals of the slice's run records", async (context) => {
  const root = await seededProject(context);
  const mcp = mcpClient(context, root);
  await mcp.start();

  const tools = Object.fromEntries((await mcp.tools()).map((tool) => [tool.name, tool]));
  assert.equal(tools.get_review.annotations.readOnlyHint, false, "a first read of an earlier ship records and marks its slice documents");

  const review = (await mcp.call("get_review", { projectRoot: root, initiative: "demo", slice: "alpha-one" })).structuredContent;
  const { runTotals, ...content } = review;
  assert.deepEqual(Object.keys(content).sort(), ["coordinator", "currentWave", "deferred", "delivery", "deltaPath", "entries", "exists", "nextOffset",
    "projectionStale", "revision", "schemaVersion", "section", "totalCount"], "the existing review fields stay unchanged");
  assert.equal(content.exists, true);
  assert.deepEqual(content.currentWave, WAVE);
  assert.deepEqual(content.entries, []);
  assert.deepEqual(runTotals, ALPHA_ONE, "wall time spans the runs, and overlapping active intervals count once in elapsed and fully in summed active time");
});

test("an initiative read adds slice, split-parent, and initiative totals with coverage instead of zeros", async (context) => {
  const root = await seededProject(context);
  const mcp = mcpClient(context, root);
  await mcp.start();

  const tools = Object.fromEntries((await mcp.tools()).map((tool) => [tool.name, tool]));
  assert.equal(tools.get_initiative.annotations.readOnlyHint, false, "a first read of an earlier ship records and marks its slice documents");

  const result = await mcp.call("get_initiative", { projectRoot: root, initiative: "demo" });
  const { runTotals, ...content } = result.structuredContent;
  assert.deepEqual(Object.keys(content).sort(), ["derived", "errors", "exists", "initiative", "projectionPath", "record", "recordPath", "revision", "valid"],
    "the existing initiative fields stay unchanged");
  assert.deepEqual(content.record, INITIATIVE);
  assert.equal(content.derived.root, "demo");
  assert.ok(runTotals, "the initiative read reports run totals");
  assert.equal(JSON.stringify(runTotals).includes(root), false, "no project path reaches the totals");

  const { slices } = runTotals;
  assert.deepEqual(Object.keys(slices).sort(), ["alpha", "alpha-one", "beta", "demo", "gamma"]);
  assert.deepEqual(slices["alpha-one"], { ...ALPHA_ONE, withDescendants: ALPHA_ONE.slice }, "the initiative and review reads agree");

  // The split parent's own record, and its descendants' records with overlapping work counted once in elapsed time.
  assert.deepEqual(slices.alpha.slice, totals({ runs: 1, wall: 60, elapsed: 60, summed: 60, tokens: [100, 0, 0, 10], tools: 4 }));
  assert.deepEqual(slices.alpha.withDescendants, totals({ runs: 3, wall: 630, elapsed: 150, summed: 210, tokens: [131, 0, 5, 18], tools: 10 }));
  assert.deepEqual(slices.alpha.waves, []);

  // No records: zero runs, and every other measure unavailable rather than zero.
  assert.deepEqual(slices.beta.slice, withoutMeasures(known(0, "exact")));
  // An entry over the 1 MiB bound makes the whole key unreadable, which lowers coverage without failing the read.
  assert.deepEqual(slices.gamma.slice, withoutMeasures(UNAVAILABLE));
  assert.deepEqual(slices.gamma.waves, []);
  // A record outside the allowlisted shape is skipped and marks the totals that include it partial.
  assert.deepEqual(slices.demo.slice, totals({ runs: 1, wall: 10, elapsed: 10, summed: 10, tokens: [7, 0, 0, 1], tools: 1 }, "partial"));

  const initiative = totals({ runs: 4, wall: 1010, elapsed: 160, summed: 220, tokens: [138, 0, 5, 19], tools: 11 }, "partial");
  assert.deepEqual(slices.demo.withDescendants, initiative);
  assert.deepEqual(runTotals.initiative, initiative);
});

// One Claude Code session that names alpha-one through a review update, runs one more tool, and ends.
async function endedSession(root, dataDirectory, sessionId) {
  const transcript = path.join(dataDirectory, `${sessionId}.jsonl`);
  await writeFile(transcript, "");
  const startedMs = Date.now() - 10 * MINUTE;
  const hook = (hookEvent, minutes, fields = {}) => recordSessionTrace({
    input: Readable.from([JSON.stringify({
      session_id: sessionId,
      cwd: root,
      transcript_path: transcript,
      hook_event_name: hookEvent,
      timestamp: new Date(startedMs + minutes * MINUTE).toISOString(),
      ...fields
    })]),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: root }
  });
  const review = { projectRoot: root, initiative: "demo", slice: "alpha-one", expectedRevision: null, actor: { id: "coordinator-1", role: "coordinator" }, operations: [] };
  await hook("SessionStart", 0);
  for (const [id, tool, input, at] of [["call-review", `${PRISM}update_review`, review, 0.5], ["call-shell", "Bash", { command: "true" }, 1]]) {
    await hook("PreToolUse", at, { tool_name: tool, tool_use_id: id, tool_input: input });
    await hook("PostToolUse", at + 0.02, { tool_name: tool, tool_use_id: id, tool_input: input, tool_response: "done" });
  }
  await hook("SessionEnd", 2);
}

test("a session consumption read reports the session's recorded totals, excluding other sessions' records of the same slice", async (context) => {
  const root = await seededProject(context);
  const dataDirectory = await scratch(context, "prism-run-totals-data-");
  const sessionId = "run-totals-session";
  await endedSession(root, dataDirectory, sessionId);

  // Precondition from the run-records slice: the ended session appended its own record beside the two seeded runs.
  const entries = await listRecordEntries(root, { kind: "runs", initiative: "demo", slice: "alpha-one" });
  const own = entries.filter((item) => item.id !== RUN.a && item.id !== RUN.b);
  assert.equal(own.length, 1, "the ended session's run is recorded for alpha-one");
  const ownSum = (name) => own[0].entry.segments.reduce((sum, part) => sum + part[name].value, 0);

  const mcp = mcpClient(context, root, { PLUGIN_DATA: dataDirectory });
  await mcp.start();
  const result = await mcp.call("summarize_session_consumption", {
    projectRoot: root,
    correlationKey: hashSessionTraceValue(sessionId, "sessionId"),
    dataDirectory
  });
  const { runMeasures } = result.structuredContent;
  assert.equal(runMeasures.collection, "on");
  assert.deepEqual(runMeasures.inProgress.targets, [], "an ended and recorded run is not in progress");
  assert.ok(runMeasures.recorded, "the session read reports recorded totals");
  assert.deepEqual(runMeasures.recorded.runs, known(1, "exact"), "only the session's own run counts");
  assert.deepEqual(runMeasures.recorded.toolCalls, known(ownSum("toolCalls"), "exact"));
  assert.deepEqual(runMeasures.recorded.summedActiveTimeMs, known(ownSum("activeTimeMs"), "exact"));
  assert.deepEqual(runMeasures.recorded.elapsedActiveTimeMs, known(ownSum("activeTimeMs"), "exact"));
  assert.equal(runMeasures.recorded.wallTimeMs.value, Date.parse(own[0].entry.endedAt) - Date.parse(own[0].entry.startedAt), "wall time is the run's span");
  assert.match(result.content[0].text, /Recorded run totals: /);
});

// A skipped entry of the slice key may hold segments of any wave, so a wave total must not stay exact beside it.
function waveRecord(runId, schemaVersion) {
  const exact = (value) => ({ value, coverage: "exact" });
  return {
    schemaVersion,
    runId,
    host: "claude-code",
    initiative: "demo",
    slice: "alpha",
    startedAt: new Date(BASE).toISOString(),
    endedAt: new Date(BASE + 60000).toISOString(),
    idleThresholdMs: 300000,
    segments: [{
      kind: "wave",
      wave: "design-1",
      role: "coordinator",
      attribution: "exact",
      wallTimeMs: exact(60000),
      activeTimeMs: exact(60000),
      inputTokens: exact(10),
      cacheWriteTokens: exact(0),
      cacheReadTokens: exact(0),
      outputTokens: exact(1),
      toolCalls: exact(1),
      activeIntervals: exact([[BASE, BASE + 60000]])
    }]
  };
}

test("a wave total is not exact when an entry of its slice key was skipped as invalid", async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "prism-run-totals-probe-")));
  defer(context, () => rm(root, { recursive: true, force: true }));
  const key = { kind: "runs", initiative: "demo", slice: "alpha" };
  await appendRecord(root, key, "a".repeat(64), waveRecord("a".repeat(64), 1));
  // A record from a newer schema, which this reader skips, served the same wave.
  await appendRecord(root, key, "b".repeat(64), waveRecord("b".repeat(64), 2));

  const totals = await readSliceRunTotals(root, { initiative: "demo", slice: "alpha" });
  assert.equal(totals.slice.inputTokens.coverage, "partial", "the slice total already reflects the skipped entry");
  const wave = totals.waves.find((item) => item.wave === "design-1");
  assert.notEqual(wave.totals.inputTokens.coverage, "exact", "the wave total must not claim exact coverage");
});
