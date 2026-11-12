import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { skip } from "./fixtures/kit-browser.mjs";
import { choosePlace, drawer, open, placesDemo, SLICE, sidebar } from "./fixtures/places-browser.mjs";

// Requirements: docs/requirements/review-app-places.md §19.
// The Work filter draws no native search clear button, as the approved mockup draws none, and Escape still clears it before a second Escape closes the drawer.
// PRISM_FILTER_SHOTS=<directory> also saves a screenshot of the filled field per width and theme.

const LONG_QUERY = "a-filter-query-with-no-spaces-anywhere-that-is-longer-than-the-field-can-ever-show";
const SHOTS = process.env.PRISM_FILTER_SHOTS;

test("the Work filter hides the native search clear button at three widths in both themes and Escape clears it first", { skip, timeout: 180000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  for (const width of [1440, 820, 390]) {
    for (const colorScheme of ["light", "dark"]) {
      const page = await open(browser, base, SLICE, { width, colorScheme });
      const narrow = width < 1000;
      if (narrow) {
        await page.locator("header").getByRole("button", { name: "Navigation" }).click();
        await drawer(page).waitFor();
      }
      const scope = narrow ? drawer(page) : sidebar(page);
      await choosePlace(narrow ? scope : page, "Work");
      const field = scope.getByRole("searchbox", { name: "Filter work" });
      // A computed style does not reach the native clear button, so the field's right end is compared empty and holding a short query once the drawer has settled.
      const box = await field.boundingBox();
      const end = { x: box.x + box.width - 32, y: box.y + 2, width: 30, height: box.height - 4 };
      await field.focus();
      await page.waitForTimeout(600);
      const empty = await page.screenshot({ clip: end });
      await field.fill("Emit");
      await page.waitForTimeout(300);
      const filled = await page.screenshot({ clip: end });
      assert.ok(filled.equals(empty), `no native clear button at ${width} ${colorScheme}`);
      await field.fill(LONG_QUERY);
      await page.waitForTimeout(300);
      assert.ok((await field.boundingBox()).x + box.width <= width + 0.5, `the field stays inside the window at ${width} ${colorScheme}`);
      if (SHOTS) await field.screenshot({ path: path.join(SHOTS, `filter-${width}-${colorScheme}.png`) });
      await field.press("Escape");
      assert.equal(await field.inputValue(), "", `Escape clears the field at ${width} ${colorScheme}`);
      if (narrow) {
        assert.equal(await drawer(page).isVisible(), true, "the first Escape keeps the drawer open");
        await field.press("Escape");
        await page.waitForTimeout(400);
        assert.equal(await drawer(page).isVisible(), false, "the second Escape closes the drawer");
      }
      assert.deepEqual(page.errors, []);
      await page.close();
    }
  }
});
