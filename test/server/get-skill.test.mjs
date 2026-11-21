import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";

// Requirements: docs/requirements/acp-agents.md §2.
// Contract clause 24 of docs/plans/harness-client-protocol/slice.md: Prism's MCP server serves the text of its skills and their
// reference files, so an agent without the Prism plugin, and its child agents, can read every skill that a skill names.

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS = readdirSync(path.join(PLUGIN, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

async function mcp(context) {
  const child = spawn(process.execPath, [path.join(PLUGIN, "dist/server/mcp.mjs")], { cwd: PLUGIN, env: isolatedEnv(), stdio: ["pipe", "pipe", "ignore"] });
  context.after(() => child.kill());
  const waiting = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let next = 1;
  const request = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "get-skill-test", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const call = async (args) => (await request("tools/call", { name: "get_skill", arguments: args })).result;
  return { request, call };
}

const answer = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);

test("clause 24: the server lists get_skill with a name and an optional path", async (t) => {
  const { request } = await mcp(t);
  const tool = (await request("tools/list", {})).result.tools.find((item) => item.name === "get_skill");
  assert.ok(tool, "get_skill is listed");
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["name", "path"]);
  assert.deepEqual(tool.inputSchema.required, ["name"]);
});

test("clause 24: a skill name, with or without the prism: prefix, answers the skill's SKILL.md text", async (t) => {
  const { call } = await mcp(t);
  const plain = await call({ name: "design" });
  assert.notEqual(plain.isError, true);
  assert.deepEqual(answer(plain), { name: "design", path: "SKILL.md", text: readFileSync(path.join(PLUGIN, "skills/design/SKILL.md"), "utf8") });
  assert.deepEqual(answer(await call({ name: "prism:orchestrate" })).text, readFileSync(path.join(PLUGIN, "skills/orchestrate/SKILL.md"), "utf8"));
});

test("clause 24: a path relative to the skill's folder answers that reference file", async (t) => {
  const { call } = await mcp(t);
  const result = answer(await call({ name: "workflow", path: "references/delegation.md" }));
  assert.deepEqual(result, { name: "workflow", path: "references/delegation.md", text: readFileSync(path.join(PLUGIN, "skills/workflow/references/delegation.md"), "utf8") });
});

test("clause 24: an unknown skill is refused with the list of skill names", async (t) => {
  const { call } = await mcp(t);
  const result = await call({ name: "deploy" });
  assert.equal(result.isError, true);
  const text = result.content.map((part) => part.text).join(" ");
  for (const name of SKILLS) assert.match(text, new RegExp(`\\b${name}\\b`), `the refusal names ${name}`);
});

test("clause 24: an absolute path, a path with .., and a missing file are refused", async (t) => {
  const { call } = await mcp(t);
  for (const bad of ["/etc/hosts", "../design/SKILL.md", "references/../../design/SKILL.md", "references/missing.md"]) {
    const result = await call({ name: "workflow", path: bad });
    assert.equal(result.isError, true, bad);
    assert.doesNotMatch(result.content.map((part) => part.text).join(" "), /root:|# Design/, `${bad} reads nothing outside the skill folder`);
  }
});
