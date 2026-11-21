import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { contrastFailures, demoProject, escapes, launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// The Views tab of a slice also lists each PlantUML file of the slice's folder that no Views line names, such as the diagrams of a design
// written before designs declared views, named by its own title and marked as stating no question, so that older designs stay readable.

const LONG = "workspace-sync: units and dependencies of the managed store clone, its fetch, merge, and push loop, and every event stream that follows it";
const OBSERVABILITY = "slice:retry-hardening/retry-observability";
const TIMEOUTS = "slice:retry-hardening/timeout-retries";

/** The demo project with a titled diagram in a design that has no Views section, and an untitled one beside a declared view. */
async function olderDesigns(context) {
  await useAppDirectory(context);
  const root = await demoProject(context);
  const plans = path.join(root, "docs", "plans", "retry-hardening");
  await writeFile(path.join(plans, "retry-observability", "overview.puml"), `@startuml\ntitle ${LONG}\ncomponent "metrics.ts\\nrecordRetry" as metrics\ncomponent "strategy.ts\\nRequestRetryStrategy" as strategy\nstrategy --> metrics\n@enduml\n`);
  await writeFile(path.join(plans, "timeout-retries", "notes.puml"), "@startuml\nAlice -> Bob: retry\n@enduml\n");
  // A diagram in a folder below the slice belongs to that folder, so the slice does not list it.
  await mkdir(path.join(plans, "timeout-retries", "probes"), { recursive: true });
  await writeFile(path.join(plans, "timeout-retries", "probes", "probe.puml"), "@startuml\nA -> B\n@enduml\n");
  const { base } = await serveProject(context, root);
  return { base, browser: await launch(context) };
}

async function viewsTab(browser, base, ref, options) {
  const page = await openPage(browser, reviewUrl(base, ref), options);
  await waitForView(page);
  await page.locator("#artifact").getByRole("tablist", { name: "Slice" }).getByRole("tab", { name: /^Views/ }).click();
  await page.locator("#artifact [data-views]").waitFor();
  return page;
}

const cards = (page) => page.locator("#artifact [data-views] .view-region").evaluateAll((regions) => regions.map((region) => ({
  heading: region.getAttribute("heading"),
  eyebrow: region.getAttribute("eyebrow"),
  unasked: region.hasAttribute("data-view-unasked"),
  note: region.querySelector(".view-note")?.textContent ?? ""
})));

test("a design without a Views section shows its folder's diagram, named by its title and marked as stating no question", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await olderDesigns(context);
  const page = await viewsTab(browser, base, OBSERVABILITY, { viewport: { width: 1440, height: 900 } });
  const tab = page.locator("#artifact").getByRole("tablist", { name: "Slice" }).getByRole("tab", { name: /^Views/ });
  assert.match((await tab.innerText()).trim(), /^Views\s+1$/, "the tab counts the diagram");
  const shown = await cards(page);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].heading, LONG);
  assert.equal(shown[0].eyebrow, "Diagram · overview.puml");
  assert.equal(shown[0].unasked, true);
  assert.match(shown[0].note, /states no question for it/);
  const card = page.getByRole("region", { name: LONG });
  await card.locator(".diagram-output svg").first().waitFor();
  assert.equal(await card.locator(".clause-link").count(), 0, "the diagram cites no clause");
  assert.deepEqual(await contrastFailures(page, "#artifact [data-views]"), []);
});

test("a diagram that the Views section does not name follows the declared views, and one in a folder below the slice is left out", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await olderDesigns(context);
  const page = await viewsTab(browser, base, TIMEOUTS);
  const shown = await cards(page);
  assert.deepEqual(shown.map((card) => [card.eyebrow, card.heading, card.unasked]), [
    ["Code view · timeout-retries.puml", "Which class owns timeout retries?", false],
    ["Diagram · notes.puml", "notes.puml", true]
  ]);
  assert.match(shown[0].note, /This view explains §1 and §2/, "the declared view keeps its note");
});

test("a diagram with a long title stays inside a phone window in both themes", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await olderDesigns(context);
  for (const colorScheme of ["light", "dark"]) {
    const page = await viewsTab(browser, base, OBSERVABILITY, { viewport: { width: 360, height: 740 }, colorScheme });
    await page.getByRole("region", { name: LONG }).locator(".diagram-output svg").first().waitFor();
    assert.deepEqual(await escapes(page, "#artifact"), [], colorScheme);
    await page.context().close();
  }
});
