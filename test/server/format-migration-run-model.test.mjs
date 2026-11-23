import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT, formatProject } from "./fixtures/artifact-formats.mjs";
import { entryFor, readRun, runFor, serve, stubHosts, waitFor } from "./fixtures/format-migration-runs.mjs";

// While no host and model are chosen for Prism's own runs, a format migration run starts with Codex and its GPT-6 Luna model where Codex lists it,
// and otherwise on the first available host with a small model it lists, Claude Code's Haiku, or the host's default model when it lists none.
// The run's Prism server, which the host starts, keeps the review app folder and state folders of the Prism that launched the run.
// Every host here is a stub on a PATH that holds no real Claude Code or Codex.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const BROKEN = { ...CONFORMING, [PATHS.requirements]: REQUIREMENT.replace('<a id="2"></a>\n', "") };
const SERVER_ENV = ["LOCALAPPDATA", "NODE_USE_ENV_PROXY", "PRISM_LAUNCH", "PRISM_MIGRATION_PROJECT", "PRISM_MIGRATION_RUN", "PRISM_REVIEW_APP_DIR", "XDG_STATE_HOME"];

const model = (id, extra = {}) => ({ id, model: id, displayName: id, description: "", hidden: false, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }], ...extra });
const LUNA = [model("gpt-5.5", { isDefault: true }), model("gpt-6-sol"), model("gpt-6-luna"), model("gpt-5.4-mini")];
const SMALL = [model("gpt-5.5", { isDefault: true }), model("gpt-5.6-terra"), model("gpt-5.6-luna"), model("gpt-5.4-mini"), model("gpt-hidden-luna", { hidden: true })];
const LARGE = [model("gpt-5.5", { isDefault: true }), model("gpt-6-sol")];

// A Codex app server stub that lists the models of PRISM_STUB_CODEX_CATALOG for its one provider, opens a thread, and holds its turn
// until its input closes, logging as the launched-session stubs do: one { kind: "run" } entry per process and one { kind: "input" } per message.
const CODEX = String.raw`#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
const log = (entry) => appendFileSync(process.env.PRISM_STUB_LOG, JSON.stringify({ host: "codex", pid: process.pid, ...entry }) + "\n");
const env = Object.fromEntries(["PRISM_LAUNCH", "PRISM_MIGRATION_RUN", "PRISM_MIGRATION_PROJECT"].map((name) => [name, process.env[name] ?? null]));
log({ kind: "run", argv, cwd: process.cwd(), env, children: [] });
if (argv[0] !== "app-server") { process.stderr.write("error: this stub runs only as codex app-server\n"); process.exit(2); }
let models = [];
try { models = JSON.parse(readFileSync(process.env.PRISM_STUB_CODEX_CATALOG, "utf8")); } catch {}
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let started = false;
const answer = (message) => {
  const { id, method, params } = message;
  if (method === "initialize") { started = true; write({ id, result: { userAgent: "codex-stub/0" } }); return; }
  if (method === "initialized" || id === undefined) return;
  if (method === "modelProvider/list") { write({ id, result: { data: [{ id: "openai", name: "OpenAI" }], defaultProviderId: "openai", canChangeDefault: false } }); return; }
  if (method === "model/list") { write({ id, result: { data: models.filter((entry) => params?.includeHidden || !entry.hidden), nextCursor: null } }); return; }
  if (method === "thread/start") { write({ id, result: { thread: { id: "01a1c2bc-3a0f-7690-9e2f-4d3f9be316a4" }, model: params?.model ?? "gpt-5.5" } }); return; }
  if (method === "turn/start") { write({ id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } }); return; }
  write({ id, error: { code: -32600, message: "Unknown method " + method + "." } });
};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    log({ kind: "input", message });
    answer(message);
  }
});
process.stdin.on("end", () => { log({ kind: "closed", results: 0, interrupted: false }); setTimeout(() => process.exit(started ? 0 : 1), 20); });
process.stdin.on("error", () => {});
`;

/**
 * A checkout with the broken requirement and one Prism server that sees the stub hosts: Claude Code's stub when claude is true, and a Codex stub
 * that lists `models` when models is given, with XDG_STATE_HOME and LOCALAPPDATA set in the launching Prism's environment: { root, call, hosts, state, local }.
 */
async function checkoutWith(context, { claude = true, models = null, choice = null } = {}) {
  const hosts = await stubHosts(context, { hosts: claude ? ["claude"] : [] });
  const scratch = path.dirname(hosts.app);
  if (models) {
    const catalog = path.join(scratch, "codex-models.json");
    await writeFile(catalog, JSON.stringify(models));
    await writeFile(path.join(hosts.bin, "codex"), CODEX);
    chmodSync(path.join(hosts.bin, "codex"), 0o755);
    hosts.env.PRISM_STUB_CODEX_CATALOG = catalog;
  }
  const state = path.join(scratch, "state");
  const local = path.join(scratch, "local-app-data");
  Object.assign(hosts.env, { XDG_STATE_HOME: state, LOCALAPPDATA: local });
  if (choice) {
    const { writePrismRunsChoice } = await import("../../dist/server/session/prism-runs.mjs");
    await writePrismRunsChoice({ choice: { provider: null, model: null, effort: null, typed: false, ...choice }, by: "test", revision: "none", env: { ...process.env, PRISM_REVIEW_APP_DIR: hosts.app } });
  }
  const root = await formatProject(context, BROKEN);
  const call = await serve(context, root, hosts);
  return { root, call, hosts, state, local };
}

const launched = async (call, run) => waitFor(async () => {
  const record = await readRun(call, run);
  return record.launch?.host ? record : null;
}, { what: `the run ${run} to launch` });
// The Codex run that opened the run's thread, and that thread's start and turn requests.
const codexThread = async (hosts) => waitFor(() => {
  for (const run of hosts.runs("codex")) {
    const inputs = hosts.inputs(run.pid);
    const thread = inputs.find((message) => message.method === "thread/start");
    const turn = inputs.find((message) => message.method === "turn/start");
    if (thread && turn) return { run, thread, turn };
  }
  return null;
}, { what: "the Codex thread of the run" });
const threads = (hosts) => hosts.runs("codex").filter((run) => hosts.inputs(run.pid).some((message) => message.method === "thread/start"));
const claudeRun = (hosts) => waitFor(() => hosts.runs("claude")[0] ?? null, { what: "the Claude Code stub to start" });
const optionValue = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);

test("clauses 1, 2, 6: with no choice and Codex listing gpt-6-luna, the run starts Codex with that model though Claude Code comes first, and its Prism server keeps the launching Prism's folders", { skip: posixOnly }, async (context) => {
  const { call, hosts, state, local } = await checkoutWith(context, { models: LUNA });
  const run = await runFor(call, PATHS.requirements);
  const record = await launched(call, run);
  assert.equal(record.launch.host, "codex");
  const { thread, turn } = await codexThread(hosts);
  assert.equal(thread.params.model, "gpt-6-luna");
  assert.equal("modelProvider" in thread.params, false, "Codex's default provider lists the model");
  assert.equal("effort" in turn.params, false, "the model's own default effort");
  assert.equal(hosts.runs("claude").length, 0, "Claude Code starts no session");
  assert.equal(threads(hosts).length, 1, "one thread of the run starts");
  const server = thread.params.config.mcp_servers["prism-run"];
  assert.deepEqual(Object.keys(server.env).sort(), SERVER_ENV);
  assert.equal(server.env.PRISM_LAUNCH, record.launch.id);
  assert.equal(server.env.PRISM_REVIEW_APP_DIR, hosts.app);
  assert.equal(server.env.XDG_STATE_HOME, state);
  assert.equal(server.env.LOCALAPPDATA, local);
  assert.equal(server.env.PRISM_MIGRATION_RUN, run);
  assert.equal((await entryFor(call, PATHS.requirements)).migration.reason, null, "a run on the default host and model needs no reason");
});

test("clauses 3, 6: with no choice and Codex listing no gpt-6-luna, the run starts Claude Code with --model haiku, and its Prism server keeps the launching Prism's folders", { skip: posixOnly }, async (context) => {
  const { call, hosts, state, local } = await checkoutWith(context, { models: SMALL });
  const run = await runFor(call, PATHS.requirements);
  const record = await launched(call, run);
  assert.equal(record.launch.host, "claude-code");
  const started = await claudeRun(hosts);
  assert.equal(optionValue(started.argv, "--model"), "haiku");
  assert.equal(started.argv.includes("--effort"), false);
  assert.equal(threads(hosts).length, 0, "Codex opens no thread");
  const mcp = JSON.parse(await readFile(optionValue(started.argv, "--mcp-config"), "utf8"));
  const server = mcp.mcpServers["prism-run"];
  assert.deepEqual(Object.keys(server.env).sort(), SERVER_ENV);
  assert.equal(server.env.PRISM_LAUNCH, record.launch.id);
  assert.equal(server.env.PRISM_REVIEW_APP_DIR, hosts.app);
  assert.equal(server.env.XDG_STATE_HOME, state);
  assert.equal(server.env.LOCALAPPDATA, local);
});

test("clause 3: with no choice and Claude Code alone, the run starts Claude Code with --model haiku", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await checkoutWith(context);
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await launched(call, run)).launch.host, "claude-code");
  assert.equal(optionValue((await claudeRun(hosts)).argv, "--model"), "haiku");
});

test("clause 3: with no choice and Codex alone without gpt-6-luna, the run starts Codex with the first model it lists whose name ends in -luna or -mini", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await checkoutWith(context, { claude: false, models: SMALL });
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await launched(call, run)).launch.host, "codex");
  const { thread } = await codexThread(hosts);
  assert.equal(thread.params.model, "gpt-5.6-luna");
});

test("clause 3: with no choice and Codex alone listing no small model, the run starts Codex with its own default model", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await checkoutWith(context, { claude: false, models: LARGE });
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await launched(call, run)).launch.host, "codex");
  const { thread } = await codexThread(hosts);
  assert.equal("model" in thread.params, false, "Codex's own default model");
});

test("clause 4: a stored choice of Any available host starts the run as no choice does", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await checkoutWith(context, { models: LUNA, choice: { host: "automatic" } });
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await launched(call, run)).launch.host, "codex");
  assert.equal((await codexThread(hosts)).thread.params.model, "gpt-6-luna");
});

test("clause 5: a chosen host that is found wins with its own model choice, and Prism reads no Codex model list for it", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await checkoutWith(context, { models: LUNA, choice: { host: "claude-code" } });
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await launched(call, run)).launch.host, "claude-code");
  assert.equal((await claudeRun(hosts)).argv.includes("--model"), false, "the chosen host's default model");
  assert.equal(hosts.runs("codex").length, 0, "Codex is not started, not even to list its models");
});

test("clause 5: a chosen Codex model wins over gpt-6-luna", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await checkoutWith(context, { models: LUNA, choice: { host: "codex", model: "gpt-6-sol" } });
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await launched(call, run)).launch.host, "codex");
  assert.equal((await codexThread(hosts)).thread.params.model, "gpt-6-sol");
  assert.equal(hosts.runs("codex").length, 1, "only the run's own app server starts");
});

test("clause 7: Settings says what Any available host starts, and refuses a model for it in those words", { skip: posixOnly }, async (context) => {
  const { actionOf, apply, listing, runOptionsReview } = await import("./fixtures/run-options-hosts.mjs");
  const s = await runOptionsReview(context, { hosts: ["claude"] });
  const current = async () => actionOf(await listing(s.base, "machine:prism-runs", s.headers), "machine.prismRuns");
  const automatic = (await current()).fields[0].options.find((option) => option.value === "automatic");
  assert.equal(automatic.consequence, "Each run starts with Codex and its GPT-6 Luna model where Codex lists it, and otherwise on the first host Prism finds on this computer with a small model.");
  const input = { host: "automatic", provider: null, run: { model: "fable", effort: null, typed: false } };
  const refused = await apply(s.base, { action: "machine.prismRuns", target: "machine:prism-runs", input, revision: (await current()).revision }, s.headers);
  assert.equal(refused.status, 400);
  assert.equal(refused.json.field, "run");
  assert.equal(refused.json.message, "Any available host chooses its model itself.");
});
