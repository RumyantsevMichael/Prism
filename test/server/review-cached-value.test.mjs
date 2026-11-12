import assert from "node:assert/strict";
import test from "node:test";
import { createCachedValue } from "../../dist/server/review/cached-value.mjs";

// The project list keeps each project's slow values this way: computed once, answered from memory, and renewed behind the answer once old.
function counter() {
  let calls = 0;
  let result = "first";
  return {
    compute: async () => {
      calls += 1;
      return `${result}#${calls}`;
    },
    set: (value) => { result = value; },
    get calls() {
      return calls;
    }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the first read waits for the value and reads within the time to live answer it without computing again", async () => {
  let now = 0;
  const source = counter();
  const value = createCachedValue(source.compute, { ttlMs: 10000, now: () => now });
  assert.equal(await value.get(), "first#1");
  now = 9999;
  assert.equal(await value.get(), "first#1");
  assert.equal(await value.get(), "first#1");
  assert.equal(source.calls, 1);
});

test("an old value is answered at once while one computation renews it behind the answer", async () => {
  let now = 0;
  const source = counter();
  const value = createCachedValue(source.compute, { ttlMs: 10000, now: () => now });
  await value.get();
  now = 10000;
  source.set("second");
  assert.equal(await value.get(), "first#1", "the old value answers without waiting");
  assert.equal(await value.get(), "first#1", "a second read while the renewal runs starts no other");
  await settle();
  assert.equal(source.calls, 2);
  assert.equal(await value.get(), "second#2");
});

test("invalidating makes the next read wait for a new value and discards a computation started before it", async () => {
  let release;
  let calls = 0;
  const value = createCachedValue(() => {
    calls += 1;
    return calls === 1 ? new Promise((resolve) => { release = () => resolve("stale"); }) : Promise.resolve(`fresh#${calls}`);
  }, { ttlMs: 10000 });
  const first = value.get();
  value.invalidate();
  assert.equal(await value.get(), "fresh#2");
  release();
  assert.equal(await first, "stale", "the earlier read still gets its own answer");
  assert.equal(await value.get(), "fresh#2", "but the value it computed is not kept");
});

test("a failed first computation is not kept, so the next read tries again", async () => {
  let calls = 0;
  const value = createCachedValue(async () => {
    calls += 1;
    if (calls === 1) throw new Error("unreadable");
    return "read";
  }, { ttlMs: 10000 });
  await assert.rejects(value.get(), /unreadable/);
  assert.equal(await value.get(), "read");
});

test("a time to live given as a function of the last computation's duration renews a slow value less often", async () => {
  let now = 0;
  let calls = 0;
  const value = createCachedValue(async () => {
    calls += 1;
    now += 2000;
    return calls;
  }, { ttlMs: (ms) => Math.max(1000, 5 * ms), now: () => now });
  assert.equal(await value.get(), 1);
  now += 9999;
  assert.equal(await value.get(), 1);
  await settle();
  assert.equal(calls, 1, "a value that took 2 seconds is kept for 10");
  now += 1;
  assert.equal(await value.get(), 1);
  await settle();
  assert.equal(calls, 2);
});
