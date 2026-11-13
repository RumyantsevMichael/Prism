import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeRuntime, manifestPath, project } from "./fixtures/component-indexes.mjs";

// Acceptance tests of index-preparation.md §11 for the index-preparation contract, clause 30.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-search-fusion-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");

const fn = (name) => `export function ${name}(value) {\n  value = value + 1;\n  return value;\n}\n`;
const FILES = {
  "README.md": "# Fixture\n",
  "packages/net/a.ts": fn("alpha"),
  "packages/net/b.ts": fn("beta"),
  "packages/net/c.ts": fn("gamma"),
  "packages/app/d.ts": fn("delta"),
  "packages/app/e.ts": fn("epsilon")
};
// Vector evidence ranks a, b, d, e, c across both indexes, while each index's lexical evidence ranks the other way round:
// net ranks c, b, a and app ranks e, d, with scores on unrelated scales.
const COSINE = { "packages/net/a.ts": 0.5, "packages/net/b.ts": 0.49, "packages/app/d.ts": 0.48, "packages/app/e.ts": 0.47, "packages/net/c.ts": 0.46 };
const LEXICAL = { "packages/net/c.ts": 9, "packages/net/b.ts": 5, "packages/net/a.ts": 1, "packages/app/e.ts": 100, "packages/app/d.ts": 1 };

async function searchWith(t, input) {
  const { root, storage } = await project(t, { files: FILES });
  const { runtime, control } = await fakeRuntime(storage);
  Object.assign(control.cosine, COSINE);
  Object.assign(control.lexical, LEXICAL);
  const found = await searchRepositoryConcepts({ projectRoot: root, ...input }, { runtime, waitMs: 30000 });
  assert.equal(found.status, "ready");
  return found.results;
}
const names = (results) => results.map((result) => result.name);

test("clause 30: an identifier-like query ranks results of several indexes with both lexical and vector evidence", async (t) => {
  // Lexical ranks across indexes: c and e lead their indexes (c first in component order), then b before d by their share of their index's top score, then a.
  // With w = 0.5, e's lexical rank lifts it above d, which vector evidence alone ranks higher.
  const results = await searchWith(t, { query: "retryRequest" });
  assert.deepEqual(names(results), ["alpha", "beta", "epsilon", "delta", "gamma"]);
  assert.deepEqual(results.map((result) => result.fusedRank), [1, 2, 3, 4, 5]);
  assert.deepEqual(results.map((result) => [result.cosineSimilarity, result.lexicalScore]), [[0.5, 1], [0.49, 5], [0.47, 100], [0.48, 1], [0.46, 9]], "each result keeps its index's scores");
  assert.deepEqual(results.map((result) => result.component), ["root/net", "root/net", "root/app", "root/app", "root/net"]);
});

test("clause 30: a plain query gives lexical evidence the lower weight", async (t) => {
  const results = await searchWith(t, { query: "retry the request" });
  assert.deepEqual(names(results), ["alpha", "beta", "delta", "epsilon", "gamma"]);
});

test("clause 30: a result whose name equals the query comes first", async (t) => {
  const results = await searchWith(t, { query: " delta " });
  assert.deepEqual(names(results), ["delta", "alpha", "beta", "epsilon", "gamma"]);
});

test("clause 30: the merged ranking keeps the first limit results", async (t) => {
  const results = await searchWith(t, { query: "retryRequest", limit: 3 });
  assert.deepEqual(names(results), ["alpha", "beta", "epsilon"]);
  assert.deepEqual(results.map((result) => result.fusedRank), [1, 2, 3]);
});

test("clause 30: a single answering index keeps its own order", async (t) => {
  const results = await searchWith(t, { query: "retryRequest", filters: { paths: ["packages/net"] } });
  assert.deepEqual(names(results), ["gamma", "beta", "alpha"]);
});
