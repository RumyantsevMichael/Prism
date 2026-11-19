import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { INITIATIVE, actionProject } from "./fixtures/review-actions.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/launch-run-configuration.md §10.
// The coordinator reads, through get_coordination_state, the model and effort that each kind of child agent takes on the host it
// runs on, and the orchestrate skill says which child agents are which kind and how each host takes the choice.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const KINDS = ["designImplementation", "codeReview", "securityReview", "gateSummary"];
const NONE = Object.fromEntries(KINDS.map((kind) => [kind, { model: null, effort: null }]));

const writeSettings = async (root, settings) => {
  const { readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const read = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  return updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: read.exists ? read.revision : null, changes: { settings } });
};

/** get_coordination_state from a Prism MCP server that a client of the given name started. */
async function coordinationState(t, root, clientName) {
  const env = { ...process.env, PRISM_REVIEW_APP: "off", PRISM_REVIEW_BROWSER_ON_START: "off" };
  delete env.CLAUDE_PROJECT_DIR;
  const child = spawn(process.execPath, [path.join(ROOT, "dist/server/mcp.mjs")], { stdio: ["pipe", "pipe", "ignore"], env });
  t.after(() => child.kill());
  let buffer = "";
  const answers = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) answers.push(JSON.parse(line));
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } } });
  await settled(() => answers.find((item) => item.id === 1));
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/call", params: { name: "get_coordination_state", arguments: { projectRoot: root, initiative: INITIATIVE } } });
  const answer = await settled(() => answers.find((item) => item.id === 2), (value) => value !== undefined, { timeout: 15000 });
  assert.ok(answer?.result, `the tool answered: ${JSON.stringify(answer)}`);
  assert.notEqual(answer.result.isError, true, JSON.stringify(answer.result));
  return answer.result.structuredContent ?? JSON.parse(answer.result.content[0].text);
}

test("clause 1: get_coordination_state names the client's host and the model and effort of each kind of child agent for it", async (t) => {
  const { root } = await actionProject(t);
  await writeSettings(root, { models: {
    "claude-code": { coordinator: { model: "fable", effort: "high" }, codeReview: { model: "opus", effort: "max" }, gateSummary: { model: "haiku" } },
    codex: { provider: "openai", designImplementation: { model: "gpt-5.5", effort: "xhigh" } }
  } });
  const claude = await coordinationState(t, root, "claude-code");
  assert.deepEqual(claude.childAgents, {
    host: "claude-code",
    kinds: { ...NONE, codeReview: { model: "opus", effort: "max" }, gateSummary: { model: "haiku", effort: null } }
  }, "the coordinator's own choice is no child agent's");
  const codex = await coordinationState(t, root, "codex-mcp-client");
  assert.deepEqual(codex.childAgents, { host: "codex", kinds: { ...NONE, designImplementation: { model: "gpt-5.5", effort: "xhigh" } } });
});

test("clause 2: a client that is no host Prism supports gets host defaults for every kind", async (t) => {
  const { root } = await actionProject(t);
  await writeSettings(root, { models: { "claude-code": { codeReview: { model: "opus", effort: "max" } } } });
  const other = await coordinationState(t, root, "some-other-client");
  assert.deepEqual(other.childAgents, { host: null, kinds: NONE });
});

test("clause 3: an initiative without model choices, and one with the old models setting, read as host defaults and the old names", async (t) => {
  const { root } = await actionProject(t);
  assert.deepEqual((await coordinationState(t, root, "claude-code")).childAgents, { host: "claude-code", kinds: NONE });
  await writeSettings(root, { models: { delivery: "sonnet", review: "opus", securityReview: "opus", examples: "haiku" } });
  assert.deepEqual((await coordinationState(t, root, "claude-code")).childAgents.kinds, {
    designImplementation: { model: "sonnet", effort: null },
    codeReview: { model: "opus", effort: null },
    securityReview: { model: "opus", effort: null },
    gateSummary: { model: "haiku", effort: null }
  }, "the old names read as typed choices of every host");
});

test("clause 4: the orchestrate skill says which child agents take which kind's model and effort, and how each host takes them", async () => {
  const skill = await readFile(path.join(ROOT, "skills/orchestrate/SKILL.md"), "utf8");
  assert.match(skill, /childAgents/, "the skill reads the choices from the coordination state");
  const lineWith = (...words) => skill.split("\n").find((line) => words.every((word) => line.includes(word)));
  assert.ok(lineWith("`designImplementation`", "`design`", "`implement`"), "design and implementation agents take designImplementation");
  assert.ok(lineWith("`codeReview`", "`review`"), "review lanes take codeReview");
  assert.ok(lineWith("`securityReview`", "security"), "the security lane takes securityReview");
  assert.ok(lineWith("`gateSummary`", "example writer"), "the example writer takes gateSummary");
  assert.doesNotMatch(skill, /`examples` model|\{delivery, review, securityReview, examples\}/, "the old models setting is gone from the skill");
  assert.match(skill, /`null`[^\n]*host default|host default[^\n]*`null`/i, "a null choice leaves the host's default");
  const row = skill.split("\n").find((line) => line.startsWith("| `models` |"));
  assert.ok(row, "the settings table keeps a models row");
  assert.match(row, /coordinator/i);
  assert.match(row, /host/i);
});

test("clause 5: the workflow's common terms define the run configuration and keep the example writer's kind", async () => {
  const workflow = await readFile(path.join(ROOT, "skills/workflow/SKILL.md"), "utf8");
  assert.match(workflow, /^\| Run configuration \| /m);
  const writer = workflow.split("\n").find((line) => line.startsWith("| Example writer |"));
  assert.ok(writer, "the example writer stays a common term");
  assert.doesNotMatch(writer, /`examples` model/);
});
