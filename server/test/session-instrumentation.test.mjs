import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createSessionTraceNormalizer,
  recordSessionTrace
} from "../../hooks/record-session-trace.mjs";
import {
  readSessionTraceEvents,
  summarizeSessionConsumption
} from "../session-trace-store.mjs";

const sessionId = "private-hook-session";
const projectRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const occurredAt = "2026-09-19T12:00:00.000Z";

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function inputFrom(value) {
  return Readable.from([JSON.stringify(value)]);
}

function hookInput(overrides = {}) {
  return {
    session_id: sessionId,
    cwd: projectRoot,
    timestamp: occurredAt,
    ...overrides
  };
}

function codexTranscriptMetadata(overrides = {}) {
  return {
    status: "SUPPORTED",
    execution: "root",
    harnessVersion: "0.155.0-alpha.9.2",
    provider: "openai",
    projectRoot,
    ...overrides
  };
}

test("uses injected normalization and storage without forwarding private host fields", async () => {
  const stored = [];
  const normalizerCalls = [];
  const normalizer = async ({ hookInput: input }) => {
    normalizerCalls.push(Object.keys(input).sort());
    return {
      sessionId: input.session_id,
      projectRoot: input.cwd,
      eventId: "safe-event-id",
      eventType: "search",
      occurredAt,
      counts: { renderedTokens: 12 },
      hashValues: { tool: "Search" },
      provenance: { collector: "test", hostEvent: "Custom" }
    };
  };
  const storeEvent = async (event, options) => {
    stored.push({ event, options });
    return { status: "appended", appendedEventTypes: [event.eventType] };
  };
  const result = await recordSessionTrace({
    input: inputFrom(hookInput({
      prompt: "private prompt text",
      tool_input: { query: "private query text" },
      tool_response: "private model response"
    })),
    environment: { PLUGIN_DATA: "/private/plugin-data", PRIVATE_TOKEN: "private-token" },
    normalizer,
    storeEvent
  });

  assert.equal(result.status, "processed");
  assert.equal(normalizerCalls.length, 1);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].options.dataDirectory, "/private/plugin-data");
  const serialized = JSON.stringify(stored[0].event);
  for (const privateValue of [
    sessionId,
    projectRoot,
    "private prompt text",
    "private query text",
    "private model response",
    "private-token"
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("normalizes successful reads without storing source or tool output", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-trace-hook-read-");
  const result = await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PostToolUse",
      tool_use_id: "read-1",
      tool_name: "Read",
      tool_input: {
        file_path: path.join(projectRoot, "server/example.mjs"),
        offset: 4,
        limit: 9
      },
      tool_response: "private source text",
      rendered_token_count: 70
    })),
    environment: {
      CLAUDE_PLUGIN_DATA: dataDirectory,
      CLAUDE_PLUGIN_ROOT: "/private/plugin-root",
      CLAUDE_PROJECT_DIR: projectRoot
    },
    normalizer: createSessionTraceNormalizer({ now: () => new Date(occurredAt) })
  });

  assert.equal(result.status, "processed");
  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(summary.coverage, "partial");
  assert.equal(summary.preEdit.renderedTokens, 70);
  assert.deepEqual(summary.preEdit.sourceRanges, [{
    path: "server/example.mjs",
    startLine: 4,
    endLine: 12,
    renderedTokens: 70
  }]);
});

test("closes the window only after a confirmed successful mutation", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-trace-hook-edit-");
  const environment = { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: projectRoot };
  const events = [
    hookInput({
      hook_event_name: "SessionStart",
      instrumentation_coverage: "exact"
    }),
    hookInput({
      hook_event_name: "PreToolUse",
      tool_use_id: "edit-failed",
      tool_name: "Edit",
      tool_input: { file_path: path.join(projectRoot, "server/change.mjs") }
    }),
    hookInput({
      hook_event_name: "PostToolUseFailure",
      tool_use_id: "edit-failed",
      tool_name: "Edit",
      tool_input: { file_path: path.join(projectRoot, "server/change.mjs") },
      error: "private failure text"
    })
  ];
  for (const event of events) {
    await recordSessionTrace({ input: inputFrom(event), environment });
  }

  const open = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(open.preEdit.window, "open");
  assert.equal(open.preEdit.firstEditAt, null);

  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PostToolUse",
      tool_use_id: "edit-success",
      tool_name: "Edit",
      tool_input: { file_path: path.join(projectRoot, "server/change.mjs") },
      tool_response: "private edit response"
    })),
    environment
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PostToolUse",
      tool_use_id: "edit-success-2",
      tool_name: "Write",
      tool_input: { file_path: path.join(projectRoot, "server/change-2.mjs") }
    })),
    environment
  });

  const closed = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(closed.preEdit.window, "closed");
  assert.equal(closed.preEdit.firstEditAt, occurredAt);
  assert.equal(closed.provenance.eventCount, 6);
});

test("marks shell mutation visibility as partial coverage", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-trace-hook-shell-");
  const environment = { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: projectRoot };
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "SessionStart",
      instrumentation_coverage: "exact"
    })),
    environment
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PreToolUse",
      tool_use_id: "shell-1",
      tool_name: "Bash",
      tool_input: { command: "private mutation command" }
    })),
    environment
  });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(summary.coverage, "partial");
  assert.equal(summary.preEdit.renderedTokens, null);
  assert.ok(summary.reasonCodes.includes("COVERAGE_GAP"));
});

test("requires explicit success for custom edit events", async () => {
  const normalizer = createSessionTraceNormalizer({ now: () => new Date(occurredAt) });
  const [attempt] = await normalizer.normalize({
    hookInput: hookInput({
      prism_trace_event: {
        event_id: "custom-edit",
        event_type: "edit",
        confirmed_success: false,
        source_path: "server/change.mjs"
      }
    }),
    environment: { CLAUDE_PROJECT_DIR: projectRoot }
  });
  const [edit] = await normalizer.normalize({
    hookInput: hookInput({
      prism_trace_event: {
        event_id: "custom-edit-success",
        event_type: "edit",
        confirmed_success: true,
        source_path: "server/change.mjs"
      }
    }),
    environment: { CLAUDE_PROJECT_DIR: projectRoot }
  });

  assert.equal(attempt.eventType, "edit_attempt");
  assert.equal(edit.eventType, "edit");
});

test("keeps retries idempotent while distinguishing host event phases", async () => {
  let tick = 0;
  const normalizer = createSessionTraceNormalizer({
    now: () => new Date(Date.UTC(2026, 8, 19, 12, 0, tick++))
  });
  const input = hookInput({
    timestamp: undefined,
    tool_use_id: "shared-tool-id",
    tool_name: "apply_patch",
    tool_response: { isError: false }
  });
  const [firstAttempt] = await normalizer.normalize({
    hookInput: { ...input, hook_event_name: "PreToolUse" },
    environment: { CLAUDE_PROJECT_DIR: projectRoot }
  });
  const [retriedAttempt] = await normalizer.normalize({
    hookInput: { ...input, hook_event_name: "PreToolUse" },
    environment: { CLAUDE_PROJECT_DIR: projectRoot }
  });
  const [completion] = await normalizer.normalize({
    hookInput: { ...input, hook_event_name: "PostToolUse" },
    environment: { CLAUDE_PROJECT_DIR: projectRoot }
  });

  assert.equal(firstAttempt.eventId, retriedAttempt.eventId);
  assert.notEqual(firstAttempt.eventId, completion.eventId);
});

test("normalizes valid host event times before chronological ordering", async () => {
  const normalizer = createSessionTraceNormalizer({
    now: () => new Date("2026-09-19T14:00:00.000Z")
  });
  const [event] = await normalizer.normalize({
    hookInput: hookInput({
      timestamp: "2026-09-19T12:00:00Z",
      hook_event_name: "SessionStart"
    }),
    environment: { CLAUDE_PROJECT_DIR: projectRoot }
  });

  assert.equal(event.occurredAt, occurredAt);
});

test("closes Codex edits only for a versioned PostToolUse lifecycle contract", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-trace-codex-edit-");
  const environment = { PLUGIN_DATA: dataDirectory, CODEX_VERSION: "future-version" };
  let harnessVersion = "0.156.0";
  const normalizer = createSessionTraceNormalizer({
    now: () => new Date(occurredAt),
    inspectCodexTranscript: async () => codexTranscriptMetadata({ harnessVersion })
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "SessionStart",
      instrumentation_coverage: "exact",
      transcript_path: "/private/root-rollout.jsonl"
    })),
    environment,
    normalizer
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PostToolUse",
      tool_use_id: "unsupported-version-patch",
      tool_name: "apply_patch",
      tool_input: { command: "private patch text" },
      tool_response: "Done!",
      transcript_path: "/private/root-rollout.jsonl"
    })),
    environment,
    normalizer
  });

  const open = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(open.preEdit.window, "open");
  assert.equal(open.coverage, "partial");

  harnessVersion = "0.155.0-alpha.9.2";
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PreToolUse",
      tool_use_id: "confirmed-patch",
      tool_name: "apply_patch",
      tool_input: { command: "private patch text" },
      transcript_path: "/private/root-rollout.jsonl"
    })),
    environment,
    normalizer
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PostToolUse",
      tool_use_id: "confirmed-patch",
      tool_name: "apply_patch",
      tool_input: { command: "private patch text" },
      tool_response: "Done!",
      transcript_path: "/private/root-rollout.jsonl"
    })),
    environment,
    normalizer
  });
  const closed = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(closed.preEdit.window, "closed");
  const trace = await readSessionTraceEvents({ dataDirectory, sessionId, projectRoot });
  assert.equal(trace.events.filter((event) => event.eventType === "edit_attempt").length, 2);
  assert.equal(trace.events.filter((event) => event.eventType === "edit").length, 1);
  assert.equal(trace.events.filter((event) => event.eventType === "first_edit").length, 1);
});

test("requires the exact registered Codex mutation tool name", async () => {
  const normalizer = createSessionTraceNormalizer({
    now: () => new Date(occurredAt),
    inspectCodexTranscript: async () => codexTranscriptMetadata()
  });
  const events = await normalizer.normalize({
    hookInput: hookInput({
      hook_event_name: "PostToolUse",
      tool_use_id: "case-varied-patch",
      tool_name: "APPLY_PATCH",
      tool_response: "Done!",
      transcript_path: "/private/root.jsonl"
    }),
    environment: { CODEX_VERSION: "0.155.0-alpha.9.2" }
  });

  assert.deepEqual(events.map((event) => event.eventType), ["coverage_gap", "edit_attempt"]);
  assert.equal(events[0].gapReason, "unproved-mutation-success");
});

test("excludes Codex subagent events and lowers coverage when execution correlation is uncertain", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-trace-codex-execution-");
  const environment = { PLUGIN_DATA: dataDirectory, CODEX_VERSION: "0.155.0-alpha.9.2" };
  const normalizer = createSessionTraceNormalizer({
    now: () => new Date(occurredAt),
    inspectCodexTranscript: async ({ transcriptPath }) => {
      if (transcriptPath.endsWith("root.jsonl")) {
        return codexTranscriptMetadata();
      }
      if (transcriptPath.endsWith("subagent.jsonl")) {
        return codexTranscriptMetadata({ execution: "subagent" });
      }
      return {
        status: "UNSUPPORTED",
        reasonCode: "INVALID_TRANSCRIPT",
        projectRoot
      };
    }
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "SessionStart",
      instrumentation_coverage: "exact",
      transcript_path: "/private/root.jsonl"
    })),
    environment,
    normalizer
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PostToolUse",
      tool_use_id: "subagent-edit",
      tool_name: "apply_patch",
      tool_response: { isError: false },
      transcript_path: "/private/subagent.jsonl"
    })),
    environment,
    normalizer
  });
  const stillOpen = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(stillOpen.preEdit.window, "open");
  assert.equal(stillOpen.coverage, "partial");
  assert.ok(stillOpen.reasonCodes.includes("COVERAGE_GAP"));

  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PostToolUse",
      tool_use_id: "uncertain-read",
      tool_name: "Read",
      tool_input: { file_path: path.join(projectRoot, "server/example.mjs") },
      transcript_path: "/private/unknown.jsonl"
    })),
    environment,
    normalizer
  });
  const partial = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(partial.preEdit.window, "open");
  assert.equal(partial.coverage, "partial");
  assert.equal(partial.preEdit.sourceReadCount, 0);
});

test("estimates bounded Codex response tokens without retaining the response", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-trace-codex-token-estimate-");
  const environment = { PLUGIN_DATA: dataDirectory, CODEX_VERSION: "0.155.0-alpha.9.2" };
  const privateResponse = "private model-facing search response";
  const normalizer = createSessionTraceNormalizer({
    now: () => new Date(occurredAt),
    inspectCodexTranscript: async () => codexTranscriptMetadata()
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "SessionStart",
      instrumentation_coverage: "exact",
      transcript_path: "/private/root.jsonl"
    })),
    environment,
    normalizer
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PostToolUse",
      tool_use_id: "estimated-search",
      tool_name: "Search",
      tool_response: privateResponse,
      transcript_path: "/private/root.jsonl"
    })),
    environment,
    normalizer
  });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(summary.preEdit.renderedTokens, Math.ceil(Buffer.byteLength(privateResponse, "utf8") / 3));
  assert.equal(summary.coverage, "partial");
  assert.ok(summary.reasonCodes.includes("COVERAGE_GAP"));

  const trace = await readSessionTraceEvents({ dataDirectory, sessionId, projectRoot });
  assert.equal(JSON.stringify(trace.events).includes(privateResponse), false);
  assert.equal(trace.events.filter((event) => event.eventType === "search").length, 1);
  assert.equal(trace.events.filter((event) => event.eventType === "coverage_gap").length, 1);
});

test("leaves oversized Codex response consumption unavailable", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-trace-codex-token-bound-");
  const environment = { PLUGIN_DATA: dataDirectory, CODEX_VERSION: "0.155.0-alpha.9.2" };
  const normalizer = createSessionTraceNormalizer({
    now: () => new Date(occurredAt),
    inspectCodexTranscript: async () => codexTranscriptMetadata()
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "SessionStart",
      instrumentation_coverage: "exact",
      transcript_path: "/private/root.jsonl"
    })),
    environment,
    normalizer
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PostToolUse",
      tool_use_id: "oversized-search",
      tool_name: "Search",
      tool_response: "x".repeat(1024 * 1024 + 1),
      transcript_path: "/private/root.jsonl"
    })),
    environment,
    normalizer
  });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(summary.coverage, "partial");
  assert.equal(summary.preEdit.renderedTokens, null);
  assert.ok(summary.reasonCodes.includes("MISSING_RENDERED_TOKEN_COUNT"));
});

test("does not serialize Codex response objects to estimate model-facing tokens", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-trace-codex-object-token-");
  const normalizer = createSessionTraceNormalizer({
    now: () => new Date(occurredAt),
    inspectCodexTranscript: async () => codexTranscriptMetadata()
  });
  const environment = { PLUGIN_DATA: dataDirectory, CODEX_VERSION: "0.155.0-alpha.9.2" };
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "SessionStart",
      instrumentation_coverage: "exact",
      transcript_path: "/private/root.jsonl"
    })),
    environment,
    normalizer
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      hook_event_name: "PostToolUse",
      tool_use_id: "object-search",
      tool_name: "Search",
      tool_response: { content: "private response content" },
      transcript_path: "/private/root.jsonl"
    })),
    environment,
    normalizer
  });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot });
  assert.equal(summary.coverage, "partial");
  assert.equal(summary.preEdit.renderedTokens, null);
  assert.ok(summary.reasonCodes.includes("MISSING_RENDERED_TOKEN_COUNT"));
  const trace = await readSessionTraceEvents({ dataDirectory, sessionId, projectRoot });
  assert.equal(JSON.stringify(trace.events).includes("private response content"), false);
});

test("classifies correlated Codex hooks despite Claude compatibility aliases", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-trace-codex-compatibility-");
  const project = await temporaryDirectory(context, "prism-trace-codex-compatibility-project-");
  const canonicalProject = await realpath(project);
  const rootTranscript = path.join(project, "root.jsonl");
  const subagentTranscript = path.join(project, "subagent.jsonl");
  const sessionMeta = (source, id = sessionId) => JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      session_id: sessionId,
      cli_version: "0.155.0-alpha.9.2",
      model_provider: "openai",
      cwd: project,
      source
    }
  });
  await writeFile(rootTranscript, `${sessionMeta("vscode")}\n`);
  await writeFile(subagentTranscript, `${sessionMeta({ subagent: { depth: 1 } }, "child-execution")}\n`);
  const environment = {
    CLAUDE_PLUGIN_DATA: dataDirectory,
    CLAUDE_PLUGIN_ROOT: "/private/plugin-root"
  };
  const normalizer = createSessionTraceNormalizer({ now: () => new Date(occurredAt) });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      cwd: project,
      hook_event_name: "SessionStart",
      model: "claude-sonnet",
      instrumentation_coverage: "exact",
      transcript_path: rootTranscript
    })),
    environment,
    normalizer
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      cwd: project,
      hook_event_name: "PostToolUse",
      tool_use_id: "unproved-root-edit",
      tool_name: "apply_patch",
      tool_response: "unstructured response",
      transcript_path: rootTranscript
    })),
    environment,
    normalizer
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      cwd: project,
      hook_event_name: "PostToolUse",
      tool_use_id: "subagent-edit",
      tool_name: "apply_patch",
      tool_response: { isError: false },
      transcript_path: subagentTranscript
    })),
    environment,
    normalizer
  });

  const summary = await summarizeSessionConsumption({ dataDirectory, sessionId, projectRoot: canonicalProject });
  assert.equal(summary.preEdit.window, "closed");
  assert.equal(summary.coverage, "partial");
  const trace = await readSessionTraceEvents({ dataDirectory, sessionId, projectRoot: canonicalProject });
  assert.equal(trace.events.filter((event) => event.eventType === "edit").length, 1);
  assert.ok(trace.events.every((event) => event.provenance.collector === "codex-hook"));
});

test("canonicalizes the hook project root before it creates trace identity", async (context) => {
  const fixture = await temporaryDirectory(context, "prism-trace-canonical-");
  const dataDirectory = await temporaryDirectory(context, "prism-trace-canonical-data-");
  const project = path.join(fixture, "project");
  const linkedProject = path.join(fixture, "linked-project");
  await mkdir(project);
  await symlink(project, linkedProject);
  const canonicalProject = await realpath(project);
  const canonicalSession = "canonical-session";

  await recordSessionTrace({
    input: inputFrom({
      session_id: canonicalSession,
      cwd: linkedProject,
      timestamp: occurredAt,
      hook_event_name: "SessionStart"
    }),
    environment: { CLAUDE_PLUGIN_DATA: dataDirectory, CLAUDE_PROJECT_DIR: linkedProject }
  });

  const summary = await summarizeSessionConsumption({
    dataDirectory,
    sessionId: canonicalSession,
    projectRoot: canonicalProject
  });
  assert.equal(summary.status, "SUPPORTED");
});

test("does not hash a project identity that resolves to a regular file", async (context) => {
  const fixture = await temporaryDirectory(context, "prism-trace-file-root-");
  const fileRoot = path.join(fixture, "not-a-project.txt");
  await writeFile(fileRoot, "not a project\n");
  const normalizer = createSessionTraceNormalizer({ now: () => new Date(occurredAt) });

  const events = await normalizer.normalize({
    hookInput: hookInput({ cwd: fileRoot, hook_event_name: "SessionStart" }),
    environment: { CLAUDE_PROJECT_DIR: fileRoot }
  });
  assert.deepEqual(events, []);
});

test("a correlated Codex transcript overrides Claude compatibility and version environment values", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-trace-codex-host-priority-");
  const project = await temporaryDirectory(context, "prism-trace-codex-host-priority-project-");
  const transcript = path.join(project, "rollout.jsonl");
  await writeFile(transcript, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: sessionId,
      session_id: sessionId,
      cli_version: "0.155.0-alpha.9.2",
      model_provider: "openai",
      cwd: project,
      source: "vscode"
    }
  })}\n`);

  await recordSessionTrace({
    input: inputFrom(hookInput({
      cwd: project,
      hook_event_name: "SessionStart",
      instrumentation_coverage: "exact",
      transcript_path: transcript,
      turn_id: "turn-1",
      model: "gpt-5.6-sol"
    })),
    environment: {
      PLUGIN_DATA: dataDirectory,
      PLUGIN_ROOT: "/private/codex-plugin",
      CLAUDE_PLUGIN_ROOT: "/private/codex-plugin",
      CLAUDE_VERSION: "hostile-compatibility-value"
    }
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      cwd: project,
      hook_event_name: "PostToolUse",
      tool_use_id: "successful-patch",
      tool_name: "apply_patch",
      tool_input: { command: "private patch text" },
      tool_response: "Done!",
      transcript_path: transcript,
      turn_id: "turn-1",
      model: "gpt-5.6-sol"
    })),
    environment: {
      PLUGIN_DATA: dataDirectory,
      PLUGIN_ROOT: "/private/codex-plugin",
      CLAUDE_PLUGIN_ROOT: "/private/codex-plugin",
      CLAUDE_VERSION: "hostile-compatibility-value"
    }
  });

  const summary = await summarizeSessionConsumption({
    dataDirectory,
    sessionId,
    projectRoot: await realpath(project)
  });
  assert.equal(summary.preEdit.window, "closed");
  const trace = await readSessionTraceEvents({
    dataDirectory,
    sessionId,
    projectRoot: await realpath(project)
  });
  assert.ok(trace.events.every((event) => event.provenance.collector === "codex-hook"));
});

test("a documented Claude project root remains stable when the hook cwd changes", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-trace-claude-stable-root-");
  const project = await temporaryDirectory(context, "prism-trace-claude-stable-root-project-");
  const child = path.join(project, "nested");
  await mkdir(child);
  const environment = {
    CLAUDE_PLUGIN_DATA: dataDirectory,
    CLAUDE_PLUGIN_ROOT: "/private/claude-plugin",
    CLAUDE_PROJECT_DIR: project
  };

  await recordSessionTrace({
    input: inputFrom(hookInput({
      cwd: project,
      hook_event_name: "SessionStart",
      instrumentation_coverage: "exact",
      transcript_path: path.join(project, "claude-transcript.jsonl")
    })),
    environment
  });
  await recordSessionTrace({
    input: inputFrom(hookInput({
      cwd: child,
      hook_event_name: "PostToolUse",
      tool_use_id: "read-after-cd",
      tool_name: "Read",
      model: "claude-sonnet",
      tool_input: { file_path: path.join(project, "server/example.mjs") },
      rendered_token_count: 17,
      transcript_path: path.join(project, "claude-transcript.jsonl")
    })),
    environment
  });

  const summary = await summarizeSessionConsumption({
    dataDirectory,
    sessionId,
    projectRoot: await realpath(project)
  });
  assert.equal(summary.coverage, "exact");
  assert.equal(summary.preEdit.sourceReadCount, 1);
  assert.equal(summary.preEdit.renderedTokens, 17);
  const trace = await readSessionTraceEvents({
    dataDirectory,
    sessionId,
    projectRoot: await realpath(project)
  });
  assert.ok(trace.events.every((event) => event.provenance.collector === "claude-code-hook"));
});

test("Codex-only markers prevent fallback to Claude when root correlation fails", async () => {
  const normalizer = createSessionTraceNormalizer({
    now: () => new Date(occurredAt),
    inspectCodexTranscript: async () => ({
      status: "UNSUPPORTED",
      reasonCode: "INVALID_TRANSCRIPT",
      projectRoot
    })
  });
  const events = await normalizer.normalize({
    hookInput: hookInput({
      hook_event_name: "PostToolUse",
      turn_id: "codex-turn",
      tool_use_id: "ambiguous-edit",
      tool_name: "Edit",
      tool_response: "Done!",
      transcript_path: "/private/invalid.jsonl"
    }),
    environment: { CLAUDE_PROJECT_DIR: projectRoot }
  });

  assert.deepEqual(events.map((event) => event.eventType), ["coverage_gap"]);
  assert.equal(events[0].provenance.collector, "codex-hook");
});

test("an unrelated namespaced write tool cannot close the repository edit window", async () => {
  const normalizer = createSessionTraceNormalizer({ now: () => new Date(occurredAt) });
  const events = await normalizer.normalize({
    hookInput: hookInput({
      cwd: process.cwd(),
      hook_event_name: "PostToolUse",
      tool_use_id: "external-write",
      tool_name: "mcp__notion__write",
      tool_response: { isError: false }
    }),
    environment: {}
  });

  assert.equal(events.some((event) => event.eventType === "edit"), false);
});

test("rejects an edit path whose in-project symbolic link resolves outside the project", async (context) => {
  const project = await temporaryDirectory(context, "prism-trace-edit-path-project-");
  const outside = await temporaryDirectory(context, "prism-trace-edit-path-outside-");
  const linked = path.join(project, "linked");
  await symlink(outside, linked, "dir");
  const normalizer = createSessionTraceNormalizer({ now: () => new Date(occurredAt) });
  const events = await normalizer.normalize({
    hookInput: hookInput({
      cwd: project,
      hook_event_name: "PostToolUse",
      tool_use_id: "linked-edit",
      tool_name: "Edit",
      tool_input: { file_path: path.join(linked, "change.mjs") }
    }),
    environment: { CLAUDE_PROJECT_DIR: project }
  });

  assert.deepEqual(events.map((event) => event.eventType), ["coverage_gap"]);
  assert.equal(events[0].gapReason, "unsupported-mutation-path");
});

test("an unknown host cannot prove mutation success through response fields", async () => {
  const normalizer = createSessionTraceNormalizer({ now: () => new Date(occurredAt) });
  const events = await normalizer.normalize({
    hookInput: hookInput({
      cwd: projectRoot,
      hook_event_name: "PostToolUse",
      tool_use_id: "unknown-host-edit",
      tool_name: "Edit",
      tool_input: { file_path: path.join(projectRoot, "server/change.mjs") },
      tool_response: { isError: false }
    }),
    environment: {}
  });

  assert.deepEqual(events.map((event) => event.eventType), ["coverage_gap", "edit_attempt"]);
  assert.equal(events[0].gapReason, "unproved-mutation-success");
});

test("returns an ignored result when injected storage fails", async () => {
  const result = await recordSessionTrace({
    input: inputFrom(hookInput({ hook_event_name: "SessionStart" })),
    environment: { PLUGIN_DATA: "/private/plugin-data" },
    storeEvent: async () => {
      throw new Error("private storage failure");
    }
  });

  assert.equal(result.status, "ignored");
});

test("does not store a dependent observation after its coverage gap is rejected", async () => {
  const storedTypes = [];
  const result = await recordSessionTrace({
    input: inputFrom(hookInput({ hook_event_name: "PostToolUse" })),
    environment: { PLUGIN_DATA: "/private/plugin-data" },
    normalizer: async () => [
      {
        sessionId,
        projectRoot,
        eventId: "gap-first",
        eventType: "coverage_gap",
        occurredAt,
        coverage: "partial",
        gapReason: "estimated-token-count",
        provenance: { collector: "test", hostEvent: "Custom" }
      },
      {
        sessionId,
        projectRoot,
        eventId: "dependent-search",
        eventType: "search",
        occurredAt,
        counts: { renderedTokens: 9 },
        provenance: { collector: "test", hostEvent: "Custom" }
      }
    ],
    storeEvent: async (event) => {
      storedTypes.push(event.eventType);
      return { status: "ignored", reasonCode: "LOCK_UNAVAILABLE" };
    }
  });

  assert.equal(result.status, "processed");
  assert.deepEqual(storedTypes, ["coverage_gap"]);
  assert.equal(result.results.length, 1);
});

test("the hook command fails open for malformed input", async (context) => {
  const hookPath = fileURLToPath(new URL("../../hooks/record-session-trace.mjs", import.meta.url));
  const dataDirectory = await temporaryDirectory(context, "prism-trace-hook-malformed-");
  const child = spawn(process.execPath, [hookPath], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDirectory
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end("not-json");

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(exitCode, 0);
  assert.equal(Buffer.concat(stdout).toString(), "");
  assert.equal(Buffer.concat(stderr).toString(), "");
});
