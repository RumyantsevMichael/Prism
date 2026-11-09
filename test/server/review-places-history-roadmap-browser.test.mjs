import assert from "node:assert/strict";
import test from "node:test";
import { shownTooltip, skip } from "./fixtures/kit-browser.mjs";
import { choosePlace, comparePlaces, editJson, groupHeadings, item, itemNames, open, placesDemo, settledOn, sidebar } from "./fixtures/places-browser.mjs";

// History and the Roadmap place over the demo, whose decisions get fixed dates before the server starts:
// Export activity reports supersedes CSV-only exports a day ago, Audit administrative actions shipped five days ago,
// and Index activity for search was superseded on 14 June 2025.

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shown = (date) => {
  const day = new Date(date);
  return `${day.getDate()} ${MONTHS[day.getMonth()]}${day.getFullYear() === new Date().getFullYear() ? "" : ` ${day.getFullYear()}`}`;
};
const oneDay = new Date(Date.now() - DAY).toISOString();
const fiveDays = new Date(Date.now() - 5 * DAY).toISOString();
const old = "2025-06-14T12:00:00.000Z";

async function prepare(root) {
  await editJson(root, ".prism/roadmap.json", (roadmap) => {
    for (const entry of roadmap.initiatives) {
      if (entry.id === "csv-exports") entry.decision.at = oneDay;
      if (entry.id === "audit-log") entry.decision.at = fiveDays;
      if (entry.id === "search-indexing") entry.decision = { kind: "superseded", by: "activity-reports", reason: "Reports cover search.", at: old, actor: "orchestrator" };
    }
  });
}

test("clauses 47, 48: History lists shipped and superseded work newest first, with dates, the superseded mark, and links to each initiative", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare });
  const history = (await (await fetch(`${base}/api/index`)).json()).navigation.places.history;
  assert.deepEqual(history.map((entry) => [entry.id, entry.decision, entry.by]), [["csv-exports", "superseded", "activity-reports"], ["audit-log", "shipped", null], ["search-indexing", "superseded", "activity-reports"]]);
  assert.equal(history[2].at, old);
  const page = await open(browser, base, "attention");
  await choosePlace(page, "History");
  const names = await itemNames(sidebar(page));
  assert.deepEqual(names, [
    `CSV-only exports Superseded ${shown(oneDay)}`,
    `Audit administrative actions ${shown(fiveDays)}`,
    `Index activity for search Superseded ${shown(old)}`
  ]);
  assert.match(names[2], /14 Jun 2025$/, "an earlier year carries the year");
  await item(sidebar(page), "CSV-only exports").locator(":scope > a").hover();
  await page.waitForTimeout(700);
  assert.equal(await shownTooltip(page), `CSV-only exports · Superseded ${shown(oneDay)}`);
  await item(sidebar(page), "Audit administrative actions").click();
  await settledOn(page, "initiative:audit-log");
  assert.deepEqual(page.errors, []);
});

test("clause 47: History says so when nothing has shipped", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare: (root) => editJson(root, ".prism/roadmap.json", (roadmap) => {
    for (const entry of roadmap.initiatives) entry.decision = null;
  }) });
  const page = await open(browser, base, "attention");
  await choosePlace(page, "History");
  assert.equal(await sidebar(page).getByText("Nothing has shipped yet.", { exact: true }).isVisible(), true);
});

test("clauses 44, 46: the Roadmap place switches the page's board, list, and graph and follows the page's own control", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare });
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Roadmap");
  await settledOn(page, "roadmap");
  const side = sidebar(page);
  assert.deepEqual(await groupHeadings(side), ["View", "Lanes"]);
  const choice = (name) => side.getByRole("radio", { name, exact: true });
  const pageMode = (name) => page.getByRole("group", { name: "Roadmap view" }).getByRole("button", { name, exact: true });
  assert.equal(await choice("Board").isChecked(), true, "the sidebar marks the board the page shows");
  await choice("List").click();
  await page.waitForTimeout(500);
  assert.equal(await pageMode("List").getAttribute("aria-pressed") ?? await pageMode("List").evaluate((host) => host.getAttribute("pressed")), "true", "the page shows its list");
  await pageMode("Graph").click();
  await page.waitForTimeout(800);
  assert.equal(await choice("Graph").isChecked(), true, "the sidebar follows the page's own control");
  const lanes = await itemNames(side);
  assert.deepEqual(lanes, ["Now 1", "Next 1", "Later 0", "Parked 1"], "each lane with its open initiatives, and no single initiative");
  assert.deepEqual(page.errors, []);
});

test("clause 45: a lane link opens the board with that lane in view, and again while the page is open", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare });
  const page = await open(browser, base, "attention", { width: 390, height: 640 });
  await page.locator("header").getByRole("button", { name: "Navigation" }).click();
  const panel = page.getByRole("dialog", { name: "Navigation" });
  await choosePlace(panel, "Roadmap");
  await settledOn(page, "roadmap");
  await page.locator("header").getByRole("button", { name: "Navigation" }).click();
  const parked = item(page.getByRole("dialog", { name: "Navigation" }), "Parked");
  const address = new URL(await parked.locator(":scope > a").getAttribute("href"), `${base}/`);
  assert.equal(address.searchParams.get("artifact"), "roadmap");
  assert.equal(address.searchParams.get("lane"), "parked");
  await parked.click();
  await page.waitForTimeout(800);
  const inView = () => page.locator("#artifact").getByRole("heading", { name: "Parked", exact: true }).evaluate((heading) => {
    const box = heading.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight;
  });
  assert.equal(await inView(), true, "the Parked lane's heading is in view");
  await page.locator("#artifact").getByRole("heading", { name: "Now", exact: true }).scrollIntoViewIfNeeded();
  await page.locator("header").getByRole("button", { name: "Navigation" }).click();
  await item(page.getByRole("dialog", { name: "Navigation" }), "Parked").click();
  await page.waitForTimeout(800);
  assert.equal(await inView(), true, "following it again scrolls again");
  assert.deepEqual(page.errors, []);
});

test("clauses 44, 47, 73: the History and Roadmap sidebars match the mockup at three widths in both themes", { skip, timeout: 900000 }, async (context) => {
  const result = await comparePlaces(context, { scenes: "history,roadmap", parts: "sidebar,head,trail,geometry,tokens" });
  assert.equal(result.status, 0, `the comparison found differences:\n${result.stdout}${result.stderr}`);
  for (const pair of result.report.pairs) assert.deepEqual(pair.differences, [], `${pair.scene} ${pair.width} ${pair.theme}`);
});
