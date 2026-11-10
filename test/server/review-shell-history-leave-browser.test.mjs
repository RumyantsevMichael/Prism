import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// Forward and Alt+ArrowRight stay inside the review app even after the tab left it from a page in the middle of its visited pages.

test("Alt+ArrowRight does not leave the review app after the tab left it from a middle page and came back", { skip }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "attention"), { viewport: { width: 1440, height: 900 } });
  await waitForView(page);
  for (const query of ["Roadmap", "retry.json"]) {
    await page.keyboard.press("Control+k");
    await page.keyboard.type(query);
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("option").first().waitFor();
    await page.keyboard.press("Enter");
    await waitForView(page);
  }
  await page.goBack();
  await waitForView(page);
  await page.goto("data:text/html,<title>outside</title>");
  await page.goBack();
  await waitForView(page);
  assert.equal(await page.locator("#page-forward").evaluate((element) => element.hasAttribute("disabled")), true, "Forward is disabled when the next page is outside the app");
  await page.locator("#sidebar").getByRole("treeitem").first().focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(800);
  assert.match(page.url(), /^http:\/\/127\.0\.0\.1:/, "Alt+ArrowRight stays in the review app");
});
