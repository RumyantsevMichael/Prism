import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, shownTooltip, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// The strip of open documents at the top of the main island, run on the real review page over the demo project:
// the one preview tab, kept tabs, where a new tab goes, closing, missing targets, agent-presented tabs, the session every window shares, the history, keys, and a phone width.

const SLICE = "slice:retry-hardening/timeout-retries";

// The review server module reads its data folder when it loads, so the fixtures' own loader starts it; the server itself is kept here so a test can present artifacts as an agent does.
async function demo(context) {
  await useAppDirectory(context);
  const root = await demoProject(context);
  if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = path.join(path.dirname(root), "data");
  const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
  const review = await startReviewServer({ projectRoot: root, openBrowser: async () => false });
  context.after(() => review.close());
  return { root, review, base: review.baseUrl.replace(/\/$/, ""), browser: await launch(context) };
}

const strip = (page) => page.getByRole("tablist", { name: "Open artifacts" });
// Each tab as its page, with * when selected, (p) for the preview, (a) for an agent tab, and (m) for a missing target.
const tabs = (page) => page.evaluate(() => [...document.querySelectorAll("#open-tabs prism-doc-tab")].map((tab) => `${tab.getAttribute("value")}${tab.hasAttribute("selected") ? "*" : ""}${tab.hasAttribute("preview") ? "(p)" : ""}${tab.hasAttribute("agent") ? "(a)" : ""}${tab.hasAttribute("missing") ? "(m)" : ""}`));
const tab = (page, ref) => page.locator(`#open-tabs prism-doc-tab[value="${ref}"]`);
const shownPage = (page) => page.evaluate(() => new URL(location.href).searchParams.get("artifact"));
const session = async (base) => (await fetch(`${base}/api/session`)).json();
const sidebarItem = (page, name) => page.locator("#sidebar").getByRole("treeitem", { name: new RegExp(`^${name}`) });
// Each entry sits in its place's sidebar, so the place is chosen on the rail first, with the same keys, since choosing Roadmap opens its page as its entry would.
async function openFromSidebar(page, name, options = {}) {
  const place = page.getByRole("navigation", { name: "Places" }).getByRole("button", { name: new RegExp(`^${name === "Roadmap" ? "Roadmap" : "Knowledge"}`) });
  if ((await place.getAttribute("aria-pressed")) !== "true") await place.click(options);
  await sidebarItem(page, name).click(options);
}
const textStyle = (page, ref) => tab(page, ref).evaluate((host) => {
  const style = getComputedStyle(host.shadowRoot.querySelector(".text"));
  return { italic: style.fontStyle === "italic", struck: style.textDecorationLine.includes("line-through"), color: style.color };
});
const deepFocus = (page) => page.evaluate(() => {
  let element = document.activeElement;
  const host = element?.tagName === "PRISM-DOC-TAB" ? element.getAttribute("value") : null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return { host, role: element?.getAttribute("role") ?? null, name: element?.getAttribute("aria-label") ?? element?.textContent?.trim() ?? null };
});
// Waits until the page settles on `ref` and the server's session agrees, since a tab change is saved after it shows.
async function settled(page, base, ref) {
  await page.waitForFunction((ref) => new URL(location.href).searchParams.get("artifact") === ref && document.querySelector("#artifact")?.getAttribute("aria-busy") === "false", ref, { timeout: 10000 });
  for (let tries = 0; tries < 40 && (await session(base)).activeTab !== ref; tries += 1) await page.waitForTimeout(100);
  await page.waitForTimeout(150);
}

test("a link opens in the one italic preview tab that the next link replaces, and Ctrl-click, a double click, and Keep keep a tab", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await demo(context);
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  assert.equal(await strip(page).isVisible(), true, "the strip of open documents shows at the top of the main island");
  assert.deepEqual(await tabs(page), ["attention*(p)"]);
  await openFromSidebar(page, "Roadmap");
  await settled(page, base, "roadmap");
  await openFromSidebar(page, "Requirements");
  await settled(page, base, "requirements");
  assert.deepEqual(await tabs(page), ["requirements*(p)"], "each ordinary open replaced the preview tab");
  assert.equal((await textStyle(page, "requirements")).italic, true, "the preview tab's title is italic");
  await openFromSidebar(page, "Decisions", { modifiers: ["Control"] });
  await settled(page, base, "decisions");
  assert.deepEqual(await tabs(page), ["requirements(p)", "decisions*"], "Ctrl-click opened a kept tab beside the preview");
  assert.equal((await textStyle(page, "decisions")).italic, false, "a kept tab's title is upright");
  await page.getByRole("tab", { name: /^Requirements/ }).dblclick();
  await settled(page, base, "requirements");
  assert.deepEqual(await tabs(page), ["requirements*", "decisions"], "a double click on the preview tab kept it");
  await openFromSidebar(page, "Glossary");
  await settled(page, base, "glossary");
  assert.deepEqual(await tabs(page), ["requirements", "glossary*(p)", "decisions"], "a new tab goes right after the selected tab, not at the end");
  await strip(page).getByRole("button", { name: "Keep", exact: true }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(await tabs(page), ["requirements", "glossary*", "decisions"], "Keep kept the preview tab");
  assert.equal((await session(base)).previewTab, null, "the kept tab is saved in the session");
  assert.deepEqual(page.errors, []);
});

test("Ctrl+Enter in the palette, a double or middle click on a content link, a Ctrl-click on a crumb, and Open as tab open kept tabs", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await demo(context);
  const page = await openPage(browser, reviewUrl(base, "roadmap"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  const link = page.locator("#artifact a.title-link[data-artifact]").first();
  const first = await link.getAttribute("data-artifact");
  await link.click({ button: "middle" });
  await settled(page, base, first);
  assert.deepEqual(await tabs(page), ["roadmap(p)", `${first}*`], "a middle click on a content link opened a kept tab");
  await page.getByRole("tab", { name: /^Roadmap/ }).click();
  await settled(page, base, "roadmap");
  const second = page.locator("#artifact a.title-link[data-artifact]").nth(1);
  const secondRef = await second.getAttribute("data-artifact");
  // A real double click also sends its first click, which previews the link first; the double click alone keeps it.
  await second.dispatchEvent("dblclick");
  await settled(page, base, secondRef);
  assert.deepEqual(await tabs(page), ["roadmap(p)", `${secondRef}*`, first], "a double click on a content link kept its tab after the selected one");
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.keyboard.type("Decisions");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("option").first().waitFor();
  await page.keyboard.press("Control+Enter");
  await settled(page, base, "decisions");
  assert.deepEqual(await tabs(page), ["roadmap(p)", secondRef, "decisions*", first], "Ctrl+Enter in the palette opened a kept tab");
  await page.goto(reviewUrl(base, SLICE));
  await waitForView(page);
  // The trail starts with the slice's place, whose crumb chooses the place, so the initiative's crumb is the one that leads to a page.
  await page.locator("#page-bar").getByRole("link", { name: "Harden request retries" }).click({ modifiers: ["Control"] });
  await settled(page, base, "initiative:retry-hardening");
  assert.equal((await tabs(page)).includes(`${SLICE}(p)`), true, "a Ctrl-click on a crumb kept the slice's preview tab beside the crumb's page");
  await page.getByRole("tab", { name: /^Retry timed-out/ }).click();
  await settled(page, base, SLICE);
  await page.locator("#page-bar").getByRole("button", { name: "Side panel" }).click();
  await page.getByRole("button", { name: "Open as tab" }).waitFor();
  await page.getByRole("button", { name: "Open as tab" }).click();
  await page.waitForFunction(() => !document.querySelector("#open-tabs prism-doc-tab[selected]")?.getAttribute("value")?.startsWith("slice:"), null, { timeout: 10000 });
  const opened = await page.evaluate(() => document.querySelector("#open-tabs prism-doc-tab[selected]").getAttribute("value"));
  assert.equal(await tab(page, opened).evaluate((host) => host.hasAttribute("preview")), false, "Open as tab opened a kept tab");
  assert.deepEqual(page.errors, []);
});

test("a tab closes from its close button or a middle click, and closing the last one shows that nothing is open", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await demo(context);
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  await openFromSidebar(page, "Roadmap", { modifiers: ["Control"] });
  await settled(page, base, "roadmap");
  await openFromSidebar(page, "Decisions", { modifiers: ["Control"] });
  await settled(page, base, "decisions");
  assert.deepEqual(await tabs(page), ["attention(p)", "roadmap", "decisions*"]);
  await tab(page, "roadmap").click({ button: "middle" });
  await page.waitForTimeout(300);
  assert.deepEqual(await tabs(page), ["attention(p)", "decisions*"], "a middle click closed a tab that was not selected");
  assert.equal(await shownPage(page), "decisions");
  await strip(page).getByRole("button", { name: "Close Decisions" }).click();
  await settled(page, base, "attention");
  assert.deepEqual(await tabs(page), ["attention*(p)"], "closing the selected tab showed the last open tab");
  await strip(page).getByRole("button", { name: "Close Attention" }).click();
  await page.locator('#artifact prism-empty-state[heading="Nothing is open"]').waitFor();
  assert.deepEqual(await tabs(page), []);
  assert.equal(await strip(page).isVisible(), false, "an empty strip takes no room");
  assert.equal(await shownPage(page), null, "the address names no page");
  for (let tries = 0; tries < 40 && (await session(base)).openTabs.length; tries += 1) await page.waitForTimeout(100);
  assert.deepEqual((await session(base)).openTabs, [], "the session holds no tab");
  assert.deepEqual(page.errors, []);
});

test("a tab whose file is gone is dimmed and struck through, says so, and its page offers Close tab", { skip, timeout: 60000 }, async (context) => {
  const { root, base, browser } = await demo(context);
  const index = await (await fetch(`${base}/api/index`)).json();
  const gone = index.artifacts.find((ref) => ref.startsWith("docs/ADRs/"));
  const page = await openPage(browser, reviewUrl(base, "roadmap"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  await page.goto(reviewUrl(base, gone));
  await settled(page, base, gone);
  await rm(path.join(root, gone));
  await page.waitForFunction((ref) => document.querySelector(`#open-tabs prism-doc-tab[value="${ref}"]`)?.hasAttribute("missing"), gone, { timeout: 10000 });
  const style = await textStyle(page, gone);
  assert.equal(style.struck, true, "the missing tab's title is struck through");
  assert.equal(await page.getByRole("tab", { name: /no longer exists/ }).count(), 1, "the missing tab says so to assistive technology");
  await page.locator('#artifact prism-empty-state[heading="This file no longer exists"]').waitFor();
  await page.getByRole("tab", { name: /no longer exists/ }).hover();
  await page.waitForTimeout(700);
  assert.match(await shownTooltip(page) ?? "", /no longer exists/, "the tooltip says why the tab is dimmed");
  await page.locator("#artifact").getByRole("button", { name: "Close tab" }).click();
  await page.waitForTimeout(400);
  assert.equal((await tabs(page)).some((value) => value.startsWith(gone)), false, "Close tab closed the missing tab");
  assert.deepEqual(page.errors, []);
});

test("an agent presentation of several artifacts opens each as a marked tab, focuses the first, and every window shows the same tabs after a reload", { skip, timeout: 60000 }, async (context) => {
  const { review, base, browser } = await demo(context);
  const index = await (await fetch(`${base}/api/index`)).json();
  const presented = index.artifacts.filter((ref) => ref.startsWith("docs/ADRs/")).slice(0, 3);
  assert.equal(presented.length, 3);
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  await review.setOpenTabs(presented);
  await settled(page, base, presented[0]);
  assert.deepEqual(await tabs(page), ["attention(p)", `${presented[0]}*(a)`, `${presented[1]}(a)`, `${presented[2]}(a)`], "every presented artifact has its own tab, and the first shows");
  assert.equal(await page.getByRole("tab", { name: /presented by the agent/ }).count(), 3, "each agent tab says it was presented by the agent");
  assert.equal(await tab(page, presented[1]).evaluate((host) => host.shadowRoot.querySelector(".mark").checkVisibility()), true, "each agent tab shows the agent mark");
  await page.getByRole("tab", { name: /presented by the agent/ }).nth(1).hover();
  await page.waitForTimeout(700);
  assert.match(await shownTooltip(page) ?? "", /Presented by the agent\./);
  const other = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await other.goto(`${base}/review`);
  await waitForView(other);
  assert.deepEqual(await tabs(other), await tabs(page), "another window of the session shows the same tabs");
  assert.equal(await shownPage(other), presented[0], "the address of the other window names the selected tab");
  await tab(other, presented[2]).click();
  await settled(page, base, presented[2]);
  assert.equal((await tabs(page)).find((value) => value.startsWith(presented[2])), `${presented[2]}*(a)`, "a tab chosen in one window is selected in every window");
  await page.reload();
  await waitForView(page);
  assert.deepEqual(await tabs(page), ["attention(p)", `${presented[0]}(a)`, `${presented[1]}(a)`, `${presented[2]}*(a)`], "a reload restores the tabs, the preview, the agent marks, and the selected tab");
  assert.deepEqual(page.errors, []);
});

test("Back and Forward move through the pages the tabs showed, and the address names the selected tab", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await demo(context);
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  await openFromSidebar(page, "Roadmap", { modifiers: ["Control"] });
  await settled(page, base, "roadmap");
  await openFromSidebar(page, "Decisions", { modifiers: ["Control"] });
  await settled(page, base, "decisions");
  await page.getByRole("tab", { name: /^Attention/ }).click();
  await settled(page, base, "attention");
  await page.locator("#page-back").click();
  await settled(page, base, "decisions");
  assert.deepEqual(await tabs(page), ["attention(p)", "roadmap", "decisions*"], "Back selected the tab of the page before");
  await page.goBack();
  await settled(page, base, "roadmap");
  await page.keyboard.press("Alt+ArrowRight");
  await settled(page, base, "decisions");
  await page.locator("#page-forward").click();
  await settled(page, base, "attention");
  assert.deepEqual(await tabs(page), ["attention*(p)", "roadmap", "decisions"]);
  assert.deepEqual(page.errors, []);
});

test("the strip moves focus with arrow keys, Home, and End, opens with Enter, reaches the focused tab's buttons with Tab, and keeps the focus when a tab closes", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await demo(context);
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  for (const name of ["Roadmap", "Requirements", "Decisions"]) {
    await openFromSidebar(page, name, { modifiers: ["Control"] });
    await settled(page, base, name.toLowerCase());
  }
  await page.getByRole("tab", { name: /^Decisions/ }).focus();
  assert.equal(await strip(page).getByRole("tab").evaluateAll((items) => items.filter((item) => item.tabIndex === 0).length), 1, "one tab is in the Tab order");
  await page.keyboard.press("Home");
  assert.equal((await deepFocus(page)).host, "attention");
  await page.keyboard.press("ArrowLeft");
  assert.equal((await deepFocus(page)).host, "decisions", "ArrowLeft wraps to the last tab");
  await page.keyboard.press("ArrowRight");
  assert.equal((await deepFocus(page)).host, "attention", "ArrowRight wraps to the first tab");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  assert.equal((await deepFocus(page)).host, "requirements");
  await page.keyboard.press("Enter");
  await settled(page, base, "requirements");
  await page.keyboard.press("Tab");
  assert.equal((await deepFocus(page)).name, "Close Requirements", "Tab reaches the focused tab's close button");
  await page.keyboard.press("Enter");
  await settled(page, base, "decisions");
  assert.deepEqual(await tabs(page), ["attention(p)", "roadmap", "decisions*"]);
  assert.equal((await deepFocus(page)).role, "tab", "the focus stays in the strip after its tab closed");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.notEqual((await deepFocus(page)).host, "attention", "Tab leaves the strip after the focused tab's buttons, not through every tab");
  assert.deepEqual(page.errors, []);
});

test("at 390px the strip scrolls inside itself, keeps the selected tab in view, and ends long titles with an ellipsis whose full title shows on focus", { skip, timeout: 60000 }, async (context) => {
  const { base, browser } = await demo(context);
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 390, height: 844 } });
  await waitForView(page);
  await fetch(`${base}/api/session`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ openTabs: ["attention", "roadmap", "requirements", "decisions", "glossary", SLICE], activeTab: SLICE }) });
  // An address without a page opens the session's selected tab.
  await page.goto(`${base}/review`);
  await waitForView(page);
  await page.waitForTimeout(300);
  const box = await page.evaluate(() => {
    const strip = document.querySelector("#open-tabs");
    const selected = strip.querySelector("prism-doc-tab[selected]").getBoundingClientRect();
    const bounds = strip.getBoundingClientRect();
    return { scrolls: strip.scrollWidth > strip.clientWidth, scrolled: strip.scrollLeft > 0, inView: selected.left >= bounds.left - 1 && selected.right <= bounds.right + 1, window: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
  assert.deepEqual(box, { scrolls: true, scrolled: true, inView: true, window: false }, "the strip scrolls, the selected tab shows whole, and the window does not scroll");
  const title = await page.evaluate(() => {
    const text = document.querySelector("#open-tabs prism-doc-tab[selected]").shadowRoot.querySelector(".text");
    return { shortened: text.scrollWidth > text.clientWidth, overflow: getComputedStyle(text).textOverflow };
  });
  assert.deepEqual(title, { shortened: true, overflow: "ellipsis" }, "the slice's long title ends with an ellipsis");
  await page.getByRole("tab", { name: /^Retry timed-out/ }).focus();
  await page.waitForTimeout(200);
  assert.match(await shownTooltip(page) ?? "", /Retry timed-out requests until a total deadline/, "the full title shows on keyboard focus");
  assert.equal(await strip(page).getByRole("button", { name: /^Close Retry timed-out/ }).isVisible(), true, "the close button shows without a pointer to hover");
  assert.deepEqual(page.errors, []);
});
