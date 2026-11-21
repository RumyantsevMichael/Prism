import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { browserRequest, isolateGit } from "./fixtures/workspace-artifacts.mjs";
import { CLAUDE_CLIENT, CLAUDE_SESSION } from "./fixtures/gate-askers.mjs";
import { answeredApproval, approvalContinue, optionOf } from "./fixtures/approval-askers.mjs";

// Requirements: docs/requirements/late-gate-answers.md §7, §8, §10, §11.
// Contract: docs/plans/late-gate-answers/slice.md clauses 13 to 16.
// A requirement's approval gate whose asker is known keeps its card after the answer, so a person who asks for changes can
// continue the work, with a new orchestration session where the gate names an initiative that the roadmap lists.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const ASKER = { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } };

test("clause 13: an answered approval gate with a known asker stays in Answered with its asker and its answer", { skip: posixOnly }, async (t) => {
  const { gate, review } = await answeredApproval(t, ASKER);
  const data = (await browserRequest(review, "/api/entity?ref=attention")).body.data;
  const item = data.answered.find((entry) => entry.id === gate);
  assert.ok(item, "the answered approval lists in Answered");
  assert.deepEqual([item.kind, item.answer.choice, item.asker.harness], ["approval", "request-changes", "Claude Code"]);
  assert.equal(data.needsYou.some((entry) => entry.id === gate), false, "it no longer waits in Needs you");
});

test("clauses 13, 14, 16: an answered approval gate of a listed initiative offers Continue with a new session by default", { skip: posixOnly }, async (t) => {
  const { gate, review } = await answeredApproval(t, ASKER);
  const action = await approvalContinue(review, gate);
  assert.equal(action.available, true, action.reason);
  assert.deepEqual(action.fields[0].options.map((item) => item.value), ["new-session", "resume", "wake"]);
  assert.equal(optionOf(action, "new-session").reason ?? null, null);
  assert.deepEqual(action.recommended, { value: "new-session", reason: "A new session reads your answer from the records and needs no live session." });
});

test("clause 16: an approval gate that names no initiative offers no new session", { skip: posixOnly }, async (t) => {
  const { gate, review } = await answeredApproval(t, { ...ASKER, initiative: null });
  const action = await approvalContinue(review, gate);
  assert.equal(optionOf(action, "new-session").reason, "The question names no initiative, so a new session has nothing to resume from.");
  assert.equal(action.recommended, null);
});

test("clause 15: an unanswered approval gate lists Continue as unavailable until it is answered", { skip: posixOnly }, async (t) => {
  const { gate, review } = await answeredApproval(t, { ...ASKER, answer: false });
  const action = await approvalContinue(review, gate);
  assert.deepEqual([action.available, action.reason], [false, "Answer the question first."]);
});
