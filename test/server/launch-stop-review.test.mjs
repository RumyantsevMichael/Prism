import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hostConversation } from "../../dist/server/session/launch-hosts.mjs";
import { CODEX_THREAD, INITIATIVE, alive, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";

// Stopping a launched session whose host already ended on its own while its supervisor still drains the host's output,
// and the interrupt that a run's conversation sends its host for a stop.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-stop-review-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const module = () => import("../../dist/server/session/launched-sessions.mjs");

// A claude stub that starts a child holding its standard output open for a few seconds, reports its session, writes a reason, and exits with code 1.
// It logs its run as a { kind: "run" } entry, as the fixture's stub does, so the fixture ends both processes after the test.
const FAILING_HOST = String.raw`#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
const index = argv.indexOf("--session-id");
const id = index >= 0 ? argv[index + 1] : null;
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: ["ignore", "inherit", "ignore"] });
child.unref();
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: id }) + "\n");
process.stderr.write("boom\n");
appendFileSync(process.env.PRISM_STUB_LOG, JSON.stringify({ host: "claude", kind: "run", argv, pid: process.pid, children: [{ kind: "output", pid: child.pid }] }) + "\n");
setTimeout(() => process.exit(1), 50);
`;

async function viewOf(fixture, id) {
  const { listLaunches } = await module();
  return (await listLaunches({ projectRoot: fixture.root, env: fixture.env })).launches.find((launch) => launch.id === id) ?? null;
}

// Clause 15.1: a run is stopped only when it ended after a stop request, so a host that failed on its own keeps its failed state.
test("a stop asked after the host ended on its own, while its output still drains, keeps the run's failed state", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { hosts: ["claude"] });
  const host = path.join(fixture.bin, "claude");
  await writeFile(host, FAILING_HOST);
  chmodSync(host, 0o755);
  const { startLaunch, stopLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const [run] = await waitFor(() => fixture.runs("claude").length ? fixture.runs("claude") : null, { what: "the stub to start" });
  await waitFor(() => !alive(run.pid), { every: 20, what: "the host to exit" });
  const answer = await stopLaunch({ id: launch.id, env: fixture.env }).catch((error) => error);
  if (answer instanceof Error) assert.equal(answer.code, "launch_not_running");
  else assert.equal(answer.state, "failed");
  const view = await waitFor(async () => {
    const current = await viewOf(fixture, launch.id);
    return current && current.state !== "running" ? current : null;
  }, { what: "the run's end to be recorded" });
  assert.equal(view.state, "failed");
  assert.equal(view.exit?.code, 1);
});

// A conversation whose host input is recorded: every message written, and whether the input was closed.
function recorded(host, options = {}) {
  const sent = [];
  let closes = 0;
  const conversation = hostConversation(host, { initiative: INITIATIVE, checkout: "/checkout", hostSessionId: host === "claude-code" ? "11111111-2222-4333-8444-555555555555" : null, ...options, send: (message) => sent.push(message), closeInput: () => { closes += 1; } });
  const say = (message) => conversation.push(Buffer.from(`${JSON.stringify(message)}\n`));
  return { conversation, sent, say, closes: () => closes };
}

test("a Claude Code interrupt is one control request, and only the answer that names its request id closes the input", () => {
  const { conversation, sent, say, closes } = recorded("claude-code");
  conversation.start();
  conversation.interrupt();
  conversation.interrupt();
  const interrupts = sent.filter((message) => message.type === "control_request");
  assert.equal(interrupts.length, 1, "a second stop sends no second interrupt");
  const id = interrupts[0].request_id;
  say({ type: "control_response", response: { subtype: "success", request_id: `${id}-other`, response: {} } });
  assert.equal(closes(), 0);
  say({ type: "control_response", response: { subtype: "success", request_id: id, response: { still_queued: [] } } });
  assert.equal(closes(), 1);
  assert.equal(conversation.inputOpen, false);
});

test("a Claude Code run whose input already closed gets no interrupt", () => {
  const { conversation, sent, say } = recorded("claude-code");
  conversation.start();
  say({ type: "result", is_error: false, result: "done", permission_denials: [] });
  assert.equal(conversation.inputOpen, false);
  conversation.interrupt();
  assert.equal(sent.filter((message) => message.type === "control_request").length, 0);
});

// Drives a Codex conversation up to the turn/start request and answers whether the request was answered with the turn.
function codexUntilTurn({ answerTurn }) {
  const run = recorded("codex");
  run.conversation.start();
  const idOf = (method) => run.sent.find((message) => message.method === method).id;
  run.say({ jsonrpc: "2.0", id: idOf("initialize"), result: {} });
  run.say({ jsonrpc: "2.0", id: idOf("thread/start"), result: { thread: { id: CODEX_THREAD } } });
  if (answerTurn) run.say({ jsonrpc: "2.0", id: idOf("turn/start"), result: { turn: { id: "turn-1" } } });
  return { ...run, idOf };
}

test("a Codex run that has not sent turn/start gets its input closed at once and no interrupt", () => {
  const { conversation, sent, say, closes } = recorded("codex");
  conversation.start();
  say({ jsonrpc: "2.0", id: sent[0].id, result: {} });
  conversation.interrupt();
  assert.equal(closes(), 1);
  say({ jsonrpc: "2.0", id: sent.find((message) => message.method === "thread/start").id, result: { thread: { id: CODEX_THREAD } } });
  assert.equal(sent.some((message) => message.method === "turn/start" || message.method === "turn/interrupt"), false);
});

test("a Codex interrupt asked before turn/start is answered goes out once the answer names the turn, and its answer closes the input", () => {
  const { conversation, sent, say, closes, idOf } = codexUntilTurn({ answerTurn: false });
  conversation.interrupt();
  assert.equal(sent.some((message) => message.method === "turn/interrupt"), false);
  assert.equal(closes(), 0);
  say({ jsonrpc: "2.0", id: idOf("turn/start"), result: { turn: { id: "turn-1" } } });
  const interrupt = sent.find((message) => message.method === "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: CODEX_THREAD, turnId: "turn-1" });
  assert.equal(closes(), 0);
  say({ jsonrpc: "2.0", id: interrupt.id, result: {} });
  assert.equal(closes(), 1);
  assert.equal(conversation.facts.hostError, null, "an answered interrupt is no host error");
});

test("a Codex interrupt that the host refuses still closes the input without a host error", () => {
  const { conversation, sent, say, closes } = codexUntilTurn({ answerTurn: true });
  conversation.interrupt();
  const interrupt = sent.find((message) => message.method === "turn/interrupt");
  say({ jsonrpc: "2.0", id: interrupt.id, error: { code: -32600, message: "no active turn" } });
  assert.equal(closes(), 1);
  assert.equal(conversation.facts.hostError, null);
});

test("a Codex turn that completes after the interrupt closes the input before the interrupt is answered", () => {
  const { conversation, sent, say, closes } = codexUntilTurn({ answerTurn: true });
  conversation.interrupt();
  assert.equal(sent.filter((message) => message.method === "turn/interrupt").length, 1);
  say({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: CODEX_THREAD, turn: { id: "turn-1", status: "interrupted", items: [], error: null } } });
  assert.equal(closes(), 1);
});

test("the forced end goes through the held child process handle on every platform, never by a looked-up process id", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../dist/server/session/launch-supervisor.mjs", import.meta.url), "utf8");
  const forceEnd = /function forceEndHost\(child\) \{([\s\S]*?)\n\}/.exec(source)?.[1];
  assert.ok(forceEnd, "the supervisor defines forceEndHost");
  assert.match(forceEnd, /child\.kill\("SIGKILL"\)/);
  assert.doesNotMatch(forceEnd, /platform|pid/);
  assert.doesNotMatch(source, /taskkill|execFile|process\.kill\(/);
});
