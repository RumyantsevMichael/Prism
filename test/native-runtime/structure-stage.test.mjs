import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
Object.assign(process.env, { PRISM_WORKER_LIBRARY: "1", PRISM_EMBEDDED: "1", CODEGRAPH_NO_STORE_WORKER: "1", CODEGRAPH_NO_PARALLEL_RESOLVE: "1", CODEGRAPH_NO_WAL_DEFER: "1", CODEGRAPH_NO_FAST_INIT: "1", CODEGRAPH_KERNEL: "0", NODE_DISABLE_COMPILE_CACHE: "1" });
const { structure, query, hasEmbeddings } = await import("../../dist/native-runtime/worker.mjs");

// Runs after `npm run stage:native`, against the pinned code graph: the structure that a build reports before it embeds,
// and a lexical search of an index whose fragments carry no embedding, which needs no model.
const sha = (value) => createHash("sha256").update(value).digest("hex");
const SOURCES = {
  "src/retry.ts": "export function retryRequest(attempts: number) {\n  return attempts > 0 ? retryRequest(attempts - 1) : 'done';\n}\n",
  "src/timeout.ts": "export function timeoutAfter(ms: number) {\n  return new Promise(resolve => setTimeout(resolve, ms));\n}\n",
  "docs/guide.md": "# Guide\n\nRetry the request after a timeout.\n"
};
const words = (text) => text.split(/\s+/).filter(Boolean).length;

async function mirror(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-structure-stage-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [file, content] of Object.entries(SOURCES)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
    files.push({ file, hash: sha(content) });
  }
  return { root, files };
}

test("the structure of a build holds every unit and fragment, and no fragment carries an embedding", async (t) => {
  const { root, files } = await mirror(t);
  const index = await structure({ mirror: root, files, snapshot: "a".repeat(64), modelDirectory: "unused", modelIdentity: "model" }, () => {}, { countTokens: words, fileTokens: words });
  assert.ok(index.units.some((unit) => unit.name === "retryRequest"));
  assert.ok(index.chunks.length > 0);
  assert.ok(index.chunks.every((chunk) => chunk.embedding === undefined && /^[a-f\d]{64}$/.test(chunk.embeddingKey)));
  assert.equal(hasEmbeddings(index), false);
  assert.deepEqual([index.counts.reusedEmbeddings, index.counts.newEmbeddings], [0, 0]);
  assert.equal(index.fileCoverage["src/retry.ts"], true);
});

test("a search of an index without embeddings answers lexically, with or without mode lexical, and loads no model", async (t) => {
  const { root, files } = await mirror(t);
  const snapshot = "b".repeat(64);
  const index = await structure({ mirror: root, files, snapshot, modelDirectory: "unused", modelIdentity: "model" }, () => {}, { countTokens: words, fileTokens: words });
  const indexPath = path.join(root, "index.json");
  await writeFile(indexPath, JSON.stringify(index));
  // The model directory does not exist, so a search that loaded the model would fail.
  const args = { query: "retry request", limit: 5, snapshot, modelDirectory: path.join(root, "missing-model"), modelIdentity: "model", indexPath };
  for (const mode of ["lexical", undefined]) {
    const results = await query({ ...args, ...(mode ? { mode } : {}) });
    assert.ok(results.length > 0, `mode ${mode}`);
    assert.ok(results.every((result) => result.cosineSimilarity === null));
    assert.ok(results.some((result) => result.file === "src/retry.ts" && result.lexicalScore > 0));
  }
});
