import assert from "node:assert/strict";
import test from "node:test";

// The Agents page's own texts: a launch's running time and how it ended, each state's words, the harness and model, what an agent works on, and its time.
const { countsOf, exitText, hostText, launchFacts, runningText, stateOf, timeText, workText } = await import("../../dist/server/review/public/views/agents.js");

const NOW = Date.parse("2026-11-19T10:00:00Z");
const minutes = (count) => new Date(NOW + count * 60000).toISOString();

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

test("each state reads as the page names it", () => {
  const words = ["running", "waiting", "blocked", "finished", "failed", "stopped", "working", "expired"].map((state) => stateOf({ state })[0]);
  assert.deepEqual(words, ["Running", "Waiting for you", "Blocked", "Finished", "Failed", "Stopped", "Working", "Expired"]);
});

test("the harness and model read as one text, any harness by its own name, and Agent without either", () => {
  assert.equal(hostText({ harness: "Claude Code", model: "claude-opus-5-5" }), "Claude Code · claude-opus-5-5");
  assert.equal(hostText({ harness: "Gemini CLI", model: null }), "Gemini CLI");
  assert.equal(hostText({ harness: null, model: "gpt-5.5" }), "Agent · gpt-5.5");
  assert.equal(hostText({ harness: null, model: null }), "Agent");
});

test("a failed launch says when it ended and why, and any other entry its activity and slice or its reason", () => {
  assert.equal(workText({ kind: "launch", state: "failed", reason: "The model is not offered.", launch: { endedAt: minutes(-4) } }, NOW), "Ended 4 min ago: The model is not offered.");
  assert.equal(workText({ kind: "launch", state: "failed", reason: "It stopped.", launch: { endedAt: new Date(NOW - 12000).toISOString() } }, NOW), "Ended 12s ago: It stopped.");
  assert.equal(workText({ kind: "claim", state: "working", activity: "design", slice: { title: "Retention policy" } }, NOW), "design · Retention policy");
  assert.equal(workText({ kind: "launch", state: "blocked", reason: "Claude Code refused Bash.", slice: null }, NOW), "Claude Code refused Bash.");
});

test("a launch's time is how long it ran, a live claim's the lease it has left, and an expired claim's how long ago it lapsed", () => {
  assert.equal(timeText({ kind: "launch", state: "running", launch: { runningMs: 5000 } }, NOW, 2000), "7s");
  assert.equal(timeText({ kind: "launch", state: "stopped", launch: { runningMs: 5000 } }, NOW, 2000), "5s");
  assert.equal(timeText({ kind: "claim", group: "other", expiresAt: minutes(22) }, NOW), "22 min left");
  assert.equal(timeText({ kind: "claim", group: "expired", expiresAt: minutes(-120) }, NOW), "expired 2 h ago");
});

test("a launch names its start, its exit, and its runs when more than one", () => {
  assert.match(launchFacts({ launchedAt: minutes(-10), exit: { code: 1, signal: null }, runs: 2 }), /^Started .+ · Exit code 1 · 2 runs$/);
  assert.match(launchFacts({ launchedAt: minutes(-10), exit: null, runs: 1 }), /^Started [^·]+$/);
});

test("the Show counts follow the entries' groups", () => {
  const entries = [
    { kind: "launch", group: "needs-you" },
    { kind: "launch", group: "launched" },
    { kind: "claim", group: "other" },
    { kind: "claim", group: "expired" }
  ];
  assert.deepEqual(countsOf(entries), { all: 4, needsYou: 1, thisComputer: 2, other: 1, expired: 1 });
});
