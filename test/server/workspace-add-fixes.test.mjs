import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { alias, isolateGit, networkStore, place, request, startApp, storeCheckout, storeFolderId, workspaceId } from "./fixtures/workspace-view.mjs";

// An added workspace's own page exchanges a write grant, a removal names the store as the blocking checkout does, and a plaintext address never merges.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const folders = async (where) => (await readdir(path.join(where.app, "stores")).catch(() => [])).sort();
const add = (prism, url, headers = {}) => prism.post("/api/workspaces", { url }, headers);

test("an added workspace that no checkout serves exchanges a write grant on its own page, and that session adds and removes", async (context) => {
  const where = await place(context);
  const store = await networkStore(where, "store");
  const other = await networkStore(where, "other");
  const prism = await startApp(context, where);
  await prism.grant();
  assert.equal((await add(prism, store.url)).status, 200);
  const id = workspaceId(store.identity);
  await prism.app.close();

  // A new start of the app keeps the added workspace and opens its tab with one grant, as prism review --workspaces does.
  const again = await startApp(context, where);
  const presented = await again.control("present", { method: "POST", body: { open: true, acceptsGrant: true } });
  assert.equal(presented.status, 200, presented.body);
  assert.ok(presented.json.writeGrant, presented.body);
  const page = `${again.viewer}/w/${id}/`;
  const exchanged = await request(`${page}api/write-session`, { method: "POST", body: { grant: presented.json.writeGrant } });
  assert.equal(exchanged.status, 200, exchanged.body);
  assert.ok(exchanged.json.token);
  const session = { "X-Prism-Write": exchanged.json.token };
  const reused = await request(`${page}api/write-session`, { method: "POST", body: { grant: presented.json.writeGrant } });
  assert.equal(reused.status, 403);

  assert.equal((await add(again, other.url, session)).status, 200);
  const removed = await again.del(`/api/workspaces/${id}`, session);
  assert.equal(removed.status, 200, removed.body);
  assert.equal(removed.json.removed, true);
});

test("a store kept because of a checkout is named by the URL that checkout names, not by the alias it was added by", async (context) => {
  const where = await place(context);
  const store = await networkStore(where, "store");
  const prism = await startApp(context, where);
  await prism.grant();
  const api = await storeCheckout(context, where, "api", store.url);
  await prism.register(api);
  const aliased = `ssh://work-alias/${store.owner}/store.git`;
  alias(aliased, store.bare);
  const merged = await add(prism, aliased);
  assert.equal(merged.status, 200, merged.body);
  assert.equal(merged.json.merged, true);
  const removed = await prism.del(`/api/workspaces/${workspaceId(store.identity)}`);
  assert.equal(removed.json.clone, "kept", removed.body);
  assert.ok(removed.json.message.includes(api), removed.json.message);
  assert.ok(removed.json.message.includes("example.invalid"), removed.json.message);
  assert.ok(!removed.json.message.includes("work-alias"), removed.json.message);
});

test("a plaintext address never merges into an encrypted workspace, and an encrypted one never into a plaintext workspace", async (context) => {
  const where = await place(context);
  const store = await networkStore(where, "store");
  const prism = await startApp(context, where);
  await prism.grant();
  const api = await storeCheckout(context, where, "api", store.url);
  await prism.register(api);

  const plain = `http://plain-host/${store.owner}/store.git`;
  alias(plain, store.bare);
  const added = await add(prism, plain);
  assert.equal(added.status, 200, added.body);
  assert.equal(added.json.merged, false);
  const plainIdentity = `http://plain-host/${store.owner}/store`;
  assert.notEqual(added.json.workspace.id, workspaceId(store.identity));
  assert.ok((await folders(where)).includes(storeFolderId(store.identity)));
  assert.equal((await folders(where)).length, 2);
  assert.equal((await prism.workspaces()).length, 2);

  const gitPlain = `git://plain-host/${store.owner}/store.git`;
  alias(gitPlain, store.bare);
  const second = await add(prism, gitPlain);
  assert.equal(second.status, 200, second.body);
  assert.equal(second.json.merged, false);
  assert.equal((await prism.workspaces()).length, 3);

  const encrypted = `ssh://work-alias/${store.owner}/store.git`;
  alias(encrypted, store.bare);
  const joined = await add(prism, encrypted);
  assert.equal(joined.status, 200, joined.body);
  assert.equal(joined.json.workspace.id, workspaceId(store.identity));
  assert.notEqual(joined.json.workspace.id, workspaceId(plainIdentity));
  assert.equal((await prism.workspaces()).length, 3);
});

test("an encrypted address added after a plaintext one stays its own workspace", async (context) => {
  const where = await place(context);
  const store = await networkStore(where, "store");
  const prism = await startApp(context, where);
  await prism.grant();
  const plain = `http://plain-host/${store.owner}/store.git`;
  alias(plain, store.bare);
  assert.equal((await add(prism, plain)).status, 200);
  const added = await add(prism, store.url);
  assert.equal(added.status, 200, added.body);
  assert.equal(added.json.merged, false);
  assert.equal(added.json.workspace.id, workspaceId(store.identity));
  assert.equal((await prism.workspaces()).length, 2);
});

test("a checkout's store URL seen before a merged alias stays first in the workspace's URLs and label across a restart of the app", async (context) => {
  const where = await place(context);
  const store = await networkStore(where, "store");
  const prism = await startApp(context, where);
  await prism.grant();
  const api = await storeCheckout(context, where, "api", store.url);
  await prism.register(api);
  const ssh = `ssh://work-alias/${store.owner}/store.git`;
  const scp = `work-alias:${store.owner}/store.git`;
  alias(ssh, store.bare);
  alias(scp, store.bare);
  assert.equal((await add(prism, ssh)).json.merged, true);
  assert.equal((await add(prism, scp)).json.merged, true);
  const id = workspaceId(store.identity);
  const storeOf = async (app) => (await app.get("/api/workspaces")).json.workspaces.find((entry) => entry.id === id).store;
  const before = await storeOf(prism);
  assert.deepEqual(before.urls, [store.url, ssh, scp]);
  await prism.app.close();

  const again = await startApp(context, where);
  const after = await storeOf(again);
  assert.deepEqual(after.urls, [store.url, ssh, scp]);
  assert.equal(after.label, before.label);
  assert.ok(!after.label.includes("work-alias"), after.label);
});
