import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, TARGET, acpFixture, apply, fakeEntry, launches, runOptions, setSettings } from "./fixtures/acp-agents.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/acp-agents.md §3 and §16.
// Prism learns that an ACP agent started its server from the token in the server's arguments, so an agent that starts the server
// through other processes, or gives it its own environment in place of the env of the mcpServers entry, still runs Prism's workflow.

const posixOnly = process.platform === "win32" ? "the fake agent runs through a shebang" : false;
const HOST = "acp-gemini";
const TOKEN = /^--prism-acp-token=[0-9a-f]{32}$/;

async function gemini(t, plan) {
  const s = await acpFixture(t, { plans: { gemini: plan } });
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" })]);
  return s;
}
const markers = (s) => path.join(s.app, "options-reads");
const leftMarkers = (s) => (existsSync(markers(s)) ? readdirSync(markers(s)) : []);

const STARTS = [
  ["through a wrapper process", { mcpVia: "wrapper" }],
  ["outside the agent's own processes", { mcpVia: "detached" }],
  ["without the env of its mcpServers entry", { mcpEnv: "inherit" }],
  ["outside the agent's own processes and without that env", { mcpVia: "detached", mcpEnv: "inherit" }]
];
for (const [name, plan] of STARTS) {
  test(`a read is ready when the agent starts Prism's server ${name}`, { skip: posixOnly }, async (t) => {
    const s = await gemini(t, plan);
    const read = await runOptions(s, HOST);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual([read.json.state, read.json.reason], ["ready", null]);
    const [opened] = s.requests("session/new");
    assert.match(opened.params.mcpServers[0].args.at(-1), TOKEN);
    assert.equal(statSync(markers(s)).mode & 0o777, 0o700);
    assert.deepEqual(await settled(() => leftMarkers(s), []), [], "the read removed the marker it found");
  });
}

test("a launched run prompts when the agent starts Prism's server outside its own processes and without the env of its entry", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { mcpVia: "detached", mcpEnv: "inherit" });
  await setSettings(s.root, INITIATIVE, { host: HOST });
  const result = await apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: {}, revision: null }, s.headers);
  assert.equal(result.status, 200, result.text);
  const id = result.json.launch.id;
  const view = await settled(async () => (await launches(s)).find((item) => item.id === id), (item) => item && !["running", "waiting"].includes(item.state));
  assert.equal(view.state, "finished", view.reason);
  assert.equal(s.requests("session/prompt").length, 1);
  // The read of run options before the launch opened the first session, and each names a token of its own.
  const [read, launched] = s.requests("session/new").map((message) => message.params.mcpServers[0]);
  assert.match(launched.args.at(-1), TOKEN);
  assert.notEqual(launched.args.at(-1), read.args.at(-1));
  assert.equal(launched.env.find((item) => item.name === "PRISM_LAUNCH").value, id);
});
