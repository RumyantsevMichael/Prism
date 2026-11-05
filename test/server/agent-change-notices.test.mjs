import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
import { INITIATIVE, actionProject } from "./fixtures/review-actions.mjs";

const { applyAction, listActions } = await import("../../dist/server/workflow/actions.mjs");
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
const { waitForGateAnswers } = await import("../../dist/hooks/wait-for-gate-answers.mjs");

const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const target = `initiative:${INITIATIVE}`;
const NOTICE = /^The person changed this initiative in the review app since this session last read it:/m;

async function person(root, action, input, { confirmed = false, actionTarget = target } = {}) {
  const listed = await listActions({ projectRoot: root, target: actionTarget });
  const view = listed.actions.find((item) => item.id === action);
  return (await applyAction({ projectRoot: root, target: view.target, action, input, revision: view.revision, confirmed, via: "review-app" })).applied;
}

async function dataDirectory(context) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-notices-data-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function server(context, root, { data, sessionId = null, clientName = "claude-code", version = "2.1.296" }) {
  const env = isolatedEnv({ PRISM_REVIEW_APP_DIR: path.join(root, ".app"), PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)), PRISM_GATE_WAIT_HEARTBEAT_MS: "200", PRISM_GATE_WAIT_SETTLE_MS: "300", CLAUDE_PROJECT_DIR: root, PLUGIN_DATA: data });
  for (const name of ["MCP_TOOL_TIMEOUT", "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "CLAUDE_CODE_SESSION_ID"]) delete env[name];
  if (sessionId) env.CLAUDE_CODE_SESSION_ID = sessionId;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const listeners = new Set();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    messages.push(JSON.parse(line));
    for (const listener of listeners) listener();
  });
  const stop = async () => {
    if (child.exitCode === null) {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  };
  context.after(stop);
  let next = 1;
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const response = (id, timeout = 15000) => new Promise((resolve, reject) => {
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
  const ready = (async () => {
    const id = next++;
    send({ id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version } } });
    await response(id);
  })();
  const start = (name, args, meta) => {
    const id = next++;
    send({ id, method: "tools/call", params: { name, arguments: { projectRoot: root, ...args }, ...(meta ? { _meta: meta } : {}) } });
    return id;
  };
  const call = async (name, args, meta) => {
    await ready;
    const message = await response(start(name, args, meta));
    if (message.error) throw Object.assign(new Error(message.error.message), { data: message.error.data });
    return message.result;
  };
  return { call, start, response, ready, stop, messages };
}

const changesOf = (result) => result.structuredContent?.personChanges;
const noticeText = (result) => result.content.map((item) => item.text).join("\n");

test("a session is told once of the person's changes since it last read the initiative, and its first read shows nothing", async (context) => {
  const { root } = await actionProject(context);
  const data = await dataDirectory(context);
  await person(root, "initiative.continuation", { value: "stepwise" });
  const orchestrator = server(context, root, { data, sessionId: "orchestrator-session" });
  const first = await orchestrator.call("get_coordination_state", { initiative: INITIATIVE });
  assert.equal(changesOf(first), undefined, "a first read shows what is already in the state, not a notice");
  assert.doesNotMatch(noticeText(first), NOTICE);
  const push = await person(root, "initiative.push", { value: "on" }, { confirmed: true });
  const told = await orchestrator.call("get_initiative", { initiative: INITIATIVE });
  assert.deepEqual(changesOf(told), [push]);
  const text = noticeText(told);
  assert.match(text, NOTICE);
  assert.match(text, /initiative\.push/);
  assert.match(text, /off/);
  assert.match(text, /\bon\b/);
  assert.match(text, /Applies to child sessions started after the change\./);
  const again = await orchestrator.call("get_coordination_state", { initiative: INITIATIVE });
  assert.equal(changesOf(again), undefined, "the notice is shown once per session");
  assert.doesNotMatch(noticeText(again), NOTICE);
  const unrelated = await orchestrator.call("get_roadmap", {});
  assert.equal(changesOf(unrelated), undefined, "a call that names no initiative carries no notice");
  await orchestrator.stop();
  const later = await person(root, "initiative.review", { value: "all" });
  const restarted = server(context, root, { data, sessionId: "orchestrator-session" });
  const resumed = await restarted.call("get_initiative", { initiative: INITIATIVE });
  assert.deepEqual(changesOf(resumed), [later], "a restarted server of the same session shows only what this session has not seen");
  const other = server(context, root, { data, sessionId: "another-session" });
  assert.equal(changesOf(await other.call("get_initiative", { initiative: INITIATIVE })), undefined);
});

test("a gate wait ends when the person changes the initiative and counts the change as shown", async (context) => {
  const { root, gateIds } = await actionProject(context);
  const data = await dataDirectory(context);
  const mcp = server(context, root, { data, sessionId: "waiting-session" });
  await mcp.call("get_coordination_state", { initiative: INITIATIVE });
  const id = mcp.start("wait_for_user_gate", { initiative: INITIATIVE, gateIds: [gateIds.review] }, { progressToken: "wait" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(mcp.messages.some((message) => message.id === id), false, "the wait is still waiting");
  const changed = await person(root, "initiative.continuation", { value: "stepwise" });
  const ended = await mcp.response(id);
  assert.deepEqual([ended.result.structuredContent.status, ended.result.structuredContent.gateIds, ended.result.structuredContent.waiting], ["changed", [gateIds.review], [gateIds.review]]);
  assert.deepEqual(ended.result.structuredContent.changes, [changed]);
  assert.equal(changesOf(await mcp.call("get_initiative", { initiative: INITIATIVE })), undefined, "the wait already showed the change");
  const answering = mcp.start("wait_for_user_gate", { initiative: INITIATIVE, gateIds: [gateIds.review] }, { progressToken: "answer" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await person(root, "gate.answer", { choice: "approve" }, { actionTarget: `gate:${INITIATIVE}/${gateIds.review}` });
  assert.equal((await mcp.response(answering)).result.structuredContent.status, "answered", "an answer to a waited gate still answers the wait");
});

test("the Stop hook ends a deferred wait with the person's change", async (context) => {
  const { root, gateIds } = await actionProject(context);
  const data = await dataDirectory(context);
  const directory = path.join(root, ".app", "gate-waits");
  const mcp = server(context, root, { data, clientName: "codex-mcp-client", version: "0.170.0" });
  const deferred = await mcp.call("wait_for_user_gate", { initiative: INITIATIVE, gateIds: [gateIds.review] }, { sessionId: "codex-session" });
  assert.equal(deferred.structuredContent.status, "deferred");
  const hook = waitForGateAnswers({ input: Readable.from([JSON.stringify({ hook_event_name: "Stop", session_id: "codex-session" })]), directory, pollMs: 50, settleMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await person(root, "initiative.continuation", { value: "stepwise" });
  const blocked = await hook;
  assert.equal(blocked?.decision, "block");
  assert.match(blocked.reason, NOTICE);
  assert.match(blocked.reason, /initiative\.continuation/);
});

test("an agent's settings write keeps every setting the person changed and reports what it kept", async (context) => {
  const { root } = await actionProject(context);
  const data = await dataDirectory(context);
  await person(root, "initiative.continuation", { value: "stepwise" });
  const mcp = server(context, root, { data, sessionId: "settings-session" });
  const { revision } = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  const written = await mcp.call("update_coordination_state", { initiative: INITIATIVE, expectedRevision: revision, changes: { settings: { continuation: "auto", commit: "on", autonomy: "broad" } } });
  assert.deepEqual(written.structuredContent.keptSettings, [{ setting: "continuation", kept: "stepwise", requested: "auto" }]);
  const stored = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.settings;
  assert.deepEqual([stored.continuation, stored.commit, stored.autonomy], ["stepwise", "on", "broad"]);
  const current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  const same = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes: { settings: { continuation: "stepwise" } } });
  assert.deepEqual(same.keptSettings ?? [], [], "writing the person's own value keeps nothing");
});

test("claiming a scope or starting a slice returns the initiative's effective settings and which the person set", async (context) => {
  const { root } = await actionProject(context);
  const data = await dataDirectory(context);
  await person(root, "initiative.push", { value: "on" }, { confirmed: true });
  const mcp = server(context, root, { data, sessionId: "claim-session" });
  const current = await mcp.call("get_initiative", { initiative: INITIATIVE });
  const claimed = await mcp.call("update_initiative", { initiative: INITIATIVE, expectedRevision: current.structuredContent.revision, operations: [{ op: "claim", slug: INITIATIVE }] });
  assert.deepEqual(claimed.structuredContent.settings, { autonomy: "conservative", agentFlow: "multi", commit: "off", push: "on", continuation: "auto", review: "marked", models: "host defaults", personSettings: ["push"] });
  const released = await mcp.call("get_initiative", { initiative: INITIATIVE });
  const started = await mcp.call("update_initiative", { initiative: INITIATIVE, expectedRevision: released.structuredContent.revision, operations: [{ op: "set_status", slug: INITIATIVE, status: "in-progress" }] });
  assert.equal(started.structuredContent.settings.push, "on");
});

async function designProject(context) {
  const { root } = await actionProject(context, { gates: false });
  await mkdir(path.join(root, "test"), { recursive: true });
  for (const name of ["download", "audit"]) await writeFile(path.join(root, "test", `${name}.test.mjs`), `// frozen ${name} test\n`);
  await writeFile(path.join(root, "docs/plans", INITIATIVE, "slice.md"), "# Export reports\n\n## Contract\n1. Downloads write the report.\n");
  return root;
}

const plan = [
  { op: "split", parent: INITIATIVE, children: [{ slug: "download", title: "Download reports", requirements: ["docs/requirements/reports.md#1"] }, { slug: "audit", title: "Audit downloads", requirements: ["docs/requirements/reports.md#1"] }] },
  { op: "accept_design", slug: "download", frozenTests: ["test/download.test.mjs"], review: "none" },
  { op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "required" }
];

async function acceptUnder(context, policy, reviewRequired) {
  const root = await designProject(context);
  if (policy) await person(root, "initiative.review", { value: policy });
  let current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "propose_design", slug: INITIATIVE, operations: plan }] });
  current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  const accepted = await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired }] });
  return { root, marks: [accepted.record.slices.download.design.review, accepted.record.slices.audit.design.review] };
}

test("design acceptance sets review marks from the initiative's review setting at that moment", async (context) => {
  assert.deepEqual((await acceptUnder(context, null, [])).marks, ["none", "none"], "without a setting, only the orchestrator's marks count");
  assert.deepEqual((await acceptUnder(context, "marked", ["download"])).marks, ["required", "none"]);
  assert.deepEqual((await acceptUnder(context, "recommended", [])).marks, ["none", "required"], "recommended adds design's recommendation");
  const all = await acceptUnder(context, "all", []);
  assert.deepEqual(all.marks, ["required", "required"]);
  await person(all.root, "initiative.review", { value: "marked" });
  const after = await getInitiative({ projectRoot: all.root, initiative: INITIATIVE });
  assert.deepEqual([after.record.slices.download.design.review, after.record.slices.audit.design.review], ["required", "required"], "an accepted design keeps its mark");
});
