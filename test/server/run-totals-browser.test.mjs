import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runRecord, segment } from "./fixtures/run-records.mjs";

// Requirements: docs/requirements/run-statistics.md §12, §17.
// Feature: docs/Features/F-run-totals-browser.feature.
// Records are seeded through the record store seam, the review server attaches totals from the shared run-totals reads,
// and the real view modules render the server's responses into a minimal stand-in container.

// The conservation store reads its location when the module loads, so private data must be set before the import.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-totals-browser-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
const { readInitiativeRunTotals, readSliceRunTotals } = await import("../../dist/server/session/run-totals.mjs");
const { appendRecord } = await import("../../dist/server/workflow/record-store.mjs");
const reviewLedgerView = await import("../../dist/server/review/public/views/review-ledger.js");
const sliceView = await import("../../dist/server/review/public/views/slice.js");
const initiativeView = await import("../../dist/server/review/public/views/initiative.js");
test.after(() => rm(privateData, { recursive: true, force: true }));

const HASH = "0".repeat(64);
const RUN = { a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64), d: "d".repeat(64) };
const REVIEW_PATH = ".prism/initiatives/demo/slices/alpha-one/review.json";
const MEASURES = ["runs", "wallTimeMs", "elapsedActiveTimeMs", "summedActiveTimeMs", "inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens", "toolCalls"];

const sliceEntry = (title, parent, status) => ({ title, status, parent, requirements: ["docs/requirements/run-statistics.md#17"], dependencies: [] });
const INITIATIVE = {
  schemaVersion: 1,
  id: "demo",
  slices: {
    demo: sliceEntry("Demo", null, "split"),
    alpha: sliceEntry("Alpha", "demo", "split"),
    "alpha-one": sliceEntry("Alpha one", "alpha", "in-progress"),
    beta: sliceEntry("Beta", "demo", "not-started"),
    gamma: sliceEntry("Gamma", "demo", "not-started")
  },
  history: []
};
const wave = (id) => ({
  id,
  mode: "design-audit",
  deltaRevision: HASH,
  baselineId: HASH,
  snapshotId: HASH,
  comparisonId: HASH,
  lanes: [{ id: "design", reviewer: "reviewer-1", coverage: ["src"] }]
});
const LEDGER = {
  schemaVersion: 1,
  deltaPath: ".prism/initiatives/demo/slices/alpha-one/change-map.json",
  baselineId: HASH,
  coordinator: "coordinator-1",
  delivery: "delivery-1",
  deliveryWorkers: ["delivery-1"],
  waves: [wave("design-1"), wave("design-2")],
  findings: [],
  assessments: [],
  conflicts: [],
  exchangeWorkers: [],
  legacy: [],
  history: []
};

// Initiative demo: split root demo, split parent alpha with leaf alpha-one, leaf beta without records, and leaf gamma
// whose run records cannot be read. Wave design-1 has run records; wave design-2 has none.
async function seededProject(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-totals-browser-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "# Workflow config\n\n## Paths\n- Plans (scratch): docs/plans/\n");
  await mkdir(path.join(root, ".prism", "initiatives", "demo", "slices", "alpha-one"), { recursive: true });
  await writeFile(path.join(root, ".prism", "initiatives", "demo", "initiative.json"), `${JSON.stringify(INITIATIVE, null, 2)}\n`);
  await writeFile(path.join(root, REVIEW_PATH), JSON.stringify(LEDGER));
  const key = (slice) => ({ kind: "runs", initiative: "demo", slice });
  await appendRecord(root, key("alpha-one"), RUN.a, runRecord(RUN.a, "alpha-one", [
    segment({ kind: "wave", wave: "design-1" }, { role: "coordinator", wall: 120, from: 0, to: 60, tokens: [10, 0, 5, 3], tools: 2 }),
    segment({ kind: "design-run", designRun: 1 }, { role: "delivery", wall: 90, from: 30, to: 90, tokens: [20, 0, 0, 4], tools: 3 })
  ], [0, 120]));
  await appendRecord(root, key("alpha-one"), RUN.b, runRecord(RUN.b, "alpha-one", [
    segment({ kind: "slice" }, { role: "delivery", wall: 30, from: 600, to: 630, tokens: [1, 0, 0, 1], tools: 1 })
  ], [600, 630]));
  await appendRecord(root, key("alpha"), RUN.c, runRecord(RUN.c, "alpha", [
    segment({ kind: "slice" }, { role: "coordinator", wall: 60, from: 60, to: 120, tokens: [100, 0, 0, 10], tools: 4 })
  ], [60, 120]));
  // An entry over the 1 MiB bound makes gamma's whole key unreadable, so every gamma measure is unavailable.
  const gamma = path.join(root, ".prism", "initiatives", "demo", "slices", "gamma", "runs");
  await mkdir(gamma, { recursive: true });
  await writeFile(path.join(gamma, `${RUN.d}.json`), JSON.stringify({ padding: "x".repeat(1024 * 1024) }));
  return root;
}

async function withServer(context, run) {
  const projectRoot = await seededProject(context);
  const review = await startReviewServer({ projectRoot });
  try {
    const json = async (route) => {
      const response = await fetch(`${review.baseUrl}${route}`);
      assert.equal(response.status, 200, route);
      return response.json();
    };
    await run({
      projectRoot,
      artifact: (artifactPath) => json(`/api/artifact?path=${encodeURIComponent(artifactPath)}`),
      entity: (ref) => json(`/api/entity?ref=${encodeURIComponent(ref)}`)
    });
  } finally {
    await review.close();
  }
}

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
    // The page follows the code index only while its index notice is shown, which these pages never are.
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

const context = () => ({
  state: {},
  hasArtifact: () => false,
  fetchArtifact: async () => ({ content: "" }),
  renderMarkdown: () => "",
  rerender() {},
  openArtifact() {},
  openEvidence() {}
});

// Each run-totals block in rendered HTML, in document order, with its scope and its tiles' shown value and coverage mark.
const BLOCK = /<(?:div|p) class="run-totals(?:-empty)?" data-run-totals="([a-z]+)">/g;
const TILE = /<prism-stat class="run-total[^"]*" data-measure="([A-Za-z]+)" data-coverage="([a-z]+)" label="[^"]*" value="([^"]*)"/g;
function runTotalsBlocks(html) {
  const starts = [...html.matchAll(BLOCK)];
  return starts.map((match, index) => {
    const body = html.slice(match.index, starts[index + 1]?.index ?? html.length);
    const tiles = Object.fromEntries([...body.matchAll(TILE)].map(([, measure, coverage, shown]) => [measure, { shown: shown.trim(), coverage }]));
    return { scope: match[1], empty: match[0].includes("run-totals-empty"), tiles };
  });
}

// alpha-one: runs a and b. Wall spans 0 s to 630 s; elapsed active is the union of 0-60, 30-90, and 600-630 s; summed
// active adds 60, 60, and 30 s. A real zero (cache-write tokens) shows as 0 because its coverage is exact.
const ALPHA_ONE_TILES = {
  runs: { shown: "2", coverage: "exact" },
  wallTimeMs: { shown: "10 min 30 s", coverage: "exact" },
  elapsedActiveTimeMs: { shown: "2 min", coverage: "exact" },
  summedActiveTimeMs: { shown: "2 min 30 s", coverage: "exact" },
  inputTokens: { shown: "31", coverage: "exact" },
  cacheWriteTokens: { shown: "0", coverage: "exact" },
  cacheReadTokens: { shown: "5", coverage: "exact" },
  outputTokens: { shown: "8", coverage: "exact" },
  toolCalls: { shown: "6", coverage: "exact" }
};

const UNAVAILABLE_TILES = Object.fromEntries(MEASURES.map((measure) => [measure, { shown: "—", coverage: "unavailable" }]));

test("wave cards show each wave's run totals with coverage marks", async (t) => {
  await withServer(t, async ({ projectRoot, artifact }) => {
    const ledger = await artifact(REVIEW_PATH);
    assert.equal(ledger.kind, "review-ledger");
    assert.deepEqual(ledger.data.waves.map((item) => item.id), ["design-1", "design-2"]);
    assert.deepEqual(ledger.runTotals, await readSliceRunTotals(projectRoot, { initiative: "demo", slice: "alpha-one" }));

    const view = container();
    reviewLedgerView.render(view, ledger, context());
    const blocks = runTotalsBlocks(view.html());
    assert.deepEqual(blocks.map((block) => [block.scope, block.empty]), [["wave", false], ["wave", true]]);
    // A wave total's wall time is the span of its active intervals, which the reads mark approximate.
    assert.deepEqual(blocks[0].tiles, {
      runs: { shown: "1", coverage: "exact" },
      wallTimeMs: { shown: "1 min", coverage: "approximate" },
      elapsedActiveTimeMs: { shown: "1 min", coverage: "exact" },
      summedActiveTimeMs: { shown: "1 min", coverage: "exact" },
      inputTokens: { shown: "10", coverage: "exact" },
      cacheWriteTokens: { shown: "0", coverage: "exact" },
      cacheReadTokens: { shown: "5", coverage: "exact" },
      outputTokens: { shown: "3", coverage: "exact" },
      toolCalls: { shown: "2", coverage: "exact" }
    });
    assert.match(view.html(), /Active time excludes idle gaps over 5 min\./);
  });
});

test("the slice page shows the slice's totals, a split parent's descendants, and unavailable measures without zeros", async (t) => {
  await withServer(t, async ({ projectRoot, entity }) => {
    const expected = await readInitiativeRunTotals(projectRoot, { initiative: "demo", root: "demo", children: { demo: ["alpha", "beta", "gamma"], alpha: ["alpha-one"], "alpha-one": [], beta: [], gamma: [] } });
    const render = async (slug) => {
      const slice = await entity(`slice:demo/${slug}`);
      assert.equal(slice.kind, "slice");
      assert.equal(slice.data.slug, slug);
      assert.deepEqual(slice.data.runTotals, expected.slices[slug]);
      const view = container();
      await sliceView.render(view, slice, context());
      return runTotalsBlocks(view.html());
    };

    const leaf = await render("alpha-one");
    assert.deepEqual(leaf.map((block) => block.scope), ["slice"]);
    assert.deepEqual(leaf[0].tiles, ALPHA_ONE_TILES);

    const parent = await render("alpha");
    assert.deepEqual(parent.map((block) => block.scope), ["slice", "descendants"]);
    assert.deepEqual(parent[0].tiles.runs, { shown: "1", coverage: "exact" });
    assert.deepEqual(parent[1].tiles.runs, { shown: "3", coverage: "exact" });
    assert.deepEqual(parent[1].tiles.inputTokens, { shown: "131", coverage: "exact" });

    assert.deepEqual((await render("beta")).map((block) => [block.scope, block.empty]), [["slice", true]]);

    const unreadable = await render("gamma");
    assert.deepEqual(unreadable.map((block) => block.scope), ["slice"]);
    assert.deepEqual(unreadable[0].tiles, UNAVAILABLE_TILES);
  });
});

test("the initiative page shows the initiative's run totals with coverage marks", async (t) => {
  await withServer(t, async ({ projectRoot, entity }) => {
    const initiative = await entity("initiative:demo");
    assert.equal(initiative.kind, "initiative");
    assert.equal(initiative.data.valid, true);
    const expected = await readInitiativeRunTotals(projectRoot, { initiative: "demo", root: initiative.data.derived.root, children: initiative.data.derived.children });
    assert.deepEqual(initiative.data.runTotals, expected);

    const view = container();
    await initiativeView.render(view, initiative, context());
    const blocks = runTotalsBlocks(view.html());
    assert.deepEqual(blocks.map((block) => block.scope), ["initiative"]);
    // Gamma's unreadable key keeps the known sums partial instead of dropping them or showing zero.
    assert.deepEqual(blocks[0].tiles.runs, { shown: "3", coverage: "partial" });
    assert.deepEqual(blocks[0].tiles.inputTokens, { shown: "131", coverage: "partial" });
    assert.deepEqual(blocks[0].tiles.toolCalls, { shown: "10", coverage: "partial" });
  });
});
