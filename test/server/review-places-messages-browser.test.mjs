import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { skip, stateFileNames } from "./fixtures/kit-browser.mjs";
import { choosePlace, drawer, open, PLACES, placesDemo, sidebar } from "./fixtures/places-browser.mjs";
import { messageHtml } from "../../src/server/review/public/views/util.js";

// A warning that names a Prism file shows the name as code, so the sidebars keep it informative without leaking a state path as prose.

test("a message marks each path under .prism/ and each JSON file name as code and leaves the sentence's punctuation outside", () => {
  assert.equal(messageHtml("The project has no .prism/workflow.md, so defaults apply."), "The project has no <code data-code-subject>.prism/workflow.md</code>, so defaults apply.");
  assert.equal(messageHtml("Cannot read .prism/initiatives/a/state.json."), "Cannot read <code data-code-subject>.prism/initiatives/a/state.json</code>.");
  assert.equal(messageHtml("The change-map.json is unreadable"), "The <code data-code-subject>change-map.json</code> is unreadable");
  assert.equal(messageHtml("Roadmap must be relative to the project root."), "Roadmap must be relative to the project root.");
  assert.equal(messageHtml("<b>"), "&lt;b&gt;");
});

test("without a workflow file the sidebars still name the setting warnings and show the file name only as code", { skip, timeout: 90000 }, async (context) => {
  const { base, browser } = await placesDemo(context, { prepare: (root) => rm(path.join(root, ".prism", "workflow.md"), { force: true }) });
  const wide = await open(browser, base, "attention");
  const warnings = sidebar(wide).locator("prism-disclosure.nav-diagnostics");
  assert.match(await warnings.getAttribute("summary"), /^\d+ workflow setting warnings?$/, "the sidebar says that warnings exist");
  await warnings.evaluate((node) => { node.open = true; });
  await wide.waitForTimeout(200);
  assert.deepEqual(await sidebar(wide).locator("li code[data-code-subject]").allInnerTexts(), [".prism/workflow.md"], "the missing file is named as code");
  for (const name of PLACES) {
    await choosePlace(wide, name);
    assert.deepEqual(await stateFileNames(wide, "nav[aria-label='Places'], #sidebar"), [], `${name} at 1440 names no Prism file outside code`);
  }
  const narrow = await open(browser, base, "attention", { width: 820 });
  await narrow.locator("header").getByRole("button", { name: "Navigation" }).click();
  await drawer(narrow).waitFor();
  await drawer(narrow).locator("prism-disclosure.nav-diagnostics").evaluate((node) => { node.open = true; });
  await narrow.waitForTimeout(200);
  assert.deepEqual(await stateFileNames(narrow, "[role='dialog'][aria-label='Navigation']"), [], "the drawer at 820 names no Prism file outside code");
  assert.deepEqual(wide.errors ?? [], []);
  assert.deepEqual(narrow.errors ?? [], []);
});
