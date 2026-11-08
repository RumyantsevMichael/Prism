import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
import { checkout, eventually, isolateGit, notes, ok, server, syncedWorkspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// A saved version is named by the next tool result that a server writes to its host, so a result that is never written, as for a cancelled call or a wait the session's end aborts,
// neither marks it named nor clears its pending notice.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
const NO_NATIVE_ASSETS = fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url));

const BASE = "# Foo\n\nLine one.\nLine two.\nLine three.\n";
const FILE = "docs/plans/foo/slice.md";

// A Prism server that a Claude Code host started, so wait_for_user_gate waits until it is answered or cancelled.
function waitingServer(context, machine, root) {
  const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: NO_NATIVE_ASSETS, PRISM_REVIEW_APP_DIR: machine.app, CLAUDE_PROJECT_DIR: root, PRISM_GATE_WAIT_HEARTBEAT_MS: "200" });
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
  return { messages, send, request, response, call, close };
}

const pending = (store) => readdir(path.join(store, ".prism-sync", "notices")).catch(() => []);
const savedCopies = async (store) => (await readdir(path.join(store, ".prism-sync", "conflicts"), { recursive: true }).catch(() => [])).filter((file) => file.endsWith("slice.md"));

// a and b change the same line; b's debounced sync, due five seconds after its write, saves b's version while b's agent waits on a gate.
async function conflictDuringWait(context) {
  const place = await syncedWorkspace(context);
  const a = { ...place.a, sync: "on" }, b = { ...place.b, sync: "on" };
  const onA = await server(context, a, await checkout(a, "api"));
  const rootB = await checkout(b, "web");
  const onB = waitingServer(context, b, rootB);
  await onB.response(onB.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.296" } }));
  const first = await writeArtifact(onA, FILE, BASE);
  assert.equal((await syncRecordStoreNow(place.storeA)).state, "ok");
  assert.equal((await syncRecordStoreNow(place.storeB)).state, "ok");
  const asked = await onB.call("update_coordination_state", { initiative: "reports", expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "correctness", question: "Is it correct?", artifacts: [] }] } });
  const gateId = ok(asked).openedGates[0].id;
  ok(await onA.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: first.version, edits: [{ oldText: "Line two.", newText: "Line two from a." }] }] }));
  assert.equal((await syncRecordStoreNow(place.storeA)).state, "ok");
  ok(await onB.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: first.version, edits: [{ oldText: "Line two.", newText: "Line two from b." }] }] }));
  const wait = onB.request("tools/call", { name: "wait_for_user_gate", arguments: { projectRoot: rootB, initiative: "reports", gateIds: [gateId] } });
  await eventually(async () => (await savedCopies(place.storeB)).length > 0, 45000, "b's debounced sync saving b's version during the wait");
  assert.equal((await pending(place.storeB)).length, 1, "the saved version is pending while the wait runs");
  return { place, b, onB, wait };
}

test("a cancelled wait is never written, so it leaves the saved version pending and the server's next result names it", async (context) => {
  const { place, onB, wait } = await conflictDuringWait(context);
  onB.send({ method: "notifications/cancelled", params: { requestId: wait, reason: "user pressed Esc" } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(onB.messages.some((message) => message.id === wait), false, "a cancelled request gets no response");
  assert.equal((await pending(place.storeB)).length, 1, "the cancelled result cleared no pending notice");
  const named = notes(await onB.call("get_artifact", { path: "docs/plans" }));
  assert.ok(named.includes(FILE), named);
  await eventually(async () => (await pending(place.storeB)).length === 0, 5000, "the written result clearing the notice it carried");
  assert.equal(notes(await onB.call("get_artifact", { path: "docs/plans" })).includes(FILE), false, "the saved version is named once");
});

test("a wait that the session's end aborts is never written, so the next server names the saved version", async (context) => {
  const { place, b, onB, wait } = await conflictDuringWait(context);
  await onB.close();
  assert.equal(onB.messages.some((message) => message.id === wait), false, "the aborted wait gets no response");
  assert.equal((await pending(place.storeB)).length, 1, "the session's end cleared no pending notice");
  const later = await server(context, b, await checkout(b, "admin"));
  const named = notes(await later.call("get_artifact", { path: "docs/plans" }));
  assert.ok(named.includes("slice.md"), named);
  await eventually(async () => (await pending(place.storeB)).length === 0, 5000, "the written result clearing the notice it carried");
});

test("any call that the host cancels before its result is written gets no response and leaves the saved version pending for the next result", async (context) => {
  const place = await syncedWorkspace(context);
  const b = { ...place.b, sync: "on" };
  const root = await checkout(b, "web");
  const onB = waitingServer(context, b, root);
  await onB.response(onB.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.296" } }));
  await onB.call("get_artifact", { path: "docs/plans" });
  // A sync of a server that has since stopped saved b's version, and its notice is pending.
  const stamp = new Date(Date.now() - 60000).toISOString().replace(/[:.]/g, "-");
  const savedAs = path.join(place.storeB, ".prism-sync", "conflicts", stamp, "artifacts", "plans", "foo", "slice.md");
  await mkdir(path.dirname(savedAs), { recursive: true });
  await writeFile(savedAs, BASE);
  await mkdir(path.join(place.storeB, ".prism-sync", "notices"), { recursive: true });
  await writeFile(path.join(place.storeB, ".prism-sync", "notices", stamp), "{}\n");
  for (const name of ["get_artifact", "list_reviewable_artifacts"]) {
    const cancelled = onB.request("tools/call", { name, arguments: { projectRoot: root, path: "docs/plans" } });
    onB.send({ method: "notifications/cancelled", params: { requestId: cancelled, reason: "user pressed Esc" } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(onB.messages.some((message) => message.id === cancelled), false, `a cancelled ${name} gets no response`);
    assert.equal((await pending(place.storeB)).length, 1, `the cancelled ${name} cleared no pending notice`);
  }
  const named = notes(await onB.call("get_artifact", { path: "docs/plans" }));
  assert.ok(named.includes(savedAs), named);
  await eventually(async () => (await pending(place.storeB)).length === 0, 5000, "the written result clearing the notice it carried");
  // A cancel that arrives after a result was written changes nothing for the next call.
  const answered = onB.request("tools/call", { name: "get_artifact", arguments: { projectRoot: root, path: "docs/plans" } });
  await onB.response(answered);
  onB.send({ method: "notifications/cancelled", params: { requestId: answered } });
  assert.equal(notes(await onB.call("get_artifact", { path: "docs/plans" })).includes(savedAs), false, "the saved version is named once");
});
