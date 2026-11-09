import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, skip, stateFileNames, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// The review shell's palette, history keys, drawer, and file headings at the edges a reviewer found: Enter right after typing, the preview's widths,
// Alt+arrows at the ends of the visited pages, a window that widens with the drawer open, and a repository file's heading.

async function demo(context) {
  await useAppDirectory(context);
  const root = await demoProject(context);
  const { base } = await serveProject(context, root);
  return { base, browser: await launch(context) };
}

const shownPage = (page) => page.evaluate(() => new URL(location.href).searchParams.get("artifact"));
const palette = (page) => page.getByRole("dialog", { name: "Command palette" });

test("Enter right after typing in the palette opens the first result, which the preview shows", { skip }, async (context) => {
  const { base, browser } = await demo(context);
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  await page.keyboard.press("Control+k");
  await palette(page).waitFor();
  await page.keyboard.type("Roadmap");
  const first = palette(page).getByRole("option").first();
  await first.waitFor();
  const label = (await first.innerText()).split("\n")[0].trim();
  assert.match(await page.locator("#palette-preview").innerText(), new RegExp(label), "the preview shows the first result before any arrow key");
  await page.keyboard.press("Enter");
  await waitForView(page);
  assert.equal(await palette(page).count(), 0, "Enter opens the first result and closes the palette");
  assert.equal(await shownPage(page), "roadmap");
});

test("the palette shows its preview above 720px and hides it at 720px and below", { skip, timeout: 120000 }, async (context) => {
  const { base, browser } = await demo(context);
  for (const [width, shown] of [[721, true], [820, true], [1100, true], [1440, true], [720, false], [390, false]]) {
    const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width, height: 800 } });
    await waitForView(page);
    await page.keyboard.press("Control+k");
    await palette(page).waitFor();
    await page.keyboard.type("timed-out");
    await palette(page).getByRole("option").first().waitFor();
    assert.equal(await page.locator("#palette-preview").isVisible(), shown, `the preview ${shown ? "shows" : "is hidden"} at ${width}px`);
    if (shown) assert.match(await page.locator("#palette-preview").innerText(), /Slice/, `the preview names the result's kind at ${width}px`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(overflow, false, `the palette fits ${width}px`);
    await page.context().close();
  }
});

test("Alt+ArrowLeft and Alt+ArrowRight do nothing at the ends of the visited pages", { skip }, async (context) => {
  const { base, browser } = await demo(context);
  const page = await openPage(browser, "data:text/html,<title>before</title>");
  await page.goto(reviewUrl(base, "attention"));
  await waitForView(page);
  assert.equal(await page.locator("#page-back").evaluate((element) => element.hasAttribute("disabled")), true, "Back is disabled on the first visited page");
  await page.locator("#sidebar").getByRole("treeitem").first().focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForTimeout(500);
  assert.match(page.url(), /\/review\?/, "Alt+ArrowLeft stays on the review page");
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(500);
  assert.equal(await shownPage(page), "attention", "Alt+ArrowRight stays on the last visited page");
});

test("widening the window past 1100px closes the Navigation drawer and gives the sidebar its trees back", { skip }, async (context) => {
  const { base, browser } = await demo(context);
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 820, height: 800 } });
  await waitForView(page);
  await page.locator("header").getByRole("button", { name: "Navigation", exact: true }).click();
  await page.getByRole("dialog").filter({ has: page.getByRole("tree") }).waitFor();
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.waitForFunction(() => !document.getElementById("nav-drawer").isOpen);
  assert.equal(await page.locator("#sidebar").getByRole("tree").first().isVisible(), true, "the sidebar shows the trees");
  assert.equal(await page.getByRole("dialog").filter({ has: page.getByRole("tree") }).count(), 0, "the drawer is closed");
});

test("a repository file's page heading is marked as the code subject, and no Prism file name shows", { skip }, async (context) => {
  const { base, browser } = await demo(context);
  const page = await openPage(browser, reviewUrl(base, "config/retry.json"));
  await waitForView(page);
  const heading = page.locator("#artifact h1");
  assert.equal(await heading.innerText(), "retry.json");
  assert.equal(await heading.evaluate((element) => Boolean(element.closest("[data-code-subject]"))), true, "the heading is the code subject");
  assert.deepEqual(await stateFileNames(page, "header, #sidebar, #page-bar, #statusbar, #artifact"), []);
});
