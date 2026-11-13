import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FILES, manifestPath, project } from "./fixtures/component-indexes.mjs";
import { embeddingKey, fakeVector, stagedRuntime, until } from "./fixtures/staged-runtime.mjs";

// Acceptance tests of index-preparation.md §2-§4 for the index-preparation contract, clauses 2-4, 7, 8, 10-14.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-index-resume-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { openNativeRepositoryIntelligence } = await import("../../dist/server/repository-intelligence/native-repository-intelligence.mjs");
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { readProgressRecords } = await import("../../dist/server/repository-intelligence/index-progress.mjs");

// A build that stalls on purpose is stopped after this period, which must outlast a slow runner's start before the build's first report,
// since a Windows runner took more than 250 ms there and the build then stalled while starting rather than in the phase a test holds.
const STALL_MS = 3000;
const RECORD = 32 + 384 * 4;
// The files of the fixture project in path order, which is the order in which the staged runtime embeds them.
const ORDER = [".prism/workflow.md", "README.md", "packages/app/client.ts", "packages/net/retry.ts", "packages/net/timeout.ts"];
const prepare = async (runtime, root) => runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 0);
const statusIs = (runtime, root, value) => until(async () => { const status = await runtime.status(root); return status.status === value && status; }, `The index did not become ${value}.`);
const contentOf = async (root, file) => readFile(path.join(root, file), "utf8");
const keysOf = async (root, files) => Promise.all(files.map(async (file) => embeddingKey(await contentOf(root, file))));
const storeOf = async (runtime, root, component) => path.join((await runtime.location(root, component)).directory, "embeddings.bin");
const records = (bytes) => Array.from({ length: Math.floor(bytes.length / RECORD) }, (_, index) => {
  const record = bytes.subarray(index * RECORD, (index + 1) * RECORD);
  return { key: record.subarray(0, 32).toString("hex"), vector: Array.from({ length: 384 }, (_, value) => record.readFloatLE(32 + value * 4)) };
});

test("clause 7: a build that keeps making progress runs well past the stall period", async (t) => {
  const { root, storage } = await project(t, { components: null });
  // Each batch arrives well inside the stall period, with room for the snapshot check that a slow machine runs before the first report, and the build lasts longer than that period.
  const { runtime, control } = await stagedRuntime(storage, { stallMs: 1200 });
  control.delayMs = 400;
  await prepare(runtime, root);
  const status = await statusIs(runtime, root, "ready");
  assert.equal(status.coverage.newEmbeddings, ORDER.length);
  assert.equal(control.stops, 0);
});

test("clauses 4, 8, and 10: a build that only repeats its progress is stopped as stalled in its phase", async (t) => {
  const { root, storage } = await project(t, { components: null });
  const { runtime, control } = await stagedRuntime(storage, { stallMs: STALL_MS });
  control.heartbeat = true;
  control.hold("packages/net/retry.ts");
  await prepare(runtime, root);
  const status = await statusIs(runtime, root, "degraded");
  const [diagnostic] = status.diagnostics;
  assert.equal(diagnostic.code, "stalled");
  assert.equal(diagnostic.phase, "embedding");
  assert.match(diagnostic.message, /^The index build made no progress for \d+ seconds during embedding\.$/);
  assert.equal(diagnostic.recovery, "Repeat the call to resume the build from its saved work.");
  assert.ok(control.stops >= 1, "the helper that ran the build is stopped");
  const [record] = await readProgressRecords((await runtime.location(root)).directory);
  assert.equal(record?.state, "failed");
  assert.equal(record.diagnostics[0].code, "stalled");
  assert.equal(record.diagnostics[0].phase, "embedding");
});

test("clause 10: a stalled component names its phase, and the next call prepares it again", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await stagedRuntime(storage, { stallMs: STALL_MS });
  control.hold("packages/net/retry.ts", "structure");
  const search = () => searchRepositoryConcepts({ projectRoot: root, query: "retry the request", filters: { paths: ["packages/net"] } }, { runtime, waitMs: 0 });
  await search();
  const status = await until(async () => {
    const value = await runtime.status(root);
    return value.components?.find((item) => item.component === "root/net")?.status === "degraded" && value;
  }, "The net component did not stall.");
  const net = status.components.find((item) => item.component === "root/net");
  assert.equal(net.failure.code, "stalled");
  assert.equal(net.failure.phase, "graph:parsing");
  assert.match(net.failure.message, /^The index build made no progress for \d+ seconds during graph:parsing\.$/);
  control.release("packages/net/retry.ts");
  const again = await searchRepositoryConcepts({ projectRoot: root, query: "retry the request", filters: { paths: ["packages/net"] } }, { runtime, waitMs: 2000 });
  assert.equal(again.status, "ready");
  assert.equal(control.builds.length, 2, "a stall is not a native limit, so the next call prepares the component again");
});

test("clauses 2, 3, and 11: each embedded batch is saved as it arrives, and no status or record shows the index or the vectors", async (t) => {
  const { root, storage } = await project(t, { components: null });
  const { runtime, control } = await stagedRuntime(storage);
  control.hold("packages/net/retry.ts");
  await prepare(runtime, root);
  await control.reached("packages/net/retry.ts");
  const store = await storeOf(runtime, root);
  const saved = await until(async () => { const bytes = await readFile(store).catch(() => null); return bytes?.length === 3 * RECORD && bytes; }, "The three embedded fragments were not saved.");
  if (process.platform !== "win32") assert.equal((await stat(store)).mode & 0o777, 0o600);
  const expected = await keysOf(root, ORDER.slice(0, 3));
  assert.deepEqual(records(saved).map((record) => record.key), expected);
  assert.deepEqual(records(saved)[0].vector, fakeVector(expected[0]));
  const status = await runtime.status(root);
  assert.equal(status.progress?.phase, "embedding");
  assert.equal("vectors" in (status.progress ?? {}), false);
  assert.equal("index" in (status.progress ?? {}), false);
  const [record] = await readProgressRecords((await runtime.location(root)).directory);
  assert.equal("vectors" in (record?.progress ?? {}), false);
  assert.equal(JSON.stringify(record).includes("\"vectors\""), false);
  control.release("packages/net/retry.ts");
  await statusIs(runtime, root, "ready");
});

test("clauses 12 and 14: a later session reuses every embedding that a stalled build saved", async (t) => {
  const { root, storage } = await project(t, { components: null });
  const first = await stagedRuntime(storage, { stallMs: STALL_MS });
  first.control.hold("packages/net/timeout.ts");
  await prepare(first.runtime, root);
  await statusIs(first.runtime, root, "degraded");
  first.control.release("packages/net/timeout.ts");
  const later = await stagedRuntime(storage);
  await prepare(later.runtime, root);
  const status = await statusIs(later.runtime, root, "ready");
  const saved = await keysOf(root, ORDER.slice(0, 4));
  assert.deepEqual(later.control.builds[0].previousEmbeddings, [...saved].sort());
  assert.deepEqual([status.coverage.reusedEmbeddings, status.coverage.newEmbeddings], [4, 1]);
});

test("clauses 12 and 14: a failed build's embeddings serve unchanged fragment text after an edit, past a torn final record", async (t) => {
  const { root, storage, write } = await project(t, { components: null });
  const first = await stagedRuntime(storage);
  first.control.fail("packages/net/timeout.ts");
  await prepare(first.runtime, root);
  await statusIs(first.runtime, root, "degraded");
  const store = await storeOf(first.runtime, root);
  // A writer that stopped in the middle of a record leaves a short final record.
  await appendFile(store, Buffer.alloc(RECORD - 100, 7));
  await write("README.md", `${FILES["README.md"]}Changed.\n`);
  const later = await stagedRuntime(storage);
  await prepare(later.runtime, root);
  const status = await statusIs(later.runtime, root, "ready");
  const unchanged = await keysOf(root, [".prism/workflow.md", "packages/app/client.ts", "packages/net/retry.ts"]);
  for (const key of unchanged) assert.ok(later.control.builds[0].previousEmbeddings.includes(key), "an unchanged fragment's saved embedding is reused");
  assert.deepEqual([status.coverage.reusedEmbeddings, status.coverage.newEmbeddings], [3, 2]);
});

test("clause 12: an unreadable embedding store counts as empty and never fails a build", async (t) => {
  const { root, storage } = await project(t, { components: null });
  const first = await stagedRuntime(storage);
  first.control.fail("packages/net/timeout.ts");
  await prepare(first.runtime, root);
  await statusIs(first.runtime, root, "degraded");
  const store = await storeOf(first.runtime, root);
  const { rm, mkdir } = await import("node:fs/promises");
  await rm(store, { force: true });
  await mkdir(store);
  const later = await stagedRuntime(storage);
  await prepare(later.runtime, root);
  const status = await statusIs(later.runtime, root, "ready");
  assert.equal(status.coverage.newEmbeddings, ORDER.length);
});

test("clause 13: a complete index leaves one saved record per distinct embedding key of its fragments", async (t) => {
  const duplicate = { ...FILES, "packages/app/copy.ts": FILES["packages/app/client.ts"] };
  const { root, storage, write } = await project(t, { components: null, files: duplicate });
  const first = await stagedRuntime(storage);
  await prepare(first.runtime, root);
  await statusIs(first.runtime, root, "ready");
  await write("README.md", `${FILES["README.md"]}Changed.\n`);
  await prepare(first.runtime, root);
  await until(async () => (await first.runtime.status(root)).coverage?.reusedEmbeddings === ORDER.length, "The second build did not finish.");
  const bytes = await readFile(await storeOf(first.runtime, root));
  const expected = new Set(await keysOf(root, [...ORDER, "packages/app/copy.ts"]));
  assert.equal(bytes.length % RECORD, 0);
  assert.deepEqual(new Set(records(bytes).map((record) => record.key)), expected);
  assert.equal(records(bytes).length, expected.size);
});

test("clause 14: a component's later build reuses what its stalled build saved, in its own store", async (t) => {
  const { root, storage } = await project(t);
  const first = await stagedRuntime(storage, { stallMs: STALL_MS });
  first.control.hold("packages/net/timeout.ts");
  await searchRepositoryConcepts({ projectRoot: root, query: "retry", filters: { paths: ["packages/net"] } }, { runtime: first.runtime, waitMs: 0 });
  await until(async () => (await first.runtime.status(root)).components?.find((item) => item.component === "root/net")?.status === "degraded", "The net component did not stall.");
  first.control.release("packages/net/timeout.ts");
  const later = await stagedRuntime(storage);
  const found = await searchRepositoryConcepts({ projectRoot: root, query: "retry", filters: { paths: ["packages/net"] } }, { runtime: later.runtime, waitMs: 2000 });
  assert.equal(found.status, "ready");
  assert.deepEqual(later.control.builds[0].previousEmbeddings, await keysOf(root, ["packages/net/retry.ts"]));
});
