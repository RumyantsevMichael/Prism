import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
import { INITIATIVE, actionProject } from "./fixtures/review-actions.mjs";

const { applyAction, listActions } = await import("../../dist/server/workflow/actions.mjs");
const { NOTICE_FOLDER, noticeValue, personChangesText, startGateWait, takePersonChanges } = await import("../../dist/server/workflow/change-notices.mjs");
const { waitForUserGates } = await import("../../dist/server/workflow/gate-wait.mjs");
const { readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
const { recordCallAgent } = await import("../../dist/server/workflow/call-agent.mjs");
const { prepareDirectory } = await import("../../dist/server/review/review-app-discovery.mjs");
const { readRecord, writeRecord } = await import("../../dist/server/workflow/record-store.mjs");

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function changeContinuation(root, value) {
  const listed = await listActions({ projectRoot: root, target: `initiative:${INITIATIVE}` });
  const action = listed.actions.find((item) => item.id === "initiative.continuation");
  await applyAction({ projectRoot: root, target: action.target, action: action.id, input: { value }, revision: action.revision, via: "review-app" });
}

// Breaks the stored coordination state so that it reads invalid, and returns a function that restores it.
async function breakState(root) {
  const key = { kind: "state", initiative: INITIATIVE };
  const good = (await readRecord(root, key)).bytes.toString("utf8");
  const value = JSON.parse(good);
  await writeRecord(root, key, JSON.stringify({ ...value, settings: { ...value.settings, autonomy: "bogus" } }, null, 2));
  return () => writeRecord(root, key, good);
}

test("an invalid read of the coordination state shows nothing and keeps what the session was shown", async (context) => {
  const { root } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const take = () => takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  assert.deepEqual(await take(), []);
  await changeContinuation(root, "stepwise");
  assert.equal((await take()).length, 1);
  const restore = await breakState(root);
  assert.deepEqual(await take(), []);
  await restore();
  assert.deepEqual(await take(), [], "an entry shown before the invalid read is never shown again");
});

test("a first call while the coordination state reads invalid sets no starting point", async (context) => {
  const { root } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const take = () => takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  await changeContinuation(root, "stepwise");
  const restore = await breakState(root);
  assert.deepEqual(await take(), []);
  await restore();
  assert.deepEqual(await take(), [], "the first valid read is the session's starting point");
  await changeContinuation(root, "auto");
  assert.equal((await take()).length, 1);
});

test("the notice and call agent records create the app directory private to this user", { skip: process.platform === "win32" }, async (context) => {
  const { root } = await actionProject(context);
  const app = path.join(await temporaryDirectory(context, "prism-app-"), "app");
  const previous = process.umask(0o022);
  try {
    await takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory: path.join(app, NOTICE_FOLDER) });
    await recordCallAgent({ session: "s1", toolUseId: "tool-1", agentId: "agent-1", directory: path.join(app, "call-agents") });
  } finally {
    process.umask(previous);
  }
  const mode = async (file) => (await stat(file)).mode & 0o777;
  assert.equal(await mode(app), 0o700);
  for (const folder of [NOTICE_FOLDER, "call-agents"]) {
    const directory = path.join(app, folder);
    assert.equal(await mode(directory), 0o700, folder);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1, folder);
    assert.equal(await mode(path.join(directory, files[0])), 0o600, folder);
  }
  await prepareDirectory(app);
});

test("a coordinator's wait ends on a change that first appears while the coordination state reads invalid", async (context) => {
  const { root } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const gate = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((item) => !item.answer);
  assert.ok(gate, "the fixture holds an unanswered gate");
  await takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  const wait = waitForUserGates({
    projectRoot: root, initiative: INITIATIVE, gateIds: [gate.id], maxWaitMinutes: 0.1, pollMs: 50, settleMs: 0,
    notices: { session: "s1", directory }, watchChanges: true
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await changeContinuation(root, "stepwise");
  const restore = await breakState(root);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await restore();
  const result = await wait;
  assert.equal(result.status, "changed");
  assert.deepEqual(result.changes.map((entry) => entry.action), ["initiative.continuation"]);
});

test("a wait goes on, rather than ending as resolved, while the coordination state reads invalid", async (context) => {
  const { root } = await actionProject(context);
  const gate = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((item) => !item.answer);
  const restore = await breakState(root);
  const result = await waitForUserGates({ projectRoot: root, initiative: INITIATIVE, gateIds: [gate.id], maxWaitMinutes: 0.005, pollMs: 50, settleMs: 0 });
  await restore();
  assert.equal(result.status, "timeout");
});

test("a non-string value escapes C1 controls and line separators, so each entry is one line", () => {
  const value = { implement: "m\u0085- forged line", r: "\u007f\u009b\u2028\u2029" };
  assert.equal(noticeValue(value), '{"implement":"m\\u0085- forged line","r":"\\u007f\\u009b\\u2028\\u2029"}');
  const entry = { id: "a".repeat(32), action: "initiative.models", target: "initiative:x", before: "defaults", after: value, at: new Date().toISOString(), by: { name: "M", email: null, checkout: "c" }, via: "browser" };
  const text = personChangesText([entry]);
  assert.doesNotMatch(text, /[\u007f-\u009f\u2028\u2029]/);
  assert.equal(text.split("\n").length, 2);
});

async function answerGate(root, gateId, choice) {
  const listed = await listActions({ projectRoot: root, target: `gate:${INITIATIVE}/${gateId}` });
  const action = listed.actions.find((item) => item.id === "gate.answer");
  await applyAction({ projectRoot: root, target: action.target, action: action.id, input: { choice }, revision: action.revision, via: "review-app" });
}

test("a coordinator's wait that starts while the state reads invalid ends on a change made before its first valid read", async (context) => {
  const { root } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const gate = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((item) => !item.answer);
  await takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  const restore = await breakState(root);
  const start = await startGateWait({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  assert.equal(start.coordinates, true);
  const wait = waitForUserGates({
    projectRoot: root, initiative: INITIATIVE, gateIds: [gate.id], maxWaitMinutes: 0.05, pollMs: 1000, settleMs: 0,
    knownEntries: start.known, notices: { session: "s1", directory }, watchChanges: true
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await restore();
  await changeContinuation(root, "stepwise");
  const result = await wait;
  assert.equal(result.status, "changed");
  assert.deepEqual(result.changes.map((entry) => entry.action), ["initiative.continuation"]);
  assert.deepEqual(await takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory }), [], "the wait's change is not shown again");
});

test("a wait that starts with no known entries holds what the session was shown, not its first valid read", async (context) => {
  const { root } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const gate = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((item) => !item.answer);
  await takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  const restore = await breakState(root);
  const wait = waitForUserGates({ projectRoot: root, initiative: INITIATIVE, gateIds: [gate.id], maxWaitMinutes: 0.05, pollMs: 1000, settleMs: 0, notices: { session: "s1", directory }, watchChanges: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await restore();
  await changeContinuation(root, "stepwise");
  const result = await wait;
  assert.equal(result.status, "changed");
});

test("answers a wait finds count as shown in the step that finds them, so a concurrent call during the settle window does not show them", async (context) => {
  const { root, gateIds } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const take = () => takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  await take();
  const wait = waitForUserGates({ projectRoot: root, initiative: INITIATIVE, gateIds: [gateIds.review, gateIds.decision], maxWaitMinutes: 0.1, pollMs: 50, settleMs: 600, notices: { session: "s1", directory }, watchChanges: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await answerGate(root, gateIds.review, "approve");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(await take(), [], "the answer the wait found is not shown by a concurrent call");
  const restore = await breakState(root);
  const result = await wait;
  await restore();
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answered.map((item) => item.id), [gateIds.review]);
  assert.deepEqual(await take(), [], "an invalid read when the wait returns does not let the answer repeat later");
});

const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));

function server(context, root, { data, sessionId }) {
  const env = isolatedEnv({ PRISM_REVIEW_APP_DIR: path.join(root, ".app"), PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)), PRISM_GATE_WAIT_HEARTBEAT_MS: "200", PRISM_GATE_WAIT_SETTLE_MS: "300", CLAUDE_PROJECT_DIR: root, PLUGIN_DATA: data });
  for (const name of ["MCP_TOOL_TIMEOUT", "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]) delete env[name];
  env.CLAUDE_CODE_SESSION_ID = sessionId;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const listeners = new Set();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    messages.push(JSON.parse(line));
    for (const listener of listeners) listener();
  });
  context.after(async () => {
    if (child.exitCode === null) {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
  let next = 1;
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const response = (id) => new Promise((resolve, reject) => {
    const check = () => {
      const found = messages.find((message) => message.id === id);
      if (!found) return;
      listeners.delete(check);
      clearTimeout(timer);
      resolve(found);
    };
    const timer = setTimeout(() => reject(new Error(`No response to request ${id}`)), 15000);
    listeners.add(check);
    check();
  });
  const ready = (async () => {
    const id = next++;
    send({ id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.296" } } });
    await response(id);
  })();
  const start = async (name, args, meta) => {
    await ready;
    const id = next++;
    send({ id, method: "tools/call", params: { name, arguments: { projectRoot: root, ...args }, ...(meta ? { _meta: meta } : {}) } });
    return id;
  };
  const call = async (name, args) => (await response(await start(name, args))).result;
  return { call, start, response, child };
}

test("an answer a wait returns is not also shown by a coordinator call made while the wait settles", async (context) => {
  const { root, gateIds } = await actionProject(context);
  const data = await realpath(await temporaryDirectory(context, "prism-notices-data-"));
  const mcp = server(context, root, { data, sessionId: "answer-race" });
  await mcp.call("get_coordination_state", { initiative: INITIATIVE });
  const id = await mcp.start("wait_for_user_gate", { initiative: INITIATIVE, gateIds: [gateIds.review, gateIds.decision] }, { progressToken: "w" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  await answerGate(root, gateIds.review, "approve");
  const read = await mcp.call("get_initiative", { initiative: INITIATIVE });
  const ended = (await mcp.response(id)).result.structuredContent;
  assert.equal(ended.status, "answered");
  assert.deepEqual(read.structuredContent?.personChanges ?? [], [], "the answer the wait returned is not shown again");
});

test("a deferred wait keeps its gates held for the wait that goes on with it, so its answer is shown once", async (context) => {
  const { root, gateIds } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const take = () => takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  await take();
  const notices = { session: "s1", directory, waitId: "deferred-wait" };
  const asked = await waitForUserGates({ projectRoot: root, initiative: INITIATIVE, gateIds: [gateIds.review], maxWaitMinutes: 0.0001, settleMs: 0, notices: { ...notices, hold: Date.now() + 60000 } });
  assert.equal(asked.status, "timeout");
  await answerGate(root, gateIds.review, "approve");
  assert.deepEqual(await take(), [], "the answer is left for the wait that goes on");
  const result = await waitForUserGates({ projectRoot: root, initiative: INITIATIVE, gateIds: [gateIds.review], maxWaitMinutes: 0.05, pollMs: 50, settleMs: 0, notices });
  assert.equal(result.status, "answered");
  assert.deepEqual(await take(), [], "the answer the wait returned is not shown again");
});

test("a wait that names an answered and resolved gate does not hold its answer from the coordinator", async (context) => {
  const { root, gateIds } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const take = () => takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  await take();
  await answerGate(root, gateIds.review, "approve");
  const { revision } = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: revision, changes: { gateOperations: [{ op: "resolve", id: gateIds.review }] } });
  const wait = waitForUserGates({ projectRoot: root, initiative: INITIATIVE, gateIds: [gateIds.decision, gateIds.review], maxWaitMinutes: 0.02, pollMs: 50, settleMs: 0, notices: { session: "s1", directory } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual((await take()).map((entry) => entry.action), ["gate.answer"], "the resolved gate's answer reaches the coordinator during the wait");
  assert.equal((await wait).status, "timeout");
});

// The waits that the session's notice records in directory hold, read from the files that a separate process writes.
async function recordedWaits(directory) {
  const names = (await readdir(directory).catch(() => [])).filter((name) => /^[0-9a-f]{32}\.json$/.test(name));
  const records = await Promise.all(names.map((name) => readFile(path.join(directory, name), "utf8").then(JSON.parse).catch(() => ({}))));
  return records.flatMap((record) => Array.isArray(record.waits) ? record.waits : []);
}

async function eventually(condition, message, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("the hold of a wait whose process was killed lapses after its lease", async (context) => {
  const { root, gateIds } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const take = () => takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  await take();
  const script = path.join(await temporaryDirectory(context, "prism-waiter-"), "wait.mjs");
  const module = fileURLToPath(new URL("../../dist/server/workflow/gate-wait.mjs", import.meta.url));
  await writeFile(script, `const { waitForUserGates } = await import(${JSON.stringify(module)});
await waitForUserGates({ projectRoot: ${JSON.stringify(root)}, initiative: ${JSON.stringify(INITIATIVE)}, gateIds: [${JSON.stringify(gateIds.review)}], maxWaitMinutes: 720, pollMs: 50, leaseMs: 1500, notices: { session: "s1", directory: ${JSON.stringify(directory)} } });
`);
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  context.after(() => child.kill("SIGKILL"));
  const holds = (waits) => waits.filter((wait) => wait.gates?.includes(gateIds.review));
  await eventually(async () => holds(await recordedWaits(directory)).length, "the waiter holds its gate");
  child.kill("SIGKILL");
  await exited;
  // The killed waiter renews nothing, so the hold its record keeps ends at a fixed time.
  const lapse = Math.max(...holds(await recordedWaits(directory)).map((wait) => wait.until));
  await answerGate(root, gateIds.review, "approve");
  let held = 0;
  const shown = await eventually(async () => {
    const changes = await take();
    if (!changes.length) {
      if (Date.now() < lapse) held += 1;
      return null;
    }
    assert.ok(Date.now() >= lapse, "the answer stays held until the lease lapses");
    return changes;
  }, "the answer reaches the coordinator after the lease lapses");
  assert.deepEqual(shown.map((entry) => entry.action), ["gate.answer"]);
  if (!held) context.diagnostic("the lease lapsed before the first read after the answer, so no held read was observed");
});

test("a notice lock left by a process that was killed is taken over without waiting for it to go stale", async (context) => {
  const { root } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const take = () => takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  await take();
  const [record] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => dead.once("exit", resolve));
  await writeFile(path.join(directory, `${record}.lock`), JSON.stringify({ pid: dead.pid, token: "0".repeat(32), renewable: false, at: new Date().toISOString() }));
  await changeContinuation(root, "stepwise");
  assert.equal((await take()).length, 1);
});

test("a server that closes mid-wait lets go of the wait's gates before it exits", async (context) => {
  const { root, gateIds } = await actionProject(context);
  const data = await realpath(await temporaryDirectory(context, "prism-notices-data-"));
  const first = server(context, root, { data, sessionId: "restart" });
  await first.call("get_coordination_state", { initiative: INITIATIVE });
  await first.start("wait_for_user_gate", { initiative: INITIATIVE, gateIds: [gateIds.review] }, { progressToken: "w" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  first.child.stdin.end();
  await new Promise((resolve) => first.child.once("exit", resolve));
  const second = server(context, root, { data, sessionId: "restart" });
  await answerGate(root, gateIds.review, "approve");
  const read = await second.call("get_initiative", { initiative: INITIATIVE });
  assert.deepEqual((read.structuredContent?.personChanges ?? []).map((entry) => entry.action), ["gate.answer"]);
});

test("a wait aborted after an answer is recorded ends cancelled and leaves the answer for a later result", async (context) => {
  const { root, gateIds } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const take = () => takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  await take();
  const controller = new AbortController();
  const wait = waitForUserGates({ projectRoot: root, initiative: INITIATIVE, gateIds: [gateIds.review], maxWaitMinutes: 1, pollMs: 5000, signal: controller.signal, notices: { session: "s1", directory } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await answerGate(root, gateIds.review, "approve");
  controller.abort();
  assert.equal((await wait).status, "cancelled");
  assert.deepEqual((await take()).map((entry) => entry.action), ["gate.answer"], "the answer nobody received is shown by a later result");
});
