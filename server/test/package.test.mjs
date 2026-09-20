import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function json(relativePath) {
  return JSON.parse(await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8"));
}

test("uses host-specific portable MCP launch paths", async () => {
  const claudeManifest = await json(".claude-plugin/plugin.json");
  const claudeMcp = await json(".mcp.json");
  const codexManifest = await json(".codex-plugin/plugin.json");
  const codexMcp = await json(".codex-mcp.json");

  assert.equal(claudeManifest.mcpServers, "./.mcp.json");
  assert.deepEqual(claudeMcp.mcpServers["prism-review"], {
    command: "node",
    args: ["${CLAUDE_PLUGIN_ROOT}/server/mcp.mjs"]
  });
  assert.equal(codexManifest.mcpServers, "./.codex-mcp.json");
  assert.deepEqual(codexMcp.mcpServers["prism-review"], {
    command: "./bin/prism-mcp",
    cwd: "."
  });
});

test("describes the shared design audit in both host manifests", async () => {
  const claudeManifest = await json(".claude-plugin/plugin.json");
  const codexManifest = await json(".codex-plugin/plugin.json");

  assert.match(claudeManifest.description, /design audits/);
  assert.match(codexManifest.description, /design audits/);
  assert.ok(codexManifest.interface.capabilities.includes("Design audits"));
  assert.ok(codexManifest.interface.defaultPrompt.some((prompt) => /audit the design before implementation/i.test(prompt)));
});

test("packages compatible capacity and trace hooks at the default plugin path", async () => {
  const hookManifest = await json("hooks/hooks.json");
  const traceBehaviorRegistry = await json("server/session-trace-behavior-registry.json");
  const commands = (event) => hookManifest.hooks[event].flatMap((group) => group.hooks.map((hook) => hook.command));
  const factCommand = "node \"${CLAUDE_PLUGIN_ROOT}/hooks/record-session-facts.mjs\"";
  const traceCommand = "node \"${CLAUDE_PLUGIN_ROOT}/hooks/record-session-trace.mjs\"";

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
  for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "PreCompact", "SessionEnd"]) {
    assert.ok(commands(event).includes(traceCommand));
  }
  assert.equal(Object.hasOwn(hookManifest.hooks, "PostToolUseFailure"), false);
  assert.equal(Object.hasOwn(hookManifest.hooks, "PostModelSwitch"), false);
  assert.equal(Object.hasOwn(hookManifest.hooks, "PostCompact"), false);
  assert.deepEqual(traceBehaviorRegistry.profiles.map((profile) => profile.match.harnessVersion), [
    "0.147.0",
    "0.155.0-alpha.9.2"
  ]);
});
