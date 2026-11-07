import assert from "node:assert/strict";
import test from "node:test";
import { boundaryFailures, contrastFailures, demoProject, escapes, launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §2, §7, §8, §9.
// The workflow views of the real review page run over the demo and edge-case projects in both themes.

const PAGES = ["attention", "roadmap", "initiative:retry-hardening", "slice:retry-hardening/timeout-retries", "requirements", "decisions", "glossary"];
const choose = (base, body) => fetch(`${base}/api/preferences`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("text and controls of every workflow view reach WCAG AA in both themes and both densities", { skip, timeout: 300000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const failures = [];
  for (const theme of ["light", "dark"]) {
    for (const density of ["compact", "comfortable"]) {
      await choose(base, { theme, density });
      for (const ref of PAGES) {
        const page = await openPage(browser, reviewUrl(base, ref));
        await waitForView(page);
        for (const failure of await contrastFailures(page, "#artifact")) failures.push(`${ref} ${theme} ${density}: text ${failure}`);
        for (const failure of await boundaryFailures(page, "#artifact")) failures.push(`${ref} ${theme} ${density}: control ${failure}`);
        await page.context().close();
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("every workflow view with long names stays inside a phone window", { skip, timeout: 300000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context, "seed-stress.mjs"));
  const browser = await launch(context);
  const index = await (await fetch(`${base}/api/index`)).json();
  const refs = [...new Set(["attention", "roadmap", ...index.navigation.index.map((entry) => entry.ref).filter((ref) => /^(initiative|slice):/.test(ref))])].slice(0, 12);
  const failures = [];
  for (const ref of refs) {
    const page = await openPage(browser, reviewUrl(base, ref), { viewport: { width: 360, height: 740 } });
    await waitForView(page);
    for (const failure of await escapes(page, "#artifact")) failures.push(`${ref}: ${failure}`);
    await page.context().close();
  }
  assert.deepEqual(failures, []);
});

test("a gate is answered from the keyboard alone", { skip }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const gates = async () => (await (await fetch(`${base}/api/entity?ref=attention`)).json()).data.gateCount;
  const before = await gates();
  assert.ok(before > 0, "the demo has open gates");
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "attention"));
  await waitForView(page);
  const choice = page.locator("#artifact").getByRole("radiogroup").first();
  await choice.getByRole("radio").first().focus();
  await page.keyboard.press("Space");
  let sent = false;
  for (let stop = 0; stop < 12 && !sent; stop += 1) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => {
      let element = document.activeElement;
      while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
      return element?.closest?.("button") ? element.textContent.trim() : element?.textContent?.trim() ?? "";
    });
    if (/^Send/.test(name)) {
      await page.keyboard.press("Enter");
      sent = true;
    }
  }
  assert.ok(sent, "the Send button is reachable with Tab");
  await page.waitForFunction(async ([base, before]) => (await (await fetch(`${base}/api/entity?ref=attention`)).json()).data.gateCount < before, [base, before], { timeout: 10000, polling: 300 });
  assert.equal(await gates(), before - 1);
});
