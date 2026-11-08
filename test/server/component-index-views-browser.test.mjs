import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { FILES, fakeRuntime, manifestPath, project, settled } from "./fixtures/component-indexes.mjs";

// The review browser in a repository with components: its automatic rebuild, its index panel and chip, and the status of an invalid declaration.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-views-browser-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { resetBackgroundPreparation, startBackgroundPreparation } = await import("../../dist/server/repository-intelligence/background-preparation.mjs");
const { readIndexingStatus } = await import("../../dist/server/repository-intelligence/index-status.mjs");
const { createProjectReview } = await import("../../dist/server/review/review-server.mjs");
const { chipState, panelHtml } = await import("../../dist/server/review/public/views/indexing.js");

const search = (root, runtime, input = {}) => searchRepositoryConcepts({ projectRoot: root, query: "retry the request", ...input }, { runtime, waitMs: 2000 });

async function serve(t, review) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    void review.handle(request, response, url.pathname, url);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (route) => JSON.parse(await (await fetch(`http://127.0.0.1:${server.address().port}${route}`)).text());
}

test("an open page rebuilds when a component's index is stale, also while another component's latest build failed", async (t) => {
  const { root, storage, write } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  await search(root, runtime, { filters: { paths: ["packages/net"] } });
  control.fail("README.md", "resource_limit");
  await search(root, runtime, { filters: { paths: ["README.md"] } });
  await settled(runtime, root);
  await write("packages/net/retry.ts", `${FILES["packages/net/retry.ts"]}// changed\n`);
  const calls = [];
  const review = createProjectReview({ projectRoot: root, baseUrl: "http://127.0.0.1/", intelligenceDirectories: () => [storage],
    rebuildIndex: async (projectRoot) => { calls.push(projectRoot); }, autoRebuild: async () => true, rebuildTiming: { quietMs: 0, gapMs: 60000, freshnessMs: 0 } });
  const call = await serve(t, review);
  const status = await call("/api/indexing");
  assert.equal(status.state, "failed");
  assert.equal(status.stale, true);
  assert.deepEqual(status.components, [{ component: "root/root", state: "failed" }, { component: "root/net", state: "ready" }]);
  assert.equal(status.diagnostics[0].component, "root/root");
  assert.deepEqual(calls, [root]);
});

test("the index panel and chip name the component of the running build and list each component", () => {
  const long = `root/${"a-very-long-component-name-".repeat(6)}end`;
  const status = { state: "preparing", progress: { phase: "graph:parsing", current: 2, total: 4, component: long }, startedAt: new Date().toISOString(), endedAt: null, diagnostics: [],
    index: { builtAt: new Date().toISOString(), coverage: { files: 2 }, diagnostics: 0, component: "root/net" }, stale: false,
    components: [{ component: "root/net", state: "ready" }, { component: long, state: "preparing" }, { component: "root/<app>", state: "failed" }] };
  const chip = chipState(status);
  assert.equal(chip.component, long);
  assert.equal(chip.label, "Indexing 3/5");
  const html = panelHtml(status);
  assert.match(html, new RegExp(`Building <code>${long}</code>`));
  assert.match(html, /<dt>Latest index<\/dt><dd>root\/net<\/dd>/);
  assert.match(html, /data-state="preparing"/);
  assert.match(html, /root\/&lt;app&gt;/);
  assert.doesNotMatch(html, /root\/<app>/);
  // A repository without components keeps today's chip and panel.
  const plain = { ...status, progress: { phase: "graph:parsing", current: 2, total: 4 }, index: { ...status.index, component: undefined }, components: undefined };
  assert.equal(chipState(plain).component, "");
  assert.doesNotMatch(panelHtml(plain), /Building|Components|Latest index/);
});

test("an invalid declaration's refusal shows as the index status's failure", async (t) => {
  resetBackgroundPreparation();
  const { root, storage } = await project(t, { components: ["## Components", "- net: packages/net", "- app: packages/net/app", ""].join("\n") });
  const { runtime, control } = await fakeRuntime(storage);
  await startBackgroundPreparation(root, { runtime, available: async () => true });
  const status = await readIndexingStatus(root, [storage]);
  assert.deepEqual(control.builds, []);
  assert.equal(status.state, "failed");
  assert.equal("components" in status, false);
  assert.match(status.diagnostics[0].code, /^component_/);
  resetBackgroundPreparation();
});
