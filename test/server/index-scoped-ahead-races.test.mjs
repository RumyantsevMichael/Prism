import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { manifestPath, project } from "./fixtures/component-indexes.mjs";
import { stagedRuntime, until } from "./fixtures/staged-runtime.mjs";

// Races between a call that pauses an unrelated build and the queue that build runs in, and the lock holder that a waiting component names,
// for the index-preparation contract's clauses 20 and 21.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-index-ahead-races-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { ProgressRecorder, readProgressRecords } = await import("../../dist/server/repository-intelligence/index-progress.mjs");

const NET_FILES = ["packages/net/retry.ts", "packages/net/timeout.ts"];
const APP_FILES = ["packages/app/client.ts"];
const NET = { name: "net", identity: "root/net", folder: "packages/net" };
const APP = { name: "app", identity: "root/app", folder: "packages/app" };
const search = (root, runtime, paths) => searchRepositoryConcepts({ projectRoot: root, query: "retry the request", ...(paths ? { filters: { paths } } : {}) }, { runtime, waitMs: 0 });
const runs = (control, files) => control.builds.filter((build) => build.files.join() === files.join()).length;
const settled = (runtime, root) => until(async () => {
  const status = await runtime.status(root);
  return !(status.components ?? []).some((item) => ["waiting", "preparing"].includes(item.status)) && status;
}, "The preparations did not settle.");

// An unscoped search whose net build stops before it embeds timeout.ts, with app and the root component queued behind it.
async function runningNet(t) {
  const context = await project(t);
  const staged = await stagedRuntime(context.storage);
  staged.control.hold("packages/net/timeout.ts");
  await search(context.root, staged.runtime);
  await staged.control.reached("packages/net/timeout.ts");
  return { ...context, ...staged };
}

test("a needed build that starts while a call checks for stored indexes is not queued again, and runs once", async (t) => {
  const { root, runtime, control } = await runningNet(t);
  const app = (await runtime.location(root, APP)).directory;
  const published = runtime.published.bind(runtime);
  let raced = false;
  // app's build stays running until the checks below, so a fast machine cannot finish it and start the next job first.
  control.hold("packages/app/client.ts");
  // The call's read of app's stored index lasts until the net build ended and the queue started app.
  runtime.published = async (directory) => {
    if (directory === app && !raced) {
      raced = true;
      control.release("packages/net/timeout.ts");
      await until(() => runtime.running?.directory === app, "The queue did not start app.");
    }
    return published(directory);
  };
  await search(root, runtime, ["packages/app"]);
  assert.ok(raced, "the call read app's stored index");
  assert.equal(runtime.running?.directory, app);
  assert.equal(runtime.queue.some((job) => job.directory === app), false, "the running app build is not queued again");
  runtime.published = published;
  control.release("packages/app/client.ts");
  await settled(runtime, root);
  assert.equal(runs(control, APP_FILES), 1, "the app build ran once");
  assert.equal(runs(control, NET_FILES), 1);
});

test("a pause that arrives after the running build returned its index leaves the job ready and out of the queue, so it runs once", async (t) => {
  const { root, runtime, control } = await runningNet(t);
  const net = (await runtime.location(root, NET)).directory;
  const succeed = ProgressRecorder.prototype.succeed;
  let entered, leave;
  const inside = new Promise((resolve) => { entered = resolve; }), left = new Promise((resolve) => { leave = resolve; });
  // The net run's final progress record is written only once the test lets it, after its build already returned.
  ProgressRecorder.prototype.succeed = async function () {
    if (this.directory === net) { entered(); await left; }
    return succeed.call(this);
  };
  t.after(() => { ProgressRecorder.prototype.succeed = succeed; });
  control.release("packages/net/timeout.ts");
  await inside;
  // The root component has no index, so this call would pause an unrelated build that is still building.
  await search(root, runtime, ["README.md"]);
  leave();
  const job = await until(() => { const value = runtime.jobs.get(net); return value?.status === "ready" && runtime.running !== value && value; }, "The net build did not end ready.");
  assert.equal(runtime.queue.includes(job), false, "the ready net job is not queued again");
  ProgressRecorder.prototype.succeed = succeed;
  await settled(runtime, root);
  assert.equal(job.attempt, 1, "the net job ran once");
  assert.equal(runs(control, NET_FILES), 1);
});

test("a call for the running build's component at changed content never pauses that build, even before it published structure", async (t) => {
  const context = await project(t);
  const { root } = context;
  const { runtime, control } = await stagedRuntime(context.storage);
  control.hold("packages/net/timeout.ts", "structure");
  await search(root, runtime);
  await control.reached("packages/net/timeout.ts");
  const net = (await runtime.location(root, NET)).directory, building = runtime.running;
  assert.equal(building?.directory, net);
  await writeFile(path.join(root, "packages/net/retry.ts"), "export function retry(value) {\n  return value + 1;\n}\n");
  await search(root, runtime, ["packages/net"]);
  assert.equal(control.stops, 0, "the running net build is not stopped");
  assert.equal(runtime.running, building, "the running net build keeps running");
  control.release("packages/net/timeout.ts");
  await settled(runtime, root);
  assert.equal(control.stops, 0);
});

test("a component waiting for another session's lock names the session that holds it, never a session that only waits for it", async (t) => {
  const { root, storage, runtime: first, control } = await runningNet(t);
  const net = (await first.location(root, NET)).directory;
  const [holder] = await until(async () => { const records = await readProgressRecords(net); return records.length && records; }, "The holding session wrote no progress record.");
  // Another live process whose session only waits for net's lock, preparing different content.
  const now = new Date().toISOString();
  await writeFile(path.join(net, `progress-${process.ppid}.json`), JSON.stringify({ schemaVersion: 1, pid: process.ppid, preparationId: "f".repeat(64), state: "preparing",
    startedAt: now, updatedAt: now, progress: { phase: "waiting" }, diagnostics: [] }), { mode: 0o600 });
  const later = await stagedRuntime(storage);
  await search(root, later.runtime, ["packages/net"]);
  const waiting = await until(async () => { const value = (await later.runtime.status(root)).components?.find((item) => item.component === NET.identity); return value?.waitingFor && value; }, "The later session's net component names nothing it waits for.");
  assert.deepEqual(waiting.waitingFor, { component: NET.identity, preparationId: holder.preparationId, reason: "lock" });
  control.release("packages/net/timeout.ts");
  await settled(first, root);
});

test("a session that took the lock after waiting for it no longer waits, so a session that waits next names it as the holder", async (t) => {
  const { root, storage, control } = await runningNet(t);
  const entryOf = async (runtime) => (await runtime.status(root)).components?.find((item) => item.component === NET.identity);
  const second = await stagedRuntime(storage);
  await search(root, second.runtime, ["packages/net"]);
  await until(async () => (await entryOf(second.runtime))?.waitingFor, "The second session never waited for net's lock.");
  // The second session stops while it reads the index that the first session stored, which it does while holding the lock.
  let entered = false, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = second.runtime.store.read.bind(second.runtime.store);
  second.runtime.store.read = async (...args) => { entered = true; await gate; return read(...args); };
  control.release("packages/net/timeout.ts");
  await until(async () => entered, "The second session never read the stored index.");
  const holding = await entryOf(second.runtime);
  assert.equal(holding.waitingFor, undefined, "the session that holds the lock waits for nothing");
  assert.match(holding.preparationId ?? "", /^[a-f\d]{64}$/);
  const third = await stagedRuntime(storage);
  await search(root, third.runtime, ["packages/net"]);
  const waiting = await until(async () => (await entryOf(third.runtime))?.waitingFor, "The third session never waited for net's lock.");
  assert.deepEqual(waiting, { component: NET.identity, preparationId: holding.preparationId, reason: "lock" });
  release();
  await settled(second.runtime, root);
  await settled(third.runtime, root);
});
