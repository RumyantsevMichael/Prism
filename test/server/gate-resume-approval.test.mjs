import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { isolateGit } from "./fixtures/workspace-artifacts.mjs";
import { CLAUDE_CLIENT, CLAUDE_SESSION, CLOUD_SESSION } from "./fixtures/gate-askers.mjs";
import { answeredApproval, approvalContinue, optionOf } from "./fixtures/approval-askers.mjs";

// Requirements: docs/requirements/late-gate-answers.md §12, §13, §23.
// Contract: docs/plans/late-gate-answers/slice.md clauses 13 and 19.
// A person who asks for changes to a requirement can resume the session that asked for its approval, such as the ideate agent,
// on the machine where it ran, while that session is not running.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

test("clauses 13, 19: an answered approval gate of a Claude Code session that is not open offers to resume it", { skip: posixOnly }, async (t) => {
  const { gate, review } = await answeredApproval(t, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  const option = optionOf(await approvalContinue(review, gate), "resume");
  assert.deepEqual([option.label, option.reason ?? null], ["Resume the session that asked", null]);
});

test("clauses 13, 19: an approval gate that names no initiative still offers to resume its asker", { skip: posixOnly }, async (t) => {
  const { gate, review } = await answeredApproval(t, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION }, initiative: null });
  const action = await approvalContinue(review, gate);
  assert.equal(action.available, true, action.reason);
  assert.equal(optionOf(action, "resume").reason ?? null, null);
});

test("clauses 13, 19: an approval gate that a cloud session asked offers a wake instead of a resume", { skip: posixOnly }, async (t) => {
  const { gate, review } = await answeredApproval(t, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION, CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: CLOUD_SESSION } });
  const action = await approvalContinue(review, gate);
  assert.equal(optionOf(action, "resume").reason, "This is a cloud session; wake it instead.");
});
