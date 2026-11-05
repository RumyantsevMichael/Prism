import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";
import { appendSessionTraceEvent, summarizeSessionConsumption } from "../../dist/server/session/session-trace-store.mjs";

// Requirements: docs/requirements/run-statistics.md §2, §6, §7, §8, §9, §12, §14, §18.
// Feature: docs/Features/F-call-attribution.feature.
// ADR: docs/ADRs/workflow-records/per-call-run-attribution.md.

const sessionId = "call-attribution-session";
const agentId = "c0ffee1234";
const at = (time) => `2026-10-23T${time}.000Z`;
const PRISM = "mcp__plugin_prism_prism-review__";
const TOKEN_KEYS = ["inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens"];

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

// Usage is [input, cache-write, cache-read, output].
function claudeMessage({ id, time, usage, agent = null }) {
  return line({
    type: "assistant",
    sessionId,
    isSidechain: agent !== null,
    ...(agent ? { agentId: agent } : {}),
    timestamp: at(time),
    message: {
      id,
      model: "claude-test",
      content: [{ type: "text", text: "private model response" }],
      usage: { input_tokens: usage[0], cache_creation_input_tokens: usage[1], cache_read_input_tokens: usage[2], output_tokens: usage[3] }
    }
  });
}

// Initiative "demo": slice alpha is in design with design-1 accepted and design-2 open; slice beta is in implementation.
// An oversized config keeps "Collection: off" near the top and pads past the 256 KiB bound with prose, so its tail alone would read as on.
async function writePlans(project, { alphaLedger = null, collectionOff = false, oversizedConfig = false } = {}) {
  if (collectionOff) {
    await mkdir(path.join(project, ".prism"), { recursive: true });
    const padding = oversizedConfig ? "Padding prose that is not a config entry.\n".repeat(Math.ceil((256 * 1024 + 1) / 42)) : "";
    await writeFile(path.join(project, ".prism", "workflow.md"), `# Workflow config\n\n## Run statistics\n- Collection: off\n\n## Notes\n${padding}`);
  }
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
  await writeFile(path.join(initiative, "slices", "alpha", "review.json"), alphaLedger ?? JSON.stringify({
    schemaVersion: 1,
    waves: [
      { id: "design-1", mode: "design-audit", lanes: [], accepted: { evidenceDigest: "0".repeat(64), actor: "orchestrator", at: at("09:00:00") } },
      { id: "design-2", mode: "design-audit", lanes: [] }
    ],
    findings: []
  }));
}

async function claudeFixture(context, plans = {}) {
  const project = await temporaryDirectory(context, "prism-call-attribution-project-");
  const dataDirectory = await temporaryDirectory(context, "prism-call-attribution-data-");
  const transcripts = await temporaryDirectory(context, "prism-call-attribution-transcripts-");
  await writePlans(project, plans);
  const rootTranscript = path.join(transcripts, `${sessionId}.jsonl`);
  const subagentTranscript = path.join(transcripts, sessionId, "subagents", `agent-${agentId}.jsonl`);
  await mkdir(path.dirname(subagentTranscript), { recursive: true });
  await writeFile(rootTranscript, "");
  await writeFile(subagentTranscript, "");
  const hook = (input, storeEvent = undefined) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: rootTranscript, ...input, timestamp: at(input.timestamp) })]),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: project },
    ...(storeEvent ? { storeEvent } : {})
  });
  // One tool call observed at PreToolUse and PostToolUse, one second apart.
  const call = async ({ tool, id, input = {}, time, end, agent = null, storeEvent = undefined }) => {
    const common = { tool_name: tool, tool_use_id: id, tool_input: input, ...(agent ? { agent_id: agent } : {}) };
    await hook({ hook_event_name: "PreToolUse", ...common, timestamp: time }, storeEvent);
    return hook({ hook_event_name: "PostToolUse", ...common, tool_response: "private result", timestamp: end }, storeEvent);
  };
  const summary = () => summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  return { project, rootTranscript, subagentTranscript, hook, call, summary };
}

function measure(value, coverage = "exact") {
  return { value, coverage };
}

// Setup check: run measures were collected, so a failure below is about attribution alone.
function assertMeasured(summary) {
  assert.equal(summary.runMeasures.collection, "on");
  assert.equal(summary.runMeasures.executions[0]?.execution, "root");
}

function targetEntry(summary, { slice, kind, role }) {
  const matches = summary.runMeasures.attribution.targets.filter((entry) => (
    entry.target.initiative === "demo" && entry.target.slice === slice && entry.target.kind === kind && entry.role === role
  ));
  assert.equal(matches.length, 1, `one ${kind} entry for ${slice} and ${role}`);
  return matches[0];
}

// Attributed and unattributed tokens add up to the executions' totals: nothing is dropped or distributed.
function assertConserved(summary) {
  const { targets, unattributed } = summary.runMeasures.attribution;
  for (const key of [...TOKEN_KEYS, "toolCalls"]) {
    const executions = summary.runMeasures.executions.reduce((sum, row) => sum + (row[key].value ?? 0), 0);
    const attributed = targets.reduce((sum, entry) => sum + (entry[key].value ?? 0), 0) + (unattributed[key].value ?? 0);
    assert.equal(attributed, executions, `${key} is conserved`);
  }
}

test("attributes cost per wave, design run, and slice and per role, with subagent inheritance and an unattributed bucket", async (context) => {
  const fixture = await claudeFixture(context);
  const { hook, call, project } = fixture;

  await hook({ hook_event_name: "SessionStart", timestamp: "10:00:00" });
  await appendFile(fixture.rootTranscript, claudeMessage({ id: "msg_r1", time: "10:00:05", usage: [1, 0, 0, 1] }));
  // Before any Prism call the root's cost has no target.
  await call({ tool: "Bash", id: "call-bash", input: { command: "private command" }, time: "10:00:10", end: "10:00:11" });
  await appendFile(fixture.rootTranscript, claudeMessage({ id: "msg_r2", time: "10:00:20", usage: [2, 0, 0, 2] }));
  // An explicit coordinator role on the slice whose latest wave is open targets that wave.
  await call({
    tool: `${PRISM}update_review`,
    id: "call-update-review",
    input: { projectRoot: project, initiative: "demo", slice: "alpha", expectedRevision: null, actor: { id: "private-actor", role: "coordinator" }, operations: [] },
    time: "10:00:30",
    end: "10:00:31"
  });
  await appendFile(fixture.rootTranscript, claudeMessage({ id: "msg_r3", time: "10:00:40", usage: [4, 0, 0, 4] }));
  await hook({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "call-agent", tool_input: { prompt: "private prompt" }, timestamp: "10:00:50" });
  await hook({ hook_event_name: "SubagentStart", agent_id: agentId, agent_type: "general-purpose", timestamp: "10:00:51" });
  // The subagent inherits the root's wave and coordinator role until its own first Prism call.
  await appendFile(fixture.subagentTranscript, claudeMessage({ id: "msg_s1", time: "10:00:55", usage: [10, 0, 0, 10], agent: agentId }));
  await call({ tool: "Read", id: "call-read", input: { file_path: path.join(project, "docs", "plans", "demo", "state.json") }, time: "10:01:00", end: "10:01:01", agent: agentId });
  await appendFile(fixture.subagentTranscript, claudeMessage({ id: "msg_s2", time: "10:01:10", usage: [20, 0, 0, 20], agent: agentId }));
  // An undeclared subagent call during design targets design run 3, two design-audit waves having started.
  await call({
    tool: `${PRISM}get_change_map`,
    id: "call-change-map",
    input: { projectRoot: project, initiative: "demo", slice: "alpha" },
    time: "10:01:20",
    end: "10:01:21",
    agent: agentId
  });
  await appendFile(fixture.subagentTranscript, claudeMessage({ id: "msg_s3", time: "10:01:30", usage: [40, 0, 0, 40], agent: agentId }));
  await hook({ hook_event_name: "SubagentStop", agent_id: agentId, agent_transcript_path: fixture.subagentTranscript, timestamp: "10:01:40" });
  await appendFile(fixture.rootTranscript, claudeMessage({ id: "msg_r4", time: "10:01:45", usage: [5, 0, 0, 5] }));
  await hook({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "call-agent", tool_input: { prompt: "private prompt" }, tool_response: "private result", timestamp: "10:01:50" });
  await appendFile(fixture.rootTranscript, claudeMessage({ id: "msg_r5", time: "10:02:00", usage: [6, 0, 0, 6] }));
  // A call naming only the initiative targets its root slice, with the undeclared root role inferred as coordinator.
  await call({ tool: `${PRISM}get_initiative`, id: "call-initiative", input: { projectRoot: project, initiative: "demo" }, time: "10:02:10", end: "10:02:11" });
  await appendFile(fixture.rootTranscript, claudeMessage({ id: "msg_r6", time: "10:02:20", usage: [7, 0, 0, 7] }));
  await call({ tool: "Bash", id: "call-bash-2", input: { command: "private command" }, time: "10:02:30", end: "10:02:31" });

  const summary = await fixture.summary();
  assertMeasured(summary);
  assert.deepEqual(summary.runMeasures.executions.map((row) => row.execution), ["root", "subagent"]);

  const wave = targetEntry(summary, { slice: "alpha", kind: "wave", role: "coordinator" });
  assert.equal(wave.target.wave, "design-2");
  assert.equal(wave.attribution, "exact");
  assert.deepEqual(wave.inputTokens, measure(45));
  assert.deepEqual(wave.outputTokens, measure(45));
  assert.deepEqual(wave.toolCalls, measure(3));
  assert.deepEqual(wave.wallTimeMs, measure(129000));
  assert.deepEqual(wave.activeTimeMs, measure(129000));

  const designRun = targetEntry(summary, { slice: "alpha", kind: "design-run", role: "delivery" });
  assert.equal(designRun.target.designRun, 3);
  assert.equal(designRun.attribution, "approximate");
  assert.deepEqual(designRun.inputTokens, measure(40, "approximate"));
  assert.deepEqual(designRun.toolCalls, measure(1, "approximate"));
  assert.deepEqual(designRun.wallTimeMs, measure(20000, "approximate"));

  const rootSlice = targetEntry(summary, { slice: "demo", kind: "slice", role: "coordinator" });
  assert.equal(rootSlice.attribution, "approximate");
  assert.deepEqual(rootSlice.inputTokens, measure(7, "approximate"));
  assert.deepEqual(rootSlice.toolCalls, measure(2, "approximate"));
  assert.deepEqual(rootSlice.wallTimeMs, measure(21000, "approximate"));

  assert.equal(summary.runMeasures.attribution.targets.length, 3);
  const { unattributed } = summary.runMeasures.attribution;
  assert.deepEqual(unattributed.inputTokens, measure(3));
  assert.deepEqual(unattributed.toolCalls, measure(1));
  assert.deepEqual(unattributed.wallTimeMs, measure(30000));
  assertConserved(summary);
});

test("marks attribution to either slice approximate when an execution names a slice while another slice it named is still active", async (context) => {
  const fixture = await claudeFixture(context);
  const { hook, call, project } = fixture;
  const coordinator = { id: "private-actor", role: "coordinator" };
  await hook({ hook_event_name: "SessionStart", timestamp: "11:00:00" });
  await call({
    tool: `${PRISM}update_review`,
    id: "call-alpha",
    input: { projectRoot: project, initiative: "demo", slice: "alpha", expectedRevision: null, actor: coordinator, operations: [] },
    time: "11:00:10",
    end: "11:00:11"
  });
  await call({
    tool: `${PRISM}update_review`,
    id: "call-beta",
    input: { projectRoot: project, initiative: "demo", slice: "beta", expectedRevision: null, actor: coordinator, operations: [] },
    time: "11:00:20",
    end: "11:00:21"
  });
  await call({ tool: "Bash", id: "call-bash", time: "11:00:30", end: "11:00:31" });

  const summary = await fixture.summary();
  assertMeasured(summary);
  // Both roles are declared, so the approximation comes only from the interleaved slices.
  assert.equal(targetEntry(summary, { slice: "alpha", kind: "wave", role: "coordinator" }).attribution, "approximate");
  const beta = targetEntry(summary, { slice: "beta", kind: "slice", role: "coordinator" });
  assert.equal(beta.attribution, "approximate");
  assert.deepEqual(beta.toolCalls, measure(2, "approximate"));
  assertConserved(summary);
});

test("attributes a call to its slice with partial coverage when the review ledger cannot be read", async (context) => {
  const fixture = await claudeFixture(context, { alphaLedger: "{ not json" });
  const { hook, call, project } = fixture;
  await hook({ hook_event_name: "SessionStart", timestamp: "12:00:00" });
  const result = await call({
    tool: `${PRISM}update_review`,
    id: "call-alpha",
    input: { projectRoot: project, initiative: "demo", slice: "alpha", expectedRevision: null, actor: { id: "private-actor", role: "coordinator" }, operations: [] },
    time: "12:00:10",
    end: "12:00:11"
  });
  assert.equal(result.status, "processed");

  const summary = await fixture.summary();
  assertMeasured(summary);
  const alpha = targetEntry(summary, { slice: "alpha", kind: "slice", role: "coordinator" });
  assert.equal(alpha.attribution, "partial");
  assert.deepEqual(alpha.toolCalls, measure(1, "partial"));
  assertConserved(summary);
});

test("records no target for a call into a project whose run statistics are off", async (context) => {
  const fixture = await claudeFixture(context);
  const { hook, call } = fixture;
  // The call names a slice of a second project with an open wave, whose config switches collection off.
  const otherProject = await temporaryDirectory(context, "prism-call-attribution-off-project-");
  await writePlans(otherProject, { collectionOff: true });
  await hook({ hook_event_name: "SessionStart", timestamp: "12:30:00" });
  const result = await call({
    tool: `${PRISM}update_review`,
    id: "call-other-project",
    input: { projectRoot: otherProject, initiative: "demo", slice: "alpha", expectedRevision: null, actor: { id: "private-actor", role: "coordinator" }, operations: [] },
    time: "12:30:10",
    end: "12:30:11"
  });
  assert.equal(result.status, "processed");
  await call({ tool: "Bash", id: "call-bash", time: "12:30:20", end: "12:30:21" });

  const summary = await fixture.summary();
  assertMeasured(summary);
  const { targets, unattributed } = summary.runMeasures.attribution;
  assert.deepEqual(targets, []);
  assert.deepEqual(unattributed.toolCalls, measure(2));
  assert.deepEqual(unattributed.wallTimeMs, measure(21000));
  assertConserved(summary);
});

test("records no target for a call into a project whose config exceeds its bound and lowers the cost that follows to partial", async (context) => {
  const fixture = await claudeFixture(context);
  const { hook, call } = fixture;
  // The second project's oversized config switches collection off near its top; an oversized config means unknown before any parse.
  // Unknown is a collection failure, so the call stores no target and the cost that follows is at most partial.
  const otherProject = await temporaryDirectory(context, "prism-call-attribution-oversized-project-");
  await writePlans(otherProject, { collectionOff: true, oversizedConfig: true });
  await hook({ hook_event_name: "SessionStart", timestamp: "12:40:00" });
  const result = await call({
    tool: `${PRISM}update_review`,
    id: "call-oversized-project",
    input: { projectRoot: otherProject, initiative: "demo", slice: "alpha", expectedRevision: null, actor: { id: "private-actor", role: "coordinator" }, operations: [] },
    time: "12:40:10",
    end: "12:40:11"
  });
  assert.equal(result.status, "processed");
  await call({ tool: "Bash", id: "call-bash", time: "12:40:20", end: "12:40:21" });

  const summary = await fixture.summary();
  assertMeasured(summary);
  const { targets, unattributed } = summary.runMeasures.attribution;
  assert.deepEqual(targets, []);
  assert.deepEqual(unattributed.toolCalls, measure(2, "partial"));
  assert.deepEqual(unattributed.wallTimeMs, measure(21000, "partial"));
  assertConserved(summary);
});

test("keeps cost unattributed and below exact when the store refuses a Prism call's attribution event", async (context) => {
  const fixture = await claudeFixture(context);
  const { hook, call, project } = fixture;
  // A busy trace directory refuses the attribution write, as concurrent hook processes do when its lock stays held.
  const busyAttribution = async (event, options) => (event.eventType === "prism_call"
    ? { status: "ignored", reasonCode: "LOCK_UNAVAILABLE" }
    : appendSessionTraceEvent(event, options));
  await hook({ hook_event_name: "SessionStart", timestamp: "13:00:00" });
  const result = await call({
    tool: `${PRISM}get_review`,
    id: "call-refused",
    input: { projectRoot: project, initiative: "demo", slice: "alpha" },
    time: "13:00:10",
    end: "13:00:11",
    storeEvent: busyAttribution
  });
  assert.equal(result.status, "processed");
  await call({ tool: "Bash", id: "call-bash", time: "13:00:20", end: "13:00:21" });

  const summary = await fixture.summary();
  assertMeasured(summary);
  const { targets, unattributed } = summary.runMeasures.attribution;
  assert.deepEqual(targets, []);
  assert.deepEqual(unattributed.toolCalls, measure(2, "partial"));
  assert.equal(unattributed.wallTimeMs.coverage, "partial");
});

test("ignores a custom trace event of type prism_call while still recording the invocation's tool call", async (context) => {
  const fixture = await claudeFixture(context);
  const { hook, call } = fixture;
  await hook({ hook_event_name: "SessionStart", timestamp: "13:30:00" });
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-custom", tool_input: {}, timestamp: "13:30:10" });
  // A prism_call is only ever derived from a Prism tool call, so a custom event claiming one is dropped.
  const result = await hook({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "call-custom",
    tool_input: {},
    tool_response: "private result",
    prism_trace_event: { event_id: "private-custom-event", event_type: "prism_call" },
    timestamp: "13:30:11"
  });
  assert.equal(result.status, "processed");
  await call({ tool: "Bash", id: "call-bash", time: "13:30:20", end: "13:30:21" });

  const summary = await fixture.summary();
  assertMeasured(summary);
  assert.deepEqual(summary.runMeasures.executions[0].toolCalls, measure(2));
  const { targets, unattributed } = summary.runMeasures.attribution;
  assert.deepEqual(targets, []);
  assert.deepEqual(unattributed.toolCalls, measure(2));
  assertConserved(summary);
});

test("marks Codex attribution below the session partial and leaves a subagent thread's cost before its first Prism call unattributed", async (context) => {
  const project = await temporaryDirectory(context, "prism-call-attribution-codex-project-");
  const dataDirectory = await temporaryDirectory(context, "prism-call-attribution-codex-data-");
  await writePlans(project);
  const rollout = (transcript, { id, source, usage }) => writeFile(transcript, [
    line({ type: "session_meta", payload: { id, session_id: sessionId, cli_version: "0.147.0", model_provider: "openai", cwd: project, source } }),
    line({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: usage[0], cached_input_tokens: usage[1], output_tokens: usage[2], reasoning_output_tokens: 0, total_tokens: usage[0] + usage[2] },
          model_context_window: 200000
        }
      }
    })
  ].join(""));
  const rootTranscript = path.join(project, "rollout-root.jsonl");
  const subagentTranscript = path.join(project, "rollout-subagent.jsonl");
  await rollout(rootTranscript, { id: sessionId, source: "vscode", usage: [1000, 600, 50] });
  await rollout(subagentTranscript, { id: "codex-subagent-thread", source: { subagent: { depth: 1 } }, usage: [300, 100, 20] });
  const hook = (transcript, input) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcript, turn_id: "turn-1", ...input, timestamp: at(input.timestamp) })]),
    environment: { PLUGIN_DATA: dataDirectory }
  });
  const updateReview = {
    tool_name: "mcp__prism_review__update_review",
    tool_use_id: "codex-update-review",
    tool_input: { projectRoot: project, initiative: "demo", slice: "alpha", expectedRevision: null, actor: { id: "private-actor", role: "coordinator" }, operations: [] }
  };
  await hook(rootTranscript, { hook_event_name: "SessionStart", timestamp: "14:00:00" });
  await hook(rootTranscript, { hook_event_name: "PreToolUse", ...updateReview, timestamp: "14:00:01" });
  await hook(rootTranscript, { hook_event_name: "PostToolUse", ...updateReview, tool_response: "private result", timestamp: "14:00:02" });
  await hook(subagentTranscript, { hook_event_name: "PreToolUse", tool_name: "exec_command", tool_use_id: "codex-subagent-call", timestamp: "14:00:04" });
  await hook(subagentTranscript, { hook_event_name: "PostToolUse", tool_name: "exec_command", tool_use_id: "codex-subagent-call", tool_response: "private output", timestamp: "14:00:06" });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  assertMeasured(summary);
  assert.equal(summary.runMeasures.executions.length, 1);
  const wave = targetEntry(summary, { slice: "alpha", kind: "wave", role: "coordinator" });
  assert.equal(wave.attribution, "partial");
  assert.deepEqual(wave.toolCalls, measure(1, "partial"));
  assert.deepEqual(wave.cacheWriteTokens, measure(null, "unavailable"));
  // Each thread is replayed alone: the root thread's segment runs from the call's start at 14:00:01 to that thread's last event at 14:00:02.
  assert.deepEqual(wave.inputTokens, measure(400, "partial"));
  assert.deepEqual(wave.wallTimeMs, measure(1000, "partial"));
  assert.deepEqual(wave.activeTimeMs, measure(1000, "partial"));
  const { unattributed } = summary.runMeasures.attribution;
  // Without a subagent start link, as before Codex sent SubagentStart, a thread's cost before its own first Prism call has no target.
  assert.deepEqual(unattributed.toolCalls, measure(1, "partial"));
  assert.deepEqual(unattributed.inputTokens, measure(200, "partial"));
  // Root thread 14:00:00-14:00:01 plus subagent thread 14:00:04-14:00:06, even though the execution's own row is exact.
  assert.deepEqual(unattributed.wallTimeMs, measure(3000, "partial"));
  assert.deepEqual(unattributed.activeTimeMs, measure(3000, "partial"));
  assertConserved(summary);
});

test("gives a Codex subagent thread's cost before its first Prism call to the root target current at its start link", async (context) => {
  const project = await temporaryDirectory(context, "prism-call-attribution-codex-link-project-");
  const dataDirectory = await temporaryDirectory(context, "prism-call-attribution-codex-link-data-");
  await writePlans(project);
  const rollout = (transcript, { id, source, usage }) => writeFile(transcript, [
    line({ type: "session_meta", payload: { id, session_id: sessionId, cli_version: "0.147.0", model_provider: "openai", cwd: project, source } }),
    line({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: usage[0], cached_input_tokens: usage[1], output_tokens: usage[2], reasoning_output_tokens: 0, total_tokens: usage[0] + usage[2] },
          model_context_window: 200000
        }
      }
    })
  ].join(""));
  const rootTranscript = path.join(project, "rollout-root.jsonl");
  const subagentTranscript = path.join(project, "rollout-subagent.jsonl");
  await rollout(rootTranscript, { id: sessionId, source: "vscode", usage: [1000, 600, 50] });
  await rollout(subagentTranscript, { id: "codex-subagent-thread", source: { subagent: { depth: 1 } }, usage: [300, 100, 20] });
  const hook = (transcript, input) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcript, turn_id: "turn-1", ...input, timestamp: at(input.timestamp) })]),
    environment: { PLUGIN_DATA: dataDirectory }
  });
  const updateReview = {
    tool_name: "mcp__prism_review__update_review",
    tool_use_id: "codex-update-review",
    tool_input: { projectRoot: project, initiative: "demo", slice: "alpha", expectedRevision: null, actor: { id: "private-actor", role: "coordinator" }, operations: [] }
  };
  await hook(rootTranscript, { hook_event_name: "SessionStart", timestamp: "14:00:00" });
  await hook(rootTranscript, { hook_event_name: "PreToolUse", ...updateReview, timestamp: "14:00:01" });
  await hook(rootTranscript, { hook_event_name: "PostToolUse", ...updateReview, tool_response: "private result", timestamp: "14:00:02" });
  // Codex 0.166 sends SubagentStart with the spawned thread's id as agent_id and that thread's rollout as transcript_path.
  await hook(subagentTranscript, { hook_event_name: "SubagentStart", agent_id: "codex-subagent-thread", agent_type: "default", timestamp: "14:00:03" });
  await hook(subagentTranscript, { hook_event_name: "PreToolUse", tool_name: "exec_command", tool_use_id: "codex-subagent-call", timestamp: "14:00:04" });
  await hook(subagentTranscript, { hook_event_name: "PostToolUse", tool_name: "exec_command", tool_use_id: "codex-subagent-call", tool_response: "private output", timestamp: "14:00:06" });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  assertMeasured(summary);
  const wave = targetEntry(summary, { slice: "alpha", kind: "wave", role: "coordinator" });
  assert.equal(wave.attribution, "partial");
  // The root thread's call plus the subagent thread's call, which it made after starting under the root's alpha segment.
  assert.deepEqual(wave.toolCalls, measure(2, "partial"));
  assert.deepEqual(wave.inputTokens, measure(600, "partial"));
  // Root thread 14:00:01-14:00:02 plus subagent thread 14:00:03-14:00:06.
  assert.deepEqual(wave.wallTimeMs, measure(4000, "partial"));
  const { unattributed } = summary.runMeasures.attribution;
  assert.deepEqual(unattributed.toolCalls, measure(0, "partial"));
  assert.deepEqual(unattributed.wallTimeMs, measure(1000, "partial"));
  assertConserved(summary);
});
