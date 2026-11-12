import assert from "node:assert/strict";
import test from "node:test";
import { shownTooltip, skip } from "./fixtures/kit-browser.mjs";
import { choosePlace, comparePlaces, editJson, groupHeadings, item, itemNames, open, placesDemo, sidebar, writeText } from "./fixtures/places-browser.mjs";

// Work lists only designed, unshipped work, grouped by state, on the demo project with a few records added before its server starts:
// Export activity reports gets a blocked slice and nothing in progress, an initiative with a record but no roadmap entry is added,
// and Harden request retries gets four more unfinished slices and two done ones, so its short list ends with a row for the rest.

const leaf = (title, status, parent = "retry-hardening") => ({ title, outcome: `${title}.`, status, parent, requirements: ["docs/requirements/retries.md#1"], dependencies: [] });

async function prepare(root) {
  await editJson(root, ".prism/initiatives/activity-reports/initiative.json", (record) => {
    record.slices.authorize.status = "blocked";
  });
  await editJson(root, ".prism/initiatives/retry-hardening/initiative.json", (record) => {
    Object.assign(record.slices, {
      "retry-budget": leaf("Cap retries per tenant", "not-started"),
      "retry-jitter": leaf("Add jitter to backoff", "not-started"),
      "retry-headers": leaf("Honor Retry-After headers", "not-started"),
      "retry-docs": leaf("Document retry settings", "not-started"),
      "retry-config": leaf("Read the retry settings", "done"),
      "retry-errors": leaf("Name retry errors", "done")
    });
  });
  await writeText(root, ".prism/initiatives/streaming-exports/initiative.json", `${JSON.stringify({ schemaVersion: 1, id: "streaming-exports", slices: {
    "streaming-exports": { title: "Spike streaming exports", outcome: "Exports stream.", status: "split", parent: null, requirements: [], dependencies: [], splitEvidence: { kind: "user_gate", gate: "g1" } },
    "stream-rows": { title: "Stream report rows", outcome: "Rows stream.", status: "not-started", parent: "streaming-exports", requirements: [], dependencies: [] },
    "stream-files": { title: "Stream report files", outcome: "Files stream.", status: "not-started", parent: "streaming-exports", requirements: [], dependencies: [] }
  }, history: [] }, null, 2)}\n`);
}

test("clauses 30, 31, 48: Work groups only designed, unshipped work under In progress, Blocked, Designed, not started, and Not on the roadmap, with counts and the note", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare });
  const index = await (await fetch(`${base}/api/index`)).json();
  assert.deepEqual(index.navigation.places.work.groups.map((group) => [group.key, group.label, group.initiatives.map((entry) => entry.id)]), [
    ["in-progress", "In progress", ["retry-hardening"]],
    ["blocked", "Blocked", ["activity-reports"]],
    ["unlisted", "Not on the roadmap", ["streaming-exports"]]
  ], "an empty group is left out, and shipped, superseded, and envisioned work is not listed");
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Work");
  const work = sidebar(page);
  assert.equal(await work.getByRole("searchbox", { name: "Filter work" }).or(work.getByRole("textbox", { name: "Filter work" })).count(), 1, "a filter field heads the place");
  assert.deepEqual(await groupHeadings(work), ["In progress", "Blocked", "Not on the roadmap"]);
  const counts = (await work.getByRole("heading", { level: 3 }).allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
  assert.deepEqual(counts, ["In progress 1", "Blocked 1", "Not on the roadmap 1"], "each group shows its count");
  const names = await itemNames(work);
  for (const absent of ["Audit administrative actions", "CSV-only exports", "Index activity for search", "Retire the legacy exporter"]) assert.equal(names.some((name) => name.startsWith(absent)), false, `${absent} is not in Work`);
  assert.equal(await work.getByText("Shipped work moves to History. Emerging and unplanned items stay on the Roadmap.", { exact: true }).isVisible(), true);
  assert.deepEqual(page.errors, []);
});

test("clauses 32, 34: rows show state, title, shipped out of all, phase, Blocked, and holder, with the full facts on hover", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare });
  const page = await open(browser, base, "slice:retry-hardening/timeout-retries");
  await choosePlace(page, "Work");
  const work = sidebar(page);
  const initiative = item(work, "Harden request retries");
  assert.equal(await initiative.getAttribute("aria-expanded"), "true", "the initiative of the open slice is expanded");
  assert.match((await itemNames(work)).find((name) => name.startsWith("Harden request retries")), /2\/10/, "the row shows shipped leaf slices out of all");
  await initiative.locator(":scope > a").hover();
  await page.waitForTimeout(700);
  assert.match(await shownTooltip(page) ?? "", /^Harden request retries · In progress · 2 of 10 shipped/);
  const blocked = item(work, "Retry dropped connections");
  assert.match((await itemNames(work)).find((name) => name.startsWith("Retry dropped connections")), /Blocked/, "a blocked slice says so");
  await blocked.locator(":scope > a").hover();
  await page.waitForTimeout(700);
  assert.match(await shownTooltip(page) ?? "", /Retry dropped connections · .*Blocked/);
  const claimed = item(work, "Emit retry metrics");
  assert.equal(await claimed.locator("prism-avatar, prism-claim").count() >= 1, true, "a claimed slice shows its holder");
  await claimed.locator(":scope > a").hover();
  await page.waitForTimeout(700);
  assert.match(await shownTooltip(page) ?? "", /Emit retry metrics · .* holds it for /, "the tooltip names the claim");
  assert.equal(await claimed.locator("prism-phase").count(), 1, "a slice row shows its phase");
  await initiative.locator(":scope > a .prism-tree-twisty").click();
  await page.waitForTimeout(300);
  assert.equal(await initiative.getAttribute("aria-expanded"), "false", "the person can collapse it");
  assert.equal(await item(work, "Export activity reports").getAttribute("aria-expanded"), "false", "an initiative with nothing open or active stays collapsed");
  assert.deepEqual(page.errors, []);
});

test("clause 33: an expanded initiative shows the open slice first, then active, blocked, and the rest, at most five, then a row for the rest", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare });
  const page = await open(browser, base, "slice:retry-hardening/retry-dashboard");
  await choosePlace(page, "Work");
  const work = sidebar(page);
  const below = await item(work, "Harden request retries").getByRole("treeitem").evaluateAll((items) => items.map((node) => {
    const ids = (node.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    return (ids.length ? ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : node.textContent).replace(/\s+/g, " ").trim();
  }));
  assert.equal(below.length, 6, "five slices and one row for the rest");
  assert.deepEqual(below.slice(0, 5).map((name) => name.split(" ").slice(0, 3).join(" ")), [
    "Chart retries on",
    "Emit retry metrics",
    "Retry timed-out requests",
    "Retry dropped connections",
    "Cap retries per"
  ], "open slice, then in progress or claimed, then blocked, then the rest in tree order");
  assert.match(below[5], /^3 more unfinished\b.*2 done/, "the last row counts the other unfinished and the done slices");
  const more = item(work, "3 more unfinished");
  assert.equal(new URL(await more.locator(":scope > a").getAttribute("href"), `${base}/`).searchParams.get("artifact"), "initiative:retry-hardening", "it opens the initiative's slice list");
  assert.deepEqual(page.errors, []);
});

test("clause 35: the filter keeps the initiatives and slices whose title holds the text, ignoring case, and says when nothing matches", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare });
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Work");
  const work = sidebar(page);
  const field = work.getByRole("searchbox", { name: "Filter work" }).or(work.getByRole("textbox", { name: "Filter work" }));
  await field.fill("DASHBOARD");
  await page.waitForTimeout(400);
  const names = await itemNames(work);
  assert.equal(names.length, 2, `only the initiative and its matching slice remain: ${names.join(" | ")}`);
  assert.match(names[0], /^Harden request retries/);
  assert.match(names[1], /^Chart retries on the service dashboard/);
  assert.deepEqual((await work.getByRole("heading", { level: 3 }).allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()), ["In progress 1"]);
  await field.fill("authorize");
  await page.waitForTimeout(400);
  assert.match((await itemNames(work)).join(" | "), /^Export activity reports.*\| Authorize report access/);
  await field.fill("report");
  await page.waitForTimeout(400);
  assert.ok((await itemNames(work)).some((name) => name.startsWith("Export activity reports")), "an initiative whose title matches stays");
  await field.fill("zzz");
  await page.waitForTimeout(400);
  assert.equal(await work.getByText('No work matches "zzz".', { exact: true }).isVisible(), true);
  await field.fill("");
  await page.waitForTimeout(400);
  assert.deepEqual(await groupHeadings(work), ["In progress", "Blocked", "Not on the roadmap"], "clearing restores the groups");
  assert.deepEqual(page.errors, []);
});

test("clauses 30, 32, 33, 73: the Work sidebar matches the mockup at three widths in both themes", { skip, timeout: 900000 }, async (context) => {
  const result = await comparePlaces(context, { scenes: "work,collapsed,drawer-tablet,drawer-phone", parts: "sidebar,head,geometry,tokens" });
  assert.equal(result.status, 0, `the comparison found differences:\n${result.stdout}${result.stderr}`);
  for (const pair of result.report.pairs) assert.deepEqual(pair.differences, [], `${pair.scene} ${pair.width} ${pair.theme}`);
});
