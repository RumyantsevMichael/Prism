import assert from "node:assert/strict";
import test from "node:test";
import { shownTooltip, skip } from "./fixtures/kit-browser.mjs";
import { repainted, settled } from "./fixtures/wait.mjs";
import { choosePlace, eventually, groupHeadings, item, itemNames, open, placesDemo, settledOn, shownRef, sidebar } from "./fixtures/places-browser.mjs";

// Requirements: docs/requirements/review-app-places.md §41, §42, §43, §44, and §47.
// The demo's roadmap has Harden request retries in Now, Export activity reports in Next, which needs it, Index activity for search in Later,
// which needs Export activity reports, Retire the legacy exporter in Parked, one shipped and one superseded initiative, and two open questions.

const preferences = async (base) => (await fetch(`${base}/api/preferences`)).json();
const toolbar = (page) => page.locator("#artifact").getByRole("toolbar", { name: "Roadmap view" });
const card = (page, title) => page.locator("#artifact article.roadmap-item").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test("§41, §44, §47: the Roadmap opens with one toolbar for the view, the grouping, and shipped work, and its sidebar leads to the whole roadmap and its lanes", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Roadmap");
  const side = sidebar(page);
  assert.deepEqual(await itemNames(side), ["Whole roadmap 4", "Now 1", "Next 1", "Later 1", "Parked 1"], "Whole roadmap first, then each lane with its open initiatives, and no single initiative");
  assert.deepEqual(await groupHeadings(side), ["Lanes"]);
  assert.equal(await side.getByRole("radio").count(), 0, "the sidebar offers no view");
  await item(side, "Whole roadmap").click();
  await settledOn(page, "roadmap");
  assert.equal(await shownRef(page), "roadmap", "Whole roadmap opens the Roadmap page");
  const bar = toolbar(page);
  const view = bar.getByRole("radiogroup", { name: "View" });
  const group = bar.getByRole("radiogroup", { name: "Group by" });
  assert.deepEqual((await view.getByRole("radio").allInnerTexts()).map((text) => text.trim()), ["Board", "List", "Graph"]);
  assert.deepEqual((await group.getByRole("radio").allInnerTexts()).map((text) => text.trim()), ["Band", "Status"]);
  assert.equal(await view.getByRole("radio", { name: "Board" }).getAttribute("aria-checked"), "true");
  assert.equal(await group.getByRole("radio", { name: "Band" }).getAttribute("aria-checked"), "true");
  assert.equal(await bar.getByRole("button", { name: /^Show shipped and superseded/ }).count(), 1, "the toolbar holds the archive toggle");
  const lanes = () => page.locator("#artifact .roadmap-band-name").allInnerTexts();
  assert.deepEqual(await lanes(), ["Now", "Next", "Later", "Parked"]);
  await group.getByRole("radio", { name: "Status" }).click();
  assert.deepEqual(await eventually(lanes, ["In progress", "Planned", "Envisioned"]), ["In progress", "Planned", "Envisioned"], "grouped by status, the board shows the statuses in the order work moves");
  assert.equal(await card(page, "Export activity reports").locator("prism-chip").first().innerText(), "Next", "a card grouped by status names its band");
  assert.equal((await preferences(base))["roadmap.groupBy"], "status", "the grouping is kept as a preference");
  await toolbar(page).getByRole("button", { name: /^Show shipped and superseded/ }).click();
  assert.deepEqual(await eventually(lanes, ["In progress", "Planned", "Envisioned", "Shipped", "Superseded"]), ["In progress", "Planned", "Envisioned", "Shipped", "Superseded"], "shipped work joins as its own groups");
  await toolbar(page).getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "List" }).click();
  const list = page.locator("#artifact prism-lib-table.roadmap-list");
  await list.waitFor();
  assert.deepEqual(await list.locator(".prism-lib-group-name").evaluateAll((heads) => heads.map((head) => head.firstChild.textContent.trim())), ["In progress", "Planned", "Envisioned", "Shipped", "Superseded"], "the list groups the same way");
  assert.equal((await preferences(base))["roadmap.view"], "list");
  await toolbar(page).getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Graph" }).click();
  await page.locator("#artifact .graph-svg").waitFor();
  assert.equal(await toolbar(page).getByRole("radiogroup", { name: "Group by" }).count(), 0, "the graph offers no grouping");
  await page.reload();
  await settledOn(page, "roadmap");
  assert.equal(await toolbar(page).getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Graph" }).getAttribute("aria-checked"), "true", "a reload keeps the view");
  assert.deepEqual(page.errors, []);
});

test("§44: a lane link shows the board grouped by band with that lane in view", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  await fetch(`${base}/api/preferences`, { method: "PUT", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ "roadmap.view": "list", "roadmap.groupBy": "status" }) });
  const page = await open(browser, base, "attention", { height: 600 });
  await choosePlace(page, "Roadmap");
  await item(sidebar(page), "Parked").click();
  const inView = () => page.locator("#artifact").getByRole("heading", { name: "Parked", exact: true }).evaluate((heading) => {
    const box = heading.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight;
  }).catch(() => false);
  assert.equal(await eventually(inView, true), true, "the Parked lane's heading is in view");
  const bar = toolbar(page);
  assert.equal(await bar.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Board" }).getAttribute("aria-checked"), "true");
  assert.equal(await bar.getByRole("radiogroup", { name: "Group by" }).getByRole("radio", { name: "Band" }).getAttribute("aria-checked"), "true");
  assert.deepEqual(page.errors, []);
});

test("§42: the Roadmap's header counts the open roadmap questions as a link to Attention showing only them, and the page lists none", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "roadmap");
  const count = page.locator("#artifact").getByRole("button", { name: "2 open questions in Attention" });
  assert.equal(await count.isVisible(), true, "the header counts both questions");
  assert.equal(await count.evaluate((control) => (control.getRootNode().host ?? control).closest(".roadmap-meta") !== null), true, "the count sits beside the metrics, above the views");
  assert.equal(await page.locator("#artifact").getByText("Who owns the retry dashboard after launch?").count(), 0, "the page lists no question");
  await count.click();
  await settledOn(page, "attention:roadmap-questions");
  const rows = page.locator("#artifact prism-row");
  assert.equal(await eventually(() => rows.count(), 2), 2, "Attention shows only the roadmap's questions");
  assert.match(await rows.first().innerText(), /Should search indexing reuse the report export pipeline\?/);
  assert.match(await page.locator("body").innerText(), /Roadmap questions · 2 of \d+ items/);
  assert.deepEqual(page.errors, []);
});

test("§43: hovering or focusing a dependency icon marks the initiatives it names and dims the others, and its tooltip names them", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "roadmap");
  const reports = card(page, "Export activity reports");
  const needs = reports.getByRole("button", { name: "Needs Harden request retries" });
  const unblocks = reports.getByRole("button", { name: "Unblocks Index activity for search" });
  assert.equal(await needs.evaluate((control) => (control.getRootNode().host ?? control).textContent.trim()), "1", "the icon shows its count");
  const foot = await reports.locator(".roadmap-item-foot").boundingBox();
  const icon = await unblocks.boundingBox();
  assert.ok(Math.abs(foot.x + foot.width - (icon.x + icon.width)) <= 1, "the icons sit at the end of the card");
  const marks = () => page.locator("#artifact article.roadmap-item").evaluateAll((cards) => cards.map((element) => `${element.querySelector("h3").textContent.trim()}:${element.classList.contains("is-related") ? "marked" : element.classList.contains("is-source") ? "source" : Number(getComputedStyle(element).opacity) < 1 ? "dimmed" : "plain"}`));
  await needs.hover();
  assert.equal(await settled(() => shownTooltip(page), "Needs Harden request retries"), "Needs Harden request retries");
  const hovered = ["Harden request retries:marked", "Export activity reports:source", "Index activity for search:dimmed", "Retire the legacy exporter:dimmed"];
  assert.deepEqual(await settled(marks, hovered), hovered);
  await page.mouse.move(0, 0);
  const plain = ["Harden request retries:plain", "Export activity reports:plain", "Index activity for search:plain", "Retire the legacy exporter:plain"];
  assert.deepEqual(await settled(marks, plain), plain, "leaving the icon clears the marks");
  await unblocks.focus();
  const focused = ["Harden request retries:dimmed", "Export activity reports:source", "Index activity for search:marked", "Retire the legacy exporter:dimmed"];
  assert.deepEqual(await settled(marks, focused), focused, "focus marks them too");
  await page.keyboard.press("Enter");
  await page.locator("#artifact").getByRole("heading", { name: "Roadmap", exact: true }).first().click();
  await repainted(page);
  assert.equal((await marks())[2], "Index activity for search:marked", "a pressed icon keeps its marks");
  assert.deepEqual(page.errors, []);
});

test("the roadmap graph shows its whole zoom level and selects no text while it is dragged", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  await fetch(`${base}/api/preferences`, { method: "PUT", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ "roadmap.view": "graph" }) });
  const page = await open(browser, base, "roadmap");
  const viewport = page.locator("#artifact .graph-viewport");
  await viewport.locator(".graph-svg").waitFor();
  const level = page.locator("#artifact [data-zoom-label]");
  assert.equal(await level.evaluate((button) => button.scrollWidth <= button.clientWidth + 1 && button.getBoundingClientRect().width > 24), true, "the zoom level is not shortened");
  const box = await viewport.boundingBox();
  await page.mouse.move(box.x + 8, box.y + box.height - 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8, { steps: 6 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => String(getSelection())), "", "dragging the canvas selects no text");
  assert.deepEqual(page.errors, []);
});
