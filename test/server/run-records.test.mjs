import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";
import { summarizeSessionConsumption } from "../../dist/server/session/session-trace-store.mjs";
import { conservationStore } from "../../dist/server/conservation/conservation-store.mjs";
import { recordFinishedRuns } from "../../dist/server/session/run-records.mjs";
import { removeInitiativeRecords } from "../../dist/server/workflow/record-store.mjs";

// Requirements: docs/requirements/run-statistics.md §2, §10, §12, §13, §15, §16, §18.
// Feature: docs/Features/F-run-records.feature.
// ADRs: docs/ADRs/workflow-records/shared-run-records.md, docs/ADRs/workflow-records/per-call-run-attribution.md.
// Records are read from the user-decided local layout, so this test does not depend on the record store module.

const agentId = "c0ffee1234";
const PRISM = "mcp__plugin_prism_prism-review__";
const MINUTE = 60 * 1000;
const RECORD_KEYS = ["schemaVersion", "runId", "host", "initiative", "slice", "startedAt", "endedAt", "idleThresholdMs", "segments"].sort();
const MEASURE_KEYS = ["wallTimeMs", "activeTimeMs", "inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens", "toolCalls"];
const SEGMENT_KEYS = ["kind", "role", "attribution", ...MEASURE_KEYS, "activeIntervals"];
const COVERAGE = new Set(["exact", "approximate", "partial", "unavailable"]);
// The store's event order within one timestamp.
const TRACE_ORDER = new Map([["run_start", -1], ["session_start", 0], ["subagent_start", 1], ["model_switch", 1], ["coverage_gap", 2],
  ["search", 3], ["source_read", 3], ["test", 3], ["compaction", 3], ["tool_start", 3], ["usage", 3], ["tool_end", 4],
  ["prism_call", 4], ["edit_attempt", 4], ["edit", 5], ["first_edit", 6], ["subagent_stop", 7], ["session_end", 7], ["run_end", 8]]);

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

// Times are minutes relative to a base, so a test can place a session in the past or keep it running now.
function clock(baseMs) {
  return (minutes) => new Date(baseMs + minutes * MINUTE).toISOString();
}

async function writeConfig(project, collection) {
  await mkdir(path.join(project, ".prism"), { recursive: true });
  await writeFile(path.join(project, ".prism", "workflow.md"), `# Workflow config\n\n## Run statistics\n- Collection: ${collection}\n`);
}

// Initiative "demo": slice alpha is in design with wave design-2 open; slice beta is in implementation.
async function writePlans(project) {
  const initiative = path.join(project, ".prism", "initiatives", "demo");
  await mkdir(path.join(initiative, "slices", "alpha"), { recursive: true });
  await mkdir(path.join(initiative, "slices", "beta"), { recursive: true });
  await writeFile(path.join(initiative, "state.json"), JSON.stringify({
    schemaVersion: 1,
    settings: {},
    active: [
      { slice: "alpha", activity: "design", label: "private label", workers: ["private-worker"] },
      { slice: "beta", activity: "implementation", label: "private label", workers: ["private-worker"] }
    ],
    pending: [],
    next: [],
    evidence: []
  }));
  await writeFile(path.join(initiative, "slices", "alpha", "review.json"), JSON.stringify({
    schemaVersion: 1,
    waves: [
      { id: "design-1", mode: "design-audit", lanes: [], accepted: { evidenceDigest: "0".repeat(64), actor: "orchestrator", at: "2026-10-01T09:00:00.000Z" } },
      { id: "design-2", mode: "design-audit", lanes: [] }
    ],
    findings: []
  }));
}

async function project(context, prefix = "prism-run-records-project-") {
  const root = await temporaryDirectory(context, prefix);
  await writePlans(root);
  return root;
}

// One Claude Code session in `root`, with its own transcripts, writing into a shared plugin data directory.
async function claudeSession(context, { root, dataDirectory, sessionId, baseMs }) {
  const transcripts = await temporaryDirectory(context, "prism-run-records-transcripts-");
  const rootTranscript = path.join(transcripts, `${sessionId}.jsonl`);
  const subagentTranscript = path.join(transcripts, sessionId, "subagents", `agent-${agentId}.jsonl`);
  await mkdir(path.dirname(subagentTranscript), { recursive: true });
  await writeFile(rootTranscript, "");
  await writeFile(subagentTranscript, "");
  const time = clock(baseMs);
  const hook = (input) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: root, transcript_path: rootTranscript, ...input, timestamp: time(input.at) })]),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: root }
  });
  const message = (file, { id, at, usage, agent = null }) => appendFile(file, line({
    type: "assistant",
    sessionId,
    isSidechain: agent !== null,
    ...(agent ? { agentId: agent } : {}),
    timestamp: time(at),
    message: {
      id,
      model: "claude-test",
      content: [{ type: "text", text: "private model response" }],
      usage: { input_tokens: usage[0], cache_creation_input_tokens: usage[1], cache_read_input_tokens: usage[2], output_tokens: usage[3] }
    }
  }));
  const call = async ({ tool, id, input = {}, at, agent = null }) => {
    const common = { tool_name: tool, tool_use_id: id, tool_input: input, ...(agent ? { agent_id: agent } : {}) };
    await hook({ hook_event_name: "PreToolUse", ...common, at });
    return hook({ hook_event_name: "PostToolUse", ...common, tool_response: "private result", at: at + 1 / 60 });
  };
  const summary = () => summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: root });
  return { sessionId, rootTranscript, subagentTranscript, hook, message, call, summary };
}

const updateAlphaReview = (root) => ({
  tool: `${PRISM}update_review`,
  input: { projectRoot: root, initiative: "demo", slice: "alpha", expectedRevision: null, actor: { id: "private-actor", role: "coordinator" }, operations: [] }
});

// A root session that reviews alpha and starts a subagent, which inherits alpha's wave and then names beta.
async function reviewAndDelegate(session, root) {
  await session.hook({ hook_event_name: "SessionStart", at: 0 });
  await session.message(session.rootTranscript, { id: "msg_r1", at: 0.1, usage: [1, 0, 0, 1] });
  await session.call({ ...updateAlphaReview(root), id: "call-review", at: 0.5 });
  await session.message(session.rootTranscript, { id: "msg_r2", at: 0.7, usage: [2, 0, 0, 2] });
  await session.hook({ hook_event_name: "SubagentStart", agent_id: agentId, agent_type: "general-purpose", at: 1 });
  await session.message(session.subagentTranscript, { id: "msg_s1", at: 1.1, usage: [10, 0, 0, 10], agent: agentId });
  await session.call({ tool: "Read", id: "call-read", input: { file_path: path.join(root, "README.md") }, at: 1.2, agent: agentId });
  await session.call({
    tool: `${PRISM}get_change_map`,
    id: "call-change-map",
    input: { projectRoot: root, initiative: "demo", slice: "beta" },
    at: 1.5,
    agent: agentId
  });
  await session.message(session.subagentTranscript, { id: "msg_s2", at: 1.7, usage: [20, 0, 0, 20], agent: agentId });
  await session.hook({ hook_event_name: "SubagentStop", agent_id: agentId, agent_transcript_path: session.subagentTranscript, at: 2 });
  await session.message(session.rootTranscript, { id: "msg_r3", at: 2.5, usage: [4, 0, 0, 4] });
  await session.call({ tool: "Bash", id: "call-bash", input: { command: "private command" }, at: 3 });
}

function runsFolder(root, slice) {
  return path.join(root, ".prism", "initiatives", "demo", "slices", slice, "runs");
}

// Lists the record files of one slice as [{ id, entry, text }] in id order, or [] when none exist.
async function records(root, slice) {
  let names = [];
  try {
    names = (await readdir(runsFolder(root, slice))).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return Promise.all(names.map(async (name) => {
    const text = await readFile(path.join(runsFolder(root, slice), name), "utf8");
    return { id: name.slice(0, -".json".length), entry: JSON.parse(text), text };
  }));
}

// A record holds only allowlisted counts, durations, timestamps, coverage marks, host, role, run and target identifiers.
function assertContentFree(record, { root, sessionId, transcripts }) {
  const { id, entry, text } = record;
  assert.deepEqual(Object.keys(entry).sort(), RECORD_KEYS);
  assert.match(entry.runId, /^[a-f0-9]{64}$/);
  assert.equal(entry.runId, id);
  assert.ok(["claude-code", "codex"].includes(entry.host));
  assert.ok(entry.segments.length > 0);
  for (const segment of entry.segments) {
    const targetKey = segment.kind === "wave" ? ["wave"] : segment.kind === "design-run" ? ["designRun"] : [];
    assert.deepEqual(Object.keys(segment).sort(), [...SEGMENT_KEYS, ...targetKey].sort());
    assert.ok(["coordinator", "delivery", "reviewer"].includes(segment.role));
    assert.ok(COVERAGE.has(segment.attribution));
    for (const key of [...MEASURE_KEYS, "activeIntervals"]) {
      assert.deepEqual(Object.keys(segment[key]).sort(), ["coverage", "value"]);
      assert.ok(COVERAGE.has(segment[key].coverage));
    }
  }
  for (const forbidden of [root, sessionId, ...transcripts, "private", "msg_"]) {
    assert.equal(text.includes(forbidden), false, `the record must not contain ${forbidden}`);
  }
}

// Pending markers and their claims anywhere in the plugin data directory, as absolute paths.
async function pendingFiles(dataDirectory) {
  const names = await readdir(dataDirectory, { recursive: true });
  return names.filter((name) => /\.pending(\.claim)?$/.test(name)).map((name) => path.join(dataDirectory, name)).sort();
}

function segment(record, { kind, role }) {
  const matches = record.entry.segments.filter((candidate) => candidate.kind === kind && candidate.role === role);
  assert.equal(matches.length, 1, `one ${kind} segment as ${role}`);
  return matches[0];
}

test("appends one content-free record per attributed slice when a Claude subagent stops and when its session ends", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  const session = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-session", baseMs: Date.now() - 10 * MINUTE });
  await reviewAndDelegate(session, root);

  // The subagent's run ended at its stop: it inherited alpha's open wave and then named beta.
  const afterStop = await records(root, "alpha");
  const betaRecords = await records(root, "beta");
  assert.equal(afterStop.length, 1, "the stopped subagent's run is recorded for alpha");
  assert.equal(betaRecords.length, 1, "the stopped subagent's run is recorded for beta");
  assert.equal(betaRecords[0].id, afterStop[0].id, "one run appends the same run id under every slice it served");
  const inherited = segment(afterStop[0], { kind: "wave", role: "coordinator" });
  assert.equal(inherited.wave, "design-2");
  assert.equal(inherited.inputTokens.value, 10);

  const ended = await session.hook({ hook_event_name: "SessionEnd", at: 4 });
  assert.equal(ended.status, "processed");
  const alphaRecords = await records(root, "alpha");
  assert.equal(alphaRecords.length, 2, "the root run adds its own record for alpha");
  const rootRecord = alphaRecords.find((record) => record.id !== afterStop[0].id);
  const wave = segment(rootRecord, { kind: "wave", role: "coordinator" });
  assert.equal(wave.wave, "design-2");
  assert.equal(wave.attribution, "exact");
  assert.deepEqual(wave.toolCalls, { value: 2, coverage: "exact" });
  assert.equal(rootRecord.entry.host, "claude-code");
  assert.equal(rootRecord.entry.initiative, "demo");
  assert.equal(rootRecord.entry.slice, "alpha");
  for (const record of [...alphaRecords, ...betaRecords]) {
    assertContentFree(record, { root, sessionId: session.sessionId, transcripts: [session.rootTranscript, session.subagentTranscript] });
  }
  // Unattributed cost before the first Prism call stays local and creates no record.
  assert.deepEqual((await readdir(path.join(root, ".prism", "initiatives", "demo", "slices"))).sort(), ["alpha", "beta"]);
});

test("leaves every existing run record unchanged when finalization repeats", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  const session = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-repeat", baseMs: Date.now() - 10 * MINUTE });
  await reviewAndDelegate(session, root);
  await session.hook({ hook_event_name: "SessionEnd", at: 4 });
  const before = [...await records(root, "alpha"), ...await records(root, "beta")];
  assert.equal(before.length, 3);

  // The end hook repeats and the session consumption read finalizes again; both append the same keys.
  assert.equal((await session.hook({ hook_event_name: "SessionEnd", at: 4 })).status, "processed");
  await session.summary();
  const after = [...await records(root, "alpha"), ...await records(root, "beta")];
  assert.deepEqual(after.map((record) => [record.id, record.text]), before.map((record) => [record.id, record.text]));
});

test("records a quiet session's run at another session's next Prism hook and reports the calling session's own run as in progress", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  // A session that stopped two hours ago without an observed end.
  const crashed = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-crashed", baseMs: Date.now() - 120 * MINUTE });
  await crashed.hook({ hook_event_name: "SessionStart", at: 0 });
  await crashed.call({ ...updateAlphaReview(root), id: "call-crashed-review", at: 0.5 });
  await crashed.message(crashed.rootTranscript, { id: "msg_c1", at: 0.7, usage: [3, 0, 0, 3] });
  await crashed.call({ tool: "Bash", id: "call-crashed-bash", input: { command: "private command" }, at: 1 });
  assert.deepEqual(await records(root, "alpha"), [], "a run without an observed end is not recorded while its session could still be running");

  // A running session in the same project makes its first Prism-hooked call now.
  const running = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-running", baseMs: Date.now() - 2 * MINUTE });
  await running.hook({ hook_event_name: "SessionStart", at: 0 });
  await running.call({ ...updateAlphaReview(root), id: "call-running-review", at: 0.5 });

  const recovered = await records(root, "alpha");
  assert.equal(recovered.length, 1, "the quiet session's run is recorded at the next Prism hook in the project");
  assert.deepEqual(segment(recovered[0], { kind: "wave", role: "coordinator" }).toolCalls, { value: 2, coverage: "exact" });

  // The calling session's own run has no end, so its observed counts are in progress and are not recorded.
  const summary = await running.summary();
  assert.equal(summary.runMeasures.collection, "on");
  const inProgress = summary.runMeasures.inProgress.targets.filter((entry) => entry.target.slice === "alpha" && entry.target.kind === "wave");
  assert.equal(inProgress.length, 1);
  assert.deepEqual(inProgress[0].toolCalls, { value: 1, coverage: "exact" });
  assert.equal((await records(root, "alpha")).length, 1, "the read records nothing for the calling session's open run");
});

test("reports an open subagent run's cost before its first Prism call in progress under the root's target after every root run is recorded", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  const session = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-open-subagent", baseMs: Date.now() - 10 * MINUTE });
  await session.hook({ hook_event_name: "SessionStart", at: 0 });
  await session.call({ ...updateAlphaReview(root), id: "call-review", at: 0.5 });
  await session.hook({ hook_event_name: "SubagentStart", agent_id: agentId, agent_type: "general-purpose", at: 1 });
  await session.message(session.subagentTranscript, { id: "msg_s1", at: 1.1, usage: [10, 0, 0, 10], agent: agentId });
  await session.call({ tool: "Read", id: "call-read", input: { file_path: path.join(root, "README.md") }, at: 1.2, agent: agentId });
  // The root's only run ends with its session and is recorded, while the subagent's run has no stop and stays open.
  await session.hook({ hook_event_name: "SessionEnd", at: 2 });
  assert.equal((await records(root, "alpha")).length, 1, "the root's run is recorded");

  // The finalizer gives the subagent's run the root's full events as context, so its cost before its own first Prism call
  // inherits alpha's wave as coordinator; the in-progress report replays the open run with the same context.
  const summary = await session.summary();
  const inProgress = summary.runMeasures.inProgress.targets.filter((entry) => entry.target.slice === "alpha" && entry.target.kind === "wave");
  assert.equal(inProgress.length, 1, "the open subagent run is in progress for alpha's wave");
  assert.equal(inProgress[0].target.wave, "design-2");
  assert.equal(inProgress[0].role, "coordinator");
  assert.equal(inProgress[0].toolCalls.value, 1);
  assert.equal(inProgress[0].inputTokens.value, 10);
  assert.deepEqual(summary.runMeasures.inProgress.unattributed.toolCalls, { value: 0, coverage: "exact" }, "none of the open run's tool calls is unattributed");
  assert.equal((await records(root, "alpha")).length, 1, "the read records nothing for the open subagent run");
});

// Promoted from the run-records impl-3 review probe for docs/requirements/run-statistics.md §9 and §12.
// An open subagent run whose observed cost all inherits the root's target has an observed unattributed cost of exactly zero,
// which must be reported as 0 rather than as an unobserved (unavailable) measure, as the session attribution reports it.
async function writeInProgressUnattributedPlans(project) {
  const initiative = path.join(project, ".prism", "initiatives", "demo");
  await mkdir(path.join(initiative, "slices", "alpha"), { recursive: true });
  await writeFile(path.join(initiative, "slices", "alpha", "review.json"), JSON.stringify({ schemaVersion: 1, waves: [], findings: [] }));
  await writeFile(path.join(initiative, "state.json"), JSON.stringify({
    schemaVersion: 1, settings: {}, active: [{ slice: "alpha", activity: "implementation", label: "l", workers: [] }], pending: [], next: [], evidence: []
  }));
}

test("probe: an open subagent run whose cost is all attributed reports its unattributed cost as exactly zero", async (context) => {
  const sessionId = "probe-in-progress-unattributed";
  const project = await temporaryDirectory(context, "prism-probe-project-");
  const dataDirectory = await temporaryDirectory(context, "prism-probe-data-");
  await writeInProgressUnattributedPlans(project);
  const transcripts = await temporaryDirectory(context, "prism-probe-transcripts-");
  const transcript = path.join(transcripts, `${sessionId}.jsonl`);
  const subagentTranscript = path.join(transcripts, sessionId, "subagents", `agent-${agentId}.jsonl`);
  await mkdir(path.dirname(subagentTranscript), { recursive: true });
  await writeFile(transcript, "");
  await writeFile(subagentTranscript, "");
  const baseMs = Date.now() - 10 * MINUTE;
  const time = (at) => new Date(baseMs + at * MINUTE).toISOString();
  const hook = (input) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcript, ...input, timestamp: time(input.at) })]),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: project }
  });
  const call = async (tool, id, input, at, agent = null) => {
    const common = { tool_name: tool, tool_use_id: id, tool_input: input, ...(agent ? { agent_id: agent } : {}) };
    await hook({ hook_event_name: "PreToolUse", ...common, at });
    await hook({ hook_event_name: "PostToolUse", ...common, tool_response: "r", at: at + 1 / 60 });
  };

  await hook({ hook_event_name: "SessionStart", at: 0 });
  await call(`${PRISM}update_review`, "call-alpha", { projectRoot: project, initiative: "demo", slice: "alpha", actor: { id: "a", role: "delivery" } }, 0.5);
  await hook({ hook_event_name: "SubagentStart", agent_id: agentId, agent_type: "general-purpose", at: 1 });
  await appendFile(subagentTranscript, `${JSON.stringify({
    type: "assistant", sessionId, isSidechain: true, agentId, timestamp: time(1.1),
    message: { id: "m1", model: "claude-test", content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 } }
  })}\n`);
  await call("Read", "call-read", { file_path: path.join(project, "README.md") }, 1.2, agentId);
  // The root's run ends with its session and is recorded; the subagent's run has no stop and stays in progress.
  await hook({ hook_event_name: "SessionEnd", at: 2 });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  const inProgress = summary.runMeasures.inProgress;
  assert.equal(inProgress.targets.find((entry) => entry.target.slice === "alpha")?.toolCalls.value, 1, "the open subagent run is in progress for alpha");
  assert.deepEqual(inProgress.unattributed.toolCalls, { value: 0, coverage: "exact" }, "the observed open run leaves no tool call unattributed");
});

test("records a quiet session whose pending marker an interrupted finalizer left claimed", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  const quiet = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-claimed", baseMs: Date.now() - 120 * MINUTE });
  await quiet.hook({ hook_event_name: "SessionStart", at: 0 });
  await quiet.call({ ...updateAlphaReview(root), id: "call-claimed-review", at: 0.5 });
  await quiet.call({ tool: "Bash", id: "call-claimed-bash", input: { command: "private command" }, at: 1 });
  assert.deepEqual(await records(root, "alpha"), []);

  // A finalizer killed after claiming the marker, while a run was still unrecorded, leaves only the claim.
  const markers = await pendingFiles(dataDirectory);
  assert.equal(markers.length, 1, "the quiet session is marked pending");
  await rename(markers[0], `${markers[0]}.claim`);

  const sweeper = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-sweeper", baseMs: Date.now() - 2 * MINUTE });
  await sweeper.hook({ hook_event_name: "SessionStart", at: 0 });
  await sweeper.call({ ...updateAlphaReview(root), id: "call-sweeper-review", at: 0.5 });

  assert.equal((await records(root, "alpha")).length, 1, "the next sweep records the claimed session's run");
  const remaining = await pendingFiles(dataDirectory);
  assert.deepEqual(remaining.filter((file) => file.endsWith(".claim")), [], "no claim remains once the run is recorded");
  assert.equal(remaining.length, 1, "only the running session's own open run stays pending");
});

// A session that reviewed alpha two hours ago and went quiet without an observed end.
async function quietAlphaSession(context, { root, dataDirectory, sessionId }) {
  const quiet = await claudeSession(context, { root, dataDirectory, sessionId, baseMs: Date.now() - 120 * MINUTE });
  await quiet.hook({ hook_event_name: "SessionStart", at: 0 });
  await quiet.call({ ...updateAlphaReview(root), id: `call-${sessionId}-review`, at: 0.5 });
  await quiet.call({ tool: "Bash", id: `call-${sessionId}-bash`, input: { command: "private command" }, at: 1 });
  return quiet;
}

// The path of the one run-statistics trace (the trace holding run_start events) in the data directory.
async function runTracePath(dataDirectory) {
  const traces = path.join(dataDirectory, "session-traces");
  for (const name of (await readdir(traces)).filter((file) => file.endsWith(".json"))) {
    const state = JSON.parse(await readFile(path.join(traces, name), "utf8"));
    if (state.events.some((event) => event.eventType === "run_start")) return path.join(traces, name);
  }
  assert.fail("a run-statistics trace exists");
}

// Fills the run-statistics trace to its 4096-event limit, so it can hold no run_end seal.
async function fillRunTrace(dataDirectory) {
  const file = await runTracePath(dataDirectory);
  const state = JSON.parse(await readFile(file, "utf8"));
  const filler = state.events.findLast((event) => event.eventType === "tool_end");
  const events = [...state.events];
  for (let index = 0; events.length < 4096; index += 1) {
    events.push({ ...structuredClone(filler), eventIdDigest: createHash("sha256").update(`filler-${index}`).digest("hex") });
  }
  events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
    || (TRACE_ORDER.get(left.eventType) ?? Infinity) - (TRACE_ORDER.get(right.eventType) ?? Infinity)
    || left.eventIdDigest.localeCompare(right.eventIdDigest));
  await writeFile(file, `${JSON.stringify({ ...state, events })}\n`);
}

test("records a quiet session's run once from a trace at its event limit and stops listing the session as pending", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  await quietAlphaSession(context, { root, dataDirectory, sessionId: "run-records-full" });
  await fillRunTrace(dataDirectory);

  const sweeper = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-full-sweeper", baseMs: Date.now() - 2 * MINUTE });
  await sweeper.hook({ hook_event_name: "SessionStart", at: 0 });
  await sweeper.call({ ...updateAlphaReview(root), id: "call-full-sweeper-review", at: 0.5 });
  const recorded = await records(root, "alpha");
  assert.equal(recorded.length, 1, "the run sealed by its trace limit is recorded");
  assert.equal(segment(recorded[0], { kind: "wave", role: "coordinator" }).toolCalls.coverage, "partial", "a full trace keeps a partial ceiling");
  assert.equal((await pendingFiles(dataDirectory)).length, 1, "only the running session's own open run stays pending");

  // A later sweep neither re-records the run nor finds the quiet session pending again.
  await sweeper.call({ ...updateAlphaReview(root), id: "call-full-sweeper-again", at: 1 });
  assert.deepEqual((await records(root, "alpha")).map((record) => record.text), recorded.map((record) => record.text));
  assert.equal((await pendingFiles(dataDirectory)).length, 1);
});

test("refuses a late event once a trace reached its own limit, so nothing lands inside the run that limit sealed", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  const quiet = await quietAlphaSession(context, { root, dataDirectory, sessionId: "run-records-late" });
  await fillRunTrace(dataDirectory);
  const sweeper = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-late-sweeper", baseMs: Date.now() - 2 * MINUTE });
  await sweeper.hook({ hook_event_name: "SessionStart", at: 0 });
  await sweeper.call({ ...updateAlphaReview(root), id: "call-late-sweeper-review", at: 0.5 });
  const recorded = await records(root, "alpha");
  assert.equal(recorded.length, 1, "the run sealed by its trace limit is recorded");

  // Even with room for a small event, as after a refusal at the byte limit, the full trace keeps refusing.
  const file = await runTracePath(dataDirectory);
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(state.limitReached, true);
  const fillerAt = state.events.findLast((event) => event.eventType === "tool_end").occurredAt;
  const trimmed = { ...state, events: state.events.filter((event) => !(event.eventType === "tool_end" && event.occurredAt === fillerAt)) };
  assert.ok(trimmed.events.length < 16);
  await writeFile(file, `${JSON.stringify(trimmed)}\n`);
  const before = await readFile(file, "utf8");
  await quiet.hook({
    hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-late-bash", tool_input: { command: "private command" },
    tool_response: "private result", at: 0.9
  });
  assert.equal(await readFile(file, "utf8"), before, "the late event inside the recorded run is refused");
  assert.deepEqual((await records(root, "alpha")).map((record) => record.text), recorded.map((record) => record.text));
});

test("a byte-limited root pre-edit trace still accepts a later small edit while a limit-sealed run-statistics trace refuses it", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  const session = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-root-limit", baseMs: Date.now() - 10 * MINUTE });
  await session.hook({ hook_event_name: "SessionStart", at: 0 });
  await session.call({ tool: "Bash", id: "call-root-limit-bash", input: { command: "private command" }, at: 0.5 });

  // Both traces carry their own limit flag with room for a small event, as after a refusal at the byte limit.
  const traces = path.join(dataDirectory, "session-traces");
  const runFile = await runTracePath(dataDirectory);
  let rootFile = null;
  for (const name of (await readdir(traces)).filter((file) => file.endsWith(".json"))) {
    const state = JSON.parse(await readFile(path.join(traces, name), "utf8"));
    if (state.events.some((event) => event.eventType === "session_start") && state.events.every((event) => !Object.hasOwn(event.hashes, "execution"))) {
      rootFile = path.join(traces, name);
    }
  }
  assert.ok(rootFile, "a root pre-edit trace exists");
  for (const file of [rootFile, runFile]) {
    const state = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, `${JSON.stringify({ ...state, limitReached: true })}\n`);
  }
  const runBefore = await readFile(runFile, "utf8");

  await session.call({ tool: "Edit", id: "call-root-limit-edit", input: { file_path: path.join(root, "change.mjs") }, at: 1 });

  const rootState = JSON.parse(await readFile(rootFile, "utf8"));
  assert.equal(rootState.limitReached, true);
  assert.deepEqual(rootState.events.filter((event) => ["edit", "first_edit"].includes(event.eventType)).map((event) => event.eventType),
    ["edit", "first_edit"], "the root pre-edit trace accepts the edit and derives first_edit");
  assert.notEqual((await session.summary()).preEdit.firstEditAt, null);
  assert.equal(await readFile(runFile, "utf8"), runBefore, "the limit-sealed run-statistics trace refuses the later event");
});

test("a full shared trace directory leaves a quiet session's run pending without writing a record", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  await quietAlphaSession(context, { root, dataDirectory, sessionId: "run-records-directory-full" });
  const markers = await pendingFiles(dataDirectory);
  assert.equal(markers.length, 1, "the quiet session is marked pending");

  // A fresh temporary file fills the shared 64 MiB directory quota, so the run_end seal is refused without a trace limit.
  const filler = path.join(dataDirectory, "session-traces", `${"b".repeat(64)}.json.123.active.tmp`);
  await writeFile(filler, "");
  await truncate(filler, 64 * 1024 * 1024 + 1);
  await recordFinishedRuns({ dataDirectory, projectRoot: root, sessionDigest: "0".repeat(64), own: false, sweep: true });

  assert.deepEqual(await records(root, "alpha"), [], "no record is written while the seal is refused by the directory limit");
  assert.deepEqual(await pendingFiles(dataDirectory), markers, "the quiet session stays pending");
  assert.equal(JSON.parse(await readFile(await runTracePath(dataDirectory), "utf8")).limitReached, false);
});

test("a run record appended after a source snapshot leaves the snapshot current and git-ignores only locks and temporary files", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  const previousDirectory = conservationStore.directory;
  conservationStore.directory = await temporaryDirectory(context, "prism-run-records-evidence-");
  context.after(() => { conservationStore.directory = previousDirectory; });
  const session = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-snapshot", baseMs: Date.now() - 10 * MINUTE });
  await session.hook({ hook_event_name: "SessionStart", at: 0 });
  await session.call({ ...updateAlphaReview(root), id: "call-snapshot-review", at: 0.5 });
  const snapshot = await conservationStore.capture(root);

  // A worker stop appends a record into the project while its review's snapshot is open.
  assert.equal((await session.hook({ hook_event_name: "SessionEnd", at: 1 })).status, "processed");
  const appended = await records(root, "alpha");
  assert.equal(appended.length, 1, "the ended run is recorded after the snapshot");
  // A writer killed mid-append leaves its entry lock and temporary file behind.
  await writeFile(path.join(runsFolder(root, "alpha"), `${appended[0].id}.json.lock`), "{}");
  await writeFile(path.join(runsFolder(root, "alpha"), `.${appended[0].id}.json.1.0123abcd.tmp`), "{}");

  await conservationStore.assertCurrent(root, snapshot.snapshotId);
  assert.equal(await readFile(path.join(root, ".prism", ".gitignore"), "utf8"), "# Transient lock and write files of Prism records, and the store's sync state.\n*.lock\n.*.tmp\n/.prism-sync/\n");
});

test("records a quiet Codex session's run with attribution below the session marked partial", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-codex-data-");
  const sessionId = "run-records-codex";
  const time = clock(Date.now() - 120 * MINUTE);
  const rollout = path.join(root, "rollout-root.jsonl");
  await writeFile(rollout, [
    line({ type: "session_meta", payload: { id: sessionId, session_id: sessionId, cli_version: "0.147.0", model_provider: "openai", cwd: root, source: "vscode" } }),
    line({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 }, model_context_window: 200000 } } })
  ].join(""));
  const codexHook = (input) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: root, transcript_path: rollout, turn_id: "turn-1", ...input, timestamp: time(input.at) })]),
    environment: { PLUGIN_DATA: dataDirectory }
  });
  // Codex names the Prism server prism_review, with an underscore.
  const review = { tool_name: "mcp__prism_review__update_review", tool_use_id: "codex-review", tool_input: updateAlphaReview(root).input };
  await codexHook({ hook_event_name: "SessionStart", at: 0 });
  await codexHook({ hook_event_name: "PreToolUse", ...review, at: 0.5 });
  await codexHook({ hook_event_name: "PostToolUse", ...review, tool_response: "private result", at: 0.6 });
  assert.deepEqual(await records(root, "alpha"), [], "Codex observes no end, so its run waits for the quiet period");

  const later = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-after-codex", baseMs: Date.now() - MINUTE });
  await later.hook({ hook_event_name: "SessionStart", at: 0 });

  const recovered = await records(root, "alpha");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].entry.host, "codex");
  const wave = segment(recovered[0], { kind: "wave", role: "coordinator" });
  assert.equal(wave.attribution, "partial");
  assert.deepEqual(wave.cacheWriteTokens, { value: null, coverage: "unavailable" });
  assertContentFree(recovered[0], { root, sessionId, transcripts: [rollout] });
});

test("appends a call's record to the project whose records the call read", async (context) => {
  const hookProject = await temporaryDirectory(context, "prism-run-records-hook-project-");
  const workTree = await project(context, "prism-run-records-work-tree-");
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  const session = await claudeSession(context, { root: hookProject, dataDirectory, sessionId: "run-records-cross-project", baseMs: Date.now() - 10 * MINUTE });
  await session.hook({ hook_event_name: "SessionStart", at: 0 });
  await session.call({ ...updateAlphaReview(workTree), id: "call-work-tree-review", at: 0.5 });
  await session.hook({ hook_event_name: "SessionEnd", at: 1 });

  const recorded = await records(workTree, "alpha");
  assert.equal(recorded.length, 1);
  assertContentFree(recorded[0], { root: workTree, sessionId: session.sessionId, transcripts: [session.rootTranscript] });
  assert.equal(recorded[0].text.includes(hookProject), false);
  await assert.rejects(readdir(path.join(hookProject, ".prism", "initiatives")), { code: "ENOENT" });
});

test("keeps run records readable after the initiative plans folder and coordination records are removed", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  const session = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-cleanup", baseMs: Date.now() - 10 * MINUTE });
  await reviewAndDelegate(session, root);
  await session.hook({ hook_event_name: "SessionEnd", at: 4 });
  const before = [...await records(root, "alpha"), ...await records(root, "beta")];
  assert.equal(before.length, 3);

  // Coordination cleanup of a shipped initiative removes its plans folder and its coordination records, but not run entries.
  await rm(path.join(root, "docs", "plans", "demo"), { recursive: true, force: true });
  await removeInitiativeRecords(root, "demo");
  const after = [...await records(root, "alpha"), ...await records(root, "beta")];
  assert.deepEqual(after.map((record) => [record.id, record.text]), before.map((record) => [record.id, record.text]));
});

test("writes no run records while collection is off and keeps existing records readable", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  const first = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-before-off", baseMs: Date.now() - 20 * MINUTE });
  await first.hook({ hook_event_name: "SessionStart", at: 0 });
  await first.call({ ...updateAlphaReview(root), id: "call-before-off", at: 0.5 });
  await first.hook({ hook_event_name: "SessionEnd", at: 1 });
  const existing = await records(root, "alpha");
  assert.equal(existing.length, 1);

  await writeConfig(root, "off");
  const second = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-while-off", baseMs: Date.now() - 10 * MINUTE });
  await second.hook({ hook_event_name: "SessionStart", at: 0 });
  await second.call({ ...updateAlphaReview(root), id: "call-while-off", at: 0.5 });
  assert.equal((await second.hook({ hook_event_name: "SessionEnd", at: 1 })).status, "processed");
  await second.summary();

  const after = await records(root, "alpha");
  assert.deepEqual(after.map((record) => [record.id, record.text]), existing.map((record) => [record.id, record.text]));
});

test("a refused record append lets the hook continue, reports the run in progress below exact, and is recorded by a later read", async (context) => {
  const root = await project(context);
  const dataDirectory = await temporaryDirectory(context, "prism-run-records-data-");
  const session = await claudeSession(context, { root, dataDirectory, sessionId: "run-records-refused", baseMs: Date.now() - 10 * MINUTE });
  // A regular file where the runs folder belongs makes every append for alpha fail.
  await mkdir(path.dirname(runsFolder(root, "alpha")), { recursive: true });
  await writeFile(runsFolder(root, "alpha"), "not a folder");

  await session.hook({ hook_event_name: "SessionStart", at: 0 });
  await session.call({ ...updateAlphaReview(root), id: "call-refused-review", at: 0.5 });
  assert.equal((await session.hook({ hook_event_name: "SessionEnd", at: 1 })).status, "processed");

  const pending = await session.summary();
  const inProgress = pending.runMeasures.inProgress.targets.filter((entry) => entry.target.slice === "alpha" && entry.target.kind === "wave");
  assert.equal(inProgress.length, 1, "the ended run whose append failed is still reported");
  assert.deepEqual(inProgress[0].toolCalls, { value: 1, coverage: "partial" });

  await rm(runsFolder(root, "alpha"));
  const settled = await session.summary();
  assert.deepEqual(settled.runMeasures.inProgress.targets, []);
  assert.equal((await records(root, "alpha")).length, 1);
});
