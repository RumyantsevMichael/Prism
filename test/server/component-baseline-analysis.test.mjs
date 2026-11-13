import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeRuntime, manifestPath, project, settled } from "./fixtures/component-indexes.mjs";

// A retained baseline in a repository with components: its structural reports read its components, and an analysis that left out a failed
// component is prepared again by the next call, so a recovered component's files become covered.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-baseline-analysis-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { reportComplexUnits } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { prepareAnalysis } = await import("../../dist/server/conservation/conservation-analysis.mjs");
const { conservationStore } = await import("../../dist/server/conservation/conservation-store.mjs");

const capture = async (root) => (await conservationStore.capture(root)).snapshotId;
const functions = (analysis) => analysis.units.filter((unit) => unit.kind === "function").map((unit) => unit.name).sort();
const ready = async (runtime, root, snapshotId) => {
  let prepared = await prepareAnalysis(root, snapshotId, { runtime });
  if (prepared.status === "preparing") { await settled(runtime, root); prepared = await prepareAnalysis(root, snapshotId, { runtime }); }
  return prepared;
};

test("a structural report on a baseline reads the baseline's components and names the snapshot", async (t) => {
  const { root, storage, write } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  const snapshotId = await capture(root);
  await write("packages/net/retry.ts", "export const removed = 1;\n");
  const report = await reportComplexUnits({ projectRoot: root, snapshotId, filters: { paths: ["packages/net"] } }, { runtime, waitMs: 30000 });
  assert.equal(report.snapshotId, snapshotId);
  assert.deepEqual(report.components.map((item) => [item.component, item.status]), [["root/net", "included"]]);
  assert.deepEqual(control.builds.map((build) => build.files), [["packages/net/retry.ts", "packages/net/timeout.ts"]]);
  assert.equal(await conservationStore.analysis(root, snapshotId), null, "a report retains no baseline analysis");
});

test("an analysis that left out a failed component covers it once its preparation succeeds", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  control.fail("packages/app/client.ts", "preparation_failed");
  const snapshotId = await capture(root);
  const partial = await ready(runtime, root, snapshotId);
  assert.equal(partial.status, "ready");
  assert.equal(partial.analysis.fileCoverage["packages/app/client.ts"], false);
  assert.deepEqual(partial.analysis.diagnostics.find((item) => item.code === "components_missing")?.components, ["root/app"]);
  control.recover("packages/app/client.ts");
  const complete = await ready(runtime, root, snapshotId);
  assert.equal(complete.status, "ready");
  assert.deepEqual(functions(complete.analysis), ["fetchUser", "retryRequest", "timeoutAfter"]);
  assert.equal(complete.analysis.fileCoverage["packages/app/client.ts"], true);
  assert.equal(complete.analysis.diagnostics.some((item) => item.code === "components_missing"), false);
  assert.deepEqual(functions(await conservationStore.analysis(root, snapshotId)), ["fetchUser", "retryRequest", "timeoutAfter"]);
  // Root and net were reused; app was tried twice.
  assert.equal(control.builds.length, 4);
});

test("an analysis whose every component failed retains nothing", async (t) => {
  const { root, storage } = await project(t, { files: { "packages/app/client.ts": "export function fetchUser() {}\n" } });
  const { runtime, control } = await fakeRuntime(storage);
  control.fail("packages/app/client.ts", "preparation_failed");
  control.fail(".prism/workflow.md", "preparation_failed");
  const snapshotId = await capture(root);
  const prepared = await ready(runtime, root, snapshotId);
  assert.equal(prepared.status, "degraded");
  assert.equal(prepared.analysis, null);
  assert.equal(await conservationStore.analysis(root, snapshotId), null);
});
