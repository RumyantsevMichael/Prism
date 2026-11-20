import assert from "node:assert/strict";
import test from "node:test";
import { skip } from "./fixtures/kit-browser.mjs";
import { eventually, open, placesDemo, settledOn } from "./fixtures/places-browser.mjs";

// Requirements: docs/requirements/review-app-places.md §46, as the approved mockup shows Requirements, Decisions, and Diagrams as one library table each,
// with a filter and a Group by choice above it that the person's preferences keep.
// The demo holds five requirements files, three Approved, one Draft, and one old note without a status that breaks its format, three decisions in two areas, and one diagram of a slice.

const table = (page) => page.locator("#artifact prism-lib-table.library-table");
// A group's name with its count; a status group is named by its status.
const groups = (page) => table(page).locator(".prism-lib-group-name").evaluateAll((heads) => heads.map((head) => `${head.querySelector("prism-status")?.getAttribute("value") ?? head.firstChild.textContent.trim()} ${head.querySelector("prism-badge").textContent.trim()}`));
const titles = (page) => table(page).locator("[data-library-row] .prism-lib-title-text > a").allInnerTexts();
const rowOf = (page, title) => table(page).locator("[data-library-row]").filter({ has: page.getByRole("link", { name: title, exact: true }) });
const columns = (page) => table(page).locator(".prism-lib-row.is-head > span").evaluateAll((cells) => cells.map((cell) => cell.textContent));
const groupBy = (page, name) => page.locator("#artifact").getByRole("radiogroup", { name: "Group by" }).getByRole("radio", { name, exact: true });
const preferences = async (base) => (await fetch(`${base}/api/preferences`)).json();

test("Requirements groups its files by status, says what each holds, and shows each slice that builds it with the requirements it builds", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "requirements");
  await table(page).waitFor({ timeout: 10000 });
  assert.equal(await page.locator("#artifact .artifact-header prism-page-sub").innerText(), "5 requirements files: what the product must do, and which slices build each requirement. · 1 of 5 breaks its format");
  assert.deepEqual(await columns(page), ["Requirements file", "Status", "Date", "Assigned to"]);
  assert.deepEqual(await groups(page), ["Approved 3", "Draft 1", "No status 1"], "Approved files come before drafts, and a file without a status comes last");
  const reports = rowOf(page, "Activity reports");
  assert.equal(await reports.locator(".prism-lib-cell.is-detail").innerText(), "2 requirements");
  assert.deepEqual((await reports.locator("prism-chip").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()), ["Authorize report access req 2", "Download signed reports req 1"]);
  assert.equal(await rowOf(page, "Search indexing").getByText("Not assigned yet").count(), 1);
  await reports.locator("prism-chip", { hasText: "Download signed reports" }).click();
  await settledOn(page, "slice:activity-reports/download");
  assert.deepEqual(page.errors, []);
});

test("Group by and the filter change only the table, the grouping stays a preference, and Escape clears the filter", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "requirements");
  await table(page).waitFor({ timeout: 10000 });
  await groupBy(page, "Initiative").click();
  assert.deepEqual(await eventually(async () => (await groups(page)).map((name) => name.replace(/\s*\d+$/, "")), ["Audit administrative actions", "Export activity reports", "Harden request retries", "Not assigned yet"]), ["Audit administrative actions", "Export activity reports", "Harden request retries", "Not assigned yet"]);
  assert.equal(await eventually(async () => (await preferences(base))["library.requirements.groupBy"], "initiative"), "initiative", "the grouping is kept as a preference");
  const filter = page.locator("#artifact [data-library-filter] input");
  await filter.fill("audit");
  assert.deepEqual(await eventually(() => titles(page), ["Audit log"]), ["Audit log"]);
  assert.equal(await page.evaluate(() => document.activeElement?.closest("[data-library-filter]") !== null), true, "the field keeps its focus while the rows change");
  await filter.press("Escape");
  assert.equal((await eventually(() => titles(page).then((names) => names.length), 5)), 5);
  await filter.fill("no such record");
  assert.equal(await table(page).locator(".prism-lib-nothing").innerText(), "No record matches the filter.");
  await groupBy(page, "None").click();
  assert.equal(await eventually(() => table(page).locator(".prism-lib-group").count(), 0), 0);
  assert.deepEqual(page.errors, []);
});

test("Decisions groups by area, says what superseded what, and names the requirements and initiatives each one applies to", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "decisions");
  await table(page).waitFor({ timeout: 10000 });
  assert.deepEqual(await groups(page), ["reporting 2", "retries 1"]);
  assert.equal(await rowOf(page, "Export reports as CSV only").locator(".is-detail").innerText(), "Superseded by Sign exported reports");
  const signed = rowOf(page, "Sign exported reports");
  assert.equal(await signed.locator(".is-detail").innerText(), "Supersedes Export reports as CSV only");
  assert.deepEqual((await signed.locator("prism-chip").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()), ["Activity reports req 1, 2", "Export activity reports initiative"]);
  await groupBy(page, "Status").click();
  assert.deepEqual(await eventually(() => groups(page), ["Accepted 1", "Proposed 1", "Superseded 1"]), ["Accepted 1", "Proposed 1", "Superseded 1"], "one group for each status, in the order a decision moves through them");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `the page does not scroll sideways at ${width} pixels`);
  }
  assert.deepEqual(page.errors, []);
});

test("Diagrams says what each diagram draws and links what it belongs to, and groups by kind", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "knowledge:diagrams");
  await table(page).waitFor({ timeout: 10000 });
  assert.deepEqual(await columns(page), ["Diagram", "Kind", "Belongs to"]);
  const row = table(page).locator("[data-library-row]").first();
  assert.equal(await row.locator(":scope > .prism-lib-cell").first().innerText(), "Class");
  await groupBy(page, "Kind").click();
  assert.deepEqual(await eventually(() => groups(page), ["Class 1"]), ["Class 1"]);
  await row.locator("prism-chip").click();
  await settledOn(page, "slice:retry-hardening/timeout-retries");
  assert.deepEqual(page.errors, []);
});
