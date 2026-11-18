import assert from "node:assert/strict";
import test from "node:test";
import { INITIATIVE, actionOf, apply, listing, runOptionsReview } from "./fixtures/run-options-hosts.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/launch-run-configuration.md §2, §3, §8, §9, §12, §13, docs/requirements/launched-sessions.md §27, §28,
// and docs/requirements/initiative-settings.md §11.
// One launch action starts the initiative's host with the coordinator model and effort chosen for that host, and a resume keeps them.

const posixOnly = process.platform === "win32" ? "the stub hosts and dialogs are POSIX scripts" : false;
const TARGET = `initiative:${INITIATIVE}`;
const LAUNCH_FLAGS = ["--input-format", "stream-json", "--output-format", "stream-json", "--permission-mode", "auto", "--permission-prompts", "none"];

const state = async (root) => {
  const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  return readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
};
const settings = async (root, value) => {
  const { updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const read = await state(root);
  await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: read.exists ? read.revision : null, changes: { settings: value } });
};
const launch = (s) => apply(s.base, { action: "launch.run", target: TARGET, input: {}, revision: null }, s.headers);
const ended = (s, id) => settled(async () => (await (await fetch(`${s.base}/api/launches`)).json()).launches.find((item) => item.id === id), (view) => view && view.state !== "running" && view.state !== "waiting");
const resume = (s, id) => apply(s.base, { action: "launch.resume", target: `launch:${id}`, input: {}, revision: null }, s.headers);
const inputsOf = (s, run, method) => s.inputs(run.pid).filter((message) => message.method === method).map((message) => message.params);

test("clause 1: an initiative lists one launch action after its settings and no launch per host, and a slice lists none", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const listed = await listing(s.base, TARGET, s.headers);
  const ids = listed.json.actions.map((action) => action.id);
  assert.deepEqual(ids.filter((id) => id.startsWith("launch.")), ["launch.run"]);
  assert.ok(ids.indexOf("launch.run") > ids.indexOf("initiative.models"), "the launch follows the settings");
  const action = actionOf(listed, "launch.run");
  assert.deepEqual({ ...action, revision: action.revision }, {
    id: "launch.run", label: "Launch", group: "Launched session", target: TARGET, value: null, fields: [],
    effect: "Starts a headless session of this initiative's host on this computer with its settings; you confirm it outside the browser unless you confirmed in the last 30 minutes.",
    context: null, recommended: null, available: true, reason: null, confirm: null, revision: null
  });
  const slice = await listing(s.base, `slice:${INITIATIVE}/${INITIATIVE}`, s.headers);
  assert.deepEqual(slice.json.actions.map((item) => item.id).filter((id) => id.startsWith("launch.")), []);
});

test("clause 2: without any supported host the launch is unavailable and names the hosts Prism supports", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: [] });
  const action = actionOf(await listing(s.base, TARGET, s.headers), "launch.run");
  assert.equal(action.available, false);
  assert.equal(action.reason, "No host that Prism supports was found on this computer. Prism supports Claude Code and Codex.");
  const refused = await launch(s);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, "action_unavailable");
  assert.equal(s.runs().length, 0);
});

test("clause 2: the launch is unavailable while the initiative's host is not found, with that host's reason", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: ["claude"] });
  await settings(s.root, { host: "codex" });
  const action = actionOf(await listing(s.base, TARGET, s.headers), "launch.run");
  assert.deepEqual([action.available, action.reason], [false, "Codex was not found: no codex executable on PATH."]);
  await settings(s.root, { host: "claude-code" });
  assert.equal(actionOf(await listing(s.base, TARGET, s.headers), "launch.run").available, true);
});

test("clause 3: a saved choice the host does not offer refuses the launch with its reason, before any confirmation", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const cases = [
    [{ "claude-code": { coordinator: { model: "claude-opus-3" } } }, "Coordinator: Claude Code on this computer does not offer the model claude-opus-3."],
    [{ "claude-code": { coordinator: { model: "claude-opus-4-6", effort: "xhigh" } } }, "Coordinator: Opus 4.6 does not take the effort xhigh."],
    [{ "claude-code": { securityReview: { model: "claude-opus-4-6" } } }, "Security review: Claude Code on this computer does not offer the model claude-opus-4-6."],
    [{ "claude-code": { codeReview: { model: "gone-family" }, gateSummary: { model: "also-gone" } } }, "Code review: Claude Code on this computer does not offer the model gone-family."]
  ];
  for (const [models, message] of cases) {
    await settings(s.root, { host: "claude-code", models });
    const refused = await launch(s);
    assert.equal(refused.status, 409, JSON.stringify(models));
    assert.deepEqual([refused.json.code, refused.json.message], ["choice_not_offered", message]);
  }
  await settings(s.root, { host: "codex", models: { codex: { provider: "azure" } } });
  const provider = await launch(s);
  assert.deepEqual([provider.json.code, provider.json.message], ["choice_not_offered", "Provider: Codex on this computer has no provider azure."]);
  assert.deepEqual(s.dialogs(), [], "no confirmation was asked");
  assert.deepEqual(s.launchRuns(), [], "nothing started");
});

test("clause 4: an offered choice launches after the confirmation outside the page", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await settings(s.root, { host: "claude-code", models: { "claude-code": { coordinator: { model: "fable", effort: "high" }, codeReview: { model: "opus", effort: "max" } } } });
  const started = await launch(s);
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.equal(s.dialogs().length, 1);
  assert.equal(started.json.launch.host, "claude-code");
  assert.equal(s.launchRuns("claude").length, 1);
});

test("clause 5: Claude Code runs with --model and --effort of the coordinator's choice after its fixed arguments, and with neither for host defaults", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await settings(s.root, { host: "claude-code", models: { "claude-code": { coordinator: { model: "fable", effort: "high" } } } });
  const first = await launch(s);
  const [run] = s.launchRuns("claude");
  assert.deepEqual(run.argv.slice(0, 2), ["-p", "--verbose"]);
  assert.deepEqual(run.argv.slice(4), [...LAUNCH_FLAGS, "--model", "fable", "--effort", "high"]);
  await ended(s, first.json.launch.id);
  await settings(s.root, { models: { "claude-code": { coordinator: { effort: "low" } } } });
  const second = await launch(s);
  await ended(s, second.json.launch.id);
  assert.deepEqual(s.launchRuns("claude")[1].argv.slice(4), [...LAUNCH_FLAGS, "--effort", "low"], "the host default model passes no --model");
  await settings(s.root, { models: {} });
  await launch(s);
  assert.deepEqual(s.launchRuns("claude")[2].argv.slice(4), LAUNCH_FLAGS, "host defaults pass neither");
});

test("clause 6: Codex starts its thread with the model and provider and its turn with the effort of the coordinator's choice", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await settings(s.root, { host: "codex", models: { codex: { provider: "openai", coordinator: { model: "gpt-6-luna", effort: "minimal" } } } });
  const first = await launch(s);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  await settled(() => s.launchRuns("codex").length, 1);
  const [run] = s.launchRuns("codex");
  const [thread] = await settled(() => inputsOf(s, run, "thread/start"), (list) => list.length === 1);
  assert.equal(thread.model, "gpt-6-luna");
  assert.equal(thread.modelProvider, "openai");
  const [turn] = await settled(() => inputsOf(s, run, "turn/start"), (list) => list.length === 1);
  assert.equal(turn.effort, "minimal");
  await ended(s, first.json.launch.id);
  await settings(s.root, { models: {} });
  const second = await launch(s);
  await settled(() => s.launchRuns("codex").length, 2);
  const other = s.launchRuns("codex")[1];
  const [plainThread] = await settled(() => inputsOf(s, other, "thread/start"), (list) => list.length === 1);
  assert.equal(Object.hasOwn(plainThread, "model"), false);
  assert.equal(Object.hasOwn(plainThread, "modelProvider"), false);
  const [plainTurn] = await settled(() => inputsOf(s, other, "turn/start"), (list) => list.length === 1);
  assert.equal(Object.hasOwn(plainTurn, "effort"), false);
  await ended(s, second.json.launch.id);
});

test("clause 7: a resume keeps the model and effort the session started with, even after the settings changed", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await settings(s.root, { host: "claude-code", models: { "claude-code": { coordinator: { model: "fable", effort: "high" } } } });
  const claude = (await launch(s)).json.launch.id;
  await ended(s, claude);
  await settings(s.root, { models: { "claude-code": { coordinator: { model: "haiku", effort: "low" } } } });
  const resumed = await resume(s, claude);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
  const again = s.launchRuns("claude")[1];
  assert.equal(again.argv[2], "--resume");
  assert.deepEqual(again.argv.slice(4), [...LAUNCH_FLAGS, "--model", "fable", "--effort", "high"]);
  await ended(s, claude);
  await settings(s.root, { host: "codex", models: { codex: { provider: "openai", coordinator: { model: "gpt-6-luna", effort: "max" } } } });
  const codex = (await launch(s)).json.launch.id;
  await ended(s, codex);
  await settings(s.root, { models: { codex: { coordinator: { model: "gpt-5.5" } } } });
  assert.equal((await resume(s, codex)).status, 200);
  await settled(() => s.launchRuns("codex").length, 2);
  const run = s.launchRuns("codex")[1];
  const [thread] = await settled(() => inputsOf(s, run, "thread/resume"), (list) => list.length === 1);
  assert.deepEqual([thread.model, thread.modelProvider], ["gpt-6-luna", "openai"]);
  const [turn] = await settled(() => inputsOf(s, run, "turn/start"), (list) => list.length === 1);
  assert.equal(turn.effort, "max", "the effort is set again for the resumed turn");
});

test("clause 8: the launch's history entry names the host and the coordinator's choice", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await settings(s.root, { host: "claude-code", models: { "claude-code": { coordinator: { model: "fable" } } } });
  const started = await launch(s);
  assert.deepEqual(started.json.applied.after, { launch: started.json.launch.id, host: "claude-code", coordinator: { provider: null, model: "fable", effort: null } });
  const history = (await state(s.root)).state.history;
  assert.deepEqual(history.at(-1).after, started.json.applied.after);
  assert.equal(history.at(-1).action, "launch.run");
});

test("clause 9: a typed model reaches the host only as the model, and nothing else from the page reaches the command line", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const typed = "us.anthropic.claude-opus-4-8[1m]";
  await settings(s.root, { host: "claude-code", models: { "claude-code": { coordinator: { model: typed, typed: true, effort: "max" } } } });
  const started = await launch(s);
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const [run] = s.launchRuns("claude");
  assert.deepEqual(run.argv.filter((argument) => argument.includes(typed)), [typed]);
  assert.equal(run.argv[run.argv.indexOf(typed) - 1], "--model");
  const prompt = s.inputs(run.pid).find((message) => message.type === "user");
  assert.deepEqual(prompt.message, { role: "user", content: `/prism:orchestrate ${INITIATIVE}` });
});

test("clause 10: startLaunch refuses a coordinator choice that breaks the name rules and starts nothing", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const { startLaunch } = await import("../../dist/server/session/launched-sessions.mjs");
  for (const coordinator of [{ model: "-p" }, { model: "a b" }, { effort: "--x" }, { provider: "../p" }, { model: "x".repeat(201) }]) {
    await assert.rejects(startLaunch({ projectRoot: s.root, initiative: INITIATIVE, host: "claude-code", coordinator: { provider: null, model: null, effort: null, ...coordinator }, env: process.env }), (error) => error.code === "invalid_choice", JSON.stringify(coordinator));
  }
  assert.deepEqual(s.launchRuns(), []);
});
