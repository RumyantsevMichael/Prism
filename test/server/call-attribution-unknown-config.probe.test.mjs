import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";
import { summarizeSessionConsumption } from "../../dist/server/session/session-trace-store.mjs";

// Review probe for call-attribution impl-1: docs/requirements/run-statistics.md §12 and §18.
// A Prism call whose target cannot be collected because its project's config cannot be read is a collection failure,
// so the cost that follows must not be reported as exact attribution to the previous target.

const sessionId = "call-attribution-probe-session";
const at = (time) => `2026-10-23T${time}.000Z`;
const PRISM = "mcp__plugin_prism_prism-review__";

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

test("probe: a call whose project config cannot be read lowers the coverage of the cost that follows", async (context) => {
  const project = await temporaryDirectory(context, "prism-probe-project-");
  const dataDirectory = await temporaryDirectory(context, "prism-probe-data-");
  await writePlans(project);
  // A second project with collection on but a config over the 256 KiB bound, so its target cannot be collected.
  const otherProject = await temporaryDirectory(context, "prism-probe-other-");
  await writePlans(otherProject);
  await mkdir(path.join(otherProject, ".prism"), { recursive: true });
  await writeFile(path.join(otherProject, ".prism", "workflow.md"), `# Workflow config\n\n${"Padding prose.\n".repeat(20000)}`);
  const transcript = path.join(project, "transcript.jsonl");
  await writeFile(transcript, "");
  const hook = (input) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcript, ...input, timestamp: at(input.timestamp) })]),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: project }
  });
  const call = async (tool, id, input, time, end) => {
    await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: id, tool_input: input, timestamp: time });
    await hook({ hook_event_name: "PostToolUse", tool_name: tool, tool_use_id: id, tool_input: input, tool_response: "r", timestamp: end });
  };
  await hook({ hook_event_name: "SessionStart", timestamp: "10:00:00" });
  await call(`${PRISM}update_review`, "call-alpha", { projectRoot: project, initiative: "demo", slice: "alpha", actor: { id: "a", role: "delivery" } }, "10:00:10", "10:00:11");
  await call(`${PRISM}get_review`, "call-other", { projectRoot: otherProject, initiative: "demo", slice: "alpha" }, "10:00:20", "10:00:21");
  await call("Bash", "call-bash", {}, "10:00:30", "10:00:31");

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  assert.equal(summary.runMeasures.collection, "on");
  const alpha = summary.runMeasures.attribution.targets.find((entry) => entry.target.slice === "alpha");
  assert.ok(alpha, "the alpha target is attributed");
  // Three tool calls land on alpha, two of them after a call whose target could not be collected.
  assert.equal(alpha.toolCalls.value, 3);
  assert.notEqual(alpha.attribution, "exact", "cost after an uncollectable Prism call is not exact attribution");
  assert.notEqual(alpha.toolCalls.coverage, "exact", "cost after an uncollectable Prism call is not exact");
});
