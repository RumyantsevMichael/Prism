import assert from "node:assert/strict";
import { chmodSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, actionProject } from "./fixtures/review-actions.mjs";
import * as processTree from "../../dist/server/session/process-tree.mjs";

const { stopTargets, listProcesses, windowsHostStart, stoppedReason } = processTree;

const entry = (pid, ppid, values = {}) => ({ pid, ppid, started: "100", ended: false, launch: null, job: false, args: "process", ...values });
const state = (pid) => { try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]; } catch { return null; } };
async function until(probe, label) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { const value = await probe(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 25)); } assert.fail(`Timed out waiting for ${label}`); }

test("Linux subreaper stop ends shell-backgrounded and detached host processes", { skip: process.platform !== "linux" }, async (t) => {
  const { startLaunch, stopLaunch } = await import("../../dist/server/session/launched-sessions.mjs");
  const project = await actionProject(t, { gates: false });
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-containment-")));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const data = path.join(scratch, "data"), app = path.join(scratch, "app"), bin = path.join(scratch, "bin"), markerFile = path.join(scratch, "marker");
  await Promise.all([mkdir(data), mkdir(app), mkdir(bin)]);
  const host = path.join(bin, "claude");
  const script = ["#!/bin/sh", "while [ \"$#\" -gt 0 ]; do", "  if [ \"$1\" = \"--session-id\" ]; then shift; session_id=$1; fi", "  shift", "done", "(sleep 60) &", "(sh -c 'sleep 60 &' >/dev/null 2>&1 &)", "printf '%s\\n' \"{\\\"type\\\":\\\"system\\\",\\\"subtype\\\":\\\"init\\\",\\\"session_id\\\":\\\"$session_id\\\"}\"", `printf '%s' \"$PRISM_LAUNCH\" > '${markerFile}'`, "while :; do sleep 1; done", ""].join("\n");
  await writeFile(host, script); chmodSync(host, 0o755);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PLUGIN_DATA: data, PRISM_REVIEW_APP_DIR: app, PRISM_REVIEW_BROWSER_ON_START: "off", PRISM_LAUNCH_STOP_GRACE_MS: "100" };
  delete env.CLAUDE_PLUGIN_DATA;
  const { launch } = await startLaunch({ projectRoot: project.root, initiative: INITIATIVE, host: "claude-code", env });
  t.after(async () => { try { await stopLaunch({ id: launch.id, env }); } catch {} });
  const marker = await until(async () => { try { return readFileSync(markerFile, "utf8"); } catch { return null; } }, "shell host startup");
  const pids = await until(() => {
    const found = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const bytes = readFileSync(`/proc/${name}/environ`);
        if (bytes.includes(Buffer.from(`PRISM_LAUNCH=${marker}`)) && readlinkSync(`/proc/${name}/exe`).endsWith("/sleep") && readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ").trim() === "sleep 60") found.push(Number(name));
      } catch {}
    }
    return found.length >= 2 ? found.slice(0, 2) : null;
  }, "marked sleep processes");
  const stopped = await stopLaunch({ id: launch.id, env });
  assert.equal(stopped.state, "stopped");
  for (const pid of pids) await until(() => [null, "Z"].includes(state(pid)), `process ${pid} to end`);
});

test("Linux stop targets include held descendants and exact launch markers, and spare zombies and unrelated work", { skip: process.platform !== "linux" }, () => {
  const launch = "launch-0123456789abcdef";
  const processes = [entry(10, 1), entry(11, 10), entry(12, 1, { launch }), entry(13, 1, { launch: "launch-ffffffffffffffff" }), entry(14, 1, { launch, ended: true })];
  assert.deepEqual(new Set(stopTargets({ platform: "linux", processes, host: 10, supervisor: 1, held: true, launch, spared: [1] })), new Set([10, 11, 12]));
});

test("Windows process listings and stop targets honor job membership and reject stale parent ids", { skip: process.platform !== "win32" }, async () => {
  const table = await listProcesses({ platform: "win32", run: async () => JSON.stringify([{ p: 100, q: 4, s: "100", a: "claude.exe" }, { p: 200, q: 100, s: "200", a: "sleep.exe" }]) });
  assert.equal(table.get(100).pid, 100);
  assert.deepEqual(stopTargets({ platform: "win32", processes: [entry(100, 4), entry(200, 100, { job: true }), entry(300, 100, { started: "50", job: true }), entry(400, 4, { launch: "launch-0123456789abcdef" })], host: 100, supervisor: 4, held: true, launch: "launch-0123456789abcdef", spared: [4] }), [100, 200, 400]);
  const invocation = windowsHostStart({ command: "C:\\host.exe", args: ["exec"], cwd: "C:\\work", job: "Local\\prism-launch-0123456789abcdef-1", env: { PRISM_LAUNCH: "launch-0123456789abcdef" } });
  assert.ok(invocation.command.toLowerCase().endsWith("powershell.exe"));
  assert.ok(invocation.args.includes("-Command"));
});

test("Windows failed containment reports the fixed unavailable reason", { skip: process.platform !== "win32" }, () => {
  assert.deepEqual(stopTargets({ platform: "win32", processes: [entry(10, 1), entry(20, 1, { launch: "launch-0123456789abcdef" })], host: 10, supervisor: 1, held: false, launch: "launch-0123456789abcdef", spared: [] }), [10, 20]);
  assert.equal(stoppedReason({ held: false }), "Stopped, but process containment was unavailable, so a process this session started may still run.");
});

test("macOS process listings read the environment separately from command text", { skip: process.platform !== "darwin" }, async () => {
  const output = "  10 1 Mon Nov 9 10:00:00 2026 /bin/sh PRISM_LAUNCH=launch-0123456789abcdef\n  11 1 Mon Nov 9 10:00:01 2026 /bin/sh launch-0123456789abcdef";
  const table = await listProcesses({ platform: "darwin", run: async () => output });
  assert.equal(table.get(10).launch, "launch-0123456789abcdef");
  assert.equal(table.get(11).launch, null);
  assert.deepEqual(stopTargets({ platform: "darwin", processes: [...table.values()], host: 9, supervisor: 8, held: false, launch: "launch-0123456789abcdef", spared: [] }), [10]);
  assert.equal(stoppedReason({ held: false }), "Stopped, but process containment was unavailable, so a process this session started may still run.");
});

// Keep this test file independent from test fixtures that launch a Node host; every process started by the Linux stub is sh or sleep.
