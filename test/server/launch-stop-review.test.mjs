import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, alive, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";

// Stopping a launched session whose host already ended on its own while its supervisor still drains the host's output.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-stop-review-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "process trees are checked on POSIX here" : false;
const module = () => import("../../dist/server/session/launched-sessions.mjs");

// A claude stub that starts a child holding its standard output open for a few seconds, reports its session, writes a reason, and exits with code 1.
// It logs its run as the fixture's stub does, so the fixture ends both processes after the test.
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
appendFileSync(process.env.PRISM_STUB_LOG, JSON.stringify({ host: "claude", argv, pid: process.pid, children: [{ kind: "output", pid: child.pid }] }) + "\n");
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
