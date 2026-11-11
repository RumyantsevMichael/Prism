import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FILES, manifestPath, project } from "./fixtures/component-indexes.mjs";
import { stagedRuntime, until } from "./fixtures/staged-runtime.mjs";

// Acceptance tests of index-preparation.md §9 for the index-preparation contract, clauses 25-27.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-sibling-reports-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const provider = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { conservationStore } = await import("../../dist/server/conservation/conservation-store.mjs");

const IS_OBJECT = "export function isObject(value) {\n  const kind = typeof value;\n  return value !== null && kind === 'object';\n}\n";
const REPORT_FILES = {
  ...FILES,
  "packages/net/is.ts": IS_OBJECT,
  "packages/app/is.ts": IS_OBJECT,
  "packages/app/client.ts": `import { retryRequest } from "../net/retry";\n${FILES["packages/app/client.ts"]}`
};
const NET_FILES = ["packages/net/is.ts", "packages/net/retry.ts", "packages/net/timeout.ts"];
const APP_FILES = ["packages/app/client.ts", "packages/app/is.ts"];
const ROOT_FILES = [".prism/workflow.md", "README.md"];
const scoped = { filters: { paths: ["packages/net"] } };
const groupFiles = (found) => found.groups.map((group) => group.variants.flatMap((variant) => variant.members.map((member) => member.file)).sort());
const states = (found) => (found.components ?? []).map((item) => [item.component, item.status]);
const buildOf = (control, files) => control.builds.find((build) => JSON.stringify(build.files) === JSON.stringify(files));
const pointer = async (runtime, root, component) => JSON.parse(await readFile(path.join((await runtime.location(root, component)).directory, "current.json"), "utf8"));
const APP = { name: "app", identity: "root/app", folder: "packages/app" };

test("clauses 25 and 26: a scoped same-name report keeps a group's members in sibling components, which it prepares with structure only", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime, control } = await stagedRuntime(storage);
  const found = await provider.findSameNameUnits({ projectRoot: root, ...scoped }, { runtime, waitMs: 2000 });
  assert.equal(found.status, "ready");
  assert.deepEqual(groupFiles(found), [["packages/app/is.ts", "packages/net/is.ts"]]);
  assert.deepEqual(states(found), [["root/root", "included"], ["root/net", "included"], ["root/app", "included"]]);
  assert.equal(buildOf(control, NET_FILES)?.fragmentsOnly, false, "the scoped component is prepared as today");
  assert.equal(buildOf(control, APP_FILES)?.fragmentsOnly, true, "a sibling is prepared with structure only");
  assert.equal(buildOf(control, ROOT_FILES)?.fragmentsOnly, true);
  assert.equal((await pointer(runtime, root, APP)).stage, "structure", "a structure-only preparation embeds nothing");
  const status = await runtime.status(root);
  assert.equal(status.components.find((item) => item.component === "root/app").status, "ready");
});

test("clause 25: a scoped module report counts importers in sibling components", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime } = await stagedRuntime(storage);
  const modules = await provider.reportModuleInterfaces({ projectRoot: root, allModules: true, ...scoped }, { runtime, waitMs: 2000 });
  assert.equal(modules.status, "ready");
  const retry = modules.modules.find((module) => module.file === "packages/net/retry.ts");
  assert.equal(retry?.importers, 1, "the importer in packages/app counts");
  assert.ok(modules.modules.every((module) => module.file.startsWith("packages/net/")), "only modules inside the paths are reported");
});

test("clause 25: scoped shared-literal and shared-dependency reports read every component", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime } = await stagedRuntime(storage);
  for (const report of [provider.findSharedLiterals, provider.findSharedDependencies]) {
    const found = await report({ projectRoot: root, ...scoped }, { runtime, waitMs: 2000 });
    assert.equal(found.status, "ready");
    assert.deepEqual(states(found), [["root/root", "included"], ["root/net", "included"], ["root/app", "included"]]);
  }
});

test("clause 26: a sibling that is not yet included is named by components_missing and leaves the result partial", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime, control } = await stagedRuntime(storage);
  control.hold("packages/app/is.ts", "structure");
  const found = await provider.findSameNameUnits({ projectRoot: root, ...scoped }, { runtime, waitMs: 500 });
  assert.equal(found.status, "partial");
  assert.equal(states(found).find(([component]) => component === "root/net")[1], "included");
  assert.notEqual(states(found).find(([component]) => component === "root/app")[1], "included");
  assert.equal(found.diagnostics[0].code, "components_missing");
  assert.ok(found.diagnostics[0].components.includes("root/app"));
  control.release("packages/app/is.ts");
});

test("clause 27: scoped cohesion and complex-unit reports read only the components that hold the paths", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime, control } = await stagedRuntime(storage);
  for (const report of [provider.reportCohesionClusters, provider.reportComplexUnits]) {
    const found = await report({ projectRoot: root, ...scoped }, { runtime, waitMs: 2000 });
    assert.deepEqual(states(found), [["root/net", "included"]]);
  }
  assert.deepEqual(control.builds.map((build) => build.files), [NET_FILES]);
});

test("clause 26: a search that needs a sibling's embeddings prepares it in full after its structure-only preparation", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime, control } = await stagedRuntime(storage);
  await provider.findSameNameUnits({ projectRoot: root, ...scoped }, { runtime, waitMs: 2000 });
  const found = await provider.searchRepositoryConcepts({ projectRoot: root, query: "is object", filters: { paths: ["packages/app"] } }, { runtime, waitMs: 2000 });
  await until(async () => (await pointer(runtime, root, APP)).stage === "complete", "The app component was not prepared in full.");
  assert.ok(control.builds.filter((build) => JSON.stringify(build.files) === JSON.stringify(APP_FILES)).some((build) => !build.fragmentsOnly));
  assert.ok(found);
});

test("clause 25: a scoped report of a retained baseline reads the baseline's sibling components", async (t) => {
  const { root, storage, write } = await project(t, { files: REPORT_FILES });
  const { runtime } = await stagedRuntime(storage);
  const { snapshotId } = await conservationStore.capture(root);
  await write("packages/app/is.ts", "export const gone = 1;\n");
  let found = await provider.findSameNameUnits({ projectRoot: root, snapshotId, ...scoped }, { runtime, waitMs: 2000 });
  if (found.status !== "ready") found = await provider.findSameNameUnits({ projectRoot: root, snapshotId, ...scoped }, { runtime, waitMs: 2000 });
  assert.equal(found.snapshotId, snapshotId);
  assert.deepEqual(groupFiles(found), [["packages/app/is.ts", "packages/net/is.ts"]]);
});
