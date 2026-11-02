import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";

// Review probe for run-records impl-1: docs/requirements/run-statistics.md §10 and §13.
// A finished run whose run-statistics trace is full must still be recorded from its observed events,
// but the finalizer can only record a run after appending its run_end seal, which a full trace refuses.

const PRISM = "mcp__plugin_prism_prism-review__";
const MINUTE = 60 * 1000;
const MAX_TRACE_EVENTS = 4096;
const ORDER = new Map([["run_start", -1], ["session_start", 0], ["subagent_start", 1], ["model_switch", 1], ["coverage_gap", 2],
  ["search", 3], ["source_read", 3], ["test", 3], ["compaction", 3], ["tool_start", 3], ["usage", 3], ["tool_end", 4],
  ["prism_call", 4], ["edit_attempt", 4], ["edit", 5], ["first_edit", 6], ["subagent_stop", 7], ["session_end", 7], ["run_end", 8]]);
const compare = (left, right) => left.occurredAt.localeCompare(right.occurredAt)
  || (ORDER.get(left.eventType) ?? Number.MAX_SAFE_INTEGER) - (ORDER.get(right.eventType) ?? Number.MAX_SAFE_INTEGER)
  || left.eventIdDigest.localeCompare(right.eventIdDigest);

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

async function writePlans(project) {
  const initiative = path.join(project, ".prism", "initiatives", "demo");
  await mkdir(path.join(initiative, "slices", "alpha"), { recursive: true });
  await writeFile(path.join(initiative, "state.json"), JSON.stringify({
    schemaVersion: 1, settings: {}, active: [{ slice: "alpha", activity: "implementation", label: "l", workers: [] }], pending: [], next: [], evidence: []
  }));
  await writeFile(path.join(initiative, "slices", "alpha", "review.json"), JSON.stringify({ schemaVersion: 1, waves: [], findings: [] }));
}

function session(project, dataDirectory, sessionId, baseMs, transcript) {
  const hook = (input) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcript, ...input, timestamp: new Date(baseMs + input.at * MINUTE).toISOString() })]),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: project }
  });
  const call = async (tool, id, input, at) => {
    await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: id, tool_input: input, at });
    await hook({ hook_event_name: "PostToolUse", tool_name: tool, tool_use_id: id, tool_input: input, tool_response: "r", at: at + 1 / 60 });
  };
  return { hook, call };
}

test("probe: a quiet session's finished run is recorded even when its run-statistics trace is full", async (context) => {
  const project = await temporaryDirectory(context, "prism-probe-project-");
  const dataDirectory = await temporaryDirectory(context, "prism-probe-data-");
  await writePlans(project);
  const transcript = path.join(project, "transcript.jsonl");
  await writeFile(transcript, "");
  const review = { projectRoot: project, initiative: "demo", slice: "alpha", actor: { id: "a", role: "delivery" } };

  // A session that worked on alpha two hours ago and never ended.
  const quiet = session(project, dataDirectory, "probe-full-trace", Date.now() - 120 * MINUTE, transcript);
  await quiet.hook({ hook_event_name: "SessionStart", at: 0 });
  await quiet.call(`${PRISM}update_review`, "call-alpha", review, 0.5);
  await quiet.call("Bash", "call-bash", {}, 1);

  // Its run-statistics trace (the one holding run_start) fills to the trace event limit with repeated observations.
  const traces = path.join(dataDirectory, "session-traces");
  let runTrace = null;
  for (const name of (await readdir(traces)).filter((file) => file.endsWith(".json"))) {
    const state = JSON.parse(await readFile(path.join(traces, name), "utf8"));
    if (state.events.some((event) => event.eventType === "run_start")) runTrace = { file: path.join(traces, name), state };
  }
  assert.ok(runTrace, "the quiet session has a run-statistics trace");
  const filler = runTrace.state.events.findLast((event) => event.eventType === "tool_end");
  const events = [...runTrace.state.events];
  for (let index = 0; events.length < MAX_TRACE_EVENTS; index += 1) {
    events.push({ ...structuredClone(filler), eventIdDigest: createHash("sha256").update(`probe-filler-${index}`).digest("hex") });
  }
  await writeFile(runTrace.file, `${JSON.stringify({ ...runTrace.state, events: events.sort(compare) })}\n`);

  // Another session's next Prism hook sweeps the project's quiet sessions.
  const sweeper = session(project, dataDirectory, "probe-sweeper", Date.now() - 2 * MINUTE, transcript);
  await sweeper.hook({ hook_event_name: "SessionStart", at: 0 });
  await sweeper.call(`${PRISM}update_review`, "call-sweeper", review, 0.5);

  let recorded = [];
  try {
    recorded = (await readdir(path.join(project, ".prism", "initiatives", "demo", "slices", "alpha", "runs"))).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert.equal(recorded.length, 1, "the quiet session's finished run is recorded from its observed events");
});
