import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, launch, openPage, reviewUrl, serveProject, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";

// The browser tests' page helper loads a page again when the browser failed its requests for a network change, and only then.
// Chromium names no network change that a route can give, so these tests count another reason as one.

const REASON = "net::ERR_INTERNET_DISCONNECTED";

// Fails the first load of one of the page's view scripts with REASON, as a network change fails every request in flight.
const failFirstScript = async (context) => {
  let failed = false;
  await context.route(/\/views\/util\.js$/, (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.abort("internetdisconnected");
  });
};

test("a page whose scripts a network change failed loads again and shows its view", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "roadmap"), { reloadReasons: new Set([REASON]), prepare: failFirstScript });
  assert.equal(page.loads, 2);
  await waitForView(page);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("a page whose scripts failed for another reason loads once", { skip, timeout: 120000 }, async (context) => {
  await useAppDirectory(context);
  const { base } = await serveProject(context, await demoProject(context));
  const browser = await launch(context);
  const page = await openPage(browser, reviewUrl(base, "roadmap"), { prepare: failFirstScript });
  assert.equal(page.loads, 1);
  assert.notEqual(await page.evaluate(() => document.querySelector("#artifact")?.getAttribute("aria-busy")), "false", "a page whose script failed shows no view");
  await page.context().close();
});
