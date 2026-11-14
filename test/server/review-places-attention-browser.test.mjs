import assert from "node:assert/strict";
import test from "node:test";
import { skip } from "./fixtures/kit-browser.mjs";
import { prepareAttention } from "./fixtures/places-attention.mjs";
import { choosePlace, comparePlaces, groupHeadings, item, itemNames, open, placesDemo, settledOn, shownRef, sidebar } from "./fixtures/places-browser.mjs";

// The Attention place on the real review page over the demo, changed so every kind has items and five initiatives have items.

const crumbs = (page) => page.locator("#page-bar").getByRole("navigation").first().getByRole("link").allInnerTexts().then((texts) => texts.map((text) => text.trim()));

test("clauses 36, 38: the Attention sidebar lists Everything, each kind with its count, the three initiatives with most items and a row for the rest, and Answered", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare: prepareAttention });
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Attention");
  const scope = sidebar(page);
  assert.deepEqual(await groupHeadings(scope), ["By kind", "By work", "Answered"]);
  const names = await itemNames(scope);
  assert.deepEqual(names.slice(0, 7).map((name) => name.replace(/\s+/g, " ")), [
    "Everything 13", "Questions 2", "Review findings 1", "Failed verifications 1", "Blocked work 4", "Ready to ship 0", "Problems 5"
  ]);
  assert.deepEqual(names.slice(7, 11), ["Harden request retries 4", "Alpha search 2", "Beta billing 2", "2 more 3"]);
  assert.equal(names.at(-1), "Answered in the last 7 days 3");
  await item(scope, "2 more").click();
  await page.waitForTimeout(300);
  const expanded = await itemNames(scope);
  assert.ok(expanded.includes("Gamma gateway 2") && expanded.includes("Export activity reports 1"), "choosing the row shows the other initiatives");
  assert.ok(expanded.indexOf("Gamma gateway 2") < expanded.indexOf("Export activity reports 1"), "in the same order");
  assert.ok(expanded.indexOf("Gamma gateway 2") > expanded.indexOf("Beta billing 2"), "below the first three");
  assert.deepEqual(page.errors, []);
});

test("clauses 39, 41: a kind or an initiative opens its own address, shows only its items, names the filter with its count, and offers the way back", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare: prepareAttention });
  const page = await open(browser, base, "attention");
  const scope = sidebar(page);
  const href = await item(scope, "Failed verifications").locator(":scope > a").getAttribute("href");
  assert.equal(new URL(href, `${base}/`).searchParams.get("artifact"), "attention:failed");
  await item(scope, "Failed verifications").click();
  await settledOn(page, "attention:failed");
  const view = page.locator("#artifact");
  assert.equal(await view.getByText("Failed verifications · 1 of 13 items", { exact: true }).isVisible(), true, "the filter and its count show above the items");
  assert.equal(await view.getByText("Retry dropped connections failed verification", { exact: true }).isVisible(), true, "the failed run is listed by its slice");
  assert.equal(await view.getByText(/The tests failed, 2 tests failed/).isVisible(), true, "with its reason in words");
  assert.equal(await view.getByText("Choose a bucket size", { exact: false }).count(), 0);
  assert.equal(await view.getByText("Should a report download require a fresh login, or is an active session enough?").count(), 0, "a question is not a failed verification");
  assert.deepEqual(await crumbs(page), ["Attention", "Failed verifications"]);
  await view.getByRole("link", { name: "Retry dropped connections failed verification" }).click();
  await settledOn(page, "slice:retry-hardening/connection-retries");
  await page.goBack();
  await settledOn(page, "attention:failed");
  await item(scope, "Export activity reports").click().catch(async () => {
    await item(scope, "2 more").click();
    await item(scope, "Export activity reports").click();
  });
  await settledOn(page, "attention:work/activity-reports");
  assert.equal(await view.getByText("Export activity reports · 1 of 13 items", { exact: true }).isVisible(), true);
  assert.equal(await view.getByText("Should a report download require a fresh login, or is an active session enough?").isVisible(), true);
  await view.getByRole("link", { name: "Show everything", exact: true }).click();
  await settledOn(page, "attention");
  assert.equal(await shownRef(page), "attention");
  assert.deepEqual(page.errors, []);
});

test("clause 40: Answered in the last 7 days lists this week's answered and closed questions, newest first, with the answer or the reason", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare: prepareAttention });
  const page = await open(browser, base, "attention");
  await item(sidebar(page), "Answered in the last 7 days").click();
  await settledOn(page, "attention:answered");
  const text = await page.locator("#artifact").innerText();
  const order = ["Review the change map and the total-deadline ADR", "Keep the old socket wrapper?", "Review the first draft of the change map."].map((question) => text.indexOf(question));
  assert.ok(order.every((index) => index >= 0), "each of this week's questions is listed");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "newest first");
  assert.match(text, /Keep it until connection retries land\./, "an answer's note shows");
  assert.match(text, /The design changed, so the agent withdrew it\./, "a closing reason shows");
  assert.equal(text.includes("Review the retry ADR draft."), false, "a question closed 10 days ago is left out");
  assert.deepEqual(page.errors, []);
});

test("clause 40: with nothing answered this week the page says so", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention:answered");
  assert.equal(await page.locator("#artifact").getByText("No question was answered or closed in the last 7 days.", { exact: true }).isVisible(), true);
});

test("clauses 36, 39, 73: the Attention sidebar and its filtered page match the mockup at three widths, and in their colors in the dark theme", { skip, timeout: 900000 }, async (context) => {
  const result = await comparePlaces(context, { scenes: "attention,attention-filtered", parts: "sidebar,head,trail,geometry,tokens" });
  assert.equal(result.status, 0, `the comparison found differences:\n${result.stdout}${result.stderr}`);
  for (const pair of result.report.pairs) assert.deepEqual(pair.differences, [], `${pair.scene} ${pair.width} ${pair.theme}`);
});
