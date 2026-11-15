import assert from "node:assert/strict";
import test from "node:test";
import { shownTooltip, skip } from "./fixtures/kit-browser.mjs";
import { repainted, settled } from "./fixtures/wait.mjs";
import { open, placesDemo, sidebar } from "./fixtures/places-browser.mjs";

// Requirements: docs/requirements/review-app-places.md §45 and §48.
// The status bar starts with Settings, which holds the appearance choices, the sidebar's layout, the record store, and About,
// and the sidebar's edge sets the sidebar's width, which the person keeps as a preference.

const settings = (page) => page.getByRole("dialog", { name: "Settings" });
const statusButtons = (page) => page.locator("#statusbar").evaluate((bar) => [...bar.querySelectorAll("prism-button")]
  .filter((item) => item.getClientRects().length && !item.closest("[hidden]"))
  .map((item) => item.getAttribute("label") || item.textContent.replace(/\s+/g, " ").trim()));
const preferences = async (base) => (await fetch(`${base}/api/preferences`)).json();

test("§45: the status bar starts with a Settings button as tall as the bar that opens one dialog with the appearance choices, the sidebar's layout, the record store, and About, and Ctrl+, opens and closes it", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  const names = await statusButtons(page);
  assert.equal(names[0], "Settings", `Settings is the status bar's first control: ${names}`);
  assert.equal(names.some((name) => /^(Appearance|About)/.test(name)), false, "the Appearance and About buttons are gone");
  const button = page.locator("#statusbar").getByRole("button", { name: "Settings", exact: true });
  const [bar, box] = [await page.locator("#statusbar").boundingBox(), await button.boundingBox()];
  assert.ok(Math.abs(box.height - bar.height) <= 1 && Math.abs(box.width - box.height) <= 1, `the button is a square as tall as the bar: ${box.width}x${box.height} in ${bar.height}`);
  await button.hover();
  assert.equal(await settled(() => shownTooltip(page), "Settings (Ctrl ,)"), "Settings (Ctrl ,)", "its tooltip names the key");
  await button.click();
  await settings(page).waitFor();
  const sections = await settings(page).getByRole("treeitem").allInnerTexts();
  assert.deepEqual(sections.map((name) => name.trim()), ["Appearance", "Layout", "Record store", "About Prism"]);
  const theme = settings(page).getByRole("radiogroup", { name: "Theme" });
  const density = settings(page).getByRole("radiogroup", { name: "Density" });
  for (const name of ["System", "Light", "Dark"]) assert.equal(await theme.getByRole("radio", { name, exact: true }).count(), 1, `Theme offers ${name}`);
  for (const name of ["Compact", "Comfortable"]) assert.equal(await density.getByRole("radio", { name, exact: true }).count(), 1, `Density offers ${name}`);
  assert.equal(await theme.getByRole("radio", { name: "System" }).getAttribute("aria-checked"), "true");
  assert.equal(await density.getByRole("radio", { name: "Compact" }).getAttribute("aria-checked"), "true");
  await settings(page).getByRole("treeitem", { name: "Layout" }).click();
  const layout = settings(page).getByRole("region", { name: "Layout" });
  assert.equal(await layout.getByRole("radiogroup", { name: "Sidebar" }).getByRole("radio", { name: "Shown" }).getAttribute("aria-checked"), "true", "Layout says the sidebar is shown");
  await layout.getByRole("radiogroup", { name: "Sidebar" }).getByRole("radio", { name: "Hidden" }).click();
  assert.equal(await settled(async () => (await preferences(base))["sidebar.collapsed"], true), true, "choosing Hidden hides the sidebar and stores it");
  await layout.getByRole("radiogroup", { name: "Sidebar" }).getByRole("radio", { name: "Shown" }).click();
  await settings(page).getByRole("treeitem", { name: "Record store" }).click();
  assert.equal(await settings(page).getByRole("region", { name: "Record store" }).isVisible(), true, "Record store shows where the records live");
  await settings(page).getByRole("treeitem", { name: "About Prism" }).click();
  const about = settings(page).getByRole("region", { name: "About Prism" });
  assert.match(await about.innerText(), /Version /, "About names the version");
  assert.equal(await about.getByRole("button", { name: /Open the catalog/ }).isVisible(), true, "About opens the component catalog");
  await page.keyboard.press("Control+,");
  await settings(page).waitFor({ state: "hidden", timeout: 3000 });
  assert.equal(await settings(page).isVisible(), false, "Ctrl+, closes it again");
  await page.keyboard.press("Control+,");
  await settings(page).waitFor({ timeout: 3000 });
  assert.equal(await settings(page).isVisible(), true, "and opens it");
  assert.deepEqual(page.errors, []);
});

test("§48: dragging the sidebar's edge sets its width between 200 and 480 pixels, a double click returns it to 248, and the width is kept as a preference", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  const edge = page.getByRole("separator", { name: "Resize the sidebar" });
  const width = async () => Math.round((await page.locator("#sidebar").evaluate((element) => element.parentElement === null ? 0 : element.getBoundingClientRect().width + parseFloat(getComputedStyle(element).marginInlineEnd))));
  const drag = async (by) => {
    const box = await edge.boundingBox();
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + by / 2, y, { steps: 4 });
    await page.mouse.move(x + by, y, { steps: 4 });
    await page.mouse.up();
    await repainted(page);
  };
  assert.equal(await width(), 248, "the sidebar starts at its default width");
  await edge.hover();
  assert.match(await settled(async () => await shownTooltip(page) ?? "", (tip) => /double-click to reset/.test(tip)), /double-click to reset/, "the edge says how to use it");
  await drag(100);
  assert.equal(await settled(width, 348), 348, "dragging widens the sidebar");
  assert.equal(await settled(async () => (await preferences(base))["sidebar.width"], 348), 348, "and keeps the width as a preference");
  await drag(400);
  assert.equal(await settled(width, 480), 480, "the width stops at 480");
  await drag(-600);
  assert.equal(await settled(width, 200), 200, "and at 200");
  await page.reload();
  await sidebar(page).waitFor();
  assert.equal(await settled(width, 200), 200, "a reload keeps the width");
  await edge.dblclick();
  assert.equal(await settled(width, 248), 248, "a double click returns it to 248");
  assert.equal(await settled(async () => (await preferences(base))["sidebar.width"], null), null, "and forgets the width");
  await edge.focus();
  await page.keyboard.press("ArrowRight");
  assert.ok(await settled(width, (shown) => shown > 248) > 248, "the arrow keys widen it from the keyboard too");
  assert.deepEqual(page.errors, []);
});
