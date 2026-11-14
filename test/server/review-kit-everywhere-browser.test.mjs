import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { contrastFailures, demoProject, launch, movingElements, openPage, reviewUrl, ROOT, serveProject, skip, stateFileNames, useAppDirectory, waitForView, writeClaim } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §5, §8, §11, §13.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 7, 8, 9, 21, 24, 62, and 69.
// Feature: docs/Features/F-review-app-ui-kit.feature.
// The whole review page, on the kit, passes the layout check and follows density and reduced motion.

const run = promisify(execFile);
const choose = (base, body) => fetch(`${base}/api/preferences`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// The check runs in two parts side by side, each over half of the pages, since a lone check spends much of its time waiting for pages to settle.
// More parts finish sooner but load the runner enough to slow the browser tests that run beside them past their own bounds.
// Together they take about three minutes on a Linux runner and up to twice that on Windows.
// The dark theme changes only colors, which the tokens test holds, so the light theme's layout is the dark theme's too, and the contrast tests check the dark colors.
const LAYOUT_CHECK_PARTS = 2;
const LAYOUT_CHECK_MS = process.platform === "win32" ? 890000 : 590000;
test("clause 62: the layout check passes every page, overlay, and the catalog at a phone and a laptop width in the light theme", { skip, timeout: LAYOUT_CHECK_MS + 10000 }, async () => {
  const parts = await Promise.all(Array.from({ length: LAYOUT_CHECK_PARTS }, (_, index) => run(process.execPath, [path.join(ROOT, "scripts/review-demo/layout-check.mjs"), "--viewports", "phone,laptop", "--themes", "light", "--part", `${index + 1}/${LAYOUT_CHECK_PARTS}`], { maxBuffer: 16 * 1024 * 1024, timeout: LAYOUT_CHECK_MS }).catch((error) => error)));
  for (const [index, result] of parts.entries()) {
    const part = `part ${index + 1} of ${LAYOUT_CHECK_PARTS}`;
    assert.equal(result.signal ?? null, null, `the layout check's ${part} finished within ${LAYOUT_CHECK_MS} ms`);
    assert.equal(result.code ?? 0, 0, `the layout check's ${part} reports:\n${result.stdout}`);
    assert.match(result.stdout, /^[1-9]\d* page checks, \d+ catalog checks, 0 distinct findings/m, `the layout check's ${part} checked pages and found nothing`);
  }
  assert.match(parts[0].stdout, /, 2 catalog checks,/, "the first part checks the catalog at each viewport");
});

const PAGES = ["attention", "roadmap", "initiative:retry-hardening", "slice:retry-hardening/timeout-retries", "requirements", "decisions", "glossary", "docs/retry.md", "src/retry/strategy.ts", "config/retry.json", "docs/plans/retry-hardening/timeout-retries/timeout-retries.puml"];

async function served(context) {
  await useAppDirectory(context);
  const root = await demoProject(context);
  await writeClaim(root, "retry-hardening", "timeout-retries", { label: "Claude on build-2", activity: "implementation", minutesLeft: 41 });
  await writeClaim(root, "retry-hardening", "retry-metrics", { label: "Codex on ci", activity: "implementation", minutesLeft: -4 });
  const { base } = await serveProject(context, root);
  return { base, browser: await launch(context) };
}

// Every computed color of every element and shadow element below the body, keyed by element path, with SVG content left out.
const computedColors = (page) => page.evaluate(() => {
  const out = {};
  const parentOf = (node) => node.assignedSlot ?? node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
  const describe = (element) => { const parts = []; for (let node = element; node && parts.length < 5; node = parentOf(node)) parts.unshift(node.tagName.toLowerCase() + (node.id ? "#" + node.id : "")); return parts.join(" > "); };
  const nodes = [document.body];
  const counts = {};
  while (nodes.length) {
    const node = nodes.shift();
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (node.shadowRoot) nodes.push(...node.shadowRoot.children);
    nodes.push(...node.children);
    if (node.closest("svg")) continue;
    let key = describe(node);
    counts[key] = (counts[key] ?? 0) + 1;
    if (counts[key] > 1) key += " #" + counts[key];
    const style = getComputedStyle(node);
    out[key] = ["color", "backgroundColor", "borderTopColor", "borderBottomColor", "outlineColor", "boxShadow", "backgroundImage", "fill", "stroke"].map((name) => style[name]).join(" | ");
  }
  return out;
});

test("clauses 7, 8: a further theme given the dark theme's values renders every page exactly as the dark theme does, shadow controls included", { skip, timeout: 300000 }, async (context) => {
  const { base, browser } = await served(context);
  const differences = [];
  for (const ref of PAGES) {
    const page = await openPage(browser, reviewUrl(base, ref), { colorScheme: "dark" });
    await waitForView(page);
    await page.evaluate(() => {
      document.documentElement.dataset.themeChoice = "dark";
      document.documentElement.dataset.theme = "dark";
    });
    await page.waitForTimeout(300);
    const dark = await computedColors(page);
    // A theme rule of another name that copies every value of the dark rule; the page must not tell the two apart.
    await page.evaluate(() => {
      const values = [];
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) if (rule.selectorText === '[data-theme="dark"]') for (const name of rule.style) values.push(`${name}: ${rule.style.getPropertyValue(name)}`);
      }
      const copy = new CSSStyleSheet();
      copy.replaceSync(`[data-theme="probe"] { color-scheme: dark; ${values.join("; ")} }`);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, copy];
      document.documentElement.dataset.theme = "probe";
    });
    await page.waitForTimeout(300);
    const probe = await computedColors(page);
    for (const [element, value] of Object.entries(dark)) if (probe[element] !== undefined && probe[element] !== value) differences.push(`${ref}: ${element} computes ${probe[element]} in the probe theme but ${value} in dark`);
    await page.context().close();
  }
  assert.deepEqual(differences.slice(0, 40), []);
});

test("clause 7: a theme that flattens the islands gives every island no gap, no radius, and no shadow", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await served(context);
  const page = await openPage(browser, reviewUrl(base, "slice:retry-hardening/timeout-retries"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  const flat = await page.evaluate(() => {
    const values = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) if (rule.selectorText?.includes('[data-theme="light"]')) for (const name of rule.style) values.push(`${name}: ${rule.style.getPropertyValue(name)}`);
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`[data-theme="flat"] { ${values.join("; ")}; --prism-island-gap: 0px; --prism-radius-island: 0px; --prism-shadow-island: none }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    document.documentElement.dataset.theme = "flat";
    return new Promise((resolve) => setTimeout(() => {
      const islands = [...document.querySelectorAll('prism-panel[variant="island"]')].filter((island) => island.getClientRects().length);
      const sidebar = document.querySelector("#sidebar").getBoundingClientRect();
      const main = document.querySelector("#main").getBoundingClientRect();
      resolve({ count: islands.length, shapes: islands.map((island) => { const style = getComputedStyle(island); return [style.borderTopLeftRadius, style.boxShadow]; }), gap: Math.round(main.left - sidebar.right) });
    }, 300));
  });
  assert.ok(flat.count >= 1, "the page shows islands");
  for (const [radius, shadow] of flat.shapes) {
    assert.equal(radius, "0px", "a flat theme removes the island radius");
    assert.equal(shadow, "none", "a flat theme removes the island shadow");
  }
  assert.ok(flat.gap <= 1, `a flat theme closes the island gap, not ${flat.gap}px`);
});

test("clauses 9, 21, 24: comfortable density makes every kit control of the page taller, and reduced motion stills the page", { skip, timeout: 180000 }, async (context) => {
  const { base, browser } = await served(context);
  const heights = {};
  for (const density of ["compact", "comfortable"]) {
    await choose(base, { density });
    const page = await openPage(browser, reviewUrl(base, "slice:retry-hardening/timeout-retries"));
    await waitForView(page);
    heights[density] = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const sizes = ["--prism-control-height", "--prism-control-height-sm", "--prism-row-height", "--prism-subtab-height"].map((name) => Math.round(parseFloat(root.getPropertyValue(name))));
      return [...document.querySelectorAll("prism-button, prism-tab, prism-tree-item, prism-menu-item, prism-list-item")].filter((element) => element.getClientRects().length).map((element) => {
        // An expanded tree item holds its child items, so its own row is the control that is measured.
        const own = element.shadowRoot?.firstElementChild ?? element.querySelector(":scope > .prism-tree-row") ?? element;
        const height = Math.round(Math.min(element.getBoundingClientRect().height, own.getBoundingClientRect().height || Infinity));
        return { tag: element.tagName.toLowerCase(), height, sized: sizes.includes(height) || sizes.includes(Math.round(element.getBoundingClientRect().height)) };
      });
    });
    await page.context().close();
  }
  assert.ok(heights.compact.length >= 3, "the page shows kit controls");
  assert.deepEqual(heights.compact.filter((item) => !item.sized), [], "every compact control takes its height from a size token");
  assert.deepEqual(heights.comfortable.filter((item) => !item.sized), [], "every comfortable control takes its height from a size token");
  assert.equal(heights.comfortable.length, heights.compact.length, "both densities show the same controls");
  heights.compact.forEach((item, index) => assert.ok(heights.comfortable[index].height > item.height, `${item.tag} ${index} is taller in comfortable density`));
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

test("clause 69: no page or overlay of the review app names Prism's own files", { skip, timeout: 300000 }, async (context) => {
  const { base, browser } = await served(context);
  const failures = [];
  for (const ref of PAGES) {
    const page = await openPage(browser, reviewUrl(base, ref));
    await waitForView(page);
    for (const failure of await stateFileNames(page)) failures.push(`${ref}: ${failure}`);
    await page.locator("header").getByRole("button", { name: /working/ }).click();
    await page.waitForTimeout(300);
    for (const failure of await stateFileNames(page)) failures.push(`${ref} with Who's working open: ${failure}`);
    await page.keyboard.press("Escape");
    await page.context().close();
  }
  assert.deepEqual([...new Set(failures)], []);
});
