import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { INITIATIVE, actionOf, apply, listing, runOptionsReview } from "./fixtures/run-options-hosts.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/initiative-settings.md §10, §11, and docs/requirements/launch-run-configuration.md §10, §11, §12, §13, §16, §17.
// The initiative's host and its per-host model and effort choices as coordination state settings and as review app actions, and the
// earlier model names that the host cannot take, kept for the person to replace and never passed to a host.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const TARGET = `initiative:${INITIATIVE}`;
const HOST_DEFAULT = { model: null, effort: null, typed: false };
const KINDS = ["coordinator", "designImplementation", "codeReview", "securityReview", "gateSummary"];
const emptyEntry = () => ({ provider: null, ...Object.fromEntries(KINDS.map((kind) => [kind, HOST_DEFAULT])) });
const emptyModels = () => ({ "claude-code": emptyEntry(), codex: emptyEntry() });
const INTERNAL_WORDS = /\b(delivery|examples|orchestrat\w*|child sessions?|run model|securityReview|gateSummary|designImplementation)\b/i;

const state = async (root) => {
  const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  return readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
};
const write = async (root, settings) => {
  const { updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const read = await state(root);
  return updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: read.exists ? read.revision : null, changes: { settings } });
};
const actions = async (s) => (await listing(s.base, TARGET, s.headers)).json.actions;
const send = async (s, action, input, confirmed = false) => {
  const current = (await actions(s)).find((item) => item.id === action);
  return apply(s.base, { action, target: TARGET, input, revision: current.revision, ...(confirmed ? { confirmed: true } : {}) }, s.headers);
};
const models = (input) => ({ host: "claude-code", provider: null, ...Object.fromEntries(KINDS.map((kind) => [kind, null])), ...input });
const EARLIER = "Claude Opus 4.1";
const earlierReason = (label) => `Prism kept the earlier model name ${EARLIER}, which ${label} cannot take as a model.`;
const refusedNaming = (root, value, where) => assert.rejects(write(root, { models: value }), (error) => {
  assert.match(error.message + JSON.stringify(error.errors ?? error.details ?? ""), new RegExp(where.replace(/[.]/g, "\\.")), `${JSON.stringify(value)} names ${where}`);
  return true;
});

// The JSON files under a folder that hold a text, such as the coordination state file after a write that left the text in it.
async function filesHolding(folder, text, found = []) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") await filesHolding(full, text, found);
    else if (entry.isFile() && entry.name.endsWith(".json") && (await readFile(full, "utf8")).includes(text)) found.push(full);
  }
  return found;
}

test("clause 1: the initiative settings are host, autonomy, commit, push, continuation, review, and models, and models read per host", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const { INITIATIVE_SETTINGS, effectiveSettings } = await import("../../dist/server/workflow/state.mjs");
  assert.deepEqual([...INITIATIVE_SETTINGS], ["host", "autonomy", "commit", "push", "continuation", "review", "models"]);
  const effective = effectiveSettings({ settings: {} });
  assert.equal(effective.host, null);
  assert.deepEqual(effective.models, {});
  const listed = await actions(s);
  assert.deepEqual(listed.filter((action) => action.group === "Initiative settings").map((action) => action.id), INITIATIVE_SETTINGS.map((name) => `initiative.${name}`));
});

test("clause 2: a stored models value is an object of supported hosts, each with a provider and the five kinds' model, effort, and typed mark", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const stored = { "claude-code": { coordinator: { model: "fable", effort: "high" }, codeReview: { model: "opus" }, gateSummary: { model: "my-proxy", typed: true } }, codex: { provider: "local", designImplementation: { effort: "low" } } };
  await write(s.root, { models: stored });
  assert.deepEqual((await state(s.root)).state.settings.models, stored);
  const refusals = [
    [{ gemini: {} }, "settings.models.gemini"],
    [{ "claude-code": { delivery: { model: "opus" } } }, "settings.models.claude-code.delivery"],
    [{ "claude-code": { coordinator: { model: "-p" } } }, "settings.models.claude-code.coordinator.model"],
    [{ "claude-code": { coordinator: { model: "has space" } } }, "settings.models.claude-code.coordinator.model"],
    [{ "claude-code": { coordinator: { effort: "High!" } } }, "settings.models.claude-code.coordinator.effort"],
    [{ "claude-code": { coordinator: { typed: true } } }, "settings.models.claude-code.coordinator.typed"],
    [{ "claude-code": { coordinator: { model: "opus", typed: false } } }, "settings.models.claude-code.coordinator.typed"],
    [{ "claude-code": { coordinator: { model: "opus", speed: "fast" } } }, "settings.models.claude-code.coordinator.speed"],
    [{ codex: { provider: "../up" } }, "settings.models.codex.provider"]
  ];
  for (const [value, where] of refusals) {
    await assert.rejects(write(s.root, { models: value }), (error) => {
      assert.match(error.message + JSON.stringify(error.errors ?? error.details ?? ""), new RegExp(where.replace(/[.]/g, "\\.")), `${JSON.stringify(value)} names ${where}`);
      return true;
    });
  }
  assert.deepEqual((await state(s.root)).state.settings.models, stored, "a refused write changes nothing");
});

test("clause 3: a stored host is a supported host", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await write(s.root, { host: "codex" });
  assert.equal((await state(s.root)).state.settings.host, "codex");
  await assert.rejects(write(s.root, { host: "gemini" }), (error) => /settings\.host/.test(error.message + JSON.stringify(error.errors ?? error.details ?? "")));
});

test("clause 4: earlier models values migrate without loss: host defaults to no choice, and named models to typed choices of every host", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const { effectiveSettings } = await import("../../dist/server/workflow/state.mjs");
  for (const legacy of ["defaults", "host defaults"]) {
    assert.deepEqual(effectiveSettings({ settings: { models: legacy } }).models, {});
    await write(s.root, { models: legacy });
    assert.deepEqual((await state(s.root)).state.settings.models, {}, `${legacy} is stored as no choice`);
  }
  const named = { delivery: "opus", review: "fable", securityReview: "claude-opus-4-8", examples: "haiku" };
  const migrated = { designImplementation: { model: "opus", typed: true }, codeReview: { model: "fable", typed: true }, securityReview: { model: "claude-opus-4-8", typed: true }, gateSummary: { model: "haiku", typed: true } };
  assert.deepEqual(effectiveSettings({ settings: { models: named } }).models, { "claude-code": migrated, codex: migrated });
  await write(s.root, { models: { delivery: "d", review: "r", securityReview: "s" } });
  const without = { designImplementation: { model: "d", typed: true }, codeReview: { model: "r", typed: true }, securityReview: { model: "s", typed: true } };
  assert.deepEqual((await state(s.root)).state.settings.models, { "claude-code": without, codex: without }, "a write in the earlier form is stored migrated, and no examples model leaves the summary on the host default");
  const action = actionOf(await listing(s.base, TARGET, s.headers), "initiative.models");
  assert.deepEqual(action.value["claude-code"].designImplementation, { model: "d", effort: null, typed: true });
  assert.deepEqual(action.value.codex.gateSummary, HOST_DEFAULT);
});

test("clause 4: an earlier name that breaks the model rule is kept as an earlier name of every host, never as a model, and the record stays valid", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const { effectiveSettings } = await import("../../dist/server/workflow/state.mjs");
  const long = `${"a".repeat(150)} ${"b".repeat(100)}`;
  const kept = { designImplementation: { earlier: EARLIER }, codeReview: { model: "sonnet", typed: true }, securityReview: { earlier: "Opus 4.1 (work)" }, gateSummary: { earlier: `${"a".repeat(150)} ${"b".repeat(49)}` } };
  assert.deepEqual(effectiveSettings({ settings: { models: { delivery: EARLIER, review: " sonnet ", securityReview: "  Opus\t 4.1\n(work) ", examples: long } } }).models, { "claude-code": kept, codex: kept }, "white space and control characters become single spaces, and the name keeps its first 200 characters");
  assert.deepEqual(effectiveSettings({ settings: { models: { delivery: "\u0007", review: "opus", securityReview: "opus" } } }).models.codex, { codeReview: { model: "opus", typed: true }, securityReview: { model: "opus", typed: true } }, "a name left empty reads as the host default");
  const migrated = { designImplementation: { earlier: EARLIER }, codeReview: { model: "sonnet", typed: true }, securityReview: { model: "opus", typed: true } };
  await write(s.root, { models: { delivery: EARLIER, review: "sonnet", securityReview: "opus" } });
  assert.deepEqual((await state(s.root)).state.settings.models, { "claude-code": migrated, codex: migrated }, "a write in the earlier form is taken and stored migrated");
  await write(s.root, { models: {}, autonomy: "broad" });
  const files = await filesHolding(s.root, '"autonomy": "broad"');
  assert.equal(files.length, 1, "one state file holds the initiative's settings");
  const record = JSON.parse(await readFile(files[0], "utf8"));
  record.settings.models = { delivery: EARLIER, review: "sonnet", securityReview: "opus" };
  await writeFile(files[0], `${JSON.stringify(record, null, 2)}\n`);
  const read = await state(s.root);
  assert.equal(read.valid, true, `a record that an earlier Prism wrote reads valid: ${JSON.stringify(read.errors)}`);
  assert.deepEqual(read.state.settings.models, { "claude-code": migrated, codex: migrated });
  await write(s.root, { push: "off" });
  const after = await state(s.root);
  assert.equal(after.state.settings.push, "off", "an agent's update of another setting is taken");
  assert.deepEqual(after.state.settings.models, { "claude-code": migrated, codex: migrated }, "and keeps the earlier name");
  assert.deepEqual(JSON.parse(await readFile(files[0], "utf8")).settings.models, { "claude-code": migrated, codex: migrated }, "the record stores it migrated");
});

test("clause 5: the host action offers every supported host, marks one this computer lacks with its reason, and shows the first one found", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: ["codex"] });
  const action = actionOf(await listing(s.base, TARGET, s.headers), "initiative.host");
  assert.equal(action.label, "Host");
  assert.equal(action.group, "Initiative settings");
  assert.equal(action.effect, "Launches started after the change run on this host; a running or resumed session keeps the host it started on.");
  assert.equal(action.confirm, null);
  assert.deepEqual(action.fields.map((field) => [field.name, field.kind, field.label, field.required]), [["value", "choice", "Host", true]]);
  assert.deepEqual(action.fields[0].options, [
    { value: "claude-code", label: "Claude Code", consequence: "Claude Code runs the launched session and its agents.", reason: "Claude Code was not found: no claude executable on PATH." },
    { value: "codex", label: "Codex", consequence: "Codex runs the launched session and its agents.", reason: null }
  ]);
  assert.equal(action.value, "codex", "with no stored host the first host this computer finds shows");
  await write(s.root, { host: "claude-code" });
  assert.equal(actionOf(await listing(s.base, TARGET, s.headers), "initiative.host").value, "claude-code", "a stored host shows even where it is not found");
});

test("clause 6: choosing a host stores it as the person's setting, and a host this computer lacks is refused with its reason", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: ["claude"] });
  const refused = await send(s, "initiative.host", { value: "codex" });
  assert.equal(refused.status, 400);
  assert.deepEqual([refused.json.code, refused.json.field, refused.json.message], ["invalid_input", "value", "Codex was not found: no codex executable on PATH."]);
  const chosen = await send(s, "initiative.host", { value: "claude-code" });
  assert.equal(chosen.status, 200);
  const read = await state(s.root);
  assert.equal(read.state.settings.host, "claude-code");
  assert.ok(read.state.personSettings.host, "the person's choice is marked as theirs");
  await write(s.root, { host: "codex" });
  assert.equal((await state(s.root)).state.settings.host, "claude-code", "an agent's write keeps the person's host");
});

test("clause 7: the models action lists the host, the provider, and the five kinds with plain words, and its value holds every host's choices", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const action = actionOf(await listing(s.base, TARGET, s.headers), "initiative.models");
  assert.equal(action.label, "Models");
  assert.equal(action.effect, "The coordinator's model and effort apply to launches started after the change, and each agent's to agents started after it; a running session or agent keeps its own.");
  assert.deepEqual(action.fields.map((field) => [field.name, field.kind, field.label, field.for ?? null, field.hint ?? null]), [
    ["host", "choice", "Host", null, null],
    ["provider", "run-option", "Provider", "coordinator", "Where the host sends its model requests; only some hosts offer a choice."],
    ["coordinator", "run-choice", "Coordinator", "coordinator", "Only coordinates: it plans the order of work, starts the agents below and asks you at gates. It writes no code."],
    ["designImplementation", "run-choice", "Design and implementation", "agents", "Writes each slice's design, tests and code."],
    ["codeReview", "run-choice", "Code review", "agents", "Reviews each finished slice."],
    ["securityReview", "run-choice", "Security review", "agents", "Reviews slices that touch access, secrets or other trust boundaries."],
    ["gateSummary", "run-choice", "Design gate summary", "agents", "Turns the design's tests into the short summaries you read at the design gate."]
  ]);
  assert.equal(action.fields[1].option, "provider");
  assert.deepEqual(action.fields[0].options.map((option) => option.value), ["claude-code", "codex"]);
  assert.deepEqual(action.value, emptyModels());
});

test("clause 8: a models change sets one host's choices and keeps every other host's, and an unchanged one records nothing", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const claude = await send(s, "initiative.models", models({ coordinator: { model: "fable", effort: "high", typed: false }, codeReview: { model: "opus", effort: null, typed: false } }));
  assert.equal(claude.status, 200, JSON.stringify(claude.json));
  const codex = await send(s, "initiative.models", models({ host: "codex", provider: "openai", coordinator: { model: "gpt-6-luna", effort: "minimal", typed: false } }));
  assert.equal(codex.status, 200, JSON.stringify(codex.json));
  assert.deepEqual((await state(s.root)).state.settings.models, {
    "claude-code": { coordinator: { model: "fable", effort: "high" }, codeReview: { model: "opus" } },
    codex: { provider: "openai", coordinator: { model: "gpt-6-luna", effort: "minimal" } }
  });
  assert.equal(codex.json.applied.action, "initiative.models");
  assert.deepEqual(codex.json.applied.after.codex.coordinator, { model: "gpt-6-luna", effort: "minimal", typed: false });
  assert.deepEqual(codex.json.applied.after["claude-code"].coordinator, { model: "fable", effort: "high", typed: false });
  const again = await send(s, "initiative.models", models({ host: "codex", provider: "openai", coordinator: { model: "gpt-6-luna", effort: "minimal", typed: false } }));
  assert.equal(again.status, 200);
  assert.equal(again.json.applied, null);
  const cleared = await send(s, "initiative.models", models({ codeReview: null, coordinator: { model: "fable", effort: "high", typed: false } }));
  assert.equal(cleared.status, 200);
  assert.deepEqual((await state(s.root)).state.settings.models["claude-code"], { coordinator: { model: "fable", effort: "high" } }, "a kind set back to the host default is left out");
  assert.ok((await state(s.root)).state.personSettings.models);
});

test("clause 9: a models change takes only values the host reports, or a model name typed as such", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const cases = [
    [models({ coordinator: { model: "claude-opus-3", effort: null, typed: false } }), "coordinator", "Claude Code on this computer does not offer the model claude-opus-3."],
    [models({ codeReview: { model: "claude-opus-4-6", effort: null, typed: false } }), "codeReview", "Claude Code on this computer does not offer the model claude-opus-4-6."],
    [models({ coordinator: { model: "claude-opus-4-6", effort: "xhigh", typed: false } }), "coordinator", "Opus 4.6 does not take the effort xhigh."],
    [models({ host: "codex", provider: "azure" }), "provider", "Codex on this computer has no provider azure."],
    [models({ provider: "openai" }), "provider", "Claude Code on this computer has no provider openai."],
    [models({ coordinator: { model: null, effort: null, typed: true } }), "coordinator", "Only a model name can be typed."],
    [models({ coordinator: { model: "-p", effort: null, typed: true } }), "coordinator", "A model name has 1 to 200 letters, digits, and . _ - : / @ [ ] +, and starts with a letter or digit."]
  ];
  for (const [input, field, message] of cases) {
    const refused = await send(s, "initiative.models", input);
    assert.equal(refused.status, 400, JSON.stringify(input));
    assert.deepEqual([refused.json.code, refused.json.field, refused.json.message], ["invalid_input", field, message]);
  }
  assert.equal((await state(s.root)).state?.settings?.models, undefined, "nothing refused is stored");
  const typed = await send(s, "initiative.models", models({ coordinator: { model: "us.anthropic.claude-opus-4-8[1m]", effort: "max", typed: true } }));
  assert.equal(typed.status, 200, JSON.stringify(typed.json));
  assert.deepEqual((await state(s.root)).state.settings.models["claude-code"].coordinator, { model: "us.anthropic.claude-opus-4-8[1m]", effort: "max", typed: true });
});

test("clause 9: a host this computer lacks takes no models change, and a host whose read failed takes only host defaults and typed names", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: ["claude"] });
  const missing = await send(s, "initiative.models", models({ host: "codex" }));
  assert.equal(missing.status, 400);
  assert.deepEqual([missing.json.field, missing.json.message], ["host", "Codex was not found: no codex executable on PATH."]);
  await s.setCatalog({ claude: { fail: "Not logged in" } });
  const offered = await send(s, "initiative.models", models({ coordinator: { model: "fable", effort: null, typed: false } }));
  assert.equal(offered.status, 400);
  assert.equal(offered.json.field, "coordinator");
  const typed = await send(s, "initiative.models", models({ coordinator: { model: "fable", effort: null, typed: true } }));
  assert.equal(typed.status, 200, "a typed name needs no report");
});

test("clause 9: a host whose read failed refuses the field that needed it with the read's own reason, never as a choice it does not offer", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  await s.setCatalog({ claude: { fail: "Not logged in" }, codex: { fail: "Authentication required" } });
  const cases = [
    [models({ coordinator: { model: "fable", effort: null, typed: false } }), "coordinator", "Claude Code did not report its run options: Not logged in."],
    [models({ codeReview: { model: null, effort: "high", typed: false } }), "codeReview", "Claude Code did not report its run options: Not logged in."],
    [models({ coordinator: { model: "fable", effort: "max", typed: true } }), "coordinator", "Claude Code did not report its run options: Not logged in."],
    [models({ host: "codex", coordinator: { model: "gpt-5.5", effort: null, typed: false } }), "coordinator", "Codex did not report its run options: Authentication required."],
    [models({ host: "codex", provider: "openai" }), "provider", "Codex did not report its run options: Authentication required."]
  ];
  for (const [input, field, message] of cases) {
    const refused = await send(s, "initiative.models", input);
    assert.equal(refused.status, 400, JSON.stringify(input));
    assert.deepEqual([refused.json.field, refused.json.message], [field, message], JSON.stringify(input));
  }
  // A model list that Codex refuses leaves its models and efforts unchecked, with the refusal as the reason.
  await s.setCatalog({ codex: { providers: (await import("./fixtures/run-options-hosts.mjs")).CODEX_CATALOG.providers, modelListError: "Authentication required" } });
  const unlisted = await send(s, "initiative.models", models({ host: "codex", designImplementation: { model: "gpt-5.5", effort: null, typed: false } }));
  assert.equal(unlisted.status, 400);
  assert.deepEqual([unlisted.json.field, unlisted.json.message], ["designImplementation", "Codex could not list its models: Authentication required"]);
  assert.equal((await state(s.root)).state?.settings?.models, undefined, "nothing refused is stored");
});

test("clause 10: every setting and every value says what it means in plain words", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const listed = (await actions(s)).filter((action) => action.group === "Initiative settings");
  const by = Object.fromEntries(listed.map((action) => [action.id, action]));
  const consequences = (id) => Object.fromEntries(by[id].fields[0].options.map((option) => [option.value, option.consequence]));
  assert.deepEqual(consequences("initiative.autonomy"), {
    conservative: "You approve every design and answer every decision.",
    broad: "Designs that change no requirement, add no decision record and raise no open question are accepted without you; you answer the rest.",
    full: "Agents accept every design and settle internal decisions without you; they never turn on Push."
  });
  assert.deepEqual(consequences("initiative.continuation"), { auto: "The next slice starts as soon as one finishes.", stepwise: "The run stops after each slice until you continue it." });
  assert.deepEqual(consequences("initiative.review"), { marked: "Only slices you mark for review at the design gate.", recommended: "Slices you mark, plus those the design recommends reviewing.", all: "Every slice gets a code review." });
  assert.equal(by["initiative.review"].effect, "Which slices get a code review before they count as done; a slice whose design is already accepted keeps its review.");
  assert.equal(by["initiative.continuation"].effect, "Whether the next slice starts by itself; applies when the slice in progress finishes.");
  for (const id of ["initiative.commit", "initiative.push"]) assert.equal(by[id].effect, "Applies to agents started after the change.");
  for (const action of listed) {
    assert.doesNotMatch(`${action.label} ${action.effect}`, INTERNAL_WORDS, action.id);
    for (const field of action.fields) {
      assert.doesNotMatch(`${field.label} ${field.hint ?? ""}`, INTERNAL_WORDS, `${action.id}.${field.name}`);
      for (const option of field.options ?? []) {
        assert.equal(typeof option.consequence, "string", `${action.id}.${field.name}.${option.value} says what it means`);
        assert.ok(option.consequence.length > 0);
        assert.doesNotMatch(`${option.label} ${option.consequence}`, INTERNAL_WORDS);
      }
    }
  }
});

test("clause 11: update_coordination_state takes the host and the per-host models in its input schema", async (t) => {
  const tools = await listTools(t);
  const update = tools.find((tool) => tool.name === "update_coordination_state");
  const settings = update.inputSchema.properties.changes.properties.settings;
  assert.deepEqual(settings.properties.host, { type: "string", enum: ["claude-code", "codex"] });
  const modelsSchema = settings.properties.models;
  const objectForm = (modelsSchema.oneOf ?? [modelsSchema]).find((entry) => entry.type === "object" && entry.propertyNames);
  assert.ok(objectForm, "models takes an object keyed by host");
  assert.deepEqual(objectForm.propertyNames, { enum: ["claude-code", "codex"] });
  const entry = objectForm.additionalProperties;
  assert.deepEqual(Object.keys(entry.properties).sort(), ["codeReview", "coordinator", "designImplementation", "gateSummary", "provider", "securityReview"]);
  assert.equal(entry.additionalProperties, false);
  assert.deepEqual(Object.keys(entry.properties.coordinator.properties).sort(), ["effort", "model", "typed"]);
  for (const kind of KINDS.slice(1)) {
    assert.deepEqual(Object.keys(entry.properties[kind].properties).sort(), ["earlier", "effort", "model", "typed"], `${kind} can keep an earlier name`);
    assert.equal(entry.properties[kind].properties.earlier.maxLength, 200);
  }
});

test("clause 12: a stored earlier name stands alone in the choice of an agent kind and keeps its rule", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const stored = { "claude-code": { designImplementation: { earlier: EARLIER }, codeReview: { model: "opus" } }, codex: { gateSummary: { earlier: "Opus 4.1 (work)" } } };
  await write(s.root, { models: stored });
  assert.deepEqual((await state(s.root)).state.settings.models, stored);
  const refusals = [
    [{ "claude-code": { coordinator: { earlier: EARLIER } } }, "settings.models.claude-code.coordinator.earlier"],
    [{ "claude-code": { codeReview: { earlier: EARLIER, effort: "high" } } }, "settings.models.claude-code.codeReview.earlier"],
    [{ "claude-code": { codeReview: { earlier: EARLIER, model: "opus", typed: true } } }, "settings.models.claude-code.codeReview.earlier"],
    [{ codex: { gateSummary: { earlier: "" } } }, "settings.models.codex.gateSummary.earlier"],
    [{ codex: { gateSummary: { earlier: " Opus" } } }, "settings.models.codex.gateSummary.earlier"],
    [{ codex: { gateSummary: { earlier: "Opus  4.1" } } }, "settings.models.codex.gateSummary.earlier"],
    [{ codex: { gateSummary: { earlier: "Opus\n4.1" } } }, "settings.models.codex.gateSummary.earlier"],
    [{ codex: { gateSummary: { earlier: "x".repeat(201) } } }, "settings.models.codex.gateSummary.earlier"],
    [{ codex: { gateSummary: { earlier: 41 } } }, "settings.models.codex.gateSummary.earlier"]
  ];
  for (const [value, where] of refusals) await refusedNaming(s.root, value, where);
  assert.deepEqual((await state(s.root)).state.settings.models, stored, "a refused write changes nothing");
});

test("clause 13: the models action shows an earlier name, refuses to apply it with its reason, and takes any other value in its place", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  const migrated = { designImplementation: { earlier: EARLIER }, codeReview: { model: "sonnet", typed: true }, securityReview: { model: "opus", typed: true } };
  await write(s.root, { models: { delivery: EARLIER, review: "sonnet", securityReview: "opus" } });
  const action = actionOf(await listing(s.base, TARGET, s.headers), "initiative.models");
  assert.equal(action.available, true, action.reason);
  const shown = { model: null, effort: null, typed: false, earlier: EARLIER };
  assert.deepEqual(action.value["claude-code"].designImplementation, shown);
  assert.deepEqual(action.value.codex.designImplementation, shown);
  assert.deepEqual(action.value["claude-code"].codeReview, { model: "sonnet", effort: null, typed: true });
  assert.deepEqual(action.value["claude-code"].gateSummary, HOST_DEFAULT);
  const rest = { codeReview: { model: "sonnet", effort: null, typed: true }, securityReview: { model: "opus", effort: null, typed: true } };
  const held = await send(s, "initiative.models", models({ coordinator: { model: "fable", effort: "high", typed: false }, designImplementation: shown, ...rest }));
  assert.equal(held.status, 400, JSON.stringify(held.json));
  assert.deepEqual([held.json.code, held.json.field, held.json.message], ["invalid_input", "designImplementation", earlierReason("Claude Code")]);
  const codex = await send(s, "initiative.models", models({ host: "codex", designImplementation: shown }));
  assert.deepEqual([codex.status, codex.json.field, codex.json.message], [400, "designImplementation", earlierReason("Codex")]);
  const malformed = await send(s, "initiative.models", models({ designImplementation: { ...shown, earlier: "Opus\n4.1" } }));
  assert.deepEqual([malformed.status, malformed.json.code, malformed.json.field], [400, "invalid_input", "designImplementation"]);
  assert.deepEqual((await state(s.root)).state.settings.models, { "claude-code": migrated, codex: migrated }, "nothing refused is stored");
  const replaced = await send(s, "initiative.models", models({ coordinator: { model: "fable", effort: "high", typed: false }, ...rest }));
  assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
  assert.deepEqual((await state(s.root)).state.settings.models, {
    "claude-code": { coordinator: { model: "fable", effort: "high" }, codeReview: { model: "sonnet", typed: true }, securityReview: { model: "opus", typed: true } },
    codex: migrated
  }, "the host default replaces the earlier name of the changed host, and every other host keeps its own");
});

// The tools that Prism's MCP server lists, from a server of its own.
async function listTools(t) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PRISM_REVIEW_APP: "off", PRISM_REVIEW_BROWSER_ON_START: "off" } });
  t.after(() => child.kill());
  let buffer = "";
  const answers = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) answers.push(JSON.parse(line));
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  await settled(() => answers.find((item) => item.id === 1));
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  return (await settled(() => answers.find((item) => item.id === 2))).result.tools;
}
