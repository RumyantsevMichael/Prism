import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { answerUserGate, readCoordinationState, updateCoordinationState } from "../../dist/server/workflow/state.mjs";

const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const INITIATIVE = "reports";

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-gate-wait-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans (scratch): docs/plans/\n");
  await mkdir(path.join(root, "docs/plans/reports"), { recursive: true });
  const created = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, changes: { gateOperations: [
    { op: "ask", kind: "decision", question: "Fresh login or active session?", artifacts: [], options: [{ id: "fresh-login", label: "Require a fresh login" }] },
    { op: "ask", kind: "visual-review", question: "Review the design.", artifacts: [] },
    { op: "ask", kind: "correctness", question: "Is it correct?", artifacts: [] }
  ] } });
  return { root, gateId: created.openedGates[0].id, gateIds: created.openedGates.map((gate) => gate.id) };
}

function server(context, root, clientName, { version = "2.1.296", environment = {} } = {}) {
  const env = { ...process.env, PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)), PRISM_GATE_WAIT_HEARTBEAT_MS: "200", PRISM_GATE_WAIT_SETTLE_MS: "600", CLAUDE_PROJECT_DIR: root };
  for (const name of ["MCP_TOOL_TIMEOUT", "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]) delete env[name];
  Object.assign(env, environment);
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const listeners = new Set();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    for (const listener of listeners) listener();
  });
  context.after(async () => {
    if (child.exitCode === null) {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const response = (id, timeout = 10000) => new Promise((resolve, reject) => {
    const check = () => {
      const found = messages.find((message) => message.id === id);
      if (found) {
        listeners.delete(check);
        clearTimeout(timer);
        resolve(found);
      }
    };
    const timer = setTimeout(() => {
      listeners.delete(check);
      reject(new Error(`No response to request ${id}`));
    }, timeout);
    listeners.add(check);
    check();
  });
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version } } });
  return { send, response, messages, ready: response(1) };
}

function wait(mcp, id, root, gateId, extra = {}, meta = { progressToken: `wait-${id}` }) {
  mcp.send({ id, method: "tools/call", params: { name: "wait_for_user_gate", arguments: { projectRoot: root, initiative: INITIATIVE, gateId, ...extra }, _meta: meta } });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("returns the browser answer and sends progress while it waits", async (context) => {
  const { root, gateId } = await project(context);
  const mcp = server(context, root, "claude-code");
  await mcp.ready;
  wait(mcp, 2, root, gateId);
  await delay(700);
  assert.ok(mcp.messages.filter((message) => message.method === "notifications/progress" && message.params.progressToken === "wait-2").length >= 2);
  assert.equal(mcp.messages.some((message) => message.id === 2), false);
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: gateId, choice: "fresh-login", note: "Downloads are sensitive." });
  const answered = await mcp.response(2);
  assert.equal(answered.result.structuredContent.status, "answered");
  assert.equal(answered.result.structuredContent.answered[0].answer.choice, "fresh-login");
  assert.match(answered.result.content[0].text, /Answer: Require a fresh login\. Note: Downloads are sensitive\./);
});

test("ends when the gate is resolved, missing, timed out, or cancelled", async (context) => {
  const { root, gateId } = await project(context);
  const mcp = server(context, root, "claude-code");
  await mcp.ready;
  wait(mcp, 2, root, "gate-000000000000");
  assert.equal((await mcp.response(2)).result.structuredContent.status, "unknown_gate");
  wait(mcp, 3, root, gateId, { maxWaitMinutes: 0.005 });
  assert.equal((await mcp.response(3)).result.structuredContent.status, "timeout");
  wait(mcp, 4, root, gateId, {}, undefined);
  await delay(300);
  mcp.send({ method: "notifications/cancelled", params: { requestId: 4, reason: "user pressed Esc" } });
  wait(mcp, 5, root, gateId);
  await delay(300);
  const { revision } = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: revision, changes: { gateOperations: [{ op: "resolve", id: gateId }] } });
  assert.equal((await mcp.response(5)).result.structuredContent.status, "resolved");
  await delay(1200);
  assert.equal(mcp.messages.some((message) => message.id === 4), false);
});

test("returns at once on hosts that cannot wait in the background", async (context) => {
  const { root, gateId } = await project(context);
  const mcp = server(context, root, "codex-mcp-client");
  await mcp.ready;
  wait(mcp, 2, root, gateId);
  const response = await mcp.response(2, 3000);
  assert.deepEqual([response.result.structuredContent.status, response.result.structuredContent.client], ["unsupported_host", "codex-mcp-client"]);
});

test("returns at once when the host would cancel the wait before backgrounding it", async (context) => {
  const { root, gateId } = await project(context);
  for (const [options, reason] of [
    [{ environment: { MCP_TOOL_TIMEOUT: "60000" } }, /MCP_TOOL_TIMEOUT \(60000 ms\) ends the call before Claude Code moves it to the background \(120000 ms\)/],
    [{ environment: { MCP_TOOL_TIMEOUT: "60000", CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "30000" } }, null],
    [{ environment: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } }, /disabled/],
    [{ version: "2.1.100" }, /predates background tool calls/]
  ]) {
    const mcp = server(context, root, "claude-code", options);
    await mcp.ready;
    wait(mcp, 2, root, gateId, reason ? {} : { maxWaitMinutes: 0.005 });
    const response = await mcp.response(2, 5000);
    if (reason) {
      assert.equal(response.result.structuredContent.status, "unsupported_host", JSON.stringify(options));
      assert.match(response.result.structuredContent.reason, reason);
    } else {
      assert.equal(response.result.structuredContent.status, "timeout", JSON.stringify(options));
    }
  }
});

test("waits on several gates and collects answers given in one visit", async (context) => {
  const { root, gateIds } = await project(context);
  const mcp = server(context, root, "claude-code");
  await mcp.ready;
  mcp.send({ id: 2, method: "tools/call", params: { name: "wait_for_user_gate", arguments: { projectRoot: root, initiative: INITIATIVE, gateIds } } });
  await delay(300);
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: gateIds[0], choice: "fresh-login" });
  await delay(200);
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: gateIds[1], choice: "approve" });
  const response = await mcp.response(2);
  const value = response.result.structuredContent;
  assert.equal(value.status, "answered");
  assert.deepEqual(value.answered.map((gate) => gate.id), gateIds.slice(0, 2));
  assert.deepEqual(value.waiting, [gateIds[2]]);
  assert.match(response.result.content[0].text, new RegExp(`Still waiting on: ${gateIds[2]}\\.`));
  mcp.send({ id: 3, method: "tools/call", params: { name: "wait_for_user_gate", arguments: { projectRoot: root, initiative: INITIATIVE } } });
  assert.match((await mcp.response(3)).error.message, /Pass the recorded gate ids in gateIds/);
});
