import assert from "node:assert/strict";
import test from "node:test";
import { createReviewServerPool } from "../../dist/server/review/review-server-pool.mjs";

const IDLE_MS = 30 * 60 * 1000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

function reviewServer({ viewers = 0, closeError } = {}) {
  return {
    viewers,
    closes: 0,
    viewerCount() { return this.viewers; },
    async close() {
      this.closes += 1;
      if (closeError) throw closeError;
    },
  };
}

function poolFor(t, start) {
  const pool = createReviewServerPool({ start });
  t.after(() => pool.close());
  return pool;
}

async function tick(t, milliseconds) {
  t.mock.timers.tick(milliseconds);
  await Promise.resolve();
  await Promise.resolve();
}

test("starts lazily and shares pending startup across tasks for one root", async (t) => {
  const pending = deferred();
  const starts = [];
  const pool = poolFor(t, (options) => {
    starts.push(options);
    return pending.promise;
  });
  assert.deepEqual(starts, []);
  const first = pool.get("/one", "task-a");
  const second = pool.get("/one", "task-b");
  const review = reviewServer();
  pending.resolve(review);
  assert.equal(await first, review);
  assert.equal(await second, review);
  assert.deepEqual(starts, [{ projectRoot: "/one" }]);
  assert.equal(await pool.get("/one", "task-a"), review);
  assert.equal(starts.length, 1);
});

test("keeps different roots separate and rejects a bound task's root change", async (t) => {
  const pool = poolFor(t, async () => reviewServer());
  const first = await pool.get("/one", "task-a");
  const second = await pool.get("/two", "task-b");
  assert.notEqual(first, second);
  await assert.rejects(pool.get("/two", "task-a"), /This task is already bound to project root: \/one/);
});

test("refreshes the idle deadline when a task requests the server", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const review = reviewServer();
  const pool = poolFor(t, async () => review);
  await pool.get("/one", "task-a");
  await tick(t, IDLE_MS - 1);
  await pool.get("/one", "task-b");
  await tick(t, 1);
  assert.equal(review.closes, 0);
  await tick(t, IDLE_MS - 1);
  assert.equal(review.closes, 1);
});

test("keeps a server with viewers alive until an idle interval has no viewers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const review = reviewServer({ viewers: 1 });
  const pool = poolFor(t, async () => review);
  await pool.get("/one", "task-a");
  await tick(t, IDLE_MS);
  assert.equal(review.closes, 0);
  review.viewers = 0;
  await tick(t, IDLE_MS - 1);
  assert.equal(review.closes, 0);
  await tick(t, 1);
  assert.equal(review.closes, 1);
});

test("idle expiry releases every task binding and permits a fresh server", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pool = poolFor(t, async () => reviewServer());
  const original = await pool.get("/one", "task-a");
  await pool.get("/one", "task-b");
  await tick(t, IDLE_MS);
  assert.equal(original.closes, 1);
  await pool.get("/two", "task-a");
  await pool.get("/three", "task-b");
  assert.notEqual(await pool.get("/one", "task-c"), original);
});

test("failed startup releases the initiating task and permits retry", async (t) => {
  let attempts = 0;
  const pool = poolFor(t, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("startup failed");
    return reviewServer();
  });
  await assert.rejects(pool.get("/one", "task-a"), /startup failed/);
  await pool.get("/two", "task-a");
  await pool.get("/one", "task-b");
  assert.equal(attempts, 3);
});

test("preserves a joining task's binding after shared startup fails", async (t) => {
  const pending = deferred();
  const pool = poolFor(t, () => pending.promise);
  const first = assert.rejects(pool.get("/one", "task-a"), /startup failed/);
  const second = assert.rejects(pool.get("/one", "task-b"), /startup failed/);
  pending.reject(new Error("startup failed"));
  await Promise.all([first, second]);
  await assert.rejects(pool.get("/two", "task-b"), /already bound to project root: \/one/);
});

test("shutdown waits for pending startup and cancels its idle timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const started = deferred();
  const pool = poolFor(t, () => {
    started.resolve();
    return pending.promise;
  });
  const request = pool.get("/one", "task-a");
  await started.promise;
  let closed = false;
  const closing = pool.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  const review = reviewServer();
  pending.resolve(review);
  await request;
  await closing;
  assert.equal(review.closes, 1);
  await tick(t, IDLE_MS);
  assert.equal(review.closes, 1);
});

test("shutdown closes other servers despite startup and close failures", async (t) => {
  const failedStart = deferred();
  const badClose = reviewServer({ closeError: new Error("close failed") });
  const goodClose = reviewServer();
  const pool = poolFor(t, ({ projectRoot }) => {
    if (projectRoot === "/pending") return failedStart.promise;
    return Promise.resolve(projectRoot === "/bad" ? badClose : goodClose);
  });
  const request = assert.rejects(pool.get("/pending", "task-a"), /startup failed/);
  await pool.get("/bad", "task-b");
  await pool.get("/good", "task-c");
  const closing = pool.close();
  failedStart.reject(new Error("startup failed"));
  await Promise.all([request, closing]);
  assert.equal(badClose.closes, 1);
  assert.equal(goodClose.closes, 1);
  await pool.close();
  assert.equal(goodClose.closes, 1);
});
