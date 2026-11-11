import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CODEX_THREAD, INITIATIVE, alive, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";

// Stopping a launched session the way the hosts' own Stop buttons do: Prism sends the host's interrupt, closes the host's
// input once the host answered it so the host exits by itself, and forcibly ends only the host process when it has not exited
// after the grace period. Processes the host started and detached keep running, as they do after the apps' Stop buttons.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-stop-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const module = () => import("../../dist/server/session/launched-sessions.mjs");

async function viewOf(fixture, id) {
  const { listLaunches } = await module();
  return (await listLaunches({ projectRoot: fixture.root, env: fixture.env })).launches.find((launch) => launch.id === id) ?? null;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}

const firstRun = (fixture, host) => waitFor(() => fixture.runs(host)[0] ?? null, { what: `the ${host} stub to start` });

test("a stop interrupts a Claude Code turn through its input, closes the input, and the host exits by itself while its detached work keeps running", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: "forever", children: ["attached", "detached"] }] } });
  fixture.env.PRISM_LAUNCH_STOP_GRACE_MS = "8000";
  const { startLaunch, stopLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const run = await firstRun(fixture, "claude");
  await waitFor(() => fixture.inputs(run.pid).length, { what: "the prompt to arrive" });
  const started = Date.now();
  const stopped = await stopLaunch({ id: launch.id, env: fixture.env });
  assert.ok(Date.now() - started < 5000, "the host answered the interrupt, so the stop did not wait for the grace period");
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.reason, null);
  assert.deepEqual(stopped.exit, { code: 1, signal: null }, "the host exited by itself after its interrupted turn");
  const interrupts = fixture.inputs(run.pid).filter((message) => message.type === "control_request");
  assert.equal(interrupts.length, 1);
  assert.equal(typeof interrupts[0].request_id, "string");
  assert.ok(interrupts[0].request_id.length > 0);
  assert.deepEqual(interrupts[0], { type: "control_request", request_id: interrupts[0].request_id, request: { subtype: "interrupt" } });
  assert.deepEqual(fixture.closed(run.pid), { results: 1, interrupted: true }, "the input closed after the host answered the interrupt");
  assert.equal(alive(run.pid), false);
  for (const child of run.children) assert.equal(alive(child.pid), true, `the ${child.kind} process of the host was ended by Prism`);
  assert.ok(stopped.resumeCommand, "a stopped session can be continued in a terminal");
  assert.equal((await viewOf(fixture, launch.id)).state, "stopped");
});

test("a stop interrupts a Codex turn with turn/interrupt, closes the input, and the app-server exits by itself", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { codex: [{ hold: "forever", children: ["detached"] }] } });
  fixture.env.PRISM_LAUNCH_STOP_GRACE_MS = "8000";
  const { startLaunch, stopLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "codex", env: fixture.env });
  const run = await firstRun(fixture, "codex");
  await waitFor(() => fixture.inputs(run.pid).some((message) => message.method === "turn/start"), { what: "the turn to start" });
  const started = Date.now();
  const stopped = await stopLaunch({ id: launch.id, env: fixture.env });
  assert.ok(Date.now() - started < 5000, "the stop did not wait for the grace period");
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(stopped.exit, { code: 0, signal: null });
  const interrupts = fixture.inputs(run.pid).filter((message) => message.method === "turn/interrupt");
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].jsonrpc, "2.0");
  assert.notEqual(interrupts[0].id, undefined, "turn/interrupt is a request");
  assert.deepEqual(interrupts[0].params, { threadId: CODEX_THREAD, turnId: "turn-1" });
  assert.deepEqual(fixture.closed(run.pid), { results: 1, interrupted: true });
  assert.equal(alive(run.pid), false);
  assert.equal(alive(run.children[0].pid), true, "a process the host detached keeps running");
});

test("a host that answers no interrupt is forcibly ended after the grace period counted from the request, and nothing else is", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: "forever", ignoreInterrupt: true, children: ["attached"] }], codex: [{ hold: "forever", ignoreInterrupt: true, children: ["attached"] }] } });
  const { startLaunch, stopLaunch } = await module();
  const claude = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const codex = await startLaunch({ projectRoot: fixture.root, initiative: "search", host: "codex", env: fixture.env });
  const runs = [await firstRun(fixture, "claude"), await firstRun(fixture, "codex")];
  await waitFor(() => fixture.inputs(runs[1].pid).some((message) => message.method === "turn/start"), { what: "the Codex turn to start" });
  for (const [launch, run] of [[claude.launch, runs[0]], [codex.launch, runs[1]]]) {
    const started = Date.now();
    const stopped = await stopLaunch({ id: launch.id, env: fixture.env });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1400, `the stop waited for the grace period of 1500 ms, not ${elapsed} ms`);
    assert.ok(elapsed < 1500 + 5000, "the stop resolves within the grace period and five seconds");
    assert.equal(stopped.state, "stopped");
    assert.deepEqual(stopped.exit, { code: null, signal: "SIGKILL" });
    assert.equal(alive(run.pid), false);
    assert.equal(alive(run.children[0].pid), true, "only the host process is ended, not its process group or tree");
  }
});

test("a stop while a Claude Code background task runs between turns interrupts through the input that is still open", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 50, background: 60000 }] } });
  fixture.env.PRISM_LAUNCH_STOP_GRACE_MS = "8000";
  const { startLaunch, stopLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const run = await firstRun(fixture, "claude");
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(fixture.closed(run.pid), null);
  const started = Date.now();
  const stopped = await stopLaunch({ id: launch.id, env: fixture.env });
  assert.ok(Date.now() - started < 5000);
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(stopped.exit, { code: 1, signal: null });
  assert.deepEqual(fixture.closed(run.pid), { results: 1, interrupted: true });
});

test("a stop leaves other launched sessions running", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: "forever" }], codex: [{ hold: "forever" }] } });
  const { startLaunch, stopLaunch } = await module();
  const first = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const second = await startLaunch({ projectRoot: fixture.root, initiative: "search", host: "codex", env: fixture.env });
  await waitFor(() => fixture.runs().length === 2, { what: "both stubs to start" });
  await stopLaunch({ id: first.launch.id, env: fixture.env });
  assert.equal((await viewOf(fixture, second.launch.id)).state, "running");
  const codex = fixture.runs("codex")[0];
  assert.equal(alive(codex.pid), true);
  assert.equal(fixture.inputs(codex.pid).filter((message) => message.method === "turn/interrupt").length, 0);
});

test("a stop is refused for a session that is not running and for an unknown launch", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 50 }] } });
  const { startLaunch, stopLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  await waitFor(async () => (await viewOf(fixture, launch.id))?.state === "finished", { what: "the run to finish" });
  const refused = await rejection(stopLaunch({ id: launch.id, env: fixture.env }));
  assert.equal(refused.code, "launch_not_running");
  assert.equal(refused.message, "The session is not running.");
  assert.equal((await viewOf(fixture, launch.id)).state, "finished", "a refused stop leaves the session's end as it was");
  assert.equal((await rejection(stopLaunch({ id: "launch-0000000000000000", env: fixture.env }))).code, "unknown_launch");
});

test("a stop asked from another process ends the session too", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: "forever" }] } });
  const { startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  await waitFor(() => fixture.runs("claude").length, { what: "the stub to start" });
  const script = `const { stopLaunch } = await import(${JSON.stringify(new URL("../../dist/server/session/launched-sessions.mjs", import.meta.url).href)});
const view = await stopLaunch({ id: ${JSON.stringify(launch.id)}, env: JSON.parse(process.env.LAUNCH_ENV) }); process.stdout.write(view.state);`;
  const state = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...fixture.env, LAUNCH_ENV: JSON.stringify(fixture.env) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(err)));
  });
  assert.equal(state, "stopped");
  assert.equal(alive(fixture.runs("claude")[0].pid), false);
});
