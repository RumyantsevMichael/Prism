import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// The Navigation drawer gives focus to the sidebar's trees when it opens, and a drawer that closes because the window widened past 1100px leaves focus in those trees, not on the page body.

const focusedIn = (page, id) => page.evaluate((root) => ({ tag: document.activeElement.tagName.toLowerCase(), inside: document.getElementById(root).contains(document.activeElement) }), id);

for (const [from, to] of [[390, 1101], [820, 1101], [1100, 1101], [820, 1440]]) {
  test(`widening from ${from}px to ${to}px with the Navigation drawer open keeps focus in the sidebar's trees`, { skip }, async (context) => {
    await useAppDirectory(context);
    const { base } = await serveProject(context, await demoProject(context));
    const browser = await launch(context);
    const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: from, height: 800 } });
    await waitForView(page);
    await page.locator("header").getByRole("button", { name: "Navigation", exact: true }).click();
    await page.getByRole("dialog").filter({ has: page.getByRole("tree") }).waitFor();
    await page.waitForTimeout(100);
    assert.deepEqual(await focusedIn(page, "nav-drawer"), { tag: "prism-tree-item", inside: true }, "opening the drawer focuses a tree item");
    await page.setViewportSize({ width: to, height: 800 });
    await page.waitForFunction(() => !document.getElementById("nav-drawer").isOpen);
    await page.waitForTimeout(300);
    assert.deepEqual(await focusedIn(page, "sidebar"), { tag: "prism-tree-item", inside: true }, "the trees keep focus after the drawer closes");
  });
}
