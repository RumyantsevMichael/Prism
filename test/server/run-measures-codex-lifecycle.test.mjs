import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";
import { summarizeSessionConsumption } from "../../dist/server/session/session-trace-store.mjs";

// Review probe (run-measures impl-1): docs/requirements/run-statistics.md §3, §12, §14; slice.md "New trace events".
// A Codex subagent thread's lifecycle event is not a repeat of the root thread's, so it must not suppress the root's session end.

const sessionId = "codex-lifecycle-probe";
const line = (value) => `${JSON.stringify(value)}\n`;

test("a Codex subagent thread's session end does not hide the root thread's later session end", async (context) => {
  const project = await realpath(await mkdtemp(path.join(tmpdir(), "prism-probe-project-")));
  const dataDirectory = await realpath(await mkdtemp(path.join(tmpdir(), "prism-probe-data-")));
  context.after(() => Promise.all([project, dataDirectory].map((directory) => rm(directory, { recursive: true, force: true }))));
  const rollout = (id, source, usage) => line({
    type: "session_meta",
    payload: { id, session_id: sessionId, cli_version: "0.147.0", model_provider: "openai", cwd: project, source }
  }) + line({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: usage[0], cached_input_tokens: usage[1], output_tokens: usage[2], reasoning_output_tokens: 0, total_tokens: usage[0] + usage[2] },
        model_context_window: 200000
      }
    }
  });
  const rootTranscript = path.join(project, "rollout-root.jsonl");
  const subagentTranscript = path.join(project, "rollout-subagent.jsonl");
  await writeFile(rootTranscript, rollout(sessionId, "vscode", [1000, 600, 50]));
  await writeFile(subagentTranscript, rollout("codex-subagent-thread", { subagent: { depth: 1 } }, [300, 100, 20]));
  const hook = (transcript, input) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcript, turn_id: "turn-1", ...input, timestamp: `2026-10-22T${input.timestamp}.000Z` })]),
    environment: { PLUGIN_DATA: dataDirectory }
  });

  await hook(rootTranscript, { hook_event_name: "SessionStart", timestamp: "10:00:00" });
  await hook(rootTranscript, { hook_event_name: "PreToolUse", tool_name: "exec_command", tool_use_id: "root-call", timestamp: "10:00:01" });
  await hook(rootTranscript, { hook_event_name: "PostToolUse", tool_name: "exec_command", tool_use_id: "root-call", timestamp: "10:00:02" });
  await hook(subagentTranscript, { hook_event_name: "PreToolUse", tool_name: "exec_command", tool_use_id: "subagent-call", timestamp: "10:00:04" });
  await hook(subagentTranscript, { hook_event_name: "PostToolUse", tool_name: "exec_command", tool_use_id: "subagent-call", timestamp: "10:00:05" });
  await hook(subagentTranscript, { hook_event_name: "SessionEnd", timestamp: "10:00:06" });
  await hook(rootTranscript, { hook_event_name: "SessionEnd", timestamp: "10:30:00" });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  const [root] = summary.runMeasures.executions;
  assert.equal(root.host, "codex");
  // Wall time runs to the last observed event of any thread, so it must reach the root's session end
  // or else stop claiming to be exact.
  assert.ok(
    root.wallTimeMs.coverage !== "exact" || root.wallTimeMs.value === 1800000,
    `wall time ${JSON.stringify(root.wallTimeMs)} ends at ${root.lastObservedAt}, before the root session end`
  );
});
