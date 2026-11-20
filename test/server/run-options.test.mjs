import assert from "node:assert/strict";
import test from "node:test";
import { optionOf, runOptions, runOptionsReview, valuesOf } from "./fixtures/run-options-hosts.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/launch-run-configuration.md §2, §4, §5, §7.
// The run options of each host, read from the host itself through GET <base>/api/run-options, in one ordered shape.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const READ_ONLY = /^This tab can only read\./;
const read = (s, query, headers = s.headers) => runOptions(s.base, query, headers);

test("clause 1: run options answer only the page's write session and start nothing without it", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const refused = await read(s, { host: "claude-code", for: "coordinator" }, {});
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "write_forbidden");
  assert.match(refused.json.message, READ_ONLY);
  assert.equal(s.runs().length, 0, "no host process starts for a tab that can only read");
});

test("clause 2: a query names a supported host and coordinator or agents, and a model, provider, or effort keeps to its rule", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const unknown = await read(s, { host: "gemini", for: "coordinator" });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, "unknown_host");
  assert.equal(unknown.json.message, "Prism supports no host gemini; it supports claude-code and codex.");
  for (const query of [{ host: "claude-code" }, { host: "claude-code", for: "child" }]) {
    const bad = await read(s, query);
    assert.equal(bad.status, 400);
    assert.deepEqual([bad.json.code, bad.json.message], ["invalid_request", "for must be coordinator or agents."]);
  }
  for (const [field, value] of [["model", "-p"], ["model", "x".repeat(201)], ["model", "has space"], ["provider", "../x"], ["effort", "High!"]]) {
    const bad = await read(s, { host: "claude-code", for: "coordinator", [field]: value });
    assert.equal(bad.status, 400, `${field} ${value} is refused`);
    assert.equal(bad.json.code, "invalid_input");
    assert.equal(bad.json.field, field);
  }
  const fine = await read(s, { host: "claude-code", for: "coordinator", model: "us.anthropic.claude-opus-4-8[1m]", typed: 1 });
  assert.equal(fine.status, 200, "a model name may hold letters, digits, and . _ - : / @ [ ] +");
  assert.equal(s.optionReads().length, 1, "refused queries start no host");
});

test("clause 3: a host that is not found on this computer answers unavailable with its reason and starts nothing", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: ["claude"] });
  const answer = await read(s, { host: "codex", for: "coordinator" });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json, { host: "codex", label: "Codex", state: "unavailable", reason: "Codex was not found: no codex executable on PATH.", options: [] });
  assert.equal(s.runs().length, 0);
});

test("clause 4: the options are provider, model, and effort in that order, and nothing else a host reports", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const claude = (await read(s, { host: "claude-code", for: "coordinator" })).json;
  assert.deepEqual(Object.keys(claude).sort(), ["host", "label", "options", "reason", "state"]);
  assert.deepEqual([claude.host, claude.label, claude.state, claude.reason], ["claude-code", "Claude Code", "ready", null]);
  assert.deepEqual(claude.options.map((option) => [option.id, option.name, option.kind]), [["model", "Model", "model"], ["effort", "Effort", "effort"]], "Claude Code reports no provider, and its permission mode, fast mode, output styles, and agents are no options");
  assert.deepEqual(Object.keys(optionOf(claude, "model")).sort(), ["chosen", "id", "kind", "name", "reportedNone", "values"]);
  assert.deepEqual(Object.keys(optionOf(claude, "effort")).sort(), ["chosen", "id", "kind", "name", "values"]);
  const codex = (await read(s, { host: "codex", for: "coordinator" })).json;
  assert.deepEqual(codex.options.map((option) => option.id), ["provider", "model", "effort"]);
  const agents = (await read(s, { host: "codex", for: "agents" })).json;
  assert.deepEqual(agents.options.map((option) => option.id), ["model", "effort"], "child agents take the coordinator's provider");
});

test("clause 5: every option starts with the host default as a null value, and each value has a value, a name, and a description", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  for (const [host, purpose] of [["claude-code", "coordinator"], ["claude-code", "agents"], ["codex", "coordinator"], ["codex", "agents"]]) {
    const report = (await read(s, { host, for: purpose })).json;
    for (const option of report.options) {
      assert.equal(option.values[0].value, null, `${host} ${purpose} ${option.id}`);
      assert.equal(option.values[0].name, "Host default");
      for (const entry of option.values) {
        assert.deepEqual(Object.keys(entry).sort(), ["description", "name", "value"]);
        assert.equal(typeof entry.name, "string");
        assert.equal(typeof entry.description, "string");
      }
    }
  }
});

test("clause 6: Claude Code's coordinator models are its own default, then each model in the order it reports, without a value no command line may take", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const model = optionOf((await read(s, { host: "claude-code", for: "coordinator" })).json, "model");
  assert.deepEqual(model.values, [
    { value: null, name: "Host default", description: "Opus 5.5 · Best for everyday, complex tasks" },
    { value: "opus", name: "Opus 5.5", description: "Best for everyday, complex tasks" },
    { value: "fable", name: "Fable 5.2", description: "Most capable for your hardest and longest-running tasks" },
    { value: "sonnet", name: "Sonnet 5.5", description: "Efficient for routine tasks" },
    { value: "haiku", name: "Haiku 5.5", description: "Fastest for quick answers" },
    { value: "claude-opus-4-6", name: "Opus 4.6", description: "Earlier version" },
    { value: "claude-haiku-4-5-20251001", name: "Haiku 4.5", description: "Fastest for quick answers" }
  ]);
  assert.equal(model.reportedNone, false);
});

test("clause 7: Claude Code's child agents take the model families its agent tool names, in the order it reports them", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const model = optionOf((await read(s, { host: "claude-code", for: "agents" })).json, "model");
  assert.deepEqual(model.values, [
    { value: null, name: "Host default", description: "The coordinator's model, unless the host's settings name a model for agents." },
    { value: "opus", name: "Opus 5.5", description: "Best for everyday, complex tasks" },
    { value: "fable", name: "Fable 5.2", description: "Most capable for your hardest and longest-running tasks" },
    { value: "sonnet", name: "Sonnet 5.5", description: "Efficient for routine tasks" },
    { value: "haiku", name: "Haiku 5.5", description: "Fastest for quick answers" }
  ]);
});

test("clause 8: Codex's coordinator offers its providers and the visible models of the chosen provider over every page", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const report = (await read(s, { host: "codex", for: "coordinator" })).json;
  assert.deepEqual(optionOf(report, "provider").values, [
    { value: null, name: "Host default", description: "OpenAI" },
    { value: "openai", name: "OpenAI", description: "" },
    { value: "local", name: "Local server", description: "" }
  ]);
  assert.deepEqual(optionOf(report, "model").values, [
    { value: null, name: "Host default", description: "GPT-5.5" },
    { value: "gpt-5.5", name: "GPT-5.5", description: "Frontier coding model" },
    { value: "gpt-6-luna", name: "GPT-6 Luna", description: "Newest model" }
  ], "a hidden model is left out");
  const lists = s.optionReads("codex").flatMap((run) => s.inputs(run.pid)).filter((message) => message.method === "model/list");
  assert.ok(lists.length >= 2, "the second page is read with the cursor of the first");
  assert.ok(lists.every((message) => message.params.includeHidden === false));
  assert.ok(lists.some((message) => message.params.cursor === "1"));
  assert.ok(lists.every((message) => !("modelProvider" in message.params) || message.params.modelProvider === null), "the host default provider names none");
  const local = (await read(s, { host: "codex", for: "coordinator", provider: "local" })).json;
  assert.ok(s.optionReads("codex").flatMap((run) => s.inputs(run.pid)).some((message) => message.method === "model/list" && message.params.modelProvider === "local"));
  assert.deepEqual(valuesOf(local, "model"), [null]);
});

test("clause 9: Codex's child agents take the models of the chosen provider and no provider of their own", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const report = (await read(s, { host: "codex", for: "agents" })).json;
  assert.deepEqual(optionOf(report, "model").values, [
    { value: null, name: "Host default", description: "The coordinator's model." },
    { value: "gpt-5.5", name: "GPT-5.5", description: "Frontier coding model" },
    { value: "gpt-6-luna", name: "GPT-6 Luna", description: "Newest model" }
  ]);
});

test("clause 10: effort levels follow the chosen model, from the lowest to the highest, with the host's own default first", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const claude = async (query) => optionOf((await read(s, { host: "claude-code", ...query })).json, "effort");
  const byDefault = await claude({ for: "coordinator" });
  assert.deepEqual(byDefault.values, [
    { value: null, name: "Host default", description: "The effort Claude Code uses when none is chosen." },
    { value: "low", name: "Low", description: "" },
    { value: "medium", name: "Medium", description: "" },
    { value: "high", name: "High", description: "" },
    { value: "xhigh", name: "Extra high", description: "" },
    { value: "max", name: "Max", description: "" }
  ]);
  assert.deepEqual((await claude({ for: "coordinator", model: "claude-opus-4-6" })).values.map((entry) => entry.value), [null, "low", "medium", "high", "max"]);
  assert.deepEqual((await claude({ for: "coordinator", model: "claude-haiku-4-5-20251001" })).values.map((entry) => entry.value), [null], "a model without effort levels takes only the host default");
  assert.deepEqual((await claude({ for: "coordinator", model: "my-proxy-model", typed: 1 })).values.map((entry) => entry.value), [null, "low", "medium", "high", "xhigh", "max"], "a typed model offers every level the host reports");
  assert.deepEqual((await claude({ for: "agents", model: "haiku" })).values.map((entry) => entry.value), [null, "low", "medium", "high", "xhigh", "max"]);
  const codex = optionOf((await read(s, { host: "codex", for: "coordinator", model: "gpt-6-luna" })).json, "effort");
  assert.deepEqual(codex.values, [
    { value: null, name: "Host default", description: "High, the model's default." },
    { value: "minimal", name: "Minimal", description: "Least reasoning" },
    { value: "low", name: "Low", description: "Fast responses" },
    { value: "high", name: "High", description: "Deeper reasoning" },
    { value: "max", name: "Max", description: "Most reasoning" }
  ], "levels the host reports out of order are ordered from the lowest to the highest");
  assert.equal(optionOf((await read(s, { host: "codex", for: "coordinator" })).json, "effort").values[0].description, "Medium, the model's default.");
});

test("clause 11: each option marks the chosen value as offered, typed, or not offered, with the reason", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const claude = (await read(s, { host: "claude-code", for: "coordinator" })).json;
  assert.deepEqual(optionOf(claude, "model").chosen, { value: null, state: "offered", reason: null });
  assert.deepEqual(optionOf(claude, "effort").chosen, { value: null, state: "offered", reason: null });
  const offered = (await read(s, { host: "claude-code", for: "coordinator", model: "fable", effort: "high" })).json;
  assert.deepEqual(optionOf(offered, "model").chosen, { value: "fable", state: "offered", reason: null });
  assert.deepEqual(optionOf(offered, "effort").chosen, { value: "high", state: "offered", reason: null });
  const gone = (await read(s, { host: "claude-code", for: "coordinator", model: "claude-opus-3", effort: "max" })).json;
  assert.deepEqual(optionOf(gone, "model").chosen, { value: "claude-opus-3", state: "not-offered", reason: "Claude Code on this computer does not offer the model claude-opus-3." });
  const level = (await read(s, { host: "claude-code", for: "coordinator", model: "claude-opus-4-6", effort: "xhigh" })).json;
  assert.deepEqual(optionOf(level, "effort").chosen, { value: "xhigh", state: "not-offered", reason: "Opus 4.6 does not take the effort xhigh." });
  const typed = (await read(s, { host: "claude-code", for: "coordinator", model: "my-proxy-model", typed: 1 })).json;
  assert.deepEqual(optionOf(typed, "model").chosen, { value: "my-proxy-model", state: "typed", reason: "Prism cannot check a model you typed; Claude Code receives it as written." });
  const listedTyped = (await read(s, { host: "claude-code", for: "coordinator", model: "opus", typed: 1 })).json;
  assert.equal(optionOf(listedTyped, "model").chosen.state, "offered", "a typed name the host lists is offered");
  const provider = (await read(s, { host: "codex", for: "coordinator", provider: "azure" })).json;
  assert.deepEqual(optionOf(provider, "provider").chosen, { value: "azure", state: "not-offered", reason: "Codex on this computer has no provider azure." });
});

test("clause 12: a host or provider that lists no models answers reportedNone with only the host default", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const local = (await read(s, { host: "codex", for: "coordinator", provider: "local" })).json;
  assert.equal(local.state, "ready");
  assert.equal(optionOf(local, "model").reportedNone, true);
  assert.deepEqual(valuesOf(local, "model"), [null]);
  await s.setCatalog({ ...(await s.readCatalog()), claude: { models: [], account: null } });
  const none = (await read(s, { host: "claude-code", for: "coordinator" })).json;
  assert.equal(optionOf(none, "model").reportedNone, true);
  assert.deepEqual(valuesOf(none, "model"), [null]);
});

test("clause 12: a model list that Codex refuses answers reportedNone and its message as the reason", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await s.setCatalog({ ...(await s.readCatalog()), codex: { ...(await s.readCatalog()).codex, modelListError: "Authentication required" } });
  const report = (await read(s, { host: "codex", for: "coordinator" })).json;
  assert.equal(report.state, "ready");
  assert.equal(report.reason, "Codex could not list its models: Authentication required");
  assert.equal(optionOf(report, "model").reportedNone, true);
});

test("clause 13: a read that fails answers failed with the reason, and the host default and a typed model stay possible", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await s.setCatalog({ claude: { fail: "Not logged in" }, codex: { fail: "Authentication required" } });
  const claude = (await read(s, { host: "claude-code", for: "coordinator", model: "fable" })).json;
  assert.deepEqual([claude.state, claude.reason], ["failed", "Claude Code did not report its run options: Not logged in."]);
  assert.deepEqual(claude.options.map((option) => [option.id, option.values.map((entry) => entry.value)]), [["model", [null]], ["effort", [null]]]);
  assert.equal(optionOf(claude, "model").chosen.state, "not-offered");
  assert.equal(optionOf((await read(s, { host: "claude-code", for: "coordinator", model: "fable", typed: 1 })).json, "model").chosen.state, "typed");
  const codex = (await read(s, { host: "codex", for: "coordinator" })).json;
  assert.deepEqual([codex.state, codex.reason], ["failed", "Codex did not report its run options: Authentication required."]);
});

test("clause 13: a host that gives no answer within the read time answers failed and is ended", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  process.env.PRISM_RUN_OPTIONS_TIMEOUT_MS = "800";
  t.after(() => { delete process.env.PRISM_RUN_OPTIONS_TIMEOUT_MS; });
  await s.setCatalog({ claude: { hang: true }, codex: { hang: true } });
  const started = Date.now();
  const claude = (await read(s, { host: "claude-code", for: "coordinator" })).json;
  assert.ok(Date.now() - started < 10000, "the answer comes after the read time, not after a host that never answers");
  assert.deepEqual([claude.state, claude.reason], ["failed", "Claude Code did not report its run options: it gave no answer within 0.8 seconds."]);
  const [run] = s.optionReads("claude");
  assert.equal(await settled(() => s.alive(run.pid), false), false, "the host that never answered is ended");
});

test("clause 14: Claude Code is read with one initialize request in a session it does not keep, without hooks, servers, or a turn", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await read(s, { host: "claude-code", for: "coordinator" });
  const [run] = s.optionReads("claude");
  assert.deepEqual(run.argv, ["-p", "--verbose", "--no-session-persistence", "--settings", "{\"disableAllHooks\":true}", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--input-format", "stream-json", "--output-format", "stream-json"]);
  assert.equal(run.cwd, s.root, "it runs in the checkout, so the project's host settings decide what it reports");
  assert.deepEqual(run.env, { PRISM_LAUNCH: null, CLAUDECODE: null, CLAUDE_CODE_SESSION_ID: null, CLAUDE_PLUGIN_ROOT: null, CODEX_THREAD_ID: null }, "it sees no host session variable of the review app's own session");
  assert.deepEqual(s.inputs(run.pid), [{ type: "control_request", request_id: "prism-options", request: { subtype: "initialize" } }], "the only message is the initialize request: no prompt, so no model turn");
});

test("clause 15: Codex is read through its app server with its provider and model lists and no thread or turn", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await read(s, { host: "codex", for: "coordinator" });
  const [run] = s.optionReads("codex");
  assert.deepEqual(run.argv, ["app-server"]);
  const methods = s.inputs(run.pid).map((message) => message.method);
  assert.deepEqual(methods.slice(0, 3), ["initialize", "initialized", "modelProvider/list"]);
  assert.ok(methods.slice(3).every((method) => method === "model/list") && methods.length >= 5);
  assert.deepEqual(s.inputs(run.pid)[0].params.clientInfo, { name: "prism-options", version: "1" });
});

test("clause 16: a read closes the host's input once it has its answers, so no host session stays open", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await read(s, { host: "claude-code", for: "coordinator" });
  await read(s, { host: "codex", for: "coordinator" });
  assert.equal(s.optionReads().length, 2, "each host was read once");
  for (const run of s.optionReads()) {
    assert.ok(await settled(() => s.closed(run.pid), (value) => value !== null), `${run.host}'s input closed`);
    assert.equal(await settled(() => s.alive(run.pid), false), false, `${run.host} exited`);
  }
});

test("clause 17: a report is reused for ten minutes by queries that differ only in purpose and selection, and concurrent reads share one host process", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await Promise.all([read(s, { host: "claude-code", for: "coordinator" }), read(s, { host: "claude-code", for: "coordinator" })]);
  await read(s, { host: "claude-code", for: "agents", model: "opus", effort: "low" });
  await read(s, { host: "claude-code", for: "coordinator", model: "x-typed", typed: 1 });
  assert.equal(s.optionReads("claude").length, 1);
  await read(s, { host: "codex", for: "coordinator" });
  await read(s, { host: "codex", for: "coordinator", provider: "local" });
  await read(s, { host: "codex", for: "agents", provider: "local" });
  assert.equal(s.optionReads("codex").length, 2, "each provider is read once");
});

test("clause 17: a failed read is read again by the next query", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const catalog = await s.readCatalog();
  await s.setCatalog({ ...catalog, claude: { fail: "Not logged in" } });
  assert.equal((await read(s, { host: "claude-code", for: "coordinator" })).json.state, "failed");
  await s.setCatalog(catalog);
  assert.equal((await read(s, { host: "claude-code", for: "coordinator" })).json.state, "ready");
  assert.equal(s.optionReads("claude").length, 2);
});
