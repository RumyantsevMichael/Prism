import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, openPage, skip, useAppDirectory, waitForView, writeClaim } from "./fixtures/kit-browser.mjs";
import { controlledPath, stubBin } from "./fixtures/launched-sessions.mjs";
import { settled } from "./fixtures/wait.mjs";

// The page draws again whenever its data changes, which an agent's work does every few seconds. A dialog open in the page, such as an
// initiative's Settings or Launch dialog or a slice's Details and settings, stays open through that: the page behind it, the dialog, its
// unapplied choices, and its focus stay as they are, and the page draws its new data once the dialog closes.
// The demo's Harden request retries has the slice Retry timed-out requests until a total deadline; a new claim on it changes both pages.

const INITIATIVE = "initiative:retry-hardening";
const SLICE = "slice:retry-hardening/timeout-retries";

/** The page in a tab the server opened, which holds the write grant the settings need, with no host on PATH so no real host can start. */
async function writablePage(context, ref) {
  await useAppDirectory(context);
  if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-data-")));
  delete process.env.CLAUDE_PLUGIN_DATA;
  const inherited = process.env.PATH;
  process.env.PATH = controlledPath(await stubBin(context, []), inherited);
  context.after(() => { process.env.PATH = inherited; });
  const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
  const opened = [];
  const root = await demoProject(context);
  const review = await startReviewServer({ projectRoot: root, openBrowser: async (url) => { opened.push(url); return true; } });
  context.after(() => review.close());
  await review.open([ref]);
  const page = await openPage(await launch(context), opened.at(-1));
  await waitForView(page);
  return { page, root };
}

// Marks the dialog, the focused control, and the page's view, so a check can tell whether any of them was drawn again.
const mark = (page, dialog) => dialog.evaluate((element) => {
  element.closest("prism-dialog").dataset.kept = "dialog";
  document.activeElement.dataset.kept = "focus";
  document.querySelector("#artifact").firstElementChild.dataset.kept = "view";
});
const kept = (page) => page.evaluate(() => ({
  dialog: document.querySelector('[data-kept="dialog"]')?.isOpen ?? false,
  focus: document.activeElement?.dataset.kept ?? null,
  view: document.querySelector("#artifact")?.firstElementChild?.dataset.kept ?? null
}));

/** Writes a claim on the slice and waits for two checks of the project after it, the first of which would redraw the page. */
async function changeData(page, root, label) {
  await writeClaim(root, "retry-hardening", "timeout-retries", { label });
  for (let check = 0; check < 2; check += 1) await page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/api/index"));
}

const shown = (page, label) => page.locator("#artifact").getByText(label, { exact: false }).first().isVisible().catch(() => false);
const focusedName = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

for (const [opener, name] of [["Settings", "Settings of Harden request retries"], ["Launch", "Launch Harden request retries"]]) {
  test(`an initiative's ${opener} dialog stays open with its choices and focus while the page's data changes, and the page draws the change once it closes`, { skip, timeout: 90000 }, async (context) => {
    const { page, root } = await writablePage(context, INITIATIVE);
    await page.locator("#artifact [data-page-end]").getByRole("button", { name: opener, exact: true }).click();
    const dialog = page.getByRole("dialog", { name });
    await dialog.waitFor();
    await dialog.getByRole("group", { name: "Autonomy" }).getByRole("button", { name: "Full", exact: true }).click();
    await mark(page, dialog);
    await changeData(page, root, "Builder on night-shift");
    assert.deepEqual(await kept(page), { dialog: true, focus: "focus", view: "view" }, "the dialog, its focus, and the page behind it are the same elements");
    assert.equal(await dialog.getByRole("group", { name: "Autonomy" }).locator("prism-button[pressed=true]").innerText(), "Full", "the unapplied choice stays");
    assert.equal(await shown(page, "Builder on night-shift"), false, "the page behind the dialog waits");
    await page.keyboard.press("Escape");
    assert.equal(await settled(() => shown(page, "Builder on night-shift"), true), true, "the page draws the new claim once the dialog closes");
    assert.equal(await dialog.count() === 0 || !(await dialog.isVisible()), true);
    assert.equal(await settled(() => focusedName(page), opener), opener, "focus goes back to the button that opened the dialog");
    assert.deepEqual(page.errors, []);
  });
}

test("a slice's Details and settings dialog stays open while the page's data changes, and the page draws the change once it closes", { skip, timeout: 90000 }, async (context) => {
  const { page, root } = await writablePage(context, SLICE);
  await page.getByRole("button", { name: "Details and settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Details and settings" });
  await dialog.waitFor();
  // The slice's settings apply each choice at once, so the test moves focus to one without choosing it.
  await dialog.getByRole("group", { name: "Autonomy" }).getByRole("button", { name: "Full", exact: true }).focus();
  await mark(page, dialog);
  await changeData(page, root, "Builder on night-shift");
  assert.deepEqual(await kept(page), { dialog: true, focus: "focus", view: "view" }, "the dialog, its focus, and the page behind it are the same elements");
  assert.equal(await shown(page, "Builder on night-shift"), false, "the page behind the dialog waits");
  await page.keyboard.press("Escape");
  assert.equal(await settled(() => shown(page, "Builder on night-shift"), true), true, "the page draws the new claim once the dialog closes");
  assert.equal(await settled(() => page.evaluate(() => document.activeElement?.getAttribute("label") ?? document.activeElement?.textContent?.trim()), "Details and settings"), "Details and settings", "focus goes back to Details and settings in the page bar");
  assert.deepEqual(page.errors, []);
});

test("a redraw that was under way when a dialog opened waits for the dialog to close before it replaces the page", { skip, timeout: 90000 }, async (context) => {
  const { page, root } = await writablePage(context, INITIATIVE);
  // The page's next read of the initiative waits until the dialog is open, so its redraw finishes while the dialog shows.
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  let holding = false;
  await page.route((url) => url.pathname.endsWith("/api/entity"), async (route) => {
    if (holding) await held;
    await route.continue();
  });
  holding = true;
  const read = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/api/entity"));
  await writeClaim(root, "retry-hardening", "timeout-retries", { label: "Builder on night-shift" });
  await read;
  await page.locator("#artifact [data-page-end]").getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings of Harden request retries" });
  await dialog.waitFor();
  await mark(page, dialog);
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/api/entity"));
  holding = false;
  release();
  await answered;
  await page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/api/index"));
  assert.deepEqual(await kept(page), { dialog: true, focus: "focus", view: "view" }, "the finished redraw left the dialog and the page as they were");
  assert.equal(await shown(page, "Builder on night-shift"), false);
  await page.keyboard.press("Escape");
  assert.equal(await settled(() => shown(page, "Builder on night-shift"), true), true, "the redraw replaces the page once the dialog closes");
  assert.equal(await settled(() => focusedName(page), "Settings"), "Settings", "focus goes back to Settings");
  assert.deepEqual(page.errors, []);
});
