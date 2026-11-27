import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { isolateGit } from "./fixtures/workspace-view.mjs";
import { launch, skip } from "./fixtures/kit-browser.mjs";
import { open } from "./fixtures/places-browser.mjs";
import { codePlaceWorkspace } from "./fixtures/code-place.mjs";

// Requirements: docs/requirements/code-place.md §2, §18, §24.
// The app builds a changed view out of sight beside the one showing, so a click on the tree still showing must reach the page being built.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const cleanups = [];
const suite = { after: (cleanup) => cleanups.push(cleanup) };
test.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
const TIMEOUT = { skip, timeout: 600000 };

const tree = (page) => page.getByRole("tree", { name: "Files of every repository" });
const treeRow = (page, name) => tree(page).getByRole("treeitem", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) }).first();
const expanded = (page, label) => page.waitForFunction((name) => [...document.querySelectorAll("prism-tree-item")].some((node) => node.getAttribute("label") === name && node.hasAttribute("expanded") && !node.closest(".artifact-stage")), label, { timeout: 20000 });

test("a folder clicked on the view still showing while the app builds the next view opens in the view that replaces it", TIMEOUT, async () => {
  const built = await codePlaceWorkspace(suite);
  await built.ready("place");
  const browser = await launch(suite);
  const page = await open(browser, `${built.prism.viewer}/w/${built.id}`, "code");
  await tree(page).waitFor({ timeout: 20000 });
  for (const name of ["api", "src", "retry"]) {
    await treeRow(page, name).locator(":scope > a").first().click();
    await expanded(page, name);
  }
  // Opening a file builds the next view out of sight; once its tree is drawn there, infra is clicked on the view still showing.
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector(".artifact-stage prism-tree")) return;
      observer.disconnect();
      const shown = [...document.querySelectorAll('prism-tree-item[data-code-repository="infra"]')].find((node) => !node.closest(".artifact-stage"));
      globalThis.clickedInfra = Boolean(shown);
      shown?.querySelector(":scope > a")?.click();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await treeRow(page, "strategy.ts").locator(":scope > a").first().click();
  await page.getByRole("group", { name: "Versions of this file" }).waitFor({ timeout: 20000 });
  assert.equal(await page.evaluate(() => globalThis.clickedInfra), true, "infra was clicked while the next view was built");
  await expanded(page, "infra");
  for (const name of ["api", "src", "retry"]) assert.equal(await treeRow(page, name).getAttribute("aria-expanded"), "true", `${name} stays open`);
});
