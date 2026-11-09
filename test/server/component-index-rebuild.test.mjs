import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FILES, fakeRuntime, manifestPath, project, settled } from "./fixtures/component-indexes.mjs";

// Acceptance tests of the initiative-settings-actions contract, clauses 31-33: an index target's rebuild and state are its own component's.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-rebuild-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { resetBackgroundPreparation, startIndexRebuild } = await import("../../dist/server/repository-intelligence/background-preparation.mjs");
const { readIndexingStatus } = await import("../../dist/server/repository-intelligence/index-status.mjs");
const { nativeSemanticRuntime } = await import("../../dist/server/repository-intelligence/native-semantic-runtime.mjs");
const { listActions } = await import("../../dist/server/workflow/actions.mjs");
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");

const ROOT_FILES = [".prism/workflow.md", "README.md"];
const NET_FILES = ["packages/net/retry.ts", "packages/net/timeout.ts"];
const APP_FILES = ["packages/app/client.ts"];
const NET = { identity: "root/net", folder: "packages/net" };
const APP = { identity: "root/app", folder: "packages/app" };
const available = async () => true;
const changed = (file) => `${FILES[file]}// changed\n`;
const rebuild = (root, runtime, component) => startIndexRebuild(root, { runtime, available, component });

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The expected state did not arrive.");
}

test("clause 32: a component's rebuild prepares only that component, also one without an index, and reuses it while it is up to date", async (t) => {
  resetBackgroundPreparation();
  const { root, storage, write } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  await rebuild(root, runtime, NET);
  await settled(runtime, root);
  assert.deepEqual(control.builds.map((build) => build.files), [NET_FILES], "only the asked component is prepared, though no component had an index");
  await rebuild(root, runtime, NET);
  await settled(runtime, root);
  assert.equal(control.builds.length, 1, "an up-to-date index is reused without a build");
  await write("packages/net/retry.ts", changed("packages/net/retry.ts"));
  await write("packages/app/client.ts", changed("packages/app/client.ts"));
  await rebuild(root, runtime, APP);
  await settled(runtime, root);
  assert.deepEqual(control.builds.slice(1).map((build) => build.files), [APP_FILES], "another component's change does not rebuild it");
});

test("clause 32: a component's rebuild retries its own failure, including a native limit, and no other failed component", async (t) => {
  resetBackgroundPreparation();
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  control.fail("packages/app/client.ts", "resource_limit");
  control.fail("README.md", "preparation_failed");
  await searchRepositoryConcepts({ projectRoot: root, query: "retry the request" }, { runtime, waitMs: 2000 });
  await settled(runtime, root);
  const before = control.builds.length;
  control.recover("packages/app/client.ts");
  control.recover("README.md");
  await rebuild(root, runtime, APP);
  await settled(runtime, root);
  assert.deepEqual(control.builds.slice(before).map((build) => build.files), [APP_FILES]);
});

test("clause 32: rebuilds of two components started together both run, one queued behind the other", async (t) => {
  resetBackgroundPreparation();
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  control.hold("packages/net/retry.ts");
  const first = rebuild(root, runtime, NET);
  const second = rebuild(root, runtime, APP);
  await until(() => control.builds.length >= 1);
  control.release("packages/net/retry.ts");
  await Promise.all([first, second]);
  await settled(runtime, root);
  assert.deepEqual(control.builds.map((build) => build.files), [NET_FILES, APP_FILES], "the second component does not join the first one's rebuild");
});

test("clause 32: a repository without components rebuilds its one index for its root target", async (t) => {
  resetBackgroundPreparation();
  const { root, storage } = await project(t, { components: null });
  const { runtime, control } = await fakeRuntime(storage);
  await rebuild(root, runtime, { identity: "root/root", folder: "" });
  await settled(runtime, root);
  assert.deepEqual(control.builds.map((build) => build.files), [[...ROOT_FILES, ...APP_FILES, ...NET_FILES].sort()]);
});

test("clause 32: an invalid declaration prepares nothing for a component's rebuild", async (t) => {
  resetBackgroundPreparation();
  const { root, storage } = await project(t, { components: ["## Components", "- net: packages/net", "- app: packages/net/app", ""].join("\n") });
  const { runtime, control } = await fakeRuntime(storage);
  await rebuild(root, runtime, NET);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(control.builds, []);
});

test("clauses 31 and 32: Prism's own indexer shows each index target its own component's state", async (t) => {
  resetBackgroundPreparation();
  const { root } = await project(t);
  // The registry's own indexer reads Prism's index storage, so this runtime builds there.
  const { runtime, control } = await fakeRuntime(nativeSemanticRuntime.directory);
  await rebuild(root, runtime, NET);
  await settled(runtime, root);
  control.hold("packages/app/client.ts");
  const running = rebuild(root, runtime, APP);
  await until(async () => (await readIndexingStatus(root, [nativeSemanticRuntime.directory])).components?.some((entry) => entry.component === APP.identity && entry.state === "preparing"));
  const view = async (identity) => (await listActions({ projectRoot: root, target: `index:${identity}` })).actions[0];
  const app = await view(APP.identity);
  assert.deepEqual([app.available, app.reason], [false, "An index build is already running."]);
  const net = await view(NET.identity);
  assert.deepEqual([net.available, net.reason], [true, null], "a ready component stays available while another prepares");
  const rootComponent = await view("root/root");
  assert.deepEqual([rootComponent.available, rootComponent.reason], [true, null], "a component without an index or a preparation has the state none");
  control.release("packages/app/client.ts");
  await running;
  await settled(runtime, root);
});
