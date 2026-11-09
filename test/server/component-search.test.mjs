import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { entry, fakeRuntime, manifestPath, project, settled } from "./fixtures/component-indexes.mjs";

// Acceptance tests of components.md §24-§26 for the component-indexes contract, clauses 12, 14-17, and 19 for search.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-search-data-"));
// The shared runtime never downloads assets in these tests; each test passes its own runtime.
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { NativeSemanticRuntime } = await import("../../dist/server/repository-intelligence/native-semantic-runtime.mjs");
const { callConservationTool } = await import("../../dist/server/conservation/conservation-tools.mjs");

const search = (root, runtime, input = {}, waitMs = 2000) => searchRepositoryConcepts({ projectRoot: root, query: "retry the request", ...input }, { runtime, waitMs });
const names = (found) => found.results.map((result) => result.name);

async function scored(t) {
  const fixture = await project(t);
  const fake = await fakeRuntime(fixture.storage);
  // Each index orders by lexicalScore, while cosineSimilarity orders differently.
  Object.assign(fake.control.lexical, { "packages/net/retry.ts": 9, "packages/net/timeout.ts": 1, "packages/app/client.ts": 5 });
  Object.assign(fake.control.cosine, { "packages/net/retry.ts": 0.2, "packages/net/timeout.ts": 0.9, "packages/app/client.ts": 0.5 });
  return { ...fixture, ...fake };
}

test("clauses 14 and 15: one included component answers in its index's order and names its component", async (t) => {
  const { root, runtime } = await scored(t);
  const found = await search(root, runtime, { filters: { paths: ["packages/net"] } });
  assert.deepEqual(names(found), ["retryRequest", "timeoutAfter"]);
  assert.deepEqual(found.results.map((result) => [result.component, result.fusedRank]), [["root/net", 1], ["root/net", 2]]);
});

test("clause 16: several included components merge by cosine similarity, keep their own scores, and renumber the rank", async (t) => {
  const { root, runtime, control } = await scored(t);
  const found = await search(root, runtime);
  assert.equal(found.status, "ready");
  assert.deepEqual(names(found), ["timeoutAfter", "fetchUser", "retryRequest"]);
  assert.deepEqual(found.results.map((result) => [result.component, result.fusedRank, result.lexicalScore, result.cosineSimilarity]),
    [["root/net", 1, 1, 0.9], ["root/app", 2, 5, 0.5], ["root/net", 3, 9, 0.2]]);
  assert.deepEqual(names(await search(root, runtime, { limit: 2 })), ["timeoutAfter", "fetchUser"]);
  // Equal similarities keep component order and then each index's order.
  Object.assign(control.cosine, { "packages/net/retry.ts": 0.5, "packages/net/timeout.ts": 0.5 });
  assert.deepEqual(names(await search(root, runtime)), ["retryRequest", "timeoutAfter", "fetchUser"]);
  // A path scope that selects both packages merges them too.
  assert.deepEqual(names(await search(root, runtime, { filters: { paths: ["packages"] } })), ["retryRequest", "timeoutAfter", "fetchUser"]);
});

test("clauses 12 and 16: an unscoped search while a component prepares merges the others and names it", async (t) => {
  const { root, runtime, control } = await scored(t);
  // The root component builds after the declared ones, so the packages answer while it prepares.
  control.hold("README.md");
  const found = await search(root, runtime, {}, 300);
  assert.equal(found.status, "partial");
  assert.deepEqual(names(found), ["timeoutAfter", "fetchUser", "retryRequest"]);
  const [missing] = found.diagnostics;
  assert.deepEqual([missing.code, missing.components], ["components_missing", ["root/root"]]);
  assert.match(missing.message, /root\/root/);
  assert.match(missing.message, /preparing/);
  assert.equal(entry(found, "root/root").status, "preparing");
  control.release("README.md");
  await settled(runtime, root);
  const complete = await search(root, runtime);
  assert.equal(complete.status, "ready");
  assert.equal(complete.diagnostics.some((item) => item.code === "components_missing"), false);
});

test("clause 17: without a native runtime the search falls back to lexical results over the selected components' files", async (t) => {
  const { root, storage } = await project(t);
  const runtime = new NativeSemanticRuntime({ directory: storage, manifestPath });
  const found = await searchRepositoryConcepts({ projectRoot: root, query: "value", filters: { paths: ["packages/app"] } }, { runtime, waitMs: 2000 });
  assert.equal(found.status, "degraded");
  assert.ok(found.results.length > 0);
  assert.ok(found.results.every((result) => result.file.startsWith("packages/app/") && result.component === "root/app" && result.cosineSimilarity === null));
  assert.equal(entry(found, "root/app").failure.code, "unsupported_runtime");
  const unscoped = await searchRepositoryConcepts({ projectRoot: root, query: "value" }, { runtime, waitMs: 2000 });
  assert.deepEqual([...new Set(unscoped.results.map((result) => result.component))].sort(), ["root/app", "root/net"]);
});

test("clause 19: a search receipt records the components, snapshot, and index revision of its result", async (t) => {
  const { root, runtime } = await scored(t);
  const found = await search(root, runtime);
  const receipt = await callConservationTool("get_conservation_evidence", { projectRoot: root, evidenceId: found.receiptId });
  assert.equal(receipt.kind, "search");
  assert.deepEqual((receipt.components ?? []).map((item) => item.component), ["root/root", "root/net", "root/app"]);
  assert.deepEqual([receipt.components, receipt.snapshot, receipt.indexRevision], [found.components, found.snapshot, found.indexRevision]);
  assert.deepEqual(receipt.entries.map((candidate) => candidate.name), names(found));
});
