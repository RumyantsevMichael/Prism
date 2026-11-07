import assert from "node:assert/strict";
import test from "node:test";
import { boundaryFailures, contrastFailures, demoProject, escapes, launch, openPage, paintedBackgrounds, reviewUrl, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §2, §3, §7, §8, §9.
// The shell of the real review page runs over the demo and edge-case projects: the top bar, sidebar, status bar, side panel, and Jump to.

const SHELL = "header, #sidebar, #statusbar, #side-panel";
const choose = (base, body) => fetch(`${base}/api/preferences`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function open(context, seed = "seed.mjs", options = {}) {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context, seed));
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "attention"), options);
  await waitForView(page);
  return { base, browser, page };
}

const deepFocus = (page) => page.evaluate(() => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element ? { tag: element.tagName.toLowerCase(), id: element.id, role: element.getAttribute("role"), inDialog: Boolean(element.closest("prism-dialog") ?? element.getRootNode().host?.closest?.("prism-dialog")) } : null;
});

test("the artifact area reports busy while a view loads and not busy once it has rendered", { skip }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => {
    window.__busy = [];
    new MutationObserver(() => {
      const value = document.querySelector("#artifact")?.getAttribute("aria-busy");
      if (value && window.__busy.at(-1) !== value) window.__busy.push(value);
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["aria-busy"], childList: true });
  });
  await page.goto(reviewUrl(base, "roadmap"));
  await waitForView(page);
  const seen = await page.evaluate(() => window.__busy);
  assert.equal(seen.at(-1), "false");
  assert.ok(seen.includes("true"), "the view reported busy while it loaded");
});

test("Jump to opens as a dialog with focus in its search field, drives its matches from the field, and returns focus on Escape", { skip }, async (context) => {
  const { page } = await open(context);
  await page.locator("#sidebar").getByRole("treeitem").first().focus();
  const before = await deepFocus(page);
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Jump to" });
  await dialog.waitFor();
  const field = dialog.getByRole("searchbox").or(dialog.getByRole("combobox"));
  assert.equal(await field.count(), 1);
  assert.equal((await deepFocus(page)).inDialog, true, "focus is in the dialog's field");
  await page.keyboard.type("retry");
  const matches = dialog.getByRole("listbox");
  await matches.getByRole("option").first().waitFor();
  await page.keyboard.press("ArrowDown");
  const active = await page.evaluate(() => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element.getAttribute("aria-activedescendant");
  });
  assert.ok(active, "the field points at the active match");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Jump to" }).count(), 0);
  assert.deepEqual(await deepFocus(page), before, "focus returns where it was");
  await page.keyboard.press("Meta+k");
  await page.getByRole("dialog", { name: "Jump to" }).waitFor();
  await page.keyboard.type("roadmap");
  await page.getByRole("dialog", { name: "Jump to" }).getByRole("option").first().waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await waitForView(page);
  assert.equal(await page.getByRole("tablist", { name: "Open artifacts" }).getByRole("tab", { selected: true }).count(), 1);
});

test("the open artifacts are a tablist, the sidebar is made of trees, and the project switcher is a menu", { skip }, async (context) => {
  const { page } = await open(context);
  const tabs = page.getByRole("tablist", { name: "Open artifacts" });
  assert.equal(await tabs.count(), 1);
  assert.equal(await tabs.getByRole("tab", { name: /Attention/, selected: true }).count(), 1);
  const sidebar = page.locator("#sidebar");
  assert.ok(await sidebar.getByRole("tree").count() >= 1, "the sidebar holds kit trees");
  const roadmap = sidebar.getByRole("treeitem", { name: /^Roadmap/ });
  await roadmap.focus();
  await page.keyboard.press("Enter");
  await waitForView(page);
  assert.equal(await tabs.getByRole("tab", { name: /Roadmap/, selected: true }).count(), 1, "Enter on a tree item opens it");
  await tabs.getByRole("tab", { selected: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await waitForView(page);
  assert.equal(await tabs.getByRole("tab", { name: /Attention/, selected: true }).count(), 1, "tabs switch from the keyboard");
  const switcher = page.locator("header").getByRole("button").filter({ has: page.locator("#project") }).or(page.locator("header [aria-haspopup=menu]")).first();
  assert.equal(await switcher.getAttribute("aria-haspopup"), "menu");
});

test("the shell's text and controls reach WCAG AA and its surfaces follow the theme in both themes", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await open(context);
  const painted = {};
  for (const theme of ["light", "dark"]) {
    await choose(base, { theme });
    const page = await openPage(browser, reviewUrl(base, "attention"));
    await waitForView(page);
    assert.deepEqual(await contrastFailures(page, SHELL), [], `shell text, ${theme}`);
    assert.deepEqual(await boundaryFailures(page, SHELL), [], `shell controls, ${theme}`);
    painted[theme] = await paintedBackgrounds(page, SHELL);
    await page.context().close();
  }
  const same = Object.entries(painted.light).filter(([element, color]) => painted.dark[element] === color).map(([element]) => element);
  assert.deepEqual(same, [], "no shell surface keeps its color in both themes");
});

test("with long names the shell stays inside a phone and a laptop window, and its menus and dialogs stay inside the window", { skip, timeout: 180000 }, async (context) => {
  const { base, browser } = await open(context, "seed-stress.mjs");
  for (const viewport of [{ width: 360, height: 740 }, { width: 1280, height: 800 }]) {
    const page = await openPage(browser, reviewUrl(base, "attention"), { viewport });
    await waitForView(page);
    assert.deepEqual(await escapes(page, SHELL), [], `shell at ${viewport.width}px`);
    await page.locator("header [aria-haspopup=menu]").first().click();
    const menu = await page.evaluate(() => {
      const found = [...document.querySelectorAll("*")].find((node) => node.getAttribute("role") === "menu" && node.getClientRects().length);
      const box = found?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight } : null;
    });
    assert.ok(menu, "the project menu opens");
    assert.ok(menu.left >= 0 && menu.right <= menu.width && menu.top >= 0 && menu.bottom <= menu.height, `the project menu stays inside ${viewport.width}px`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Jump to" }).waitFor();
    await page.keyboard.type("slice");
    await page.waitForTimeout(600);
    assert.deepEqual(await escapes(page, "body"), [], `Jump to at ${viewport.width}px`);
    await page.context().close();
  }
});
