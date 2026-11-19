import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { escapes, launch, openPage, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { INITIATIVE, runOptionsReview } from "./fixtures/run-options-hosts.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/launch-run-configuration.md §4, §6, §11, §12, §13, §14, §16, §17, and docs/requirements/initiative-settings.md §10.
// The host and the model choices of an initiative's Settings, drawn from what the stub hosts report on this computer:
// one Host select, a Models section of pickers for the coordinator and each kind of agent, and the effort of the chosen model.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-choice-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const skipHere = skip || (process.platform === "win32" ? "the stub hosts are POSIX scripts" : false);

const TARGET = `initiative:${INITIATIVE}`;
const KINDS = ["Coordinator", "Design and implementation", "Code review", "Security review", "Design gate summary"];
const HINTS = [
  "Only coordinates: it plans the order of work, starts the agents below and asks you at gates. It writes no code.",
  "Writes each slice's design, tests and code.",
  "Reviews each finished slice.",
  "Reviews slices that touch access, secrets or other trust boundaries.",
  "Turns the design's tests into the short summaries you read at the design gate."
];
const CLAUDE_MODELS = ["Host default", "Opus 5.5", "Fable 5.2", "Sonnet 5.5", "Haiku 5.5", "Opus 4.6", "Haiku 4.5", "Other model…"];

const writeSettings = async (root, settings) => {
  const { readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const read = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  return updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: read.exists ? read.revision : null, changes: { settings } });
};
const storedModels = async (root) => {
  const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  return (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state?.settings?.models;
};

/** The initiative page in a tab that Prism opened, which holds the write grant, with its Settings dialog open. */
async function settingsDialog(t, { hosts, viewport, before } = {}) {
  const s = await runOptionsReview(t, hosts ? { hosts } : {});
  if (before) await before(s);
  await s.review.open([TARGET]);
  const page = await openPage(await launch(t), s.opened.at(-1), viewport ? { viewport } : {});
  await waitForView(page);
  const open = async () => {
    await page.locator("#artifact [data-page-end]").getByRole("button", { name: "Settings", exact: true }).click();
    await dialog.waitFor();
  };
  const dialog = page.getByRole("dialog", { name: "Settings of Export reports" });
  await open();
  return { ...s, page, dialog, open };
}

const picker = (scope, label) => scope.locator(`prism-picker[label="${label}"]`);
const ready = (scope, label) => settled(() => picker(scope, label).evaluate((element) => !element.hasAttribute("busy")), true, { timeout: 15000 });
const shown = async (scope, label) => {
  await ready(scope, label);
  return picker(scope, label).getByRole("button", { name: label }).innerText().then((text) => text.replace(/\s+/g, " ").trim());
};
async function openPicker(page, scope, label, heading = `${label} model`) {
  await ready(scope, label);
  await picker(scope, label).getByRole("button", { name: label }).click();
  const popover = page.getByRole("dialog", { name: heading });
  await popover.waitFor();
  return popover;
}
const optionNames = (popover) => popover.getByRole("option").allInnerTexts().then((texts) => texts.map((text) => text.split("\n")[0].trim()));
const efforts = (popover) => popover.getByRole("group", { name: "Effort" }).getByRole("button").allInnerTexts().then((texts) => texts.map((text) => text.trim()));
const pressedEffort = (popover) => popover.getByRole("group", { name: "Effort" }).locator("prism-button[pressed=true]").innerText().then((text) => text.trim());
const applyAll = async (s) => {
  const apply = s.dialog.locator("[data-settings-apply]");
  await settled(() => apply.evaluate((element) => !element.hasAttribute("disabled")), true);
  await apply.click();
  const confirmation = s.page.locator("#action-dialog");
  if (await confirmation.getByRole("button", { name: "Confirm" }).isVisible().catch(() => false)) await confirmation.getByRole("button", { name: "Confirm" }).click();
  await settled(() => s.dialog.isVisible(), false);
};

test("clause 1: Settings shows the host as one select of every supported host, with one this computer lacks disabled and its reason", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await settingsDialog(t, { hosts: ["claude"] });
  const host = s.dialog.getByRole("combobox", { name: "Host" });
  assert.equal(await host.count(), 1, "one Host select, which the Models section follows");
  const options = await host.locator("option").evaluateAll((items) => items.map((item) => [item.value, item.textContent.trim(), item.disabled]));
  assert.deepEqual(options, [["claude-code", "Claude Code", false], ["codex", "Codex: unavailable", true]]);
  assert.equal(await host.inputValue(), "claude-code", "with no stored host the first host found shows");
  assert.match(await s.dialog.innerText(), /Codex was not found: no codex executable on PATH\./, "the reason shows below the select");
  assert.match(await s.dialog.innerText(), /The hosts Prism supports, as found on this computer\. Each host reports its own models, providers and effort levels\./);
  assert.deepEqual(s.page.errors, []);
});

test("clause 2: the Models section shows the coordinator and each kind of agent as a picker with its hint, reading Host default until one is chosen", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await settingsDialog(t);
  const models = s.dialog.locator("[data-run-choices]");
  assert.equal(await models.count(), 1);
  assert.deepEqual(await models.locator("prism-picker").evaluateAll((items) => items.map((item) => item.getAttribute("label"))), KINDS, "Claude Code reports no provider, so no Provider picker shows");
  for (const [index, label] of KINDS.entries()) {
    assert.match(await shown(models, label), /^Host default\s*·?\s*Host default effort$/, `${label} reads the host default`);
    assert.equal(await picker(models, label).getAttribute("hint"), HINTS[index]);
  }
  await s.dialog.getByRole("combobox", { name: "Host" }).selectOption("codex");
  await settled(() => models.locator("prism-picker").count(), 6);
  assert.deepEqual(await models.locator("prism-picker").evaluateAll((items) => items.map((item) => item.getAttribute("label"))), ["Provider", ...KINDS], "Codex reports providers, so its Provider picker leads");
  assert.equal(await picker(models, "Provider").getAttribute("hint"), "Where the host sends its model requests; only some hosts offer a choice.");
  assert.match(await shown(models, "Provider"), /^Host default/);
  assert.deepEqual(s.page.errors, []);
});

test("clause 3: each picker shows that it reads while the host's options are read, and a failed read names its reason and still offers the host default and a typed model", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await settingsDialog(t, {
    hosts: ["claude"],
    before: async (fixture) => {
      process.env.PRISM_RUN_OPTIONS_TIMEOUT_MS = "4000";
      t.after(() => { delete process.env.PRISM_RUN_OPTIONS_TIMEOUT_MS; });
      await fixture.setCatalog({ claude: { hang: true } });
    }
  });
  const coordinator = picker(s.dialog, "Coordinator");
  await coordinator.waitFor();
  assert.equal(await coordinator.evaluate((element) => element.hasAttribute("busy")), true, "the picker is busy while the read runs");
  assert.match(await coordinator.getByRole("button", { name: "Coordinator" }).innerText(), /Reading Claude Code’s models…/);
  await ready(s.dialog, "Coordinator");
  assert.match(await s.dialog.innerText(), /Claude Code did not report its run options: it gave no answer within 4 seconds\./);
  const popover = await openPicker(s.page, s.dialog, "Coordinator");
  assert.deepEqual(await optionNames(popover), ["Host default", "Other model…"]);
  assert.deepEqual(s.page.errors, []);
});

test("clause 4: the coordinator's picker lists the host's models in its order between Host default and Other model, with the effort levels of the chosen model", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await settingsDialog(t);
  const popover = await openPicker(s.page, s.dialog, "Coordinator");
  assert.equal(await popover.getByRole("searchbox", { name: "Filter models" }).count(), 1);
  assert.deepEqual(await optionNames(popover), CLAUDE_MODELS);
  assert.match(await popover.getByRole("option", { name: /^Host default/ }).innerText(), /Opus 5\.5 · Best for everyday, complex tasks/, "the host default names what the host runs by default");
  assert.match(await popover.innerText(), /Effort for Host default/);
  assert.deepEqual(await efforts(popover), ["Host default", "Low", "Medium", "High", "Extra high", "Max"]);
  assert.equal(await pressedEffort(popover), "Host default");
  assert.match(await popover.innerText(), /Levels come from the chosen model and change with it\./);
  await s.page.keyboard.press("Escape");
  const agents = await openPicker(s.page, s.dialog, "Code review");
  assert.deepEqual(await optionNames(agents), ["Host default", "Opus 5.5", "Fable 5.2", "Sonnet 5.5", "Haiku 5.5", "Other model…"], "an agent takes the families the host's agents take");
  assert.match(await agents.getByRole("option", { name: /^Host default/ }).innerText(), /The coordinator's model, unless the host's settings name a model for agents\./);
  assert.deepEqual(s.page.errors, []);
});

test("clause 5: choosing a model offers its own effort levels, and an effort it does not take shows as not offered", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await settingsDialog(t);
  const popover = await openPicker(s.page, s.dialog, "Coordinator");
  await popover.getByRole("option", { name: /^Fable 5\.2/ }).click();
  assert.equal(await popover.isVisible(), true, "the popover stays open for the effort");
  await popover.getByRole("group", { name: "Effort" }).getByRole("button", { name: "Extra high", exact: true }).click();
  assert.match(await shown(s.dialog, "Coordinator"), /^Fable 5\.2\s*·?\s*Extra high effort$/);
  await popover.getByRole("option", { name: /^Opus 4\.6/ }).click();
  assert.match(await popover.innerText(), /Effort for Opus 4\.6/);
  assert.deepEqual(await settled(() => efforts(popover), (levels) => !levels.includes("Extra high")), ["Host default", "Low", "Medium", "High", "Max"], "the levels follow the new model");
  assert.match(await picker(s.dialog, "Coordinator").innerText(), /Not offered: Opus 4\.6 does not take the effort xhigh\./, "the earlier effort shows as not offered");
  assert.equal(await picker(s.dialog, "Coordinator").getByRole("button", { name: "Coordinator" }).getAttribute("aria-invalid"), "true");
  await popover.getByRole("option", { name: /^Haiku 4\.5/ }).click();
  assert.deepEqual(await settled(() => efforts(popover), (levels) => levels.length === 1), ["Host default"], "a model without effort levels takes only the host default");
  assert.deepEqual(s.page.errors, []);
});

test("clause 6: model choices wait for Apply, which stores them for the shown host, and the dialog shows them when opened again", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await settingsDialog(t);
  const coordinator = await openPicker(s.page, s.dialog, "Coordinator");
  await coordinator.getByRole("option", { name: /^Fable 5\.2/ }).click();
  await coordinator.getByRole("group", { name: "Effort" }).getByRole("button", { name: "High", exact: true }).click();
  await s.page.keyboard.press("Escape");
  const review = await openPicker(s.page, s.dialog, "Code review");
  await review.getByRole("option", { name: /^Opus 5\.5/ }).click();
  await s.page.keyboard.press("Escape");
  assert.equal(await storedModels(s.root), undefined, "nothing is stored before Apply");
  await applyAll(s);
  assert.deepEqual(await storedModels(s.root), { "claude-code": { coordinator: { model: "fable", effort: "high" }, codeReview: { model: "opus" } } });
  await s.page.reload();
  await waitForView(s.page);
  await s.open();
  assert.match(await shown(s.dialog, "Coordinator"), /^Fable 5\.2\s*·?\s*High effort$/);
  assert.match(await shown(s.dialog, "Code review"), /^Opus 5\.5\s*·?\s*Host default effort$/);
  assert.deepEqual(s.page.errors, []);
});

test("clause 7: switching the host shows the choices kept for that host and its provider, and switching back shows the first host's unchanged", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await settingsDialog(t, {
    before: (fixture) => writeSettings(fixture.root, { host: "claude-code", models: {
      "claude-code": { coordinator: { model: "fable", effort: "high" } },
      codex: { provider: "openai", coordinator: { model: "gpt-6-luna", effort: "minimal" } }
    } })
  });
  assert.match(await shown(s.dialog, "Coordinator"), /^Fable 5\.2\s*·?\s*High effort$/);
  const host = s.dialog.getByRole("combobox", { name: "Host" });
  await host.selectOption("codex");
  assert.match(await settled(() => shown(s.dialog, "Coordinator"), (text) => text.startsWith("GPT")), /^GPT-6 Luna\s*·?\s*Minimal effort$/, "Codex's kept choice shows, not Claude Code's");
  assert.match(await shown(s.dialog, "Provider"), /^OpenAI/);
  await host.selectOption("claude-code");
  assert.match(await settled(() => shown(s.dialog, "Coordinator"), (text) => text.startsWith("Fable")), /^Fable 5\.2\s*·?\s*High effort$/, "Claude Code's choice is kept while Codex shows");
  await host.selectOption("codex");
  await applyAll(s);
  const models = await storedModels(s.root);
  assert.deepEqual(models["claude-code"], { coordinator: { model: "fable", effort: "high" } }, "applying the switch keeps every other host's choices");
  assert.deepEqual(s.page.errors, []);
});

test("clause 8: a saved choice that the host no longer offers shows as not offered with its reason", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await settingsDialog(t, {
    before: (fixture) => writeSettings(fixture.root, { models: { "claude-code": { coordinator: { model: "claude-opus-3", effort: "high" } } } })
  });
  await ready(s.dialog, "Coordinator");
  const coordinator = picker(s.dialog, "Coordinator");
  assert.match(await coordinator.getByRole("button", { name: "Coordinator" }).innerText(), /claude-opus-3/, "the saved name still shows");
  assert.match(await coordinator.innerText(), /Not offered: Claude Code on this computer does not offer the model claude-opus-3\./);
  assert.equal(await coordinator.getByRole("button", { name: "Coordinator" }).getAttribute("aria-invalid"), "true");
  const popover = await openPicker(s.page, s.dialog, "Coordinator");
  await popover.getByRole("option", { name: /^Host default/ }).click();
  await s.page.keyboard.press("Escape");
  await settled(() => coordinator.innerText(), (text) => !text.includes("Not offered"));
  assert.doesNotMatch(await coordinator.innerText(), /Not offered/, "choosing an offered value clears it");
  assert.deepEqual(s.page.errors, []);
});

test("clause 8: an earlier model name shows as not offered from the saved value, and Apply sends it back unchanged until the person chooses", { skip: skipHere, timeout: 90000 }, async (t) => {
  const earlier = { "claude-code": { designImplementation: { earlier: "Claude Opus 4.1" } }, codex: { codeReview: { earlier: "GPT 5 (work)" } } };
  const s = await settingsDialog(t, { before: (fixture) => writeSettings(fixture.root, { models: earlier }) });
  const requests = [];
  s.page.on("request", (request) => requests.push(request.url()));
  await s.page.keyboard.press("Escape");
  await settled(() => s.dialog.isVisible(), false);
  await s.open();
  await ready(s.dialog, "Design and implementation");
  const design = picker(s.dialog, "Design and implementation");
  assert.match(await design.getByRole("button", { name: "Design and implementation" }).innerText(), /Claude Opus 4\.1/, "the earlier name still shows");
  assert.match(await design.innerText(), /Not offered: Prism kept the earlier model name Claude Opus 4\.1, which Claude Code cannot take as a model\./);
  assert.equal(await design.getByRole("button", { name: "Design and implementation" }).getAttribute("aria-invalid"), "true");
  assert.deepEqual(requests.filter((url) => url.includes("api/run-options") && /Claude(%20|\+| )Opus/.test(url)), [], "the earlier name is never sent to api/run-options");
  const coordinator = await openPicker(s.page, s.dialog, "Coordinator");
  await coordinator.getByRole("option", { name: /^Fable 5\.2/ }).click();
  await s.page.keyboard.press("Escape");
  const apply = s.dialog.locator("[data-settings-apply]");
  await settled(() => apply.evaluate((element) => !element.hasAttribute("disabled")), true);
  const answered = s.page.waitForResponse((response) => response.request().method() === "POST" && (response.request().postData() ?? "").includes('"initiative.models"'));
  await apply.click();
  const response = await answered;
  const input = JSON.parse(response.request().postData()).input;
  assert.equal(input.designImplementation?.earlier, "Claude Opus 4.1", "an untouched earlier name goes back as it was");
  assert.equal(input.designImplementation?.model ?? null, null, "and never as a model");
  assert.equal(response.status(), 400, "the models action refuses the earlier name");
  assert.deepEqual(await storedModels(s.root), earlier, "so nothing changes");
  if (await s.dialog.isVisible()) await s.page.keyboard.press("Escape");
  await settled(() => s.dialog.isVisible(), false);
  await s.open();
  const replaced = await openPicker(s.page, s.dialog, "Design and implementation");
  await replaced.getByRole("option", { name: /^Host default/ }).click();
  await s.page.keyboard.press("Escape");
  await settled(() => design.innerText(), (text) => !text.includes("Not offered"));
  assert.doesNotMatch(await design.innerText(), /Not offered/, "choosing the host default clears it");
  await applyAll(s);
  assert.deepEqual(await storedModels(s.root), { codex: earlier.codex }, "the chosen value replaces the earlier name, and the other host keeps its own");
  assert.deepEqual(s.page.errors, []);
});

test("clause 9: Other model takes a typed name, which shows that Prism cannot check it and is stored as typed, and a name that breaks the rule is not taken", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await settingsDialog(t);
  const popover = await openPicker(s.page, s.dialog, "Coordinator");
  await popover.getByRole("option", { name: /^Other model…/ }).click();
  const name = popover.getByRole("textbox", { name: "Model name" });
  await name.waitFor();
  await name.fill("-p");
  await name.press("Enter");
  assert.match(await popover.innerText(), /A model name has 1 to 200 letters, digits, and \. _ - : \/ @ \[ \] \+, and starts with a letter or digit\./);
  assert.match(await shown(s.dialog, "Coordinator"), /^Host default/, "a name that breaks the rule is not taken");
  await name.fill("us.anthropic.claude-opus-4-8[1m]");
  await name.press("Enter");
  assert.match(await shown(s.dialog, "Coordinator"), /^us\.anthropic\.claude-opus-4-8\[1m\]/);
  assert.match(await picker(s.dialog, "Coordinator").innerText(), /Prism cannot check a model you typed; Claude Code receives it as written\./);
  assert.deepEqual(await efforts(popover), ["Host default", "Low", "Medium", "High", "Extra high", "Max"], "a typed model offers every level the host reports");
  await s.page.keyboard.press("Escape");
  await applyAll(s);
  assert.deepEqual((await storedModels(s.root))["claude-code"].coordinator, { model: "us.anthropic.claude-opus-4-8[1m]", typed: true });
  assert.deepEqual(s.page.errors, []);
});

test("clause 10: a provider that reports no models says so and offers the host default and a typed name", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await settingsDialog(t, { before: (fixture) => writeSettings(fixture.root, { host: "codex" }) });
  const providers = await openPicker(s.page, s.dialog, "Provider", "Provider");
  assert.deepEqual(await optionNames(providers), ["Host default", "OpenAI", "Local server"], "a provider is chosen from the host's list only");
  await providers.getByRole("option", { name: /^Local server/ }).click();
  await settled(() => providers.isVisible(), false);
  const models = await openPicker(s.page, s.dialog, "Coordinator");
  assert.deepEqual(await settled(() => optionNames(models), (names) => names.length === 2), ["Host default", "Other model…"]);
  assert.match(await models.innerText(), /Codex reported no models\./);
  assert.deepEqual(s.page.errors, []);
});

test("clause 11: on a phone-wide window the Models section and an open picker stay inside the window", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await settingsDialog(t, { viewport: { width: 390, height: 844 } });
  await ready(s.dialog, "Design gate summary");
  const popover = await openPicker(s.page, s.dialog, "Coordinator");
  const box = await popover.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `the popover stays inside the window: ${JSON.stringify(box)}`);
  assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "the page does not scroll sideways");
  assert.deepEqual(await escapes(s.page, "[data-run-choices]"), []);
  assert.deepEqual(s.page.errors, []);
});
