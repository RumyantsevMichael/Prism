import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { recordSessionTrace } from "../../dist/hooks/record-session-trace.mjs";
import {
  appendSessionTraceEvent,
  summarizeSessionConsumption
} from "../../dist/server/session/session-trace-store.mjs";

// Review probe (run-measures impl-2): docs/requirements/run-statistics.md §12 and §18; shared-run-records.md durable loss rule.
// A loss marker must not be evicted while the trace whose loss it records is retained, or the undercount turns exact again.

const sessionId = "run-measures-loss-eviction-probe";
const RUN_STATISTICS_TYPES = new Set(["tool_start", "tool_end", "usage"]);

test("directory size eviction does not remove a loss marker while its trace survives", async (context) => {
  const project = await realpath(await mkdtemp(path.join(tmpdir(), "prism-probe-project-")));
  const dataDirectory = await realpath(await mkdtemp(path.join(tmpdir(), "prism-probe-data-")));
  const transcripts = await realpath(await mkdtemp(path.join(tmpdir(), "prism-probe-transcripts-")));
  context.after(() => Promise.all([project, dataDirectory, transcripts].map((directory) => rm(directory, { recursive: true, force: true }))));
  const transcript = path.join(transcripts, `${sessionId}.jsonl`);
  await writeFile(transcript, "");
  const busyStore = async (event, options) => (RUN_STATISTICS_TYPES.has(event.eventType)
    ? { status: "ignored", reasonCode: "LOCK_UNAVAILABLE" }
    : appendSessionTraceEvent(event, options));
  const hook = (session, input, storeEvent = undefined) => recordSessionTrace({
    input: Readable.from([JSON.stringify({ session_id: session, cwd: project, transcript_path: transcript, ...input, timestamp: `2026-10-22T${input.timestamp}.000Z` })]),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: project },
    ...(storeEvent ? { storeEvent } : {})
  });
  const traces = path.join(dataDirectory, "session-traces");
  const files = async () => (await readdir(traces)).filter((name) => /\.json$|\.loss/.test(name));

  await hook(sessionId, { hook_event_name: "SessionStart", timestamp: "10:00:00" });
  await hook(sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-a", timestamp: "10:00:01" });
  await hook(sessionId, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-a", timestamp: "10:00:02" });
  await hook(sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-b", timestamp: "10:00:03" }, busyStore);
  await hook(sessionId, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-b", timestamp: "10:00:04" }, busyStore);
  const marker = (await files()).find((name) => name.includes(".loss"));
  assert.ok(marker, "the refused append left a loss marker");
  await hook(sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-c", timestamp: "10:00:05" });
  await hook(sessionId, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call-c", timestamp: "10:00:06" });
  const ownTraces = (await files()).filter((name) => name !== marker);

  // Another session's traces were last written after the loss but before the marked session's latest append.
  const other = `${sessionId}-other`;
  await hook(other, { hook_event_name: "SessionStart", timestamp: "11:00:00" });
  for (let index = 0; index < 12; index += 1) {
    await hook(other, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `other-${index}`, timestamp: `11:00:${String(index + 1).padStart(2, "0")}` });
  }
  const otherTraces = (await files()).filter((name) => name !== marker && !ownTraces.includes(name));
  const base = Date.now() / 1000 - 3600;
  await utimes(path.join(traces, marker), base, base);
  for (const name of otherTraces) await utimes(path.join(traces, name), base + 60, base + 60);
  for (const name of ownTraces) await utimes(path.join(traces, name), base + 120, base + 120);
  let ownBytes = 0;
  for (const name of ownTraces) ownBytes += (await stat(path.join(traces, name))).size;

  // A third session's first append needs room: the size limit keeps the marked session's traces but not the other session's.
  let first = true;
  const tightStore = (event, options) => {
    const limit = first ? { maxDirectoryBytes: ownBytes + 3000 } : {};
    first = false;
    return appendSessionTraceEvent(event, { ...options, ...limit });
  };
  await hook(`${sessionId}-third`, { hook_event_name: "SessionStart", timestamp: "12:00:00" }, tightStore);

  const remaining = await files();
  assert.ok(ownTraces.every((name) => remaining.includes(name)), "the marked session's traces were retained");
  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: project });
  const [root] = summary.runMeasures.executions;
  assert.ok(
    root.toolCalls.coverage !== "exact" || root.toolCalls.value === 3,
    `three tool calls ran, but after eviction (marker kept: ${remaining.includes(marker)}) the row reports ${JSON.stringify(root.toolCalls)}`
  );
});
