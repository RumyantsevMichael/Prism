import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FILES, fakeRuntime, manifestPath, project, settled } from "./fixtures/component-indexes.mjs";

// Acceptance tests of components.md §20-§22 for the component-indexes contract, clauses 1 and 25-29 for background preparation and the review browser.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-views-data-"));
// The shared runtime never downloads assets in these tests; each test passes its own runtime.
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { resetBackgroundPreparation, startBackgroundPreparation, startIndexRebuild } = await import("../../dist/server/repository-intelligence/background-preparation.mjs");
const { readIndexingStatus, readPublishedUnits } = await import("../../dist/server/repository-intelligence/index-status.mjs");
const { gitFingerprint } = await import("../../dist/server/repository-intelligence/index-progress.mjs");

const ROOT_FILES = [".prism/workflow.md", "README.md"];
const NET_FILES = ["packages/net/retry.ts", "packages/net/timeout.ts"];
const APP_FILES = ["packages/app/client.ts"];
const search = (root, runtime, input = {}, waitMs = 2000) => searchRepositoryConcepts({ projectRoot: root, query: "retry the request", ...input }, { runtime, waitMs });
const available = async () => true;
const changed = (file) => `${FILES[file]}// changed\n`;

test("clause 26: background preparation refreshes only the components that already have an index", async (t) => {
  resetBackgroundPreparation();
  const { root, storage, write } = await project(t);
  const first = await fakeRuntime(storage);
  await search(root, first.runtime, { filters: { paths: ["packages/net"] } });
  await write("packages/net/retry.ts", changed("packages/net/retry.ts"));
  const later = await fakeRuntime(storage);
  await startBackgroundPreparation(root, { runtime: later.runtime, available });
  await settled(later.runtime, root);
  assert.deepEqual(later.control.builds.map((build) => build.files), [NET_FILES]);
});

test("clause 25: background preparation and rebuild prepare nothing for an invalid declaration", async (t) => {
  resetBackgroundPreparation();
  const { root, storage } = await project(t, { components: ["## Components", "- net: packages/net", "- app: packages/net/app", ""].join("\n") });
  const { runtime, control } = await fakeRuntime(storage);
  await startBackgroundPreparation(root, { runtime, available });
  await startIndexRebuild(root, { runtime, available });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(control.builds, []);
});

test("clause 27: a rebuild prepares the components with an index or a failure that are out of date or failed", async (t) => {
  resetBackgroundPreparation();
  const { root, storage, write } = await project(t);
  const first = await fakeRuntime(storage);
  first.control.fail("packages/app/client.ts", "resource_limit");
  // The search answers after its wait even while components still prepare, which a busy runner can outlast, so the count is read once they settle.
  await search(root, first.runtime);
  await settled(first.runtime, root);
  assert.equal(first.control.builds.length, 3);
  await write("packages/net/retry.ts", changed("packages/net/retry.ts"));
  first.control.recover("packages/app/client.ts");
  // The rebuild retries a component that reached a native limit, even in the same process and for the same content.
  await startIndexRebuild(root, { runtime: first.runtime, available });
  await settled(first.runtime, root);
  assert.deepEqual(first.control.builds.slice(3).map((build) => build.files).sort(), [APP_FILES, NET_FILES].sort());
  assert.equal((await search(root, first.runtime)).status, "ready");
  assert.equal(first.control.builds.length, 5);
});

test("the review browser's automatic rebuild leaves a component that reached a native limit for its current content", async (t) => {
  resetBackgroundPreparation();
  const { root, storage, write } = await project(t);
  const first = await fakeRuntime(storage);
  first.control.fail("packages/app/client.ts", "resource_limit");
  // The search answers after its wait even while components still prepare, which a busy runner can outlast, so the count is read once they settle.
  await search(root, first.runtime);
  await settled(first.runtime, root);
  assert.equal(first.control.builds.length, 3);
  await write("packages/net/retry.ts", changed("packages/net/retry.ts"));
  // A later process, such as the review app after a restart, knows the limit only from the recorded failure.
  const later = await fakeRuntime(storage);
  await startIndexRebuild(root, { runtime: later.runtime, available, automatic: true });
  await settled(later.runtime, root);
  assert.deepEqual(later.control.builds.map((build) => build.files), [NET_FILES]);
  // The process that reached the limit does not retry it either; net is already up to date.
  await startIndexRebuild(root, { runtime: first.runtime, available, automatic: true });
  await settled(first.runtime, root);
  assert.equal(first.control.builds.length, 3);
  // Once its content changes, the automatic rebuild prepares it again.
  await write("packages/app/client.ts", changed("packages/app/client.ts"));
  later.control.recover("packages/app/client.ts");
  await startIndexRebuild(root, { runtime: later.runtime, available, automatic: true });
  await settled(later.runtime, root);
  assert.deepEqual(later.control.builds.slice(1).map((build) => build.files), [APP_FILES]);
});

test("clause 28: the review browser's index status combines the components and names the one preparing", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  assert.equal((await readIndexingStatus(root, [storage], { availability: async () => ({ supported: true, published: true }) })).state, "none");
  await search(root, runtime, { filters: { paths: ["packages/net"] } });
  const ready = await readIndexingStatus(root, [storage], { fingerprint: () => gitFingerprint(root) });
  assert.equal(ready.state, "ready");
  assert.equal(ready.stale, false);
  assert.deepEqual(ready.components, [{ component: "root/net", state: "ready" }]);
  assert.ok(Date.parse(ready.index.builtAt) > 0);
  const stale = await readIndexingStatus(root, [storage], { fingerprint: async () => ({ head: "other", worktree: "other" }) });
  assert.equal(stale.stale, true);
  control.hold("packages/app/client.ts");
  await search(root, runtime, { filters: { paths: ["packages/app"] } }, 0);
  let preparing;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    preparing = await readIndexingStatus(root, [storage]);
    if (preparing.state === "preparing" && preparing.progress) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(preparing.state, "preparing");
  assert.equal(preparing.progress.component, "root/app");
  assert.deepEqual(preparing.components, [{ component: "root/net", state: "ready" }, { component: "root/app", state: "preparing" }]);
  control.release("packages/app/client.ts");
  await settled(runtime, root);
  control.fail("README.md", "preparation_failed");
  await search(root, runtime, { filters: { paths: ["README.md"] } });
  const failed = await readIndexingStatus(root, [storage]);
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.components, [{ component: "root/root", state: "failed" }, { component: "root/net", state: "ready" }, { component: "root/app", state: "ready" }]);
});

test("clause 29: the code places come from every component's published units", async (t) => {
  const { root, storage } = await project(t);
  const { runtime } = await fakeRuntime(storage);
  assert.equal(await readPublishedUnits(root, [storage]), null);
  await search(root, runtime, { filters: { paths: ["packages"] } });
  const units = await readPublishedUnits(root, [storage]);
  const named = units.units.filter((unit) => unit.kind === "function").map((unit) => `${unit.file}#${unit.name}`).sort();
  assert.deepEqual(named, ["packages/app/client.ts#fetchUser", "packages/net/retry.ts#retryRequest", "packages/net/timeout.ts#timeoutAfter"]);
  assert.equal(units.units.some((unit) => unit.file === "README.md"), false);
});

test("clause 1: a repository without components keeps its one index in the review browser", async (t) => {
  const { root, storage } = await project(t, { components: null });
  const { runtime } = await fakeRuntime(storage);
  await search(root, runtime);
  const status = await readIndexingStatus(root, [storage]);
  assert.equal(status.state, "ready");
  assert.equal("components" in status, false);
  const units = await readPublishedUnits(root, [storage]);
  assert.ok(units.units.some((unit) => unit.file === "README.md") && units.units.some((unit) => unit.file === "packages/app/client.ts"));
});
