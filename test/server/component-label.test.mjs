import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, THREE, componentProject, planAndAccept, read } from "./fixtures/components.mjs";

// Requirement: docs/requirements/components.md §27.
// Contract: docs/plans/components/component-slices/slice.md clause 34.
// The review server serves the initiative and slice entities, and the real view modules render them into a minimal stand-in container.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-component-label-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
const initiativeView = await import("../../dist/server/review/public/views/initiative.js");
const sliceView = await import("../../dist/server/review/public/views/slice.js");
test.after(() => rm(privateData, { recursive: true, force: true }));

// A stand-in for the browser container: views write HTML strings, and queried children collect their own HTML.
function container() {
  const element = () => ({
    innerHTML: "",
    children: [],
    dataset: {},
    style: {},
    classList: { toggle() {} },
    addEventListener() {},
    appendChild(child) { this.children.push(child); },
    querySelectorAll() { return []; },
    querySelector(selector) {
      if (selector === "[data-index-notice]") return null;
      const child = element();
      this.children.push(child);
      return child;
    }
  });
  const root = element();
  root.html = () => [root.innerHTML, ...root.children.map((child) => child.innerHTML)].join("\n");
  return root;
}

const context = (state = {}) => ({
  state,
  hasArtifact: () => false,
  fetchArtifact: async () => ({ content: "" }),
  renderMarkdown: () => "",
  rerender() {},
  openArtifact() {},
  openEvidence() {}
});

const LABEL = /<span class="component-chip" data-component="([a-z0-9_/-]+)">([^<]*)<\/span>/g;
const labels = (html) => [...html.matchAll(LABEL)].map(([, name, text]) => [name, text.trim()]);

async function withEntities(t, root, run) {
  const review = await startReviewServer({ projectRoot: root });
  try {
    const entity = async (ref) => {
      const response = await fetch(`${review.baseUrl}/api/entity?ref=${encodeURIComponent(ref)}`);
      assert.equal(response.status, 200, ref);
      return response.json();
    };
    await run(entity);
  } finally {
    await review.close();
  }
}

test("clause 34: the slice tree, the board cards, and the slice page label each slice that records a component", async (t) => {
  const root = await componentProject(t);
  await planAndAccept(root, THREE);
  // A slice accepted before components existed has no component.
  const current = await read(root);
  const file = path.join(root, current.recordPath);
  const raw = JSON.parse(await readFile(file, "utf8"));
  delete raw.slices["web-pages"].component;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);

  await withEntities(t, root, async (entity) => {
    const initiative = await entity(`initiative:${INITIATIVE}`);
    assert.equal(initiative.data.record.slices["billing-totals"].component, "root/billing");
    for (const mode of ["list", "board"]) {
      const view = container();
      await initiativeView.render(view, initiative, context({ mode }));
      const shown = labels(view.html());
      assert.deepEqual(shown.filter(([name]) => name === "root/billing"), [["root/billing", "root/billing"]], `${mode}: billing is labelled once with its identity`);
      assert.deepEqual(shown.filter(([name]) => name === "root/shared"), [["root/shared", "root/shared"]], `${mode}: shared is labelled once`);
      assert.equal(shown.some(([name]) => name === "root/web"), false, `${mode}: a slice without a component has no label`);
    }
    const page = async (slug) => {
      const slice = await entity(`slice:${INITIATIVE}/${slug}`);
      const view = container();
      await sliceView.render(view, slice, context());
      return labels(view.html());
    };
    assert.deepEqual(await page("billing-totals"), [["root/billing", "root/billing"]]);
    assert.deepEqual(await page("web-pages"), []);
    assert.deepEqual(await page(INITIATIVE), [], "a split scope records no component");
  });
});
