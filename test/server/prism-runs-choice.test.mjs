import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { actionOf, apply, listing, runOptionsReview } from "./fixtures/run-options-hosts.mjs";

// Requirements: docs/requirements/launched-sessions.md §24, and docs/requirements/launch-run-configuration.md §16.
// The host and model of Prism's own runs, such as migration runs: one choice per computer, kept in the review app folder, made
// through the same host reports as a launch, and read by the code that starts those runs.
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const TARGET = "machine:prism-runs";
const ACTION = "machine.prismRuns";

const choiceFile = (s) => path.join(s.app, "prism-runs.json");
const current = async (s) => actionOf(await listing(s.base, TARGET, s.headers), ACTION);
const send = async (s, input, headers = s.headers) => apply(s.base, { action: ACTION, target: TARGET, input, revision: (await current(s)).revision }, headers);
const choice = (input) => ({ host: "claude-code", provider: null, run: null, ...input });
const prismRunLaunch = async (s) => {
  const { prismRunLaunch: read } = await import("../../dist/server/session/prism-runs.mjs");
  return read({ checkout: s.root, env: s.env });
};

test("clause 1: this computer lists one action for Prism's own runs, with the host, the provider, and the model and effort, starting on any available host", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: ["claude"] });
  const action = await current(s);
  assert.ok(action, "the action is listed for machine:prism-runs");
  assert.equal(action.label, "Prism's own runs");
  assert.equal(action.group, "This computer");
  assert.equal(action.effect, "Prism's own runs on this computer, such as moving records to a new format, start with this host and model; a run already started keeps its own.");
  assert.equal(action.confirm, null);
  assert.deepEqual(action.fields.map((field) => [field.name, field.kind, field.label, field.for ?? null]), [
    ["host", "choice", "Host", null],
    ["provider", "run-option", "Provider", "coordinator"],
    ["run", "run-choice", "Model", "coordinator"]
  ]);
  assert.deepEqual(action.fields[0].options, [
    { value: "automatic", label: "Any available host", consequence: "Each run starts on the first host Prism finds on this computer, with its default model.", reason: null },
    { value: "claude-code", label: "Claude Code", consequence: "Claude Code runs Prism's own runs.", reason: null },
    { value: "codex", label: "Codex", consequence: "Codex runs Prism's own runs.", reason: "Codex was not found: no codex executable on PATH." }
  ]);
  assert.deepEqual(action.value, { host: "automatic", provider: null, run: { model: null, effort: null, typed: false } });
  assert.equal(typeof action.revision, "string");
  const listed = (await listing(s.base, "initiative:reports", s.headers)).json.actions.map((item) => item.id);
  assert.equal(listed.includes(ACTION), false, "an initiative does not list it");
});

test("clause 2: a choice is stored in the review app folder, readable only by the person, and shows when listed again", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const before = (await current(s)).revision;
  const applied = await send(s, choice({ run: { model: "fable", effort: "high", typed: false } }));
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.deepEqual(applied.json.applied.after, { host: "claude-code", provider: null, run: { model: "fable", effort: "high", typed: false } });
  const stored = JSON.parse(await readFile(choiceFile(s), "utf8"));
  assert.deepEqual({ host: stored.host, provider: stored.provider, model: stored.model, effort: stored.effort, typed: stored.typed }, { host: "claude-code", provider: null, model: "fable", effort: "high", typed: false });
  assert.match(stored.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof stored.by, "string");
  assert.equal((await stat(choiceFile(s))).mode & 0o777, 0o600);
  const after = await current(s);
  assert.notEqual(after.revision, before, "the revision follows the stored choice");
  assert.deepEqual(after.value, { host: "claude-code", provider: null, run: { model: "fable", effort: "high", typed: false } });
  const again = await send(s, choice({ run: { model: "fable", effort: "high", typed: false } }));
  assert.equal(again.status, 200);
  assert.equal(again.json.applied, null, "an unchanged choice records nothing");
  const stale = await apply(s.base, { action: ACTION, target: TARGET, input: choice({}), revision: before }, s.headers);
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "stale_revision");
});

test("clause 3: a choice takes only what the chosen host reports, or a model typed as such, and a host this computer lacks is refused", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: ["claude"] });
  const cases = [
    [choice({ host: "codex" }), "host", "Codex was not found: no codex executable on PATH."],
    [choice({ host: "gemini" }), "host", null],
    [choice({ run: { model: "claude-opus-3", effort: null, typed: false } }), "run", "Claude Code on this computer does not offer the model claude-opus-3."],
    [choice({ run: { model: "claude-opus-4-6", effort: "xhigh", typed: false } }), "run", "Opus 4.6 does not take the effort xhigh."],
    [choice({ provider: "openai" }), "provider", "Claude Code on this computer has no provider openai."],
    [choice({ run: { model: "-p", effort: null, typed: true } }), "run", "A model name has 1 to 200 letters, digits, and . _ - : / @ [ ] +, and starts with a letter or digit."],
    [choice({ host: "automatic", run: { model: "fable", effort: null, typed: false } }), "run", "Any available host takes only the host's default model."]
  ];
  for (const [input, field, message] of cases) {
    const refused = await send(s, input);
    assert.equal(refused.status, 400, JSON.stringify(input));
    assert.equal(refused.json.code, "invalid_input");
    assert.equal(refused.json.field, field, JSON.stringify(input));
    if (message) assert.equal(refused.json.message, message);
  }
  await assert.rejects(readFile(choiceFile(s)), "nothing refused is stored");
  const typed = await send(s, choice({ run: { model: "us.anthropic.claude-opus-4-8[1m]", effort: "max", typed: true } }));
  assert.equal(typed.status, 200, JSON.stringify(typed.json));
});

test("clause 4: only the page's write session changes the choice", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const refused = await send(s, choice({}), {});
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "write_forbidden");
  await assert.rejects(readFile(choiceFile(s)));
});

test("clause 5: the code that starts Prism's own runs reads the chosen host and model", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await send(s, choice({ host: "codex", provider: "openai", run: { model: "gpt-6-luna", effort: "minimal", typed: false } }));
  assert.deepEqual(await prismRunLaunch(s), { host: "codex", coordinator: { provider: "openai", model: "gpt-6-luna", effort: "minimal", typed: false }, reason: null });
  await send(s, choice({ host: "claude-code", run: { model: "my-proxy-model", effort: null, typed: true } }));
  assert.deepEqual(await prismRunLaunch(s), { host: "claude-code", coordinator: { provider: null, model: "my-proxy-model", effort: null, typed: true }, reason: null });
});

test("clause 6: without a choice, or when the chosen host is gone, a run starts on the first available host with its defaults, and with no host it starts nowhere", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: ["codex"] });
  const defaults = { provider: null, model: null, effort: null, typed: false };
  assert.deepEqual(await prismRunLaunch(s), { host: "codex", coordinator: defaults, reason: null }, "no choice reads as any available host");
  await writeFile(choiceFile(s), JSON.stringify({ host: "claude-code", provider: null, model: "fable", effort: "high", typed: false, at: new Date().toISOString(), by: "someone" }), { mode: 0o600 });
  assert.deepEqual(await prismRunLaunch(s), { host: "codex", coordinator: defaults, reason: "Claude Code, chosen for Prism's own runs, was not found: no claude executable on PATH. Codex runs it with its default model." });
  await writeFile(choiceFile(s), "{ not json", { mode: 0o600 });
  assert.deepEqual(await prismRunLaunch(s), { host: "codex", coordinator: defaults, reason: "The choice for Prism's own runs could not be read, so the first available host runs it with its default model." });
});

test("clause 6: with no supported host on this computer, Prism's own runs start nowhere", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: [] });
  assert.equal(await prismRunLaunch(s), null);
});

test("clause 7: a stored choice that breaks a name rule is never passed on", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await writeFile(choiceFile(s), JSON.stringify({ host: "claude-code", provider: null, model: "--dangerously-skip-permissions", effort: "high; rm -rf ~", typed: true, at: new Date().toISOString(), by: "someone" }), { mode: 0o600 });
  const launch = await prismRunLaunch(s);
  assert.equal(launch.host, "claude-code");
  assert.deepEqual(launch.coordinator, { provider: null, model: null, effort: null, typed: false });
  assert.equal(launch.reason, "The choice for Prism's own runs could not be read, so the first available host runs it with its default model.");
  assert.equal((await current(s)).value.run.model, null, "the action shows the defaults too");
});
