import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, alive, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";

// Stopping a launched session: the host and every process it started end, also those that left its process group or ignore
// a polite request, while the shared review app and the supervisors of other sessions keep running.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-stop-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "process trees are checked on POSIX here" : false;
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

test("a stop ends the host and every process it started, in its group, in a session of its own, or ignoring the polite signal", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: "forever", ignoreTerm: true, children: ["group", "session", "stubborn"] }] } });
  const { startLaunch, stopLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const [run] = await waitFor(() => fixture.runs("claude").length ? fixture.runs("claude") : null, { what: "the stub to start its children" });
  const pids = [run.pid, ...run.children.map((child) => child.pid)];
  assert.ok(pids.every(alive));
  const started = Date.now();
  const stopped = await stopLaunch({ id: launch.id, env: fixture.env });
  assert.ok(Date.now() - started < 1500 + 5000, "the stop resolves within the grace period and five seconds");
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(stopped.exit, { code: null, signal: "SIGKILL" });
  for (const pid of pids) assert.equal(alive(pid), false, `process ${pid} survived the stop`);
  assert.ok(stopped.resumeCommand, "a stopped session can be continued in a terminal");
  assert.equal((await viewOf(fixture, launch.id)).state, "stopped");
});

test("a host that ends on the polite signal is stopped without waiting for the grace period", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { codex: [{ hold: "forever" }] } });
  fixture.env.PRISM_LAUNCH_STOP_GRACE_MS = "8000";
  const { startLaunch, stopLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "codex", env: fixture.env });
  await waitFor(() => fixture.runs("codex").length, { what: "the stub to start" });
  const started = Date.now();
  const stopped = await stopLaunch({ id: launch.id, env: fixture.env });
  assert.ok(Date.now() - started < 5000, "the stop did not wait for the grace period");
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(stopped.exit, { code: null, signal: "SIGTERM" });
});

test("a stop spares the shared review app even when the session started it", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: "forever", children: ["session"] }] } });
  const { startLaunch, stopLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const [run] = await waitFor(() => fixture.runs("claude").length ? fixture.runs("claude") : null, { what: "the stub to start" });
  const app = run.children[0].pid;
  // The session's child in a session of its own plays the review app that the launched session's Prism server started.
  await writeFile(path.join(fixture.app, "review-app.json"), JSON.stringify({ protocol: 1, port: 1, controlToken: "c", viewerToken: "v", pid: app }));
  const stopped = await stopLaunch({ id: launch.id, env: fixture.env });
  assert.equal(stopped.state, "stopped");
  assert.equal(alive(run.pid), false);
  assert.equal(alive(app), true, "the review app survived the stop");
  process.kill(app, "SIGKILL");
});

test("a stop leaves other launched sessions running", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: "forever" }], codex: [{ hold: "forever" }] } });
  const { startLaunch, stopLaunch } = await module();
  const first = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const second = await startLaunch({ projectRoot: fixture.root, initiative: "search", host: "codex", env: fixture.env });
  await waitFor(() => fixture.runs().length === 2, { what: "both stubs to start" });
  await stopLaunch({ id: first.launch.id, env: fixture.env });
  assert.equal((await viewOf(fixture, second.launch.id)).state, "running");
  assert.equal(alive(fixture.runs("codex")[0].pid), true);
});

test("a stop is refused for a session that is not running and for an unknown launch", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 50 }] } });
  const { startLaunch, stopLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  await waitFor(async () => (await viewOf(fixture, launch.id))?.state === "finished", { what: "the run to finish" });
  assert.equal((await rejection(stopLaunch({ id: launch.id, env: fixture.env }))).code, "launch_not_running");
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
