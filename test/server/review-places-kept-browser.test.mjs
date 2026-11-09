import assert from "node:assert/strict";
import test from "node:test";
import { skip } from "./fixtures/kit-browser.mjs";
import { choosePlace, item, open, placesDemo, reviewUrl, settledOn, shownRef, sidebar, SLICE, tabs } from "./fixtures/places-browser.mjs";

// What the review app did before the places must keep working with them: shortcuts, tabs, banners, and every page within reach without the palette.

const palette = (page) => page.getByRole("dialog", { name: "Command palette" });

test("clause 27: Ctrl K, Cmd K, the search button, and / outside a field open the palette, and Ctrl+, opens Appearance", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  for (const open of [() => page.keyboard.press("Control+k"), () => page.keyboard.press("Meta+k"), () => page.locator("header").getByRole("button", { name: /^Search or jump to/ }).click(), () => page.keyboard.press("/")]) {
    await page.locator("#artifact").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await open();
    await palette(page).waitFor({ timeout: 3000 });
    assert.equal(await palette(page).isVisible(), true);
    await page.keyboard.press("Escape");
    await palette(page).waitFor({ state: "hidden", timeout: 3000 });
  }
  await page.keyboard.press("Control+,");
  const menu = page.getByRole("menu", { name: /Appearance/ });
  await menu.waitFor({ timeout: 3000 });
  assert.equal(await menu.isVisible(), true, "Ctrl+, opened Appearance");
  await page.keyboard.press("Escape");
  await page.locator("#statusbar").getByRole("button", { name: /Appearance/ }).click();
  await menu.waitFor({ timeout: 3000 });
  assert.equal(await menu.isVisible(), true, "the status bar's Appearance button opened it");
  assert.deepEqual(page.errors, []);
});

test("clause 27: the strip of tabs keeps its preview, Keep, close, middle-click close, and reload, opened from the places' sidebars", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Work");
  await item(sidebar(page), "Harden request retries").click();
  await settledOn(page, "initiative:retry-hardening");
  await item(sidebar(page), "Export activity reports").click();
  await settledOn(page, "initiative:activity-reports");
  assert.deepEqual(await tabs(page), ["initiative:activity-reports*(p)"], "each click replaced the one preview tab");
  await choosePlace(page, "Knowledge");
  await item(sidebar(page), "Decisions").click({ modifiers: ["Control"] });
  await settledOn(page, "decisions");
  assert.deepEqual(await tabs(page), ["initiative:activity-reports(p)", "decisions*"], "Ctrl-click kept a tab");
  await page.getByRole("tab", { name: /^Export activity reports/ }).click();
  await page.getByRole("tablist", { name: "Open artifacts" }).getByRole("button", { name: "Keep", exact: true }).click();
  await page.waitForTimeout(400);
  assert.deepEqual(await tabs(page), ["initiative:activity-reports*", "decisions"], "Keep kept the preview tab");
  await page.reload();
  await page.waitForTimeout(1000);
  assert.deepEqual(await tabs(page), ["initiative:activity-reports*", "decisions"], "the tabs came back after a reload");
  await page.getByRole("tab", { name: /^Decisions/ }).click({ button: "middle" });
  await page.waitForTimeout(400);
  assert.deepEqual(await tabs(page), ["initiative:activity-reports*"], "a middle click closed the tab");
  await page.getByRole("tablist", { name: "Open artifacts" }).getByRole("button", { name: /^Close/ }).first().click();
  await page.waitForTimeout(400);
  assert.deepEqual(await tabs(page), [], "the close button closed the last tab");
  assert.deepEqual(page.errors, []);
});

test("clause 27: Back, Forward, Alt+arrows, Who's working, the project menu, and the connection banner keep working", { skip, timeout: 90000 }, async (context) => {
  const { base, browser, close } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Roadmap");
  await settledOn(page, "roadmap");
  await page.locator("#page-bar").getByRole("button", { name: "Back" }).click();
  await settledOn(page, "attention");
  await page.keyboard.press("Alt+ArrowRight");
  await settledOn(page, "roadmap");
  await page.keyboard.press("Alt+ArrowLeft");
  await settledOn(page, "attention");
  await page.locator("#page-bar").getByRole("button", { name: "Forward" }).click();
  await settledOn(page, "roadmap");
  await page.locator("header").getByRole("button", { name: /working/ }).click();
  await page.getByRole("dialog", { name: "Who's working" }).waitFor({ timeout: 3000 });
  await page.keyboard.press("Escape");
  await page.locator("header [aria-haspopup=menu]").first().click();
  await page.getByRole("menu").first().waitFor({ timeout: 3000 });
  await page.keyboard.press("Escape");
  await close();
  await page.waitForFunction(() => [...document.querySelectorAll("#banners prism-banner")].some((banner) => !banner.hidden), null, { timeout: 30000 });
  assert.ok(true, "a banner says the review server stopped answering");
});

test("clause 28: every page the app served before is reachable from the rail, a place's sidebar, or a page those lead to", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "roadmap");
  const via = async (place, row) => {
    await choosePlace(page, place);
    await item(sidebar(page), row).click();
  };
  const follow = async (selector) => page.locator("#artifact").locator(selector).first().click();
  const reached = [];
  await via("Knowledge", "Requirements");
  await settledOn(page, "requirements");
  reached.push(await shownRef(page));
  await page.locator("#artifact").getByRole("link", { name: "Retry requirements" }).first().click();
  await settledOn(page, "docs/requirements/retries.md");
  reached.push(await shownRef(page));
  await via("Knowledge", "Decisions");
  await settledOn(page, "decisions");
  await page.locator("#artifact").getByRole("link", { name: "Bound retries by a total deadline" }).first().click();
  await settledOn(page, "docs/ADRs/retries/total-retry-deadline.md");
  reached.push(await shownRef(page));
  await via("Knowledge", "Glossary");
  await settledOn(page, "glossary");
  reached.push(await shownRef(page));
  await via("Work", "Harden request retries");
  await settledOn(page, "initiative:retry-hardening");
  reached.push(await shownRef(page));
  await follow(`a[data-artifact="${SLICE}"]`);
  await settledOn(page, SLICE);
  reached.push(await shownRef(page));
  await page.locator("#artifact prism-tab").filter({ hasText: /^\s*Files/ }).first().click();
  await follow('[data-artifact$=".puml"]');
  await page.waitForFunction(() => new URL(location.href).searchParams.get("artifact")?.endsWith(".puml"), null, { timeout: 10000 });
  reached.push("diagram");
  await choosePlace(page, "Roadmap");
  await settledOn(page, "roadmap");
  await page.locator("#artifact").getByRole("button", { name: /Show shipped and superseded/ }).click().catch(() => {});
  await page.locator("#artifact").getByRole("link", { name: "Audit administrative actions" }).first().click();
  await settledOn(page, "initiative:audit-log");
  reached.push(await shownRef(page));
  await choosePlace(page, "Attention");
  await page.locator("#sidebar").getByRole("treeitem").first().click();
  await settledOn(page, "attention");
  reached.push(await shownRef(page));
  await page.locator("#statusbar").getByRole("button", { name: /Appearance/ }).click();
  const catalog = page.context().waitForEvent("page", { timeout: 5000 });
  await page.getByRole("menuitem", { name: /Component catalog/ }).click();
  const opened = await catalog;
  await opened.waitForLoadState("domcontentloaded");
  assert.match(opened.url(), /\/kit\/catalog/);
  assert.deepEqual(reached, ["requirements", "docs/requirements/retries.md", "docs/ADRs/retries/total-retry-deadline.md", "glossary", "initiative:retry-hardening", SLICE, "diagram", "initiative:audit-log", "attention"]);
  assert.equal(page.url().includes("palette"), false);
  assert.deepEqual(page.errors, []);
});
