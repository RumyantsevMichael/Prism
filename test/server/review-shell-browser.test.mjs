import assert from "node:assert/strict";
import test from "node:test";
import { boundaryFailures, contrastFailures, demoProject, escapes, launch, movingElements, openPage, paintedBackgrounds, reviewUrl, serveProject, skip, stateFileNames, useAppDirectory, waitForView, writeClaim } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-ui-kit.md §2, §3, §7, §8, §9.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 20, 21, 22, 66, 67, 68, 69, 74, 75, 76, 77, and 78.
// The shell of the real review page runs over the demo and edge-case projects: the top bar, the sidebar and its drawer, the page bar, the islands, the status bar, the command palette, and Who's working.

const SHELL = "header, #sidebar, #page-bar, #statusbar, #side-panel";
const SLICE = "Retry timed-out requests until a total deadline";
const choose = (base, body) => fetch(`${base}/api/preferences`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// The demo project with one live claim and one expired claim, written before its server starts.
async function claimed(context, seed = "seed.mjs") {
  await useAppDirectory(context);
  const root = await demoProject(context, seed);
  if (seed === "seed.mjs") {
    await writeClaim(root, "retry-hardening", "timeout-retries", { label: "Claude on build-2", activity: "implementation", minutesLeft: 41 });
    await writeClaim(root, "retry-hardening", "retry-metrics", { label: "Codex on ci", activity: "implementation", minutesLeft: -4 });
  }
  const { base } = await serveProject(context, root);
  return { root, base, browser: await launch(context) };
}

async function open(context, ref = "attention", options = {}, seed = "seed.mjs") {
  const { base, browser } = await claimed(context, seed);
  const page = await openPage(browser, reviewUrl(base, ref), options);
  await waitForView(page);
  return { base, browser, page };
}

const deepFocus = (page) => page.evaluate(() => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element ? { tag: element.tagName.toLowerCase(), id: element.id, role: element.getAttribute("role"), inDialog: Boolean(element.closest("prism-dialog") ?? element.getRootNode().host?.closest?.("prism-dialog")) } : null;
});
const shownPage = (page) => page.evaluate(() => new URL(location.href).searchParams.get("artifact"));

test("clause 74: the artifact area reports busy while a view loads and not busy once it has rendered", { skip }, async (context) => {
  const { base, browser } = await claimed(context);
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => {
    window.__busy = [];
    new MutationObserver(() => {
      const value = document.querySelector("#artifact")?.getAttribute("aria-busy");
      if (value && window.__busy.at(-1) !== value) window.__busy.push(value);
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["aria-busy"], childList: true });
  });
  await page.goto(reviewUrl(base, "roadmap"));
  await waitForView(page);
  const seen = await page.evaluate(() => window.__busy);
  assert.equal(seen.at(-1), "false");
  assert.ok(seen.includes("true"), "the view reported busy while it loaded");
});

test("clause 75: the shell is a top bar, one sidebar of trees, the main island with its page bar, and a status bar on a canvas, with no tab strip", { skip }, async (context) => {
  const { page } = await open(context);
  const header = page.locator("header");
  assert.equal(await header.locator("[aria-haspopup=menu]").count() >= 1, true, "the top bar holds the project switcher menu");
  assert.equal(await header.getByRole("button", { name: /search|command palette/i }).count() >= 1, true, "the top bar holds the search button");
  assert.equal(await header.getByRole("button", { name: /working/ }).count(), 1, "the top bar holds the Who's working button");
  assert.ok(await header.locator("svg, img, prism-icon").count() >= 1, "the top bar shows the Prism mark");
  const sidebar = page.locator("#sidebar");
  assert.ok(await sidebar.getByRole("tree").count() >= 2, "the sidebar holds kit trees for places, initiatives, and the library");
  assert.equal(await sidebar.getByRole("treeitem", { name: /^Attention/ }).count(), 1);
  assert.equal(await sidebar.getByRole("treeitem", { name: /^Roadmap/ }).count(), 1);
  const strips = await page.evaluate(() => {
    const deep = (root) => [...root.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...deep(node.shadowRoot)] : [node]);
    const inside = (node) => { for (let at = node; at; at = at.parentElement ?? at.getRootNode().host) if (at.id === "artifact") return true; return false; };
    return deep(document).filter((node) => node.getAttribute("role") === "tablist" && node.getClientRects().length && !inside(node)).length;
  });
  assert.equal(strips, 0, "the page has no tab strip outside a page's own content");
  assert.equal(await page.getByRole("tablist", { name: "Open artifacts" }).count(), 0);
  const layout = await page.evaluate(() => {
    const main = document.querySelector("#main");
    const canvasOf = (element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundColor !== "rgba(0, 0, 0, 0)") return style;
      }
      return getComputedStyle(document.documentElement);
    };
    const probe = document.createElement("div");
    probe.style.setProperty("background-color", "var(--prism-color-chrome)");
    document.body.append(probe);
    const chrome = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const canvas = canvasOf(main);
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--prism-island-gap"));
    const sidebar = document.querySelector("#sidebar").getBoundingClientRect();
    const box = main.getBoundingClientRect();
    return {
      main: main.tagName.toLowerCase(), variant: main.getAttribute("variant"),
      bar: Boolean(main.querySelector("#page-bar")), artifact: Boolean(main.querySelector("#artifact")),
      barFirst: main.querySelector("#page-bar")?.getBoundingClientRect().top <= main.querySelector("#artifact")?.getBoundingClientRect().top,
      canvas: canvas.backgroundColor === chrome, gradient: canvas.backgroundImage.includes("gradient"),
      gap: Math.round(box.left - sidebar.right), expected: gap,
      statusbar: Boolean(document.querySelector("#statusbar"))
    };
  });
  assert.deepEqual({ main: layout.main, variant: layout.variant, bar: layout.bar, artifact: layout.artifact, barFirst: layout.barFirst, statusbar: layout.statusbar }, { main: "prism-panel", variant: "island", bar: true, artifact: true, barFirst: true, statusbar: true });
  assert.equal(layout.canvas, true, "the islands sit on a canvas painted --prism-color-chrome");
  assert.equal(layout.gradient, true, "the canvas carries the canvas gradient");
  assert.ok(layout.gap >= layout.expected - 1, `the main island stands at least --prism-island-gap from the sidebar (${layout.gap}px)`);
});

test("clause 76: the page bar moves back and forward through visited pages, from its buttons, Alt+arrows, and the browser, and shows a breadcrumb trail", { skip }, async (context) => {
  const { page } = await open(context);
  const bar = page.locator("#page-bar");
  const back = bar.getByRole("button", { name: "Back", exact: true });
  const forward = bar.getByRole("button", { name: "Forward", exact: true });
  assert.equal(await back.isDisabled(), true, "Back is disabled on the first page");
  assert.equal(await forward.isDisabled(), true, "Forward is disabled at the end");
  await page.locator("#sidebar").getByRole("treeitem", { name: /^Roadmap/ }).focus();
  await page.keyboard.press("Enter");
  await waitForView(page);
  assert.equal(await shownPage(page), "roadmap");
  const trail = bar.getByRole("navigation", { name: "Breadcrumb" });
  assert.equal(await trail.count(), 1, "the page bar holds the breadcrumb trail");
  assert.equal(await trail.locator("[aria-current=page]").innerText(), "Roadmap");
  await back.click();
  await waitForView(page);
  assert.equal(await shownPage(page), "attention", "Back returns to the earlier page");
  assert.equal(await forward.isDisabled(), false);
  await forward.click();
  await waitForView(page);
  assert.equal(await shownPage(page), "roadmap", "Forward returns to the later page");
  await page.keyboard.press("Alt+ArrowLeft");
  await waitForView(page);
  assert.equal(await shownPage(page), "attention", "Alt+ArrowLeft acts as Back");
  await page.keyboard.press("Alt+ArrowRight");
  await waitForView(page);
  assert.equal(await shownPage(page), "roadmap", "Alt+ArrowRight acts as Forward");
  await page.goBack();
  await waitForView(page);
  assert.equal(await shownPage(page), "attention", "the browser's own back moves through the same pages");
  await page.goto(page.url().replace(/artifact=[^&]+/, `artifact=${encodeURIComponent("slice:retry-hardening/timeout-retries")}`));
  await waitForView(page);
  const crumbs = await trail.getByRole("link").allInnerTexts();
  assert.ok(crumbs.some((text) => /Harden request retries/.test(text)), `the trail names the initiative by title: ${crumbs}`);
  assert.equal(await trail.locator("[aria-current=page]").innerText(), SLICE, "the trail ends with the slice's title");
});

test("clause 77: above 1100px the sidebar sits beside the page, and at 1100px and below it opens as a drawer from Navigation", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await claimed(context);
  const wide = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 1280, height: 800 } });
  await waitForView(wide);
  assert.equal(await wide.locator("#sidebar").isVisible(), true, "the sidebar shows at 1280px");
  assert.equal(await wide.locator("header").getByRole("button", { name: "Navigation", exact: true }).isVisible().catch(() => false), false, "no Navigation button at 1280px");
  await wide.context().close();
  for (const width of [1100, 820]) {
    const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width, height: 800 } });
    await waitForView(page);
    assert.equal(await page.locator("#sidebar").isVisible(), false, `the sidebar is hidden at ${width}px`);
    const button = page.locator("header").getByRole("button", { name: "Navigation", exact: true });
    await button.click();
    const drawer = page.getByRole("dialog").filter({ has: page.getByRole("tree") });
    await drawer.waitFor();
    const box = await drawer.evaluate((element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, width: rect.width, drawer: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--prism-drawer-width")) }; });
    assert.ok(Math.abs(box.left) <= 1 && Math.abs(box.width - box.drawer) <= 1, `the drawer slides in from the left at --prism-drawer-width at ${width}px`);
    await drawer.getByRole("treeitem", { name: /^Roadmap/ }).click();
    await waitForView(page);
    assert.equal(await page.getByRole("dialog").filter({ has: page.getByRole("tree") }).count(), 0, "choosing a page closes the drawer");
    assert.equal(await shownPage(page), "roadmap");
    assert.deepEqual(await escapes(page, "body"), [], `the page fits ${width}px`);
    await page.context().close();
  }
});

test("clause 78: the command palette opens on Ctrl+K and Meta+K, drives kinded results from its field, previews the active result, and returns focus on Escape", { skip }, async (context) => {
  const { page } = await open(context);
  await page.locator("#sidebar").getByRole("treeitem").first().focus();
  const before = await deepFocus(page);
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await dialog.waitFor();
  const field = dialog.getByRole("searchbox").or(dialog.getByRole("combobox"));
  assert.equal(await field.count(), 1);
  assert.equal((await deepFocus(page)).inDialog, true, "focus is in the palette's field");
  await page.keyboard.type("timed-out");
  const results = dialog.getByRole("listbox");
  const slice = results.getByRole("option", { name: new RegExp(SLICE) });
  await slice.waitFor();
  assert.match(await slice.innerText(), /Slice/, "a result shows its kind");
  assert.match(await slice.innerText(), /Claude on build-2/, "a slice result shows its holder");
  await page.keyboard.press("ArrowDown");
  const active = await page.evaluate(() => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element.getAttribute("aria-activedescendant");
  });
  assert.ok(active, "the field points at the active result");
  const preview = await dialog.evaluate((element) => {
    const listbox = element.querySelector('[role="listbox"]') ?? element.querySelector("prism-listbox");
    const outside = [...element.querySelectorAll("*")].filter((node) => !listbox.contains(node) && node.childElementCount === 0 && node.textContent.trim());
    return outside.map((node) => node.textContent.trim()).join(" | ");
  });
  assert.match(preview, new RegExp(SLICE), "the preview names the active result");
  assert.match(preview, /Claude on build-2/, "the preview of a slice names its holder");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Command palette" }).count(), 0);
  assert.deepEqual(await deepFocus(page), before, "focus returns where it was");
  await page.keyboard.press("Meta+k");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.keyboard.type("roadmap");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("option").first().waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await waitForView(page);
  assert.equal(await page.getByRole("dialog", { name: "Command palette" }).count(), 0, "Enter opens the result and closes the palette");
  assert.equal(await shownPage(page), "roadmap");
  const narrow = await openPage(page.context().browser(), page.url(), { viewport: { width: 390, height: 800 } });
  await waitForView(narrow);
  await narrow.keyboard.press("Control+k");
  await narrow.getByRole("dialog", { name: "Command palette" }).waitFor();
  assert.deepEqual(await escapes(narrow, "body"), [], "the palette fits 390px");
});

test("clauses 66, 67, 68: the sidebar and Who's working show every claim read-only, live ones breathing in the top bar", { skip }, async (context) => {
  const { page } = await open(context, "slice:retry-hardening/timeout-retries");
  const sidebar = page.locator("#sidebar");
  const row = sidebar.getByRole("treeitem", { name: new RegExp(SLICE) });
  assert.equal(await row.locator("prism-claim").count(), 1, "the claimed slice's tree item ends with its claim");
  assert.equal(await row.locator("prism-claim").getAttribute("variant"), "avatar");
  const who = page.locator("header").getByRole("button", { name: /1 working/ });
  assert.equal(await who.count(), 1, "the top bar counts the live claims");
  const stack = await who.evaluate((button) => {
    const deep = (root) => [...root.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...deep(node.shadowRoot)] : [node]);
    return deep(button.closest("prism-button") ?? button).concat(deep(button)).filter((node) => node.tagName.toLowerCase() === "prism-avatar").map((avatar) => ({ live: avatar.hasAttribute("live"), breathing: avatar.hasAttribute("breathing") }));
  });
  assert.ok(stack.length >= 1 && stack.length <= 3, "the button shows up to three avatars");
  assert.ok(stack.every((avatar) => avatar.live && avatar.breathing), "the top bar's avatars are live and breathing");
  await who.click();
  const popover = page.getByRole("dialog", { name: "Who's working" });
  await popover.waitFor();
  const text = await popover.innerText();
  assert.match(text, /Claude on build-2[\s\S]*Agent[\s\S]*implementation[\s\S]*Retry timed-out requests until a total deadline[\s\S]*min left/, "the popover lists the live claim");
  assert.match(text, /Codex on ci[\s\S]*Expired 4 min ago/, "the popover lists the expired claim");
  assert.ok(text.indexOf("Claude on build-2") < text.indexOf("Codex on ci"), "live claims come before expired ones");
  const offered = await page.evaluate(() => {
    const deep = (root) => [...root.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...deep(node.shadowRoot)] : [node]);
    return deep(document).filter((node) => ["button", "link", "menuitem"].includes(node.getAttribute("role")) || ["BUTTON", "A"].includes(node.tagName)).map((node) => (node.getAttribute("aria-label") ?? node.textContent).trim()).filter((name) => /^(take|release|renew|remind|follow|claim)\b/i.test(name));
  });
  assert.deepEqual(offered, [], "nothing offers a claim action");
  const breathing = await page.evaluate(() => [...document.querySelectorAll("prism-avatar[breathing]")].filter((avatar) => !avatar.closest("header") && !avatar.closest("prism-claim[variant=strip]")).length);
  assert.equal(breathing, 0, "only the top bar and the claim strip breathe");
  await page.keyboard.press("Escape");
  const still = await openPage(page.context().browser(), page.url(), { reducedMotion: "reduce" });
  await waitForView(still);
  assert.deepEqual(await movingElements(still, "header"), [], "under reduced motion the top bar's live dots stand still");
});

test("clauses 20, 21, 22: the shell's text and fields reach WCAG AA, glass overlays included, and its surfaces follow the theme", { skip, timeout: 180000 }, async (context) => {
  const { base, browser } = await claimed(context);
  const painted = {};
  for (const theme of ["light", "dark"]) {
    await choose(base, { theme });
    const page = await openPage(browser, reviewUrl(base, "attention"));
    await waitForView(page);
    assert.deepEqual(await contrastFailures(page, SHELL), [], `shell text, ${theme}`);
    assert.deepEqual(await boundaryFailures(page, SHELL), [], `shell fields, ${theme}`);
    painted[theme] = await paintedBackgrounds(page, SHELL);
    await page.locator("header").getByRole("button", { name: /working/ }).click();
    await page.getByRole("dialog", { name: "Who's working" }).waitFor();
    assert.deepEqual(await contrastFailures(page, "body"), [], `Who's working over the page, ${theme}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor();
    await page.keyboard.type("retry");
    await page.waitForTimeout(400);
    assert.deepEqual(await contrastFailures(page, "body"), [], `the palette over the page, ${theme}`);
    assert.deepEqual(await boundaryFailures(page, "body"), [], `the palette's field on glass, ${theme}`);
    await page.context().close();
  }
  const same = Object.entries(painted.light).filter(([element, color]) => painted.dark[element] === color).map(([element]) => element);
  assert.deepEqual(same, [], "no shell surface keeps its color in both themes");
});

test("clause 69: the shell names Prism's records by title and kind, never by file name or path", { skip, timeout: 180000 }, async (context) => {
  const { base, browser } = await claimed(context);
  for (const ref of ["attention", "roadmap", "slice:retry-hardening/timeout-retries", "docs/plans/retry-hardening/timeout-retries/timeout-retries.puml", "src/retry/strategy.ts"]) {
    const page = await openPage(browser, reviewUrl(base, ref));
    await waitForView(page);
    assert.deepEqual(await stateFileNames(page, SHELL), [], `the shell on ${ref}`);
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor();
    await page.keyboard.type("retry");
    await page.waitForTimeout(500);
    assert.deepEqual(await stateFileNames(page, '[role="dialog"]'), [], `the palette on ${ref}, its Files group aside`);
    await page.context().close();
  }
});

test("clauses 36, 77, 78: with long names the shell stays inside a phone and a laptop window, and its menus, popovers, and dialogs stay inside the window", { skip, timeout: 180000 }, async (context) => {
  const { base, browser } = await claimed(context, "seed-stress.mjs");
  for (const viewport of [{ width: 360, height: 740 }, { width: 1280, height: 800 }]) {
    const page = await openPage(browser, reviewUrl(base, "attention"), { viewport });
    await waitForView(page);
    assert.deepEqual(await escapes(page, SHELL), [], `shell at ${viewport.width}px`);
    await page.locator("header [aria-haspopup=menu]").first().click();
    const menu = await page.evaluate(() => {
      const deep = (root) => [...root.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...deep(node.shadowRoot)] : [node]);
      const found = deep(document).find((node) => node.getAttribute("role") === "menu" && node.getClientRects().length);
      const box = found?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight } : null;
    });
    assert.ok(menu, "the project menu opens");
    assert.ok(menu.left >= 0 && menu.right <= menu.width && menu.top >= 0 && menu.bottom <= menu.height, `the project menu stays inside ${viewport.width}px`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor();
    await page.keyboard.type("slice");
    await page.waitForTimeout(600);
    assert.deepEqual(await escapes(page, "body"), [], `the palette at ${viewport.width}px`);
    await page.context().close();
  }
});
