import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FILES, entry, fakeRuntime, manifestPath, project, settled } from "./fixtures/component-indexes.mjs";

// Acceptance tests of components.md §24-§26 for the component-indexes contract, clauses 9, 10, 12, 18, 19 for analysis receipts, and 20.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-reports-data-"));
// The shared runtime never downloads assets in these tests; each test passes its own runtime.
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { findSameNameUnits, reportModuleInterfaces, prepareNativeProvider } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { CompositeRepositoryIntelligence } = await import("../../dist/server/repository-intelligence/composite-repository-intelligence.mjs");
const { planRepositoryContext } = await import("../../dist/server/repository-intelligence/repository-intelligence.mjs");
const { callConservationTool } = await import("../../dist/server/conservation/conservation-tools.mjs");

const IS_OBJECT = "export function isObject(value) {\n  const kind = typeof value;\n  return value !== null && kind === 'object';\n}\n";
const REPORT_FILES = {
  ...FILES,
  "packages/net/is.ts": IS_OBJECT,
  "packages/app/is.ts": IS_OBJECT,
  "packages/app/client.ts": `import { retryRequest } from "../net/retry";\n${FILES["packages/app/client.ts"]}`
};
const options = (runtime, waitMs = 2000) => ({ runtime, waitMs });
const groupFiles = (found) => found.groups.map((group) => group.variants.flatMap((variant) => variant.members.map((member) => member.file)).sort());

test("clauses 10 and 18: an unscoped structural report reads every component as one union", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime, control } = await fakeRuntime(storage);
  const found = await findSameNameUnits({ projectRoot: root }, options(runtime));
  assert.equal(control.builds.length, 3);
  assert.equal(found.status, "ready");
  assert.deepEqual(groupFiles(found), [["packages/app/is.ts", "packages/net/is.ts"]]);
  assert.deepEqual((found.components ?? []).map((item) => [item.component, item.status]), [["root/root", "included"], ["root/net", "included"], ["root/app", "included"]]);
  const modules = await reportModuleInterfaces({ projectRoot: root, allModules: true, limit: 2 }, options(runtime));
  assert.equal(modules.status, "ready");
  assert.equal(modules.modules.length, 2);
  assert.equal(modules.totalModules, 4, "the limit applies to the union of the components");
  assert.equal(modules.nextOffset, 2);
});

test("clause 9: a path-scoped report answers only from the components that hold the paths", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime, control } = await fakeRuntime(storage);
  const scoped = await findSameNameUnits({ projectRoot: root, filters: { paths: ["packages/net"] } }, options(runtime));
  assert.deepEqual(control.builds.map((build) => build.files), [["packages/net/is.ts", "packages/net/retry.ts", "packages/net/timeout.ts"]]);
  assert.deepEqual(scoped.groups, []);
  assert.deepEqual((scoped.components ?? []).map((item) => item.component), ["root/net"]);
  // Importers count only in the selected components.
  const modules = async (input) => (await reportModuleInterfaces({ projectRoot: root, allModules: true, ...input }, options(runtime))).modules.find((module) => module.file === "packages/net/retry.ts");
  assert.equal((await modules({ filters: { paths: ["packages/net"] } })).importers, 0);
  assert.equal((await modules({})).importers, 1);
});

test("clause 12: a report while a component prepares names the component it left out", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime, control } = await fakeRuntime(storage);
  control.hold("packages/app/is.ts");
  const found = await findSameNameUnits({ projectRoot: root }, options(runtime, 300));
  assert.equal(found.status, "partial");
  assert.deepEqual(found.groups, []);
  assert.deepEqual([found.diagnostics[0]?.code, found.diagnostics[0]?.components], ["components_missing", ["root/app"]]);
  assert.equal(entry(found, "root/app").status, "preparing");
  control.release("packages/app/is.ts");
  await settled(runtime, root);
});

test("clause 19: an analysis receipt records the components, snapshot, and index revision of its report", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime } = await fakeRuntime(storage);
  const found = await findSameNameUnits({ projectRoot: root }, options(runtime));
  const receipt = await callConservationTool("get_conservation_evidence", { projectRoot: root, evidenceId: found.receiptId });
  assert.equal(receipt.kind, "repository-analysis");
  assert.deepEqual((receipt.components ?? []).map((item) => item.component), ["root/root", "root/net", "root/app"]);
  assert.deepEqual([receipt.components, receipt.snapshot, receipt.indexRevision], [found.components, found.snapshot, found.indexRevision]);
});

test("clause 20: a context plan merges every component and is not estimate-eligible while one is missing", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime, control } = await fakeRuntime(storage);
  control.hold("README.md");
  control.hold("packages/net/retry.ts");
  control.hold("packages/app/client.ts");
  const waiting = await prepareNativeProvider(root, options(runtime, 0));
  assert.equal(waiting.preparation.status, "preparing");
  control.release("README.md");
  control.release("packages/net/retry.ts");
  for (let attempt = 0; attempt < 100 && entry(await runtime.status(root), "root/net")?.status !== "ready"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const partial = await prepareNativeProvider(root, options(runtime, 0));
  const plan = await planRepositoryContext({ task: "retry the request", hints: { symbols: ["retryRequest"] }, provider: new CompositeRepositoryIntelligence(partial.provider) });
  const missing = plan.diagnostics.provider.find((item) => item.code === "components_missing");
  assert.deepEqual(missing?.components, ["root/app"]);
  assert.equal(plan.diagnostics.estimateEligible, false);
  assert.deepEqual([plan.tokenEstimate.lower, plan.tokenEstimate.expected, plan.tokenEstimate.upper], [null, null, null]);
  control.release("packages/app/client.ts");
  await settled(runtime, root);
  const complete = await prepareNativeProvider(root, options(runtime, 0));
  const evidence = await complete.provider.search("retry the request", {}, { topK: 10 });
  const files = new Set(evidence.hits.map((hit) => hit.node.file));
  assert.ok(files.has("packages/net/retry.ts") && files.has("packages/app/client.ts"), "the candidates come from every component");
  assert.equal(evidence.diagnostics.some((item) => item.code === "components_missing"), false);
});
