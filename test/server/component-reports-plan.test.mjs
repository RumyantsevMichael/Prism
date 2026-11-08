import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { entry, fakeRuntime, manifestPath, project, settled } from "./fixtures/component-indexes.mjs";

// A context plan's expected snapshot and a structural report's preparing answer in a repository that declares components.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-reports-plan-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { prepareNativeProvider, reportComplexUnits, searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");

test("a context plan accepts the snapshot of an unscoped search or its own source fingerprint, and refuses any other", async (t) => {
  const { root, storage } = await project(t);
  const { runtime } = await fakeRuntime(storage);
  const search = await searchRepositoryConcepts({ projectRoot: root, query: "retry" }, { runtime, waitMs: 2000 });
  assert.equal(search.status, "ready");
  const bySearch = await prepareNativeProvider(root, { runtime, waitMs: 2000, expectedSnapshot: search.snapshot });
  assert.equal(bySearch.preparation.status, "ready");
  const { sourceFingerprint } = await bySearch.provider.describe();
  const byPlan = await prepareNativeProvider(root, { runtime, waitMs: 2000, expectedSnapshot: sourceFingerprint });
  assert.equal(byPlan.preparation.status, "ready");
  await assert.rejects(prepareNativeProvider(root, { runtime, waitMs: 2000, expectedSnapshot: "0".repeat(64) }), { code: "stale_snapshot" });
});

test("a structural report answers preparing without a preparation id while no component is included", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  control.hold("packages/net/retry.ts");
  const found = await reportComplexUnits({ projectRoot: root }, { runtime, waitMs: 0 });
  assert.deepEqual([found.status, found.preparationId, found.units], ["preparing", null, []]);
  assert.equal(entry(found, "root/net").status, "preparing");
  assert.equal(found.diagnostics[0].code, "components_missing");
  control.release("packages/net/retry.ts");
  await settled(runtime, root);
  const ready = await reportComplexUnits({ projectRoot: root }, { runtime, waitMs: 2000 });
  assert.equal(ready.status, "ready");
  assert.equal(typeof ready.receiptId, "string");
});
