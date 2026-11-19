import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launch, openPage, serveProject, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";

// A press, a double click, or a drag on a kit control, a navigation item, or a status mark selects none of its text, as in a desktop application,
// while documents, code, figures, messages, and fields stay selectable; shadow content takes its host's value.

async function catalog(context) {
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-selection-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/kit/catalog`);
  await page.waitForFunction(() => customElements.get("prism-button") !== undefined, null, { timeout: 5000 });
  return page;
}

const CONTROLS = `
  <prism-button>Approve</prism-button>
  <prism-tabs label="Views"><prism-tab value="a" selected>Design</prism-tab><prism-tab value="b">Views</prism-tab></prism-tabs>
  <prism-doc-tabs label="Open"><prism-doc-tab-group name="Retry requests">Retry requests</prism-doc-tab-group><prism-doc-tab value="x" label="Design" group="Retry requests" group-tone="1" agent selected>Design</prism-doc-tab></prism-doc-tabs>
  <prism-chip>Component</prism-chip><prism-badge>3</prism-badge><prism-kbd>Ctrl</prism-kbd>
  <prism-segmented label="Mode"><button value="a" aria-pressed="true">List</button><button value="b">Board</button></prism-segmented>
  <prism-tree label="Files"><prism-tree-item label="Requirements"></prism-tree-item></prism-tree>
  <prism-disclosure summary="Earlier runs"><p>Run 1</p></prism-disclosure>`;
const CONTENT = `
  <prism-doc><p class="prose">A paragraph people copy.</p></prism-doc>
  <prism-code language="js">const answer = 42;</prism-code>
  <prism-stat label="Open findings" value="12"></prism-stat>
  <prism-banner tone="danger">The store is unreachable: ECONNREFUSED</prism-banner>
  <prism-field label="Name"><input value="typed text"></prism-field>`;

// The user-select value Chromium uses for the deepest text-bearing node of each element, through its shadow root.
const usedSelect = (page) => page.evaluate(() => {
  const textOf = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let found = null;
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (node.shadowRoot) {
        const inner = textOf(node.shadowRoot);
        if (inner) return inner;
      }
      if ([...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim())) found ??= node;
    }
    return found;
  };
  return Object.fromEntries([...document.querySelectorAll("#fixture > *")].map((element) => {
    const holder = element.matches("prism-field") ? element.querySelector("input") : textOf(element.shadowRoot ?? element) ?? element;
    return [element.tagName.toLowerCase(), getComputedStyle(holder).userSelect];
  }));
});

test("kit controls, navigation, and marks select no text, while content and fields stay selectable", { skip, timeout: 60000 }, async (context) => {
  const page = await catalog(context);
  await page.evaluate((html) => {
    const region = document.createElement("div");
    region.id = "fixture";
    region.innerHTML = html;
    document.body.prepend(region);
  }, CONTROLS + CONTENT);
  await page.waitForTimeout(300);
  const used = await usedSelect(page);
  for (const tag of ["prism-button", "prism-tabs", "prism-doc-tabs", "prism-chip", "prism-badge", "prism-kbd", "prism-segmented"]) assert.equal(used[tag], "none", `${tag} selects no text`);
  for (const tag of ["prism-doc", "prism-code", "prism-stat", "prism-banner", "prism-field"]) assert.notEqual(used[tag], "none", `${tag} stays selectable`);
  // A tree item's label and a disclosure's toggle select nothing, while the disclosure's content stays selectable.
  const inner = await page.evaluate(() => ({
    tree: getComputedStyle(document.querySelector("#fixture prism-tree-item")).userSelect,
    toggle: getComputedStyle(document.querySelector("#fixture .prism-disclosure-toggle")).userSelect,
    body: getComputedStyle(document.querySelector("#fixture prism-disclosure p")).userSelect
  }));
  assert.deepEqual(inner, { tree: "none", toggle: "none", body: "auto" });
  // A double click on a tab's title selects nothing, and one on a document's word selects it.
  await page.locator("#fixture prism-doc-tab").dblclick();
  assert.equal(await page.evaluate(() => getSelection().toString()), "", "a double click on a tab selects nothing");
  await page.locator("#fixture .prose").dblclick({ position: { x: 30, y: 8 } });
  assert.match(await page.evaluate(() => getSelection().toString()), /paragraph/, "a double click on a document's word selects it");
});
