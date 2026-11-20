import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FILES, fakeRuntime, manifestPath, project, settled } from "./fixtures/component-indexes.mjs";

// Acceptance tests of index-preparation.md §10 for the index-preparation contract, clauses 28 and 29.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-library-coverage-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { openNativeRepositoryIntelligence } = await import("../../dist/server/repository-intelligence/native-repository-intelligence.mjs");
const { findSameNameUnits } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");

const COVERAGE_FILES = {
  ...FILES,
  "packages/app/extra.ts": "export function parseBody(text) {\n  return JSON.parse(text);\n}\n",
  "packages/app/broken.ts": "export function broken( {\n"
};
// What the code graph could not resolve in each file, as a runtime reports it.
const UNRESOLVED = {
  // A global call and a package import point outside the indexed source.
  "packages/net/retry.ts": [{ name: "fetch", kind: "calls" }, { name: "lodash", kind: "imports" }],
  // retryRequest is a function of this index, so this is a missing link inside the source.
  "packages/net/timeout.ts": [{ name: "retryRequest", kind: "calls" }],
  // A relative import names a file of the source.
  "packages/app/client.ts": [{ name: "./missing", kind: "imports" }, { name: "console.log", kind: "calls" }],
  // The last segment of JSON.parse and Http::Client names no unit of the index.
  "packages/app/extra.ts": [{ name: "JSON.parse", kind: "calls" }, { name: "Http::Client", kind: "instantiates" }]
};
const unresolvedDiagnostic = (file, count) => ({ code: "incomplete_structure", file, count, message: "The graph has unresolved references in this file." });

// A test runtime whose builds report unresolved references by file and mark those files uncovered, as the runtime does before this contract.
async function coverageRuntime(storage, { reportUnresolved = true, unresolved = UNRESOLVED } = {}) {
  const fake = await fakeRuntime(storage);
  const helper = fake.runtime.helper();
  fake.runtime.helper = () => ({
    async request(method, args, progress) {
      const index = await helper.request(method, args, progress);
      if (method !== "build") return index;
      for (const [file, references] of Object.entries(unresolved)) if (file in index.fileCoverage) {
        index.fileCoverage[file] = false;
        index.diagnostics.push(unresolvedDiagnostic(file, references.length));
      }
      if ("packages/app/broken.ts" in index.fileCoverage) {
        index.fileCoverage["packages/app/broken.ts"] = false;
        index.syntaxCoverage["packages/app/broken.ts"] = false;
        index.diagnostics.push({ code: "incomplete_structure", file: "packages/app/broken.ts", message: "The graph SDK omitted or could not parse a source file." });
      }
      if (reportUnresolved) index.unresolvedByFile = Object.fromEntries(Object.entries(unresolved).filter(([file]) => file in index.fileCoverage));
      return index;
    }
  });
  return fake;
}

const storedCoverage = async (runtime, root) => {
  const directory = (await runtime.location(root)).directory;
  const { revision } = JSON.parse(await readFile(path.join(directory, "current.json"), "utf8"));
  return JSON.parse(await readFile(path.join(directory, `${revision}.json`), "utf8")).fileCoverage;
};

test("clauses 28 and 29: a file whose unresolved references all point outside the indexed source is covered", async (t) => {
  const { root, storage } = await project(t, { components: null, files: COVERAGE_FILES });
  const { runtime } = await coverageRuntime(storage);
  await runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 0);
  const status = await settled(runtime, root);
  assert.deepEqual(await storedCoverage(runtime, root), {
    ".prism/workflow.md": true,
    "README.md": true,
    "packages/app/broken.ts": false,
    "packages/app/client.ts": false,
    "packages/app/extra.ts": true,
    "packages/net/retry.ts": true,
    "packages/net/timeout.ts": false
  });
  assert.equal(status.coverage.structurallyCoveredFiles, 4);
  assert.equal(status.coverage.complete, false);
  // The diagnostics still disclose every unresolved reference.
  assert.ok(status.diagnostics.some((item) => item.file === "packages/net/retry.ts" && item.code === "incomplete_structure"));
});

test("clause 29: a name that the index defines only through its last segment keeps a file uncovered", async (t) => {
  const { root, storage } = await project(t, { components: null, files: COVERAGE_FILES });
  // service#fetchUser and api.client.fetchUser end in fetchUser, a function of packages/app/client.ts.
  const unresolved = { "packages/app/extra.ts": [{ name: "service#fetchUser", kind: "references" }], "packages/net/retry.ts": [{ name: "api.client.fetchUser", kind: "calls" }] };
  const { runtime } = await coverageRuntime(storage, { unresolved });
  await runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 0);
  await settled(runtime, root);
  const coverage = await storedCoverage(runtime, root);
  assert.deepEqual([coverage["packages/app/extra.ts"], coverage["packages/net/retry.ts"], coverage["packages/net/timeout.ts"]], [false, false, true]);
});

test("clause 29: reports count the coverage that Prism computed", async (t) => {
  const { root, storage } = await project(t, { files: COVERAGE_FILES });
  const { runtime } = await coverageRuntime(storage);
  const found = await findSameNameUnits({ projectRoot: root, filters: { paths: ["packages/net"] } }, { runtime, waitMs: 10000 });
  assert.equal(found.status, "ready");
  const status = await runtime.status(root);
  const net = status.components.find((item) => item.component === "root/net");
  assert.equal(net.coverage.structurallyCoveredFiles, 1, "retry.ts is covered and timeout.ts is not, inside the net component");
});

test("clause 29: in a component, a call that names only a sibling component's function points outside its index", async (t) => {
  const { root, storage } = await project(t, { files: COVERAGE_FILES });
  // retryRequest is a function of the net component, which the app component's index does not hold.
  const { runtime } = await coverageRuntime(storage, { unresolved: { "packages/app/extra.ts": [{ name: "retryRequest", kind: "calls" }] } });
  await findSameNameUnits({ projectRoot: root }, { runtime, waitMs: 10000 });
  const status = await runtime.status(root);
  const app = status.components.find((item) => item.component === "root/app");
  assert.equal(app.coverage.structurallyCoveredFiles, 2, "client.ts and extra.ts are covered, broken.ts did not parse");
});

test("clause 29: an index without unresolvedByFile keeps the coverage its runtime reported", async (t) => {
  const { root, storage } = await project(t, { components: null, files: COVERAGE_FILES });
  const { runtime } = await coverageRuntime(storage, { reportUnresolved: false });
  await runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 0);
  const status = await settled(runtime, root);
  assert.equal((await storedCoverage(runtime, root))["packages/net/retry.ts"], false);
  assert.equal(status.coverage.structurallyCoveredFiles, 2);
});
