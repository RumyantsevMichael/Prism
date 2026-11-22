import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function json(relativePath) {
  return JSON.parse(await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8"));
}

test("uses host-specific portable MCP launch paths", async () => {
  const claudeManifest = await json(".claude-plugin/plugin.json");
  const claudeMcp = await json(".claude-mcp.json");
  const codexManifest = await json(".codex-plugin/plugin.json");
  const codexMcp = await json(".codex-mcp.json");

  assert.equal(claudeManifest.mcpServers, "./.claude-mcp.json");
  assert.deepEqual(claudeMcp.mcpServers["prism-review"], {
    command: "node",
    args: ["${CLAUDE_PLUGIN_ROOT}/dist/server/mcp.mjs"],
    // Its own tool timeout overrides a short MCP_TOOL_TIMEOUT, such as a cloud session's, so a gate wait reaches the background handoff.
    timeout: 100000000,
    env: { NODE_USE_ENV_PROXY: "1", PRISM_TOOL_TIMEOUT_MS: "100000000" }
  });
  assert.equal(codexManifest.mcpServers, "./.codex-mcp.json");
  assert.deepEqual(codexMcp.mcpServers["prism-review"], {
    // Windows cannot run a script by its #! line, so Codex starts the launcher through Node on every platform.
    command: "node",
    args: ["./bin/prism-mcp"],
    cwd: ".",
    env: { NODE_USE_ENV_PROXY: "1" },
    // Codex passes a plugin's MCP server only basic variables, so the app folder settings, the launch, and a migration run's scope must be forwarded by name.
    env_vars: ["PRISM_REVIEW_APP_DIR", "XDG_STATE_HOME", "LOCALAPPDATA", "PRISM_LAUNCH", "PRISM_MIGRATION_RUN", "PRISM_MIGRATION_PROJECT"]
  });
});

test("keeps the plugin MCP definition out of project MCP config", async () => {
  await assert.rejects(access(new URL("../../.mcp.json", import.meta.url)), { code: "ENOENT" });
});

test("describes frozen-contract design in both host manifests", async () => {
  const claudeManifest = await json(".claude-plugin/plugin.json");
  const codexManifest = await json(".codex-plugin/plugin.json");

  assert.match(claudeManifest.description, /frozen contract/);
  assert.match(codexManifest.description, /frozen contracts/);
  assert.doesNotMatch(`${claudeManifest.description} ${codexManifest.description}`, /design audit/i);
  assert.ok(codexManifest.interface.capabilities.includes("Frozen acceptance tests"));
  assert.ok(codexManifest.interface.defaultPrompt.some((prompt) => /failing acceptance tests/i.test(prompt)));
});

test("packages compatible capacity and trace hooks at the default plugin path", async () => {
  const hookManifest = await json("hooks/hooks.json");
  const traceBehaviorRegistry = await json("dist/server/session/session-trace-behavior-registry.json");
  const commands = (event) => hookManifest.hooks[event].flatMap((group) => group.hooks.map((hook) => hook.command));
  const factCommand = "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/record-session-facts.mjs\"";
  const traceCommand = "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/record-session-trace.mjs\"";

  assert.ok(commands("SessionStart").includes(factCommand));
  assert.ok(commands("UserPromptSubmit").includes(factCommand));
  assert.ok(commands("PreToolUse").includes(factCommand));
  assert.ok(commands("PreToolUse").indexOf(factCommand) < commands("PreToolUse").indexOf(traceCommand));
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const factHook = hookManifest.hooks[event]
      .flatMap((group) => group.hooks)
      .find((hook) => hook.command === factCommand);
    assert.equal(factHook.additionalContextLimit, 512);
  }
  for (const event of ["UserPromptSubmit", "SessionStart"]) {
    const answerHook = hookManifest.hooks[event].flatMap((group) => group.hooks).find((hook) => hook.command === "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/deliver-gate-answers.mjs\"");
    assert.deepEqual([answerHook.timeout, answerHook.additionalContextLimit], [5, 4000], event);
  }
  assert.deepEqual(hookManifest.hooks.Stop.flatMap((group) => group.hooks), [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/wait-for-gate-answers.mjs\"", statusMessage: "Prism: waiting for answers to open questions", timeout: 3600 }, { type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/keep-runs-to-a-result.mjs\"", statusMessage: "Prism: checking that the launched run has a result", timeout: 10 }]);
  // Each hook carries a short name of what it does, which Claude Code and Codex show instead of its command line.
  for (const hook of Object.values(hookManifest.hooks).flat().flatMap((group) => group.hooks)) assert.match(hook.statusMessage ?? "", /^Prism: [a-z]/, hook.command);
  for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "SubagentStart", "SubagentStop", "SessionEnd"]) {
    assert.ok(commands(event).includes(traceCommand));
  }
  // A launched Claude Code or Codex session that starts again in a terminal closes its unanswered no-result gate.
  const withdrawHook = hookManifest.hooks.SessionStart.flatMap((group) => group.hooks).find((hook) => hook.command === "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/withdraw-launch-questions.mjs\"");
  assert.deepEqual([withdrawHook?.timeout, withdrawHook?.additionalContextLimit], [5, undefined]);
  const offerHook = hookManifest.hooks.SessionStart.flatMap((group) => group.hooks).find((hook) => hook.command === "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/offer-prism.mjs\"");
  assert.deepEqual([offerHook.timeout, offerHook.additionalContextLimit], [5, 1500]);
  const roleCommand = "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/keep-orchestrator-role.mjs\"";
  for (const event of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
    assert.ok(commands(event).includes(roleCommand), event);
  }
  assert.deepEqual(hookManifest.hooks.PreToolUse.filter((group) => group.hooks.some((hook) => hook.command === roleCommand)).map((group) => group.matcher), ["Skill"]);
  // The host question tools of Claude Code and Codex are refused while the asking session has an unanswered Prism gate.
  const questionCommand = "node \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/keep-questions-in-gates.mjs\"";
  assert.deepEqual(hookManifest.hooks.PreToolUse.filter((group) => group.hooks.some((hook) => hook.command === questionCommand)).map((group) => group.matcher), ["^(AskUserQuestion|request_user_input)$"]);
  // Codex clamps a SessionEnd hook to 3 seconds and warns about any longer timeout.
  assert.deepEqual(hookManifest.hooks.SessionEnd.flatMap((group) => group.hooks).map((hook) => hook.timeout), [3, 3]);
  assert.equal(Object.hasOwn(hookManifest.hooks, "PostModelSwitch"), false);
  assert.equal(Object.hasOwn(hookManifest.hooks, "PostCompact"), false);
  assert.deepEqual(traceBehaviorRegistry.profiles.map((profile) => profile.match.harnessVersion), [
    "0.147.0",
    "0.163.0",
    "0.155.0-alpha.9.2"
  ]);
});
