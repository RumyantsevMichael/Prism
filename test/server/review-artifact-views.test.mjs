import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The conservation store reads its location when the module loads, so private data must be set before the import.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-review-views-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
const { conservationStore } = await import("../../dist/server/conservation/conservation-store.mjs");
const examples = await readFile(new URL("./fixtures/change-map.json", import.meta.url), "utf8");
test.after(() => rm(privateData, { recursive: true, force: true }));

async function fixture(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-review-views-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const slice = path.join(root, "docs", "plans", "demo", "retry");
  await mkdir(slice, { recursive: true });
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans (scratch): docs/plans/\n");
  // Records written before .prism sit beside the Markdown, one under the change map's earlier name; the review moves them.
  await writeFile(path.join(slice, "concept-delta.json"), examples);
  await mkdir(path.join(root, "docs", "plans", "demo", "deadline"), { recursive: true });
  await writeFile(path.join(root, "docs", "plans", "demo", "deadline", "change-map.json"), examples);
  await writeFile(path.join(slice, "review.json"), JSON.stringify({ schemaVersion: 1, deltaPath: "docs/plans/demo/retry/concept-delta.json", waves: [], findings: [] }));
  await writeFile(path.join(root, "docs", "plans", "demo", "state.json"), JSON.stringify({ schemaVersion: 1, settings: {}, active: [] }));
  await writeFile(path.join(root, "docs", "plans", "demo", "notes.json"), JSON.stringify({ anything: [1, 2] }));
  await writeFile(path.join(root, "docs", "plans", "demo", "broken.json"), "{ not json");
  return root;
}

function fetchReview(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, headers: response.headers, text: body, json: () => JSON.parse(body) });
      });
    }).once("error", reject);
  });
}

test("lists JSON artifacts and identifies Prism artifact kinds", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot });
  try {
    const index = (await fetchReview(`${review.baseUrl}/api/index`)).json();
    assert.deepEqual(index.artifacts, [
      ".prism/initiatives/demo/slices/deadline/change-map.json",
      ".prism/initiatives/demo/slices/retry/change-map.json",
      ".prism/initiatives/demo/slices/retry/review.json",
      ".prism/initiatives/demo/state.json",
      "docs/plans/demo/broken.json",
      "docs/plans/demo/notes.json"
    ]);
    const load = async (artifact) => (await fetchReview(`${review.baseUrl}/api/artifact?path=${encodeURIComponent(artifact)}`)).json();
    const delta = await load(".prism/initiatives/demo/slices/retry/change-map.json");
    assert.equal(delta.kind, "change-map");
    assert.equal((await load(".prism/initiatives/demo/slices/deadline/change-map.json")).kind, "change-map");
    assert.equal(delta.data.concepts.length, 6);
    assert.equal(delta.summary.totalCount, 6);
    assert.equal(delta.summary.counts.REPLACE, 2);
    assert.equal(typeof delta.summary.ready, "boolean");
    assert.equal(Object.hasOwn(delta.summary, "concepts"), false);
    assert.deepEqual(delta.diagrams, []);
    assert.equal((await load(".prism/initiatives/demo/slices/retry/review.json")).kind, "review-ledger");
    assert.equal((await load(".prism/initiatives/demo/state.json")).kind, "coordination-state");
    assert.equal((await load("docs/plans/demo/notes.json")).kind, "json");
    const broken = await load("docs/plans/demo/broken.json");
    assert.equal(broken.kind, "json");
    assert.match(broken.parseError, /JSON/);
    assert.equal(broken.content, "{ not json");
  } finally {
    await review.close();
  }
});

test("reads retained evidence for the review project with bounded lists", async (context) => {
  const projectRoot = await fixture(context);
  const candidates = Array.from({ length: 250 }, (_, index) => ({ id: `unit-${index}`, file: "src/a.ts" }));
  const id = await conservationStore.put(projectRoot, { kind: "search", schemaVersion: 1, project: projectRoot, query: "retry", candidates });
  const review = await startReviewServer({ projectRoot });
  try {
    const response = await fetchReview(`${review.baseUrl}/api/evidence?id=${id}`);
    assert.equal(response.status, 200);
    const evidence = response.json();
    assert.equal(evidence.id, id);
    assert.equal(evidence.kind, "search");
    assert.equal(evidence.record.query, "retry");
    assert.equal(evidence.record.candidates.length, 200);
    assert.deepEqual(evidence.truncated, { "/candidates": 250 });
    const invalid = await fetchReview(`${review.baseUrl}/api/evidence?id=..%2F..%2Fsecret`);
    assert.equal(invalid.status, 400);
    assert.match(invalid.text, /64-character/);
    const missing = await fetchReview(`${review.baseUrl}/api/evidence?id=${"0".repeat(64)}`);
    assert.equal(missing.status, 400);
    assert.match(missing.text, /missing or corrupt/);
  } finally {
    await review.close();
  }
});

test("does not read evidence that belongs to another project", async (context) => {
  const projectRoot = await fixture(context);
  const otherRoot = await fixture(context);
  const id = await conservationStore.put(otherRoot, { kind: "search", schemaVersion: 1, project: otherRoot, query: "other", candidates: [] });
  const review = await startReviewServer({ projectRoot });
  try {
    const response = await fetchReview(`${review.baseUrl}/api/evidence?id=${id}`);
    assert.equal(response.status, 400);
  } finally {
    await review.close();
  }
});

test("serves view modules by name only", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot });
  try {
    const registry = await fetchReview(`${review.baseUrl}/views/registry.js`);
    assert.equal(registry.status, 200);
    assert.match(registry.headers["content-type"], /text\/javascript/);
    assert.match(registry.headers["content-security-policy"], /script-src 'self'/);
    for (const name of ["change-map", "review-ledger", "coordination-state", "evidence", "graph", "json-tree", "json-view", "util"]) {
      assert.equal((await fetchReview(`${review.baseUrl}/views/${name}.js`)).status, 200, name);
    }
    assert.equal((await fetchReview(`${review.baseUrl}/views/missing.js`)).status, 404);
    assert.equal((await fetchReview(`${review.baseUrl}/views/Registry.js`)).status, 404);
    assert.equal((await fetchReview(`${review.baseUrl}/views/%2e%2e%2freview-server.mjs`)).status, 404);
    const page = await fetchReview(`${review.baseUrl}/review`);
    assert.match(page.text, /id="evidence-drawer"/);
  } finally {
    await review.close();
  }
});
