import assert from "node:assert/strict";
import test from "node:test";
import { INITIATIVE, TARGET, acpFixture, actionOf, apply, fakeEntry, listing, runOptions, setSettings } from "./fixtures/acp-agents.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/acp-agents.md §3 and §15, docs/requirements/launch-run-configuration.md §18, and
// docs/requirements/launched-sessions.md §29.
// Contract clauses 10 to 17 of docs/plans/harness-client-protocol/slice.md: how Prism reads an ACP agent's run options without a
// turn, which options it offers, and how an agent that cannot run Prism's workflow or needs a sign-in reads.

const posixOnly = process.platform === "win32" ? "the fake agent runs through a shebang" : false;
const HOST = "acp-gemini";
const values = (report, id) => report.options.find((option) => option.id === id)?.values.map((value) => value.value);

async function gemini(t, plan = {}) {
  const s = await acpFixture(t, { plans: { gemini: plan } });
  await s.declare([fakeEntry(s, "gemini", { label: "Gemini CLI" })]);
  return s;
}

test("clause 10: a read opens one session in the checkout with Prism's server, never prompts or authenticates, and reports ready", { skip: posixOnly }, async (t) => {
  const s = await gemini(t);
  const read = await runOptions(s, HOST);
  assert.equal(read.status, 200, read.text);
  assert.deepEqual([read.json.host, read.json.label, read.json.state, read.json.reason], [HOST, "Gemini CLI", "ready", null]);
  const [initialize] = s.requests("initialize");
  assert.deepEqual(initialize.params, { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "prism-options", version: "1" } });
  const [opened] = s.requests("session/new");
  assert.equal(opened.params.cwd, s.root);
  assert.deepEqual(opened.params.mcpServers.map((server) => server.name), ["prism"]);
  assert.deepEqual(s.requests("session/prompt"), []);
  assert.deepEqual(s.requests("authenticate"), []);
  assert.ok(s.entries().some((entry) => entry.kind === "mcp" && entry.server === "prism" && entry.tools.includes("get_skill")), "the agent listed Prism's tools");
});

test("clause 11: a model selection is set in the reading session before efforts are reported, and the session is closed when the agent can", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { efforts: { "fake-small": ["low"] } });
  const read = await runOptions(s, HOST, "coordinator", { model: "fake-small" });
  assert.deepEqual(s.requests("session/set_config_option").map((message) => [message.params.configId, message.params.value]), [["model", "fake-small"]]);
  assert.deepEqual(values(read.json, "effort"), [null, "low"]);
  assert.equal(s.requests("session/close").length, 1);
  await settled(() => s.entries().some((entry) => entry.kind === "closed"), true);
  assert.ok(s.entries().some((entry) => entry.kind === "closed"), "the agent's input closed after the read");
});

test("clause 11: an agent that cannot close a session is sent no session/close and still has its input closed", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { close: false });
  assert.equal((await runOptions(s, HOST)).json.state, "ready");
  assert.deepEqual(s.requests("session/close"), []);
  await settled(() => s.entries().some((entry) => entry.kind === "closed"), true);
  assert.ok(s.entries().some((entry) => entry.kind === "closed"));
});

test("clause 12: the model and thought_level options become model and effort, efforts lowest first, and every other option is left out", { skip: posixOnly }, async (t) => {
  const s = await gemini(t);
  const report = (await runOptions(s, HOST)).json;
  assert.deepEqual(report.options.map((option) => option.id), ["model", "effort"]);
  assert.deepEqual(values(report, "model"), [null, "fake-large", "fake-small"]);
  assert.deepEqual(report.options[0].values.slice(1).map((value) => [value.name, value.description]), [["Fake Large", "The big one"], ["Fake Small", "The quick one"]]);
  assert.deepEqual(values(report, "effort"), [null, "low", "medium", "high"]);
});

test("clause 13: for child agents an ACP agent offers only its default model and effort and says why", { skip: posixOnly }, async (t) => {
  const s = await gemini(t);
  const report = (await runOptions(s, HOST, "agents")).json;
  assert.deepEqual(values(report, "model"), [null]);
  assert.deepEqual(values(report, "effort"), [null]);
  assert.equal(report.options.find((option) => option.id === "model").values[0].description, "Gemini CLI chooses the models of its own child agents.");
});

test("clause 14: an agent that speaks another ACP version reads failed with both versions", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { protocolVersion: 2 });
  const report = (await runOptions(s, HOST)).json;
  assert.deepEqual([report.state, report.reason], ["failed", "Gemini CLI speaks ACP version 2, and Prism speaks version 1."]);
});

test("clause 15: an agent that needs a sign-in reads sign-in with its own methods, and Prism never authenticates", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { authRequired: true, authMethods: [{ id: "oauth", name: "Google login", description: "Run gemini and choose Login with Google" }, { id: "key", name: "API key" }] });
  const report = (await runOptions(s, HOST)).json;
  assert.deepEqual([report.state, report.reason], ["sign-in", "Gemini CLI needs you to sign in before it can run: Google login (Run gemini and choose Login with Google), API key."]);
  assert.deepEqual(s.requests("authenticate"), []);
  const bare = await gemini(t, { authRequired: true });
  assert.equal((await runOptions(bare, HOST)).json.reason, "Gemini CLI needs you to sign in before it can run: sign in with the agent's own command.");
});

test("clause 16: an agent whose session does not start Prism's server reads failed, since it cannot run Prism's workflow", { skip: posixOnly }, async (t) => {
  const s = await gemini(t, { startMcp: false });
  const report = (await runOptions(s, HOST)).json;
  assert.deepEqual([report.state, report.reason], ["failed", "Gemini CLI did not start Prism's tools, so it cannot run Prism's workflow."]);
});

test("clause 17: while the initiative's ACP host reads failed or sign-in, the launch is unavailable with that reason and asks nothing", { skip: posixOnly }, async (t) => {
  for (const [plan, reason] of [[{ startMcp: false }, "Gemini CLI did not start Prism's tools, so it cannot run Prism's workflow."], [{ authRequired: true }, "Gemini CLI needs you to sign in before it can run: sign in with the agent's own command."]]) {
    const s = await gemini(t, plan);
    await setSettings(s.root, INITIATIVE, { host: HOST });
    const action = actionOf(await listing(s.base, TARGET(INITIATIVE), s.headers), "launch.run");
    assert.deepEqual([action.available, action.reason], [false, reason]);
    const refused = await apply(s.base, { action: "launch.run", target: TARGET(INITIATIVE), input: {}, revision: null }, s.headers);
    assert.deepEqual([refused.status, refused.json.code], [409, "action_unavailable"]);
    assert.deepEqual(s.dialogs(), [], "no confirmation was asked");
    assert.deepEqual(s.requests("session/prompt"), []);
  }
});
