import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FILES, fakeRuntime, manifestPath, project, settled } from "./fixtures/component-indexes.mjs";

// Conservation evidence over a retained baseline whose analysis leaves out a failed component: what the analysis cannot see must stay an explicit
// check, and a component index reused between a baseline and the live project must be the index its own content builds.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-baseline-evidence-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { compareChangeMap, assessDeltaReadiness, prepareAnalysis } = await import("../../dist/server/conservation/conservation-analysis.mjs");
const { conservationStore } = await import("../../dist/server/conservation/conservation-store.mjs");
const { updateChangeMap } = await import("../../dist/server/conservation/change-map.mjs");
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");

const body = (name, lines) => `export function ${name}(value) {\n${Array.from({ length: lines }, (_, index) => `  value = value + ${index};`).join("\n")}\n  return value;\n}\n`;
const symbol = (file, value) => ({ path: file, selector: { type: "symbol", value } });
const key = { initiative: "plan", slice: "slice" };
const until = async (runtime, root, call, waiting) => {
  let result = await call();
  for (let attempt = 0; attempt < 20 && waiting(result); attempt++) { await settled(runtime, root); result = await call(); }
  return result;
};

async function comparison(t, failApp) {
  const { root, storage, write } = await project(t, { files: { ...FILES, "packages/app/client.ts": body("fetchUser", 12) } });
  const { runtime, control } = await fakeRuntime(storage);
  if (failApp) control.fail("packages/app/client.ts", "resource_limit");
  const baselineId = (await conservationStore.capture(root, key)).snapshotId;
  await write("packages/net/copy.ts", body("fetchUser", 12));
  const resultSnapshotId = (await conservationStore.capture(root, key)).snapshotId;
  const map = await updateChangeMap({ projectRoot: root, ...key, expectedRevision: null, scope: ["packages/net"], baselineId, requirements: [{ path: "README.md" }],
    operations: [{ op: "insert", entry: { id: "add-copy", kind: "rule", label: "add", action: "ADD", before: [], after: [symbol("packages/net/copy.ts", "fetchUser")],
      reason: "Satisfy the bound requirement.", requirements: [{ path: "README.md" }] } }] });
  const compared = await until(runtime, root, () => compareChangeMap({ projectRoot: root, ...key, expectedRevision: map.revision, baselineId, resultSnapshotId }, { runtime }), result => result.status === "preparing");
  return (await conservationStore.get(root, compared.comparisonId, "comparison")).observations;
}

test("a comparison over an analysis that leaves out a failed component requires a check of the detector diff", async (t) => {
  const included = await comparison(t, false);
  assert.ok(included.some(item => item.code === "duplication_introduced" && item.severity === "failure" && item.file === "packages/net/copy.ts"));
  assert.equal(included.some(item => item.code === "detector_diff_unknown"), false);
  const failed = await comparison(t, true);
  const unknown = failed.filter(item => item.code === "detector_diff_unknown");
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].severity, "review_required");
  assert.equal(unknown[0].file, undefined, "a copy can join any changed file with the left-out component, so the check covers the whole change");
  assert.match(unknown[0].message, /root\/app/);
});

async function readiness(t, failApp) {
  const files = { ...FILES, "packages/app/a.ts": body("readLockOwner", 12), "packages/app/b.ts": body("readLockOwner", 12) };
  const { root, storage } = await project(t, { files });
  const { runtime, control } = await fakeRuntime(storage);
  if (failApp) control.fail("packages/app/a.ts", "preparation_failed");
  const baselineId = (await conservationStore.capture(root, key)).snapshotId;
  const entry = (id, file) => ({ id, kind: "rule", label: id, action: "ADD", before: [], after: [symbol(file, id)], reason: "r" });
  const document = { schemaVersion: 2, scope: ["packages/app"], baselineId, requirements: [{ path: "README.md" }], concepts: [entry("reportA", "packages/app/a.ts"), entry("reportB", "packages/app/b.ts")] };
  const check = async () => (await assessDeltaReadiness(root, document, conservationStore, { runtime })).filter(item => item.code.startsWith("duplication"));
  return { root, runtime, control, baselineId, check: () => until(runtime, root, check, found => found.some(item => item.code === "duplication_check_preparing")) };
}

test("readiness names the files of a failed component that its duplication check cannot see, and checks them once the component recovers", async (t) => {
  const included = await readiness(t, false);
  assert.deepEqual((await included.check()).map(item => [item.code, item.blocking]), [["duplication_growth", true]]);
  const failed = await readiness(t, true);
  const found = await failed.check();
  assert.deepEqual(found.map(item => [item.code, item.blocking]), [["duplication_check_unavailable", false]]);
  assert.match(found[0].message, /root\/app/);
  assert.match(found[0].message, /packages\/app\/a\.ts, packages\/app\/b\.ts/);
  assert.ok((await conservationStore.analysis(failed.root, failed.baselineId)).diagnostics.some(item => item.code === "components_missing"), "the partial analysis is stored");
  // Readiness prepares the stored partial analysis again, as a comparison does, so the recovered component's duplication blocks.
  failed.control.recover("packages/app/a.ts");
  assert.deepEqual((await failed.check()).map(item => [item.code, item.blocking]), [["duplication_growth", true]]);
});

test("a component index reused between a baseline and the live project is as complete as the component's own content", async (t) => {
  const search = async (baselineFirst) => {
    // A file above the 2 MiB per-file limit in app makes the whole baseline incomplete, but not net, whose files are all retained.
    const { root, storage } = await project(t, { files: { ...FILES, "packages/app/big.txt": "x".repeat(3 * 1024 * 1024) } });
    const { runtime } = await fakeRuntime(storage);
    if (baselineFirst) {
      const snapshotId = (await conservationStore.capture(root)).snapshotId;
      assert.equal((await until(runtime, root, () => prepareAnalysis(root, snapshotId, { runtime }), result => result.status === "preparing")).status, "ready");
    }
    const live = await searchRepositoryConcepts({ projectRoot: root, query: "retry the request", filters: { paths: ["packages/net"] } }, { runtime, waitMs: 2000 });
    return live.diagnostics.filter(item => item.component === "root/net").map(item => item.code);
  };
  assert.deepEqual(await search(true), await search(false));
});
