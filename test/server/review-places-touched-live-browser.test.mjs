import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { skip } from "./fixtures/kit-browser.mjs";
import { prepareTouched } from "./fixtures/places-touched.mjs";
import { choosePlace, item, open, placesDemo, settledOn, sidebar, SLICE } from "./fixtures/places-browser.mjs";

// Touched by my work and its sidebar count follow the remembered slice's records while they are shown, as every other page follows its own.

const DESIGN = "docs/plans/retry-hardening/timeout-retries/slice.md";
const ADDED = "- change `docs/requirements/retries.md`: tightens the deadline (§1)\n";

const touchedCount = async (page) => Number((await item(sidebar(page), "Touched by my work").innerText()).match(/(\d+)\s*$/)?.[1]);
const changesCount = async (page) => Number(((await page.locator("#artifact").innerText()).replace(/\s+/g, " ").match(/This work changes (\d+)/) ?? [])[1]);

async function addChange(root) {
  const file = path.join(root, DESIGN);
  await writeFile(file, (await readFile(file, "utf8")).replace("- change `src/retry.mjs`", `${ADDED}- change \`src/retry.mjs\``));
}

async function until(read, expected, timeout = 10000) {
  const end = Date.now() + timeout;
  let value = await read();
  while (value !== expected && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

test("clause 55: Touched by my work and its count redraw when the slice's records change while the page is open", { skip, timeout: 90000 }, async (context) => {
  const { root, base, browser } = await placesDemo(context, { prepare: prepareTouched });
  const page = await open(browser, base, SLICE);
  await choosePlace(page, "Knowledge");
  await item(sidebar(page), "Touched by my work").click();
  await settledOn(page, "knowledge:touched");
  const [changes, count] = [await until(() => changesCount(page), 2), await touchedCount(page)];
  assert.equal(changes, 2);
  const marker = await page.evaluate(() => { const node = document.querySelector("#artifact .knowledge-table"); node.dataset.unchanged = "yes"; return Boolean(node); });
  assert.ok(marker);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.equal(await page.locator("#artifact .knowledge-table[data-unchanged=yes]").count(), 1, "an unchanged answer does not redraw the page");
  await addChange(root);
  assert.equal(await until(() => changesCount(page), 3), 3, "the page shows the added record");
  assert.equal(await until(() => touchedCount(page), count + 1), count + 1, "the sidebar counts it");
  assert.deepEqual(page.errors, []);
});

test("clause 55: the Touched by my work count follows the remembered slice while another Knowledge page is open", { skip, timeout: 90000 }, async (context) => {
  const { root, base, browser } = await placesDemo(context, { prepare: prepareTouched });
  const page = await open(browser, base, SLICE);
  await choosePlace(page, "Knowledge");
  await item(sidebar(page), "Changed this week").click();
  await settledOn(page, "knowledge:changed");
  const count = await until(() => touchedCount(page), 7);
  assert.ok(Number.isFinite(count) && count > 0, "the count of the slice opened before");
  await addChange(root);
  assert.equal(await until(() => touchedCount(page), count + 1), count + 1);
  assert.deepEqual(page.errors, []);
});
