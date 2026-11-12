import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, formatProject } from "./fixtures/artifact-formats.mjs";
import { launch, openPage, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";

// The format findings on the real Attention page, built from the review app's UI kit.

// The review server reads its private data folder when it loads, so the folder is set before any server starts.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-formats-browser-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const BROKEN = "# Old notes\n\nThe client retries.\n";

// Native controls written in the page's light DOM, outside the kit's own elements.
const offKit = (page, selector) => page.evaluate((scope) => {
  const root = document.querySelector(scope);
  if (!root) return ["missing"];
  return [...root.querySelectorAll("button, input, select, textarea")].map((element) => element.outerHTML.slice(0, 80));
}, selector);

async function formatsPage(context) {
  await useAppDirectory(context);
  const root = await formatProject(context, { ...CONFORMING, "docs/requirements/old-a.md": BROKEN, "docs/ADRs/old/plain.md": "# Plain decision\n\nWe retry.\n" });
  // Only a tab the server opened holds a write grant, so the server opens the page and the test records its address.
  const { review, opened } = await startActionReview(context, root);
  await review.open(["attention:formats"]);
  const browser = await launch(context);
  const page = await openPage(browser, opened.at(-1));
  await waitForView(page);
  return page;
}

test("clause 19: the Format findings page lists each format with its count, its artifacts by kind of break, and each finding's rule and message", { skip, timeout: 90000 }, async (context) => {
  const page = await formatsPage(context);
  const view = page.locator("#artifact");
  assert.equal(await view.getByText("Format findings", { exact: false }).first().isVisible(), true);
  assert.equal(await view.getByText("Requirements", { exact: false }).first().isVisible(), true);
  assert.equal(await view.getByText("Decisions", { exact: false }).first().isVisible(), true);
  assert.equal(await view.getByText("No Prism format", { exact: true }).first().isVisible(), true, "foreign artifacts list under their own heading");
  assert.equal(await view.getByText("docs/requirements/old-a.md", { exact: false }).first().isVisible(), true);
  assert.equal(await view.getByText("requirements.header", { exact: false }).first().isVisible(), true, "the broken rule is named");
  assert.equal(await view.getByText("docs/ADRs/old/plain.md", { exact: false }).first().isVisible(), true);
  assert.equal(await view.getByText(/Mark as legacy/).first().isVisible(), true, "the legacy action is offered");
  assert.deepEqual(await offKit(page, "#artifact"), [], "every control on the page is a kit element");
  assert.deepEqual(page.errors, []);
});
