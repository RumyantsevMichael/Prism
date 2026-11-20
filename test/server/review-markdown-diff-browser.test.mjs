import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { answerGate, checkout, git, isolateGit, ok, reviewBrowser, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";
import { launch, openPage, skip } from "./fixtures/kit-browser.mjs";

// Requirements: docs/requirements/review-app-places.md §46, as the approved mockup shows a Markdown file's changes since its accepted version on its rendered text.
// The file is accepted, then one sentence gains words and loses words, one paragraph goes, and a section is added.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/requirements/retries.md";
// The file keeps the requirements format, since Prism refuses a write or an approval that would break it, so the changes lie in its free sections.
const ACCEPTED = `# Retries

Status: Draft
Created: 2026-11-07
Approved: n/a

## Problem

When a request times out, the client shall retry it until the total deadline elapses, at most three times.

When a connection drops, the client shall retry the request.

Each retry waits between 100 and 400 milliseconds.

## Goals

- Recover from short failures.

## Non-goals

- n/a

## Design questions

| Name | Meaning |
| --- | --- |
| attempts | Retries made |

<a id="1"></a>
## 1. Total deadline

Pattern: Ubiquitous

Disposition: Active

Requirement: The client shall stop retrying at the total deadline.

Rationale: A bound keeps connections free.

Related: n/a
`;
// Text added before the first requirement section stays in the free sections.
const beforeRequirements = (content, text) => content.replace('<a id="1"></a>', `${text}<a id="1"></a>`);
const changed = (accepted) => beforeRequirements(accepted
  .replace("until the total deadline elapses, at most three times.", "until the total deadline, counted from the first attempt, elapses.")
  .replace("Each retry waits between 100 and 400 milliseconds.\n\n", ""), "### 4. Jitter\n\nThe client shall wait a random interval before each retry.\n\n");

const pageUrl = (review, file) => `${review.baseUrl.replace(/\/$/, "")}/review?artifact=${encodeURIComponent(file)}`;

async function changedFile(context) {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api);
  const review = await reviewBrowser(context, api);
  await writeArtifact(prism, FILE, ACCEPTED);
  const asked = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Retries." }] }));
  assert.equal((await answerGate(review, { id: asked.artifacts[0].gate, choice: "approve" })).status, 200);
  const approved = ok(await prism.call("get_artifact", { path: FILE }));
  // Approving the file records its approval date in it, so the change starts from the approved text.
  const written = ok(await prism.call("update_artifact", { operations: [{ op: "write", path: FILE, content: changed(approved.content), expectedVersion: approved.version }] })).artifacts[0];
  return { review, prism, version: written.version, content: changed(approved.content) };
}

const blocks = (page) => page.locator("#artifact [data-diff-view] > [data-diff]").evaluateAll((items) => items.map((item) => `${item.dataset.diff}: ${item.textContent.replace(/\s+/g, " ").trim()}`));

test("a changed store file says so above its text, and Show changes marks the changed blocks and words on the rendered text", { skip, timeout: 120000 }, async (context) => {
  const { review } = await changedFile(context);
  const browser = await launch(context);
  const page = await openPage(browser, pageUrl(review, FILE), { viewport: { width: 1280, height: 900 } });
  const changes = page.locator("#artifact [data-artifact-changes]");
  await changes.waitFor({ timeout: 15000 });
  assert.match(await changes.innerText(), /Changed since the accepted version/);
  const toggle = changes.locator("[data-changes-toggle]");
  assert.equal((await toggle.innerText()).trim(), "Show 4 changes", "the button counts the changed blocks: one changed, one removed, and a heading and a paragraph added");
  assert.equal(await page.locator("#artifact [data-diff-view]").count(), 0, "the text shows as it is until the changes are asked for");
  await toggle.click();
  await page.locator("#artifact prism-doc[data-diff-view]").waitFor({ timeout: 10000 });
  assert.deepEqual(await blocks(page), [
    "changed: When a request times out, the client shall retry it until the total deadline elapses, at most three times, counted from the first attempt, elapses.",
    "removed: Each retry waits between 100 and 400 milliseconds.",
    "added: 4. Jitter",
    "added: The client shall wait a random interval before each retry."
  ]);
  const changed = page.locator('#artifact [data-diff-view] > [data-diff="changed"]');
  assert.deepEqual(await changed.locator("ins").allInnerTexts(), [", counted from the first attempt, elapses"], "the changed block marks the words it gained");
  assert.deepEqual(await changed.locator("del").allInnerTexts(), ["elapses, at most three times"], "and puts back the words it lost, a word kept alone between the two going with them");
  assert.equal((await page.locator("#artifact [data-changes-toggle]").innerText()).trim(), "Hide changes");
  assert.match(await page.locator("#artifact .artifact-diff-legend").innerText(), /Added\s+Changed\s+Removed/);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `the page does not scroll sideways at ${width} pixels`);
  }
  assert.deepEqual(page.errors, []);
});

test("Source lines shows the numbered line diff, and the shown changes and the choice stay as the person left them while the file changes", { skip, timeout: 120000 }, async (context) => {
  const { review, prism, version, content } = await changedFile(context);
  const browser = await launch(context);
  const page = await openPage(browser, pageUrl(review, FILE), { viewport: { width: 1280, height: 900 } });
  const toggle = page.locator("#artifact [data-changes-toggle]");
  await toggle.click();
  await page.locator("#artifact").getByRole("radiogroup", { name: "Changes as" }).getByRole("radio", { name: "Source lines" }).click();
  const table = page.locator("#artifact .artifact-source-diff table.line-diff");
  await table.waitFor({ timeout: 10000 });
  assert.ok(await table.locator("tr.diff-add").count() >= 3, "added lines show");
  assert.ok(await table.locator("tr.diff-del").count() >= 2, "removed lines show");
  assert.equal(await page.locator("#artifact .artifact-diff-legend").count(), 0, "the rendered legend goes with the rendered changes");
  ok(await prism.call("update_artifact", { operations: [{ op: "write", path: FILE, content: beforeRequirements(content, "A late sentence.\n\n"), expectedVersion: version }] }));
  await page.locator("#artifact .artifact-source-diff", { hasText: "A late sentence." }).waitFor({ timeout: 15000 });
  assert.equal(await page.locator("#artifact").getByRole("radiogroup", { name: "Changes as" }).getByRole("radio", { name: "Source lines" }).getAttribute("aria-checked"), "true", "the page drew the change and kept the choice");
  await page.locator("#artifact").getByRole("radiogroup", { name: "Changes as" }).getByRole("radio", { name: "Rendered" }).click();
  await page.locator("#artifact prism-doc[data-diff-view]").waitFor({ timeout: 10000 });
  await page.locator("#artifact [data-changes-toggle]").click();
  await page.locator("#artifact [data-changes-toggle]", { hasText: "Show 5 changes" }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator("#artifact [data-diff-view]").count(), 0, "Hide changes shows the text as it is");
  assert.deepEqual(page.errors, []);
});
