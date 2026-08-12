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
