import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { escapes, launch, openPage, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";
import { INITIATIVE, runOptionsFixture } from "./fixtures/run-options-hosts.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/launch-run-configuration.md §1, §2, §3, §12, §15, §17.
// Launch on an initiative page opens one run configuration dialog: the latest run, the host, every initiative setting, and the
// model choices, filled with the initiative's values; confirming saves them as the initiative's settings and then launches.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-config-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const skipHere = skip || (process.platform === "win32" ? "the stub hosts are POSIX scripts" : false);

const TARGET = `initiative:${INITIATIVE}`;
const KINDS = ["Coordinator", "Design and implementation", "Code review", "Security review", "Design gate summary"];

const coordination = async (root) => {
  const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  return readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
};
const writeSettings = async (root, settings) => {
  const { updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const read = await coordination(root);
  return updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: read.exists ? read.revision : null, changes: { settings } });
};

/** The initiative page in a tab that Prism opened, which holds the write grant; open() presses Launch and waits for the dialog. */
async function runPage(t, { hosts, viewport, before } = {}) {
  const fixture = await runOptionsFixture(t, hosts ? { hosts } : {});
  fixture.useAsProcessEnv();
  const s = { ...fixture, ...(await startActionReview(t, fixture.root)) };
  if (before) await before(s);
  await s.review.open([TARGET]);
  const page = await openPage(await launch(t), s.opened.at(-1), viewport ? { viewport } : {});
  await waitForView(page);
  const dialog = page.getByRole("dialog", { name: "Launch Export reports" });
  const open = async () => {
    await page.locator("#artifact [data-page-end]").getByRole("button", { name: "Launch", exact: true }).click();
    await dialog.waitFor();
  };
  return { ...s, page, dialog, open };
}

const launchButton = (dialog) => dialog.getByRole("button", { name: /^Launch with / });
/** The launch button's label as a person reads it: the name its visible text gives the one launch button. */
const launchLabel = (dialog) => launchButton(dialog).ariaSnapshot().then((snapshot) => snapshot.match(/^- button "([^"]*)"/)?.[1]);
const pressed = (dialog, group) => dialog.getByRole("group", { name: group }).locator("prism-button[pressed=true]").innerText().then((text) => text.trim());
const pick = (dialog, group, value) => dialog.getByRole("group", { name: group }).getByRole("button", { name: value, exact: true }).click();
const picker = (dialog, label) => dialog.locator(`prism-picker[label="${label}"]`);
const ready = (dialog, label) => settled(() => picker(dialog, label).evaluate((element) => !element.hasAttribute("busy")), true, { timeout: 15000 });
const enabled = (locator) => locator.evaluate((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true");
const launchesOf = async (s) => (await fetch(`${s.base}/api/launches`)).json().then((body) => body.launches ?? []);

test("clause 1: Launch opens one dialog with the host, how the run works, and the models, and starts nothing until the person confirms", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await runPage(t);
  await s.open();
  assert.equal(await s.page.getByRole("dialog", { name: "Launch an orchestration" }).count(), 0, "no popover of launches per host");
  const text = await s.dialog.innerText();
  assert.match(text, /These are this initiative's settings; change any of them before the run starts\./);
  const order = ["Host", "How the run works", "Autonomy", "Commit", "Push", "Continuation", "Review", "Models", "Coordinator", "Design and implementation", "Code review", "Security review", "Design gate summary"];
  const positions = order.map((word) => text.indexOf(word));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), `the dialog reads in order: ${JSON.stringify(Object.fromEntries(order.map((word, index) => [word, positions[index]])))}`);
  assert.equal(await s.dialog.getByRole("radiogroup", { name: "Host" }).evaluate((element) => element.value), "claude-code");
  assert.deepEqual(await s.dialog.locator("prism-picker").evaluateAll((items) => items.map((item) => item.getAttribute("label"))), KINDS);
  assert.match(text, /Launching saves these choices as this initiative's settings\./);
  assert.equal(await launchLabel(s.dialog), "Launch with Claude Code");
  assert.equal(await s.dialog.getByRole("button", { name: "Cancel" }).count(), 1);
  assert.deepEqual(s.launchRuns(), [], "opening the dialog starts no session");
  assert.deepEqual(await launchesOf(s), []);
  assert.deepEqual(s.page.errors, []);
});

test("clause 2: the dialog shows the initiative's current values, and each choice says what it does in plain words", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await runPage(t, {
    before: (fixture) => writeSettings(fixture.root, { autonomy: "broad", commit: "on", push: "off", continuation: "stepwise", review: "recommended", models: { "claude-code": { coordinator: { model: "fable", effort: "high" } } } })
  });
  await s.open();
  assert.deepEqual([await pressed(s.dialog, "Autonomy"), await pressed(s.dialog, "Continuation"), await pressed(s.dialog, "Review")], ["Broad", "Stepwise", "Recommended slices"]);
  await ready(s.dialog, "Coordinator");
  assert.match(await picker(s.dialog, "Coordinator").getByRole("button", { name: "Coordinator" }).innerText(), /Fable 5\.2\s*·?\s*High effort/);
  const tips = async (group) => s.dialog.getByRole("group", { name: group }).locator("prism-button").evaluateAll((buttons) => buttons.map((button) => [button.textContent.trim(), button.getAttribute("tip")]));
  assert.deepEqual(await tips("Autonomy"), [
    ["Conservative", "You approve every design and answer every decision."],
    ["Broad", "Designs that change no requirement, add no decision record and raise no open question are accepted without you; you answer the rest."],
    ["Full", "Agents accept every design and settle internal decisions without you; they never turn on Push."]
  ]);
  assert.deepEqual(await tips("Continuation"), [
    ["Automatic", "The next slice starts as soon as one finishes."],
    ["Stepwise", "The run stops after each slice until you continue it."]
  ]);
  assert.deepEqual(await tips("Review"), [
    ["Marked slices", "Only slices you mark for review at the design gate."],
    ["Recommended slices", "Slices you mark, plus those the design recommends reviewing."],
    ["All slices", "Every slice gets a code review."]
  ]);
  assert.match(await s.dialog.getByRole("group", { name: "Review" }).locator("xpath=..").innerText(), /Slices you mark, plus those the design recommends reviewing\./, "the chosen value's consequence shows under it");
  assert.doesNotMatch(await s.dialog.innerText(), /\b(delivery|examples|orchestrat\w*|concept|run model|securityReview|gateSummary)\b/i, "no internal word reaches the dialog");
  assert.deepEqual(s.page.errors, []);
});

test("clause 3: confirming saves every changed choice as the initiative's settings, under their confirmations, and then launches with them", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await runPage(t);
  await s.open();
  await pick(s.dialog, "Autonomy", "Broad");
  await pick(s.dialog, "Push", "On");
  await ready(s.dialog, "Coordinator");
  await picker(s.dialog, "Coordinator").getByRole("button", { name: "Coordinator" }).click();
  const popover = s.page.getByRole("dialog", { name: "Coordinator model" });
  await popover.getByRole("option", { name: /^Sonnet 5\.5/ }).click();
  await popover.getByRole("group", { name: "Effort" }).getByRole("button", { name: "Low", exact: true }).click();
  await s.page.keyboard.press("Escape");
  assert.equal(await s.dialog.isVisible(), true, "closing the picker keeps the dialog open");
  assert.equal((await coordination(s.root)).state?.settings?.autonomy, undefined, "nothing is saved before the launch is confirmed");
  await launchButton(s.dialog).click();
  const confirmation = s.page.locator("#action-dialog");
  await confirmation.getByRole("button", { name: "Confirm" }).click();
  await settled(() => s.dialog.isVisible(), false, { timeout: 30000 });
  const [run] = await settled(() => s.launchRuns("claude"), (runs) => runs.length === 1, { timeout: 30000 });
  assert.ok(run, "one session launched");
  const settings = (await coordination(s.root)).state.settings;
  assert.deepEqual([settings.autonomy, settings.push], ["broad", "on"], "the settings were saved, the risky one after its confirmation");
  assert.deepEqual(settings.models["claude-code"].coordinator, { model: "sonnet", effort: "low" });
  const tail = run.argv.slice(-4);
  assert.deepEqual(tail, ["--model", "sonnet", "--effort", "low"], "the launch ran with the saved coordinator choice");
  const history = (await coordination(s.root)).state.history ?? [];
  const actions = history.map((entry) => entry.action).filter(Boolean);
  assert.ok(actions.indexOf("launch.run") > actions.lastIndexOf("initiative.models"), `the settings are saved before the launch: ${JSON.stringify(actions)}`);
  await s.open();
  assert.match(await s.dialog.locator("[data-launch-latest]").innerText(), /Latest run · Claude Code/, "the latest run leads the dialog once there is one");
  assert.deepEqual(s.page.errors, []);
});

test("clause 4: Cancel and Escape discard the dialog's changes and launch nothing", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await runPage(t, { before: (fixture) => writeSettings(fixture.root, { autonomy: "broad" }) });
  await s.open();
  await pick(s.dialog, "Autonomy", "Full");
  await s.page.keyboard.press("Escape");
  await settled(() => s.dialog.isVisible(), false);
  await s.open();
  assert.equal(await pressed(s.dialog, "Autonomy"), "Broad", "Escape discards the change");
  await pick(s.dialog, "Autonomy", "Conservative");
  await s.dialog.getByRole("button", { name: "Cancel" }).click();
  await settled(() => s.dialog.isVisible(), false);
  await s.open();
  assert.equal(await pressed(s.dialog, "Autonomy"), "Broad", "Cancel discards the change");
  assert.equal((await coordination(s.root)).state.settings.autonomy, "broad");
  assert.deepEqual(s.launchRuns(), []);
  assert.deepEqual(s.dialogs(), [], "no confirmation was asked");
  assert.deepEqual(s.page.errors, []);
});

test("clause 5: choosing another host names it on the launch button, shows its own choices, and launches it", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await runPage(t, {
    before: (fixture) => writeSettings(fixture.root, { models: { codex: { provider: "openai", coordinator: { model: "gpt-5.5", effort: "high" } } } })
  });
  await s.open();
  await s.dialog.getByRole("radiogroup", { name: "Host" }).getByRole("radio", { name: "Codex" }).check();
  assert.equal(await settled(() => launchLabel(s.dialog), "Launch with Codex"), "Launch with Codex");
  await settled(() => s.dialog.locator("prism-picker").count(), 6);
  await ready(s.dialog, "Coordinator");
  assert.match(await picker(s.dialog, "Coordinator").getByRole("button", { name: "Coordinator" }).innerText(), /GPT-5\.5\s*·?\s*High effort/);
  await launchButton(s.dialog).click();
  const [run] = await settled(() => s.launchRuns("codex"), (runs) => runs.length === 1, { timeout: 30000 });
  assert.ok(run, "Codex launched");
  assert.equal((await coordination(s.root)).state.settings.host, "codex", "the host is saved as the initiative's setting");
  assert.deepEqual(s.page.errors, []);
});

test("clause 5: a host this computer lacks shows unavailable with its reason and cannot be chosen", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await runPage(t, { hosts: ["claude"] });
  await s.open();
  const options = await s.dialog.getByRole("radiogroup", { name: "Host" }).getByRole("radio").evaluateAll((items) => items.map((item) => [item.value, item.disabled]));
  assert.deepEqual(options, [["claude-code", false], ["codex", true]]);
  const missing = /Codex was not found: no codex executable on PATH\./;
  assert.match(await settled(() => s.dialog.innerText(), (text) => missing.test(text)), missing);
  assert.equal(await launchLabel(s.dialog), "Launch with Claude Code");
  assert.deepEqual(s.page.errors, []);
});

test("clause 6: without any supported host the dialog says so, names the hosts Prism supports, and offers no launch", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await runPage(t, { hosts: [] });
  await s.open();
  // The dialog reads the hosts after it opens and says Loading… until then.
  const none = /No host that Prism supports was found on this computer\. Prism supports Claude Code and Codex\./;
  assert.match(await settled(() => s.dialog.innerText(), (text) => none.test(text)), none);
  const button = s.dialog.getByRole("button", { name: /^Launch/ });
  assert.equal(await button.count(), 1);
  assert.equal(await enabled(button), false, "the launch cannot be pressed");
  await button.click({ force: true });
  assert.deepEqual(s.launchRuns(), []);
  assert.equal(await s.dialog.getByRole("group", { name: "Autonomy" }).count(), 1, "the settings still show");
  assert.deepEqual(s.page.errors, []);
});

test("clause 7: a saved choice the host does not offer shows why and holds the launch until the person chooses an offered value", { skip: skipHere, timeout: 120000 }, async (t) => {
  const s = await runPage(t, {
    before: (fixture) => writeSettings(fixture.root, { models: { "claude-code": { codeReview: { model: "claude-opus-3" } } } })
  });
  await s.open();
  await ready(s.dialog, "Code review");
  assert.match(await picker(s.dialog, "Code review").innerText(), /Not offered: Claude Code on this computer does not offer the model claude-opus-3\./);
  assert.equal(await enabled(launchButton(s.dialog)), false, "no launch while a choice is not offered");
  assert.match(await s.dialog.innerText(), /Code review: Claude Code on this computer does not offer the model claude-opus-3\./, "the dialog says what holds the launch");
  await picker(s.dialog, "Code review").getByRole("button", { name: "Code review" }).click();
  const popover = s.page.getByRole("dialog", { name: "Code review model" });
  await popover.getByRole("option", { name: /^Host default/ }).click();
  await s.page.keyboard.press("Escape");
  assert.equal(await settled(() => enabled(launchButton(s.dialog)), true), true, "the host default releases the launch");
  await launchButton(s.dialog).click();
  await settled(() => s.launchRuns("claude"), (runs) => runs.length === 1, { timeout: 30000 });
  assert.equal((await coordination(s.root)).state.settings.models?.["claude-code"]?.codeReview, undefined, "the host default replaced the saved choice");
  assert.deepEqual(s.page.errors, []);
});

test("clause 8: a declined launch shows its reason in the dialog and keeps it open", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await runPage(t);
  await s.open();
  await ready(s.dialog, "Coordinator");
  await s.setDialog({ code: 1 });
  await launchButton(s.dialog).click();
  assert.match(await settled(() => s.dialog.innerText(), (text) => text.includes("You declined the launch."), { timeout: 20000 }), /You declined the launch\./, "the refusal's reason shows in the dialog");
  assert.equal(await s.dialog.isVisible(), true, "the dialog stays open for another try");
  assert.deepEqual(s.launchRuns(), []);
  assert.deepEqual(s.page.errors, []);
});

test("clause 9: on a phone-wide window the dialog and its pickers stay inside the window", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await runPage(t, { viewport: { width: 390, height: 844 } });
  await s.open();
  await ready(s.dialog, "Design gate summary");
  assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "the page does not scroll sideways");
  const box = await s.dialog.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `the dialog stays inside the window: ${JSON.stringify(box)}`);
  assert.deepEqual(await escapes(s.page, "prism-dialog"), []);
  assert.deepEqual(s.page.errors, []);
});
