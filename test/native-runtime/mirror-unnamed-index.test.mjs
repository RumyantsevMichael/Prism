import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
Object.assign(process.env, { PRISM_WORKER_LIBRARY: "1", PRISM_EMBEDDED: "1", CODEGRAPH_NO_STORE_WORKER: "1", CODEGRAPH_NO_PARALLEL_RESOLVE: "1", CODEGRAPH_NO_WAL_DEFER: "1", CODEGRAPH_NO_FAST_INIT: "1", CODEGRAPH_KERNEL: "0", NODE_DISABLE_COMPILE_CACHE: "1" });
const { structure } = await import("../../dist/native-runtime/worker.mjs");
const { updateMirror, markIndexed } = await import("../../dist/server/repository-intelligence/index-mirror.mjs");

// Runs after `npm run stage:native`, against the pinned code graph, which indexes every file of its mirror folder:
// a file that a paused build copied and the source then lost must not reach the next build's index.
const sha = (value) => createHash("sha256").update(value).digest("hex");
const words = (text) => text.split(/\s+/).filter(Boolean).length;
const tools = { countTokens: words, fileTokens: words };
const privateDirectory = async (directory) => { await mkdir(directory, { recursive: true, mode: 0o700 }); return directory; };
const comparable = ({ resources: _resources, ...index }) => JSON.parse(JSON.stringify(index));

test("the build after a paused build whose copied file the source lost returns a full build's index", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-mirror-unnamed-index-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), directory = path.join(root, "location"), fresh = path.join(root, "fresh");
  await Promise.all([mkdir(source), mkdir(directory), mkdir(path.join(fresh, "mirror"), { recursive: true })]);
  const snapshot = (files) => Promise.all(files.map(async (file) => ({ file, hash: sha(await readFile(path.join(source, file))), absolutePath: path.join(source, file) })));
  const build = async (files, update) => structure({ ...update, files: files.map(({ file, hash }) => ({ file, hash })), snapshot: "c".repeat(64), modelDirectory: "unused", modelIdentity: "model" }, () => {}, tools);
  await writeFile(path.join(source, "a.ts"), "import { helper } from './b';\nexport function main() {\n  return helper() + extra();\n}\n");
  await writeFile(path.join(source, "b.ts"), "export function helper() {\n  return 1;\n}\n");
  let files = await snapshot(["a.ts", "b.ts"]);
  await build(files, await updateMirror(directory, files, { privateDirectory }));
  await markIndexed(directory, files);
  await writeFile(path.join(source, "c.ts"), "export function extra() {\n  return 2;\n}\n");
  await writeFile(path.join(source, "d.ts"), "export const d = 1;\n");
  files = await snapshot(["a.ts", "b.ts", "c.ts", "d.ts"]);
  let calls = 0;
  const current = () => { if (calls++ === 1) throw Object.assign(new Error("paused"), { code: "paused" }); };
  await assert.rejects(updateMirror(directory, files, { privateDirectory, current }), { code: "paused" });
  await rm(path.join(source, "c.ts")); await rm(path.join(source, "d.ts"));
  files = await snapshot(["a.ts", "b.ts"]);
  const update = await updateMirror(directory, files, { privateDirectory });
  // The runtime builds its kept graph in full, by scanning the mirror folder, whenever its record is gone, as after an update of the code graph SDK.
  await rm(path.join(directory, "runtime-state", "graph.json"), { force: true });
  const kept = comparable(await build(files, update));
  const full = comparable(await build(files, await updateMirror(fresh, files, { privateDirectory })));
  for (const key of Object.keys(full)) assert.deepEqual(kept[key], full[key], `field ${key} differs`);
  assert.ok(full.diagnostics.some(item => item.file === "a.ts" && item.code === "incomplete_structure"), "a full build reports the call into the lost file as unresolved");
});
