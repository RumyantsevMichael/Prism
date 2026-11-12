import assert from "node:assert/strict";
import test from "node:test";

// The Launched sessions place's own texts: the running time, how the last run ended, and each state's words.
const { exitText, runningText, stateOf } = await import("../../dist/server/review/public/views/launched-sessions.js");

test("the running time reads in seconds, minutes, and hours", () => {
  assert.equal(runningText(0), "0s");
  assert.equal(runningText(4999), "4s");
  assert.equal(runningText(125000), "2m 05s");
  assert.equal(runningText(3729000), "1h 02m 09s");
  assert.equal(runningText(-5), "0s");
});

test("the exit status names the exit code or the signal, and nothing before a run ended", () => {
  assert.equal(exitText(null), "");
  assert.equal(exitText({ code: 0, signal: null }), "Exit code 0");
  assert.equal(exitText({ code: null, signal: "SIGKILL" }), "Ended by signal SIGKILL");
});

test("each state reads as the place names it", () => {
  const words = ["running", "waiting", "blocked", "finished", "failed", "stopped"].map((state) => stateOf({ state })[0]);
  assert.deepEqual(words, ["Running", "Waiting for you", "Blocked", "Finished", "Failed", "Stopped"]);
});
