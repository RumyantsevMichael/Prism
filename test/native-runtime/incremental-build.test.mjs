import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
Object.assign(process.env, { PRISM_WORKER_LIBRARY: "1", PRISM_EMBEDDED: "1", CODEGRAPH_NO_STORE_WORKER: "1", CODEGRAPH_NO_PARALLEL_RESOLVE: "1", CODEGRAPH_NO_WAL_DEFER: "1", CODEGRAPH_NO_FAST_INIT: "1", CODEGRAPH_KERNEL: "0", NODE_DISABLE_COMPILE_CACHE: "1" });
const { structure } = await import("../../dist/native-runtime/worker.mjs");

// Runs after `npm run stage:native`, against the pinned code graph: a build given change lists syncs its kept graph for those paths, reuses what it
// derived from the other files, and returns the same index as a full build of the same files.
const sha = (value) => createHash("sha256").update(value).digest("hex");
const SOURCES = {
  "src/retry.ts": "import { wait } from './wait';\nexport function retryRequest(attempts: number) {\n  wait(attempts);\n  return attempts > 0 ? retryRequest(attempts - 1) : helperLater();\n}\n",
  "src/wait.ts": "export function wait(ms: number) {\n  return new Promise(resolve => setTimeout(resolve, ms));\n}\n",
  "src/timeout.ts": "import { wait } from './wait';\nexport function timeoutAfter(ms: number) {\n  return wait(ms);\n}\n",
  "src/old.ts": "export function oldHelper() {\n  return 1;\n}\n",
  "src/user.ts": "import { oldHelper } from './old';\nexport function useOld() {\n  return oldHelper();\n}\n",
  "src/solo.ts": "export function standalone() {\n  return 0;\n}\n",
  "docs/guide.md": "# Guide\n\nRetry the request after a [timeout](notes.md).\n",
  "docs/notes.md": "# Notes\n\nA timeout waits.\n"
};
const CHANGED = {
  "src/wait.ts": "export function wait(ms: number, label = 'wait') {\n  return new Promise(resolve => setTimeout(() => resolve(label), ms));\n}\n",
  "src/later.ts": "export function helperLater() {\n  return 'done';\n}\n",
  "docs/notes.md": "# Notes\n\nA timeout waits, then retries.\n"
};
const REMOVED = ["src/old.ts"];
const counter = () => {
  const counted = [];
  const words = (text) => text.split(/\s+/).filter(Boolean).length;
  return { counted, tools: { countTokens: words, fileTokens: (text) => { counted.push(text); return words(text); } } };
};

async function folder(t, prefix) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function place(mirror, sources) {
  for (const [file, content] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(mirror, file)), { recursive: true });
    await rm(path.join(mirror, file), { force: true });
    await writeFile(path.join(mirror, file), content);
  }
}
const listed = (sources) => Object.entries(sources).map(([file, content]) => ({ file, hash: sha(content) })).sort((a, b) => a.file < b.file ? -1 : 1);
const args = (mirror, sources, extra = {}) => ({ mirror, files: listed(sources), snapshot: "c".repeat(64), modelDirectory: "unused", modelIdentity: "model", ...extra });
// The index is stored as JSON, so a field without a value is compared as the stored index leaves it out.
const comparable = ({ resources: _resources, ...index }) => JSON.parse(JSON.stringify(index));
const after = () => { const sources = { ...SOURCES, ...CHANGED }; for (const file of REMOVED) delete sources[file]; return sources; };

test("an incremental build after adding, changing, and removing files returns the same index as a full build of the same files", async (t) => {
  const kept = path.join(await folder(t, "prism-incremental-kept-"), "mirror");
  await place(kept, SOURCES);
  await structure(args(kept, SOURCES), () => {}, counter().tools);
  await place(kept, CHANGED);
  for (const file of REMOVED) await rm(path.join(kept, file));
  const sources = after();
  const changedFiles = Object.keys(CHANGED).sort();
  const phases = [];
  const { counted, tools } = counter();
  const incremental = await structure(args(kept, sources, { changedFiles, removedFiles: REMOVED }), (value) => phases.push(value), tools);
  const fresh = path.join(await folder(t, "prism-incremental-full-"), "mirror");
  await place(fresh, sources);
  const full = await structure(args(fresh, sources), () => {}, counter().tools);
  assert.deepEqual(comparable(incremental), comparable(full));
  // Only the changed files were counted again, and the graph synced the changed files and those that link to them, never the unrelated one.
  assert.deepEqual(counted.sort(), changedFiles.map((file) => CHANGED[file]).sort());
  const parsed = phases.filter((value) => value.phase === "graph:parsing").map((value) => value.total);
  assert.ok(parsed.length && Math.max(...parsed) <= 5, `the graph parsed ${JSON.stringify(parsed)} of 6 code files`);
  // A reference into the added file now resolves, and nothing still names the removed one.
  assert.ok(incremental.edges.some((edge) => incremental.units.find((unit) => unit.id === edge.target)?.name === "helperLater"));
  assert.ok(!incremental.units.some((unit) => unit.file === "src/old.ts"));
});

test("a build without usable state builds in full and still returns the same index", async (t) => {
  const parent = await folder(t, "prism-incremental-lost-");
  const kept = path.join(parent, "mirror");
  await place(kept, SOURCES);
  await structure(args(kept, SOURCES), () => {}, counter().tools);
  assert.ok((await stat(path.join(parent, "runtime-state", "graph.json"))).isFile());
  await place(kept, CHANGED);
  for (const file of REMOVED) await rm(path.join(kept, file));
  // A record that cannot be read, and a derived state of another chunker, both count as missing.
  await writeFile(path.join(parent, "runtime-state", "graph.json"), "not json");
  const derived = JSON.parse(await readFile(path.join(parent, "runtime-state", "derived.json"), "utf8"));
  await writeFile(path.join(parent, "runtime-state", "derived.json"), JSON.stringify({ ...derived, chunkerVersion: "other" }));
  const sources = after();
  const { counted, tools } = counter();
  const incremental = await structure(args(kept, sources, { changedFiles: Object.keys(CHANGED).sort(), removedFiles: REMOVED }), () => {}, tools);
  const fresh = path.join(await folder(t, "prism-incremental-full-"), "mirror");
  await place(fresh, sources);
  assert.deepEqual(comparable(incremental), comparable(await structure(args(fresh, sources), () => {}, counter().tools)));
  assert.equal(counted.length, Object.keys(sources).length);
});

test("a changed file the request did not name is still synced, because the kept state records what it was built from", async (t) => {
  const kept = path.join(await folder(t, "prism-incremental-unnamed-"), "mirror");
  await place(kept, SOURCES);
  await structure(args(kept, SOURCES), () => {}, counter().tools);
  await place(kept, CHANGED);
  for (const file of REMOVED) await rm(path.join(kept, file));
  const sources = after();
  const incremental = await structure(args(kept, sources, { changedFiles: [], removedFiles: [] }), () => {}, counter().tools);
  const fresh = path.join(await folder(t, "prism-incremental-full-"), "mirror");
  await place(fresh, sources);
  assert.deepEqual(comparable(incremental), comparable(await structure(args(fresh, sources), () => {}, counter().tools)));
});
