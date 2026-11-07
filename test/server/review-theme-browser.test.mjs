import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, launch, movingElements, openPage, paintedBackgrounds, reviewUrl, rootToken, serveProject, settle, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §1, §3, §4, §5, §6, §13.
// The real review page runs in Chromium over a demo project, with the theme chosen through the preferences route and the operating system's setting emulated.

const PAGES = ["attention", "roadmap", "slice:retry-hardening/timeout-retries", "docs/retry.md", "src/retry/strategy.ts", "config/retry.json"];

const choose = (base, body) => fetch(`${base}/api/preferences`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const appearance = (page) => page.evaluate(() => ({ choice: document.documentElement.dataset.themeChoice, theme: document.documentElement.dataset.theme, density: document.documentElement.dataset.density }));

test("by default the page follows the operating system's theme and switches with it without a reload", { skip }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/`, { colorScheme: "light" });
  assert.deepEqual(await appearance(page), { choice: "system", theme: "light", density: "compact" });
  await page.evaluate(() => { window.__sameDocument = true; });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => window.__sameDocument), true, "the switch happens without a reload");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light", null, { timeout: 3000 });
});

test("a stored theme overrides the operating system and survives a reload and a restart on another port", { skip }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  const first = await serveProject(context, root);
  await choose(first.base, { theme: "dark" });
  const browser = await launch(context);
  const page = await openPage(browser, `${first.base}/`, { colorScheme: "light" });
  assert.deepEqual(await appearance(page), { choice: "dark", theme: "dark", density: "compact" });
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.content.trim().toLowerCase()), (await rootToken(page, "--prism-color-chrome")).toLowerCase(), "the theme color is the chrome color");
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await settle(page);
  assert.equal((await appearance(page)).theme, "dark");
  const second = await serveProject(context, root);
  await first.close();
  assert.notEqual(new URL(second.base).port, new URL(first.base).port);
  const restarted = await openPage(browser, `${second.base}/`, { colorScheme: "light" });
  assert.deepEqual(await appearance(restarted), { choice: "dark", theme: "dark", density: "compact" });
});

test("the page applies the last choice it saw before the server answers, and keeps it when the server cannot be reached", { skip }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  await choose(base, { theme: "dark", density: "comfortable" });
  const browser = await launch(context);
  const browserContext = await browser.newContext({ colorScheme: "light" });
  const page = await browserContext.newPage();
  await page.goto(`${base}/`);
  await settle(page);
  assert.equal((await appearance(page)).theme, "dark");
  // The next load answers the preferences late, so the theme at DOMContentLoaded comes from the browser's last choice.
  await browserContext.route("**/api/preferences", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { window.__early = { theme: document.documentElement.dataset.theme, density: document.documentElement.dataset.density }; }));
  await page.reload();
  assert.deepEqual(await page.evaluate(() => window.__early), { theme: "dark", density: "comfortable" });
  await browserContext.unroute("**/api/preferences");
  await browserContext.route("**/api/preferences", (route) => route.abort());
  await page.reload();
  await settle(page);
  assert.deepEqual(await appearance(page), { choice: "dark", theme: "dark", density: "comfortable" }, "an unreachable server keeps the browser's choice");
  const fresh = await (await browser.newContext({ colorScheme: "light" })).newPage();
  await fresh.context().route("**/api/preferences", (route) => route.abort());
  await fresh.goto(`${base}/`);
  await settle(fresh);
  assert.deepEqual(await appearance(fresh), { choice: "system", theme: "light", density: "compact" }, "a browser without a choice uses the defaults");
});

test("comfortable density raises the control and row heights", { skip }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const compact = await openPage(browser, `${base}/`);
  assert.equal(await rootToken(compact, "--prism-control-height"), "24px");
  assert.equal(await rootToken(compact, "--prism-row-height"), "22px");
  await choose(base, { density: "comfortable" });
  const comfortable = await openPage(browser, `${base}/`);
  assert.equal((await appearance(comfortable)).density, "comfortable");
  assert.equal(await rootToken(comfortable, "--prism-control-height"), "30px");
  assert.equal(await rootToken(comfortable, "--prism-row-height"), "28px");
  assert.equal(await rootToken(comfortable, "--prism-font-size-md"), "14px");
});

test("every painted surface of every page changes with the theme", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const failures = [];
  for (const ref of PAGES) {
    const painted = {};
    const paper = {};
    for (const theme of ["light", "dark"]) {
      await choose(base, { theme });
      const page = await openPage(browser, reviewUrl(base, ref));
      // A probe painted with the diagram paper gives that color in the same form as every painted surface.
      await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.id = "paper-probe";
        probe.style.setProperty("background-color", "var(--prism-color-diagram-paper)");
        probe.style.setProperty("width", "1px");
        probe.style.setProperty("height", "1px");
        document.body.append(probe);
      });
      painted[theme] = await paintedBackgrounds(page);
      const probe = Object.keys(painted[theme]).find((key) => key.endsWith("div#paper-probe"));
      paper[theme] = painted[theme][probe];
      delete painted[theme][probe];
      await page.context().close();
    }
    assert.ok(Object.keys(painted.light).length > 3, `${ref} paints surfaces`);
    for (const [element, color] of Object.entries(painted.light)) {
      if (!(element in painted.dark) || painted.dark[element] !== color) continue;
      if (color === paper.light && color === paper.dark) continue;
      failures.push(`${ref}: ${element} keeps ${color} in both themes`);
    }
  }
  assert.deepEqual(failures, []);
});

test("the interface and code fonts load from the review app with every other host unreachable", { skip }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "src/retry/strategy.ts"), { blockOtherHosts: true });
  const fonts = await page.evaluate(() => {
    const family = (element) => element ? getComputedStyle(element).fontFamily : null;
    const code = document.querySelector("#artifact pre, #artifact code");
    return {
      body: family(document.body),
      code: family(code),
      loaded: [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/["']/g, ""))
    };
  });
  assert.match(fonts.body, /^"?Prism UI"?,/);
  assert.match(fonts.code ?? "", /^"?Prism Code"?,/);
  assert.ok(fonts.loaded.includes("Prism UI"), "Prism UI loaded");
  assert.ok(fonts.loaded.includes("Prism Code"), "Prism Code loaded");
  assert.deepEqual(page.errors, []);
});

test("under reduced motion nothing on the page animates or transitions", { skip }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  for (const ref of ["attention", "slice:retry-hardening/timeout-retries", "docs/plans/retry-hardening/timeout-retries/timeout-retries.puml"]) {
    const page = await openPage(browser, reviewUrl(base, ref), { reducedMotion: "reduce" });
    for (const token of ["--prism-duration-fast", "--prism-duration-normal", "--prism-duration-slow"]) assert.equal(await rootToken(page, token), "0ms");
    assert.deepEqual(await movingElements(page), [], `${ref} moves nothing`);
    await page.context().close();
  }
});
