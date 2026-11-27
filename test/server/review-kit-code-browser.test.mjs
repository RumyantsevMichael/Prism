import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launch, openPage, serveProject, skip, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { repainted } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/code-place.md §19, §23.
// Contract: docs/plans/code-place/slice.md clauses 54 to 56, through the served component catalog page.

async function catalog(context, options = {}) {
  await useAppDirectory(context);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-code-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { base } = await serveProject(context, root);
  const browser = await launch(context);
  const page = await openPage(browser, `${base}/kit/catalog`, options);
  await page.waitForFunction(() => customElements.get("prism-chip") !== undefined, null, { timeout: 5000 });
  return { page };
}

async function mount(page, html, width = "600px") {
  await page.evaluate(([html, width]) => {
    document.querySelector("#fixture")?.remove();
    const region = document.createElement("div");
    region.id = "fixture";
    region.style.setProperty("width", width);
    region.innerHTML = html;
    document.body.prepend(region);
    window.scrollTo(0, 0);
  }, [html, width]);
  await repainted(page);
}

// The computed color of a token, in the form getComputedStyle reports colors.
const token = (page, name) => page.evaluate((name) => {
  const probe = document.createElement("span");
  probe.style.setProperty("color", `var(${name})`);
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}, name);

// Each visible text node under the fixture, through shadow roots, with its parent's color and box.
const texts = (page) => page.evaluate(() => {
  const found = [];
  const walk = (root) => {
    for (const node of root.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if (box.width) found.push({ text: node.textContent.trim(), color: getComputedStyle(node.parentElement).color, x: box.x });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.localName === "slot") walk({ childNodes: node.assignedNodes({ flatten: true }) });
        else walk(node.shadowRoot ?? node);
      }
    }
  };
  walk(document.querySelector("#fixture"));
  return found;
});

test("clause 54: prism-line-delta shows added and removed counts in their colors and names them", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-line-delta added="3" removed="2"></prism-line-delta>`);
  assert.equal(await page.locator("#fixture prism-line-delta").evaluate((node) => customElements.get(node.localName) !== undefined), true, "the element is defined");
  assert.equal((await page.locator("#fixture").innerText()).replace(/\s+/g, " ").trim(), "+3 −2");
  const shown = await texts(page);
  const added = shown.find((item) => item.text === "+3");
  const removed = shown.find((item) => item.text === "−2");
  assert.ok(added && removed, JSON.stringify(shown));
  assert.equal(added.color, await token(page, "--prism-color-diff-added"));
  assert.equal(removed.color, await token(page, "--prism-color-diff-removed"));
  assert.ok(added.x < removed.x, "added comes first");
  assert.match(await page.locator("#fixture").ariaSnapshot(), /3 lines added, 2 lines removed/);
  await mount(page, `<prism-line-delta added="1" removed="1"></prism-line-delta>`);
  assert.match(await page.locator("#fixture").ariaSnapshot(), /1 line added, 1 line removed/, "a count of 1 reads in the singular");
});

test("clause 54: prism-line-delta leaves out a count it is not given", { skip }, async (context) => {
  const { page } = await catalog(context);
  await mount(page, `<prism-line-delta added="5"></prism-line-delta> <prism-line-delta removed="1"></prism-line-delta>`);
  const [first, second] = await page.locator("#fixture prism-line-delta").evaluateAll((nodes) => nodes.map((node) => node.innerText ?? node.textContent));
  assert.equal(first.trim(), "+5");
  assert.equal(second.trim(), "−1");
});

test("clause 55: prism-inline-note shows its glyph before its text in the tone's color and wraps long text", { skip }, async (context) => {
  const { page } = await catalog(context);
  const long = "Report retry attempts as metrics also changes lines 2–4 of a file whose name is long enough to wrap, so whichever merges second will conflict.";
  await mount(page, `<prism-inline-note tone="warning"><prism-icon slot="start" name="warning" size="xs"></prism-icon>${long}</prism-inline-note>`, "240px");
  const note = page.locator("#fixture prism-inline-note");
  const shown = await texts(page);
  assert.equal(shown[0]?.color, await token(page, "--prism-color-warning"));
  const glyph = await page.locator("#fixture prism-inline-note prism-icon").boundingBox();
  const box = await note.boundingBox();
  assert.ok(glyph && glyph.x < shown[0].x, "the glyph comes before the text");
  assert.ok(box.height > glyph.height * 2, "the long text wraps onto several lines");
  assert.equal(await note.evaluate((node) => node.scrollWidth <= node.clientWidth + 1 && node.getBoundingClientRect().right <= document.querySelector("#fixture").getBoundingClientRect().right + 1), true, "nothing overflows");
  await mount(page, `<prism-inline-note tone="info"><prism-icon slot="start" name="info" size="xs"></prism-icon>Shown for the chosen branch only.</prism-inline-note>`);
  assert.equal((await texts(page))[0]?.color, await token(page, "--prism-color-info"));
});

test("clause 56: the catalog lists both elements with a specimen per state and a long text", { skip }, async (context) => {
  const { page } = await catalog(context);
  for (const tag of ["prism-line-delta", "prism-inline-note"]) {
    const entry = page.locator(`#entry-${tag}`);
    assert.equal(await entry.count(), 1, `${tag} has a catalog entry`);
    const text = await entry.innerText();
    assert.match(text, /long-text/i, `${tag} shows a long text specimen`);
    assert.ok(await entry.locator(tag).count() >= 2, `${tag} has live specimens`);
  }
  assert.ok(await page.locator("#entry-prism-inline-note prism-inline-note[tone=\"warning\"]").count() >= 1);
  assert.ok(await page.locator("#entry-prism-inline-note prism-inline-note[tone=\"info\"]").count() >= 1);
});
