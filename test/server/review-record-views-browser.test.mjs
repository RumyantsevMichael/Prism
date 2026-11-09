import assert from "node:assert/strict";
import test from "node:test";
import { boundaryFailures, contrastFailures, demoProject, escapes, launch, openPage, paintedBackgrounds, reviewUrl, serveProject, skip, stateFileNames, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §2, §3, §7, §8, §9.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 20, 21, 22, 38, 45, and 69.
// The record, document, and source views of the real review page run over the demo and edge-case projects in both themes.

const choose = (base, body) => fetch(`${base}/api/preferences`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function recordPages(base) {
  const index = await (await fetch(`${base}/api/index`)).json();
  const pick = (pattern) => index.artifacts.find((item) => pattern.test(item));
  return [
    pick(/change-map\.json$/),
    pick(/review\.json$/),
    pick(/state\.json$/),
    "docs/retry.md",
    "src/retry/strategy.ts",
    "config/retry.json",
    "docs/plans/retry-hardening/timeout-retries/timeout-retries.puml"
  ].filter(Boolean);
}

test("clauses 20, 21, 22: text and fields of every record, document, and source view reach WCAG AA, and their surfaces follow the theme", { skip, timeout: 300000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const pages = await recordPages(base);
  assert.ok(pages.length >= 6, "the demo has record pages");
  const failures = [];
  for (const ref of pages) {
    const painted = {};
    for (const theme of ["light", "dark"]) {
      await choose(base, { theme });
      const page = await openPage(browser, reviewUrl(base, ref));
      await waitForView(page);
      for (const failure of await contrastFailures(page, "#artifact")) failures.push(`${ref} ${theme}: text ${failure}`);
      for (const failure of await boundaryFailures(page, "#artifact")) failures.push(`${ref} ${theme}: field ${failure}`);
      painted[theme] = await paintedBackgrounds(page, "#artifact");
      await page.context().close();
    }
    for (const [element, color] of Object.entries(painted.light)) {
      if (painted.dark[element] === color) failures.push(`${ref}: ${element} keeps ${color} in both themes`);
    }
  }
  assert.deepEqual(failures, []);
});

test("clause 45: the evidence drawer opens from the keyboard as a dialog, closes with Escape, and returns focus", { skip }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const [changeMap] = await recordPages(base);
  const page = await openPage(browser, reviewUrl(base, changeMap));
  await waitForView(page);
  const chip = page.locator("#artifact [data-evidence]").first();
  assert.equal(await chip.count(), 1, "the change map links evidence");
  await chip.focus();
  await page.keyboard.press("Enter");
  const drawer = page.locator("#evidence-drawer");
  await drawer.waitFor({ state: "visible" });
  assert.deepEqual(await contrastFailures(page, "#evidence-drawer"), []);
  assert.equal(await page.getByRole("dialog").filter({ has: page.locator("#evidence-drawer") }).or(page.locator('#evidence-drawer[role="dialog"], #evidence-drawer [role="dialog"]')).count() >= 1, true, "the drawer is a kit dialog");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  assert.equal(await chip.evaluate((element) => element === document.activeElement || element.contains(document.activeElement) || element.shadowRoot?.activeElement != null), true, "focus returns to the evidence link");
});

test("clause 69: record, document, and source views name Prism's records by title and kind, and keep repository paths only where code is the subject", { skip, timeout: 300000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const failures = [];
  for (const ref of await recordPages(base)) {
    const page = await openPage(browser, reviewUrl(base, ref));
    await waitForView(page);
    for (const failure of await stateFileNames(page, "body")) failures.push(`${ref}: ${failure}`);
    await page.context().close();
  }
  assert.deepEqual(failures, []);
  const source = await openPage(browser, reviewUrl(base, "src/retry/strategy.ts"));
  await waitForView(source);
  assert.ok(await source.locator("#artifact [data-code-subject]").filter({ hasText: "src/retry/strategy.ts" }).count() >= 1, "a source file preview names its repository path where code is the subject");
});

test("clause 38: record and document views with long names stay inside a phone window", { skip, timeout: 300000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context, "seed-stress.mjs"));
  const browser = await launch(context);
  const index = await (await fetch(`${base}/api/index`)).json();
  const failures = [];
  for (const ref of index.artifacts.slice(0, 15)) {
    const page = await openPage(browser, reviewUrl(base, ref), { viewport: { width: 360, height: 740 } });
    await waitForView(page);
    for (const failure of await escapes(page, "#artifact")) failures.push(`${ref}: ${failure}`);
    await page.context().close();
  }
  assert.deepEqual(failures, []);
});
