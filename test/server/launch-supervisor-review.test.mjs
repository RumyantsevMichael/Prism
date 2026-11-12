import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CODEX_THREAD, INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";
import { codexThreadRequest, hostConversation, resumeCommandOf } from "../../dist/server/session/launch-hosts.mjs";
import { RETENTION_MS, launchView, launchesDirectory } from "../../dist/server/session/launch-records.mjs";
import { withFileLock } from "../../dist/server/workflow/artifact-store.mjs";
import { fileURLToPath } from "node:url";

// What a launched session takes from its host's output: a host session id only when it is safe on a command line,
// and a launch view that carries that id only in its resumeCommand. Stub executables stand in for claude and codex.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-review-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "process supervision is checked on POSIX here" : false;
const module = () => import("../../dist/server/session/launched-sessions.mjs");
const UNSAFE_THREADS = ["--dangerously-bypass-approvals-and-sandbox", "a; rm -rf ~", "-c", "id with space", ""];

// A host conversation fed these output lines, which writes into a list and never reaches a process.
const feed = (host, lines, options = {}) => {
  const conversation = hostConversation(host, { initiative: INITIATIVE, checkout: "/work/demo", send: () => {}, closeInput: () => {}, ...options });
  conversation.start();
  for (const line of lines) conversation.push(Buffer.from(`${JSON.stringify(line)}\n`));
  conversation.end();
  return conversation.facts;
};
const answer = (id, result) => ({ jsonrpc: "2.0", id, result });
const note = (method, params) => ({ jsonrpc: "2.0", method, params });

async function settled(fixture, id, states) {
  const { listLaunches } = await module();
  return waitFor(async () => {
    const { launches } = await listLaunches({ projectRoot: fixture.root, env: fixture.env });
    return launches.find((view) => view.id === id && states.includes(view.state)) ?? null;
  });
}

test("a Codex thread id that is unsafe on a command line names no session", () => {
  for (const threadId of UNSAFE_THREADS) {
    const named = [];
    const facts = feed("codex", [answer(1, {}), answer(2, { thread: { id: threadId } }), note("thread/started", { thread: { id: CODEX_THREAD } })], { onSessionId: (id) => named.push(id) });
    assert.equal(facts.hostSessionId, null, threadId);
    assert.deepEqual(named, [], threadId);
    assert.equal(resumeCommandOf("codex", threadId), null, threadId);
    assert.throws(() => codexThreadRequest({ checkout: "/work/demo", hostSessionId: threadId, resume: true }), threadId);
  }
  assert.equal(feed("codex", [answer(1, {}), answer(2, { thread: { id: CODEX_THREAD } })]).hostSessionId, CODEX_THREAD);
  assert.equal(resumeCommandOf("codex", CODEX_THREAD), `codex resume ${CODEX_THREAD}`);
});

test("a run that names an unsafe thread id has no resume command and cannot be resumed", { skip: posixOnly }, async (t) => {
  for (const threadId of ["--dangerously-bypass-approvals-and-sandbox", "a; rm -rf ~"]) {
    const fixture = await launchFixture(t, { plans: { codex: [{ threadId }] } });
    const { resumeLaunch, startLaunch } = await module();
    const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "codex", env: fixture.env });
    const view = await settled(fixture, launch.id, ["finished"]);
    assert.equal(view.resumeCommand, null);
    assert.ok(!JSON.stringify(view).includes(threadId));
    await assert.rejects(resumeLaunch({ id: launch.id, env: fixture.env }), { code: "no_host_session" });
    assert.equal(fixture.runs("codex").length, 1);
  }
});

test("a failed run's reason never carries the host session id", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { codex: [{ exit: 1, stderr: `Error: no rollout found for thread id ${CODEX_THREAD}` }] } });
  const { startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "codex", env: fixture.env });
  const failed = await settled(fixture, launch.id, ["failed"]);
  const { resumeCommand, ...rest } = failed;
  assert.ok(resumeCommand.command.includes(CODEX_THREAD));
  assert.ok(!JSON.stringify(rest).includes(CODEX_THREAD), `the launch view outside resumeCommand holds the host session id: ${failed.reason}`);
  assert.match(failed.reason, /<host session id>/);
});

test("host error text and refusal reasons have the host session id replaced, in any letter case", () => {
  const id = "0f6b2c1e-5d4a-4c3b-9a8f-7e6d5c4b3a21";
  const upper = id.toUpperCase();
  const facts = feed("claude-code", [
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: `${"y".repeat(470)} session ${upper}` }] } },
    { type: "result", is_error: true, result: `Error: Session ID ${id} is already in use.`, permission_denials: [{ tool_name: "Bash", tool_use_id: "a" }] }
  ], { hostSessionId: id });
  assert.ok(!JSON.stringify(facts).toLowerCase().includes(id));
  assert.equal(facts.hostError, "Error: Session ID <host session id> is already in use.");
  assert.ok(facts.refusals[0].reason.length <= 500);
  const codex = feed("codex", [
    answer(1, {}),
    answer(2, { thread: { id: CODEX_THREAD } }),
    answer(3, { turn: { id: "turn-1" } }),
    note("item/completed", { item: { type: "commandExecution", status: "declined", command: `echo ${CODEX_THREAD}` } }),
    note("turn/completed", { turn: { id: "turn-1", status: "failed", error: { message: `thread ${CODEX_THREAD} failed` } } })
  ]);
  assert.equal(codex.hostSessionId, CODEX_THREAD);
  assert.equal(codex.hostError, "thread <host session id> failed");
  assert.equal(codex.refusals[0].reason, "Codex declined: echo <host session id>");

  // A record written before the reader replaced the id still shows it only in resumeCommand.
  const run = (fields) => ({ number: 1, cause: "launch", token: "t", supervisorPid: 1, hostPid: 2, startedAt: "2026-11-01T00:00:00.000Z", heartbeatAt: "2026-11-01T00:00:00.000Z", outputAt: null, endedAt: "2026-11-01T00:01:00.000Z", exit: { code: 0, signal: null }, refusals: [], hostError: null, stderr: null, ...fields });
  const record = (fields) => ({ id: "launch-0123456789abcdef", initiative: INITIATIVE, host: "claude-code", checkout: "/tmp/x", store: "s", createdAt: "2026-11-01T00:00:00.000Z", hostSessionId: id, runs: [run(fields)] });
  for (const fields of [{ exit: { code: 1, signal: null }, stderr: `Error: Session ID ${upper} is already in use.` }, { hostError: `session ${id}` }, { refusals: [{ tool: "Bash", reason: `in ${id}` }] }]) {
    const { resumeCommand, ...rest } = launchView(record(fields));
    assert.equal(resumeCommand.command, `claude --resume ${id}`);
    assert.ok(!JSON.stringify(rest).toLowerCase().includes(id), JSON.stringify(rest));
  }
});

test("a blocked launch counts every refusal of its run, though the record holds only the first ones", () => {
  const at = "2026-11-01T00:00:00.000Z";
  const record = (fields) => ({ id: "launch-0123456789abcdef", initiative: INITIATIVE, host: "claude-code", checkout: "/tmp/x", store: "s", createdAt: at, hostSessionId: null,
    runs: [{ number: 1, cause: "launch", token: "t", supervisorPid: 1, hostPid: 2, startedAt: at, heartbeatAt: at, outputAt: null, endedAt: at, exit: { code: 0, signal: null }, hostError: null, stderr: null, ...fields }] });
  const refusals = Array.from({ length: 20 }, (_, index) => ({ tool: "Bash", reason: `no ${index}` }));
  assert.equal(launchView(record({ refusals, refusalCount: 31 })).reason, "Claude Code refused Bash: no 0 (and 30 more)");
  assert.equal(launchView(record({ refusals: refusals.slice(0, 2) })).reason, "Claude Code refused Bash: no 0 (and 1 more)");
});

test("listing removes an expired launch folder only under the launch lock", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { codex: [{}] } });
  const { listLaunches, startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "codex", env: fixture.env });
  await settled(fixture, launch.id, ["finished"]);
  const folder = path.join(launchesDirectory(fixture.env), launch.id);
  const later = Date.now() + RETENTION_MS + 60000;
  let listed = null;
  await withFileLock(path.join(launchesDirectory(fixture.env), "launches"), async () => {
    listed = listLaunches({ projectRoot: fixture.root, env: fixture.env, now: later });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(existsSync(folder), "the folder was removed while another process held the launch lock");
  });
  const { launches } = await listed;
  assert.equal(launches.length, 0);
  assert.ok(!existsSync(folder));
});

test("a resume that answers launch_failed after its timeout starts no run afterwards", { skip: posixOnly, timeout: 60000 }, async (t) => {
  const fixture = await launchFixture(t, { plans: { codex: [{}, { hold: "forever" }] } });
  const { listLaunches, resumeLaunch, startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "codex", env: fixture.env });
  await settled(fixture, launch.id, ["finished"]);
  const slow = fileURLToPath(new URL("./fixtures/slow-launch-supervisor.mjs", import.meta.url));
  await assert.rejects(resumeLaunch({ id: launch.id, env: { ...fixture.env, NODE_OPTIONS: `--import ${slow}` } }), { code: "launch_failed" });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const { launches } = await listLaunches({ projectRoot: fixture.root, env: fixture.env });
  const view = launches.find((entry) => entry.id === launch.id);
  assert.equal(fixture.runs("codex").length, 1, `a run started after launch_failed; the session now shows ${view.state} with ${view.runs} runs`);
  assert.equal(view.state, "finished");
});
