import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FILES, manifestPath, project } from "./fixtures/component-indexes.mjs";
import { stagedRuntime, until } from "./fixtures/staged-runtime.mjs";

// Acceptance tests of index-preparation.md §1 and §5 for the index-preparation contract, clauses 1, 5, and 15-19.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-index-structure-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { openNativeRepositoryIntelligence } = await import("../../dist/server/repository-intelligence/native-repository-intelligence.mjs");
const { searchRepositoryConcepts, findSameNameUnits, reportModuleInterfaces, prepareNativeProvider } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { readPublishedUnits } = await import("../../dist/server/repository-intelligence/index-status.mjs");
const { prepareAnalysis } = await import("../../dist/server/conservation/conservation-analysis.mjs");
const { conservationStore } = await import("../../dist/server/conservation/conservation-store.mjs");

const IS_OBJECT = "export function isObject(value) {\n  const kind = typeof value;\n  return value !== null && kind === 'object';\n}\n";
const REPORT_FILES = { ...FILES, "packages/net/is.ts": IS_OBJECT, "packages/app/is.ts": IS_OBJECT };
const HELD = "packages/net/timeout.ts";
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const pointer = async (runtime, root, component) => readJson(path.join((await runtime.location(root, component)).directory, "current.json"));
const NET = { name: "net", identity: "root/net", folder: "packages/net" };
const groupFiles = (found) => found.groups.map((group) => group.variants.flatMap((variant) => variant.members.map((member) => member.file)).sort());

// Starts a build of a repository without components that stops before it embeds the held file, after it reported structure.
async function heldBuild(t, files = REPORT_FILES) {
  const context = await project(t, { components: null, files });
  const staged = await stagedRuntime(context.storage);
  staged.control.hold(HELD);
  await staged.runtime.prepare(await openNativeRepositoryIntelligence(context.root), undefined, 0);
  await staged.control.reached(HELD);
  await until(async () => (await pointer(staged.runtime, context.root).catch(() => null))?.stage === "structure", "The structure was not published.");
  return { ...context, ...staged };
}

test("clauses 1 and 15: a reported structure is stored with its sidecar and pointers before embeddings, and the complete index replaces it", async (t) => {
  const { root, runtime, control } = await heldBuild(t);
  const directory = (await runtime.location(root)).directory;
  const structure = await pointer(runtime, root);
  assert.equal(structure.stage, "structure");
  assert.match(structure.revision, /^[a-f0-9]{64}$/);
  const generation = await readJson(path.join(directory, `generation-${structure.snapshot}-fake-assets.json`));
  assert.deepEqual([generation.stage, generation.revision], ["structure", structure.revision]);
  const sidecar = await readJson(path.join(directory, `units-${structure.revision}.json`));
  assert.ok(sidecar.units.some((unit) => unit.name === "isObject"));
  const stored = await readJson(path.join(directory, `${structure.revision}.json`));
  assert.ok(stored.chunks.length > 0 && stored.chunks.every((chunk) => chunk.embedding === undefined), "a structure-only index holds no embeddings");
  control.release(HELD);
  const complete = await until(async () => { const value = await pointer(runtime, root); return value.stage === "complete" && value; }, "The complete index was not published.");
  assert.equal(complete.snapshot, structure.snapshot);
  assert.notEqual(complete.revision, structure.revision);
  const replaced = await readJson(path.join(directory, `generation-${structure.snapshot}-fake-assets.json`));
  assert.deepEqual([replaced.stage, replaced.revision], ["complete", complete.revision]);
});

test("clause 16: structural reports answer from the structure without waiting for embeddings", async (t) => {
  const { root, runtime, control } = await heldBuild(t);
  const structure = await pointer(runtime, root);
  const found = await findSameNameUnits({ projectRoot: root }, { runtime, waitMs: 0 });
  assert.equal(found.status, "ready");
  assert.equal(found.indexRevision, structure.revision);
  assert.deepEqual(groupFiles(found), [["packages/app/is.ts", "packages/net/is.ts"]]);
  const modules = await reportModuleInterfaces({ projectRoot: root, allModules: true }, { runtime, waitMs: 0 });
  assert.equal(modules.status, "ready");
  assert.ok(modules.modules.length > 0);
  assert.equal(control.builds.length, 1, "the reports join the running build");
  control.release(HELD);
});

test("clause 16: the review browser's published units come from the structure", async (t) => {
  const { root, storage, runtime, control } = await heldBuild(t);
  const structure = await pointer(runtime, root);
  const view = await readPublishedUnits(root, [storage]);
  assert.equal(view?.revision, structure.revision);
  assert.ok(view.units.some((unit) => unit.file === "packages/net/is.ts" && unit.name === "isObject"));
  control.release(HELD);
});

test("clause 16: conservation analysis of a retained baseline answers from its structure", async (t) => {
  const { root, storage } = await project(t, { components: null, files: REPORT_FILES });
  const { runtime, control } = await stagedRuntime(storage);
  const { snapshotId } = await conservationStore.capture(root);
  control.hold(HELD);
  const first = await prepareAnalysis(root, snapshotId, { runtime });
  await control.reached(HELD);
  // Each call waits at most ten seconds for the build, which the structure must make unnecessary.
  const ready = first.status === "ready" ? first : await prepareAnalysis(root, snapshotId, { runtime });
  assert.equal(ready.status, "ready", "the analysis answers from the structure");
  assert.ok(ready.analysis.units.some((unit) => unit.name === "isObject"));
  assert.equal(control.builds.length, 1);
  control.release(HELD);
});

test("clause 16: another session answers a report from a structure that this session stored, while this session embeds", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const first = await stagedRuntime(storage);
  first.control.hold(HELD);
  await searchRepositoryConcepts({ projectRoot: root, query: "retry", filters: { paths: ["packages/net"] } }, { runtime: first.runtime, waitMs: 0 });
  await first.control.reached(HELD);
  await until(async () => (await pointer(first.runtime, root, NET).catch(() => null))?.stage === "structure", "The net structure was not published.");
  const later = await stagedRuntime(storage);
  const found = await findSameNameUnits({ projectRoot: root, filters: { paths: ["packages/net/is.ts"] } }, { runtime: later.runtime, waitMs: 500 });
  const net = found.components.find((item) => item.component === "root/net");
  assert.equal(net.status, "included");
  assert.equal(net.indexRevision, (await pointer(first.runtime, root, NET)).revision);
  first.control.release(HELD);
});

test("clause 17: the status gives each index's stage, and a build that embeds after its structure stays preparing", async (t) => {
  const fresh = await project(t, { components: null });
  const idle = await stagedRuntime(fresh.storage);
  assert.equal((await idle.runtime.status(fresh.root)).stage, "none");
  const { root, runtime, control } = await heldBuild(t);
  const status = await runtime.status(root);
  assert.deepEqual([status.status, status.stage], ["preparing", "structure"]);
  control.release(HELD);
  const done = await until(async () => { const value = await runtime.status(root); return value.status === "ready" && value; }, "The build did not finish.");
  assert.equal(done.stage, "complete");
});

test("clause 17: each component's status entry gives its stage", async (t) => {
  const { root, storage } = await project(t, { files: REPORT_FILES });
  const { runtime, control } = await stagedRuntime(storage);
  control.hold(HELD);
  await searchRepositoryConcepts({ projectRoot: root, query: "retry", filters: { paths: ["packages/net"] } }, { runtime, waitMs: 0 });
  await control.reached(HELD);
  const status = await until(async () => { const value = await runtime.status(root); return value.components?.find((item) => item.component === "root/net")?.stage === "structure" && value; }, "The net stage did not become structure.");
  const stages = Object.fromEntries(status.components.map((item) => [item.component, item.stage]));
  assert.deepEqual(stages, { "root/root": "none", "root/net": "structure", "root/app": "none" });
  assert.equal(status.components.find((item) => item.component === "root/net").status, "preparing");
  control.release(HELD);
});

test("clauses 5 and 18: a search of a structure-only index answers lexically and says that it answered without embeddings", async (t) => {
  const { root, runtime, control } = await heldBuild(t);
  const found = await searchRepositoryConcepts({ projectRoot: root, query: "retry the request" }, { runtime, waitMs: 0 });
  assert.equal(found.status, "ready");
  assert.ok(found.results.length > 0);
  assert.ok(found.results.every((result) => result.cosineSimilarity === null));
  assert.equal(control.searches.at(-1).mode, "lexical");
  const pending = found.diagnostics.find((item) => item.code === "embeddings_pending");
  assert.equal(pending?.message, "Lexical results answered without embeddings for the index; repeat the search after the build finishes for a hybrid ranking.");
  assert.equal("components" in pending, false);
  assert.equal(found.capabilities.semanticSearch, false);
  assert.equal(found.capabilities.hybridSearch, false);
  control.release(HELD);
  await until(async () => (await runtime.status(root)).status === "ready", "The build did not finish.");
  const hybrid = await searchRepositoryConcepts({ projectRoot: root, query: "retry the request" }, { runtime, waitMs: 0 });
  assert.equal(hybrid.diagnostics.some((item) => item.code === "embeddings_pending"), false);
  assert.ok(hybrid.results.some((result) => result.cosineSimilarity !== null));
  assert.equal(hybrid.capabilities.semanticSearch, true);
});

test("clause 18: in a repository with components only the structure-only component is marked pending, after components_missing", async (t) => {
  const { root, storage, write } = await project(t, { files: REPORT_FILES });
  const { runtime, control } = await stagedRuntime(storage);
  assert.equal((await searchRepositoryConcepts({ projectRoot: root, query: "retry" }, { runtime, waitMs: 2000 })).status, "ready");
  await write(HELD, `${FILES[HELD]}// changed\n`);
  await write("packages/app/client.ts", `${FILES["packages/app/client.ts"]}// changed\n`);
  control.hold(HELD);
  control.hold("packages/app/client.ts", "structure");
  const found = await searchRepositoryConcepts({ projectRoot: root, query: "retry" }, { runtime, waitMs: 0 });
  await control.reached(HELD);
  const answer = await until(async () => {
    const value = await searchRepositoryConcepts({ projectRoot: root, query: "retry" }, { runtime, waitMs: 0 });
    return value.components?.find((item) => item.component === "root/net")?.status === "included" && value;
  }, "The net component was not included from its structure.");
  assert.ok(found);
  const entries = Object.fromEntries(answer.components.map((item) => [item.component, item]));
  assert.equal(entries["root/net"].embeddings, "pending");
  assert.equal("embeddings" in entries["root/root"], false);
  assert.equal("embeddings" in entries["root/app"], false);
  const codes = answer.diagnostics.map((item) => item.code);
  assert.deepEqual(codes.slice(0, 2), ["components_missing", "embeddings_pending"]);
  const pending = answer.diagnostics[1];
  assert.deepEqual(pending.components, ["root/net"]);
  assert.equal(pending.message, "Lexical results answered without embeddings for root/net; repeat the search after the build finishes for a hybrid ranking.");
  assert.equal(answer.capabilities.semanticSearch, true, "the root component's complete index answers with embeddings");
  assert.ok(answer.results.filter((result) => result.component === "root/net").every((result) => result.cosineSimilarity === null));
  control.release(HELD);
  control.release("packages/app/client.ts");
});

test("clause 19: a context plan keeps waiting for a complete index", async (t) => {
  const { root, runtime, control } = await heldBuild(t);
  const { preparation } = await prepareNativeProvider(root, { runtime, waitMs: 0 });
  assert.equal(preparation.status, "preparing");
  control.release(HELD);
});
