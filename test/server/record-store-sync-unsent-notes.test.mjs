import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
import { notes, prismServer, repository } from "./fixtures/repository-checkouts.mjs";

// A saved version is named by the next tool result that a server writes to its host, so a result that is never written, as for a cancelled call or a wait the session's end aborts,
// neither marks it named nor clears its pending notice.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-unsent-notes-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment,
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(() => rm(environment, { recursive: true, force: true }));
const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const NO_NATIVE_ASSETS = fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const exists = (target) => access(target).then(() => true, () => false);

async function eventually(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`${label} did not hold within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// A Prism server that a Claude Code host started, so wait_for_user_gate waits until it is answered or cancelled.
function waitingServer(context, root, app) {
  const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: NO_NATIVE_ASSETS, PRISM_REVIEW_APP_DIR: app, CLAUDE_PROJECT_DIR: root, PRISM_GATE_WAIT_HEARTBEAT_MS: "200" });
  for (const name of ["MCP_TOOL_TIMEOUT", "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]) delete env[name];
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    await exited;
    clearTimeout(timer);
  };
  context.after(close);
  let next = 1;
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method, params) => { const id = next++; send({ id, method, params }); return id; };
  const response = (id) => eventually(() => messages.find((message) => message.id === id), 20000, `the response to request ${id}`);
  const call = (name, args = {}) => response(request("tools/call", { name, arguments: { projectRoot: root, ...args } }));
  return { root, messages, send, request, response, call, close };
}

// A checkout whose synced store a waiting server uses, a gate to wait on, and a record version that a sync of a stopped server saved, still pending, once the store is in use.
async function savedDuringWait(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-unsent-notes-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  git(parent, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(parent, "clone", "-q", "remote.git", "store");
  const store = path.join(parent, "store");
  git(store, "checkout", "-q", "-b", "main");
  await writeFile(path.join(store, "README.md"), "Prism records\n");
  git(store, "add", ".");
  git(store, "commit", "-q", "-m", "init");
  git(store, "push", "-q", "-u", "origin", "main");
  const root = await repository(parent, "api", { remote: "https://github.com/acme/api.git", store: "../store", repository: "api", sync: "on" });
  const app = path.join(parent, "app");
  const prism = waitingServer(context, root, app);
  await prism.response(prism.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.296" } }));
  const asked = await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "correctness", question: "Is it correct?", artifacts: [] }] } });
  assert.equal(asked.result?.isError, undefined, JSON.stringify(asked));
  const gateId = asked.result.structuredContent.openedGates[0].id;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const savedAs = path.join(store, ".prism-sync", "conflicts", stamp, "roadmap.json");
  const notice = path.join(store, ".prism-sync", "notices", stamp);
  await mkdir(path.dirname(savedAs), { recursive: true });
  await writeFile(savedAs, "{}\n");
  await mkdir(path.dirname(notice), { recursive: true });
  await writeFile(notice, "{}\n");
  const wait = prism.request("tools/call", { name: "wait_for_user_gate", arguments: { projectRoot: root, initiative: "reports", gateIds: [gateId] } });
  await new Promise((resolve) => setTimeout(resolve, 800));
  return { parent, root, app, prism, wait, savedAs, notice };
}

test("a cancelled wait is never written, so it leaves the saved version pending and the server's next result names it", async (context) => {
  const { prism, wait, savedAs, notice } = await savedDuringWait(context);
  prism.send({ method: "notifications/cancelled", params: { requestId: wait, reason: "user pressed Esc" } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(prism.messages.some((message) => message.id === wait), false, "a cancelled request gets no response");
  assert.equal(await exists(notice), true, "the cancelled result cleared no pending notice");
  const named = notes(await prism.call("get_roadmap"));
  assert.ok(named.includes(".prism/roadmap.json") && named.includes(savedAs), named);
  await eventually(async () => !(await exists(notice)), 5000, "the written result clearing the notice it carried");
  assert.equal(notes(await prism.call("get_roadmap")).includes(savedAs), false, "the saved version is named once");
  await prism.close();
});

test("a wait that the session's end aborts is never written, so the next server names the saved version", async (context) => {
  const { root, app, prism, wait, savedAs, notice } = await savedDuringWait(context);
  await prism.close();
  assert.equal(prism.messages.some((message) => message.id === wait), false, "the aborted wait gets no response");
  assert.equal(await exists(notice), true, "the session's end cleared no pending notice");
  const later = await prismServer(context, root, { appFolder: app });
  const named = notes(await later.call("get_roadmap", {}));
  assert.ok(named.includes(savedAs), named);
  await eventually(async () => !(await exists(notice)), 5000, "the written result clearing the notice it carried");
  assert.deepEqual(await readdir(path.dirname(notice)), []);
  await later.close();
});

test("any call that the host cancels before its result is written gets no response and leaves the saved version pending for the next result", async (context) => {
  const { prism, wait, savedAs, notice } = await savedDuringWait(context);
  for (const name of ["get_roadmap", "list_reviewable_artifacts"]) {
    const cancelled = prism.request("tools/call", { name, arguments: { projectRoot: prism.root } });
    prism.send({ method: "notifications/cancelled", params: { requestId: cancelled, reason: "user pressed Esc" } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(prism.messages.some((message) => message.id === cancelled), false, `a cancelled ${name} gets no response`);
    assert.equal(await exists(notice), true, `the cancelled ${name} cleared no pending notice`);
  }
  const named = notes(await prism.call("get_roadmap"));
  assert.ok(named.includes(savedAs), named);
  await eventually(async () => !(await exists(notice)), 5000, "the written result clearing the notice it carried");
  // A cancel that arrives after a result was written changes nothing for the next call.
  const answered = prism.request("tools/call", { name: "get_roadmap", arguments: { projectRoot: prism.root } });
  await prism.response(answered);
  prism.send({ method: "notifications/cancelled", params: { requestId: answered } });
  assert.equal(notes(await prism.call("get_roadmap")).includes(savedAs), false, "the saved version is named once");
  prism.send({ method: "notifications/cancelled", params: { requestId: wait } });
  await prism.close();
});
