import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createSessionTraceNormalizer, recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";
import {
  readSessionTraceEvents,
  summarizeSessionConsumption
} from "../../dist/server/session/session-trace-store.mjs";

// Requirements: docs/requirements/run-statistics.md §1, §2, §3, §4, §5, §12, §14, §18.
// Feature: docs/Features/F-run-measures.feature.

const sessionId = "run-measures-session";
const agentId = "a1b2c3d4e5f6";
const at = (time) => `2026-10-22T${time}.000Z`;

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

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
      usage: {
        input_tokens: usage[0],
        cache_creation_input_tokens: usage[1],
        cache_read_input_tokens: usage[2],
        output_tokens: usage[3]
      }
    }
  });
}

async function claudeFixture(context, workflowConfig = null) {
  const project = await temporaryDirectory(context, "prism-run-measures-project-");
  const dataDirectory = await temporaryDirectory(context, "prism-run-measures-data-");
  const transcripts = await temporaryDirectory(context, "prism-run-measures-transcripts-");
  await writeFile(path.join(project, "README.md"), "fixture\n");
  if (workflowConfig !== null) {
    await mkdir(path.join(project, ".prism"));
    await writeFile(path.join(project, ".prism", "workflow.md"), workflowConfig);
  }
  const rootTranscript = path.join(transcripts, `${sessionId}.jsonl`);
  const subagentTranscript = path.join(transcripts, sessionId, "subagents", `agent-${agentId}.jsonl`);
  await mkdir(path.dirname(subagentTranscript), { recursive: true });
  await writeFile(rootTranscript, "");
  await writeFile(subagentTranscript, "");
  const environment = { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: project };
  const hook = (input, normalizer = undefined) => recordSessionTrace({
    input: Readable.from([JSON.stringify({
      session_id: sessionId,
      cwd: project,
      transcript_path: rootTranscript,
      ...input,
      timestamp: at(input.timestamp)
    })]),
    environment,
    ...(normalizer ? { normalizer } : {})
  });
  return { project, dataDirectory, rootTranscript, subagentTranscript, hook };
}

function execution(summary, kind) {
  return summary.runMeasures.executions.filter((row) => row.execution === kind);
}

function measure(value, coverage = "exact") {
  return { value, coverage };
}

// Every stored file, so run-statistics traces kept beside the root session trace are checked too.
async function storedText(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

// Base names of every stored file, so a run-statistics trace file anywhere in the data directory is seen.
async function storedFileNames(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

// Pre-edit fields that run statistics must leave unchanged (run-statistics.md §18; shared-run-records ADR).
function preEditFacts(summary) {
  return { coverage: summary.coverage, reasonCodes: summary.reasonCodes, preEdit: summary.preEdit, provenance: summary.provenance };
}

test("reports wall time, active time, tokens once per message, and tool calls for the root session and a subagent", async (context) => {
  const fixture = await claudeFixture(context);
  const { hook } = fixture;

  await hook({ hook_event_name: "SessionStart", timestamp: "10:00:00" });
  await appendFile(fixture.rootTranscript, [
    claudeMessage({ id: "msg_r1", time: "10:00:05", usage: [2, 100, 0, 10] }),
    claudeMessage({ id: "msg_r1", time: "10:00:05", usage: [2, 100, 0, 10] })
  ].join(""));
  await hook({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "call-agent", tool_input: { prompt: "private prompt" }, timestamp: "10:00:10" });
  await hook({ hook_event_name: "SubagentStart", agent_id: agentId, agent_type: "general-purpose", timestamp: "10:00:11" });
  await appendFile(fixture.subagentTranscript, [
    claudeMessage({ id: "msg_s1", time: "10:00:15", usage: [5, 200, 0, 30], agent: agentId }),
    claudeMessage({ id: "msg_s1", time: "10:00:15", usage: [5, 200, 0, 30], agent: agentId }),
    claudeMessage({ id: "msg_s2", time: "10:00:19", usage: [4, 20, 200, 15], agent: agentId })
  ].join(""));
  await hook({ hook_event_name: "PreToolUse", agent_id: agentId, tool_name: "Read", tool_use_id: "call-read", tool_input: { file_path: path.join(fixture.project, "README.md") }, timestamp: "10:00:20" });
  await hook({ hook_event_name: "PostToolUse", agent_id: agentId, tool_name: "Read", tool_use_id: "call-read", tool_input: { file_path: path.join(fixture.project, "README.md") }, tool_response: "private source", timestamp: "10:00:21" });
  await hook({ hook_event_name: "SubagentStop", agent_id: agentId, agent_transcript_path: fixture.subagentTranscript, timestamp: "10:00:30" });
  await appendFile(fixture.rootTranscript, claudeMessage({ id: "msg_r2", time: "10:00:31", usage: [3, 50, 100, 20] }));
  await hook({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "call-agent", tool_response: "private result", timestamp: "10:00:31" });
  // Twenty idle minutes with no running tool, then a ten-minute tool call.
  await appendFile(fixture.rootTranscript, claudeMessage({ id: "msg_r3", time: "10:20:31", usage: [1, 10, 150, 5] }));
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-bash", tool_input: { command: "private command" }, timestamp: "10:20:31" });
  await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-bash", tool_response: "private output", timestamp: "10:30:31" });

  const summary = await summarizeSessionConsumption({
    dataDirectory: fixture.dataDirectory,
    sessionId,
    projectRoot: fixture.project
  });

  assert.equal(summary.status, "SUPPORTED");
  assert.equal(summary.runMeasures.collection, "on");
  assert.equal(summary.runMeasures.idleThresholdMs, 300000);
  const [root] = execution(summary, "root");
  assert.equal(root.host, "claude-code");
  assert.equal(root.ended, false);
  assert.deepEqual(root.wallTimeMs, measure(1831000));
  assert.deepEqual(root.activeTimeMs, measure(631000));
  assert.deepEqual(root.inputTokens, measure(6));
  assert.deepEqual(root.cacheWriteTokens, measure(160));
  assert.deepEqual(root.cacheReadTokens, measure(250));
  assert.deepEqual(root.outputTokens, measure(35));
  assert.deepEqual(root.toolCalls, measure(2));

  const subagents = execution(summary, "subagent");
  assert.equal(subagents.length, 1);
  const [subagent] = subagents;
  assert.equal(subagent.ended, true);
  assert.match(subagent.executionDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(subagent.executionDigest, root.executionDigest);
  assert.deepEqual(subagent.wallTimeMs, measure(19000));
  assert.deepEqual(subagent.activeTimeMs, measure(19000));
  assert.deepEqual(subagent.inputTokens, measure(9));
  assert.deepEqual(subagent.cacheWriteTokens, measure(220));
  assert.deepEqual(subagent.cacheReadTokens, measure(200));
  assert.deepEqual(subagent.outputTokens, measure(45));
  assert.deepEqual(subagent.toolCalls, measure(1));

  // Subagent reads stay out of the root pre-edit summary.
  assert.equal(summary.preEdit.sourceReadCount, 0);

  const stored = await storedText(fixture.dataDirectory);
  for (const forbidden of ["private", agentId, fixture.rootTranscript, "msg_r1"]) {
    assert.equal(stored.includes(forbidden), false, `trace must not contain ${forbidden}`);
  }
});

test("counts a long-running tool call as active time", async (context) => {
  const fixture = await claudeFixture(context);
  await fixture.hook({ hook_event_name: "SessionStart", timestamp: "11:00:00" });
  await fixture.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-tests", timestamp: "11:00:01" });
  await fixture.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-tests", timestamp: "11:12:01" });

  const summary = await summarizeSessionConsumption({ dataDirectory: fixture.dataDirectory, sessionId, projectRoot: fixture.project });
  const [root] = execution(summary, "root");
  assert.deepEqual(root.activeTimeMs, measure(721000));
  assert.deepEqual(root.toolCalls, measure(1));
});

test("reports token measures as unavailable instead of zero when the transcript format is unrecognized", async (context) => {
  const fixture = await claudeFixture(context);
  await writeFile(fixture.rootTranscript, "not a transcript record\n{\"unexpected\":true}\n");
  await fixture.hook({ hook_event_name: "SessionStart", timestamp: "12:00:00" });
  await fixture.hook({ hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "call-grep", timestamp: "12:00:01" });
  const result = await fixture.hook({ hook_event_name: "PostToolUse", tool_name: "Grep", tool_use_id: "call-grep", timestamp: "12:00:02" });
  assert.equal(result.status, "processed");

  const summary = await summarizeSessionConsumption({ dataDirectory: fixture.dataDirectory, sessionId, projectRoot: fixture.project });
  // The usage-unavailable gap and the tool spans live in the run-statistics trace, so the root
  // pre-edit coverage and reason codes stay exactly what the baseline reports for this sequence.
  assert.equal(summary.coverage, "partial");
  assert.deepEqual(summary.reasonCodes, ["INITIAL_COVERAGE_PARTIAL", "MISSING_RENDERED_TOKEN_COUNT"]);
  assert.equal(summary.preEdit.searchCount, 1);
  assert.equal(summary.provenance.limitReached, false);
  const [root] = execution(summary, "root");
  for (const key of ["inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens"]) {
    assert.deepEqual(root[key], measure(null, "unavailable"), key);
  }
  assert.deepEqual(root.toolCalls, measure(1));
});

test("keeps tool events of a subagent with an invalid agent id out of the root pre-edit summary", async (context) => {
  const fixture = await claudeFixture(context);
  const control = await claudeFixture(context);
  for (const { hook } of [fixture, control]) {
    await hook({ hook_event_name: "SessionStart", timestamp: "12:30:00" });
    await hook({ hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "call-grep", timestamp: "12:30:01" });
    await hook({ hook_event_name: "PostToolUse", tool_name: "Grep", tool_use_id: "call-grep", timestamp: "12:30:02" });
  }
  const readme = path.join(fixture.project, "README.md");
  await fixture.hook({ hook_event_name: "PreToolUse", agent_id: "bad id!", tool_name: "Read", tool_use_id: "call-bad-read", tool_input: { file_path: readme }, timestamp: "12:30:03" });
  const result = await fixture.hook({ hook_event_name: "PostToolUse", agent_id: "bad id!", tool_name: "Read", tool_use_id: "call-bad-read", tool_input: { file_path: readme }, tool_response: "private source", timestamp: "12:30:04" });
  assert.equal(result.status, "processed");

  const summary = await summarizeSessionConsumption({ dataDirectory: fixture.dataDirectory, sessionId, projectRoot: fixture.project });
  const controlSummary = await summarizeSessionConsumption({ dataDirectory: control.dataDirectory, sessionId, projectRoot: control.project });
  assert.equal(summary.preEdit.sourceReadCount, 0);
  assert.deepEqual(preEditFacts(summary), preEditFacts(controlSummary));
  assert.equal(summary.runMeasures.executions.length, 1);
  const [root] = execution(summary, "root");
  assert.deepEqual(root.toolCalls, measure(1, "partial"));
  assert.equal(root.wallTimeMs.coverage, "partial");
});

test("marks token measures partial when a usage read is cut short by its time budget", async (context) => {
  const fixture = await claudeFixture(context);
  const { hook } = fixture;
  await hook({ hook_event_name: "SessionStart", timestamp: "12:45:00" });
  await appendFile(fixture.rootTranscript, claudeMessage({ id: "msg_b1", time: "12:45:01", usage: [2, 100, 0, 10] }));
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-b1", timestamp: "12:45:01" });
  await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-b1", timestamp: "12:45:02" });
  await appendFile(fixture.rootTranscript, claudeMessage({ id: "msg_b2", time: "12:45:03", usage: [3, 50, 100, 20] }));
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-b2", timestamp: "12:45:03" });
  // A zero budget stands in for a transcript too large to read before the in-hook deadline.
  const result = await hook(
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-b2", timestamp: "12:45:04" },
    createSessionTraceNormalizer({ usageReadBudgetMs: 0 })
  );
  assert.equal(result.status, "processed");

  const summary = await summarizeSessionConsumption({ dataDirectory: fixture.dataDirectory, sessionId, projectRoot: fixture.project });
  const [root] = execution(summary, "root");
  // The last complete read stays the value, marked partial because a later read was cut short.
  assert.deepEqual(root.inputTokens, measure(2, "partial"));
  assert.deepEqual(root.cacheWriteTokens, measure(100, "partial"));
  assert.deepEqual(root.cacheReadTokens, measure(0, "partial"));
  assert.deepEqual(root.outputTokens, measure(10, "partial"));
  assert.deepEqual(root.toolCalls, measure(2));
  assert.deepEqual(root.wallTimeMs, measure(4000));
});

test("the workflow off switch stops run statistics collection", async (context) => {
  const fixture = await claudeFixture(context, "# Workflow config\n\n## Run statistics\n- Collection: off\n");
  await appendFile(fixture.rootTranscript, claudeMessage({ id: "msg_off", time: "13:00:01", usage: [1, 1, 1, 1] }));
  await fixture.hook({ hook_event_name: "SessionStart", timestamp: "13:00:00" });
  await fixture.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-off", timestamp: "13:00:01" });
  await fixture.hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-off", timestamp: "13:00:02" });
  await fixture.hook({ hook_event_name: "SubagentStart", agent_id: agentId, timestamp: "13:00:03" });

  const summary = await summarizeSessionConsumption({ dataDirectory: fixture.dataDirectory, sessionId, projectRoot: fixture.project });
  assert.equal(summary.runMeasures.collection, "off");
  assert.deepEqual(summary.runMeasures.executions, []);
  const trace = await readSessionTraceEvents({ dataDirectory: fixture.dataDirectory, sessionId, projectRoot: fixture.project });
  assert.equal(trace.status, "SUPPORTED");
  const runStatisticsEvents = trace.events.filter((event) => ["tool_start", "tool_end", "usage", "subagent_start", "subagent_stop"].includes(event.eventType));
  assert.deepEqual(runStatisticsEvents, []);
  // The root session trace is the only stored file: no run-statistics trace exists for the root execution or the subagent.
  const sessionDigests = new Set(trace.events.map((event) => event.sessionDigest));
  assert.equal(sessionDigests.size, 1);
  const [rootTraceFile] = [...sessionDigests].map((digest) => `${digest}.json`);
  assert.deepEqual(await storedFileNames(fixture.dataDirectory), [rootTraceFile]);
});

test("reports Codex session totals with cache-write unavailable and partial attribution below the session", async (context) => {
  const project = await temporaryDirectory(context, "prism-run-measures-codex-project-");
  const dataDirectory = await temporaryDirectory(context, "prism-run-measures-codex-data-");
  const transcript = path.join(project, "rollout.jsonl");
  await writeFile(transcript, [
    line({
      type: "session_meta",
      payload: { id: sessionId, session_id: sessionId, cli_version: "0.147.0", model_provider: "openai", cwd: project, source: "vscode" }
    }),
    line({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 },
          model_context_window: 200000
        }
      }
    })
  ].join(""));
  const hook = (input) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcript, turn_id: "turn-1", ...input, timestamp: at(input.timestamp) })]),
    environment: { PLUGIN_DATA: dataDirectory }
  });
  await hook({ hook_event_name: "SessionStart", timestamp: "14:00:00" });
  await hook({ hook_event_name: "PreToolUse", tool_name: "exec_command", tool_use_id: "codex-call", timestamp: "14:00:01" });
  await hook({ hook_event_name: "PostToolUse", tool_name: "exec_command", tool_use_id: "codex-call", tool_response: "private output", timestamp: "14:00:03" });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  assert.equal(summary.runMeasures.executions.length, 1);
  const [root] = execution(summary, "root");
  assert.equal(root.host, "codex");
  assert.equal(root.belowSession, "partial");
  assert.deepEqual(root.inputTokens, measure(400));
  assert.deepEqual(root.cacheReadTokens, measure(600));
  assert.deepEqual(root.outputTokens, measure(50));
  assert.deepEqual(root.cacheWriteTokens, measure(null, "unavailable"));
  assert.deepEqual(root.toolCalls, measure(1));
  assert.deepEqual(root.wallTimeMs, measure(3000));
});

test("sums each Codex thread's latest usage and tool calls into the session row when a subagent thread reports usage", async (context) => {
  const project = await temporaryDirectory(context, "prism-run-measures-codex-subagent-project-");
  const dataDirectory = await temporaryDirectory(context, "prism-run-measures-codex-subagent-data-");
  const rootTranscript = path.join(project, "rollout-root.jsonl");
  const subagentTranscript = path.join(project, "rollout-subagent.jsonl");
  const rollout = ({ id, source, usage }) => [
    line({
      type: "session_meta",
      payload: { id, session_id: sessionId, cli_version: "0.147.0", model_provider: "openai", cwd: project, source }
    }),
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
  ].join("");
  await writeFile(rootTranscript, rollout({ id: sessionId, source: "vscode", usage: [1000, 600, 50] }));
  await writeFile(subagentTranscript, rollout({ id: "codex-subagent-thread", source: { subagent: { depth: 1 } }, usage: [300, 100, 20] }));
  const hook = (transcript, input) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcript, turn_id: "turn-1", ...input, timestamp: at(input.timestamp) })]),
    environment: { PLUGIN_DATA: dataDirectory }
  });
  await hook(rootTranscript, { hook_event_name: "SessionStart", timestamp: "14:30:00" });
  await hook(rootTranscript, { hook_event_name: "PreToolUse", tool_name: "exec_command", tool_use_id: "codex-root-call", timestamp: "14:30:01" });
  await hook(rootTranscript, { hook_event_name: "PostToolUse", tool_name: "exec_command", tool_use_id: "codex-root-call", tool_response: "private output", timestamp: "14:30:03" });
  await hook(subagentTranscript, { hook_event_name: "PreToolUse", tool_name: "exec_command", tool_use_id: "codex-subagent-call", timestamp: "14:30:04" });
  await hook(subagentTranscript, { hook_event_name: "PostToolUse", tool_name: "exec_command", tool_use_id: "codex-subagent-call", tool_response: "private output", timestamp: "14:30:06" });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  // One session row: Codex subagent threads are summed into it, never reported as their own rows.
  assert.equal(summary.runMeasures.executions.length, 1);
  const [root] = execution(summary, "root");
  assert.equal(root.host, "codex");
  assert.equal(root.belowSession, "partial");
  assert.deepEqual(root.inputTokens, measure(600));
  assert.deepEqual(root.cacheReadTokens, measure(700));
  assert.deepEqual(root.outputTokens, measure(70));
  assert.deepEqual(root.cacheWriteTokens, measure(null, "unavailable"));
  assert.deepEqual(root.toolCalls, measure(2));
  assert.deepEqual(root.wallTimeMs, measure(6000));
  assert.deepEqual(root.activeTimeMs, measure(6000));
});

test("reports an execution whose run-statistics appends were refused below exact instead of dropping it", async (context) => {
  const { project, dataDirectory, rootTranscript } = await claudeFixture(context);
  const { appendSessionTraceEvent } = await import("../../dist/server/session/session-trace-store.mjs");
  // A busy trace directory refuses the subagent's link writes, as concurrent hook processes do when its lock stays held.
  const busyLinks = async (event, options) => (["subagent_start", "subagent_stop"].includes(event.eventType)
    ? { status: "ignored", reasonCode: "LOCK_UNAVAILABLE" }
    : appendSessionTraceEvent(event, options));
  const hook = (input, storeEvent = undefined) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: rootTranscript, ...input, timestamp: at(input.timestamp) })]),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: project },
    ...(storeEvent ? { storeEvent } : {})
  });
  await hook({ hook_event_name: "SessionStart", timestamp: "15:00:00" });
  await hook({ hook_event_name: "SubagentStart", agent_id: agentId, timestamp: "15:00:01" }, busyLinks);
  await hook({ hook_event_name: "PreToolUse", agent_id: agentId, tool_name: "Bash", tool_use_id: "lost-link-call", timestamp: "15:00:02" });
  await hook({ hook_event_name: "PostToolUse", agent_id: agentId, tool_name: "Bash", tool_use_id: "lost-link-call", timestamp: "15:00:03" });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  const [root] = execution(summary, "root");
  const [subagent] = execution(summary, "subagent");
  assert.equal(root.wallTimeMs.coverage, "partial");
  assert.ok(subagent, "the subagent whose link was refused still has a row");
  assert.deepEqual(subagent.toolCalls, measure(1, "partial"));

  // A session whose every run-statistics append was refused reports an unavailable root row rather than no row.
  const refuseAll = async () => ({ status: "ignored", reasonCode: "LOCK_UNAVAILABLE" });
  const otherSession = `${sessionId}-all-refused`;
  await recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: otherSession, cwd: project, transcript_path: rootTranscript, hook_event_name: "SessionStart", timestamp: at("15:10:00") })]),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: project },
    storeEvent: refuseAll
  });
  const refused = await summarizeSessionConsumption({ dataDirectory, sessionId: otherSession, projectRoot: project });
  assert.deepEqual(refused.runMeasures.executions.map((row) => [row.execution, row.wallTimeMs.coverage]), [["root", "unavailable"]]);
});
