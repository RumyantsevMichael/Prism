import assert from "node:assert/strict";
import test from "node:test";
import { descendantsOf, stopGraceMs } from "../../dist/server/session/process-tree.mjs";

// The process list that a stop walks: a spared process and everything below it stays out of the list it ends.
const table = new Map([
  [10, { pid: 10, ppid: 1, started: "a", args: "claude -p" }],
  [11, { pid: 11, ppid: 10, started: "a", args: "node mcp.mjs" }],
  [12, { pid: 12, ppid: 11, started: "a", args: "sleep 600" }],
  [13, { pid: 13, ppid: 10, started: "a", args: "node review-app.mjs" }],
  [14, { pid: 14, ppid: 13, started: "a", args: "node /x/launch-supervisor.mjs /app/launches/launch-1 launch t" }],
  [15, { pid: 15, ppid: 10, started: "a", args: "node /x/launch-supervisor.mjs /app/launches/launch-2 launch t" }],
  [16, { pid: 16, ppid: 15, started: "a", args: "codex exec" }],
  [17, { pid: 17, ppid: 1, started: "a", args: "unrelated" }]
]);

test("the descendants of a host leave out the review app, launch supervisors, and every process below them", () => {
  const found = descendantsOf(table, [10], new Set([13])).map((entry) => entry.pid).sort((a, b) => a - b);
  assert.deepEqual(found, [11, 12]);
});

test("the grace period reads PRISM_LAUNCH_STOP_GRACE_MS and falls back to ten seconds", () => {
  assert.equal(stopGraceMs({ PRISM_LAUNCH_STOP_GRACE_MS: "1500" }), 1500);
  assert.equal(stopGraceMs({ PRISM_LAUNCH_STOP_GRACE_MS: "0" }), 0);
  assert.equal(stopGraceMs({}), 10000);
  assert.equal(stopGraceMs({ PRISM_LAUNCH_STOP_GRACE_MS: "-1" }), 10000);
  assert.equal(stopGraceMs({ PRISM_LAUNCH_STOP_GRACE_MS: "soon" }), 10000);
});
