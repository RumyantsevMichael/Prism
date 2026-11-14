import assert from "node:assert/strict";
import http from "node:http";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, eventually, git, isolateGit, networkStore, ok, place, pushToRemote, server, startApp, storeFolderId, workspaceId } from "./fixtures/workspace-view.mjs";

// Contract clauses 22-25 of the workspace-view design: an open workspace fetches on its own, shows its last synced copy, and pushes the app's writes.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

// A page of the workspace: its events stream stays connected until close().
function openPage(context, prism, id) {
  const stream = http.get(`${prism.viewer}/w/${id}/api/events`);
  const close = () => stream.destroy();
  context.after(close);
  return close;
}

async function addedWorkspace(context, options = {}) {
  const where = await place(context);
  const store = await networkStore(where);
  const prism = await startApp(context, where, { workspaceFetchMs: 300, workspaceFetchMaxMs: 1200, ...options });
  await prism.grant();
  const added = await prism.post("/api/workspaces", { url: store.url });
  assert.equal(added.status, 200, added.body);
  const id = workspaceId(store.identity);
  const clone = path.join(where.app, "stores", storeFolderId(store.identity));
  const sync = async () => (await prism.get(`/w/${id}/api/index`)).json.sync;
  return { where, store, prism, id, clone, sync };
}

const fetched = (clone, file) => { try { git(clone, "cat-file", "-e", `origin/main:${file}`); return true; } catch { return false; } };

test("clause 22: an open page makes the app fetch the store on its own timer, and a closed one stops it", async (context) => {
  const { where, store, prism, id, clone } = await addedWorkspace(context);
  const close = openPage(context, prism, id);
  await pushToRemote(where, store.bare, { "artifacts/requirements/first.md": "# First\n" });
  await eventually(() => fetched(clone, "artifacts/requirements/first.md"), 10000, "the first push reaching the clone");
  close();
  await new Promise((resolve) => setTimeout(resolve, 600));
  await pushToRemote(where, store.bare, { "artifacts/requirements/second.md": "# Second\n" });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(fetched(clone, "artifacts/requirements/second.md"), false, "no page is connected, so nothing fetches");
});

test("clause 22: reading the index of a workspace served through a checkout starts no fetch while no page is connected", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const root = await checkout(where, "api", { store: store.url, sync: "on" });
  const agent = await server(context, where, root);
  ok(await agent.call("get_roadmap", {}));
  await agent.close();
  // Every record read now finds the store's last fetch old, as one 30 seconds after the last fetch would.
  const { configureRecordSync } = await import("../../dist/server/workflow/record-store-sync.mjs");
  configureRecordSync({ pullIntervalMs: 0 });
  context.after(() => configureRecordSync({ pullIntervalMs: 30000 }));
  const prism = await startApp(context, where, { workspaceFetchMs: 300 });
  await prism.register(root);
  const id = workspaceId(store.identity);
  const clone = path.join(where.app, "stores", storeFolderId(store.identity));
  await pushToRemote(where, store.bare, { "artifacts/requirements/unread.md": "# Unread\n" });
  for (let read = 0; read < 5; read += 1) {
    const index = await prism.get(`/w/${id}/api/index`);
    assert.equal(index.status, 200, index.body);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(fetched(clone, "artifacts/requirements/unread.md"), false, "no page is connected, so reading the index fetches nothing");
});

test("clause 23: failed fetches back off by doubling up to the maximum, and a success restores the interval", async (context) => {
  const { store, prism, id, sync } = await addedWorkspace(context);
  await rename(store.bare, `${store.bare}.away`);
  openPage(context, prism, id);
  // Each wait is read from the attempt it follows, from its start to the next fetch it schedules, so a slow Git fetch does not lengthen it.
  // While a fetch runs, the next fetch is still the one it started at, which a timer can fire a millisecond early, so a wait shorter than the interval is that one.
  const waits = new Map();
  const deadline = Date.now() + 20000;
  while (waits.size < 4 && Date.now() < deadline) {
    const state = await sync();
    const wait = Date.parse(state?.nextFetchAt) - Date.parse(state?.lastAttemptAt);
    if (wait >= 300) waits.set(state.lastAttemptAt, wait);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const observed = [...waits.values()];
  assert.ok(observed.length >= 4, `several failed fetches were attempted: ${observed.join(", ")}`);
  assert.ok(observed.every((wait, index) => index === 0 || wait === Math.min(observed[index - 1] * 2, 1200)), `each wait doubles: ${observed.join(", ")}`);
  assert.ok(observed[0] >= 600, `the wait after a failure is twice the interval or more: ${observed.join(", ")}`);
  assert.equal(observed.at(-1), 1200, `the waits stop at the maximum: ${observed.join(", ")}`);
  await rename(`${store.bare}.away`, store.bare);
  const restored = await eventually(async () => { const state = await sync(); return state.state === "ok" && state; }, 10000, "a fetch succeeding again");
  assert.ok(Date.parse(restored.nextFetchAt) - Date.parse(restored.lastAttemptAt) <= 300 + 200, "the wait is the interval again");
});

test("clause 24: an unreachable store shows its last synced copy with the time of that sync and Git's reason", async (context) => {
  const { store, prism, id, sync } = await addedWorkspace(context);
  openPage(context, prism, id);
  const first = await eventually(async () => { const state = await sync(); return state?.state === "ok" && state.lastSyncedAt && state; }, 10000, "a first fetch");
  await rename(store.bare, `${store.bare}.away`);
  context.after(() => rename(`${store.bare}.away`, store.bare).catch(() => {}));
  const unreachable = await eventually(async () => { const state = await sync(); return state.state === "unreachable" && state; }, 10000, "the store becoming unreachable");
  assert.ok(Date.parse(unreachable.lastSyncedAt) >= Date.parse(first.lastSyncedAt), "the time of the last fetch that succeeded");
  assert.ok(unreachable.message.includes(`example.invalid/${store.owner}/store`), unreachable.message);
  const index = await prism.get(`/w/${id}/api/index`);
  assert.equal(index.status, 200, "the workspace still reads from its clone");
});

test("clause 25: a gate answer on a store-only workspace is committed and pushed to the store's upstream", async (context) => {
  const where = await place(context);
  const store = await networkStore(where);
  const elsewhere = await checkout(where, "api", { store: store.url, sync: "on" });
  const agent = await server(context, where, elsewhere);
  ok(await agent.call("update_initiative", { initiative: "reports", expectedRevision: null, operations: [{ op: "create", slug: "reports", title: "Reports", requirements: ["r.md#1"] }] }));
  const asked = ok(await agent.call("update_coordination_state", { initiative: "reports", expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "visual-review", question: "Review the design.", artifacts: [] }] } }));
  const gate = asked.openedGates[0].id;
  await eventually(() => git(store.bare, "log", "--all", "-p").includes(gate), 15000, "the gate reaching the remote");
  // The app keeps its own copy of the store, so the checkout's machine is another machine here.
  const app = { parent: where.parent, app: path.join(where.parent, "app-b"), sync: "on" };
  const prism = await startApp(context, app, { workspaceFetchMs: 300 });
  await prism.grant();
  assert.equal((await prism.post("/api/workspaces", { url: store.url })).status, 200);
  const id = workspaceId(store.identity);
  const target = `gate:reports/${gate}`;
  const listed = await prism.get(`/w/${id}/api/actions?target=${encodeURIComponent(target)}`);
  assert.equal(listed.status, 200, listed.body);
  const action = listed.json.actions.find((item) => item.id === "gate.answer");
  const applied = await prism.post(`/w/${id}/api/actions/apply`, { action: "gate.answer", target, input: { choice: "approve" }, revision: action.revision });
  assert.equal(applied.status, 200, applied.body);
  await eventually(() => /answeredAt/.test(git(store.bare, "log", "-1", "-p", "main")), 15000, "the answer reaching the remote");
});
