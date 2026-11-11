import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { manifestPath, project } from "./fixtures/component-indexes.mjs";

// The index store keeps the full index, whose fragment vectors make it the largest data Prism handles, off the event loop that answers
// pages and agents: a build, a save, and a reload of a large index leave that loop free, and only the index metadata reaches it.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-index-store-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { NativeSemanticRuntime } = await import("../../dist/server/repository-intelligence/native-semantic-runtime.mjs");
const { openNativeRepositoryIntelligence } = await import("../../dist/server/repository-intelligence/native-repository-intelligence.mjs");

// A helper that answers a build with an index of `FRAGMENTS` fragments of 384-number vectors, about 60 MB of JSON, in one line.
const FRAGMENTS = 7000;
const WORKER = `
import readline from "node:readline";
import { readFile } from "node:fs/promises";
import path from "node:path";
const build = async (args) => {
  const units = [], fileCoverage = {};
  for (const { file, hash } of args.files) {
    fileCoverage[file] = true;
    units.push({ id: "file:" + file, file, kind: "file", name: file, domain: "code", range: { startLine: 1, endLine: 1 }, sourceHash: hash, rangeComplete: true });
  }
  const vector = Array.from({ length: 384 }, (_, index) => Math.sin(index) / 20);
  const chunks = Array.from({ length: ${FRAGMENTS} }, (_, index) => ({ id: "chunk:" + index, parentId: units[0].id, file: units[0].file, kind: "file", name: "f" + index,
    role: "whole", range: { startLine: 1, endLine: 1 }, text: "fragment " + index, embeddingText: "fragment " + index, context: "", embeddingKey: "key" + index, embedding: vector }));
  const reused = Object.keys(args.previousEmbeddings || {}).length;
  return { schemaVersion: 1, chunkerVersion: "fake-chunker", modelIdentity: "fake-model", snapshot: args.snapshot, units, edges: [], unresolvedReferences: [], chunks, fileCoverage,
    syntaxCoverage: fileCoverage, diagnostics: [], counts: { files: args.files.length, units: units.length, fragments: chunks.length, reusedEmbeddings: reused, newEmbeddings: chunks.length - reused },
    structureComplete: true, resources: {} };
};
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, progress: { phase: "embedding", current: 0, total: ${FRAGMENTS} } }) + "\\n");
  process.stdout.write(JSON.stringify({ id: request.id, result: await build(request.args) }) + "\\n");
});
`;

async function largeRuntime(t, directory, storage) {
  const runtimeDirectory = path.join(directory, "helper-runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(path.join(runtimeDirectory, "worker.mjs"), WORKER);
  await symlink(process.execPath, path.join(runtimeDirectory, process.platform === "win32" ? "node.exe" : "node")).catch(() => {});
  const runtime = new NativeSemanticRuntime({ directory: storage, manifestPath });
  runtime.assets = async () => ({ runtime: runtimeDirectory, modelDirectory: "fake-model", modelIdentity: "fake-model", assetIdentity: "fake-assets" });
  t.after(() => runtime.close());
  return runtime;
}

// The longest time the event loop went without running a 10 ms timer while `work` ran.
async function longestStop(work) {
  let last = performance.now(), longest = 0;
  const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 10);
  try { return { result: await work(), longest }; } finally { clearInterval(timer); }
}

// Until the index store had a thread, the line reader searched the whole unfinished line again after each 64 KiB chunk and the process
// parsed, hashed, and serialized the index itself, so an index of this size held the event loop for seconds, and a larger one for minutes.
const STOP_LIMIT_MS = 400;

test("building, saving, and reloading a large index leaves the event loop free", { skip: process.platform === "win32", timeout: 120000 }, async (t) => {
  const { directory, root, storage, write } = await project(t, { files: { "a.ts": "export const a = 1;\n" }, components: null });
  const runtime = await largeRuntime(t, directory, storage);
  const built = await longestStop(async () => runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 60000));
  assert.equal(built.result.status, "ready", JSON.stringify(built.result.diagnostics));
  assert.equal(built.result.prepared.index.chunks, undefined, "only the metadata reaches the event loop");
  assert.equal(built.result.prepared.index.counts.fragments, FRAGMENTS);
  assert.ok(built.longest < STOP_LIMIT_MS, `the event loop stopped for ${Math.round(built.longest)} ms during the build`);
  const { directory: stored } = await runtime.location(root);
  assert.ok((await readdir(stored)).includes(`${built.result.prepared.revision}.json`));

  // A changed source builds again, reusing the stored embeddings, which the thread reads from the stored index.
  await write("a.ts", "export const a = 2;\n");
  const rebuilt = await longestStop(async () => runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 60000));
  assert.equal(rebuilt.result.status, "ready");
  assert.equal(rebuilt.result.prepared.index.counts.reusedEmbeddings, FRAGMENTS);
  assert.ok(rebuilt.longest < STOP_LIMIT_MS, `the event loop stopped for ${Math.round(rebuilt.longest)} ms during the rebuild`);

  // A new runtime, as after a restart, loads the stored index without building it again.
  const restarted = await largeRuntime(t, directory, storage);
  const reloaded = await longestStop(async () => restarted.prepare(await openNativeRepositoryIntelligence(root), undefined, 60000));
  assert.equal(reloaded.result.status, "ready");
  assert.equal(reloaded.result.prepared.revision, rebuilt.result.prepared.revision);
  assert.ok(reloaded.longest < STOP_LIMIT_MS, `the event loop stopped for ${Math.round(reloaded.longest)} ms during the reload`);
});

test("closing the runtime ends the index thread and its build helper", { skip: process.platform === "win32", timeout: 60000 }, async (t) => {
  const { directory, root, storage } = await project(t, { files: { "a.ts": "export const a = 1;\n" }, components: null });
  const runtime = await largeRuntime(t, directory, storage);
  assert.equal((await runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 60000)).status, "ready");
  const worker = runtime.indexStore.worker;
  assert.ok(worker, "the build ran in the index thread");
  const exited = new Promise((resolve) => worker.once("exit", resolve));
  await runtime.close();
  await exited;
  assert.equal(runtime.indexStore, undefined);
});
