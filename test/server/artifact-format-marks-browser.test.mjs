import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, formatProject } from "./fixtures/artifact-formats.mjs";
import { launch, openPage, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";

// The review app marks a nonconforming artifact with the rules it breaks in its lists and on its page, built from the UI kit.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-format-marks-browser-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const OLD = "docs/requirements/old-a.md";
const BROKEN = "# Old notes\n\nThe client retries.\n";

async function opened(context, refs) {
  await useAppDirectory(context);
  const root = await formatProject(context, { ...CONFORMING, [OLD]: BROKEN });
  const { review, opened: urls } = await startActionReview(context, root);
  await review.open(refs);
  const browser = await launch(context);
  const page = await openPage(browser, urls.at(-1));
  await waitForView(page);
  return page;
}

// Each format mark in the page: its tag, tone, text, and title.
const marks = (page, scope) => page.evaluate((selector) => [...document.querySelectorAll(`${selector} [data-format-mark]`)].map((element) => ({
  tag: element.tagName.toLowerCase(),
  tone: element.getAttribute("tone"),
  text: element.textContent.replace(/\s+/g, " ").trim(),
  title: element.getAttribute("title")
})), scope);

test("clauses 6, 8, 9: a requirements list marks the nonconforming file's row with a warning badge naming its rules, and no conforming row", { skip, timeout: 90000 }, async (context) => {
  const page = await opened(context, ["requirements"]);
  await page.getByText("Old notes", { exact: false }).first().waitFor();
  const found = await marks(page, "body");
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.deepEqual([found[0].tag, found[0].tone, found[0].text], ["prism-badge", "warning", "Breaks its format"]);
  assert.match(found[0].title, /requirements\.header/);
  const row = page.locator("[data-format-mark]").first().locator("xpath=ancestor::*[contains(@class, 'prism-lib-row') or self::prism-list-item][1]");
  assert.match(await row.innerText(), /Old notes|old-a/);
  assert.deepEqual(page.errors, []);
});

test("clauses 7, 8: a nonconforming file's page shows a warning banner with each finding, and a conforming file's page none", { skip, timeout: 90000 }, async (context) => {
  const page = await opened(context, [OLD]);
  await page.getByText("This file breaks its format", { exact: false }).first().waitFor();
  const [banner] = await marks(page, "body");
  assert.deepEqual([banner.tag, banner.tone], ["prism-banner", "warning"]);
  assert.match(banner.text, /This file breaks its format/);
  assert.match(banner.text, /requirements\.header/);
  const other = await opened(context, [PATHS.requirements]);
  await other.getByText("Request retries", { exact: false }).first().waitFor();
  assert.deepEqual(await marks(other, "body"), []);
});

test("clause 6: the Jump palette marks a nonconforming file's result", { skip, timeout: 90000 }, async (context) => {
  const page = await opened(context, ["attention"]);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await page.keyboard.type("Old notes");
  await page.getByText("Old notes", { exact: false }).first().waitFor();
  const found = await marks(page, ".palette-result");
  assert.ok(found.some((mark) => mark.tag === "prism-badge" && mark.text === "Breaks its format"), JSON.stringify(found));
});
