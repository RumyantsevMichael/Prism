import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { alias, isolateGit, networkStore, place, startApp, storeCheckout, workspaceId } from "./fixtures/workspace-view.mjs";

// A checkout's Store value can carry a token, which neither the saved list of added workspaces nor the workspace list ever repeats.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

test("a checkout's credential-bearing store URL is never saved to workspaces.json or listed, before or after a restart of the app", async (context) => {
  const where = await place(context);
  const store = await networkStore(where, "store");
  const token = "ghp_SECRET123";
  const secret = `https://x-access-token:${token}@example.invalid/${store.owner}/store.git`;
  alias(secret, store.bare);
  const prism = await startApp(context, where);
  await prism.grant();
  const api = await storeCheckout(context, where, "api", secret);
  await prism.register(api);
  const id = workspaceId(store.identity);
  const storeOf = async (app) => (await app.get("/api/workspaces")).json.workspaces.find((entry) => entry.id === id)?.store;

  // A workspace that only a checkout serves lists the address without its credential.
  const listedBefore = await prism.get("/api/workspaces");
  assert.ok(!listedBefore.body.includes(token), listedBefore.body);

  const added = await prism.post("/api/workspaces", { url: store.url });
  assert.equal(added.status, 200, added.body);
  const saved = await readFile(path.join(where.app, "workspaces.json"), "utf8");
  assert.ok(!saved.includes(token), saved);
  const listed = await prism.get("/api/workspaces");
  assert.ok(!listed.body.includes(token), listed.body);
  const before = await storeOf(prism);
  assert.ok(before.urls.includes(store.url), JSON.stringify(before.urls));
  assert.equal(new Set(before.urls).size, before.urls.length, JSON.stringify(before.urls));
  await prism.app.close();

  const again = await startApp(context, where);
  const relisted = await again.get("/api/workspaces");
  assert.ok(!relisted.body.includes(token), relisted.body);
  assert.deepEqual((await storeOf(again)).urls, before.urls);
  assert.ok(!(await readFile(path.join(where.app, "workspaces.json"), "utf8")).includes(token));
});
