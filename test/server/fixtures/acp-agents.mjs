// A fake Agent Client Protocol agent, a declaration file, and a review server for the ACP agent tests.
// The fake agent speaks ACP version 1 over its standard input and output and follows the plan that FAKE_ACP_PLAN names for the
// agent named by its first argument, so a test drives an agent without any model; it logs what it reads to FAKE_ACP_LOG.
// It starts each stdio MCP server that session/new or session/resume names, as real agents do, and lists that server's tools.
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchFixture } from "./launched-sessions.mjs";
import { actionOf, apply, get, listing, pageSession, startActionReview } from "./review-actions.mjs";

export { INITIATIVE } from "./review-actions.mjs";
export { actionOf, apply, get, listing };

// A plan, per agent name: { protocolVersion = 1, authRequired, authMethods = [], startMcp = true, embeddedContext = true,
// close = true, resume = true, load = false, configOptions, efforts: { <model>: [<level>] }, permission: { title, kind, options, rawInput },
// hold, stopReason = "end_turn", stderr: [<line>], exitBeforeAnswer: <code>, usage, usageUpdate, askFs, mcpEnv: "inherit", mcpVia: "wrapper" | "detached" }.
export const DEFAULT_OPTIONS = Object.freeze([
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }, { value: "auto", name: "Auto", description: "The agent decides permissions" }, { value: "bypassPermissions", name: "Bypass", description: "Accepts all permissions" }] },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "fake-large", options: [{ value: "fake-large", name: "Fake Large", description: "The big one" }, { value: "fake-small", name: "Fake Small", description: "The quick one" }] },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "high", name: "High" }, { value: "low", name: "Low" }, { value: "medium", name: "Medium" }] },
  { id: "fast", name: "Fast", category: "model_config", type: "select", currentValue: "off", options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] }
]);

// The launchers through which the fake agent can start an MCP server, each run as `node -e <launcher> <command> <args...>` with the
// agent's pipes as its standard streams. "wrapper" stays the server's parent, as a shell or an npm launcher does. "detached" stays
// alive without reading its input and starts the server through a helper that exits at once, so the server no longer descends from
// the agent at all; it exits once the agent is gone.
const START = 'require("node:child_process").spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit" })';
const LAUNCHERS = Object.freeze({
  wrapper: `${START}.on("exit", (code) => process.exit(code ?? 0));`,
  detached: `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(`${START}.unref(); process.exit(0);`)}, ...process.argv.slice(1)], { stdio: "inherit" }); const parent = process.ppid; setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 200);`
});

const AGENT = String.raw`#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const name = process.argv[2] ?? "fake";
const log = (entry) => fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify({ agent: name, pid: process.pid, ...entry }) + "\n");
let plan = {};
try { plan = JSON.parse(fs.readFileSync(process.env.FAKE_ACP_PLAN, "utf8"))[name] ?? {}; } catch {}
const watched = ["PRISM_LAUNCH", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "FAKE_DECLARED"];
log({ kind: "start", argv: process.argv.slice(3), cwd: process.cwd(), env: Object.fromEntries(watched.map((key) => [key, process.env[key] ?? null])) });
for (const line of plan.stderr ?? []) process.stderr.write(line + "\n");
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let options = JSON.parse(process.env.FAKE_ACP_OPTIONS);
if (plan.configOptions) options = plan.configOptions;
const efforts = plan.efforts ?? {};
const servers = [];
const LAUNCHERS = ${JSON.stringify(LAUNCHERS)};
function startServers(list) {
  for (const server of list ?? []) {
    if (plan.startMcp === false) continue;
    // mcpEnv "inherit" ignores the env of the mcpServers entry and passes the agent's own environment, as some agents do.
    const env = plan.mcpEnv === "inherit" ? { ...process.env } : { PATH: process.env.PATH, HOME: process.env.HOME ?? "" };
    if (plan.mcpEnv !== "inherit") for (const item of server.env ?? []) env[item.name] = item.value;
    // mcpVia names a launcher of LAUNCHERS that starts the server, so the server is no child of the agent.
    const [command, args] = LAUNCHERS[plan.mcpVia] ? [process.execPath, ["-e", LAUNCHERS[plan.mcpVia], server.command, ...(server.args ?? [])]] : [server.command, server.args ?? []];
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "ignore"] });
    servers.push(child);
    let buffer = "";
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }); }
        else if (message.id === 2) log({ kind: "mcp", server: server.name, tools: (message.result?.tools ?? []).map((tool) => tool.name) });
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agent", version: "1" } } });
  }
}
let held = null;
let asking = null;
let nextAsk = 5000;
const answer = (id, result) => out({ jsonrpc: "2.0", id, result });
const finish = (id, stopReason) => answer(id, { stopReason, ...(plan.usage === null ? {} : { usage: plan.usage ?? { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }) });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    log({ kind: "input", message });
    const { id, method, params } = message;
    if (method === undefined) {
      if (asking && id === asking.ask) { log({ kind: "permission-answer", outcome: message.result?.outcome ?? null }); const prompt = asking.prompt; asking = null; if (held === null) finish(prompt, plan.stopReason ?? "end_turn"); }
      continue;
    }
    if (method === "initialize") answer(id, { protocolVersion: plan.protocolVersion ?? 1, agentCapabilities: { loadSession: plan.load === true, promptCapabilities: { embeddedContext: plan.embeddedContext !== false }, sessionCapabilities: { ...(plan.close === false ? {} : { close: {} }), ...(plan.resume === false ? {} : { resume: {} }) } }, authMethods: plan.authMethods ?? [] });
    else if (method === "session/new") {
      if (plan.authRequired) { out({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required" } }); continue; }
      startServers(params.mcpServers);
      answer(id, { sessionId: "fake-session-1", configOptions: options });
    } else if (method === "session/resume" || method === "session/load") { startServers(params.mcpServers); answer(id, { configOptions: options }); }
    else if (method === "session/set_config_option") {
      const option = options.find((item) => item.id === params.configId);
      if (!option || !option.options.some((value) => value.value === params.value)) { out({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } }); continue; }
      options = options.map((item) => (item.id === params.configId ? { ...item, currentValue: params.value } : item));
      if (option.category === "model" && efforts[params.value]) options = options.map((item) => (item.category === "thought_level" ? { ...item, options: efforts[params.value].map((level) => ({ value: level, name: level })) } : item));
      answer(id, { configOptions: options });
    } else if (method === "session/close") answer(id, {});
    else if (method === "session/prompt") {
      if (plan.usageUpdate !== null) out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "usage_update", ...(plan.usageUpdate ?? { used: 500, size: 1000, cost: { amount: 0.25, currency: "USD" } }) } } });
      if (plan.askFs) out({ jsonrpc: "2.0", id: 4000, method: "fs/read_text_file", params: { sessionId: params.sessionId, path: "/etc/hosts" } });
      if (plan.exitBeforeAnswer !== undefined) { setTimeout(() => process.exit(plan.exitBeforeAnswer), 50); continue; }
      if (plan.hold) held = id;
      if (plan.permission) {
        asking = { ask: nextAsk++, prompt: id };
        out({ jsonrpc: "2.0", id: asking.ask, method: "session/request_permission", params: { sessionId: params.sessionId, toolCall: { toolCallId: "t1", title: plan.permission.title ?? "Write probe.txt", kind: plan.permission.kind ?? "edit", ...(plan.permission.rawInput === undefined ? {} : { rawInput: plan.permission.rawInput }) }, options: plan.permission.options ?? [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } });
      } else if (!plan.hold) finish(id, plan.stopReason ?? "end_turn");
    } else if (method === "session/cancel") {
      if (held !== null) { finish(held, "cancelled"); held = null; }
    } else if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
});
process.stdin.on("end", () => {
  log({ kind: "closed" });
  for (const child of servers) try { child.kill(); } catch {}
  setTimeout(() => process.exit(0), 20);
});
`;

/**
 * launchFixture's project, private review app folder, controlled PATH, and confirming native dialog stub, a fake ACP agent at
 * `agent` on PATH as `fake-acp`, and a review server whose process environment names the declaration file.
 * declare(entries) writes the declaration file, setPlan(plans) the fake agent's plans by agent name, and entries() the agent log.
 */
export async function acpFixture(context, { agents = [], plans = {}, dialog = { code: 0 }, hosts = ["claude", "codex"], options = DEFAULT_OPTIONS } = {}) {
  const fixture = await launchFixture(context, { hosts, dialog });
  const scratch = path.dirname(fixture.log);
  const agent = path.join(fixture.bin, "fake-acp");
  await writeFile(agent, AGENT);
  chmodSync(agent, 0o755);
  const declarations = path.join(scratch, "acp-agents.json");
  const planFile = path.join(scratch, "acp-plans.json");
  const agentLog = path.join(scratch, "acp-agent.jsonl");
  const declare = (entries) => writeFile(declarations, JSON.stringify({ agents: entries }));
  const setPlan = (value) => writeFile(planFile, JSON.stringify(value));
  await declare(agents);
  await setPlan(plans);
  const env = { ...fixture.env, PRISM_ACP_AGENTS: declarations, FAKE_ACP_PLAN: planFile, FAKE_ACP_LOG: agentLog, FAKE_ACP_OPTIONS: JSON.stringify(options), PRISM_RUN_OPTIONS_TIMEOUT_MS: "20000" };
  Object.assign(fixture.env, env);
  fixture.useAsProcessEnv();
  const { review, base, opened } = await startActionReview(context, fixture.root);
  const headers = await pageSession(review, opened);
  const entries = () => (existsSync(agentLog) ? readFileSync(agentLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  /** The messages with a method that the agent read, in order, optionally of one method. */
  const requests = (method = null) => entries().filter((entry) => entry.kind === "input" && entry.message.method && (!method || entry.message.method === method)).map((entry) => entry.message);
  return { ...fixture, env, base, headers, review, opened, agent, declarations, declare, setPlan, entries, requests };
}

/** A declaration entry for the fake agent under `name`, which its first argument names. */
export const fakeEntry = (fixture, name, extra = {}) => ({ id: name, label: `${name[0].toUpperCase()}${name.slice(1)} agent`, command: fixture.agent, args: [name], ...extra });

/** An install record of a registry agent as clause 54 lays it out, pointing at the fake agent. */
export async function installRecord(fixture, { id, name, version, installedAt = "2026-11-19T10:00:00.000Z" }) {
  const folder = path.join(fixture.app, "agents", id, version);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "install.json"), JSON.stringify({ id, name, version, authors: ["Fake Authors"], license: "MIT", source: "https://example.invalid/fake", distribution: "binary", command: fixture.agent, args: [id], env: {}, installedAt }));
  await writeFile(path.join(fixture.app, "agents", id, "current.json"), JSON.stringify({ version }));
  return folder;
}

export const TARGET = (initiative) => `initiative:${initiative}`;

/** Sets the initiative's settings in its coordination state, as the Settings actions store them. */
export async function setSettings(root, initiative, value) {
  const { readCoordinationState, updateCoordinationState } = await import("../../../dist/server/workflow/state.mjs");
  const read = await readCoordinationState({ projectRoot: root, initiative });
  await updateCoordinationState({ projectRoot: root, initiative, expectedRevision: read.exists ? read.revision : null, changes: { settings: value } });
}

/** The run options report of a host for a purpose, with an optional selection. */
export async function runOptions(fixture, host, purpose = "coordinator", selection = {}) {
  const query = new URLSearchParams({ host, for: purpose, ...selection });
  return get(fixture.base, `api/run-options?${query}`, fixture.headers);
}

/** Every launched session view of this machine. */
export async function launches(fixture) {
  return (await get(fixture.base, "api/launches")).json?.launches ?? [];
}
