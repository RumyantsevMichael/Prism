import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, formatProject } from "./fixtures/artifact-formats.mjs";
import { launch, openPage, skip, useAppDirectory, waitForView } from "./fixtures/kit-browser.mjs";
import { startActionReview } from "./fixtures/review-actions.mjs";

// The Requirements library lists its files in one kit library table, and the row of a file that breaks its format holds the mark.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-library-marks-browser-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const OLD = "docs/requirements/old-a.md";
const BROKEN = "# Old notes\n\nThe client retries.\n";

test("clause 1: the Requirements library lists every requirement file in one kit library table with its columns, and the broken file's row holds the mark", { skip, timeout: 90000 }, async (context) => {
  await useAppDirectory(context);
  const root = await formatProject(context, { ...CONFORMING, [OLD]: BROKEN });
  const { review, opened: urls } = await startActionReview(context, root);
  await review.open(["requirements"]);
  const browser = await launch(context);
  const page = await openPage(browser, urls.at(-1));
  await waitForView(page);
  await page.getByText("Old notes", { exact: false }).first().waitFor();
  assert.equal(await page.locator("table.data-table").count(), 0, "no plain table lists the files");
  const table = page.locator("prism-lib-table");
  assert.equal(await table.count(), 1);
  const head = (await table.locator(".prism-lib-row.is-head > *").allTextContents()).map((cell) => cell.trim()).filter(Boolean);
  assert.deepEqual(head, ["Requirements file", "Status", "Date", "Assigned to"]);
  assert.ok(await table.locator(".prism-lib-group").count() >= 1, "the rows stand under a group head");
  const rows = table.locator(".prism-lib-row:not(.is-head)");
  assert.equal(await rows.count(), 2, "one row per requirement file");
  assert.equal(await rows.filter({ hasText: "Old notes" }).locator("prism-badge[data-format-mark]").count(), 1);
  assert.equal(await rows.filter({ hasText: "Request retries" }).locator("[data-format-mark]").count(), 0);
  assert.deepEqual(page.errors, []);
});
