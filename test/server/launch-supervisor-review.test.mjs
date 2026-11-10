import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CODEX_THREAD, INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";
import { hostArguments, resumeCommandOf, streamReader } from "../../dist/server/session/launch-hosts.mjs";
import { RETENTION_MS, launchView, launchesDirectory } from "../../dist/server/session/launch-records.mjs";
import { withFileLock } from "../../dist/server/workflow/artifact-store.mjs";

// What a launched session takes from its host's output: a host session id only when it is safe on a command line,
// and a launch view that carries that id only in its resumeCommand. Stub executables stand in for claude and codex.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-review-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "process supervision is checked on POSIX here" : false;
const module = () => import("../../dist/server/session/launched-sessions.mjs");
const UNSAFE_THREADS = ["--dangerously-bypass-approvals-and-sandbox", "a; rm -rf ~", "-c", "id with space", ""];

const feed = (reader, lines) => {
  for (const line of lines) reader.push(Buffer.from(`${JSON.stringify(line)}\n`));
  reader.end();
  return reader.facts;
};

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
    const facts = feed(streamReader("codex", { onSessionId: (id) => named.push(id) }), [
      { type: "thread.started", thread_id: threadId },
      { type: "thread.started", thread_id: CODEX_THREAD }
    ]);
    assert.equal(facts.hostSessionId, null, threadId);
    assert.deepEqual(named, [], threadId);
    assert.equal(resumeCommandOf("codex", threadId), null, threadId);
    assert.throws(() => hostArguments({ host: "codex", initiative: INITIATIVE, hostSessionId: threadId, resume: true }), threadId);
  }
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
  const facts = feed(streamReader("claude-code", { hostSessionId: id }), [
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: `${"y".repeat(470)} session ${upper}` }] } },
    { type: "result", is_error: true, result: `Error: Session ID ${id} is already in use.`, permission_denials: [{ tool_name: "Bash", tool_use_id: "a" }] }
  ]);
  assert.ok(!JSON.stringify(facts).toLowerCase().includes(id));
  assert.equal(facts.hostError, "Error: Session ID <host session id> is already in use.");
  assert.ok(facts.refusals[0].reason.length <= 500);
  const codex = feed(streamReader("codex"), [
    { type: "thread.started", thread_id: CODEX_THREAD },
    { type: "item.completed", item: { type: "command_execution", status: "declined", command: `echo ${CODEX_THREAD}` } },
    { type: "turn.failed", error: { message: `thread ${CODEX_THREAD} failed` } }
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
