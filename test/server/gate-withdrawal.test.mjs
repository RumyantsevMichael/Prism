import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_CLIENT, CLAUDE_SESSION, INITIATIVE, actionOf, apply, askGate, askerFixture, askerServer, answer, card, get, listing, result } from "./fixtures/gate-askers.mjs";
import { authorOf } from "./fixtures/review-actions.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/late-gate-answers.md §4, §19, §20, §21.
// Contract: docs/plans/late-gate-answers/slice.md clauses 10 to 12.
// The person withdraws a question whose asker is gone: it closes without an answer, leaves Attention, starts nothing, and a session
// that comes back to it learns that it was withdrawn.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const target = (id) => `gate:${INITIATIVE}/${id}`;
const withdrawAction = async (review, id) => actionOf(await listing(review.base, target(id), review.headers), "gate.withdraw");
const withdraw = async (review, id) => apply(review.base, { action: "gate.withdraw", target: target(id), input: {}, revision: (await withdrawAction(review, id)).revision }, review.headers);

async function asked(t) {
  const s = await askerFixture(t);
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  const id = await askGate(server);
  const review = await s.page();
  await settled(async () => (await card(review, id))?.asker?.state, "not-running");
  return { s, server, id, review };
}

test("clause 10: a gate whose asker is not running lists Withdraw with its effect", { skip: posixOnly }, async (t) => {
  const { id, review } = await asked(t);
  const action = await withdrawAction(review, id);
  assert.deepEqual({ ...action, revision: undefined }, {
    id: "gate.withdraw", label: "Withdraw", group: "Question", target: target(id), value: null, fields: [],
    effect: "Closes the question without an answer and removes it from Attention; no session starts.",
    context: null, recommended: null, available: true, reason: null, confirm: null, revision: undefined
  });
});

test("clause 10: Withdraw is unavailable while a session waits on the gate, while its asker is open, and once it is answered", { skip: posixOnly }, async (t) => {
  const { s, server, id, review } = await asked(t);
  const wait = server.start("wait_for_user_gate", { initiative: INITIATIVE, gateId: id, maxWaitMinutes: 5 });
  await settled(async () => (await card(review, id))?.asker?.state, "waiting");
  assert.deepEqual([(await withdrawAction(review, id)).available, (await withdrawAction(review, id)).reason], [false, "A session waits on this question, so it reads your answer."]);
  const refused = await withdraw(review, id);
  assert.deepEqual([refused.status, refused.json.code], [409, "action_unavailable"]);
  wait.cancel();
  await s.setAgentsOpen([CLAUDE_SESSION]);
  await settled(async () => (await card(review, id))?.asker?.state, "open");
  assert.equal((await withdrawAction(review, id)).reason, "The session that asked is open, so withdraw the question only after that session ends.");
  await s.setAgentsOpen([]);
  await settled(async () => (await card(review, id))?.asker?.state, "not-running");
  assert.equal((await answer(review, id)).status, 200);
  assert.equal((await withdrawAction(review, id)).reason, "The question already has an answer.");
});

test("clauses 10, 11: a gate with an unknown asker can be withdrawn", { skip: posixOnly }, async (t) => {
  const s = await askerFixture(t);
  const { updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const created = await updateCoordinationState({ projectRoot: s.root, initiative: INITIATIVE, expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "assistance", question: "Install the signing key.", context: "Signing needs a key that only you can add.", artifacts: [] }] } });
  const review = await s.page();
  const id = created.openedGates[0].id;
  assert.equal((await withdrawAction(review, id)).available, true);
  assert.equal((await withdraw(review, id)).status, 200);
});

test("clause 11: withdrawing closes the gate without an answer, records who and when, removes its card, and starts nothing", { skip: posixOnly }, async (t) => {
  const { s, server, id, review } = await asked(t);
  const before = Date.now();
  const applied = await withdraw(review, id);
  assert.equal(applied.status, 200, applied.text);
  const state = result(await server.call("get_coordination_state", { initiative: INITIATIVE })).state;
  assert.equal(state.pending.some((gate) => gate.id === id), false, "the gate left pending");
  const closed = state.closed.find((gate) => gate.id === id);
  assert.equal(closed.answer, undefined, "the closed gate has no answer");
  assert.equal(closed.reason, "The person withdrew this question without an answer.");
  const entry = state.history.find((item) => item.action === "gate.withdraw" && item.target === target(id));
  assert.ok(entry, "a history entry records the withdrawal");
  assert.deepEqual(entry.by, authorOf(s.root));
  assert.ok(Date.parse(entry.at) >= before - 1000);
  const data = (await get(review.base, "api/entity?ref=attention", review.headers)).json.data;
  assert.equal([...data.needsYou, ...data.answered].some((item) => item.id === id), false, "the card left Attention");
  assert.deepEqual(s.runs(), [], "no session started");
  assert.deepEqual((await (await fetch(`${review.base}/api/launches`)).json()).launches, [], "no launched session exists");
});

test("clause 12: a wait on a withdrawn gate returns withdrawn, and a session that waits on it later is told so", { skip: posixOnly }, async (t) => {
  const { id, review, server } = await asked(t);
  assert.equal((await withdraw(review, id)).status, 200);
  const waited = result(await server.call("wait_for_user_gate", { initiative: INITIATIVE, gateId: id, maxWaitMinutes: 1 }));
  assert.equal(waited.status, "withdrawn");
  assert.deepEqual(waited.withdrawn.map((item) => item.id), [id]);
  assert.equal(typeof waited.withdrawn[0].at, "string");
  const response = await server.call("wait_for_user_gate", { initiative: INITIATIVE, gateId: id, maxWaitMinutes: 1 });
  assert.match(response.result.content[0].text, new RegExp(`The person withdrew user gate ${id} in the review browser without an answer\\. Do not act on it as answered\\.`));
});
