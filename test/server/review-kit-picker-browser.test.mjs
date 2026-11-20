import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { escapes, launch, openPage, ROOT, serveProject, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { repainted, settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/launch-run-configuration.md §16, §17.
// prism-picker: a field-like value control that opens a chooser popover with a filter, a list of options, and extra controls.
// It is exercised through its attributes, events, and keys on the served catalog page, where the kit loads as it ships.

async function catalog(context, viewport = { width: 1280, height: 800 }) {
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-picker-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/kit/catalog`, { viewport });
  await page.waitForFunction(() => customElements.get("prism-button") !== undefined, null, { timeout: 5000 });
  return page;
}

async function mount(page, html) {
  await page.evaluate((html) => {
    document.querySelector("#fixture")?.remove();
    const region = document.createElement("div");
    region.id = "fixture";
    region.style.setProperty("padding", "16px");
    region.innerHTML = html;
    document.body.prepend(region);
    window.scrollTo(0, 0);
    window.__changes = [];
    region.addEventListener("change", (event) => { if (event.target.tagName === "PRISM-PICKER") window.__changes.push(event.detail?.value ?? null); });
  }, html);
  await repainted(page);
}

const OPTIONS = `<prism-list-item value="opus">Opus 5.5<span slot="detail">Best for everyday, complex tasks</span></prism-list-item>
<prism-list-item value="fable" selected>Fable 5.2<span slot="detail">Most capable for the hardest, longest tasks</span></prism-list-item>
<prism-list-item value="sonnet">Sonnet 5.5<span slot="detail">Efficient for routine tasks</span></prism-list-item>
<prism-list-item value="old" disabled>Opus 3<span slot="detail">No longer offered</span></prism-list-item>`;
// The HTML parser keeps the first copy of a repeated attribute, so a test's attributes replace the defaults here rather than follow them on the tag.
const DEFAULTS = { id: "pk", label: "Coordinator", heading: "Coordinator model", "filter-label": "Filter models", value: "fable", display: "Fable 5.2", detail: "High effort", hint: "Most capable for the hardest, longest tasks" };
const attribute = ([name, value]) => (value === true ? name : `${name}="${String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`);
const picker = (attributes = {}, extra = "") => `<prism-picker ${Object.entries({ ...DEFAULTS, ...attributes }).map(attribute).join(" ")}>${OPTIONS}${extra}</prism-picker>`;
const EFFORT = `<div slot="extra"><prism-button size="sm" pressed="true">High</prism-button><prism-button size="sm" pressed="false">Max</prism-button></div>`;
const trigger = (page) => page.getByRole("button", { name: "Coordinator" });
const popover = (page) => page.getByRole("dialog", { name: "Coordinator model" });
const filter = (page) => popover(page).getByRole("searchbox", { name: "Filter models" });
const shownOptions = (page) => popover(page).getByRole("option").allInnerTexts().then((texts) => texts.map((text) => text.split("\n")[0].trim()));

test("clause 1: the kit registers prism-picker in light DOM with its catalog entry and a specimen per state", { skip }, async (context) => {
  const kit = await import(pathToFileURL(path.join(ROOT, "dist/server/review/public/kit/kit.js")).href);
  const element = kit.KIT_ELEMENTS.find((item) => item.tag === "prism-picker");
  assert.ok(element, "KIT_ELEMENTS lists prism-picker");
  for (const name of ["label", "value", "display", "detail", "hint", "heading", "filter-label", "invalid", "error", "busy", "disabled"]) assert.ok(element.catalog.options.some((option) => option.name === name), `the catalog documents ${name}`);
  assert.deepEqual(element.catalog.states, ["default", "open", "filtered", "empty", "busy", "invalid", "disabled"]);
  const page = await catalog(context);
  const entry = page.locator('[data-catalog-entry="prism-picker"]');
  assert.equal(await entry.count(), 1);
  for (const state of [...element.catalog.states, "long-text", "unbroken-name"]) assert.ok(await entry.locator(`[data-specimen="${state}"] prism-picker`).count() > 0, `a live ${state} specimen`);
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-catalog-entry="prism-picker"] prism-picker').shadowRoot)), false, "it renders in light DOM");
});

test("clause 2: the picker shows its label, its value and detail in one button, and its hint or error below it", { skip }, async (context) => {
  const page = await catalog(context);
  await mount(page, picker());
  const button = trigger(page);
  assert.equal(await button.count(), 1, "one button named by the label");
  assert.match(await button.innerText(), /Fable 5\.2\s*·?\s*High effort/);
  assert.equal(await button.getAttribute("aria-haspopup"), "dialog");
  assert.equal(await button.getAttribute("aria-expanded"), "false");
  assert.match(await page.locator("#pk").innerText(), /^Coordinator/, "the label shows above the button");
  const hint = page.locator("#pk").getByText("Most capable for the hardest, longest tasks");
  assert.equal(await hint.isVisible(), true, "the hint shows");
  assert.ok((await hint.boundingBox()).y >= (await button.boundingBox()).y + (await button.boundingBox()).height - 1, "the hint shows below the button");
  await page.evaluate(() => { const element = document.querySelector("#pk"); element.setAttribute("invalid", ""); element.setAttribute("error", "Not offered: Claude Code on this computer does not offer the model fable."); });
  await repainted(page);
  assert.equal(await button.getAttribute("aria-invalid"), "true");
  assert.match(await page.locator("#pk").innerText(), /Not offered: Claude Code on this computer does not offer the model fable\./);
});

test("clause 3: the button opens a popover with a focused filter, the options, and the extra controls", { skip }, async (context) => {
  const page = await catalog(context);
  for (const open of ["click", "Enter", " ", "ArrowDown"]) {
    await mount(page, picker({}, EFFORT));
    if (open === "click") await trigger(page).click();
    else {
      await trigger(page).focus();
      await page.keyboard.press(open === " " ? "Space" : open);
    }
    await settled(() => popover(page).isVisible(), true);
    assert.equal(await popover(page).isVisible(), true, `${open} opens it`);
    assert.equal(await trigger(page).getAttribute("aria-expanded"), "true");
    assert.equal(await filter(page).evaluate((element) => element === document.activeElement), true, "the filter takes focus");
    assert.deepEqual(await shownOptions(page), ["Opus 5.5", "Fable 5.2", "Sonnet 5.5", "Opus 3"]);
    assert.equal(await popover(page).getByRole("button", { name: "Max" }).isVisible(), true, "the extra controls show below the list");
  }
});

test("clause 4: typing in the filter keeps only matching options, and shows the empty text when none match", { skip }, async (context) => {
  const page = await catalog(context);
  await mount(page, picker({}, `<p slot="empty">Claude Code reported no models.</p>`));
  await trigger(page).click();
  await filter(page).fill("OPUS");
  assert.deepEqual(await shownOptions(page), ["Opus 5.5", "Opus 3"], "matching ignores letter case");
  await filter(page).fill("zzz");
  assert.deepEqual(await shownOptions(page), []);
  assert.equal(await popover(page).getByText("Claude Code reported no models.").isVisible(), true);
  await mount(page, picker());
  await trigger(page).click();
  await filter(page).fill("zzz");
  assert.equal(await popover(page).getByText("Nothing matches.").isVisible(), true, "without empty content the picker says nothing matches");
});

test("clause 5: choosing an option sets the value, selects only it, sends change, and closes a picker without extra controls", { skip }, async (context) => {
  const page = await catalog(context);
  await mount(page, picker());
  await trigger(page).click();
  await filter(page).fill("son");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#pk").getAttribute("value"), "sonnet");
  assert.deepEqual(await page.evaluate(() => window.__changes), ["sonnet"]);
  assert.deepEqual(await page.locator("#pk prism-list-item[selected]").evaluateAll((items) => items.map((item) => item.getAttribute("value"))), ["sonnet"]);
  await settled(() => popover(page).isVisible(), false);
  assert.equal(await popover(page).isVisible(), false, "it closes");
  assert.equal(await trigger(page).evaluate((element) => element.getRootNode().activeElement === element), true, "focus returns to the button");
  await mount(page, picker({}, EFFORT));
  await trigger(page).click();
  await popover(page).getByRole("option", { name: /Opus 5\.5/ }).click();
  assert.equal(await page.locator("#pk").getAttribute("value"), "opus");
  assert.equal(await popover(page).isVisible(), true, "a picker with extra controls stays open for them");
});

test("clause 6: Escape and a click outside close the popover, and a disabled option cannot be chosen", { skip }, async (context) => {
  const page = await catalog(context);
  await mount(page, picker());
  await trigger(page).click();
  await popover(page).getByRole("option", { name: /Opus 3/ }).click({ force: true });
  assert.equal(await page.locator("#pk").getAttribute("value"), "fable", "the disabled option is not chosen");
  assert.deepEqual(await page.evaluate(() => window.__changes), []);
  await page.keyboard.press("Escape");
  await settled(() => popover(page).isVisible(), false);
  assert.equal(await popover(page).isVisible(), false);
  assert.equal(await trigger(page).getAttribute("aria-expanded"), "false");
  await trigger(page).click();
  await page.mouse.click(5, 700);
  await settled(() => popover(page).isVisible(), false);
  assert.equal(await popover(page).isVisible(), false, "a click outside closes it");
});

test("clause 7: a busy or disabled picker opens nothing, and a busy one shows that it reads", { skip }, async (context) => {
  const page = await catalog(context);
  await mount(page, picker({ busy: true, display: "Reading Claude Code’s models…", detail: "" }));
  assert.equal(await trigger(page).isDisabled(), true);
  assert.equal(await trigger(page).getAttribute("aria-busy"), "true");
  assert.equal(await page.locator("#pk prism-spinner").count(), 1);
  assert.match(await trigger(page).innerText(), /Reading Claude Code’s models…/);
  await mount(page, picker({ disabled: true }));
  assert.equal(await trigger(page).isDisabled(), true);
  await trigger(page).click({ force: true });
  assert.equal(await popover(page).isVisible(), false);
});

test("clause 8: on a phone-wide window the button and the open popover stay inside the window", { skip }, async (context) => {
  const page = await catalog(context, { width: 390, height: 800 });
  await mount(page, picker({ display: "A model name far longer than any phone gives room for, so it has to end early", detail: "Extra high effort" }, EFFORT));
  await trigger(page).click();
  await settled(() => popover(page).isVisible(), true);
  const box = await popover(page).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `the popover stays inside the window: ${JSON.stringify(box)}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "the page does not scroll sideways");
  assert.deepEqual(await escapes(page, "#fixture"), []);
});
