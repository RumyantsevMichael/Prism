import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
Object.assign(process.env, { PRISM_EMBEDDED: "1", CODEGRAPH_NO_STORE_WORKER: "1", CODEGRAPH_NO_PARALLEL_RESOLVE: "1", CODEGRAPH_NO_WAL_DEFER: "1", CODEGRAPH_NO_FAST_INIT: "1", CODEGRAPH_KERNEL: "0", NODE_DISABLE_COMPILE_CACHE: "1" });
const { extractGraph } = await import("../../dist/native-runtime/graph.mjs");
const runtime = fileURLToPath(new URL("../../dist/native-runtime/", import.meta.url));

// Runs after `npm run stage:native`, against the pinned code graph.
test("the graph reports every unresolved reference by file with its kind", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-unresolved-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = {
    "src/client.ts": "import { chunk } from 'lodash';\nimport { helper } from './missing';\nexport function load(url: string) {\n  return fetch(url).then(() => chunk([1, 2], 1)).then(() => helper());\n}\n",
    "src/other.ts": "export function other() { return 1; }\n"
  };
  const files = [];
  for (const [file, content] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
    files.push({ file, content, hash: "verified" });
  }
  const graph = await extractGraph(root, files, runtime);
  const references = graph.unresolvedByFile["src/client.ts"];
  assert.ok(Array.isArray(references), JSON.stringify(graph.unresolvedByFile));
  for (const reference of references) assert.deepEqual(Object.keys(reference).sort(), ["kind", "name"]);
  const has = (predicate, label) => assert.ok(references.some(predicate), `${label}: ${JSON.stringify(references)}`);
  has(item => item.kind === "calls" && item.name === "fetch", "a library call");
  has(item => item.kind === "imports" && item.name === "lodash", "a package import");
  has(item => item.kind === "imports" && item.name.startsWith("./missing"), "a relative import");
  assert.equal(graph.unresolvedByFile["src/other.ts"], undefined);
  // Each file the graph reports keeps its count diagnostic.
  const diagnostic = graph.diagnostics.find(item => item.file === "src/client.ts");
  assert.equal(diagnostic?.count, references.length);
});
