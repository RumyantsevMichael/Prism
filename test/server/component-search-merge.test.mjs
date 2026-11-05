import test from "node:test";
import assert from "node:assert/strict";
import { searchComponents } from "../../dist/server/repository-intelligence/component-indexes.mjs";

// How searchComponents merges the answers of several component indexes, beyond the acceptance tests of the component-indexes contract.
const hit = (name, cosineSimilarity, fusedRank) => ({ name, cosineSimilarity, fusedRank, lexicalScore: fusedRank, excerpt: "" });
const component = (identity, results) => ({ component: identity, search: async () => results });

test("a result without a similarity follows every result that has one, in component order", async () => {
  const { results } = await searchComponents([
    component("root/net", [hit("outline", null, 1), hit("retry", 0.4, 2)]),
    component("root/app", [hit("fetch", 0.6, 1), hit("group", null, 2)])
  ], 10);
  assert.deepEqual(results.map(result => [result.name, result.component, result.fusedRank]),
    [["fetch", "root/app", 1], ["retry", "root/net", 2], ["outline", "root/net", 3], ["group", "root/app", 4]]);
});

test("a component that does not answer adds nothing, and one answering component keeps its index's order", async () => {
  const { answers, results } = await searchComponents([
    component("root/net", null),
    component("root/app", [hit("low", 0.1, 1), hit("high", 0.9, 2)])
  ], 1);
  assert.deepEqual(answers.map(answer => answer === null), [true, false]);
  assert.deepEqual(results.map(result => [result.name, result.component, result.fusedRank]), [["low", "root/app", 1]]);
});
