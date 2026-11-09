import assert from "node:assert/strict";
import test from "node:test";
import { skip } from "./fixtures/kit-browser.mjs";
import { choosePlace, comparePlaces, groupHeadings, item, itemNames, open, placesDemo, settledOn, sidebar } from "./fixtures/places-browser.mjs";

// The Knowledge place over the demo, which holds four requirements files, three decisions, three glossary terms, and one diagram, eleven records in all.

const field = (scope) => scope.getByRole("searchbox", { name: "Search 11 records", exact: true }).or(scope.getByRole("textbox", { name: "Search 11 records", exact: true }));

test("clauses 49, 50: the Knowledge sidebar holds a records search, Start from, and Browse by kind with counts, and each entry opens its page", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Knowledge");
  const side = sidebar(page);
  assert.equal(await field(side).count(), 1, "the search field names the number of records");
  assert.deepEqual(await groupHeadings(side), ["Start from", "Browse by kind"]);
  const names = await itemNames(side);
  assert.equal(names.length, 6, "two entry points and four kinds, and no single record");
  assert.match(names[0], /^Touched by my work\b/);
  assert.match(names[1], /^Changed this week\b/);
  assert.deepEqual(names.slice(2), ["Requirements 4", "Decisions 3", "Glossary 3", "Diagrams 1"]);
  for (const [name, ref] of [["Requirements", "requirements"], ["Decisions", "decisions"], ["Glossary", "glossary"], ["Diagrams", "knowledge:diagrams"], ["Touched by my work", "knowledge:touched"], ["Changed this week", "knowledge:changed"]]) {
    await item(side, name).click();
    await settledOn(page, ref);
  }
  assert.deepEqual(page.errors, []);
});

test("clause 51: the Diagrams page lists each diagram by its name with its owner and opens it", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "knowledge:diagrams");
  const view = page.locator("#artifact");
  const link = view.getByRole("link", { name: "timeout-retries", exact: true });
  assert.equal(await link.isVisible(), true, "a diagram without a name after @startuml is named by its file");
  assert.equal(await view.getByText("Harden request retries · Retry timed-out requests until a total deadline", { exact: true }).isVisible(), true, "with its owner");
  await link.click();
  await settledOn(page, "docs/plans/retry-hardening/timeout-retries/timeout-retries.puml");
  assert.deepEqual(page.errors, []);
});

test("clause 52: typing in the search shows matching records grouped by kind, a choice opens its page, and Escape restores the groups", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Knowledge");
  const side = sidebar(page);
  await field(side).fill("d");
  await page.waitForTimeout(400);
  assert.deepEqual(await groupHeadings(side), ["Start from", "Browse by kind"], "one character changes nothing");
  await field(side).fill("Deadline");
  await page.waitForTimeout(600);
  assert.deepEqual(await groupHeadings(side), ["Requirements", "Decisions", "Glossary"], "the empty Diagrams group is left out");
  assert.deepEqual(await itemNames(side), ["Retry requirements", "Bound retries by a total deadline", "Retry deadline"]);
  await field(side).fill("total attempts");
  await page.waitForTimeout(600);
  assert.deepEqual(await itemNames(side), ["Retry requirements", "Retry deadline"], "every word must occur in the title or the text");
  await item(side, "Retry deadline").click();
  await settledOn(page, "glossary");
  await field(side).fill("deadline");
  await page.waitForTimeout(600);
  await item(side, "Bound retries by a total deadline").click();
  await settledOn(page, "docs/ADRs/retries/total-retry-deadline.md");
  await field(side).fill("no such words");
  await page.waitForTimeout(600);
  assert.equal(await side.getByText('No record matches "no such words".', { exact: true }).isVisible(), true);
  await field(side).press("Escape");
  await page.waitForTimeout(400);
  assert.deepEqual(await groupHeadings(side), ["Start from", "Browse by kind"], "Escape restores the groups");
  await field(side).fill("deadline");
  await page.waitForTimeout(600);
  await field(side).fill("");
  await page.waitForTimeout(400);
  assert.deepEqual(await groupHeadings(side), ["Start from", "Browse by kind"], "clearing the field restores the groups");
  assert.deepEqual(page.errors, []);
});

test("clauses 49, 73: the Knowledge sidebar matches the mockup at three widths in both themes", { skip, timeout: 900000 }, async (context) => {
  const result = await comparePlaces(context, { scenes: "knowledge", parts: "sidebar,head,geometry,tokens" });
  assert.equal(result.status, 0, `the comparison found differences:\n${result.stdout}${result.stderr}`);
  for (const pair of result.report.pairs) assert.deepEqual(pair.differences, [], `${pair.scene} ${pair.width} ${pair.theme}`);
});
