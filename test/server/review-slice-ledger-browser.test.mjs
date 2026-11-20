import assert from "node:assert/strict";
import test from "node:test";
import { skip } from "./fixtures/kit-browser.mjs";
import { eventually, open, placesDemo, SLICE } from "./fixtures/places-browser.mjs";

// Requirements: docs/requirements/review-app-places.md §46, docs/requirements/review-loop-decisions.md §3, and docs/requirements/review-finding-provenance.md §2.
// The demo's Retry on timeout has one design audit wave with two reviewers, main and security, and four findings: F2 blocker open, F1 high in progress, S1 medium reopened, and F3 low verified.

const reviewTab = async (page) => {
  const tabs = page.locator("#artifact").getByRole("tablist", { name: "Slice" });
  await tabs.getByRole("tab", { name: /^Review\b/ }).click();
  const pane = page.locator('#artifact [data-tab-panel="review"]');
  await pane.locator("[data-ledger-summary]").waitFor({ timeout: 10000 });
  return pane;
};
const rows = (pane) => pane.locator("[data-finding]").evaluateAll((items) => items.map((item) => item.querySelector(".ledger-finding-id").textContent));

test("the slice's Review tab holds the ledger: one summary line, the findings by status beside the chosen one, and the folds below", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, SLICE);
  const tabs = page.locator("#artifact").getByRole("tablist", { name: "Slice" });
  const changeMap = tabs.getByRole("tab", { name: /^Change map/ });
  assert.match(await changeMap.innerText(), /Deprecated/, "the change map's tab says it is deprecated");
  assert.match(await changeMap.getAttribute("tip"), /Replaced by the Files tab/, "and says what replaces it");
  const pane = await reviewTab(page);
  const summary = await pane.locator("[data-ledger-summary]").innerText();
  assert.match(summary, /Wave 1 open\s+design-audit/, "the summary leads with the current wave and its state");
  assert.equal(await pane.locator('[data-count="unresolved"]').innerText(), "3 unresolved findings");
  assert.equal(await pane.locator('[data-count="blocking"]').innerText(), "2 block shipping until verified", "the blocker and the high finding block shipping");
  assert.deepEqual(await pane.locator(".ledger-reviewers prism-chip").allInnerTexts().then((texts) => texts.map((text) => text.split(/\s+/)[0])), ["main", "security"], "each reviewer is a chip");
  assert.deepEqual(await pane.locator(".ledger-group-head").allInnerTexts().then((texts) => texts.map((text) => text.replace(/\s+/g, " ").trim())), ["Open 1", "In progress 1", "Reopened 1", "Verified 1"], "the groups follow the order work moves, and only a status with findings is one");
  assert.match(await pane.locator(".ledger-empty-groups").innerText(), /^No fixed or deferred findings\.$/);
  assert.deepEqual(await rows(pane), ["F2", "F1", "S1", "F3"], "the most severe finding comes first");
  const detail = pane.locator("[data-detail]");
  assert.equal(await detail.getByRole("heading", { level: 3 }).innerText(), "Deleting LegacyRetryHandler drops connection retries", "the ledger opens on the most severe open finding");
  await pane.getByRole("option", { name: /F1/ }).click();
  assert.equal(await eventually(() => detail.getByRole("heading", { level: 3 }).innerText(), "The delta does not say when the deadline is checked"), "The delta does not say when the deadline is checked");
  assert.match(await detail.innerText(), /Evidence[\s\S]*slow first attempt[\s\S]*Closes when[\s\S]*no attempt starts after the deadline/);
  assert.deepEqual(await pane.locator(".ledger-more > prism-disclosure").evaluateAll((folds) => folds.map((fold) => fold.getAttribute("summary"))).then((names) => names.map((name) => name.replace(/ · .*/, ""))), ["Waves", "Assessments", "Operation history", "Record details"]);
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `the page does not scroll sideways at ${width} pixels`);
  }
  const stacked = await pane.evaluate((element) => {
    const list = element.querySelector(".ledger-findings").getBoundingClientRect();
    const chosen = element.querySelector(".ledger-detail").getBoundingClientRect();
    return chosen.top >= list.bottom - 1;
  });
  assert.equal(stacked, true, "at 390 pixels the chosen finding follows the list");
  assert.deepEqual(page.errors, []);
});

test("the ledger filters by reviewer and severity, and a hidden finding gives way to the first one shown", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, SLICE);
  const pane = await reviewTab(page);
  await pane.getByRole("radiogroup", { name: "Reviewer" }).getByRole("radio", { name: "security", exact: true }).click();
  assert.deepEqual(await eventually(() => rows(pane), ["S1"]), ["S1"], "the security reviewer raised one finding");
  assert.equal(await pane.locator(".ledger-shown").innerText(), "1 of 4 findings");
  assert.equal(await pane.locator("[data-detail]").getByRole("heading", { level: 3 }).innerText(), "Unbounded deadline from configuration", "a hidden finding gives way to the first one shown");
  await pane.getByRole("radiogroup", { name: "Reviewer" }).getByRole("radio", { name: "All", exact: true }).click();
  await pane.locator('[data-ledger-severity="low"]').click();
  assert.deepEqual(await eventually(() => rows(pane), ["F2", "F1", "S1"]), ["F2", "F1", "S1"], "turning Low off hides the low finding");
  assert.equal(await pane.locator('[data-ledger-severity="low"]').getAttribute("pressed"), "false");
  await pane.locator("prism-disclosure[data-fold=wavesOpen]").getByRole("button").first().click();
  await pane.locator('[data-ledger-severity="medium"]').click();
  assert.deepEqual(await eventually(() => rows(pane), ["F2", "F1"]), ["F2", "F1"], "the severity filters add up");
  assert.equal(await pane.locator("prism-disclosure[data-fold=wavesOpen]").getAttribute("open"), "", "an opened fold stays open when a filter draws the ledger again");
  assert.deepEqual(page.errors, []);
});
