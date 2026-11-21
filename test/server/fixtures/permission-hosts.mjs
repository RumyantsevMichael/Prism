// Hosts whose permission requests carry what the shared stubs do not send: wrappers around the fake ACP agent and the Codex stub
// that rewrite the one permission request each sends, and send the notifications that a real host sends around it.
// Each wrapper starts the wrapped stub with its own arguments, passes the standard input through, and rewrites only that request, so
// the wrapped stub still logs every message it reads, the answers to the rewritten request included.
// The plan file holds { acp: { toolCall, before }, codex: { request, before, after } }:
// acp.toolCall replaces the tool call of session/request_permission, acp.before holds session/update `update` objects sent first,
// and acp.cancelAfter sends `$/cancel_request` for the request 300 ms after it;
// codex.request holds the method and the params, without threadId and turnId, that replace the stub's approval request, and
// codex.before and codex.after hold { method, params } notifications, without threadId and turnId, sent before and 300 ms after it.
import { chmodSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

const WRAPPER = (target, planFile, kind) => String.raw`#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const plan = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, "utf8"))[${JSON.stringify(kind)}] ?? {}; } catch { return {}; } };
const child = spawn(${JSON.stringify(target)}, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
child.on("exit", (code) => process.exit(code ?? 0));
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
function rewrite(message) {
  const value = plan();
  if (${JSON.stringify(kind)} === "acp" && message.method === "session/request_permission") {
    const sessionId = message.params?.sessionId;
    for (const update of value.before ?? []) out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
    out(value.toolCall ? { ...message, params: { ...message.params, toolCall: value.toolCall } } : message);
    if (value.cancelAfter) setTimeout(() => out({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: message.id } }), 300);
    return;
  }
  if (${JSON.stringify(kind)} === "codex" && message.id === "approval-1" && message.method !== undefined && value.request) {
    const { threadId, turnId } = message.params ?? {};
    const notify = (item) => out({ jsonrpc: "2.0", method: item.method, params: { threadId, turnId, ...item.params } });
    (value.before ?? []).forEach(notify);
    out({ jsonrpc: "2.0", id: message.id, method: value.request.method, params: { threadId, turnId, ...value.request.params } });
    if (value.after) setTimeout(() => value.after.forEach(notify), 300);
    return;
  }
  out(message);
}
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(line + "\n"); continue; }
    rewrite(message);
  }
});
`;

/**
 * Wraps the hosts of an acpFixture: `acp` is the absolute command of an ACP agent that rewrites its permission request, for a
 * declaration entry, and the Codex stub on PATH becomes a wrapper that rewrites its approval request; setPlan(value) sets both plans.
 */
export async function permissionHosts(fixture) {
  const planFile = path.join(fixture.bin, "permission-hosts.json");
  const setPlan = (value) => writeFile(planFile, JSON.stringify(value));
  await setPlan({});
  const acp = path.join(fixture.bin, "permission-acp");
  await writeFile(acp, WRAPPER(fixture.agent, planFile, "acp"));
  chmodSync(acp, 0o755);
  const codex = path.join(fixture.bin, "codex");
  const stub = path.join(fixture.bin, "codex-stub");
  await rename(codex, stub).catch(() => {});
  await writeFile(codex, WRAPPER(stub, planFile, "codex"));
  chmodSync(codex, 0o755);
  return { acp, setPlan };
}
