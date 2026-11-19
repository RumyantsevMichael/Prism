import assert from "node:assert/strict";
import { chmodSync, readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acpAgentHosts } from "../../dist/server/session/acp-agents.mjs";
import { HOST_REQUEST_REFUSAL, hostArguments, hostAvailability, hostConversation, resumeCommandOf } from "../../dist/server/session/launch-hosts.mjs";
import { INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";

// Launched sessions on an Agent Client Protocol agent that the person declared: which entries count, what Prism writes to the
// agent, when it closes the agent's input, and what a run reports.

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const posixOnly = process.platform === "win32" ? "the fake agent runs through a shebang" : false;

async function agentsEnv(t, agents) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "prism-acp-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "acp-agents.json");
  await writeFile(file, JSON.stringify({ agents }));
  return { PATH: process.env.PATH, PRISM_ACP_AGENTS: file };
}

const answer = (id, result) => ({ jsonrpc: "2.0", id, result });
const OPTIONS = [{ id: "mode", category: "mode", currentValue: "ask", options: [] }, { id: "model", category: "model", currentValue: "fake-large", options: [] }];

async function talk(t, entry, options = {}) {
  const env = await agentsEnv(t, [{ id: "fake", label: "Fake agent", command: "/bin/true", ...entry }]);
  const sent = [];
  const state = { closed: 0 };
  const conversation = hostConversation("acp-fake", { initiative: "demo", checkout: "/work/demo", env, ...options, send: (message) => sent.push(message), closeInput: () => { state.closed += 1; } });
  conversation.start();
  const feed = (...lines) => { for (const line of lines) conversation.push(Buffer.from(`${JSON.stringify(line)}\n`)); };
  return { conversation, sent, state, feed, facts: conversation.facts, env };
}

test("only valid agent entries count, in file order, as acp-<id> hosts with their arguments and resume command", async (t) => {
  const env = await agentsEnv(t, [
    { id: "gemini", label: "Gemini CLI", command: "gemini", args: ["--acp"], resumeCommand: "gemini --resume {session}" },
    { id: "Bad Id", label: "x", command: "x" },
    { id: "rel", label: "Relative", command: "./agent" },
    { id: "noprompt", label: "No initiative", command: "x", prompt: "Run it." },
    { id: "gemini", label: "Duplicate", command: "other" },
    { id: "codex", label: "Codex over ACP", command: "/usr/local/bin/codex-acp", options: { mode: "workspace-write" } }
  ]);
  assert.deepEqual(acpAgentHosts(env).map((item) => [item.host, item.label]), [["acp-gemini", "Gemini CLI"], ["acp-codex", "Codex over ACP"]]);
  assert.deepEqual(hostArguments({ host: "acp-gemini", hostSessionId: null, resume: false, env }), ["--acp"]);
  assert.equal(resumeCommandOf("acp-gemini", "s-1", env), "gemini --resume s-1");
  assert.equal(resumeCommandOf("acp-codex", "s-1", env), null);
  const hosts = await hostAvailability({ env: { ...env, PATH: "/nonexistent" } });
  assert.deepEqual(hosts.map((item) => item.host), ["claude-code", "codex", "acp-gemini", "acp-codex"]);
  assert.equal(hosts[2].available, false);
  assert.match(hosts[3].reason, /is no executable file/);
});

test("a missing or broken agents file declares no agent", async (t) => {
  assert.deepEqual(acpAgentHosts({ PRISM_ACP_AGENTS: "/nonexistent/acp-agents.json" }), []);
  const env = await agentsEnv(t, []);
  await writeFile(env.PRISM_ACP_AGENTS, "{not json");
  assert.deepEqual(acpAgentHosts(env), []);
});

test("a launch initializes, opens a session in the checkout, sets the declared options in order, then sends the prompt", async (t) => {
  const named = [];
  const models = [];
  const { sent, feed, facts, state } = await talk(t, { options: { mode: "edit", model: "fake-small" }, prompt: "$prism:orchestrate {initiative}" }, { onSessionId: (id) => named.push(id), onModel: (model) => models.push(model) });
  assert.deepEqual(sent[0], { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "prism-launch", version: "1" } } });
  feed(answer(1, { protocolVersion: 1, agentCapabilities: {} }));
  assert.deepEqual(sent[1].params, { cwd: "/work/demo", mcpServers: [] });
  feed(answer(2, { sessionId: "s-1", configOptions: OPTIONS }));
  assert.deepEqual(named, ["s-1"]);
  assert.deepEqual(sent[2].params, { sessionId: "s-1", configId: "mode", value: "edit" });
  feed(answer(3, { configOptions: OPTIONS }));
  assert.deepEqual(sent[3].params, { sessionId: "s-1", configId: "model", value: "fake-small" });
  feed(answer(4, { configOptions: [OPTIONS[0], { ...OPTIONS[1], currentValue: "fake-small" }] }));
  assert.deepEqual(models, ["fake-small"], "the model is the one the agent reports after the options are set");
  assert.deepEqual(sent[4], { jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId: "s-1", prompt: [{ type: "text", text: "$prism:orchestrate demo" }] } });
  feed({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "usage_update", used: 50, size: 100, cost: { amount: 0.5, currency: "USD" } } } });
  assert.equal(state.closed, 0);
  feed(answer(5, { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, bogus: "x" } }));
  assert.equal(state.closed, 1);
  assert.deepEqual(facts.usage, { contextUsed: 50, contextSize: 100, cost: { amount: 0.5, currency: "USD" }, tokens: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
  assert.equal(facts.hostError, null);
});

test("a run fails before its prompt when the agent does not offer a declared option", async (t) => {
  const { sent, feed, facts, state } = await talk(t, { options: { autonomy: "high" } });
  feed(answer(1, { protocolVersion: 1 }), answer(2, { sessionId: "s-1", configOptions: OPTIONS }));
  assert.equal(sent.some((message) => message.method === "session/prompt"), false);
  assert.equal(state.closed, 1);
  assert.match(facts.hostError, /offers no option autonomy/);
});

test("a permission request is answered cancelled and recorded as a refusal, and any other request is refused", async (t) => {
  const { sent, feed, facts } = await talk(t, {});
  feed(answer(1, { protocolVersion: 1 }), answer(2, { sessionId: "s-1", configOptions: [] }));
  feed({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: { toolCall: { title: "Write probe.txt" }, options: [] } });
  feed({ jsonrpc: "2.0", id: 78, method: "fs/read_text_file", params: { path: "/etc/passwd" } });
  assert.deepEqual(sent.at(-2), { jsonrpc: "2.0", id: 77, result: { outcome: { outcome: "cancelled" } } });
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 78, error: { ...HOST_REQUEST_REFUSAL } });
  assert.equal(facts.refusalCount, 1);
  assert.equal(facts.refusals[0].tool, "Write probe.txt");
});

test("a stop during the prompt sends session/cancel once and closes the input at the prompt's answer; a stop before it closes at once", async (t) => {
  const run = await talk(t, {});
  run.feed(answer(1, { protocolVersion: 1 }), answer(2, { sessionId: "s-1", configOptions: [] }));
  run.conversation.interrupt();
  run.conversation.interrupt();
  assert.deepEqual(run.sent.filter((message) => message.method === "session/cancel"), [{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s-1" } }]);
  assert.equal(run.state.closed, 0);
  run.feed(answer(3, { stopReason: "cancelled" }));
  assert.equal(run.state.closed, 1);
  assert.equal(run.facts.hostError, null);
  const early = await talk(t, {});
  early.conversation.interrupt();
  assert.equal(early.state.closed, 1);
});

test("a resume reopens the kept session with session/resume and sets the declared options again", async (t) => {
  const { sent, feed } = await talk(t, { options: { mode: "edit" } }, { resume: true, hostSessionId: "s-1" });
  feed(answer(1, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }));
  assert.deepEqual([sent[1].method, sent[1].params], ["session/resume", { sessionId: "s-1", cwd: "/work/demo", mcpServers: [] }]);
  feed(answer(2, { configOptions: OPTIONS }));
  assert.deepEqual(sent[2].params, { sessionId: "s-1", configId: "mode", value: "edit" });
});

test("an agent that speaks another protocol version, or answers a request with an error, fails the run with its message", async (t) => {
  const other = await talk(t, {});
  other.feed(answer(1, { protocolVersion: 2 }));
  assert.match(other.facts.hostError, /ACP version 2/);
  const failing = await talk(t, {});
  failing.feed(answer(1, { protocolVersion: 1 }), { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Authentication required" } });
  assert.equal(failing.facts.hostError, "Authentication required");
  assert.equal(failing.state.closed, 1);
});

test("a launch on a declared ACP agent runs it in the checkout, records its session, usage, and refusal, and resumes it", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t);
  const agentLog = path.join(path.dirname(fixture.log), "fake-acp.jsonl");
  const agent = path.join(fixture.bin, "fake-acp");
  await writeFile(agent, `#!${process.execPath}\nimport(${JSON.stringify(FAKE)});\n`);
  chmodSync(agent, 0o755);
  const agentsFile = path.join(path.dirname(fixture.log), "acp-agents.json");
  await writeFile(agentsFile, JSON.stringify({ agents: [{ id: "fake", label: "Fake agent", command: agent, args: ["--acp"], prompt: "Please write for {initiative}.", options: { mode: "edit" }, resumeCommand: "fake --resume {session}" }] }));
  const env = { ...fixture.env, PRISM_ACP_AGENTS: agentsFile, FAKE_ACP_LOG: agentLog };
  const { startLaunch, resumeLaunch, launchRunStatus } = await import("../../dist/server/session/launched-sessions.mjs");
  const { launchFolder, readLaunchRecord } = await import("../../dist/server/session/launch-records.mjs");
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "acp-fake", env });
  assert.equal(launch.hostLabel, "Fake agent");
  await waitFor(async () => (await launchRunStatus({ id: launch.id, env })) === "ended", { what: "the ACP run to end" });
  const entries = () => (existsSync(agentLog) ? readFileSync(agentLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const start = entries().find((entry) => entry.kind === "start");
  assert.deepEqual(start.argv, ["--acp"]);
  assert.equal(start.cwd, fixture.root);
  assert.deepEqual(entries().filter((entry) => entry.kind === "input" && entry.message.method).map((entry) => entry.message.method), ["initialize", "session/new", "session/set_config_option", "session/prompt"]);
  assert.ok(entries().some((entry) => entry.kind === "closed"), "the agent's input closed after the prompt was answered");
  const record = await readLaunchRecord(launchFolder(env, launch.id));
  assert.equal(record.hostSessionId, "fake-session-1");
  const [run] = record.runs;
  assert.deepEqual(run.exit, { code: 0, signal: null });
  assert.equal(run.model, "fake-large");
  assert.equal(run.refusalCount, 1);
  assert.deepEqual(run.usage, { contextUsed: 500, contextSize: 1000, cost: { amount: 0.25, currency: "USD" }, tokens: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
  const resumed = await resumeLaunch({ id: launch.id, env });
  assert.equal(resumed.state, "running");
  await waitFor(async () => (await launchRunStatus({ id: launch.id, env })) === "ended", { what: "the resumed run to end" });
  assert.ok(entries().some((entry) => entry.message?.method === "session/resume" && entry.message.params.sessionId === "fake-session-1"));
  const ended = (await readLaunchRecord(launchFolder(env, launch.id))).runs;
  assert.equal(ended.length, 2);
});
