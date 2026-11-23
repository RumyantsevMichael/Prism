import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { isolateGit } from "./fixtures/workspace-artifacts.mjs";
import { CLAUDE_CLIENT, CLAUDE_SESSION, CLOUD_SESSION } from "./fixtures/gate-askers.mjs";
import { answeredApproval, approvalContinue, optionOf } from "./fixtures/approval-askers.mjs";

// Requirements: docs/requirements/late-gate-answers.md §14, §15, §23.
// Contract: docs/plans/late-gate-answers/slice.md clauses 13 and 22.
// A person who asks for changes to a requirement that a cloud session asked them to approve can wake that cloud session.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

test("clauses 13, 22: an answered approval gate of a cloud session offers to wake it", { skip: posixOnly }, async (t) => {
  const { gate, review } = await answeredApproval(t, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION, CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: CLOUD_SESSION } });
  const option = optionOf(await approvalContinue(review, gate), "wake");
  assert.deepEqual([option.label, option.reason ?? null], ["Wake the cloud session that asked", null]);
});
