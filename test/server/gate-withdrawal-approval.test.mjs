import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { browserRequest, checkout, eventually, isolateGit, ok, requirementFile, reviewBrowser, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";
import { CLAUDE_CLIENT, CLAUDE_SESSION } from "./fixtures/gate-askers.mjs";

// Requirements: docs/requirements/late-gate-answers.md §19, §20, §21.
// Contract: docs/plans/late-gate-answers/slice.md clauses 10 to 12.
// A requirement's approval gate whose asker is gone can be withdrawn: it leaves Attention, the file's status stays, and a wait on it says so.

const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/requirements/billing.md";

test("clauses 10, 11, 12: withdrawing an approval gate keeps the file's status and ends a later wait as withdrawn", async (t) => {
  const place = await workspace(t);
  const api = await checkout(place, "api");
  const prism = await server(t, place, api, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  const gate = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, question: "Approve billing?", context: "Billing." }] })).artifacts[0].gate;
  const review = await reviewBrowser(t, api);
  const target = `approval:${gate}`;
  let action;
  await eventually(async () => (action = (await browserRequest(review, `/api/actions?target=${encodeURIComponent(target)}`)).body.actions?.find((item) => item.id === "gate.withdraw")) !== undefined, 30000, "the approval lists Withdraw");
  assert.equal(action.available, true, action.reason);
  const applied = await browserRequest(review, "/api/actions/apply", { method: "POST", body: { action: "gate.withdraw", target, input: {}, revision: action.revision } });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const read = ok(await prism.call("get_artifact", { path: FILE }));
  assert.equal(read.status, "Draft", "the recorded status stays as it was");
  await eventually(async () => !(await browserRequest(review, "/api/entity?ref=attention")).body.data.needsYou.some((item) => item.id === gate), 30000, "the card leaves Attention");
  const waited = ok(await prism.call("wait_for_user_gate", { artifact: FILE, gateId: gate, maxWaitMinutes: 1 }));
  assert.equal(waited.status, "withdrawn");
  assert.deepEqual(waited.withdrawn.map((item) => item.id), [gate]);
});
