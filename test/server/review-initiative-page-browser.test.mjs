import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, openPage, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";
import { eventually, open, placesDemo } from "./fixtures/places-browser.mjs";

// Requirements: docs/requirements/review-app-places.md §46, and docs/requirements/review-app-actions.md §1 and §5.
// The demo's Harden request retries is first in Now, in progress with four slices: one blocked, one not started, and two in progress.
// Its settings start at Broad autonomy, Commit on, Push off, and Stepwise continuation.

const INITIATIVE = "initiative:retry-hardening";
const preferences = async (base) => (await fetch(`${base}/api/preferences`)).json();

/** Opens the initiative page in a tab the server opened, which holds the write grant that applying a setting needs. */
async function writablePage(context) {
  await useAppDirectory(context);
  if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-data-")));
  delete process.env.CLAUDE_PLUGIN_DATA;
  const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
  const opened = [];
  const review = await startReviewServer({ projectRoot: await demoProject(context), openBrowser: async (url) => { opened.push(url); return true; } });
  context.after(() => review.close());
  await review.open([INITIATIVE]);
  const browser = await launch(context);
  const page = await openPage(browser, opened.at(-1));
  await waitForView(page);
  return page;
}

const settingsDialog = (page) => page.getByRole("dialog", { name: "Settings of Harden request retries" });
const pressed = (dialog, group) => dialog.getByRole("group", { name: group }).locator("prism-button[pressed=true]").innerText().then((text) => text.trim());
const pick = (dialog, group, value) => dialog.getByRole("group", { name: group }).getByRole("button", { name: value, exact: true }).click();

test("the initiative page heads with its lane and rank, its state and intent, its run totals, Launch, and Settings, and shows its slices as one bar", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, INITIATIVE);
  const artifact = page.locator("#artifact");
  assert.equal(await artifact.locator("[data-page-eyebrow]").innerText(), "INITIATIVE · NOW · #1", "the eyebrow names the lane and the rank in it");
  assert.equal(await artifact.getByRole("heading", { level: 1 }).innerText(), "Harden request retries");
  assert.match(await artifact.locator(".artifact-header").innerText(), /In progress\s+Make retries predictable so callers never wait past a total deadline\./, "the state leads the intent");
  const end = artifact.locator("[data-page-end]");
  assert.deepEqual((await end.locator(":scope > prism-button").allInnerTexts()).map((text) => text.trim()), ["3 h 55 min active · ≈ 19.9M tokens", "Launch", "Settings"]);
  const bar = artifact.locator("prism-slice-bar.initiative-progress");
  assert.equal(await bar.getAttribute("aria-label"), "0 of 4 done · 2 in progress · 1 blocked");
  assert.deepEqual(await bar.evaluate((element) => [...element.shadowRoot.querySelectorAll("prism-status")].map((segment) => segment.getAttribute("value"))), ["in-progress", "in-progress", "blocked", "not-started"], "the bar reads as progress, from the work under way to what has not started");
  const facts = artifact.locator("prism-disclosure.initiative-facts");
  assert.equal(await facts.getAttribute("open"), "", "the facts show by default");
  const factsText = await facts.innerText();
  assert.match(factsText, /Unblocks\s+Export activity reports/, "a dependency is named by its title");
  assert.match(factsText, /Requirements\s+Retry requirements\s+1, 2, 3/, "the requirements of one file are one chip with their numbers");
  assert.equal(await artifact.locator(".initiative-frontier").innerText(), "1 slice can start once its prerequisites finish: Chart retries on the service dashboard");
  const view = artifact.locator(".initiative-toolbar").getByRole("radiogroup", { name: "View" });
  assert.deepEqual((await view.getByRole("radio").allInnerTexts()).map((text) => text.trim()), ["Board", "List", "Graph"]);
  await view.getByRole("radio", { name: "List" }).click();
  assert.equal((await eventually(async () => (await preferences(base))["initiative.view"], "list")), "list", "the view is kept as a preference");
  for (const width of [390, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `the page does not scroll sideways at ${width} pixels`);
  }
  assert.deepEqual(page.errors, []);
});

test("the run totals and Launch open popovers, and Launch offers both hosts with their availability", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, INITIATIVE);
  const end = page.locator("#artifact [data-page-end]");
  await end.getByRole("button", { name: /active/ }).click();
  const totals = page.getByRole("dialog", { name: "Run totals" });
  await totals.waitFor();
  assert.match(await totals.innerText(), /This initiative/, "the popover holds the run totals table");
  await page.keyboard.press("Escape");
  await end.getByRole("button", { name: "Launch", exact: true }).click();
  const launcher = page.getByRole("dialog", { name: "Launch an orchestration" });
  await launcher.waitFor();
  const text = await launcher.innerText();
  assert.match(text, /Launch with Claude Code/);
  assert.match(text, /Launch with Codex/);
  assert.equal(await launcher.getByRole("button", { name: /^Launch with/ }).count(), 0, "each launch is pressed as Launch, since its heading already names the host");
  assert.deepEqual(page.errors, []);
});

test("review-app-actions §1, §5: Settings gathers the initiative's settings in one dialog that applies every change at once, and Cancel or Escape discards them", { skip, timeout: 90000 }, async (context) => {
  const page = await writablePage(context);
  const open = () => page.locator("#artifact [data-page-end]").getByRole("button", { name: "Settings", exact: true }).click();
  await open();
  const dialog = settingsDialog(page);
  await dialog.waitFor();
  const apply = dialog.locator("[data-settings-apply]");
  assert.equal(await apply.innerText(), "Apply");
  assert.equal(await apply.getAttribute("disabled"), "", "nothing to apply before a change");
  assert.deepEqual([await pressed(dialog, "Autonomy"), await pressed(dialog, "Continuation")], ["Broad", "Stepwise"]);
  await pick(dialog, "Autonomy", "Conservative");
  await pick(dialog, "Continuation", "Automatic");
  assert.equal(await eventually(() => apply.innerText(), "Apply 2 changes"), "Apply 2 changes", "the button counts the changes");
  assert.equal(await pressed(dialog, "Autonomy"), "Conservative", "a pick waits for Apply instead of applying at once");
  await page.keyboard.press("Escape");
  await open();
  assert.deepEqual([await pressed(dialog, "Autonomy"), await pressed(dialog, "Continuation"), await apply.innerText()], ["Broad", "Stepwise", "Apply"], "Escape discards the changes");
  await pick(dialog, "Review", "All slices");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await open();
  assert.notEqual(await pressed(dialog, "Review"), "All slices", "Cancel discards the change");
  await pick(dialog, "Autonomy", "Conservative");
  await pick(dialog, "Push", "On");
  await eventually(() => apply.innerText(), "Apply 2 changes");
  await apply.click();
  const confirmation = page.locator("#action-dialog");
  await confirmation.getByRole("button", { name: "Confirm" }).click();
  assert.equal(await eventually(() => dialog.isVisible(), false), false, "the dialog closes once every change applied");
  await page.reload();
  await waitForView(page);
  await open();
  assert.deepEqual([await pressed(dialog, "Autonomy"), await pressed(dialog, "Push")], ["Conservative", "On"], "both changes were applied, the risky one after its confirmation");
  assert.deepEqual(page.errors, []);
});
