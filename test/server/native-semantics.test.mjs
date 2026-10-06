import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, utimes, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { NativeSemanticRuntime } from "../../dist/server/native-semantic-runtime.mjs";
import { SemanticNativeRepositoryIntelligence, searchRepositoryConcepts, validateConceptSearch } from "../../dist/server/semantic-native-provider.mjs";
import { openNativeRepositoryIntelligence } from "../../dist/server/native-repository-intelligence.mjs";
import { CompositeRepositoryIntelligence } from "../../dist/server/composite-repository-intelligence.mjs";
import { planRepositoryContext } from "../../dist/server/repository-intelligence.mjs";
import { withFileLock } from "../../dist/server/artifact-store.mjs";
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
