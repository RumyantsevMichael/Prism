import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { manifestPath, project } from "./fixtures/component-indexes.mjs";

// The index store's bounds on what one build request carries and on when a stopped build may still send it.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-index-store-bounds-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { NativeSemanticRuntime } = await import("../../dist/server/repository-intelligence/native-semantic-runtime.mjs");
const { openNativeRepositoryIntelligence } = await import("../../dist/server/repository-intelligence/native-repository-intelligence.mjs");
const { LocalIndexStore, REUSED_EMBEDDINGS } = await import("../../dist/server/repository-intelligence/index-store.mjs");
const { Helper } = await import("../../dist/server/repository-intelligence/native-helper.mjs");

const RECORD = 32 + 384 * 4;

// A helper that answers a build with one fragment per file and writes how many previous embeddings its request carried beside the mirror.
const WORKER = `
import readline from "node:readline";
import { writeFileSync } from "node:fs";
import path from "node:path";
const vector = Array.from({ length: 384 }, (_, index) => Math.sin(index) / 20);
const build = (args) => {
  writeFileSync(path.join(path.dirname(args.mirror), "received.json"), JSON.stringify(Object.keys(args.previousEmbeddings || {}).length));
  const units = [], chunks = [], fileCoverage = {};
  for (const { file, hash } of args.files) {
    fileCoverage[file] = true;
    units.push({ id: "file:" + file, file, kind: "file", name: file, domain: "code", range: { startLine: 1, endLine: 1 }, sourceHash: hash, rangeComplete: true });
    chunks.push({ id: "chunk:" + file, parentId: "file:" + file, file, kind: "file", name: file, role: "whole", range: { startLine: 1, endLine: 1 }, text: file, embeddingText: file,
      context: "", embeddingKey: "a".repeat(64), embedding: vector });
  }
  return { schemaVersion: 1, chunkerVersion: "fake-chunker", modelIdentity: "fake-model", snapshot: args.snapshot, units, edges: [], unresolvedReferences: [], chunks, fileCoverage,
    syntaxCoverage: fileCoverage, diagnostics: [], counts: { files: args.files.length, units: units.length, fragments: chunks.length, reusedEmbeddings: 0, newEmbeddings: chunks.length },
    structureComplete: true, resources: {} };
};
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, result: build(request.args) }) + "\\n");
});
`;

async function helperRuntime(t, directory, worker = WORKER) {
  const runtimeDirectory = path.join(directory, "helper-runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(path.join(runtimeDirectory, "worker.mjs"), worker);
  await symlink(process.execPath, path.join(runtimeDirectory, process.platform === "win32" ? "node.exe" : "node")).catch(() => {});
  return runtimeDirectory;
}

// `count` valid records with distinct keys whose float values, unlike multiples of a power of two, serialize to their full length.
function storeRecords(count) {
  const vectors = Array.from({ length: 16 }, (_, seed) => {
    const bytes = Buffer.alloc(384 * 4);
    for (let position = 0; position < 384; position += 1) bytes.writeFloatLE(Math.sin(seed * 384 + position) / 3, position * 4);
    return bytes;
  });
  const bytes = Buffer.alloc(count * RECORD);
  const keys = randomBytes(count * 32);
  for (let index = 0; index < count; index += 1) {
    keys.copy(bytes, index * RECORD, index * 32, index * 32 + 32);
    vectors[index % 16].copy(bytes, index * RECORD + 32);
  }
  return bytes;
}

test("a build whose embedding store holds more records than one request can carry still completes", { skip: process.platform === "win32", timeout: 300000 }, async (t) => {
  const { directory, root, storage } = await project(t, { files: { "a.ts": "export const a = 1;\n" }, components: null });
  const runtimeDirectory = await helperRuntime(t, directory);
  const runtime = new NativeSemanticRuntime({ directory: storage, manifestPath });
  runtime.assets = async () => ({ runtime: runtimeDirectory, modelDirectory: "fake-model", modelIdentity: "fake-model", assetIdentity: "fake-assets" });
  t.after(() => runtime.close());
  const { directory: location } = await runtime.location(root);
  await mkdir(location, { recursive: true });
  await writeFile(path.join(location, "embeddings.bin"), storeRecords(70000), { mode: 0o600 });
  const result = await runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 240000);
  assert.equal(result.status, "ready", JSON.stringify(result.diagnostics));
  const received = JSON.parse(await readFile(path.join(location, "received.json"), "utf8"));
  assert.equal(received, REUSED_EMBEDDINGS, "the request carries the newest saved embeddings up to its bound");
  assert.equal((await readFile(path.join(location, "embeddings.bin"))).length, RECORD, "the saved index replaces the oversized store");
});

test("a request that cannot be serialized fails without staying registered", { skip: process.platform === "win32", timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "prism-helper-serialize-"));
  const runtimeDirectory = await helperRuntime(t, directory);
  const helper = new Helper(runtimeDirectory, { directory }, "build");
  t.after(() => helper.close());
  await assert.rejects(helper.request("build", { size: 1n }), (error) => error.code === "preparation_failed" && /could not be serialized/.test(error.message));
  assert.equal(helper.requests.size, 0);
});

test("a build stopped before it sends its request never sends it, and the next build runs at once", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "prism-store-stop-"));
  let requested = 0, stopped = 0;
  const index = { units: [], chunks: [], diagnostics: [], resources: {} };
  const store = new LocalIndexStore(async () => { requested += 1; return structuredClone(index); }, () => { stopped += 1; });
  const request = { runtime: "fake-runtime", directory, args: { mirror: directory, files: [], snapshot: "x", modelDirectory: "m", modelIdentity: "m" } };
  const abandoned = store.build(request, () => {});
  await store.stop();
  await assert.rejects(abandoned, (error) => error.code === "preparation_failed");
  assert.deepEqual({ requested, stopped }, { requested: 0, stopped: 1 });
  const token = await store.build(request, () => {});
  assert.equal(requested, 1, "the next build sends its request without waiting behind the abandoned one");
  assert.ok(store.built.has(token));
});
