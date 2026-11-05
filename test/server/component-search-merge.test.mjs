import test from "node:test";
import assert from "node:assert/strict";
import { searchComponents } from "../../dist/server/repository-intelligence/component-indexes.mjs";

// How searchComponents merges the answers of several component indexes, beyond the acceptance tests of the component-indexes contract.
const hit = (name, cosineSimilarity, fusedRank, extra = {}) => ({ name, cosineSimilarity, fusedRank, lexicalScore: fusedRank, excerpt: "", ...extra });
const component = (identity, results) => ({ component: identity, search: async () => results });

test("a result without a similarity stays after the result it follows in its index, or after every result when it follows none", async () => {
  const { results } = await searchComponents([
    component("root/net", [hit("outline", null, 1), hit("retry", 0.4, 2)]),
    component("root/app", [hit("fetch", 0.6, 1), hit("group", null, 2)])
  ], 10);
  assert.deepEqual(results.map(result => [result.name, result.component, result.fusedRank]),
    [["fetch", "root/app", 1], ["group", "root/app", 2], ["retry", "root/net", 3], ["outline", "root/net", 4]]);
});

test("a container that its index placed after its best member stays after that member when two full components merge", async () => {
  // Each index answers the limit, as the worker does, with the class outline spliced after its best member.
  const { results } = await searchComponents([
    component("root/net", [hit("Client.get", 0.91, 1), hit("Client", null, 2, { groupedMembers: 2 }), hit("Client.post", 0.88, 3), hit("retry", 0.5, 4)]),
    component("root/app", [hit("fetchAll", 0.7, 1), hit("load", 0.6, 2), hit("save", 0.55, 3), hit("log", 0.4, 4)])
  ], 4);
  assert.deepEqual(results.map(result => [result.name, result.component, result.fusedRank, result.cosineSimilarity]),
    [["Client.get", "root/net", 1, 0.91], ["Client", "root/net", 2, null], ["Client.post", "root/net", 3, 0.88], ["fetchAll", "root/app", 4, 0.7]]);
  assert.equal(results[1].groupedMembers, 2);
});

test("a component that does not answer adds nothing, and one answering component keeps its index's order", async () => {
  const { answers, results } = await searchComponents([
    component("root/net", null),
    component("root/app", [hit("low", 0.1, 1), hit("high", 0.9, 2)])
  ], 1);
  assert.deepEqual(answers.map(answer => answer === null), [true, false]);
  assert.deepEqual(results.map(result => [result.name, result.component, result.fusedRank]), [["low", "root/app", 1]]);
});
