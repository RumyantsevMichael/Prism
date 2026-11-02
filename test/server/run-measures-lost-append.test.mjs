import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";
import {
  appendSessionTraceEvent,
  summarizeSessionConsumption
} from "../../dist/server/session/session-trace-store.mjs";

// Review probe (run-measures impl-1): docs/requirements/run-statistics.md §12 and §18.
// A run-statistics append that the store refuses, as concurrent hook processes do when the trace directory lock stays busy,
// must lower the coverage of the affected measures instead of leaving an undercount marked exact.

const sessionId = "run-measures-lost-append-probe";
const RUN_STATISTICS_TYPES = new Set(["tool_start", "tool_end", "usage"]);

test("a refused run-statistics append lowers tool-call coverage instead of reporting an exact undercount", async (context) => {
  const project = await realpath(await mkdtemp(path.join(tmpdir(), "prism-probe-project-")));
  const dataDirectory = await realpath(await mkdtemp(path.join(tmpdir(), "prism-probe-data-")));
  const transcripts = await realpath(await mkdtemp(path.join(tmpdir(), "prism-probe-transcripts-")));
  context.after(() => Promise.all([project, dataDirectory, transcripts].map((directory) => rm(directory, { recursive: true, force: true }))));
  const transcript = path.join(transcripts, `${sessionId}.jsonl`);
  await writeFile(transcript, "");
  const busyStore = async (event, options) => (RUN_STATISTICS_TYPES.has(event.eventType)
    ? { status: "ignored", reasonCode: "LOCK_UNAVAILABLE" }
    : appendSessionTraceEvent(event, options));
  const hook = (input, storeEvent = undefined) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: project, transcript_path: transcript, ...input, timestamp: `2026-10-22T${input.timestamp}.000Z` })]),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: project },
    ...(storeEvent ? { storeEvent } : {})
  });

  await hook({ hook_event_name: "SessionStart", timestamp: "10:00:00" });
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-a", timestamp: "10:00:01" });
  await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-a", timestamp: "10:00:02" });
  const refusedStart = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-b", timestamp: "10:00:03" }, busyStore);
  const refusedEnd = await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-b", timestamp: "10:00:04" }, busyStore);
  assert.equal(refusedStart.status, "processed");
  assert.equal(refusedEnd.status, "processed");
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-c", timestamp: "10:00:05" });
  await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-c", timestamp: "10:00:06" });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  const [root] = summary.runMeasures.executions;
  assert.ok(
    root.toolCalls.coverage !== "exact" || root.toolCalls.value === 3,
    `three tool calls ran, but the row reports ${JSON.stringify(root.toolCalls)}`
  );
});
