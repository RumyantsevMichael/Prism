import assert from "node:assert/strict";
import test from "node:test";
import { boundaryFailures, contrastFailures, demoProject, escapes, launch, openPage, reviewUrl, serveProject, skip, stateFileNames, useAppDirectory, waitForView, writeClaim } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §2, §7, §8, §9.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 21, 22, 38, 66, 67, 69, 77, 79, 80, and 81.
// The workflow views of the real review page run over the demo and edge-case projects in both themes.

const PAGES = ["attention", "roadmap", "initiative:retry-hardening", "slice:retry-hardening/timeout-retries", "slice:retry-hardening/retry-observability", "requirements", "decisions", "glossary"];
const SLICE = "Retry timed-out requests until a total deadline";

// The demo project with a live claim on the gated slice and an expired claim on another, written before its server starts.
async function claimed(context) {
  await useAppDirectory(context);
  const root = await demoProject(context);
  await writeClaim(root, "retry-hardening", "timeout-retries", { label: "Claude on build-2", activity: "implementation", minutesLeft: 41 });
  await writeClaim(root, "retry-hardening", "retry-metrics", { label: "Codex on ci", activity: "implementation", minutesLeft: -4 });
  const { base } = await serveProject(context, root);
  return { base, browser: await launch(context) };
}

const choose = (base, body) => fetch(`${base}/api/preferences`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("clauses 21, 22: text and fields of every workflow view reach WCAG AA in both themes and both densities", { skip, timeout: 300000 }, async (context) => {
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
        for (const failure of await boundaryFailures(page, "#artifact")) failures.push(`${ref} ${theme} ${density}: field ${failure}`);
        await page.context().close();
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("clauses 38, 77: every workflow view with long names stays inside a phone window", { skip, timeout: 300000 }, async (context) => {
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

test("clause 81: a gate is answered from the keyboard alone", { skip }, async (context) => {
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

test("clauses 66, 67: the roadmap, the slice page, the gate, and Attention show the slice's claims read-only", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await claimed(context);
  const roadmap = await openPage(browser, reviewUrl(base, "roadmap"));
  await waitForView(roadmap);
  const card = roadmap.locator("#artifact").locator("article, li, section, prism-panel").filter({ hasText: "Harden request retries" }).last();
  const cardText = await card.innerText();
  assert.match(cardText, /1 working/, "the initiative card counts its live claims");
  assert.match(cardText, /1 claim expired/, "the initiative card counts its expired claims");
  assert.ok(await card.locator("prism-avatar").count() >= 2, "the card shows the holders' avatars");
  const slice = await openPage(browser, reviewUrl(base, "slice:retry-hardening/timeout-retries"));
  await waitForView(slice);
  const strip = slice.locator('#artifact prism-claim[variant="strip"]');
  assert.equal(await strip.count(), 1, "the slice page shows a claim strip");
  assert.match(await strip.innerText(), /Claude on build-2[\s\S]*Agent[\s\S]*implementation[\s\S]*since[\s\S]*min left/);
  const below = await slice.evaluate(() => {
    const stepper = document.querySelector("#artifact prism-stepper").getBoundingClientRect();
    const claim = document.querySelector('#artifact prism-claim[variant="strip"]').getBoundingClientRect();
    return claim.top >= stepper.bottom - 1;
  });
  assert.equal(below, true, "the claim strip sits under the stepper");
  const attention = await openPage(browser, reviewUrl(base, "attention"));
  await waitForView(attention);
  const view = attention.locator("#artifact");
  assert.match(await view.innerText(), /Claude on build-2 is waiting on your answer/, "the gate names whose work resumes");
  const watch = view.getByRole("region", { name: /Watch/ }).or(view.locator("section, prism-panel").filter({ has: attention.getByRole("heading", { name: /Watch/ }) })).first();
  assert.match(await watch.innerText(), /Codex on ci[\s\S]*Expired 4 min ago/, "the Watch group lists the expired claim");
  for (const page of [roadmap, slice, attention]) {
    const offered = await page.evaluate(() => {
      const deep = (root) => [...root.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...deep(node.shadowRoot)] : [node]);
      return deep(document.querySelector("#artifact")).filter((node) => ["button", "link", "menuitem"].includes(node.getAttribute("role")) || ["BUTTON", "A"].includes(node.tagName)).map((node) => (node.getAttribute("aria-label") ?? node.textContent).trim()).filter((name) => /^(take|release|renew|remind|follow|claim)\b/i.test(name));
    });
    assert.deepEqual(offered, [], "no view offers a claim action");
  }
});

test("clauses 77, 79: the slice page shows its lifecycle, claim, and sub-tabs, and its side panel opens beside the page or as a bottom sheet", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await claimed(context);
  const page = await openPage(browser, reviewUrl(base, "slice:retry-hardening/timeout-retries"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  const view = page.locator("#artifact");
  const stepper = view.getByRole("list", { name: "Lifecycle" });
  assert.equal(await stepper.count(), 1);
  const steps = await stepper.getByRole("listitem").allInnerTexts();
  assert.equal(steps.length, 6);
  for (const [index, phase] of ["Requirements", "Design", "Frozen", "Build", "Review", "Shipped"].entries()) assert.match(steps[index], new RegExp(phase), `step ${index + 1} is ${phase}`);
  assert.equal(await stepper.locator('[aria-current="step"]').count(), 1, "one phase is current");
  assert.match(steps[0], /done/i, "requirements are done");
  const tabs = view.getByRole("tablist", { name: "Slice" });
  assert.deepEqual((await tabs.getByRole("tab").allInnerTexts()).map((text) => text.trim()), ["Design", "Diagram", "Verification", "Review ledger", "Change map", "Files"]);
  const bar = page.locator("#page-bar");
  assert.equal(await bar.getByRole("button", { name: "Copy link", exact: true }).count(), 1);
  const side = bar.getByRole("button", { name: "Side panel", exact: true });
  assert.equal(await side.count(), 1);
  assert.equal(await side.getAttribute("aria-pressed"), "false");
  await side.click();
  assert.equal(await side.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#side-panel").isVisible(), true, "the side panel opens beside the page");
  assert.ok(await page.locator("#side-panel svg").count() >= 1 || await page.locator("#side-panel").getByText(/diagram/i).count() >= 1, "the side panel holds the slice's diagram");
  const phone = await openPage(browser, reviewUrl(base, "slice:retry-hardening/timeout-retries"), { viewport: { width: 390, height: 800 } });
  await waitForView(phone);
  await phone.locator("#page-bar").getByRole("button", { name: "Side panel", exact: true }).click();
  const sheet = phone.getByRole("dialog").filter({ has: phone.locator("svg, prism-panel, p") }).last();
  await sheet.waitFor();
  const box = await sheet.evaluate((element) => { const rect = element.getBoundingClientRect(); return { bottom: rect.bottom, width: rect.width, height: innerHeight, window: innerWidth }; });
  assert.ok(Math.abs(box.bottom - box.height) <= 1 && Math.abs(box.width - box.window) <= 1, "at 390px the side panel is a bottom sheet across the window");
  const blank = await openPage(browser, reviewUrl(base, "slice:retry-hardening/retry-observability"));
  await waitForView(blank);
  const blankSteps = blank.locator("#artifact").getByRole("list", { name: "Lifecycle" });
  assert.match(await blankSteps.locator('[aria-current="step"]').innerText(), /Design/, "a slice without an accepted design is in its design phase");
  const blankTabs = blank.locator("#artifact").getByRole("tablist", { name: "Slice" });
  await blankTabs.getByRole("tab", { name: "Review ledger" }).click();
  assert.ok(await blank.locator("#artifact prism-empty-state").count() >= 1, "a tab whose record is absent shows an empty state");
});

test("clauses 69, 80: every workflow view names Prism's records by title and kind, and the gate's list of what to inspect does too", { skip, timeout: 180000 }, async (context) => {
  const { base, browser } = await claimed(context);
  const failures = [];
  for (const ref of PAGES) {
    const page = await openPage(browser, reviewUrl(base, ref));
    await waitForView(page);
    for (const failure of await stateFileNames(page, "#artifact")) failures.push(`${ref}: ${failure}`);
    await page.context().close();
  }
  assert.deepEqual(failures, []);
  const page = await openPage(browser, reviewUrl(base, "attention"));
  await waitForView(page);
  const gate = page.locator("#artifact").locator("article, section, prism-panel").filter({ hasText: "Review the change map and the total-deadline ADR" }).last();
  const text = await gate.innerText();
  assert.match(text, /Design · \d+ clauses? · \d+ frozen tests?/, "the slice's design is named by kind with its counts");
  assert.match(text, /· Decision · (Proposed|Accepted|Superseded)/, "the decision is named by title and kind");
  assert.match(text, /Change map · \d+ planned changes?/, "the change map is named by kind with its count");
  const decision = page.locator("#artifact").locator("article, section, prism-panel").filter({ hasText: "deletes the only handler that retries dropped connections" }).last();
  const other = await decision.innerText();
  assert.match(other, /Review ledger · \d+ open findings?/, "the review ledger is named by kind with its count");
  assert.match(other, /· Requirements/, "the requirements file is named by title and kind");
});
