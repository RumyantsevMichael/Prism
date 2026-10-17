import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { recordSessionFacts } from "../../dist/hooks/record-session-facts.mjs";
import {
  createClaudeCodeHostAdapter,
  estimateClaudeCodeCapacity,
  inspectClaudeCodeTranscript,
  readClaudeCodeAutoCompactWindow
} from "../../dist/server/session/host-adapters/claude-code.mjs";
import { createSessionCorrelationKey } from "../../dist/server/session/host-session-facts.mjs";
import {
  evaluateActiveRepositoryFit,
  resolveActiveSessionCapacity
} from "../../dist/server/session/session-capacity.mjs";

const sessionId = "claude-session";

async function temporaryDirectory(context, prefix) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function claudeSession(context, { lines } = {}) {
  const root = await temporaryDirectory(context, "prism-claude-capacity-");
  const projectRoot = path.join(root, "project");
  const dataDirectory = path.join(root, "data");
  const configDirectory = path.join(root, "config");
  await mkdir(projectRoot);
  await mkdir(configDirectory);
  const transcriptPath = path.join(root, "transcript.jsonl");
  const entries = lines ?? [
    { type: "user", sessionId, version: "2.1.302" },
    { type: "assistant", sessionId, version: "2.1.302", message: { model: "claude-opus-5-5" } }
  ];
  await writeFile(transcriptPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return {
    projectRoot,
    dataDirectory,
    configDirectory,
    transcriptPath,
    environment: {
      CLAUDE_PROJECT_DIR: projectRoot,
      CLAUDE_PLUGIN_DATA: dataDirectory,
      CLAUDE_CONFIG_DIR: configDirectory
    }
  };
}

function hook(session, fields = {}) {
  return Readable.from([JSON.stringify({
    session_id: sessionId,
    transcript_path: session.transcriptPath,
    cwd: session.projectRoot,
    ...fields
  })]);
}

test("estimates a conservative Claude Code threshold from observable window controls", () => {
  assert.deepEqual(estimateClaudeCodeCapacity({ model: "claude-opus-5-5" }), {
    contextWindowTokens: 200000,
    compactionThresholdTokens: 144000
  });
  assert.deepEqual(estimateClaudeCodeCapacity({ model: "claude-opus-5-5[1m]" }), {
    contextWindowTokens: 1000000,
    compactionThresholdTokens: 144000
  });
  assert.equal(estimateClaudeCodeCapacity({
    model: "claude-opus-5-5[1m]",
    environment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" }
  }).compactionThresholdTokens, 384000);
  assert.equal(estimateClaudeCodeCapacity({
    model: "claude-opus-5-5",
    environment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" }
  }).compactionThresholdTokens, 144000);
  assert.equal(estimateClaudeCodeCapacity({
    model: "claude-opus-5-5[1m]",
    environment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000", CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }
  }).contextWindowTokens, 200000);
  assert.equal(estimateClaudeCodeCapacity({
    model: "claude-opus-5-5[1m]",
    environment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" },
    settingsAutoCompactWindow: 300000
  }).compactionThresholdTokens, 224000);
  assert.equal(estimateClaudeCodeCapacity({
    model: "claude-opus-5-5",
    environment: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" }
  }).compactionThresholdTokens, 90000);
  assert.equal(estimateClaudeCodeCapacity({
    model: "claude-opus-5-5",
    environment: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "95" }
  }).compactionThresholdTokens, 144000);
  assert.equal(estimateClaudeCodeCapacity({
    model: "claude-opus-5-5",
    environment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "15000" }
  }), null);
});

test("reads only the session's main-thread version and model from the transcript tail", async (context) => {
  const session = await claudeSession(context, {
    lines: [
      { type: "assistant", sessionId, version: "2.1.300", message: { model: "claude-opus-5-5" } },
      { type: "assistant", sessionId, isSidechain: true, version: "2.1.302", message: { model: "claude-haiku-5-5" } },
      { type: "assistant", sessionId: "other", version: "9.9.9", message: { model: "other-model" } },
      { type: "queue-operation", sessionId }
    ]
  });
  assert.deepEqual(await inspectClaudeCodeTranscript({ transcriptPath: session.transcriptPath, sessionId }), {
    harnessVersion: "2.1.300",
    model: "claude-opus-5-5"
  });
  assert.equal(await inspectClaudeCodeTranscript({ transcriptPath: path.join(session.projectRoot, "missing.jsonl"), sessionId }), null);
  assert.equal(await inspectClaudeCodeTranscript({ transcriptPath: "relative.jsonl", sessionId }), null);
});

test("reads the smallest autoCompactWindow from Claude Code settings layers", async (context) => {
  const session = await claudeSession(context);
  await writeFile(path.join(session.configDirectory, "settings.json"), JSON.stringify({ autoCompactWindow: 400000, env: { SECRET: "x" } }));
  await mkdir(path.join(session.projectRoot, ".claude"));
  await writeFile(path.join(session.projectRoot, ".claude", "settings.json"), JSON.stringify({
    autoCompactWindow: "auto",
    modelSettings: { opus: { autoCompactWindow: 250000 } }
  }));
  await writeFile(path.join(session.projectRoot, ".claude", "settings.local.json"), "not json");
  assert.equal(await readClaudeCodeAutoCompactWindow({ projectRoot: session.projectRoot, environment: session.environment }), 250000);
});

test("announces the key before a new Claude Code session has a transcript", async (context) => {
  const session = await claudeSession(context);
  await rm(session.transcriptPath);
  const result = await recordSessionFacts({
    input: hook(session, { hook_event_name: "SessionStart" }),
    environment: session.environment
  });
  assert.equal(result.record, null);
  assert.match(result.hookOutput.hookSpecificOutput.additionalContext, new RegExp(createSessionCorrelationKey(sessionId)));
  const resolution = await resolveActiveSessionCapacity({
    dataDirectory: session.dataDirectory,
    correlationKey: createSessionCorrelationKey(sessionId),
    projectRoot: session.projectRoot
  });
  assert.equal(resolution.reasonCode, "NO_SESSION_FACTS");
});

test("resolves an estimated active Claude Code capacity after the PreToolUse refresh", async (context) => {
  const session = await claudeSession(context);
  const capture = await recordSessionFacts({
    input: hook(session, { hook_event_name: "PreToolUse", tool_name: "mcp__prism__resolve_session_capacity" }),
    environment: session.environment
  });
  assert.equal(capture.status, "SUPPORTED");
  assert.equal(capture.hookOutput, null);
  const activeSession = {
    dataDirectory: session.dataDirectory,
    correlationKey: createSessionCorrelationKey(sessionId),
    projectRoot: session.projectRoot
  };
  const resolution = await resolveActiveSessionCapacity(activeSession);
  assert.equal(resolution.status, "SUPPORTED");
  assert.equal(resolution.capacityBasis, "ESTIMATED");
  assert.deepEqual(resolution.session, {
    harness: "claude-code",
    harnessVersion: "2.1.302",
    provider: "anthropic",
    model: "claude-opus-5-5"
  });
  assert.deepEqual(resolution.capacity, {
    contextWindowTokens: 200000,
    compactionThresholdTokens: 144000,
    implementationReserveTokens: 60000
  });
  assert.equal(resolution.provenance.compactionThreshold.field, "estimate.claude_code.auto_compact_threshold");
  assert.equal(resolution.provenance.implementationReserve.policy, "claude-code-conservative-estimate");

  const fit = await evaluateActiveRepositoryFit({
    costs: { baseSessionContextTokens: 30000, featureDesignContextTokens: 10000 },
    tokenEstimate: { lower: 30000, expected: 40000, upper: 50000 }
  }, activeSession);
  assert.equal(fit.repositoryReadBudgetTokens, 44000);
  assert.equal(fit.fit, "UNCERTAIN");

  const explicit = await resolveActiveSessionCapacity({
    ...activeSession,
    capacityOverrides: { contextWindowTokens: 200000, compactionThresholdTokens: 160000 }
  });
  assert.equal(explicit.capacityBasis, "ATTESTED");
  assert.equal(explicit.capacity.compactionThresholdTokens, 160000);
});

test("keeps the hook model across later events and ignores subagent hooks", async (context) => {
  const session = await claudeSession(context);
  const environment = { ...session.environment, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" };
  const first = await recordSessionFacts({
    input: hook(session, { hook_event_name: "SessionStart", model: "claude-opus-5-5[1m]" }),
    environment
  });
  assert.equal(first.record.host.model, "claude-opus-5-5[1m]");
  assert.equal(first.record.capacityOverrides.compactionThresholdTokens, 384000);

  const later = await recordSessionFacts({
    input: hook(session, { hook_event_name: "PreToolUse" }),
    environment
  });
  assert.equal(later.record.host.model, "claude-opus-5-5[1m]");
  assert.equal(later.record.sources.model, "hook.model");

  const subagent = await createClaudeCodeHostAdapter().capture({
    hookInput: { session_id: sessionId, transcript_path: session.transcriptPath, agent_id: "agent-1", hook_event_name: "PreToolUse" },
    environment
  });
  assert.equal(subagent.record, null);
  assert.equal(subagent.reasonCode, "UNSUPPORTED_EXECUTION");
});

test("never treats a Codex hook with a compatibility project directory as Claude Code", async (context) => {
  const session = await claudeSession(context);
  for (const [input, environment] of [
    [{ hook_event_name: "UserPromptSubmit", turn_id: "turn-1" }, session.environment],
    [{ hook_event_name: "UserPromptSubmit" }, { ...session.environment, CODEX_VERSION: "0.163.0" }]
  ]) {
    const result = await recordSessionFacts({ input: hook(session, input), environment });
    assert.equal(result.record, null);
    assert.equal(result.hookOutput, null);
  }
});

test("reports the Claude Code provider from the documented environment switches", async (context) => {
  const session = await claudeSession(context);
  const capture = await createClaudeCodeHostAdapter().capture({
    hookInput: { session_id: sessionId, transcript_path: session.transcriptPath, hook_event_name: "PreToolUse" },
    environment: { ...session.environment, CLAUDE_CODE_USE_BEDROCK: "1" }
  });
  assert.equal(capture.record.host.provider, "aws-bedrock");
});
