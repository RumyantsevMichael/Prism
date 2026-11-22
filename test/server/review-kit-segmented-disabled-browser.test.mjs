import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { escapes, launch, openPage, serveProject, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// A disabled segmented choice still shows its chosen value, offers no segment to a click, a key, or Tab, and sends no change.
// It is checked on the served catalog page, where the kit loads as it ships, and on its catalog specimen.

async function catalog(context, colorScheme = "light") {
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-segmented-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/kit/catalog`, { colorScheme });
  await page.waitForFunction(() => customElements.get("prism-segmented") !== undefined, null, { timeout: 5000 });
  return page;
}

const state = (page, selector) => page.evaluate((selector) => {
  const group = document.querySelector(selector);
  return {
    value: group.value,
    ariaDisabled: group.getAttribute("aria-disabled"),
    segments: [...group.querySelectorAll(".prism-segment")].map((segment) => ({ value: segment.dataset.value, checked: segment.getAttribute("aria-checked"), disabled: segment.disabled }))
  };
}, selector);

test("the catalog lists the disabled option and state of prism-segmented with a specimen whose segments are all disabled", { skip, timeout: 60000 }, async (context) => {
  const page = await catalog(context);
  const entry = page.locator("#entry-prism-segmented");
  assert.match(await entry.locator('[data-doc="options"]').innerText(), /disabled/);
  assert.match(await entry.locator('[data-doc="states"]').innerText(), /disabled/);
  const specimen = '#entry-prism-segmented [data-specimen="disabled"] prism-segmented';
  const shown = await state(page, specimen);
  assert.equal(shown.ariaDisabled, "true");
  assert.deepEqual(shown.segments.map((segment) => segment.disabled), [true, true, true]);
  assert.equal(shown.segments.find((segment) => segment.checked === "true")?.value, "list", "the chosen value still shows");
  assert.deepEqual(await escapes(page, "#entry-prism-segmented"), []);
});

for (const colorScheme of ["light", "dark"]) {
  test(`a disabled prism-segmented sends no change from a click, a key, or Tab, and the attribute toggles back in the ${colorScheme} theme`, { skip, timeout: 60000 }, async (context) => {
    const page = await catalog(context, colorScheme);
    await page.evaluate(() => {
      const region = document.createElement("div");
      region.id = "fixture";
      region.innerHTML = `<button id="before">Before</button><prism-segmented id="mode" label="Mode" value="a" disabled><span value="a">List</span><span value="b">Board</span></prism-segmented><button id="after">After</button>`;
      document.body.prepend(region);
      window.changes = [];
      document.querySelector("#mode").addEventListener("change", (event) => window.changes.push(event.detail.value));
    });
    await page.locator("#mode .prism-segment[data-value='b']").click({ force: true });
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "after", "Tab skips every disabled segment");
    await page.evaluate(() => document.querySelector("#mode").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    assert.equal((await state(page, "#mode")).value, "a");
    assert.deepEqual(await page.evaluate(() => window.changes), []);
    // Taking the attribute away offers the choice again.
    await page.evaluate(() => { document.querySelector("#mode").disabled = false; });
    const enabled = await state(page, "#mode");
    assert.equal(enabled.ariaDisabled, null);
    assert.deepEqual(enabled.segments.map((segment) => segment.disabled), [false, false]);
    await page.locator("#mode .prism-segment[data-value='b']").click();
    assert.equal((await state(page, "#mode")).value, "b");
    assert.deepEqual(await page.evaluate(() => window.changes), ["b"]);
    assert.deepEqual(page.errors ?? [], []);
  });
}
