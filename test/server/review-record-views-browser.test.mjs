import assert from "node:assert/strict";
import test from "node:test";
import { boundaryFailures, contrastFailures, demoProject, escapes, launch, openPage, paintedBackgrounds, reviewUrl, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §2, §3, §7, §8, §9.
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

test("text and controls of every record, document, and source view reach WCAG AA, and their surfaces follow the theme", { skip, timeout: 300000 }, async (context) => {
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
      for (const failure of await boundaryFailures(page, "#artifact")) failures.push(`${ref} ${theme}: control ${failure}`);
      painted[theme] = await paintedBackgrounds(page, "#artifact");
      // The diagram sheet keeps the paper color in both themes, so the paper's own value in this form is set aside.
      await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.id = "paper-probe";
        probe.style.setProperty("background-color", "var(--prism-color-diagram-paper)");
        probe.style.setProperty("width", "1px");
        probe.style.setProperty("height", "1px");
        document.querySelector("#artifact").append(probe);
      });
      const withProbe = await paintedBackgrounds(page, "#artifact");
      painted[`${theme}-paper`] = Object.entries(withProbe).find(([key]) => key.endsWith("div#paper-probe"))?.[1];
      await page.context().close();
    }
    for (const [element, color] of Object.entries(painted.light)) {
      if (painted.dark[element] === color && !(color === painted["light-paper"] && color === painted["dark-paper"])) failures.push(`${ref}: ${element} keeps ${color} in both themes`);
    }
  }
  assert.deepEqual(failures, []);
});

test("the evidence drawer opens from the keyboard and closes with Escape", { skip }, async (context) => {
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
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
});

test("record and document views with long names stay inside a phone window", { skip, timeout: 300000 }, async (context) => {
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
