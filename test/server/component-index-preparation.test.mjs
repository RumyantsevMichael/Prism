import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readdir, rm } from "node:fs/promises";
import { FILES, entry, fakeRuntime, fingerprint, manifestPath, project, settled, sha256 } from "./fixtures/component-indexes.mjs";

// Acceptance tests of components.md §20-§24 and §26 for the component-indexes contract, clauses 1-8, 10-13, 21, and 25.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-index-data-"));
// The shared runtime never downloads assets in these tests; each test passes its own runtime.
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { openNativeRepositoryIntelligence } = await import("../../dist/server/repository-intelligence/native-repository-intelligence.mjs");

const ROOT_FILES = [".prism/workflow.md", "README.md"];
const NET_FILES = ["packages/net/retry.ts", "packages/net/timeout.ts"];
const APP_FILES = ["packages/app/client.ts"];
const search = (root, runtime, input = {}, waitMs = 2000) => searchRepositoryConcepts({ projectRoot: root, query: "retry the request", ...input }, { runtime, waitMs });
const built = (control) => control.builds.map((build) => build.files);

test("clause 1: a repository without components keeps its one index, its storage, and its fields", async (t) => {
  const { root, storage } = await project(t, { components: null });
  const first = await fakeRuntime(storage);
  await first.runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 0);
  await settled(first.runtime, root);
  assert.deepEqual(built(first.control), [[...ROOT_FILES, ...APP_FILES, ...NET_FILES].sort()]);
  // A later session reuses the index that the earlier one prepared, from the same storage.
  const later = await fakeRuntime(storage);
  const found = await search(root, later.runtime);
  assert.equal(found.status, "ready");
  assert.deepEqual(later.control.builds, []);
  assert.equal("components" in found, false);
  assert.equal("components" in (await later.runtime.status(root)), false);
});

test("clauses 2, 8, and 10: a path-scoped call prepares only the components that hold the paths, each holding only its own files", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  const found = await search(root, runtime, { filters: { paths: ["packages/net"] } });
  assert.deepEqual(built(control), [NET_FILES]);
  assert.equal(found.status, "ready");
  assert.deepEqual((found.components ?? []).map(({ indexRevision, ...rest }) => rest), [{ component: "root/net", folder: "packages/net", status: "included", failure: null }]);
  assert.match(found.components?.[0].indexRevision, /^[a-f0-9]{64}$/);
  assert.ok(found.results.length > 0 && found.results.every((result) => result.file.startsWith("packages/net/")));
  // A path that only the root component holds selects only the root component.
  await search(root, runtime, { filters: { paths: ["README.md"] } });
  assert.deepEqual(built(control), [NET_FILES, ROOT_FILES]);
  // A path that no component holds selects none, and the answer is ready and empty.
  const none = await search(root, runtime, { filters: { paths: ["packages/missing"] } });
  assert.deepEqual([none.status, none.components, none.results], ["ready", [], []]);
  assert.equal(control.builds.length, 2);
});

test("clauses 2 and 8: an unscoped call prepares every component that holds a file, the declared ones in component order and then the root component", async (t) => {
  const { root, storage, write } = await project(t, { components: ["## Components", "- net: packages/net", "- app: packages/app", "- empty: packages/empty", ""].join("\n") });
  await write("packages/empty/.gitkeep", "");
  const { runtime, control } = await fakeRuntime(storage);
  const found = await search(root, runtime);
  assert.deepEqual(built(control), [NET_FILES, APP_FILES, ["packages/empty/.gitkeep"], ROOT_FILES]);
  assert.deepEqual((found.components ?? []).map((item) => [item.component, item.status]), [["root/root", "included"], ["root/net", "included"], ["root/app", "included"], ["root/empty", "included"]]);
  assert.equal(found.status, "ready");
  assert.equal(entry(found, "root/root").folder, "");
});

test("clauses 3 and 4: a component is prepared again only when its own files change, from its own previous embeddings, and survives a rename", async (t) => {
  const { root, storage, write, configure } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  await search(root, runtime);
  assert.equal(control.builds.length, 3);
  await write("packages/app/client.ts", `${FILES["packages/app/client.ts"]}// changed\n`);
  await search(root, runtime);
  assert.equal(control.builds.length, 4);
  assert.deepEqual(control.builds[3].files, APP_FILES);
  // Only the app component's previous index supplies embeddings to its new build.
  assert.deepEqual(control.builds[3].previousEmbeddings, [sha256(`packages/app/client.ts\0${sha256(FILES["packages/app/client.ts"])}`)]);
  // A later session reuses every up-to-date component index from the storage.
  const later = await fakeRuntime(storage);
  const again = await search(root, later.runtime);
  assert.deepEqual([again.status, later.control.builds], ["ready", []]);
  // Renaming the repository changes the root component's workflow file and every identity, and no other component is prepared again.
  await configure({ workspace: ["- Repository: shop"] });
  const renamed = await search(root, later.runtime);
  assert.deepEqual(built(later.control), [ROOT_FILES]);
  assert.deepEqual((renamed.components ?? []).map((item) => item.component), ["shop/shop", "shop/net", "shop/app"]);
});

test("clause 5: a later call's waiting components move ahead of components that only an earlier call needs", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  control.hold("packages/net/retry.ts");
  const unscoped = await search(root, runtime, {}, 0);
  assert.equal(unscoped.status, "preparing");
  assert.deepEqual(unscoped.results, []);
  assert.deepEqual((unscoped.components ?? []).map((item) => item.component), ["root/root", "root/net", "root/app"]);
  assert.ok(["waiting", "preparing"].includes(entry(unscoped, "root/net")?.status));
  assert.deepEqual([entry(unscoped, "root/root")?.status, entry(unscoped, "root/app")?.status], ["waiting", "waiting"]);
  let status;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await runtime.status(root);
    if (entry(status, "root/net")?.status === "preparing" && built(control).length) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual((status.components ?? []).map((item) => [item.component, item.status]), [["root/root", "waiting"], ["root/net", "preparing"], ["root/app", "waiting"]]);
  // The root component builds after the declared ones, until a call that needs it moves it ahead of them.
  const scoped = await search(root, runtime, { filters: { paths: ["README.md"] } }, 0);
  assert.deepEqual((scoped.components ?? []).map((item) => [item.component, item.status]), [["root/root", "waiting"]]);
  // The running preparation is never interrupted.
  assert.deepEqual(built(control), [NET_FILES]);
  control.release("packages/net/retry.ts");
  await settled(runtime, root);
  assert.deepEqual(built(control), [NET_FILES, ROOT_FILES, APP_FILES]);
});

test("a stored component index loads at once instead of waiting behind a build", async (t) => {
  const { root, storage, write } = await project(t);
  const first = await fakeRuntime(storage);
  assert.equal((await search(root, first.runtime)).status, "ready");
  await write("packages/net/retry.ts", `${FILES["packages/net/retry.ts"]}// changed\n`);
  // A new process, as after a restart, has nothing loaded; net must build again, and app and the root component only load.
  const later = await fakeRuntime(storage);
  later.control.hold("packages/net/retry.ts");
  const found = await search(root, later.runtime, {}, 2000);
  assert.deepEqual((found.components ?? []).map((item) => [item.component, item.status]), [["root/root", "included"], ["root/net", "preparing"], ["root/app", "included"]]);
  assert.deepEqual(built(later.control), [NET_FILES]);
  later.control.release("packages/net/retry.ts");
  await settled(later.runtime, root);
  const after = await search(root, later.runtime);
  assert.equal(after.status, "ready", JSON.stringify({ components: after.components, problems: after.problems ?? after.notes ?? null }));
});

test("a stored index pointer whose index is gone hands the component back to the build queue", async (t) => {
  const { root, storage } = await project(t);
  const first = await fakeRuntime(storage);
  assert.equal((await search(root, first.runtime)).status, "ready");
  const { directory } = await first.runtime.location(root, { name: "app", identity: "root/app", folder: "packages/app" });
  for (const name of await readdir(directory)) if (/^[a-f\d]{64}\.json$/.test(name)) await rm(path.join(directory, name));
  const later = await fakeRuntime(storage);
  const found = await search(root, later.runtime, {}, 2000);
  assert.equal(found.status, "ready");
  assert.deepEqual(built(later.control), [APP_FILES]);
  assert.equal((await settled(later.runtime, root)).status, "indexed");
});

test("clause 6: a call waits at most its bound for its components and then answers", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  control.hold("packages/net/retry.ts");
  const started = Date.now();
  const found = await search(root, runtime, { filters: { paths: ["packages/net"] } }, 300);
  const elapsed = Date.now() - started;
  assert.equal(found.status, "preparing");
  assert.ok(elapsed >= 250 && elapsed < 5000, `waited ${elapsed} ms`);
  control.release("packages/net/retry.ts");
  await settled(runtime, root);
});

test("clauses 7, 11, and 12: a component that reaches a native limit is named, keeps the others, and is not prepared again for the same content", async (t) => {
  const { root, storage, write } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  control.fail("packages/app/client.ts", "resource_limit");
  const found = await search(root, runtime);
  assert.equal(found.status, "partial");
  assert.deepEqual((found.components ?? []).map((item) => [item.component, item.status]), [["root/root", "included"], ["root/net", "included"], ["root/app", "failed"]]);
  assert.equal(entry(found, "root/app").failure.code, "resource_limit");
  assert.match(entry(found, "root/app").failure.message, /30 minute/);
  assert.equal(entry(found, "root/app").indexRevision, null);
  const [missing] = found.diagnostics;
  assert.deepEqual([missing.code, missing.components], ["components_missing", ["root/app"]]);
  assert.match(missing.message, /root\/app/);
  assert.match(missing.message, /30 minute/);
  // The same content is not prepared again in this process.
  await search(root, runtime);
  assert.equal(control.builds.length, 3);
  const status = await runtime.status(root);
  assert.equal(entry(status, "root/app").status, "degraded");
  assert.equal(entry(status, "root/app").failure.code, "resource_limit");
  assert.equal(status.status, "degraded");
  // Another failure is retried by the next call that needs the component.
  control.fail("packages/net/retry.ts", "preparation_failed");
  await write("packages/net/retry.ts", `${FILES["packages/net/retry.ts"]}// changed\n`);
  const failed = await search(root, runtime, { filters: { paths: ["packages/net"] } });
  assert.deepEqual([failed.status, entry(failed, "root/net").status, entry(failed, "root/net").failure.code], ["degraded", "failed", "preparation_failed"]);
  control.recover("packages/net/retry.ts");
  const retried = await search(root, runtime, { filters: { paths: ["packages/net"] } });
  assert.equal(retried.status, "ready");
  assert.equal(control.builds.length, 5);
});

test("clause 11: a call whose every component failed is degraded", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  control.fail("packages/net/retry.ts", "preparation_failed");
  const found = await search(root, runtime, { filters: { paths: ["packages/net"] } });
  assert.equal(found.status, "degraded");
  assert.equal(found.preparationId, null);
  assert.deepEqual(found.diagnostics[0].components, ["root/net"]);
});

test("clause 13: snapshot and indexRevision identify the selected components, and a changed selection snapshot is refused", async (t) => {
  const { root, storage, write } = await project(t);
  const { runtime } = await fakeRuntime(storage);
  const found = await search(root, runtime, { filters: { paths: ["packages/net"] } });
  const net = fingerprint(NET_FILES.map((file) => [file, FILES[file]]));
  assert.equal(found.snapshot, sha256(`root/net ${net}\n`));
  assert.equal(found.indexRevision, sha256(`root/net ${found.components?.[0].indexRevision}\n`));
  assert.equal((await search(root, runtime, { filters: { paths: ["packages/net"] }, expectedSnapshot: found.snapshot })).status, "ready");
  // A change in another component leaves this selection's snapshot as it was.
  await write("packages/app/client.ts", "export function other(value) {\n  return value;\n}\n");
  assert.equal((await search(root, runtime, { filters: { paths: ["packages/net"] }, expectedSnapshot: found.snapshot })).snapshot, found.snapshot);
  const unscoped = await search(root, runtime);
  assert.notEqual(unscoped.snapshot, found.snapshot);
  await assert.rejects(search(root, runtime, { expectedSnapshot: found.snapshot }), { code: "stale_snapshot" });
});

test("clause 21: the status tools report each component without preparing any", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  await search(root, runtime, { filters: { paths: ["packages/net"] } });
  const status = await runtime.status(root);
  assert.deepEqual((status.components ?? []).map((item) => [item.component, item.folder, item.status]), [["root/root", "", "unprepared"], ["root/net", "packages/net", "ready"], ["root/app", "packages/app", "unprepared"]]);
  assert.equal(status.status, "indexed");
  assert.deepEqual([status.preparationId, status.snapshot, status.indexRevision, status.coverage], [null, null, null, null]);
  const net = entry(status, "root/net");
  assert.match(net.indexRevision, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(net.builtAt) > 0);
  assert.deepEqual([net.failure, net.diagnosticCount], [null, 0]);
  assert.equal(control.builds.length, 1);
  // Another process reads the published index of each component from the storage.
  const later = await fakeRuntime(storage);
  const read = await later.runtime.status(root);
  assert.deepEqual((read.components ?? []).map((item) => item.status), ["unprepared", "indexed", "unprepared"]);
  assert.deepEqual(later.control.builds, []);
});

test("clause 25: an invalid declaration refuses the native index and status tools before any preparation", async (t) => {
  const { root, storage } = await project(t, { components: ["## Components", "- net: packages/net", "- net: packages/app", ""].join("\n") });
  const { runtime, control } = await fakeRuntime(storage);
  await assert.rejects(search(root, runtime), { code: "component_invalid" });
  await assert.rejects(runtime.status(root), { code: "component_invalid" });
  assert.deepEqual(control.builds, []);
});
