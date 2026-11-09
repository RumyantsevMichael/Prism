import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView, writeClaim } from "./fixtures/kit-browser.mjs";

// A link preview stays open while the pointer crosses a neighboring link on its way to the preview, so its button can be reached.
// A Markdown heading's fold toggle stays inside the box that holds the document, at every width.

test("a link preview survives the pointer crossing the next link on its way to the preview's button", { skip }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "initiative:retry-hardening"), { viewport: { width: 1280, height: 800 } });
  await waitForView(page);
  // The requirement chip and the record chip below it sit one line apart, so the path from the first into its preview crosses the second.
  const pair = await page.evaluate(() => {
    const chips = [...document.querySelectorAll("#workspace [data-artifact]")].filter((element) => !element.dataset.artifact.includes(":"));
    for (const first of chips) {
      const top = first.getBoundingClientRect();
      const next = chips.find((other) => {
        const box = other.getBoundingClientRect();
        return box.top > top.top && box.top - top.bottom < 12 && box.left < top.right && box.right > top.left;
      });
      if (next) return { first: first.dataset.artifact, x: top.left + 6, y: (top.top + top.bottom) / 2 };
    }
    return null;
  });
  assert.ok(pair, "the initiative page shows two file chips one above the other");
  await page.mouse.move(pair.x, pair.y);
  const preview = page.locator(".link-preview:not([hidden])");
  await preview.waitFor({ state: "visible", timeout: 5000 });
  const button = preview.getByText("Show in side panel");
  await button.waitFor();
  const target = await button.boundingBox();
  assert.ok(target.y > pair.y, "the preview opens below the link");
  // A person moves the pointer down and across in a few steps; each step lands on whatever lies under it, including the next chip.
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(pair.x + ((target.x + target.width / 2 - pair.x) * step) / steps, pair.y + ((target.y + target.height / 2 - pair.y) * step) / steps);
    await page.waitForTimeout(40);
  }
  assert.equal(await preview.isVisible(), true, "the preview is still open when the pointer reaches it");
  await button.click();
  await page.locator("#side-panel").waitFor({ state: "visible", timeout: 5000 });
  assert.match(await page.locator("#side-panel-source").textContent(), /\S/, "the side panel shows the previewed file");
  assert.deepEqual(page.errors, []);
});

test("a link preview switches to a neighboring link the pointer rests on", { skip }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "requirements"), { viewport: { width: 1280, height: 800 } });
  await waitForView(page);
  const chips = await page.evaluate(() => [...document.querySelectorAll("#workspace [data-artifact]")].filter((element) => element.dataset.artifact.startsWith("docs/")).slice(0, 2).map((element) => {
    const box = element.getBoundingClientRect();
    return { ref: element.dataset.artifact, x: box.left + 6, y: (box.top + box.bottom) / 2 };
  }));
  assert.equal(chips.length, 2, "the requirements page lists two documents");
  const preview = page.locator(".link-preview:not([hidden])");
  // The preview opens below its link, so the pointer moves up from the lower link to the upper one without passing over it.
  await page.mouse.move(chips[1].x, chips[1].y);
  await preview.waitFor({ state: "visible", timeout: 5000 });
  const first = await preview.textContent();
  await page.mouse.move(chips[0].x, chips[0].y);
  await page.waitForFunction((text) => {
    const element = document.querySelector(".link-preview:not([hidden])");
    return element && !element.hidden && element.textContent !== text;
  }, first, { timeout: 5000 });
  assert.equal(await preview.isVisible(), true, "the preview shows the link the pointer rests on");
});

for (const width of [360, 768, 1280]) {
  test(`fold toggles stay inside the document's box at ${width}px`, { skip }, async (context) => {
    await useAppDirectory(context);
    const root = await demoProject(context);
    const { base } = await serveProject(context, root);
    const browser = await launch(context);
    const page = await openPage(browser, reviewUrl(base, "docs/retry.md"), { viewport: { width, height: 800 } });
    await waitForView(page);
    const escapes = await page.evaluate(() => {
      const found = [];
      const toggles = [...document.querySelectorAll("#workspace .md-fold")];
      for (const toggle of toggles) {
        const box = toggle.getBoundingClientRect();
        // The nearest ancestor that draws a box or clips is the container the toggle must stay in.
        let container = toggle.closest(".document-content").parentElement;
        while (container && container !== document.body) {
          const style = getComputedStyle(container);
          if (style.borderLeftWidth !== "0px" || style.overflowX !== "visible" || style.backgroundColor !== "rgba(0, 0, 0, 0)") break;
          container = container.parentElement;
        }
        const bounds = container.getBoundingClientRect();
        if (box.left < bounds.left + Number.parseFloat(getComputedStyle(container).borderLeftWidth)) found.push(`${toggle.parentElement.textContent.trim()}: ${Math.round(box.left)} < ${Math.round(bounds.left)}`);
      }
      return { count: toggles.length, found };
    });
    assert.ok(escapes.count > 0, "the document has fold toggles");
    assert.deepEqual(escapes.found, []);
  });
}

test("Who's working and the sidebar name the harness a claim records, and say Agent for a claim that names none", { skip }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  await writeClaim(root, "retry-hardening", "timeout-retries", { label: "Prism Test on build-2", host: "Codex", minutesLeft: 41 });
  await writeClaim(root, "retry-hardening", "retry-metrics", { label: "Prism Test on ci", minutesLeft: 30 });
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 1280, height: 800 } });
  await waitForView(page);
  await page.locator("#presence-button").click();
  const rows = page.locator("#presence .presence-row");
  await rows.first().waitFor();
  const kinds = await rows.evaluateAll((items) => Object.fromEntries(items.map((row) => [row.querySelector(".presence-name").textContent, row.querySelector(".presence-kind").textContent])));
  assert.deepEqual(kinds, { "Prism Test on build-2": "Codex", "Prism Test on ci": "Agent" });
  const tips = await page.evaluate(() => [...document.querySelectorAll("#sidebar prism-claim")].map((claim) => claim.getAttribute("tip") ?? ""));
  assert.ok(tips.some((tip) => tip.startsWith("Prism Test on build-2 · Codex ·")), `a sidebar claim's tip names the harness: ${JSON.stringify(tips)}`);
  assert.deepEqual(page.errors, []);
});
