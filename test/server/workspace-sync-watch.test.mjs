import assert from "node:assert/strict";
import test from "node:test";

const { watchWorkspace } = await import("../../dist/server/review/workspace-sync.mjs");
const { syncItem } = await import("../../dist/server/review/public/views/record-store.js");

// A fake clock and sync: each call records when it ran and answers the next outcome.
function harness(outcomes) {
  const calls = [];
  const sync = async (base) => {
    calls.push(base);
    return outcomes.shift() ?? { state: "ok" };
  };
  return { calls, sync };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("the watch fetches only while a page is connected and names the store without credentials when it fails", async () => {
  const { calls, sync } = harness([{ state: "fetch_failed", message: "fatal: unable to access 'https://user:token@example.invalid/o/store.git/': Could not resolve host" }]);
  const watch = watchWorkspace({ base: async () => "/clone", label: () => "example.invalid/o/store", intervalMs: 10000, maxMs: 40000, sync });
  assert.equal((await watch.state()).nextFetchAt, null, "no page is connected, so no fetch is due");
  assert.equal(calls.length, 0);
  watch.viewers(1);
  await settle();
  assert.equal(calls.length, 1, "the first page starts a fetch");
  const failed = await watch.state();
  assert.equal(failed.state, "unreachable");
  assert.equal(failed.lastSyncedAt, null);
  assert.ok(failed.message.includes("example.invalid/o/store"), failed.message);
  assert.ok(failed.message.includes("Could not resolve host"), failed.message);
  assert.ok(!failed.message.includes("token"), failed.message);
  assert.equal(Date.parse(failed.nextFetchAt) - Date.parse(failed.lastAttemptAt), 20000, "the wait after a failure doubles");
  watch.viewers(2);
  await settle();
  assert.equal(calls.length, 1, "another page joining starts no fetch");
  watch.viewers(0);
  assert.equal((await watch.state()).nextFetchAt, null);
  // A page that reconnects during the backoff keeps the time the next fetch is due.
  watch.viewers(1);
  await settle();
  assert.equal(calls.length, 1, "a reconnect during the backoff waits for it");
  watch.stop();
});

test("a watch without a clone to sync fetches nothing, and a skipped sync keeps the last outcome", async () => {
  const { calls, sync } = harness([{ state: "skipped" }]);
  const none = watchWorkspace({ base: async () => null, label: () => "store", intervalMs: 10000, sync });
  none.viewers(1);
  await settle();
  assert.equal(calls.length, 0);
  assert.equal((await none.state()).lastSyncedAt, null);
  none.stop();
  const skipped = watchWorkspace({ base: async () => "/clone", label: () => "store", intervalMs: 10000, sync });
  skipped.viewers(1);
  await settle();
  const state = await skipped.state();
  assert.equal(state.state, "ok");
  assert.equal(state.lastSyncedAt, null, "a sync that another process ran is no fetch of this app's");
  skipped.stop();
});

test("the status bar shows when an unreachable workspace last synced, and a record sync problem over a fetch that went through", () => {
  const now = Date.parse("2026-11-03T02:00:00Z");
  const store = { kind: "remote", sync: true };
  const unreachable = syncItem(store, { state: "fetch_failed", at: "2026-11-03T01:59:00Z" }, now, { state: "unreachable", lastSyncedAt: "2026-11-03T01:30:00Z", message: "Prism could not fetch store" });
  assert.deepEqual(unreachable, { label: "Store unreachable · last synced 30 min ago", tone: "danger", problem: true, message: "Prism could not fetch store" });
  assert.equal(syncItem(store, null, now, { state: "unreachable", lastSyncedAt: null, message: "m" }).label, "Store unreachable · never synced");
  assert.equal(syncItem(store, { state: "ok", at: "2026-11-03T01:00:00Z" }, now, { state: "ok", lastSyncedAt: "2026-11-03T01:58:00Z" }).label, "Synced 2 min ago");
  assert.equal(syncItem(store, null, now, { state: "syncing", lastSyncedAt: null }).label, "Syncing…");
  assert.equal(syncItem(store, { state: "conflicts", at: "2026-11-03T01:58:00Z" }, now, { state: "ok", lastSyncedAt: "2026-11-03T01:58:00Z" }).tone, "warn");
});
