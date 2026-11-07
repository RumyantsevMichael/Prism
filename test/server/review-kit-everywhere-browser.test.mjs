import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { contrastFailures, demoProject, launch, movingElements, openPage, reviewUrl, ROOT, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §5, §8, §11, §13.
// Feature: docs/Features/F-review-app-ui-kit.feature.
// The whole review page, on the kit, passes the layout check and follows density and reduced motion.

const run = promisify(execFile);
const choose = (base, body) => fetch(`${base}/api/preferences`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("the layout check passes every page, overlay, and the catalog at a phone and a laptop width in both themes", { skip, timeout: 900000 }, async () => {
  const result = await run(process.execPath, [path.join(ROOT, "scripts/review-demo/layout-check.mjs"), "--viewports", "phone,laptop", "--themes", "light,dark"], { maxBuffer: 16 * 1024 * 1024, timeout: 890000 }).catch((error) => error);
  assert.equal(result.code ?? 0, 0, `the layout check reports:\n${result.stdout}`);
  assert.match(result.stdout, /0 distinct findings/);
});

test("comfortable density makes every kit control of the page taller, and reduced motion stills the page", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const heights = {};
  for (const density of ["compact", "comfortable"]) {
    await choose(base, { density });
    const page = await openPage(browser, reviewUrl(base, "slice:retry-hardening/timeout-retries"));
    await waitForView(page);
    heights[density] = await page.evaluate(() => [...document.querySelectorAll("prism-button, prism-tab")].filter((element) => element.getClientRects().length).map((element) => Math.round(element.getBoundingClientRect().height)));
    await page.context().close();
  }
  assert.ok(heights.compact.length >= 3, "the page shows kit controls");
  assert.ok(heights.compact.every((height) => height >= 22 && height <= 24), `compact controls are 22 to 24px tall: ${heights.compact}`);
  assert.ok(heights.comfortable.every((height) => height >= 28 && height <= 30), `comfortable controls are 28 to 30px tall: ${heights.comfortable}`);
  for (const ref of ["attention", "roadmap", "slice:retry-hardening/timeout-retries"]) {
    const page = await openPage(browser, reviewUrl(base, ref), { reducedMotion: "reduce" });
    await waitForView(page);
    assert.deepEqual(await movingElements(page), [], `${ref} moves nothing`);
    for (const theme of ["light", "dark"]) {
      await choose(base, { theme, density: "compact" });
      await page.reload();
      await waitForView(page);
      assert.deepEqual(await contrastFailures(page), [], `${ref} text, ${theme}`);
    }
    await page.context().close();
  }
});
