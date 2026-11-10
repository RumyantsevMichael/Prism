import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeSemanticRuntime } from "../../dist/server/repository-intelligence/native-semantic-runtime.mjs";
import { openNativeRepositoryIntelligence } from "../../dist/server/repository-intelligence/native-repository-intelligence.mjs";
import { ProgressRecorder, gitFingerprint } from "../../dist/server/repository-intelligence/index-progress.mjs";
import { readIndexingStatus, readPublishedUnits } from "../../dist/server/repository-intelligence/index-status.mjs";
const manifestPath = fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url));
const available = async () => ({ supported: true, published: true });

async function fixture(t, { git = false } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-indexing-")));
  const root = path.join(directory, "project"); await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.ts"), "export const x = 1;\n");
  if (git) {
    const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    run("init", "-q"); run("-c", "user.name=t", "-c", "user.email=t@example.com", "add", "."); run("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "initial");
  }
  const cache = path.join(directory, "cache");
  const runtime = new NativeSemanticRuntime({ directory: cache, manifestPath });
  runtime.assets = async () => ({ runtime: "fake", modelIdentity: "model", assetIdentity: "assets" });
  return { directory, root, cache, runtime };
}

const index = (args, chunks = []) => ({ schemaVersion: 1, snapshot: args.snapshot, modelIdentity: "model", units: [], edges: [], chunks, fileCoverage: { "a.ts": true }, diagnostics: [], counts: { files: 1, fragments: chunks.length }, structureComplete: true });
const status = (root, cache, options = {}) => readIndexingStatus(root, [cache], { availability: available, fingerprint: () => gitFingerprint(root), ...options });

test("a running build publishes its current step beside the index and removes it when the index is ready", async t => {
  const { root, cache, runtime } = await fixture(t, { git: true });
  assert.equal((await status(root, cache)).state, "none");
  let release, seen;
  const gate = new Promise(resolve => { release = resolve; });
  runtime.store = runtime.inProcessStore();
  runtime.helper = () => ({ request: async (_method, args, progress) => {
    progress({ phase: "embedding", current: 8, total: 32 });
    await gate;
    return index(args);
  } });
  const preparing = runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 0);
  for (let attempt = 0; attempt < 100 && seen?.progress?.phase !== "embedding"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    seen = await status(root, cache);
  }
  assert.equal(seen.state, "preparing");
  assert.deepEqual(seen.progress, { phase: "embedding", current: 8, total: 32 });
  release(); await preparing; await runtime.status(root, 1000);
  const ready = await status(root, cache);
  assert.equal(ready.state, "ready");
  assert.equal(ready.stale, false);
  assert.ok(Date.parse(ready.index.builtAt) > 0);
  assert.ok(!(await readdir((await runtime.location(root)).directory)).some(name => name.startsWith("progress-")));
});

test("the stale hint follows Git changes and a reused index moves its freshness forward", async t => {
  const { root, cache, runtime } = await fixture(t, { git: true });
  let builds = 0;
  runtime.store = runtime.inProcessStore();
  runtime.helper = () => ({ request: async (_method, args) => { builds++; return index(args); } });
  assert.equal((await runtime.prepare(await openNativeRepositoryIntelligence(root))).status, "ready");
  assert.equal((await status(root, cache)).stale, false);
  await writeFile(path.join(root, "a.ts"), "export const x = 2;\n");
  assert.equal((await status(root, cache)).stale, true, "an edited file makes the index stale");
  await writeFile(path.join(root, "a.ts"), "export const x = 1;\n");
  await writeFile(path.join(root, "notes.md"), "# Notes\n");
  await rm(path.join(root, "notes.md"));
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "empty"], { cwd: root });
  assert.equal((await status(root, cache)).stale, true, "a new commit looks stale until the next use");
  assert.equal((await runtime.prepare(await openNativeRepositoryIntelligence(root))).status, "ready");
  assert.equal(builds, 1, "unchanged content reuses the index");
  assert.equal((await status(root, cache)).stale, false, "the reuse records the new commit");
});

test("a folder without Git gives no stale hint", async t => {
  const { root, cache, runtime } = await fixture(t);
  runtime.store = runtime.inProcessStore();
  runtime.helper = () => ({ request: async (_method, args) => index(args) });
  await runtime.prepare(await openNativeRepositoryIntelligence(root));
  const ready = await status(root, cache);
  assert.equal(ready.state, "ready");
  assert.equal(ready.stale, null);
});

test("a failed build stays visible until a later index replaces it", async t => {
  const { root, cache, runtime } = await fixture(t);
  let fail = true;
  runtime.store = runtime.inProcessStore();
  runtime.helper = () => ({ request: async (_method, args) => { if (fail) throw Object.assign(new Error("The model could not load."), { code: "preparation_failed" }); return index(args); } });
  assert.equal((await runtime.prepare(await openNativeRepositoryIntelligence(root))).status, "degraded");
  const failed = await status(root, cache);
  assert.equal(failed.state, "failed");
  assert.equal(failed.diagnostics[0].code, "preparation_failed");
  assert.equal(failed.index, null);
  fail = false;
  assert.equal((await runtime.prepare(await openNativeRepositoryIntelligence(root))).status, "ready");
  assert.equal((await status(root, cache)).state, "ready");
});

test("progress from a stopped process reads as interrupted, and an older one gives way to the index", async t => {
  const { root, cache, runtime } = await fixture(t);
  const storage = (await runtime.location(root)).directory;
  await mkdir(storage, { recursive: true });
  const stopped = { schemaVersion: 1, pid: 2 ** 22 + 12345, preparationId: "p", state: "preparing", startedAt: new Date(Date.now() - 5000).toISOString(),
    updatedAt: new Date(Date.now() - 4000).toISOString(), progress: { phase: "graph:parsing", current: 3, total: 9 }, diagnostics: [] };
  await writeFile(path.join(storage, `progress-${stopped.pid}.json`), JSON.stringify(stopped));
  assert.equal((await status(root, cache)).state, "interrupted");
  const hung = { ...stopped, pid: process.pid, updatedAt: new Date(Date.now() - 120000).toISOString() };
  await writeFile(path.join(storage, `progress-${process.pid}.json`), JSON.stringify(hung));
  assert.equal((await status(root, cache, { now: Date.now() })).state, "interrupted", "a live process without heartbeats is not shown as running");
  await rm(path.join(storage, `progress-${process.pid}.json`));
  runtime.store = runtime.inProcessStore();
  runtime.helper = () => ({ request: async (_method, args) => index(args) });
  await runtime.prepare(await openNativeRepositoryIntelligence(root));
  assert.ok(!(await readdir(storage)).includes(`progress-${stopped.pid}.json`), "a new build removes progress of stopped processes");
  assert.equal((await status(root, cache)).state, "ready");
});

test("a session waiting for another session's build does not replace that build's progress", async t => {
  const { root, cache, runtime } = await fixture(t);
  const storage = (await runtime.location(root)).directory;
  await mkdir(storage, { recursive: true });
  const at = seconds => new Date(Date.now() - seconds * 1000).toISOString();
  // The lock holder reports sparsely while saving, and the waiting session's heartbeat is often the newer write.
  const building = { schemaVersion: 1, pid: process.ppid, preparationId: "p", state: "preparing", startedAt: at(60), updatedAt: at(3), progress: { phase: "embedding", current: 8, total: 32 }, diagnostics: [] };
  const waiting = { ...building, pid: process.pid, startedAt: at(20), updatedAt: at(0), progress: { phase: "waiting" } };
  await writeFile(path.join(storage, `progress-${building.pid}.json`), JSON.stringify(building));
  await writeFile(path.join(storage, `progress-${waiting.pid}.json`), JSON.stringify(waiting));
  assert.equal((await status(root, cache)).progress.phase, "embedding");
  await writeFile(path.join(storage, `progress-${building.pid}.json`), JSON.stringify({ ...building, updatedAt: at(0), progress: { phase: "saving" } }));
  await writeFile(path.join(storage, `progress-${waiting.pid}.json`), JSON.stringify({ ...waiting, updatedAt: at(4) }));
  assert.equal((await status(root, cache)).progress.phase, "saving");
});

test("a platform without a published runtime reads as unavailable", async t => {
  const { root, cache } = await fixture(t);
  assert.equal((await readIndexingStatus(root, [cache], { availability: async () => ({ supported: true, published: false }) })).state, "unavailable");
});

test("the recorder throttles progress writes but always writes a new step", async t => {
  const { directory } = await fixture(t);
  const recorder = new ProgressRecorder(directory, "p");
  await recorder.start();
  recorder.update({ phase: "snapshot-copy", current: 1, total: 100 });
  recorder.update({ phase: "snapshot-copy", current: 2, total: 100 });
  recorder.update({ phase: "graph:parsing", current: 1, total: 10 });
  await recorder.queue;
  assert.equal(JSON.parse(await readFile(path.join(directory, `progress-${process.pid}.json`), "utf8")).progress.phase, "graph:parsing");
  await recorder.fail([{ code: "preparation_failed", message: "Stopped." }]);
  const record = JSON.parse(await readFile(path.join(directory, `progress-${process.pid}.json`), "utf8"));
  assert.equal(record.state, "failed");
  assert.ok(record.finishedAt);
});

test("a recorder that a newer recorder of the same storage replaced changes the progress file no more", async t => {
  const { directory } = await fixture(t);
  const file = path.join(directory, `progress-${process.pid}.json`);
  const replaced = new ProgressRecorder(directory, "replaced"), newer = new ProgressRecorder(directory, "newer");
  await replaced.start();
  await newer.start();
  replaced.update({ phase: "saving" });
  assert.equal(JSON.parse(await readFile(file, "utf8")).preparationId, "newer");
  await newer.succeed();
  await replaced.fail([{ code: "stale_snapshot", message: "The source changed." }]);
  await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
  // A failure recorded before any build still writes the file once no recorder holds it.
  await new ProgressRecorder(directory, "background").fail([{ code: "preparation_failed", message: "Unreadable." }]);
  assert.equal(JSON.parse(await readFile(file, "utf8")).preparationId, "background");
});

test("a published index carries a units sidecar that is read without the full index and without preparing", async t => {
  const { root, cache, runtime } = await fixture(t);
  assert.equal(await readPublishedUnits(root, [cache]), null);
  const units = [
    { id: "a", file: "a.ts", kind: "function", name: "x", qualifiedName: "a.x", range: { startLine: 1, endLine: 1 }, sourceHash: "h", rangeComplete: true, signature: "x()", span: { start: 0, end: 5 } },
    { id: "b", file: "a.ts", kind: "variable", name: "y", range: { startLine: 2, endLine: 3 }, rangeComplete: true }
  ];
  const edges = [{ source: "a", target: "b", kind: "calls" }, { source: "a", target: "b", kind: "references" }, { source: "b", target: "a", kind: "references" }, { source: "a", target: "b", kind: "contains" }];
  runtime.store = runtime.inProcessStore();
  runtime.helper = () => ({ request: async (_method, args) => ({ ...index(args, [{ embeddingKey: "k", embedding: [1, 2] }]), units, edges }) });
  const prepared = await runtime.prepare(await openNativeRepositoryIntelligence(root));
  const storage = (await runtime.location(root)).directory, revision = prepared.prepared.revision;
  const sidecar = path.join(storage, `units-${revision}.json`);
  assert.equal((await stat(sidecar)).mode & 0o777, 0o600);
  // An index published before sidecars existed reads as no units until a later preparation reuses it and writes its sidecar.
  await rm(sidecar);
  assert.equal(await readPublishedUnits(root, [cache]), null);
  const later = new NativeSemanticRuntime({ directory: cache, manifestPath });
  later.assets = runtime.assets;
  later.helper = () => { throw new Error("A reused index must not rebuild."); };
  assert.equal((await later.prepare(await openNativeRepositoryIntelligence(root))).prepared.revision, revision);
  await stat(sidecar);
  // A damaged full index does not matter, because only the pointer and the sidecar are read.
  await writeFile(path.join(storage, `${revision}.json`), "not json");
  const before = (await readdir(storage)).sort();
  const published = await readPublishedUnits(root, [cache]);
  assert.deepEqual((await readdir(storage)).sort(), before, "reading changes no file");
  assert.equal(published.snapshot, prepared.snapshot);
  assert.equal(published.revision, revision);
  assert.ok(Date.parse(published.builtAt) > 0);
  assert.deepEqual(published.units, [
    { id: "a", file: "a.ts", kind: "function", name: "x", qualifiedName: "a.x", range: { startLine: 1, endLine: 1 }, sourceHash: "h" },
    { id: "b", file: "a.ts", kind: "variable", name: "y", range: { startLine: 2, endLine: 3 } }
  ]);
  assert.deepEqual(published.edges, [["a", "b"], ["b", "a"]]);
});
