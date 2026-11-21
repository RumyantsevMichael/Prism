import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installAgent } from "../../dist/server/session/agent-installs.mjs";
import { INITIATIVE, TARGET, acpFixture, apply, setSettings } from "./fixtures/acp-agents.mjs";
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
