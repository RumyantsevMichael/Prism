import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FILES, manifestPath, project } from "./fixtures/component-indexes.mjs";
import { embeddingKey, stagedRuntime, until } from "./fixtures/staged-runtime.mjs";

// Acceptance tests of index-preparation.md §6 and §7 for the index-preparation contract, clauses 20 and 21.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-index-ahead-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { openNativeRepositoryIntelligence } = await import("../../dist/server/repository-intelligence/native-repository-intelligence.mjs");
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { readProgressRecords } = await import("../../dist/server/repository-intelligence/index-progress.mjs");

const ROOT_FILES = [".prism/workflow.md", "README.md"];
const NET_FILES = ["packages/net/retry.ts", "packages/net/timeout.ts"];
const APP_FILES = ["packages/app/client.ts"];
const NET = { name: "net", identity: "root/net", folder: "packages/net" };
const search = (root, runtime, paths, waitMs = 0) => searchRepositoryConcepts({ projectRoot: root, query: "retry the request", ...(paths ? { filters: { paths } } : {}) }, { runtime, waitMs });
const entry = (result, component) => result.components?.find((item) => item.component === component);
const built = (control) => control.builds.map((build) => build.files);
const settled = (runtime, root) => until(async () => {
  const status = await runtime.status(root);
  return !(status.components ?? []).some((item) => ["waiting", "preparing"].includes(item.status)) && status.status !== "preparing" && status;
}, "The preparations did not settle.");

// An unscoped search whose net build stops before it embeds timeout.ts, after it saved the embedding of retry.ts.
async function runningNet(t) {
  const context = await project(t);
  const staged = await stagedRuntime(context.storage);
  staged.control.hold("packages/net/timeout.ts");
  await search(context.root, staged.runtime);
  await staged.control.reached("packages/net/timeout.ts");
  return { ...context, ...staged };
}

test("clause 20: a call that needs a component without an index pauses an unrelated running build, which resumes from its saved work", async (t) => {
  const { root, runtime, control } = await runningNet(t);
  control.hold("README.md", "structure");
  await search(root, runtime, ["README.md"]);
  await control.reached("README.md");
  assert.deepEqual(built(control), [NET_FILES, ROOT_FILES], "the root component started without waiting for the net build");
  assert.ok(control.stops >= 1, "the paused build's helper is stopped");
  const paused = entry(await runtime.status(root), "root/net");
  assert.equal(paused.status, "waiting");
  assert.equal(paused.failure, null);
  const records = await readProgressRecords((await runtime.location(root, NET)).directory);
  assert.equal(records.some((record) => record.state === "failed"), false, "a paused build records no failure");
  control.release("README.md");
  assert.equal((await search(root, runtime, ["README.md"], 2000)).status, "ready");
  control.release("packages/net/timeout.ts");
  await settled(runtime, root);
  assert.deepEqual(built(control), [NET_FILES, ROOT_FILES, NET_FILES, APP_FILES], "the paused build runs directly after the call's components");
  assert.ok(control.builds[2].previousEmbeddings.includes(embeddingKey(FILES["packages/net/retry.ts"])), "the resumed build reuses what the paused one saved");
  assert.equal(entry(await search(root, runtime), "root/net").status, "included");
});

test("clause 20: a call whose components all have a stored index waits its turn without pausing the running build", async (t) => {
  const { root, storage, write } = await project(t);
  const { runtime, control } = await stagedRuntime(storage);
  assert.equal((await search(root, runtime, undefined, 2000)).status, "ready");
  await write("README.md", `${FILES["README.md"]}Changed.\n`);
  await write("packages/net/timeout.ts", `${FILES["packages/net/timeout.ts"]}// changed\n`);
  control.hold("packages/net/timeout.ts");
  await search(root, runtime);
  await control.reached("packages/net/timeout.ts");
  const scoped = await search(root, runtime, ["README.md"], 200);
  assert.ok(["waiting", "preparing"].includes(entry(scoped, "root/root").status));
  assert.equal(control.stops, 0);
  assert.equal(built(control).length, 4, "only the net build of the changed content started");
  control.release("packages/net/timeout.ts");
  await settled(runtime, root);
});

test("clause 20: a call that needs the running component does not pause it", async (t) => {
  const { root, runtime, control } = await runningNet(t);
  const scoped = await search(root, runtime, ["packages/net"], 100);
  assert.equal(entry(scoped, "root/net").status, "included", "the running build's published structure answers the call, as clause 18 states");
  assert.equal(entry(scoped, "root/net").embeddings, "pending");
  assert.equal(entry(await runtime.status(root), "root/net").status, "preparing", "the running build goes on embedding");
  assert.equal(control.stops, 0, "the running build's helper is not stopped");
  control.release("packages/net/timeout.ts");
  await settled(runtime, root);
  assert.equal(built(control).filter((files) => files.join() === NET_FILES.join()).length, 1, "the net build ran once, without a pause and a resumed run");
});

test("clause 21: a component waiting in this process's queue names the build it waits behind, in the status and in results", async (t) => {
  const { root, runtime, control } = await runningNet(t);
  const status = await runtime.status(root);
  const running = entry(status, "root/net");
  assert.equal(running.status, "preparing");
  assert.equal("waitingFor" in running, false);
  for (const component of ["root/root", "root/app"]) {
    assert.deepEqual(entry(status, component).waitingFor, { component: "root/net", preparationId: running.preparationId, reason: "queue" });
  }
  const result = await search(root, runtime);
  assert.deepEqual(entry(result, "root/app").waitingFor, { component: "root/net", preparationId: running.preparationId, reason: "queue" });
  assert.equal("waitingFor" in entry(result, "root/net"), false);
  control.release("packages/net/timeout.ts");
  await settled(runtime, root);
  assert.equal((await runtime.status(root)).components.some((item) => "waitingFor" in item), false);
});

test("clause 21: a component that another session is preparing names that session's preparation and the lock", async (t) => {
  const { root, storage, runtime: first, control } = await runningNet(t);
  const [record] = await until(async () => { const records = await readProgressRecords((await first.location(root, NET)).directory); return records.length && records; }, "The first session wrote no progress record.");
  const later = await stagedRuntime(storage);
  await search(root, later.runtime, ["packages/net"]);
  const net = await until(async () => { const value = entry(await later.runtime.status(root), "root/net"); return value?.waitingFor && value; }, "The later session's net component names nothing it waits for.");
  assert.deepEqual(net.waitingFor, { component: "root/net", preparationId: record.preparationId, reason: "lock" });
  control.release("packages/net/timeout.ts");
  await settled(first, root);
});

test("clause 21: a repository without components names the other session's build that holds its lock", async (t) => {
  const { root, storage } = await project(t, { components: null });
  const first = await stagedRuntime(storage);
  first.control.hold("packages/net/timeout.ts");
  await first.runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 0);
  await first.control.reached("packages/net/timeout.ts");
  const directory = (await first.runtime.location(root)).directory;
  const [record] = await readProgressRecords(directory);
  const later = await stagedRuntime(storage);
  await later.runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 0);
  const status = await until(async () => { const value = await later.runtime.status(root); return value.waitingFor && value; }, "The later session names nothing it waits for.");
  assert.deepEqual(status.waitingFor, { component: "root/root", preparationId: record.preparationId, reason: "lock" });
  first.control.release("packages/net/timeout.ts");
  await until(async () => (await later.runtime.status(root)).status === "ready", "The later session did not finish.");
  assert.equal("waitingFor" in (await later.runtime.status(root)), false);
  assert.ok(await readFile(path.join(directory, "current.json"), "utf8"));
});
