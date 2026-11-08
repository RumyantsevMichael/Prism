import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, launch, openPage, serveProject, settle, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §3, §4, §5, §7.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 25 and 26.
// Feature: docs/Features/F-review-app-appearance.feature.
// The person chooses the theme and density from the status bar's Appearance menu of the real review page.

const stored = async (base) => (await fetch(`${base}/api/preferences`)).json();
const appearance = (page) => page.evaluate(() => ({ choice: document.documentElement.dataset.themeChoice, theme: document.documentElement.dataset.theme, density: document.documentElement.dataset.density }));

async function open(context) {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/`, { colorScheme: "light" });
  return { base, browser, page };
}

test("clause 25: the status bar ends with an Appearance button whose menu offers the theme, the density, and the catalog", { skip }, async (context) => {
  const { page } = await open(context);
  const status = page.locator("#statusbar");
  const button = status.getByRole("button", { name: "Appearance", exact: true });
  assert.equal(await button.count(), 1);
  const last = await status.evaluate((bar) => {
    const buttons = [...bar.querySelectorAll("prism-button")].filter((item) => item.getClientRects().length && !item.closest("[hidden]"));
    return buttons.at(-1)?.textContent.trim();
  });
  assert.equal(last, "Appearance", "Appearance is the last control of the status bar");
  await button.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  assert.equal(await menu.count(), 1);
  const theme = page.getByRole("group", { name: "Theme" });
  const density = page.getByRole("group", { name: "Density" });
  for (const name of ["System", "Light", "Dark"]) assert.equal(await theme.getByRole("menuitemradio", { name, exact: true }).count(), 1, `Theme offers ${name}`);
  for (const name of ["Compact", "Comfortable"]) assert.equal(await density.getByRole("menuitemradio", { name, exact: true }).count(), 1, `Density offers ${name}`);
  assert.equal(await page.getByRole("menuitem", { name: "Component catalog" }).count(), 1);
  assert.equal(await theme.getByRole("menuitemradio", { name: "System" }).getAttribute("aria-checked"), "true");
  assert.equal(await density.getByRole("menuitemradio", { name: "Compact" }).getAttribute("aria-checked"), "true");
});

test("clause 26: choosing Dark from the keyboard applies it at once, stores it, and keeps it after a reload", { skip }, async (context) => {
  const { base, page } = await open(context);
  const button = page.locator("#statusbar").getByRole("button", { name: "Appearance", exact: true });
  await button.focus();
  await page.keyboard.press("Enter");
  // The first enabled item is System; Light and Dark follow it.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.deepEqual(await appearance(page), { choice: "dark", theme: "dark", density: "compact" });
  assert.equal(await page.getByRole("menu").count(), 0, "choosing closes the menu");
  assert.deepEqual(await stored(base), { theme: "dark", density: "compact" });
  await page.reload();
  await settle(page);
  assert.equal((await appearance(page)).theme, "dark");
  await button.click();
  assert.equal(await page.getByRole("menuitemradio", { name: "Dark", exact: true }).getAttribute("aria-checked"), "true");
  assert.equal(await page.getByRole("menuitemradio", { name: "System", exact: true }).getAttribute("aria-checked"), "false");
});

test("clause 26: choosing System again follows the operating system, and Comfortable raises the density", { skip }, async (context) => {
  const { base, page } = await open(context);
  const button = page.locator("#statusbar").getByRole("button", { name: "Appearance", exact: true });
  await button.click();
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  assert.equal((await appearance(page)).theme, "light", "a chosen theme ignores the operating system");
  await button.click();
  await page.getByRole("menuitemradio", { name: "System", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", null, { timeout: 3000 });
  await button.click();
  await page.getByRole("menuitemradio", { name: "Comfortable", exact: true }).click();
  assert.equal((await appearance(page)).density, "comfortable");
  assert.equal(await button.evaluate((element) => element.getBoundingClientRect().height), 30, "kit controls take the comfortable height");
  assert.deepEqual(await stored(base), { theme: "system", density: "comfortable" });
});

test("clause 26: Component catalog opens the catalog in a new tab", { skip }, async (context) => {
  const { base, page } = await open(context);
  await page.locator("#statusbar").getByRole("button", { name: "Appearance", exact: true }).click();
  const [tab] = await Promise.all([page.context().waitForEvent("page"), page.getByRole("menuitem", { name: "Component catalog" }).click()]);
  await tab.waitForLoadState("load");
  assert.equal(tab.url(), `${base}/kit/catalog`);
  assert.equal(page.url().startsWith(base), true, "the review page stays open");
});
