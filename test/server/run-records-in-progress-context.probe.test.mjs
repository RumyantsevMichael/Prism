import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";
import { summarizeSessionConsumption } from "../../dist/server/session/session-trace-store.mjs";

// Review probe for run-records impl-2: docs/requirements/run-statistics.md §6 and §13, slice.md Read surface and Finalization.
// The calling session's open run after a quiet period continues the execution's earlier Prism call target, so its in-progress
// counts belong to that target, as the session attribution and the record later written for the run both say.

const PRISM = "mcp__plugin_prism_prism-review__";
const MINUTE = 60 * 1000;
const sessionId = "probe-in-progress-context";

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

async function writePlans(project) {
  const initiative = path.join(project, ".prism", "initiatives", "demo");
  for (const slice of ["alpha", "beta"]) {
    await mkdir(path.join(initiative, "slices", slice), { recursive: true });
    await writeFile(path.join(initiative, "slices", slice, "review.json"), JSON.stringify({ schemaVersion: 1, waves: [], findings: [] }));
  }
  await writeFile(path.join(initiative, "state.json"), JSON.stringify({
    schemaVersion: 1, settings: {}, active: [{ slice: "beta", activity: "implementation", label: "l", workers: [] }], pending: [], next: [], evidence: []
  }));
}

test("probe: the calling session's open run after a quiet period reports its in-progress cost for the earlier call's slice", async (context) => {
  const project = await temporaryDirectory(context, "prism-probe-project-");
  const dataDirectory = await temporaryDirectory(context, "prism-probe-data-");
  await writePlans(project);
  const transcript = path.join(project, "transcript.jsonl");
  await writeFile(transcript, "");
  const baseMs = Date.now() - 60 * MINUTE;
  const hook = (input) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcript, ...input, timestamp: new Date(baseMs + input.at * MINUTE).toISOString() })]),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: project }
  });
  const call = async (tool, id, input, at) => {
    await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: id, tool_input: input, at });
    await hook({ hook_event_name: "PostToolUse", tool_name: tool, tool_use_id: id, tool_input: input, tool_response: "r", at: at + 1 / 60 });
  };

  await hook({ hook_event_name: "SessionStart", at: 0 });
  await call(`${PRISM}update_review`, "call-beta", { projectRoot: project, initiative: "demo", slice: "beta", actor: { id: "a", role: "delivery" } }, 0.5);
  await call("Bash", "call-bash-1", {}, 1);
  // After a quiet period the session continues beta's work without another Prism call; the new run is still open.
  await call("Bash", "call-bash-2", {}, 40);
  await call("Bash", "call-bash-3", {}, 41);

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  const attributed = summary.runMeasures.attribution.targets.find((entry) => entry.target.slice === "beta");
  assert.equal(attributed.toolCalls.value, 4, "the session attributes every tool call after the beta call to beta");
  const inProgress = summary.runMeasures.inProgress.targets.find((entry) => entry.target.slice === "beta");
  assert.equal(inProgress?.toolCalls.value, 2, "the open run's two tool calls are in progress for beta");
  assert.equal(summary.runMeasures.inProgress.unattributed.toolCalls.value, 0, "none of the open run's tool calls is unattributed");
});
