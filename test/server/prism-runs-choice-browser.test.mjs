import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { escapes, launch, openPage, skip, waitForView } from "./fixtures/kit-browser.mjs";
import { runOptionsReview } from "./fixtures/run-options-hosts.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/launched-sessions.md §24, and docs/requirements/launch-run-configuration.md §16.
// The app's Settings dialog holds the host and model of Prism's own runs on this computer, with the same Host select and
// model picker as an initiative's run choices.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-runs-choice-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const skipHere = skip || (process.platform === "win32" ? "the stub hosts are POSIX scripts" : false);

/** The review page in a tab that Prism opened, which holds the write grant, with the app's Settings at Prism's own runs. */
async function section(t, { hosts, viewport } = {}) {
  const s = await runOptionsReview(t, hosts ? { hosts } : {});
  await s.review.open([]);
  const granted = new URL(s.opened.at(-1));
  const page = await openPage(await launch(t), `${granted.origin}${granted.pathname.replace(/\/$/, "")}/review?artifact=attention${granted.hash}`, viewport ? { viewport } : {});
  await waitForView(page);
  await page.locator("#statusbar").getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor();
  await settings.getByRole("treeitem", { name: "Prism's own runs" }).click();
  const region = settings.getByRole("region", { name: "Prism's own runs" });
  await region.waitFor();
  return { ...s, page, settings, region };
}

const picker = (scope) => scope.locator('prism-picker[label="Model"]');
const ready = (scope) => settled(() => picker(scope).evaluate((element) => !element.hasAttribute("busy")), true, { timeout: 15000 });

test("clause 8: Settings has a section for Prism's own runs after the record store, with the host select and the model picker", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await section(t, { hosts: ["claude"] });
  const sections = (await s.settings.getByRole("treeitem").allInnerTexts()).map((name) => name.trim());
  assert.deepEqual(sections, ["Appearance", "Layout", "Record store", "Prism's own runs", "About Prism"]);
  assert.match(await s.region.innerText(), /Prism's own runs on this computer, such as moving records to a new format, start with this host and model; a run already started keeps its own\./);
  const host = s.region.getByRole("combobox", { name: "Host" });
  const options = await host.locator("option").evaluateAll((items) => items.map((item) => [item.value, item.textContent.trim(), item.disabled]));
  assert.deepEqual(options, [["automatic", "Any available host", false], ["claude-code", "Claude Code", false], ["codex", "Codex: unavailable", true]]);
  assert.equal(await host.inputValue(), "automatic");
  assert.match(await s.region.innerText(), /Codex was not found: no codex executable on PATH\./);
  assert.equal(await picker(s.region).evaluate((element) => element.hasAttribute("disabled")), true, "any available host takes only its default model");
  assert.deepEqual(s.page.errors, []);
});

test("clause 8: choosing a host and a model from its report and applying them stores the choice on this computer", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await section(t);
  await s.region.getByRole("combobox", { name: "Host" }).selectOption("claude-code");
  await ready(s.region);
  await picker(s.region).getByRole("button", { name: "Model" }).click();
  const popover = s.page.getByRole("dialog", { name: "Model of Prism's own runs" });
  await popover.waitFor();
  const names = (await popover.getByRole("option").allInnerTexts()).map((text) => text.split("\n")[0].trim());
  assert.deepEqual(names, ["Host default", "Opus 5.5", "Fable 5.2", "Sonnet 5.5", "Haiku 5.5", "Opus 4.6", "Haiku 4.5", "Other model…"], "the same models as a launch's coordinator");
  await popover.getByRole("option", { name: /^Sonnet 5\.5/ }).click();
  await popover.getByRole("group", { name: "Effort" }).getByRole("button", { name: "Medium", exact: true }).click();
  await s.page.keyboard.press("Escape");
  await s.region.getByRole("button", { name: "Apply", exact: true }).click();
  const file = path.join(s.app, "prism-runs.json");
  const stored = await settled(() => readFile(file, "utf8").then(JSON.parse).catch(() => null), (value) => value !== null);
  assert.deepEqual([stored.host, stored.model, stored.effort, stored.typed], ["claude-code", "sonnet", "medium", false]);
  await s.page.reload();
  await waitForView(s.page);
  await s.page.locator("#statusbar").getByRole("button", { name: "Settings", exact: true }).click();
  await s.settings.getByRole("treeitem", { name: "Prism's own runs" }).click();
  await ready(s.region);
  assert.equal(await s.region.getByRole("combobox", { name: "Host" }).inputValue(), "claude-code");
  assert.match(await picker(s.region).getByRole("button", { name: "Model" }).innerText(), /Sonnet 5\.5\s*·?\s*Medium effort/);
  assert.deepEqual(s.page.errors, []);
});

test("clause 8: on a phone-wide window the section stays inside the window", { skip: skipHere, timeout: 90000 }, async (t) => {
  const s = await section(t, { viewport: { width: 390, height: 844 } });
  await s.region.getByRole("combobox", { name: "Host" }).selectOption("codex");
  await ready(s.region);
  assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "the page does not scroll sideways");
  assert.deepEqual(await escapes(s.page, '[role="dialog"]'), []);
  assert.deepEqual(s.page.errors, []);
});
