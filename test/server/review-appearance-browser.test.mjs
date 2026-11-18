import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, launch, openPage, serveProject, settle, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { repainted } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §3, §4, §5, §7.
// Contract: docs/plans/review-app-ui-kit/slice.md clause 26; the status bar's Settings button that replaced the Appearance menu of clause 25 is tested in review-places-settings-browser.test.mjs.
// Feature: docs/Features/F-review-app-appearance.feature.
// The person chooses the theme and density in the Settings dialog that the status bar's first button opens on the real review page.

// The review app stores every registered preference; these tests read the appearance part of them.
const stored = async (base) => {
  const { theme, density } = await (await fetch(`${base}/api/preferences`)).json();
  return { theme, density };
};
const appearance = (page) => page.evaluate(() => ({ choice: document.documentElement.dataset.themeChoice, theme: document.documentElement.dataset.theme, density: document.documentElement.dataset.density }));

async function open(context) {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/`, { colorScheme: "light" });
  return { base, browser, page };
}

const settings = (page) => page.getByRole("dialog", { name: "Settings" });
async function openSettings(page) {
  await page.locator("#statusbar").getByRole("button", { name: "Settings", exact: true }).click();
  await settings(page).waitFor();
}

test("clause 26: choosing Dark from the keyboard applies it at once, stores it, and keeps it after a reload", { skip }, async (context) => {
  const { base, page } = await open(context);
  const button = page.locator("#statusbar").getByRole("button", { name: "Settings", exact: true });
  await button.focus();
  await page.keyboard.press("Enter");
  await settings(page).waitFor();
  const theme = settings(page).getByRole("radiogroup", { name: "Theme" });
  await theme.getByRole("radio", { name: "System", exact: true }).focus();
  // System is chosen; Light and Dark follow it.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  assert.deepEqual(await appearance(page), { choice: "dark", theme: "dark", density: "compact" });
  assert.equal(await settings(page).isVisible(), true, "choosing keeps Settings open to try another");
  assert.deepEqual(await stored(base), { theme: "dark", density: "compact" });
  await page.reload();
  await settle(page);
  assert.equal((await appearance(page)).theme, "dark");
  await openSettings(page);
  assert.equal(await theme.getByRole("radio", { name: "Dark", exact: true }).getAttribute("aria-checked"), "true");
  assert.equal(await theme.getByRole("radio", { name: "System", exact: true }).getAttribute("aria-checked"), "false");
});

test("clause 26: choosing System again follows the operating system, and Comfortable raises the density", { skip }, async (context) => {
  const { base, page } = await open(context);
  await openSettings(page);
  const theme = settings(page).getByRole("radiogroup", { name: "Theme" });
  await theme.getByRole("radio", { name: "Light", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await repainted(page);
  assert.equal((await appearance(page)).theme, "light", "a chosen theme ignores the operating system");
  await theme.getByRole("radio", { name: "System", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", null, { timeout: 3000 });
  await settings(page).getByRole("radiogroup", { name: "Density" }).getByRole("radio", { name: "Comfortable", exact: true }).click();
  assert.equal((await appearance(page)).density, "comfortable");
  assert.equal(await page.locator("header").getByRole("button", { name: /^Search or jump to/ }).evaluate((element) => element.getBoundingClientRect().height), 30, "kit controls take the comfortable height");
  assert.deepEqual(await stored(base), { theme: "system", density: "comfortable" });
});

test("clause 26: Component catalog opens the catalog in a new tab", { skip }, async (context) => {
  const { base, page } = await open(context);
  await openSettings(page);
  await settings(page).getByRole("treeitem", { name: "About Prism" }).click();
  const [tab] = await Promise.all([page.context().waitForEvent("page"), settings(page).getByRole("button", { name: /Open the catalog/ }).click()]);
  await tab.waitForLoadState("load");
  assert.equal(tab.url(), `${base}/kit/catalog`);
  assert.equal(page.url().startsWith(base), true, "the review page stays open");
});
