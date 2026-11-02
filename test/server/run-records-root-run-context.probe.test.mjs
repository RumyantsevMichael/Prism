import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";
import { summarizeSessionConsumption } from "../../dist/server/session/session-trace-store.mjs";

// Review probe for run-records impl-1: docs/requirements/run-statistics.md §6 and §10.
// Cost is attributed from a Prism call until the execution's next such call, so a root run that starts after a quiet
// period, before the session's next Prism call, still serves the earlier call's slice and must be recorded for it.

const PRISM = "mcp__plugin_prism_prism-review__";
const MINUTE = 60 * 1000;
const sessionId = "probe-root-run-context";

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

test("probe: a root run that continues an earlier Prism call's target after a quiet period is recorded for that slice", async (context) => {
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
  await call(`${PRISM}update_review`, "call-alpha", { projectRoot: project, initiative: "demo", slice: "alpha", actor: { id: "a", role: "delivery" } }, 0.5);
  await call("Bash", "call-bash-1", {}, 1);
  // The user steps away for over 30 minutes, then the session continues alpha's work without another Prism call.
  await call("Bash", "call-bash-2", {}, 40);
  await call("Bash", "call-bash-3", {}, 41);

  // Before the session ends, its attribution assigns the later tool calls to alpha.
  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  const alpha = summary.runMeasures.attribution.targets.find((entry) => entry.target.slice === "alpha");
  assert.equal(alpha.toolCalls.value, 4, "the session attributes every tool call after the alpha call to alpha");

  await hook({ hook_event_name: "SessionEnd", at: 42 });
  const runs = path.join(project, ".prism", "initiatives", "demo", "slices", "alpha", "runs");
  const recorded = (await readdir(runs)).filter((name) => name.endsWith(".json"));
  assert.equal(recorded.length, 2, "both the first run and the run after the quiet period served alpha and are recorded");
});
