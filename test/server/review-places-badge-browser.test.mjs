import assert from "node:assert/strict";
import test from "node:test";
import { skip } from "./fixtures/kit-browser.mjs";
import { open, placesDemo, SLICE } from "./fixtures/places-browser.mjs";

// The rail's count badge stays readable on its corner, and the narrow page bar draws no separator before its only crumb.

test("the Attention badge caps its count at 99+ and keeps the whole count in its name and tooltip", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  const read = (count) => page.evaluate((count) => {
    const item = [...document.querySelectorAll('prism-rail-item[value="attention"]')].find((node) => node.getClientRects().length);
    item.setAttribute("count", String(count));
    item.setAttribute("count-label", `${count} questions`);
    const badge = item.querySelector(".prism-rail-badge");
    const icon = item.querySelector(".prism-rail-icon").getBoundingClientRect();
    const box = badge.getBoundingClientRect();
    return { text: badge.textContent, name: item.querySelector("button").getAttribute("aria-label"), tip: item.getAttribute("tip"), coveredWidth: Math.max(0, Math.min(icon.right, box.right) - Math.max(icon.left, box.left)) / icon.width };
  }, count);
  const nine = await read(9);
  assert.equal(nine.text, "9");
  const twelve = await read(12);
  assert.equal(twelve.text, "12");
  assert.ok(twelve.coveredWidth <= nine.coveredWidth + 0.01, "two digits cover no more of the glyph than one");
  const many = await read(128);
  assert.equal(many.text, "99+", "a count over 99 shows 99+");
  assert.equal(many.name, "Attention, 128 questions");
  assert.equal(many.tip, "Attention, 128 questions", "the tooltip carries the whole count");
  assert.ok(many.coveredWidth < 1, "the badge leaves part of the glyph uncovered");
  assert.deepEqual(page.errors ?? [], []);
});

test("the page bar draws no separator before the first crumb it shows", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  for (const width of [390, 820]) {
    const page = await open(browser, base, SLICE, { width });
    const first = await page.evaluate(() => {
      const item = [...document.querySelectorAll("#page-bar .prism-breadcrumbs-item")].find((node) => node.getClientRects().length);
      const separator = item?.querySelector(".prism-breadcrumbs-separator");
      return { found: Boolean(item), separator: Boolean(separator?.getClientRects().length) };
    });
    assert.deepEqual(first, { found: true, separator: false }, `the first crumb shown at ${width} has no separator before it`);
  }
  const wide = await open(browser, base, SLICE, { width: 1440 });
  assert.ok(await wide.evaluate(() => [...document.querySelectorAll("#page-bar .prism-breadcrumbs-separator")].filter((node) => node.getClientRects().length).length) > 0, "a wide page bar keeps its separators");
});
