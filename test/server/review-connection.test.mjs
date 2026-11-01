import assert from "node:assert/strict";
import test from "node:test";

const { connectionState, recordProbe, RETRY_AFTER_FAILURES, STOPPED_AFTER_MS } = await import("../../dist/server/review/public/views/connection.js");

function probeRun(results, step = 1500) {
  let tracker = { failures: 0, failingSince: null };
  let now = 0;
  const states = [];
  for (const ok of results) {
    now += step;
    tracker = recordProbe(tracker, ok, now);
    states.push(connectionState({ ...tracker, now }));
  }
  return states;
}

test("one failed probe stays live, a second shows retrying, and the grace period ends in stopped", () => {
  assert.equal(RETRY_AFTER_FAILURES, 2);
  const failures = Math.ceil(STOPPED_AFTER_MS / 1500) + 1;
  const states = probeRun(Array(failures).fill(false));
  assert.equal(states[0], "live");
  assert.equal(states[1], "retrying");
  assert.equal(states.at(-2), "retrying");
  assert.equal(states.at(-1), "stopped");
});

test("an answer from the app clears the stopped state", () => {
  const states = probeRun([...Array(20).fill(false), true]);
  assert.equal(states.at(-2), "stopped");
  assert.equal(states.at(-1), "live");
});

test("a handoff that answers within the grace period never reads as stopped", () => {
  const states = probeRun([false, false, false, false, true, false, false, false, false, true]);
  assert.ok(!states.includes("stopped"));
});

test("an open event stream keeps a failing probe from reading as stopped", () => {
  assert.equal(connectionState({ failures: 30, failingSince: 0, now: STOPPED_AFTER_MS * 4, streamOpen: true }), "retrying");
  assert.equal(connectionState({ failures: 30, failingSince: 0, now: STOPPED_AFTER_MS * 4, streamOpen: false }), "stopped");
});

test("failures after a long pause, as after a laptop sleeps, still wait out the grace period", () => {
  let tracker = recordProbe({ failures: 0, failingSince: null }, true, 0);
  tracker = recordProbe(tracker, false, 10 * 60 * 1000);
  tracker = recordProbe(tracker, false, 10 * 60 * 1000 + 1500);
  assert.equal(connectionState({ ...tracker, now: 10 * 60 * 1000 + 1500 }), "retrying");
});
