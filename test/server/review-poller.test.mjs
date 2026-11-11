import assert from "node:assert/strict";
import test from "node:test";
import { coalesce, createPoller, deadline } from "../../dist/server/review/public/views/poller.js";

// A fake clock and document, so a test steps through the schedule without waiting.
function harness() {
  const timers = new Map();
  let next = 1;
  const listeners = new Set();
  const doc = {
    visibilityState: "visible",
    addEventListener: (name, listener) => name === "visibilitychange" && listeners.add(listener),
    removeEventListener: (name, listener) => listeners.delete(listener)
  };
  return {
    doc,
    timers,
    setTimer: (callback, ms) => {
      const id = next++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    // Fires every pending timer once, as if its delay passed.
    fire() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.callback();
    },
    show(state) {
      doc.visibilityState = state;
      for (const listener of listeners) listener();
    }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

test("a poll is scheduled only after the previous answer, so at most one is ever in flight", async () => {
  const clock = harness();
  let calls = 0;
  let inFlight = 0;
  let most = 0;
  let answer = gate();
  const poller = createPoller({ ...clock, interval: 1500, run: async () => {
    calls += 1;
    inFlight += 1;
    most = Math.max(most, inFlight);
    await answer.promise;
    inFlight -= 1;
  } });
  void poller.start();
  await settle();
  assert.equal(calls, 1);
  assert.equal(clock.timers.size, 0, "no next poll is scheduled while the first is unanswered");
  clock.fire();
  await settle();
  assert.equal(calls, 1, "a slow answer holds back the next poll");
  answer.open();
  await settle();
  assert.equal(clock.timers.size, 1, "the next poll is scheduled after the answer");
  assert.equal([...clock.timers.values()][0].ms, 1500);
  answer = gate();
  clock.fire();
  await settle();
  assert.equal(calls, 2);
  answer.open();
  await settle();
  assert.equal(most, 1);
});

test("asking for a poll while one is in flight runs one more after it, never a second at once", async () => {
  const clock = harness();
  let calls = 0;
  let inFlight = 0;
  let most = 0;
  let answer = gate();
  const poller = createPoller({ ...clock, interval: 5000, run: async () => {
    calls += 1;
    inFlight += 1;
    most = Math.max(most, inFlight);
    await answer.promise;
    inFlight -= 1;
  } });
  void poller.start();
  await settle();
  const first = poller.now();
  const second = poller.now();
  assert.equal(first, second, "both requests share the run in flight");
  await settle();
  assert.equal(calls, 1);
  const held = answer;
  answer = { promise: Promise.resolve() };
  held.open();
  await first;
  assert.equal(calls, 2, "the asked-for run followed the one in flight once");
  assert.equal(most, 1);
  assert.equal(clock.timers.size, 1, "the schedule resumes after the follow-up run");
});

test("a hidden tab polls nothing, and showing it polls once at once and resumes the schedule", async () => {
  const clock = harness();
  let calls = 0;
  const poller = createPoller({ ...clock, interval: () => 1500, run: async () => { calls += 1; } });
  void poller.start();
  await settle();
  assert.equal(calls, 1);
  clock.show("hidden");
  clock.fire();
  await settle();
  assert.equal(calls, 1, "a timer that fires while the tab is hidden does not poll");
  assert.equal(clock.timers.size, 0, "and schedules nothing");
  clock.show("visible");
  await settle();
  assert.equal(calls, 2, "showing the tab polls once at once");
  assert.equal(clock.timers.size, 1, "and resumes the schedule");
  poller.stop();
  assert.equal(clock.timers.size, 0, "stopping cancels the next poll");
  clock.show("hidden");
  clock.show("visible");
  await settle();
  assert.equal(calls, 2, "a stopped poller ignores visibility");
});

test("a poller that starts in a hidden tab waits until the tab is shown", async () => {
  const clock = harness();
  clock.doc.visibilityState = "hidden";
  let calls = 0;
  const poller = createPoller({ ...clock, interval: 1500, run: async () => { calls += 1; } });
  await poller.start();
  assert.equal(calls, 0);
  clock.show("visible");
  await settle();
  assert.equal(calls, 1);
});

test("a failed poll keeps the schedule and passes no result to the interval", async () => {
  const clock = harness();
  const seen = [];
  const poller = createPoller({ ...clock, interval: (result) => { seen.push(result); return 10; }, run: async () => { throw new Error("down"); } });
  await poller.start();
  assert.deepEqual(seen, [undefined]);
  assert.equal(clock.timers.size, 1);
});

test("a coalesced call made while one runs shares one follow-up run", async () => {
  let calls = 0;
  let answer = gate();
  const refresh = coalesce(async () => {
    calls += 1;
    await answer.promise;
  });
  const first = refresh();
  refresh();
  refresh();
  const held = answer;
  answer = { promise: Promise.resolve() };
  held.open();
  await first;
  await settle();
  await settle();
  assert.equal(calls, 2, "three calls during one run made one more run, not three");
});

test("a deadline aborts a request that is not answered in time", async () => {
  const signal = deadline(20);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason?.name, "TimeoutError");
});
