import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FILES, entry, fakeRuntime, manifestPath, project, settled } from "./fixtures/component-indexes.mjs";

// Acceptance tests of components.md §20-§22 and §26 for the component-indexes contract, clauses 22-24.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-baselines-data-"));
// The shared runtime never downloads assets in these tests; each test passes its own runtime.
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { prepareAnalysis } = await import("../../dist/server/conservation/conservation-analysis.mjs");
const { conservationStore } = await import("../../dist/server/conservation/conservation-store.mjs");

const ROOT_FILES = [".prism/workflow.md", "README.md"];
const NET_FILES = ["packages/net/retry.ts", "packages/net/timeout.ts"];
const APP_FILES = ["packages/app/client.ts"];
const search = (root, runtime, input = {}, waitMs = 2000) => searchRepositoryConcepts({ projectRoot: root, query: "retry the request", ...input }, { runtime, waitMs });
const capture = async (root) => (await conservationStore.capture(root)).snapshotId;
const functions = (analysis) => analysis.units.filter((unit) => unit.kind === "function").map((unit) => unit.name).sort();

test("clause 22: a retained baseline is indexed per component and reuses a component index of the same content", async (t) => {
  const { root, storage, write } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  const before = await capture(root);
  const retained = await search(root, runtime, { snapshotId: before });
  assert.deepEqual(control.builds.map((build) => build.files), [ROOT_FILES, NET_FILES, APP_FILES]);
  assert.deepEqual((retained.components ?? []).map((item) => [item.component, item.status]), [["root/root", "included"], ["root/net", "included"], ["root/app", "included"]]);
  assert.equal(retained.snapshotId, before);
  // The live project has the same content, so its components reuse the baseline's indexes.
  const live = await search(root, runtime);
  assert.equal(live.status, "ready");
  assert.equal(control.builds.length, 3);
  // A baseline taken after one package changed prepares only that package, and the live project then reuses it.
  await write("packages/app/client.ts", `${FILES["packages/app/client.ts"]}// changed\n`);
  const after = await capture(root);
  await search(root, runtime, { snapshotId: after });
  assert.deepEqual(control.builds.slice(3).map((build) => build.files), [APP_FILES]);
  await search(root, runtime);
  assert.equal(control.builds.length, 4);
  // A path scope selects the baseline's components as it selects the live project's.
  const scoped = await search(root, runtime, { snapshotId: after, filters: { paths: ["packages/net"] } });
  assert.deepEqual((scoped.components ?? []).map((item) => item.component), ["root/net"]);
});

test("clause 23: a path-scoped call on a baseline retains no analysis of it", async (t) => {
  const { root, storage } = await project(t);
  const { runtime } = await fakeRuntime(storage);
  const snapshotId = await capture(root);
  await search(root, runtime, { snapshotId, filters: { paths: ["packages/net"] } });
  assert.equal(await conservationStore.analysis(root, snapshotId), null);
  const analysis = await prepareAnalysis(root, snapshotId, { runtime });
  assert.equal(analysis.status === "preparing" ? (await settled(runtime, root), (await prepareAnalysis(root, snapshotId, { runtime })).status) : analysis.status, "ready");
  assert.deepEqual(functions((await prepareAnalysis(root, snapshotId, { runtime })).analysis), ["fetchUser", "retryRequest", "timeoutAfter"]);
});

test("clause 24: a baseline analysis waits for every component and then retains their union", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  const snapshotId = await capture(root);
  control.hold("packages/app/client.ts");
  assert.equal((await prepareAnalysis(root, snapshotId, { runtime })).status, "preparing");
  for (let attempt = 0; attempt < 100 && entry(await runtime.status(root), "root/net")?.status !== "ready"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await prepareAnalysis(root, snapshotId, { runtime })).status, "preparing", "one component still prepares");
  control.release("packages/app/client.ts");
  await settled(runtime, root);
  const prepared = await prepareAnalysis(root, snapshotId, { runtime });
  assert.equal(prepared.status, "ready");
  assert.deepEqual(functions(prepared.analysis), ["fetchUser", "retryRequest", "timeoutAfter"]);
  assert.deepEqual(Object.keys(prepared.analysis.fileCoverage).sort(), [...ROOT_FILES, ...APP_FILES, ...NET_FILES].sort());
  assert.deepEqual(control.builds.map((build) => build.files), [ROOT_FILES, NET_FILES, APP_FILES]);
});

test("clause 24: a failed component's files are retained without units and as not covered, and the analysis names it", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  control.fail("packages/app/client.ts", "resource_limit");
  const snapshotId = await capture(root);
  let prepared = await prepareAnalysis(root, snapshotId, { runtime });
  if (prepared.status === "preparing") { await settled(runtime, root); prepared = await prepareAnalysis(root, snapshotId, { runtime }); }
  assert.equal(prepared.status, "ready");
  assert.deepEqual(functions(prepared.analysis), ["retryRequest", "timeoutAfter"]);
  assert.equal(prepared.analysis.fileCoverage["packages/app/client.ts"], false);
  assert.equal(prepared.analysis.fileCoverage["packages/net/retry.ts"], true);
  const missing = prepared.analysis.diagnostics.find((item) => item.code === "components_missing");
  assert.deepEqual(missing?.components, ["root/app"]);
  assert.match(missing.message, /30 minute/);
});
