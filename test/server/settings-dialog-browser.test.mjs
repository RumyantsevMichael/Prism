import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { escapes, launch, openPage, reviewUrl, serveProject, settle, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// Settings keeps one size whichever section it shows, groups its sections by whose settings they are, and on a phone shows the list of sections or one section.

const SECTIONS = ["Appearance", "Layout", "Personal", "Record store", "Prism's own runs", "Coding agents", "About Prism"];
const GROUPS = ["You", "This workspace", "This computer", "Prism"];

async function settings(context, width) {
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-settings-browser-")));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width, height: 900 } });
  await settle(page);
  await page.locator("#statusbar").getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.waitFor();
  // The dialog rises into place as it opens, so its edges are measured once that has finished.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  return { page, dialog };
}

const edges = (page) => page.evaluate(() => {
  const box = document.querySelector("#settings-dialog dialog").getBoundingClientRect();
  return [box.left, box.top, box.width, box.height];
});

test("Settings keeps its size and position whichever section it shows, and lists its sections in groups", { skip, timeout: 120000 }, async (context) => {
  const { page, dialog } = await settings(context, 1440);
  const nav = dialog.getByRole("navigation", { name: "Settings sections" });
  assert.deepEqual((await nav.locator(".prism-group-heading").allInnerTexts()).map((name) => name.trim().toLowerCase()), GROUPS.map((name) => name.toLowerCase()));
  assert.deepEqual((await nav.getByRole("treeitem").allInnerTexts()).map((name) => name.trim()), SECTIONS);
  const first = await edges(page);
  for (const name of SECTIONS) {
    await nav.getByRole("treeitem", { name, exact: true }).click();
    assert.deepEqual(await edges(page), first, `showing ${name} moves none of the dialog's edges`);
  }
  assert.equal(await dialog.getByRole("button", { name: "All settings" }).isVisible(), false, "All settings shows only on a phone");
  assert.deepEqual(await escapes(page, "#settings-dialog"), [], "nothing escapes its container");
  assert.deepEqual(page.errors, []);
});

test("on a phone Settings fills the window, opens on its list of sections, shows one section at a time, and goes back with All settings", { skip, timeout: 120000 }, async (context) => {
  const { page, dialog } = await settings(context, 390);
  assert.deepEqual(await edges(page), [0, 0, 390, 900], "Settings fills the window");
  const nav = dialog.getByRole("navigation", { name: "Settings sections" });
  const back = dialog.getByRole("button", { name: "All settings" });
  assert.equal(await nav.isVisible(), true, "Settings opens on its list of sections");
  assert.equal(await dialog.getByRole("region", { name: "Appearance" }).isVisible(), false, "no section shows beside the list");
  await nav.getByRole("treeitem", { name: "Layout", exact: true }).click();
  assert.equal(await nav.isVisible(), false, "a chosen section takes the list's place");
  assert.equal(await dialog.getByRole("region", { name: "Layout" }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "settings-back", "focus moves to All settings");
  await back.click();
  assert.equal(await nav.isVisible(), true, "All settings shows the list again");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("value")), "layout", "focus returns to the chosen section");
  await nav.getByRole("treeitem", { name: "Layout", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.locator("#statusbar").getByRole("button", { name: "Settings", exact: true }).click();
  await dialog.waitFor();
  assert.equal(await nav.isVisible(), true, "Settings opens on its list again");
  assert.deepEqual(await escapes(page, "#settings-dialog"), [], "nothing escapes its container");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the page does not scroll sideways");
  assert.deepEqual(page.errors, []);
});
