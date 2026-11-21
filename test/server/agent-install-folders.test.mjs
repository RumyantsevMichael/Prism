import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installAgent, sweepUnusedVersions } from "../../dist/server/session/agent-installs.mjs";
import { INITIATIVE, TARGET, acpFixture, apply, get, setSettings } from "./fixtures/acp-agents.mjs";
import { binaryAgent, platformKey, registryFixture } from "./fixtures/acp-registry.mjs";
import { settled } from "./fixtures/wait.mjs";

// The folders and the machine lock of registry installs: a version folder that a launched session runs on is never replaced, the one
// install slot is never taken by two processes, and each install keeps to a staging folder of its own.

const posixOnly = process.platform === "win32" ? "the fake agent is a POSIX script" : false;
const agents = (s) => path.join(s.app, "agents");
const act = (s, action, id) => apply(s.base, { action, target: `agent:${id}`, input: {}, revision: null }, s.headers);
const current = (s, id) => JSON.parse(readFileSync(path.join(agents(s), id, "current.json"), "utf8")).version;

test("an update back to a version whose folder a running session uses is refused and keeps that folder", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t, { dialog: { code: 0 } });
  const registry = await registryFixture(t, s);
  const first = await binaryAgent(s, registry, { id: "opencode", version: "1.0.0" });
  registry.setAgents([first]);
  assert.equal((await act(s, "agents.install", "opencode")).status, 200);
  await s.setPlan({ opencode: { hold: true } });
  await setSettings(s.root, INITIATIVE, { host: "acp-opencode" });
  const launched = await apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: {}, revision: null }, s.headers);
  assert.equal(launched.status, 200, launched.text);
  await settled(() => s.requests("session/prompt").length, 1);
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode", version: "1.1.0" })]);
  assert.equal((await act(s, "agents.update", "opencode")).status, 200);
  assert.equal(current(s, "opencode"), "1.1.0");
  // The registry lists 1.0.0 again, with a checksum that would fail if it were downloaded.
  const listed = first.distribution.binary[platformKey()];
  registry.setAgents([{ ...first, distribution: { binary: { [platformKey()]: { ...listed, sha256: "1".repeat(64) } } } }]);
  const back = await act(s, "agents.update", "opencode");
  assert.equal(back.json?.code, "agent_running", back.text);
  assert.ok(existsSync(path.join(agents(s), "opencode", "1.0.0", "agent")), "the folder of the version a running session uses stays");
  assert.equal(current(s, "opencode"), "1.1.0");
  await apply(s.base, { action: "launch.stop", target: `launch:${launched.json.launch.id}`, input: {}, revision: null }, s.headers);
});

const launch = (s) => apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: {}, revision: null }, s.headers);
const stop = (s, id) => apply(s.base, { action: "launch.stop", target: `launch:${id}`, input: {}, revision: null }, s.headers);
const stateOf = async (s, id) => (await get(s.base, "api/launches")).json.launches.find((item) => item.id === id)?.state;

test("a session on the new version neither keeps the earlier version's folder nor blocks an update back to it", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t, { dialog: { code: 0 } });
  const registry = await registryFixture(t, s);
  const first = await binaryAgent(s, registry, { id: "opencode", version: "1.0.0" });
  registry.setAgents([first]);
  assert.equal((await act(s, "agents.install", "opencode")).status, 200);
  await s.setPlan({ opencode: { hold: true } });
  await setSettings(s.root, INITIATIVE, { host: "acp-opencode" });
  const older = await launch(s);
  assert.equal(older.status, 200, older.text);
  await settled(() => s.requests("session/prompt").length, 1);
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode", version: "1.1.0" })]);
  assert.equal((await act(s, "agents.update", "opencode")).status, 200);
  assert.ok(existsSync(path.join(agents(s), "opencode", "1.0.0", "agent")), "the version the running session uses stays");
  await stop(s, older.json.launch.id);
  await settled(() => stateOf(s, older.json.launch.id), "stopped");
  const newer = await launch(s);
  assert.equal(newer.status, 200, newer.text);
  await settled(() => s.requests("session/prompt").length, 2);
  await settled(() => existsSync(path.join(agents(s), "opencode", "1.0.0")), false);
  assert.equal(existsSync(path.join(agents(s), "opencode", "1.0.0")), false, "no session runs on 1.0.0 any more");
  registry.setAgents([first]);
  const back = await act(s, "agents.update", "opencode");
  assert.equal(back.status, 200, back.text);
  assert.equal(current(s, "opencode"), "1.0.0");
  assert.ok(existsSync(path.join(agents(s), "opencode", "1.1.0", "agent")), "the version the running session uses stays");
  await stop(s, newer.json.launch.id);
  await settled(() => stateOf(s, newer.json.launch.id), "stopped");
});

test("an earlier version is removed after its session ends although the process that updated the agent ended first", { skip: posixOnly }, async (t) => {
  const s = await acpFixture(t, { dialog: { code: 0 } });
  const registry = await registryFixture(t, s);
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode", version: "1.0.0" })]);
  assert.equal((await act(s, "agents.install", "opencode")).status, 200);
  await s.setPlan({ opencode: { hold: true } });
  await setSettings(s.root, INITIATIVE, { host: "acp-opencode" });
  const launched = await launch(s);
  assert.equal(launched.status, 200, launched.text);
  await settled(() => s.requests("session/prompt").length, 1);
  registry.setAgents([await binaryAgent(s, registry, { id: "opencode", version: "1.1.0" })]);
  const module = new URL("../../dist/server/session/agent-installs.mjs", import.meta.url).href;
  const updater = spawn(process.execPath, ["--input-type=module", "-e", `const { updateAgent } = await import(${JSON.stringify(module)}); await updateAgent({ id: "opencode", confirm: async () => {} });`], { env: { ...process.env, ...s.env }, stdio: ["ignore", "ignore", "inherit"] });
  assert.equal(await new Promise((done) => updater.on("close", done)), 0);
  assert.equal(current(s, "opencode"), "1.1.0");
  assert.ok(existsSync(path.join(agents(s), "opencode", "1.0.0", "agent")), "the version the running session uses stays");
  await stop(s, launched.json.launch.id);
  await settled(() => stateOf(s, launched.json.launch.id), "stopped");
  await settled(() => existsSync(path.join(agents(s), "opencode", "1.0.0")), false);
  assert.equal(existsSync(path.join(agents(s), "opencode", "1.0.0")), false);
});

test("a sweep by any process removes the earlier versions that no session runs on, and keeps the current one", async (t) => {
  const { app, env } = await appFolder(t);
  const folder = path.join(app, "agents", "opencode");
  for (const version of ["1.0.0", "1.1.0", "2.0.0"]) await mkdir(path.join(folder, version), { recursive: true });
  await writeFile(path.join(folder, "current.json"), JSON.stringify({ version: "2.0.0" }));
  await sweepUnusedVersions(env);
  assert.deepEqual(readdirSync(folder).sort(), ["2.0.0", "current.json"]);
  assert.deepEqual(readdirSync(path.join(app, "agents")).sort(), ["opencode"], "no lock or staging folder is left");
});

async function appFolder(t) {
  const app = await mkdtemp(path.join(os.tmpdir(), "prism-install-lock-"));
  t.after(() => rm(app, { recursive: true, force: true }));
  await mkdir(path.join(app, "agents"), { recursive: true });
  // A registry that cannot be reached locally, so an install that takes the slot stops right after, before any download.
  return { app, env: { ...process.env, PRISM_REVIEW_APP_DIR: app, PRISM_ACP_REGISTRY_URL: "http://127.0.0.1:1/registry.json" } };
}

const install = (env) => installAgent({ id: "opencode", env, confirm: async () => { throw new Error("no dialog in this test"); } }).then(() => null, (error) => error.code ?? error.message);

test("a lock that is still being written counts as held, and stays", async (t) => {
  const { app, env } = await appFolder(t);
  const lock = path.join(app, "agents", ".install.lock");
  await writeFile(lock, "");
  assert.equal(await install(env), "install_running");
  await writeFile(lock, '{"pid":');
  assert.equal(await install(env), "install_running");
  assert.ok(existsSync(lock), "a lock that cannot be read whole is not removed");
});

test("a lock whose process on this computer ended is taken, and released after the install", async (t) => {
  const { app, env } = await appFolder(t);
  const ended = spawnSync(process.execPath, ["-e", "0"]).pid;
  const lock = path.join(app, "agents", ".install.lock");
  await writeFile(lock, `${JSON.stringify({ pid: ended, host: os.hostname(), startedAt: new Date().toISOString() })}\n`);
  assert.equal(await install(env), "action_unavailable");
  assert.equal(existsSync(lock), false);
  // A live holder of this computer keeps its lock.
  await writeFile(lock, `${JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: new Date().toISOString() })}\n`);
  assert.equal(await install(env), "install_running");
});

test("an install removes what ended installs left in staging, but not a staging folder whose process runs", async (t) => {
  const { app, env } = await appFolder(t);
  const staging = path.join(app, "agents", ".staging");
  const ended = spawnSync(process.execPath, ["-e", "0"]).pid;
  const live = `${process.ppid}-${"a".repeat(16)}`;
  await mkdir(path.join(staging, live), { recursive: true });
  await mkdir(path.join(staging, `${ended}-${"b".repeat(16)}`), { recursive: true });
  await writeFile(path.join(staging, "download"), "left");
  assert.equal(await install(env), "action_unavailable");
  assert.deepEqual(readdirSync(staging), [live]);
  assert.deepEqual(readdirSync(path.join(app, "agents")).sort(), [".staging"], "no lock or temporary lock file is left");
});

test("a launch that is starting keeps every version folder until its run records the version it starts on", { skip: posixOnly }, async (t) => {
  const { app, env } = await appFolder(t);
  const folder = path.join(app, "agents", "opencode");
  const started = path.join(app, "agent-started");
  const layOut = async (version) => {
    await mkdir(path.join(folder, version), { recursive: true });
    const agent = path.join(folder, version, "agent");
    await writeFile(agent, `#!/bin/sh\necho ${version} > "${started}"\n`);
    await chmod(agent, 0o755);
    return JSON.stringify({ id: "opencode", name: "OpenCode", version, distribution: "binary", command: agent, args: [], env: {}, installedAt: "2026-11-19T10:00:00.000Z" });
  };
  const earlier = await layOut("1.0.0");
  // The earlier version's install record is a named pipe, so the supervisor stops right after it read that 1.0.0 is current, and goes
  // on only once this test writes the record: the window between choosing a version and recording the run is held open, not raced.
  const record = path.join(folder, "1.0.0", "install.json");
  assert.equal(spawnSync("mkfifo", [record]).status, 0);
  await writeFile(path.join(folder, "current.json"), JSON.stringify({ version: "1.0.0" }));
  const checkout = await mkdtemp(path.join(os.tmpdir(), "prism-starting-checkout-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const id = `launch-${"c".repeat(16)}`;
  const launchFolder = path.join(app, "launches", id);
  await mkdir(launchFolder, { recursive: true, mode: 0o700 });
  const launchRecord = () => JSON.parse(readFileSync(path.join(launchFolder, "launch.json"), "utf8"));
  await writeFile(path.join(launchFolder, "launch.json"), JSON.stringify({ id, initiative: "starting", host: "acp-opencode", checkout, store: "test", createdAt: new Date().toISOString(), hostSessionId: null, coordinator: { provider: null, model: null, effort: null, typed: false }, runs: [] }));
  const supervisorFile = new URL("../../dist/server/session/launch-supervisor.mjs", import.meta.url).pathname;
  const supervisor = spawn(process.execPath, [supervisorFile, launchFolder, "launch", "a".repeat(16)], { cwd: checkout, env: { ...env, PRISM_ACP_AGENTS: path.join(app, "no-declarations.json") }, stdio: "ignore" });
  const exited = new Promise((done) => supervisor.on("close", done));
  t.after(() => supervisor.kill());
  // A writer opens without blocking only once the supervisor is reading the pipe, so it has chosen 1.0.0 and not yet recorded its run.
  let writer = null;
  while (writer === null) {
    try { writer = openSync(record, constants.O_WRONLY | constants.O_NONBLOCK); } catch (error) { if (error.code !== "ENXIO") throw error; await new Promise((done) => setTimeout(done, 20)); }
  }
  assert.equal(launchRecord().runs.length, 0);
  // An update to 1.1.0 finishes now, and a sweep runs in the window.
  await writeFile(path.join(folder, "1.1.0", "install.json"), await layOut("1.1.0"));
  await writeFile(path.join(folder, "current.json"), JSON.stringify({ version: "1.1.0" }));
  await sweepUnusedVersions(env);
  assert.ok(existsSync(path.join(folder, "1.0.0", "agent")), "the version folder that a starting launch chose stays");
  writeSync(writer, earlier);
  closeSync(writer);
  await exited;
  const run = launchRecord().runs[0];
  assert.equal(run?.agentVersion, "1.0.0", JSON.stringify(launchRecord()));
  assert.equal(readFileSync(started, "utf8").trim(), "1.0.0", "the agent started from the version folder it chose");
  assert.equal(launchRecord().starting, undefined, "the run record replaced the start's mark");
  assert.equal(existsSync(path.join(folder, "1.0.0")), false, "once the run ended, its version went in the supervisor's own sweep");
});
