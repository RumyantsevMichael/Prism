import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";

// Review probe for run-records impl-2: docs/requirements/run-statistics.md §10.
// A run records one entry per slice its attributed cost served, so an earlier run's slice that the execution left before
// the run started serves none of the run's cost and must not receive a record for it.

const PRISM = "mcp__plugin_prism_prism-review__";
const MINUTE = 60 * 1000;
const sessionId = "probe-context-only-target";

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

async function records(project, slice) {
  const runs = path.join(project, ".prism", "initiatives", "demo", "slices", slice, "runs");
  const names = (await readdir(runs).catch(() => [])).filter((name) => name.endsWith(".json"));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(runs, name), "utf8"))));
}

test("probe: a run after a quiet period records only the slice current at its start, not an earlier run's slice", async (context) => {
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
  await call(`${PRISM}update_review`, "call-beta", { projectRoot: project, initiative: "demo", slice: "beta", actor: { id: "a", role: "delivery" } }, 2);
  await call("Bash", "call-bash-2", {}, 3);
  // After a quiet period the session continues beta's work without another Prism call.
  await call("Bash", "call-bash-3", {}, 40);
  await call("Bash", "call-bash-4", {}, 41);
  await hook({ hook_event_name: "SessionEnd", at: 42 });

  const beta = await records(project, "beta");
  assert.equal(beta.length, 2, "both runs served beta");
  const alpha = await records(project, "alpha");
  assert.deepEqual(
    alpha.map((record) => record.startedAt),
    [new Date(baseMs).toISOString()],
    "only the first run served alpha; the later run must not record a zero-cost alpha entry"
  );
});
