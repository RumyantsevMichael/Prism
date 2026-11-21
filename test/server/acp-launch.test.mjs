import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPTIONS, INITIATIVE, TARGET, acpFixture, apply, fakeEntry, launches, setSettings } from "./fixtures/acp-agents.mjs";
import { STRIPPED } from "./fixtures/launched-sessions.mjs";
import { WAIT_MS, settled } from "./fixtures/wait.mjs";
import { LAUNCH_NOTE } from "../../dist/server/session/launch-hosts.mjs";

// Requirements: docs/requirements/acp-agents.md §1, §2, and §16, and docs/requirements/launched-sessions.md §29.
// Contract clauses 18 to 23 and 25 to 31 of docs/plans/harness-client-protocol/slice.md: a launched session on an ACP agent gets
// Prism's server and the orchestrate skill's text, runs in the agent's automatic mode with the coordinator's choice, and reports
// its usage, its stop, its failures, and its terminal command.

const posixOnly = process.platform === "win32" ? "the fake agent runs through a shebang" : false;
const HOST = "acp-gemini";
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL = readFileSync(path.join(PLUGIN, "skills/orchestrate/SKILL.md"), "utf8");
const INSTRUCTION = `Run the Prism skill orchestrate in the attached resource for the initiative ${INITIATIVE}. Prism's skills are not installed in this agent: read every other Prism skill or reference file that a skill names with Prism's get_skill tool.`;

async function gemini(t, { plan = {}, entry = {}, settings = {} } = {}) {
  const s = await acpFixture(t, { plans: { gemini: plan } });
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI", ...entry })]);
  await setSettings(s.root, INITIATIVE, { host: HOST, ...settings });
  return s;
}
const launch = async (s) => {
  const result = await apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: {}, revision: null }, s.headers);
  assert.equal(result.status, 200, result.text);
  return result.json.launch.id;
};
const view = async (s, id) => (await launches(s)).find((item) => item.id === id);
const ended = (s, id) => settled(() => view(s, id), (item) => item && !["running", "waiting"].includes(item.state));
// Clause 17 has Prism read the agent's run options before a launch, which starts the agent without PRISM_LAUNCH, so the
// launched run's log is that of the agent processes whose PRISM_LAUNCH is set.
const launchedLog = (s) => {
  const all = s.entries();
  const pids = new Set(all.filter((entry) => entry.kind === "start" && entry.env.PRISM_LAUNCH !== null).map((entry) => entry.pid));
  return all.filter((entry) => pids.has(entry.pid));
};
const sent = (s, method = null) => launchedLog(s).filter((entry) => entry.kind === "input" && entry.message.method && (!method || entry.message.method === method)).map((entry) => entry.message);
const configSet = (s) => sent(s, "session/set_config_option").map((message) => [message.params.configId, message.params.value]);

test("clauses 18, 19: a launch starts the agent in the checkout without host session variables and passes only Prism's server", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { entry: { args: ["gemini", "--acp"], env: { FAKE_DECLARED: "declared" } } });
  const id = await launch(s);
  await ended(s, id);
  const start = launchedLog(s).find((entry) => entry.kind === "start");
  assert.deepEqual(start.argv, ["--acp"]);
  assert.equal(start.cwd, s.root);
  assert.equal(start.env.PRISM_LAUNCH, id);
  assert.equal(start.env.FAKE_DECLARED, "declared");
  for (const name of STRIPPED.filter((key) => key in start.env)) assert.equal(start.env[name], null, `${name} is stripped`);
  const [initialize] = sent(s, "initialize");
  assert.deepEqual(initialize.params.clientInfo, { name: "prism-launch", version: "1" });
  const [opened] = sent(s, "session/new");
  assert.equal(opened.params.cwd, s.root);
  assert.equal(opened.params.mcpServers.length, 1);
  const [server] = opened.params.mcpServers;
  assert.equal(server.name, "prism");
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, [path.join(PLUGIN, "dist/server/mcp.mjs")]);
  assert.deepEqual(server.env.map((item) => item.name).sort(), ["NODE_USE_ENV_PROXY", "PRISM_LAUNCH", "PRISM_REVIEW_APP_DIR"]);
  assert.equal(server.env.find((item) => item.name === "PRISM_LAUNCH").value, id);
  assert.equal(server.env.find((item) => item.name === "NODE_USE_ENV_PROXY").value, "1");
});

test("clauses 20, 21: the run sets the automatic mode, then the coordinator's model and effort, before its prompt", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { settings: { models: { [HOST]: { coordinator: { model: "fake-small", effort: "low" } } } } });
  await ended(s, await launch(s));
  assert.deepEqual(configSet(s), [["mode", "auto"], ["model", "fake-small"], ["effort", "low"]]);
  const order = sent(s).map((message) => message.method);
  assert.ok(order.lastIndexOf("session/set_config_option") < order.indexOf("session/prompt"));
});

test("clause 21: a declared autoMode wins, an agent without an automatic mode keeps its own, and a bypass value is never set", { skip: posixOnly }, async (t) => {
  const declared = await gemini(t, { entry: { autoMode: "ask" } });
  await ended(declared, await launch(declared));
  assert.deepEqual(configSet(declared), [["mode", "ask"]]);
  const modes = [{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }, { value: "yolo", name: "Yolo", description: "Accepts all permissions" }] }];
  const none = await gemini(t, { plan: { configOptions: modes } });
  await ended(none, await launch(none));
  assert.deepEqual(configSet(none), [], "no mode is set when the agent has no automatic mode");
  const bypass = await gemini(t, { entry: { autoMode: "bypassPermissions" } });
  await ended(bypass, await launch(bypass));
  assert.ok(!configSet(bypass).some(([, value]) => value === "bypassPermissions"));
});

test("clause 20: a recorded value the agent no longer offers fails the resume before its prompt and names it", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { settings: { models: { [HOST]: { coordinator: { model: "fake-small" } } } } });
  const id = await launch(s);
  await ended(s, id);
  const large = DEFAULT_OPTIONS.map((option) => (option.id === "model" ? { ...option, options: option.options.filter((value) => value.value === "fake-large") } : option));
  await s.setPlan({ gemini: { configOptions: large } });
  await apply(s.base, { action: "launch.resume", target: `launch:${id}`, input: {}, revision: null }, s.headers);
  const result = await settled(() => view(s, id), (item) => item?.state === "failed");
  assert.match(result.reason, /Gemini CLI does not offer fake-small for Model\./);
  assert.equal(sent(s, "session/prompt").length, 1, "the resume sent no prompt");
});

test("clause 22: an agent that never starts Prism's server ends without a prompt and says it cannot run Prism's workflow", { skip: posixOnly }, async (t) => {
  // The agent starts Prism's server for the options read of clause 17, so the launch is allowed, and not for the launched run,
  // which then waits the 60 seconds of clause 22.
  const s = await acpFixture(t, { plans: { gemini: {}, "gemini-launched": { startMcp: false } } });
  const wrapper = path.join(path.dirname(s.log), "gemini-wrapper");
  writeFileSync(wrapper, `#!/bin/sh\nif [ -n "$PRISM_LAUNCH" ]; then exec "${s.agent}" gemini-launched; fi\nexec "${s.agent}" gemini\n`);
  chmodSync(wrapper, 0o755);
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI", command: wrapper, args: [] })]);
  await setSettings(s.root, INITIATIVE, { host: HOST });
  const id = await launch(s);
  const result = await settled(() => view(s, id), (item) => item && !["running", "waiting"].includes(item.state), { timeout: 60000 + WAIT_MS });
  assert.equal(result.state, "failed");
  assert.match(result.reason, /Gemini CLI did not start Prism's tools, so it cannot run Prism's workflow\./);
  assert.ok(launchedLog(s).some((entry) => entry.kind === "start" && entry.agent === "gemini-launched"), "the launched run is the agent that never starts Prism's server");
  assert.deepEqual(sent(s, "session/prompt"), []);
});

test("clause 23: the prompt carries the orchestrate skill as a resource and the fixed instruction, or the skill as text", { skip: posixOnly }, async (t) => {
  const s = await gemini(t);
  await ended(s, await launch(s));
  const [prompt] = sent(s, "session/prompt");
  assert.deepEqual(prompt.params.prompt, [
    { type: "resource", resource: { uri: "prism://skills/orchestrate/SKILL.md", mimeType: "text/markdown", text: SKILL } },
    { type: "text", text: INSTRUCTION },
    { type: "text", text: LAUNCH_NOTE }
  ]);
  const plain = await gemini(t, { plan: { embeddedContext: false } });
  await ended(plain, await launch(plain));
  assert.deepEqual(sent(plain, "session/prompt")[0].params.prompt, [{ type: "text", text: SKILL }, { type: "text", text: INSTRUCTION }, { type: "text", text: LAUNCH_NOTE }]);
});

test("clause 25: a resume reopens the session with Prism's server, sets the recorded choice again, and prompts again", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { settings: { models: { [HOST]: { coordinator: { model: "fake-small" } } } } });
  const id = await launch(s);
  await ended(s, id);
  await setSettings(s.root, INITIATIVE, { host: HOST, models: { [HOST]: { coordinator: { model: "fake-large" } } } });
  const resumed = await apply(s.base, { action: "launch.resume", target: `launch:${id}`, input: {}, revision: null }, s.headers);
  assert.equal(resumed.status, 200, resumed.text);
  await settled(async () => sent(s, "session/prompt").length, (count) => count === 2);
  await ended(s, id);
  const [reopened] = sent(s, "session/resume");
  assert.deepEqual([reopened.params.sessionId, reopened.params.cwd, reopened.params.mcpServers.map((server) => server.name)], ["fake-session-1", s.root, ["prism"]]);
  assert.deepEqual(configSet(s), [["mode", "auto"], ["model", "fake-small"], ["mode", "auto"], ["model", "fake-small"]], "the resume uses the choice recorded at launch");
  assert.equal(sent(s, "session/prompt").length, 2);
});

test("clause 25: an agent without resume falls back to session/load, and one with neither fails the resume", { skip: posixOnly }, async (t) => {
  const load = await gemini(t, { plan: { resume: false, load: true } });
  const id = await launch(load);
  await ended(load, id);
  await apply(load.base, { action: "launch.resume", target: `launch:${id}`, input: {}, revision: null }, load.headers);
  await settled(() => sent(load, "session/load").length, 1);
  assert.equal(sent(load, "session/load").length, 1);
  const neither = await gemini(t, { plan: { resume: false, load: false } });
  const other = await launch(neither);
  await ended(neither, other);
  await apply(neither.base, { action: "launch.resume", target: `launch:${other}`, input: {}, revision: null }, neither.headers);
  const result = await settled(() => view(neither, other), (item) => item?.state === "failed");
  assert.match(result.reason, /Gemini CLI cannot resume a session\./);
});

test("clause 26: a file system request from the agent is refused, and the run still ends", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { plan: { askFs: true } });
  const result = await ended(s, await launch(s));
  assert.equal(result.state, "finished");
  const answer = launchedLog(s).find((entry) => entry.kind === "input" && entry.message.id === 4000 && !entry.message.method);
  assert.deepEqual(answer.message.error, { code: -32601, message: "Prism answers no host requests." });
  assert.deepEqual(sent(s, "initialize")[0].params.clientCapabilities, {});
});

test("clause 27: a stop during the prompt sends session/cancel once, and the session shows stopped", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { plan: { hold: true } });
  const id = await launch(s);
  await settled(() => sent(s, "session/prompt").length, 1);
  const stopped = await apply(s.base, { action: "launch.stop", target: `launch:${id}`, input: {}, revision: null }, s.headers);
  assert.equal(stopped.status, 200, stopped.text);
  const result = await ended(s, id);
  assert.equal(result.state, "stopped");
  assert.equal(sent(s, "session/cancel").length, 1);
});

test("clause 28: a refusal stop reason, and an agent that exits before its answer, fail the run with the reason", { skip: posixOnly }, async (t) => {
  const refused = await gemini(t, { plan: { stopReason: "refusal" } });
  const result = await ended(refused, await launch(refused));
  assert.equal(result.state, "failed");
  assert.match(result.reason, /Gemini CLI stopped: refusal\./);
  const exited = await gemini(t, { plan: { exitBeforeAnswer: 3 } });
  const crashed = await ended(exited, await launch(exited));
  assert.equal(crashed.state, "failed");
  assert.match(crashed.reason, /exit code 3/);
});

test("clause 29: a run shows the tokens, context, and cost the agent reported, and null for what it did not", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { plan: { usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 5, totalTokens: 17, bogus: 9 }, usageUpdate: { used: 500, size: 1000, cost: { amount: 0.25, currency: "USD" } } } });
  const result = await ended(s, await launch(s));
  assert.deepEqual(result.usage, { tokens: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 5, totalTokens: 17 }, context: { used: 500, size: 1000 }, cost: { amount: 0.25, currency: "USD" } });
  const silent = await gemini(t, { plan: { usage: null, usageUpdate: null } });
  assert.deepEqual((await ended(silent, await launch(silent))).usage, { tokens: null, context: null, cost: null });
});

test("clause 30: a failed run's reason is the last stderr line that is no stack frame, and the stderr tail is kept privately", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { plan: { exitBeforeAnswer: 1, stderr: ["Starting agent fake-session-1", "Error: the model gemini-9 is not available", "    at Object.run (/agent/main.js:10:5)", "    at process.next (node:internal/1:2:3)"] } });
  const id = await launch(s);
  const result = await ended(s, id);
  assert.equal(result.state, "failed");
  assert.match(result.reason, /Error: the model gemini-9 is not available/);
  const folder = path.join(s.app, "launches", id);
  const kept = readdirSync(folder).filter((name) => name.endsWith(".stderr"));
  assert.equal(kept.length, 1);
  const text = readFileSync(path.join(folder, kept[0]), "utf8");
  assert.match(text, /at Object\.run/);
  assert.doesNotMatch(text, /fake-session-1/, "the host session id is redacted");
});

test("clause 31: the terminal command is the declared resumeCommand, and an agent without one shows none", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { entry: { resumeCommand: "gemini --resume {session}" } });
  const result = await ended(s, await launch(s));
  assert.deepEqual(result.resumeCommand, { command: "gemini --resume fake-session-1", cwd: s.root });
  const plain = await gemini(t);
  assert.equal((await ended(plain, await launch(plain))).resumeCommand, null);
  assert.ok(existsSync(plain.declarations));
});
