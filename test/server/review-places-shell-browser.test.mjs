import assert from "node:assert/strict";
import test from "node:test";
import { escapes, shownTooltip, skip, stateFileNames, waitForView } from "./fixtures/kit-browser.mjs";
import { pause, settled } from "./fixtures/wait.mjs";
import { buttonNames, choosePlace, comparePlaces, drawer, item, open, placeButton, PLACES, placesDemo, placeTitle, rail, reviewUrl, row as rowOf, settledOn, shownPlace, shownRef, sidebar, SLICE, tabs } from "./fixtures/places-browser.mjs";

// The rail of places and the sidebar that shows only the current place, on the real review page over the demo project.
// The demo records three questions that wait for an answer: two on Harden request retries and one on Export activity reports.

const pressed = async (page) => {
  const snapshot = await rail(page).ariaSnapshot();
  return [...snapshot.matchAll(/- button "([^"]*)" \[pressed\]/g)].map((match) => match[1]);
};
// Headless Chromium under load now and then drops the window a Shift or middle click on a link opens, on a bare page with a bare link too,
// while the page leaves the click to the browser; so the gesture is repeated until a window opens, and a page that took the click itself fails every time.
async function openedByClick(page, anchor, click, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    const opened = page.context().waitForEvent("page", { timeout: 5000 });
    await anchor.click(click);
    try {
      return await opened;
    } catch (error) {
      if (attempt === attempts) throw error;
    }
  }
}
const bell = (page) => page.locator("header").getByRole("button", { name: /^Attention/ });
const sidebarButton = (scope) => scope.getByRole("button", { name: /^(Hide the sidebar|Keep the sidebar open)$/ });

test("clauses 1, 2, 3, 4, 5, 6: a wide window shows a borderless rail of the five places with Attention's question count, no bell, and the button that hides the sidebar at the end of the sidebar's head", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  await rail(page).waitFor();
  const names = await buttonNames(rail(page));
  assert.deepEqual(names.map((name) => name.split(",")[0]), PLACES, "the rail holds the five places in order and nothing else");
  assert.equal(names[0], "Attention, 3 questions", "the Attention button is named with the question count");
  assert.equal(await sidebarButton(rail(page)).count(), 0, "the sidebar button left the rail");
  assert.equal(await sidebarButton(sidebar(page)).filter({ visible: true }).count(), 1, "the sidebar's head holds the button that hides it");
  assert.equal(await rail(page).getByText("3", { exact: true }).isVisible(), true, "the badge shows the count");
  assert.deepEqual(await pressed(page), ["Attention, 3 questions"], "the current place is pressed");
  const box = await rail(page).boundingBox();
  const sidebarBox = await sidebar(page).boundingBox();
  assert.ok(box.x <= 1 && box.x + box.width <= sidebarBox.x + 1, "the rail sits at the left edge, left of the sidebar");
  const style = await rail(page).evaluate((nav) => {
    const host = nav.getRootNode().host ?? nav;
    const read = getComputedStyle(nav);
    return { border: ["Top", "Right", "Bottom", "Left"].map((side) => parseFloat(read[`border${side}Width`])).reduce((sum, value) => sum + value, 0), background: read.backgroundColor, hostBorder: parseFloat(getComputedStyle(host).borderRightWidth) };
  });
  assert.equal(style.border + style.hostBorder, 0, "the rail draws no border");
  assert.equal(await bell(page).filter({ visible: true }).count(), 0, "the top bar shows no Attention bell");
  assert.equal(await sidebarButton(page.locator("header")).filter({ visible: true }).count(), 0, "the sidebar button left the top bar");
  await placeButton(page, "Work").hover();
  assert.equal(await settled(() => shownTooltip(page), "Work"), "Work", "hovering names the place");
  await placeButton(page, "Knowledge").focus();
  assert.equal(await settled(() => shownTooltip(page), "Knowledge"), "Knowledge", "keyboard focus names the place");
  for (const [name, subtitle] of [["Work", "Designed and not shipped"], ["Knowledge", "Requirements, decisions, glossary"], ["History", "Shipped and superseded"], ["Attention", "What waits on you"]]) {
    await choosePlace(page, name);
    assert.deepEqual((await pressed(page)).map((label) => label.split(",")[0]), [name], `${name} is pressed`);
    assert.equal((await placeTitle(sidebar(page)).innerText()).trim(), name, `the sidebar's head names ${name}`);
    assert.equal(await sidebar(page).getByText(subtitle, { exact: true }).count(), 0, `the head shows no subtitle line for ${name}`);
    await placeTitle(sidebar(page)).hover();
    assert.equal(await settled(() => shownTooltip(page), `${name}: ${subtitle}`), `${name}: ${subtitle}`, `hovering the title says what ${name} holds`);
    await page.mouse.move(0, 0);
  }
  await choosePlace(page, "Work");
  assert.equal(await item(sidebar(page), "Harden request retries").isVisible(), true, "Work lists the initiatives being worked on");
  assert.equal(await sidebar(page).getByRole("treeitem", { name: /^Requirements/ }).count(), 0, "Work shows nothing of Knowledge");
  await choosePlace(page, "Knowledge");
  assert.equal(await item(sidebar(page), "Requirements").isVisible(), true, "Knowledge leads to the requirements");
  assert.equal(await sidebar(page).getByRole("treeitem", { name: /^Harden request retries/ }).count(), 0, "Knowledge shows nothing of Work");
  assert.deepEqual(page.errors, []);
});

// The place head lines up with the tab strip beside it, and the rail starts below the top bar.
async function headGeometry(page) {
  const box = async (locator) => {
    const value = await locator.boundingBox();
    assert.ok(value, `${locator} is laid out`);
    return { ...value, bottom: value.y + value.height, middle: value.y + value.height / 2 };
  };
  const nav = rail(page);
  return {
    strip: await box(page.locator("#open-tabs")),
    tab: await box(page.locator("#open-tabs prism-doc-tab[selected]").first()),
    bar: await box(page.locator("#page-bar")),
    trail: await box(page.locator("#page-bar").getByRole("navigation").first()),
    button: await box(sidebarButton(sidebar(page))),
    firstPlace: await box(placeButton(page, "Attention")),
    sidebar: await box(sidebar(page)),
    nav,
    title: await box(placeTitle(sidebar(page)))
  };
}

test("clauses 2, 6: the place head is one line level with the selected tab, with the title first and the button that hides the sidebar at its end, and the rail has no head block", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  for (const place of ["Attention", "Work"]) {
    const page = await open(browser, base, SLICE);
    await choosePlace(page, place);
    const at = await headGeometry(page);
    assert.equal(await at.nav.getByRole("separator").count(), 0, "the rail draws no separator");
    assert.ok(at.firstPlace.y < at.tab.bottom, `the places start level with the tab strip: ${at.firstPlace.y} and ${at.tab.bottom}`);
    assert.ok(Math.abs(at.title.middle - at.tab.middle) <= 2, `the place title is on the tab row: ${at.title.middle} and ${at.tab.middle}`);
    assert.ok(Math.abs(at.button.middle - at.title.middle) <= 2, `the button is on the title's line: ${at.button.middle} and ${at.title.middle}`);
    assert.ok(at.button.x > at.title.x + at.title.width - 1, "the button follows the title");
    assert.ok(at.sidebar.x + at.sidebar.width - (at.button.x + at.button.width) <= 16, "the button stands at the head's end");
    assert.deepEqual(page.errors, []);
    await page.close();
  }
});

test("clauses 7, 8, 9: only Roadmap opens a page, and the place stays while tabs, links, the palette, and Back change the page", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Roadmap");
  await settledOn(page, "roadmap");
  assert.equal((await placeTitle(sidebar(page)).innerText()).trim(), "Roadmap");
  await choosePlace(page, "Work");
  assert.equal(await shownRef(page), "roadmap", "choosing Work leaves the open page");
  await choosePlace(page, "Work");
  assert.equal(await sidebar(page).isVisible(), true, "choosing the current place keeps the sidebar shown");
  assert.equal((await placeTitle(sidebar(page)).innerText()).trim(), "Work");
  await page.locator("#artifact a[data-artifact^='initiative:']").first().click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("artifact")?.startsWith("initiative:"));
  await choosePlace(page, "Knowledge");
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.keyboard.type("Retry timed-out");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("option").first().waitFor();
  await page.keyboard.press("Enter");
  await settledOn(page, SLICE);
  assert.equal((await placeTitle(sidebar(page)).innerText()).trim(), "Knowledge", "the palette's page did not move the sidebar");
  assert.equal(await sidebar(page).getByRole("treeitem", { selected: true }).count(), 0, "Knowledge does not list the slice, so it marks nothing");
  await page.getByRole("tab", { name: /^Roadmap/ }).click().catch(() => {});
  await page.goBack();
  assert.equal(await settled(async () => (await placeTitle(sidebar(page)).innerText()).trim(), "Knowledge"), "Knowledge", "Back kept the place");
  await choosePlace(page, "Work");
  await page.goto(reviewUrl(base, SLICE));
  await settledOn(page, SLICE);
  assert.equal(await item(sidebar(page), "Retry timed-out requests").getAttribute("aria-selected"), "true", "Work lists the open slice and marks it");
  assert.deepEqual(page.errors, []);
});

test("clauses 10, 11: the place survives a reload and a new window, falls back to Attention, and a place= address chooses and stores one", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "roadmap");
  assert.equal(await shownPlace(page), "Attention", "a browser that stored no place shows Attention");
  await choosePlace(page, "Knowledge");
  await page.reload();
  assert.equal(await shownPlace(page), "Knowledge", "a reload keeps the place");
  const second = await page.context().newPage();
  await second.goto(reviewUrl(base, "attention"));
  assert.equal(await shownPlace(second), "Knowledge", "another window of the same browser shows the stored place");
  await second.close();
  await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (localStorage.getItem(key) === "knowledge") localStorage.setItem(key, "lobby");
    }
  });
  await page.reload();
  assert.equal(await shownPlace(page), "Attention", "a stored value that is not a place falls back to Attention");
  await page.goto(`${reviewUrl(base, "roadmap")}&place=history`);
  assert.equal(await shownPlace(page), "History", "place=history chooses History");
  await page.goto(reviewUrl(base, "roadmap"));
  assert.equal(await shownPlace(page), "History", "and stores it");
  await page.goto(`${reviewUrl(base, "roadmap")}&place=lobby`);
  assert.equal(await shownPlace(page), "History", "an unknown place= value is ignored");
  assert.deepEqual(page.errors, []);
});

test("clauses 12, 13: no place shows a disabled or planned entry, an internal word, or a Prism file name", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, SLICE);
  for (const name of PLACES) {
    await choosePlace(page, name);
    const scope = "nav[aria-label='Places'], #sidebar";
    const found = await page.evaluate((selector) => {
      const out = [];
      const walk = (root) => {
        for (const node of root.querySelectorAll("*")) {
          if (node.matches("[disabled], [aria-disabled='true']")) out.push(`disabled ${node.tagName}`);
          if (node.shadowRoot) walk(node.shadowRoot);
        }
      };
      for (const holder of document.querySelectorAll(selector)) {
        walk(holder);
        if (/\bPlanned\b/.test(holder.innerText)) out.push("Planned");
        if (/\bconcepts?\b/i.test(holder.innerText)) out.push("concept");
      }
      return out;
    }, scope);
    assert.deepEqual(found, [], `${name} shows no disabled, planned, or internal entry`);
    assert.deepEqual(await stateFileNames(page, scope), [], `${name} names no Prism file`);
  }
  assert.deepEqual(page.errors, []);
});

test("clauses 14, 15, 16: [ and the head's button hide the sidebar and keep the rail, the choice survives a reload, and a place chosen on the rail opens over the page until a page, Escape, or a click outside hides it", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Work");
  await page.locator("body").click({ position: { x: 700, y: 400 } }).catch(() => {});
  await page.keyboard.press("[");
  assert.equal(await settled(() => sidebar(page).isVisible(), false), false, "[ hid the sidebar");
  assert.equal(await rail(page).isVisible(), true, "the rail stays");
  const mainLeft = async () => (await page.locator("#main").boundingBox()).x;
  const hiddenLeft = await mainLeft();
  await page.reload();
  assert.equal(await shownPlace(page), "Work", "the reload kept the place");
  assert.equal(await sidebar(page).isVisible(), false, "the hidden sidebar stays hidden after a reload");
  await choosePlace(page, "Knowledge");
  assert.equal(await settled(() => sidebar(page).isVisible(), true), true, "choosing a place on the rail opens its sidebar");
  assert.equal((await placeTitle(sidebar(page)).innerText()).trim(), "Knowledge");
  assert.equal(await mainLeft(), hiddenLeft, "the sidebar opens over the page without moving it");
  const keep = sidebarButton(sidebar(page));
  assert.equal(await sidebar(page).getByRole("button", { name: "Keep the sidebar open", expanded: true }).count(), 1, "its button offers to keep it open");
  await keep.hover();
  assert.match(await settled(async () => await shownTooltip(page) ?? "", (tip) => /\(\[\)$/.test(tip)), /\(\[\)$/, "the tooltip names the key");
  await page.keyboard.press("Escape");
  assert.equal(await settled(() => sidebar(page).isVisible(), false), false, "Escape hides it again");
  await choosePlace(page, "Knowledge");
  await page.locator("#main").click({ position: { x: 600, y: 300 } });
  assert.equal(await settled(() => sidebar(page).isVisible(), false), false, "a click outside hides it again");
  await choosePlace(page, "Knowledge");
  await item(sidebar(page), "Decisions").click();
  await settledOn(page, "decisions");
  assert.equal(await settled(() => sidebar(page).isVisible(), false), false, "choosing a page hides it again");
  await page.reload();
  assert.equal(await shownPlace(page), "Knowledge", "the reload kept the place");
  assert.equal(await sidebar(page).isVisible(), false, "and the sidebar still hidden");
  await choosePlace(page, "Knowledge");
  await sidebarButton(sidebar(page)).click();
  assert.ok(await settled(mainLeft, (left) => left > hiddenLeft) > hiddenLeft, "keeping it open gives the sidebar its column back");
  assert.equal(await sidebar(page).getByRole("button", { name: "Hide the sidebar", expanded: true }).count(), 1, "and the button hides it again");
  await page.reload();
  await waitForView(page);
  assert.equal(await sidebar(page).isVisible(), true, "the shown sidebar is stored");
  await sidebarButton(sidebar(page)).click();
  assert.equal(await settled(() => sidebar(page).isVisible(), false), false, "the head's button hides it");
  await page.keyboard.press("[");
  assert.equal(await settled(() => sidebar(page).isVisible(), true), true, "and [ shows it again");
  await page.setViewportSize({ width: 900, height: 900 });
  await rail(page).waitFor({ state: "hidden" });
  await page.keyboard.press("[");
  await pause(300, "a key that should change nothing leaves no state to wait for");
  await page.setViewportSize({ width: 1440, height: 900 });
  await rail(page).waitFor();
  assert.equal(await settled(() => sidebar(page).isVisible(), true), true, "[ on a narrow window changed nothing");
  assert.deepEqual(page.errors, []);
});

test("clause 17: a sidebar entry is a link: Shift and middle click open the browser, Ctrl-click keeps a tab, a click previews, and a double click keeps", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, "attention");
  await choosePlace(page, "Work");
  const row = item(sidebar(page), "Export activity reports");
  const href = await row.evaluate((node) => node.querySelector(":scope > a")?.getAttribute("href"));
  assert.equal(new URL(href, base + "/").searchParams.get("artifact"), "initiative:activity-reports", "the row's anchor carries the page's address");
  for (const [label, click] of [["Shift click", { modifiers: ["Shift"] }], ["middle click", { button: "middle" }]]) {
    const other = await openedByClick(page, row.locator(":scope > a"), click);
    await other.waitForURL(/[?&]artifact=/, { timeout: 15000 });
    assert.equal(new URL(other.url()).searchParams.get("artifact"), "initiative:activity-reports", `a ${label} opened the address in the browser`);
    await other.close();
    assert.equal(await shownRef(page), "attention", `a ${label} left this page`);
  }
  await row.click({ modifiers: ["Control"] });
  await settledOn(page, "initiative:activity-reports");
  assert.deepEqual(await tabs(page), ["attention(p)", "initiative:activity-reports*"], "Ctrl-click opened a kept tab");
  await rowOf(sidebar(page), "Harden request retries").click();
  await settledOn(page, "initiative:retry-hardening");
  assert.ok((await tabs(page)).includes("initiative:retry-hardening*(p)"), "a click opened the preview tab");
  await rowOf(sidebar(page), "Harden request retries").dblclick();
  assert.ok((await settled(() => tabs(page), (shown) => shown.includes("initiative:retry-hardening*"))).includes("initiative:retry-hardening*"), "a double click kept it");
  assert.deepEqual(page.errors, []);
});

test("clauses 18, 19, 20, 21: each page names its place, the trail starts with it, and the crumb chooses the place without leaving the page", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const contextOf = async (ref) => (await fetch(`${base}/api/context?ref=${encodeURIComponent(ref)}`)).json();
  const expected = {
    attention: "attention", "attention:questions": "attention", roadmap: "roadmap", ".prism/roadmap.json": "roadmap",
    "initiative:retry-hardening": "work", [SLICE]: "work", "docs/plans/retry-hardening/timeout-retries/timeout-retries.puml": "work", "docs/plans/retry-hardening/timeout-retries/slice.md": "work",
    "initiative:audit-log": "history", "initiative:csv-exports": "history", "initiative:search-indexing": "roadmap",
    requirements: "knowledge", decisions: "knowledge", glossary: "knowledge", "knowledge:touched": "knowledge", "docs/requirements/retries.md": "knowledge", "docs/ADRs/retries/total-retry-deadline.md": "knowledge", "docs/Glossary.md": "knowledge",
    "src/retry/strategy.ts": null
  };
  for (const [ref, place] of Object.entries(expected)) assert.equal((await contextOf(ref)).place, place, `${ref} belongs to ${place}`);
  const labels = async (ref) => (await contextOf(ref)).trail.map((crumb) => crumb.label);
  assert.deepEqual(await labels(SLICE), ["Work", "Harden request retries", "Retry timed-out requests until a total deadline"]);
  assert.deepEqual(await labels("docs/requirements/retries.md"), ["Knowledge", "Requirements", "Retry requirements"]);
  assert.deepEqual(await labels("initiative:audit-log"), ["History", "Audit administrative actions"]);
  assert.deepEqual(await labels("initiative:search-indexing"), ["Roadmap", "Index activity for search"]);
  assert.deepEqual(await labels("attention"), ["Attention"]);
  assert.deepEqual(await labels("roadmap"), ["Roadmap"]);
  assert.deepEqual(await labels("src/retry/strategy.ts"), ["Files", "src/retry/strategy.ts"]);
  assert.equal((await contextOf(SLICE)).trail[0].place, "work", "the first crumb carries its place");
  const page = await open(browser, base, "attention");
  await page.goto(reviewUrl(base, SLICE));
  await settledOn(page, SLICE);
  assert.equal((await placeTitle(sidebar(page)).innerText()).trim(), "Attention");
  const crumb = page.locator("#page-bar").getByRole("link", { name: "Work", exact: true });
  const address = new URL(await crumb.getAttribute("href"), `${base}/`);
  assert.equal(address.searchParams.get("artifact"), SLICE);
  assert.equal(address.searchParams.get("place"), "work");
  await crumb.click();
  assert.equal(await settled(async () => (await placeTitle(sidebar(page)).innerText()).trim(), "Work"), "Work", "the crumb chose Work");
  assert.equal(await shownRef(page), SLICE, "and kept the page");
  assert.deepEqual(page.errors, []);
});

test("clauses 22, 23, 24, 25: a narrow window hides the rail, keeps the bell, and opens rail and place together in the drawer", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context);
  const page = await open(browser, base, SLICE, { width: 820 });
  assert.equal(await rail(page).filter({ visible: true }).count(), 0, "the rail is hidden");
  assert.equal(await sidebar(page).isVisible(), false, "the sidebar is hidden");
  assert.equal(await bell(page).isVisible(), true, "the bell is in the top bar");
  assert.match(await bell(page).innerText(), /\b3\b/, "the bell shows the question count");
  await page.locator("header").getByRole("button", { name: "Navigation" }).click();
  const panel = drawer(page);
  await panel.waitFor();
  assert.equal(await rail(panel).isVisible(), true, "the drawer holds the rail");
  assert.equal(await sidebarButton(panel).filter({ visible: true }).count(), 0, "the drawer offers no button to hide the sidebar");
  assert.equal(await rail(panel).getByRole("separator").count(), 0, "nor a head block on its rail");
  assert.equal((await buttonNames(rail(panel)))[0].split(",")[0], "Attention", "it starts with the places");
  const railBox = await rail(panel).boundingBox();
  const head = placeTitle(panel);
  assert.ok((await head.boundingBox()).x > railBox.x + railBox.width - 1, "the place's sidebar sits right of the rail");
  const focused = await page.evaluate(() => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    const host = element?.getRootNode?.().host ?? element;
    return Boolean(host?.closest?.("#nav-drawer") || document.getElementById("nav-drawer")?.contains(host));
  });
  assert.equal(focused, true, "focus moved into the drawer");
  await choosePlace(panel, "Knowledge");
  assert.equal(await panel.isVisible(), true, "choosing a place keeps the drawer open");
  assert.equal((await placeTitle(panel).innerText()).trim(), "Knowledge");
  await item(panel, "Decisions").click();
  await settledOn(page, "decisions");
  assert.equal(await settled(() => panel.isVisible(), false), false, "choosing a page closed the drawer");
  await page.locator("header").getByRole("button", { name: "Navigation" }).click();
  await drawer(page).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await settled(() => drawer(page).isVisible(), false), false, "widening closed the drawer");
  assert.equal(await settled(() => rail(page).isVisible(), true), true, "the rail is back");
  assert.equal((await placeTitle(sidebar(page)).innerText()).trim(), "Knowledge", "with the sidebar of the place chosen in the drawer");
  await page.setViewportSize({ width: 820, height: 900 });
  await bell(page).click();
  await settledOn(page, "attention");
  assert.deepEqual(page.errors, []);
});

test("clauses 26, 65: the rail, the drawer, and every place stay inside the window at three widths with long names, and the kit catalog shows the new elements", { skip, timeout: 240000 }, async (context) => {
  for (const seed of ["seed.mjs", "seed-stress.mjs"]) {
    const { base, browser } = await placesDemo(context, { seed });
    for (const width of [390, 820, 1440]) {
      const page = await open(browser, base, "attention", { width });
      for (const name of PLACES) {
        if (width <= 1100) {
          await page.locator("header").getByRole("button", { name: "Navigation" }).click();
          await drawer(page).waitFor();
          await choosePlace(drawer(page), name);
        } else {
          await choosePlace(page, name);
        }
        assert.deepEqual(await escapes(page), [], `${seed} at ${width}px in ${name}`);
        if (width <= 1100) {
          await page.keyboard.press("Escape");
          await drawer(page).waitFor({ state: "hidden" });
        }
      }
      assert.deepEqual(page.errors, []);
      await page.context().close();
    }
  }
  const { base, browser } = await placesDemo(context);
  const catalog = await open(browser, base, "attention");
  await catalog.goto(`${base}/kit/catalog`);
  await catalog.waitForLoadState("load");
  for (const tag of ["prism-rail", "prism-rail-item", "prism-place-head"]) assert.equal(await catalog.locator(`[data-catalog-entry="${tag}"]`).count(), 1, `the catalog shows ${tag}`);
});

test("clauses 2, 3, 5, 6, 20, 23, 73: the rail, the place heads, the top bar, the trail, the geometry, and the design values match the mockup at three widths, and in their colors in the dark theme", { skip, timeout: 1200000 }, async (context) => {
  const result = await comparePlaces(context, { scenes: "work,attention,history,roadmap,collapsed,drawer-tablet,drawer-phone", parts: "rail,head,topbar,trail,geometry,tokens" });
  assert.equal(result.status, 0, `the comparison found differences:\n${result.stdout}${result.stderr}`);
  assert.ok(result.report.pairs.length >= 22, "every scene ran at its widths in the light theme, and at 1440 pixels in the dark theme");
  for (const pair of result.report.pairs) assert.deepEqual(pair.differences, [], `${pair.scene} ${pair.width} ${pair.theme}`);
});
