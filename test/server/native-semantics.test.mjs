import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, utimes, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { NativeSemanticRuntime, pruneAssets, pruneIndexes } from "../../dist/server/repository-intelligence/native-semantic-runtime.mjs";
import { SemanticNativeRepositoryIntelligence, findSameNameUnits, findSharedDependencies, findSharedLiterals, reportCohesionClusters, reportComplexUnits, reportModuleInterfaces, searchRepositoryConcepts, validateConceptSearch, validateCohesion, validateComplexUnits, validateModuleInterfaces, validateSameNameUnits, validateSharedDependencies, validateSharedLiterals } from "../../dist/server/repository-intelligence/semantic-native-provider.mjs";
import { openNativeRepositoryIntelligence } from "../../dist/server/repository-intelligence/native-repository-intelligence.mjs";
import { CompositeRepositoryIntelligence } from "../../dist/server/repository-intelligence/composite-repository-intelligence.mjs";
import { planRepositoryContext } from "../../dist/server/repository-intelligence/repository-intelligence.mjs";
import { withFileLock } from "../../dist/server/workflow/artifact-store.mjs";
import { callConservationTool } from "../../dist/server/conservation/conservation-tools.mjs";
const manifestPath = fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url));

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-semantics-")));
  const root = path.join(directory, "project"); await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root };
}
test("discovery is passive and degraded lexical search retains filters and source hashes", async t => {
  const { directory, root } = await fixture(t);
  await mkdir(path.join(root, "instructions"));
  await writeFile(path.join(root, "instructions/retry.md"), "Retry transient network failures.\n");
  const runtime = new NativeSemanticRuntime({ directory: path.join(directory, "cache"), manifestPath });
  assert.equal((await runtime.status(root)).status, "unprepared");
  await assert.rejects(readFile(path.join(directory, "cache/current.json")), { code: "ENOENT" });
  const found = await searchRepositoryConcepts({ projectRoot: root, query: "network", filters: { domains: ["instruction"] } }, { runtime });
  assert.equal(found.status, "degraded");
  assert.equal(found.results.length, 1);
  assert.match(found.results[0].sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(found.results[0].cosineSimilarity, null);
  assert.ok(found.diagnostics.some(item => item.code === "unsupported_runtime"));
});
test("shared dependency groups need the prepared index and report a degraded runtime without groups", async t => {
  const { directory, root } = await fixture(t);
  await writeFile(path.join(root, "a.mjs"), "export function a() { return 1; }\n");
  const runtime = new NativeSemanticRuntime({ directory: path.join(directory, "cache"), manifestPath });
  const found = await findSharedDependencies({ projectRoot: root }, { runtime });
  assert.equal(found.status, "degraded");
  assert.deepEqual(found.groups, []);
  assert.equal(found.coverage, null);
  assert.ok(found.diagnostics.some(item => item.code === "unsupported_runtime"));
});
test("module interface reports need the prepared index and report a degraded runtime without modules", async t => {
  const { directory, root } = await fixture(t);
  await writeFile(path.join(root, "a.mjs"), "export function a() { return 1; }\n");
  const runtime = new NativeSemanticRuntime({ directory: path.join(directory, "cache"), manifestPath });
  const found = await reportModuleInterfaces({ projectRoot: root }, { runtime });
  assert.equal(found.status, "degraded");
  assert.deepEqual([found.modules, found.delegatingClasses, found.coverage], [[], [], null]);
  for (const input of [{ offset: -1 }, { offset: 1.5 }, { allModules: "yes" }, { includeTests: true }, { limit: 101 }, { filters: { paths: ["/abs"] } }])
    assert.throws(() => validateModuleInterfaces({ projectRoot: "/tmp", ...input }), error => ["validation_failed", "invalid_path"].includes(error.code), JSON.stringify(input));
  validateModuleInterfaces({ projectRoot: "/tmp", offset: 20, limit: 100, allModules: true, filters: { paths: ["src"] } });
});
test("shared literal groups and cohesion clusters need the prepared index and report a degraded runtime without results", async t => {
  const { directory, root } = await fixture(t);
  await writeFile(path.join(root, "a.mjs"), "export function a() { return 'alpha'; }\n");
  const runtime = new NativeSemanticRuntime({ directory: path.join(directory, "cache"), manifestPath });
  const literals = await findSharedLiterals({ projectRoot: root }, { runtime });
  assert.deepEqual([literals.status, literals.groups, literals.shapes, literals.coverage], ["degraded", [], [], null]);
  const cohesion = await reportCohesionClusters({ projectRoot: root }, { runtime });
  assert.deepEqual([cohesion.status, cohesion.containers, cohesion.coverage], ["degraded", [], null]);
  assert.ok(cohesion.diagnostics.some(item => item.code === "unsupported_runtime"));
  for (const [name, call] of [["groups", findSameNameUnits], ["units", reportComplexUnits]]) {
    const found = await call({ projectRoot: root }, { runtime });
    assert.deepEqual([found.status, found[name], found.coverage], ["degraded", [], null], name);
  }
  for (const validate of [validateSharedLiterals, validateCohesion, validateSameNameUnits, validateComplexUnits]) {
    for (const input of [{ limit: 0 }, { offset: 1 }, { allModules: true }, { includeTests: "yes" }, { filters: { paths: ["../outside"] } }])
      assert.throws(() => validate({ projectRoot: "/tmp", ...input }), error => ["validation_failed", "invalid_path"].includes(error.code), JSON.stringify(input));
    validate({ projectRoot: "/tmp", limit: 100, includeTests: true, filters: { paths: ["src"] } });
  }
});
test("prepared shared literal groups read snapshot files, leave out tests by default, and apply path filters", async t => {
  const { root } = await fixture(t);
  const files = {
    "src/states.mjs": "export const PHASES = ['applying', 'available', 'awaiting-consent'];\n",
    "src/panel.mjs": "export function render(phase) {\n  return phase === 'applying' ? 'available' : 'awaiting-consent';\n}\n",
    "test/panel.test.mjs": "test('phases', () => ['applying', 'available', 'awaiting-consent']);\n"
  };
  const units = [];
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
    units.push({ id: file, file, kind: file.startsWith("test/") ? "function" : file.includes("states") ? "constant" : "function", name: path.basename(file), domain: "code",
      range: { startLine: 1, endLine: content.split("\n").length - 1 }, span: { start: 0, end: content.length } });
  }
  const runtime = { prepare: async source => ({ status: "ready", snapshot: (await source.snapshot()).sourceFingerprint, preparationId: "test", diagnostics: [],
    prepared: { index: { units, edges: [], structureComplete: true }, revision: "test", modelIdentity: "test" } }) };
  const found = await findSharedLiterals({ projectRoot: root }, { runtime });
  assert.equal(found.status, "ready");
  assert.deepEqual(found.groups.map(group => group.members.map(member => member.file).sort()), [["src/panel.mjs", "src/states.mjs"]]);
  const withTests = await findSharedLiterals({ projectRoot: root, includeTests: true }, { runtime });
  assert.deepEqual(withTests.groups[0].members.map(member => member.file).sort(), ["src/panel.mjs", "src/states.mjs", "test/panel.test.mjs"]);
  // A path filter keeps a group with one member inside it, together with the members elsewhere.
  assert.deepEqual((await findSharedLiterals({ projectRoot: root, filters: { paths: ["src/panel.mjs"] } }, { runtime })).groups.map(group => group.members.map(member => member.file).sort()), [["src/panel.mjs", "src/states.mjs"]]);
  assert.deepEqual((await findSharedLiterals({ projectRoot: root, filters: { paths: ["lib"] } }, { runtime })).groups, []);
  const cohesion = await reportCohesionClusters({ projectRoot: root }, { runtime });
  assert.deepEqual([cohesion.status, cohesion.containers, cohesion.coverage], ["ready", [], { examinedContainers: 0, reportedContainers: 0 }]);
  // Each analysis retains its complete result, with the hash of every file that the result names.
  const receipt = await callConservationTool("get_conservation_evidence", { projectRoot: root, evidenceId: found.receiptId });
  assert.deepEqual([receipt.kind, receipt.tool, receipt.section, receipt.totalCount, receipt.snapshot], ["repository-analysis", "find_shared_literals", "groups", 1, found.snapshot]);
  // The response shortens long literal lists, and the receipt keeps the complete groups.
  assert.deepEqual(receipt.entries, found.groups.map(({ literalCount, ...group }) => group));
  assert.equal(found.groups[0].literalCount, 3);
  assert.deepEqual(receipt.scope, { paths: [], includeTests: false });
  const named = await callConservationTool("get_conservation_evidence", { projectRoot: root, evidenceId: found.receiptId, section: "files" });
  assert.deepEqual(named.entries.map(entry => entry.file), ["src/panel.mjs", "src/states.mjs"]);
  assert.ok(named.entries.every(entry => /^[a-f0-9]{64}$/.test(entry.hash)));
  // The receipt keeps every group, and the response applies the limit.
  const limited = await findSharedLiterals({ projectRoot: root, includeTests: true, limit: 1 }, { runtime });
  assert.equal(limited.totalGroups, 1);
  assert.notEqual(limited.receiptId, found.receiptId);
  assert.equal((await callConservationTool("get_conservation_evidence", { projectRoot: root, evidenceId: cohesion.receiptId })).section, "containers");
});
test("prepared same-name groups and complex units read snapshot files and retain receipts", async t => {
  const { root } = await fixture(t);
  const isObject = "function isObject(value) {\n  return value !== null && typeof value === 'object';\n}\n";
  const dispatch = `function handle(name) {\n${Array.from({ length: 9 }, (_, index) => `  if (name === "tool_${index}") return ${index};`).join("\n")}\n}\n`;
  const files = { "src/a.mjs": isObject, "src/b.mjs": isObject, "src/mcp.mjs": dispatch };
  const units = [];
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
    units.push({ id: file, file, kind: "function", name: file.endsWith("mcp.mjs") ? "handle" : "isObject", domain: "code", range: { startLine: 1, endLine: content.split("\n").length - 1 }, span: { start: 0, end: content.length - 1 } });
  }
  const runtime = { prepare: async source => ({ status: "ready", snapshot: (await source.snapshot()).sourceFingerprint, preparationId: "test", diagnostics: [],
    prepared: { index: { units, edges: [], unresolvedReferences: [], structureComplete: true }, revision: "test", modelIdentity: "test" } }) };
  const same = await findSameNameUnits({ projectRoot: root }, { runtime });
  assert.deepEqual(same.groups.map(group => [group.name, group.kind, group.files]), [["isObject", "identical", 2]]);
  assert.deepEqual((await findSameNameUnits({ projectRoot: root, filters: { paths: ["src/a.mjs"] } }, { runtime })).groups.map(group => [group.name, group.files]), [["isObject", 2]]);
  assert.deepEqual((await findSameNameUnits({ projectRoot: root, filters: { paths: ["src/mcp.mjs"] } }, { runtime })).groups, []);
  const complex = await reportComplexUnits({ projectRoot: root }, { runtime });
  assert.deepEqual(complex.units.map(unit => [unit.selector, unit.dispatch]), [["handle", { subject: "name", values: 9 }]]);
  const receipt = await callConservationTool("get_conservation_evidence", { projectRoot: root, evidenceId: complex.receiptId });
  assert.deepEqual([receipt.tool, receipt.section, receipt.totalCount], ["report_complex_units", "units", 1]);
  assert.equal((await callConservationTool("get_conservation_evidence", { projectRoot: root, evidenceId: same.receiptId })).section, "groups");
});
test("shared dependency input limits, unknown fields, and path traversal fail before preparation", () => {
  for (const input of [{ limit: 0 }, { limit: 101 }, { includeTests: "yes" }, { filters: { domains: ["code"] } }, { filters: { paths: ["../outside"] } }, { query: "x" }, { snapshotId: "x" }])
    assert.throws(() => validateSharedDependencies({ projectRoot: "/tmp", ...input }), error => ["validation_failed", "invalid_path"].includes(error.code), JSON.stringify(input));
  validateSharedDependencies({ projectRoot: "/tmp", limit: 100, includeTests: true, filters: { paths: ["src/server"] } });
});
test("search input limits, unknown fields, and path traversal fail before preparation", () => {
  for (const input of [{ query: "" }, { query: "x", limit: 51 }, { query: "x", limit: null }, { query: "x", limit: "10" }, { query: "x", filters: { domains: ["unknown"] } }, { query: "x", filters: { paths: ["../outside"] } }, { query: "x", filters: { surprise: [] } }, { query: "x", extra: true }]) assert.throws(() => validateConceptSearch(input));
});
test("fallback filters select matching artifacts before the global result limit", async t => {
  const { directory, root } = await fixture(t);
  await mkdir(path.join(root, 'instructions'));
  await Promise.all(Array.from({ length: 105 }, (_, i) => writeFile(path.join(root, `retry-${i}.js`), 'retry '.repeat(20))));
  await writeFile(path.join(root, 'instructions/retry.md'), 'Retry temporary failures.\n');
  const runtime = new NativeSemanticRuntime({ directory: path.join(directory, 'cache'), manifestPath });
  for (const filters of [{ domains: ['instruction'] }, { paths: ['instructions'] }, { domains: ['instruction'], paths: ['instructions'], kinds: ['file'] }]) {
    const result = await searchRepositoryConcepts({ projectRoot: root, query: 'retry', filters, limit: 1 }, { runtime });
    assert.deepEqual(result.results.map(item => item.file), ['instructions/retry.md']);
  }
  const absent = await searchRepositoryConcepts({ projectRoot: root, query: 'retry', filters: { kinds: ['function'] } }, { runtime });
  assert.deepEqual(absent.results, []);
});
test("degraded domain filters share classification with structured search", async t => {
  const { directory, root } = await fixture(t);
  await mkdir(path.join(root, "policies"));
  await writeFile(path.join(root, "policies/retry.md"), "Retry transient failures.\n");
  await writeFile(path.join(root, "notes.txt"), "Retry transient failures.\n");
  const runtime = new NativeSemanticRuntime({ directory: path.join(directory, "cache"), manifestPath });
  for (const [domain, file] of [["instruction", "policies/retry.md"], ["documentation", "notes.txt"]]) {
    const result = await searchRepositoryConcepts({ projectRoot: root, query: "retry", filters: { domains: [domain] } }, { runtime });
    assert.deepEqual(result.results.map(item => item.file), [file]);
  }
});
test("a query worker crash degrades to lexical results while stale source errors remain failures", async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "retry.ts"), "export function retryRequest() { return 1; }\n");
  const runtime = {
    prepare: async source => ({ status: "ready", snapshot: (await source.snapshot()).sourceFingerprint, preparationId: "test", diagnostics: [], prepared: { index: {}, revision: "test", modelIdentity: "test" } }),
    search: async () => { throw Object.assign(new Error("The worker exited."), { code: "preparation_failed" }); }
  };
  const result = await searchRepositoryConcepts({ projectRoot: root, query: "retryRequest" }, { runtime });
  assert.equal(result.status, "degraded");
  assert.equal(result.capabilities.semanticSearch, false);
  assert.equal(result.results[0].file, "retry.ts");
  assert.equal(result.results[0].cosineSimilarity, null);
  assert.ok(result.diagnostics.some(item => item.code === "preparation_failed"));
  runtime.search = async () => { throw Object.assign(new Error("Source changed."), { code: "snapshot-changed" }); };
  await assert.rejects(searchRepositoryConcepts({ projectRoot: root, query: "retryRequest" }, { runtime }), { code: "stale_snapshot" });
});
test("concurrent callers share preparation and reject stale expected snapshots", async t => {
  const { root, directory } = await fixture(t);
  await writeFile(path.join(root, "a.ts"), "export const x = 1;\n");
  const source = await openNativeRepositoryIntelligence(root);
  const runtime = new NativeSemanticRuntime({ directory: path.join(directory, "cache") });
  let builds = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  runtime.build = async () => { builds++; await gate; return { index: { snapshot: (await source.snapshot()).sourceFingerprint } }; };
  const [a, b] = await Promise.all([runtime.prepare(source, undefined, 0), runtime.prepare(source, undefined, 0)]);
  assert.equal(a.status, "preparing"); assert.equal(a.preparationId, b.preparationId);
  assert.equal(builds, 1);
  release(); await runtime.status(root, 100);
  assert.equal((await runtime.prepare(source)).status, "ready");
  await assert.rejects(runtime.prepare(source, "0".repeat(64)), { code: "stale_snapshot" });
});
test("complete native evidence supplies numeric FIT input while partial structure and semantic-only hints do not", async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "retry.ts"), "export function retryRequest() { return 1; }\n");
  const source = await openNativeRepositoryIntelligence(root), snapshot = await source.snapshot();
  const node = { id: "retry", file: "retry.ts", name: "retryRequest", kind: "function", range: { startLine: 1, endLine: 1 }, rangeComplete: true };
  const index = { units: [node], edges: [], fileCoverage: { "retry.ts": true }, structureComplete: true, diagnostics: [], snapshot: snapshot.sourceFingerprint };
  const runtime = { search: async () => [{ ...node, fusedScore: 0.01, cosineSimilarity: 0.7, lexicalScore: 2, fusedRank: 1 }] };
  const provider = new SemanticNativeRepositoryIntelligence(source, { status: "ready", prepared: { index, revision: "index", modelIdentity: "model" } }, runtime);
  const plan = hints => planRepositoryContext({ task: "retry requests", hints, provider: new CompositeRepositoryIntelligence(provider) });
  const complete = await plan({ symbols: ["retryRequest"] });
  assert.ok(complete.tokenEstimate.expected > 0);
  assert.equal((await plan({ concepts: ["recover from temporary connectivity issues"] })).tokenEstimate.expected, null);
  index.fileCoverage["retry.ts"] = false;
  assert.equal((await plan({})).tokenEstimate.expected, null);
  index.fileCoverage["retry.ts"] = true;
  runtime.search = async () => [{ ...node, fusedScore: 0.01, cosineSimilarity: 0.99 }];
  assert.deepEqual((await plan({ symbols: ["retryRequest"] })).tokenEstimate, complete.tokenEstimate);
  await writeFile(path.join(root, "retry.ts"), "export function retryRequest() { return 2; }\n");
  await assert.rejects(provider.verifySnapshot(), { code: "stale_snapshot" });
});
test("renewable operation locks retain live owners and recover crashed owners without changing legacy defaults", async t => {
  const { directory } = await fixture(t), file = path.join(directory, "index");
  await writeFile(file + ".lock", JSON.stringify({ pid: process.pid, renewable: true }));
  await utimes(file + ".lock", new Date(0), new Date(0));
  await assert.rejects(withFileLock(file, async () => {}, undefined, { renew: true, timeoutMs: 30, staleMs: 1 }), { code: "lock_timeout" });
  await writeFile(file + ".lock", JSON.stringify({ pid: 2147483647, renewable: true }));
  await utimes(file + ".lock", new Date(0), new Date(0));
  assert.equal(await withFileLock(file, async () => "recovered", undefined, { renew: true, timeoutMs: 100, staleMs: 1 }), "recovered");
  await assert.rejects(readFile(file + ".lock"), { code: "ENOENT" });
});
test("private storage rejects a repository cache and symlink storage", async t => {
  const { directory, root } = await fixture(t);
  await assert.rejects(new NativeSemanticRuntime({ directory: path.join(root, "cache") }).status(root), { code: "invalid_path" });
  if (process.platform !== "win32") {
    await mkdir(path.join(directory, "target")); await symlink(path.join(directory, "target"), path.join(directory, "link"));
    const runtime = new NativeSemanticRuntime({ directory: path.join(directory, "link") });
    const result = await runtime.prepare(await openNativeRepositoryIntelligence(root));
    assert.equal(result.status, "degraded"); assert.equal(result.diagnostics[0].code, "invalid_path");
  }
});
test("atomic generations retain previous bytes after a failed build and reuse unchanged embeddings", async t => {
  const { directory, root } = await fixture(t);
  await writeFile(path.join(root, "a.ts"), "export const x = 1;\n");
  const runtime = new NativeSemanticRuntime({ directory: path.join(directory, "cache"), manifestPath });
  runtime.assets = async () => ({ runtime: "fake", modelIdentity: "model", assetIdentity: "assets" });
  let fail = false, seenPrevious = null;
  runtime.helper = () => ({ request: async (_method, args) => {
    seenPrevious = args.previousEmbeddings;
    if (fail) throw new Error("Worker crashed during indexing.");
    return { schemaVersion: 1, snapshot: args.snapshot, modelIdentity: "model", units: [], edges: [], chunks: [{ embeddingKey: "stable", embedding: [1, 2] }], fileCoverage: { "a.ts": true }, diagnostics: [], counts: { files: 1 }, structureComplete: true };
  } });
  const first = await runtime.prepare(await openNativeRepositoryIntelligence(root));
  assert.equal(first.status, "ready");
  const storage = (await runtime.location(root)).directory, pointer = await readFile(path.join(storage, "current.json"));
  fail = true; await writeFile(path.join(root, "a.ts"), "export const x = 2;\n");
  const second = await runtime.prepare(await openNativeRepositoryIntelligence(root));
  assert.equal(second.status, "degraded");
  assert.deepEqual(await readFile(path.join(storage, "current.json")), pointer);
  assert.deepEqual(seenPrevious.stable, [1, 2]);
  assert.ok(!(await readdir(storage)).some(name => name.startsWith("snapshot-")));
  fail = false;
  const recovered = await runtime.prepare(await openNativeRepositoryIntelligence(root));
  assert.equal(recovered.status, "ready");
  assert.notEqual(recovered.prepared.revision, first.prepared.revision);
  assert.equal(recovered.prepared.index.chunks, undefined);
});
test("repeated source edits keep a bounded set of reusable index generations", async t => {
  const { directory, root } = await fixture(t);
  const runtime = new NativeSemanticRuntime({ directory: path.join(directory, "cache"), manifestPath });
  runtime.assets = async () => ({ runtime: "fake", modelIdentity: "model", assetIdentity: "assets" });
  let builds = 0;
  runtime.helper = () => ({ request: async (_method, args) => {
    builds++;
    return { schemaVersion: 1, snapshot: args.snapshot, modelIdentity: "model", units: [], edges: [], chunks: [], fileCoverage: { "a.ts": true }, diagnostics: [], counts: { files: 1 }, structureComplete: true };
  } });
  const revisions = [];
  for (let value = 0; value < 8; value++) {
    await writeFile(path.join(root, "a.ts"), `export const x = ${value};\n`);
    const prepared = await runtime.prepare(await openNativeRepositoryIntelligence(root));
    assert.equal(prepared.status, "ready");
    revisions.push(prepared.prepared.revision);
  }
  const storage = (await runtime.location(root)).directory, entries = await readdir(storage);
  const kept = entries.filter(name => /^[a-f\d]{64}\.json$/.test(name));
  assert.equal(kept.length, 4);
  assert.ok(kept.includes(`${revisions.at(-1)}.json`));
  for (const name of entries.filter(name => name.startsWith("generation-"))) assert.ok(kept.includes(`${JSON.parse(await readFile(path.join(storage, name), "utf8")).revision}.json`));
  assert.ok(runtime.generations.size <= 4);
  await writeFile(path.join(root, "a.ts"), "export const x = 6;\n");
  const reused = await runtime.prepare(await openNativeRepositoryIntelligence(root));
  assert.equal(reused.prepared.revision, revisions[6]);
  assert.equal(builds, 8);
});
test("index pruning removes abandoned snapshot mirrors and pointers to removed revisions", async t => {
  const { directory } = await fixture(t), storage = path.join(directory, "storage"), hour = 60 * 60 * 1000;
  await mkdir(path.join(storage, "snapshot-abandoned", "src"), { recursive: true });
  const [current, recent, old] = ["c", "b", "a"].map(value => value.repeat(64));
  for (const [index, revision] of [current, recent, old].entries()) {
    await writeFile(path.join(storage, `${revision}.json`), "{}");
    await writeFile(path.join(storage, `generation-${index}-assets.json`), JSON.stringify({ revision }));
    const used = new Date(Date.now() - index * hour); await utimes(path.join(storage, `${revision}.json`), used, used);
  }
  await writeFile(path.join(storage, "current.json"), JSON.stringify({ revision: current }));
  await pruneIndexes(storage, current, 2);
  assert.deepEqual((await readdir(storage)).sort(), [`${current}.json`, `${recent}.json`, "current.json", "generation-0-assets.json", "generation-1-assets.json"].sort());
});
test("model files fall back from the release mirror to the model host", async t => {
  const { directory, root } = await fixture(t), localManifest = path.join(directory, "manifest.json"), platform = `${process.platform}-${process.arch}`;
  const digest = value => createHash("sha256").update(value).digest("hex"), worker = Buffer.from("// worker"), config = Buffer.from("{}");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.bundles[platform] = { url: "https://example.invalid/runtime.tar.gz", bytes: 1, sha256: "a".repeat(64), unpackedBytes: 1 };
  manifest.modelMirror = "https://example.invalid/release";
  manifest.model.files = [{ path: "onnx/config.json", bytes: config.length, sha256: digest(config) }];
  await writeFile(localManifest, JSON.stringify(manifest));
  const cache = path.join(directory, "cache"), runtimeDirectory = path.join(cache, "assets", "a".repeat(64));
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(path.join(runtimeDirectory, "worker.mjs"), worker);
  await writeFile(path.join(runtimeDirectory, "runtime.json"), JSON.stringify({ schemaVersion: 1, platform, node: "24.16.0", files: { "worker.mjs": digest(worker) } }));
  const originalFetch = globalThis.fetch, requested = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  let modelHost = true;
  globalThis.fetch = async url => {
    requested.push(String(url));
    if (url.host === "example.invalid" || !modelHost) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    return { ok: true, body: [config] };
  };
  const runtime = new NativeSemanticRuntime({ directory: cache, manifestPath: localManifest });
  const assets = await runtime.assets(() => {});
  assert.deepEqual(requested, ["https://example.invalid/release/model-onnx-config.json", "https://huggingface.co/test/model/resolve/test-revision/onnx/config.json"]);
  assert.deepEqual(await readFile(path.join(assets.modelDirectory, "onnx/config.json")), config);
  modelHost = false;
  await rm(assets.modelDirectory, { recursive: true });
  await assert.rejects(new NativeSemanticRuntime({ directory: cache, manifestPath: localManifest }).assets(() => {}),
    { code: "preparation_failed", message: /from example\.invalid failed: ENOTFOUND.*from huggingface\.co failed: ENOTFOUND/ });
});
test("a concurrent source edit prevents generation publication", async t => {
  const { directory, root } = await fixture(t);
  await writeFile(path.join(root, "a.ts"), "export const x = 1;\n");
  const runtime = new NativeSemanticRuntime({ directory: path.join(directory, "cache"), manifestPath });
  runtime.assets = async () => ({ runtime: "fake" });
  runtime.helper = () => ({ request: async () => { await writeFile(path.join(root, "a.ts"), "export const x = 2;\n"); return {}; } });
  const result = await runtime.prepare(await openNativeRepositoryIntelligence(root));
  assert.equal(result.status, "degraded"); assert.equal(result.diagnostics[0].code, "stale_snapshot");
  await assert.rejects(readFile(path.join((await runtime.location(root)).directory, "current.json")), { code: "ENOENT" });
});
test("a downloaded archive is removed after extraction ends, including when extraction fails", async t => {
  const { directory, root } = await fixture(t), localManifest = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")), bytes = Buffer.from("not a tar");
  manifest.bundles[`${process.platform}-${process.arch}`] = { url: "https://example.invalid/pinned.tar.gz", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), unpackedBytes: 100 };
  await writeFile(localManifest, JSON.stringify(manifest));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({ ok: true, body: { async *[Symbol.asyncIterator]() { yield bytes; } } });
  const cache = path.join(directory, "cache"), runtime = new NativeSemanticRuntime({ directory: cache, manifestPath: localManifest });
  const result = await runtime.prepare(await openNativeRepositoryIntelligence(root));
  assert.equal(result.status, "degraded");
  assert.deepEqual(await readdir(path.join(cache, "assets")), []);
});

test("asset pruning keeps current and recent assets and removes stale assets and extracted archives", async t => {
  const { directory } = await fixture(t), assets = path.join(directory, "assets"), day = 24 * 60 * 60 * 1000, old = new Date(Date.now() - 20 * day);
  for (const name of ["current", "recent", "stale", "current.tar.gz", "stale.tar.gz", "orphan.tar.gz", "stale.123.tmp", "stale.lock"]) {
    const target = path.join(assets, name);
    if (name.includes(".")) { await mkdir(assets, { recursive: true }); await writeFile(target, name); } else { await mkdir(path.join(target, "inner"), { recursive: true }); await writeFile(path.join(target, "inner", "file"), name); }
  }
  for (const name of ["stale", "stale.tar.gz", "orphan.tar.gz", "stale.123.tmp", "current"]) await utimes(path.join(assets, name), old, old);
  await pruneAssets(assets, new Set(["current"]));
  assert.deepEqual((await readdir(assets)).sort(), ["current", "recent", "stale.lock"]);
});

test("invalid checksums and interrupted downloads publish no runtime and remove temporary files", async t => {
  const { directory, root } = await fixture(t), localManifest = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const hash = createHash("sha256").update("expected").digest("hex");
  manifest.bundles[`${process.platform}-${process.arch}`] = { url: "https://example.invalid/pinned.tar.gz", bytes: 8, sha256: hash, unpackedBytes: 100 };
  await writeFile(localManifest, JSON.stringify(manifest));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const interrupted of [false, true]) {
    globalThis.fetch = async () => ({ ok: true, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(interrupted ? "expe" : "incorrect"); if (interrupted) throw new Error("Download interrupted."); } } });
    const cache = path.join(directory, "cache-" + interrupted), runtime = new NativeSemanticRuntime({ directory: cache, manifestPath: localManifest });
    const result = await runtime.prepare(await openNativeRepositoryIntelligence(root));
    assert.equal(result.status, "degraded"); assert.equal(result.diagnostics[0].code, interrupted ? "preparation_failed" : "corrupt_asset");
    assert.deepEqual(await readdir(path.join(cache, "assets")), []);
  }
});
