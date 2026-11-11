import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { descendantsOf, endProcessTree, listProcesses, stopGraceMs, STOP_FINISH_MS, supervisorCommand } from "../../dist/server/session/process-tree.mjs";

// The process list that a stop walks: a spared process and everything below it stays out of the list it ends.
const table = new Map([
  [10, { pid: 10, ppid: 1, started: "a", args: "claude -p" }],
  [11, { pid: 11, ppid: 10, started: "a", args: "node mcp.mjs" }],
  [12, { pid: 12, ppid: 11, started: "a", args: "sleep 600" }],
  [13, { pid: 13, ppid: 10, started: "a", args: "node review-app.mjs" }],
  [14, { pid: 14, ppid: 13, started: "a", args: "node /x/launch-supervisor.mjs /app/launches/launch-1 launch t" }],
  [15, { pid: 15, ppid: 10, started: "a", args: "node /x/launch-supervisor.mjs /app/launches/launch-2 launch t" }],
  [16, { pid: 16, ppid: 15, started: "a", args: "codex exec" }],
  [17, { pid: 17, ppid: 1, started: "a", args: "unrelated" }]
]);

test("the descendants of a host leave out the review app, launch supervisors, and every process below them", () => {
  const found = descendantsOf(table, [10], new Set([13])).map((entry) => entry.pid).sort((a, b) => a - b);
  assert.deepEqual(found, [11, 12]);
});

test("the grace period reads PRISM_LAUNCH_STOP_GRACE_MS and falls back to ten seconds", () => {
  assert.equal(stopGraceMs({ PRISM_LAUNCH_STOP_GRACE_MS: "1500" }), 1500);
  assert.equal(stopGraceMs({ PRISM_LAUNCH_STOP_GRACE_MS: "0" }), 0);
  assert.equal(stopGraceMs({}), 10000);
  assert.equal(stopGraceMs({ PRISM_LAUNCH_STOP_GRACE_MS: "-1" }), 10000);
  assert.equal(stopGraceMs({ PRISM_LAUNCH_STOP_GRACE_MS: "soon" }), 10000);
});

// Windows keeps the parent id of a parent that ended and reuses it, so a process older than the parent it names is not its child.
test("a process that started before the parent it names is not that parent's descendant", () => {
  const stale = new Map([
    [100, { pid: 100, ppid: 4, started: "133000000000000500", args: "claude.exe -p" }],
    [200, { pid: 200, ppid: 100, started: "133000000000000600", args: "node mcp.mjs" }],
    [300, { pid: 300, ppid: 200, started: "133000000000000001", args: "explorer.exe" }],
    [400, { pid: 400, ppid: 200, started: "133000000000000600", args: "node child.mjs" }]
  ]);
  assert.deepEqual(descendantsOf(stale, [100]).map((entry) => entry.pid), [200, 400]);
});

test("only a supervisor's exact command line marks a launch supervisor, never a mention of its file name", () => {
  const launches = path.join(path.sep, "app", "launches");
  const folder = path.join(launches, "launch-0123456789abcdef");
  assert.deepEqual(supervisorCommand(`/usr/bin/node /x y/launch-supervisor.mjs ${folder} person 0123456789abcdef`, launches), { folder, token: "0123456789abcdef" });
  assert.equal(supervisorCommand(`bash -c sleep 600 # launch-supervisor.mjs`), null);
  assert.equal(supervisorCommand(`vim src/server/session/launch-supervisor.mjs`), null);
  assert.equal(supervisorCommand(`/usr/bin/node /x/launch-supervisor.mjs ${path.join(path.sep, "elsewhere", "launch-0123456789abcdef")} person t`, launches), null);
  assert.equal(supervisorCommand(`/usr/bin/node /x/launch-supervisor.mjs ${path.join(launches, "launch-1")} person t`, launches), null);
});

test("a command line is recognized as a supervisor's or not in time linear in its length", () => {
  for (const unit of ["/node /launch-supervisor.mjs a launch ", "node ", " ", "launch-supervisor.mjs "]) {
    const args = unit.repeat(Math.ceil(30000 / unit.length)) + "/app/launches/launch-0123456789abcdef launch t";
    const started = Date.now();
    supervisorCommand(args);
    supervisorCommand(`${args}!`);
    assert.ok(Date.now() - started < 200, `a ${args.length}-character command line took ${Date.now() - started} ms`);
  }
  const launches = path.join(path.sep, "app", "launches");
  const folder = path.join(launches, "launch-0123456789abcdef");
  assert.deepEqual(supervisorCommand(`"/opt/node js/node" "/x y/launch-supervisor.mjs" "${folder}" gate t1`, launches), { folder, token: "t1" });
  assert.deepEqual(supervisorCommand(`/opt/my node/bin/node launch-supervisor.mjs ${folder} launch t2`, launches), { folder, token: "t2" });
  assert.equal(supervisorCommand(`/usr/bin/nodex /x/launch-supervisor.mjs ${folder} person t`, launches), null);
});

// POSIX lstart is local time without a zone, so in the hour repeated when daylight saving time ends a child can read as older.
test("on POSIX a child is its parent's descendant whatever their start times read", () => {
  const table = new Map([
    [100, { pid: 100, ppid: 1, started: "Sun Nov 1 01:50:00 2026", args: "claude -p" }],
    [101, { pid: 101, ppid: 100, started: "Sun Nov 1 01:10:00 2026", args: "sleep 600" }]
  ]);
  assert.deepEqual(descendantsOf(table, [100]).map((entry) => entry.pid), [101]);
});

test("a stop spares a launch supervisor that its launch record names and ends a process that only mentions the supervisor", { skip: process.platform === "win32" ? "process trees are checked on POSIX here" : false }, async (t) => {
  const app = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-process-tree-")));
  t.after(() => rm(app, { recursive: true, force: true }));
  const folder = path.join(app, "launches", "launch-0123456789abcdef");
  await mkdir(folder, { recursive: true });
  const script = path.join(app, "launch-supervisor.mjs");
  await writeFile(script, "setInterval(() => {}, 1000);\n");
  const token = "fedcba9876543210";
  const hostScript = [
    "const { spawn } = require('node:child_process');",
    `const supervisor = spawn(process.execPath, [${JSON.stringify(script)}, ${JSON.stringify(folder)}, 'person', '${token}'], { stdio: 'ignore' });`,
    "const mention = spawn('/bin/sh', ['-c', 'sleep 600 # launch-supervisor.mjs'], { stdio: 'ignore' });",
    "console.log(JSON.stringify({ supervisor: supervisor.pid, mention: mention.pid }));",
    "setInterval(() => {}, 1000);"
  ].join("\n");
  const host = spawn(process.execPath, ["-e", hostScript], { stdio: ["ignore", "pipe", "ignore"] });
  const pids = await new Promise((resolve) => host.stdout.once("data", (chunk) => resolve(JSON.parse(String(chunk)))));
  t.after(() => { for (const pid of [pids.supervisor, pids.mention, host.pid]) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const at = new Date().toISOString();
  await writeFile(path.join(folder, "launch.json"), JSON.stringify({ id: "launch-0123456789abcdef", runs: [{ number: 1, token, supervisorPid: pids.supervisor, startedAt: at, endedAt: null }] }));
  let exited = false;
  const ended = new Promise((resolve) => host.once("exit", () => { exited = true; resolve(); }));
  const started = Date.now();
  await endProcessTree({ pid: host.pid, running: () => !exited, ended, graceMs: 200, reviewAppFolder: app });
  assert.ok(Date.now() - started < 200 + STOP_FINISH_MS + 500, "the stop keeps to its deadline");
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(pids.supervisor), true, "the recorded supervisor survived the stop");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const table = await listProcesses();
  assert.equal(table.has(pids.mention) && !/defunct|<zombie>/.test(table.get(pids.mention).args), false, "the process that only mentions the supervisor was ended");
});
