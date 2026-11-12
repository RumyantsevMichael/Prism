import assert from "node:assert/strict";
import test from "node:test";
import { skip } from "./fixtures/kit-browser.mjs";
import { prepareTouched } from "./fixtures/places-touched.mjs";
import { choosePlace, editJson, item, open, placesDemo, settledOn, sidebar, SLICE } from "./fixtures/places-browser.mjs";

// How Touched by my work treats the server's answers while it polls: a slice the server says does not exist brings back the no-slice text,
// and a request that gets no answer keeps the page and its count as they were.

const RECORDS = "Records behind the slice you have open: Harden request retries, slice Retry timed-out requests until a total deadline";
const NO_SLICE = "This page lists the records behind the slice you have open. Open a slice to see them.";

async function touched(context) {
  const { root, browser, base } = await placesDemo(context, { prepare: prepareTouched });
  const page = await open(browser, base, SLICE);
  await choosePlace(page, "Knowledge");
  await item(sidebar(page), "Touched by my work").click();
  await settledOn(page, "knowledge:touched");
  const view = page.locator("#artifact");
  await view.getByText(RECORDS, { exact: true }).waitFor();
  return { root, page, view };
}

const countText = async (page) => (await item(sidebar(page), "Touched by my work").textContent()).replace(/\s+/g, " ").trim();

test("clause 59: a slice removed while Touched by my work is open brings back the no-slice text and drops its count", { skip, timeout: 90000 }, async (context) => {
  const { root, page, view } = await touched(context);
  assert.match(await countText(page), /\d/, "the sidebar counts the slice's records");
  await editJson(root, ".prism/initiatives/retry-hardening/initiative.json", (record) => {
    delete record.slices["timeout-retries"];
    return record;
  });
  await view.getByText(NO_SLICE, { exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await view.getByText(RECORDS, { exact: true }).count(), 0);
  assert.doesNotMatch(await countText(page), /\d/, "the sidebar no longer counts the removed slice's records");
  assert.deepEqual(page.errors, []);
});

test("a Touched by my work request that gets no answer keeps the page and its count as they were", { skip, timeout: 90000 }, async (context) => {
  const { page, view } = await touched(context);
  const before = await countText(page);
  let failed = 0;
  await page.route(/\/api\/touched\?/, (route) => {
    failed += 1;
    return failed % 2 ? route.fulfill({ status: 503, body: "busy" }) : route.abort("failed");
  });
  const deadline = Date.now() + 20000;
  while (failed < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(failed >= 3, "the page kept asking");
  assert.equal(await view.getByText(RECORDS, { exact: true }).isVisible(), true);
  assert.equal(await view.getByText(NO_SLICE, { exact: true }).count(), 0);
  assert.equal(await countText(page), before);
});
