import assert from "node:assert/strict";
import test from "node:test";
import { answer, askRound, gateOf, itemDone, itemProject, itemUpdate, question, roadmapUpdate, workItem } from "./fixtures/work-items.mjs";

// Shaping asks rounds of at most five questions as gates, records each answer in the shaping record, and drafts no requirement before a round is answered.

test("§16: a round takes one to five questions, each with a recommended answer, what it settles, and whether readiness needs it", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const six = Array.from({ length: 6 }, (_, index) => question(`Question ${index + 1}?`));
  const refused = await itemUpdate(call, "sync", [{ op: "ask_round", questions: six }]);
  assert.equal(refused.value?.code, "validation_failed", refused.text);
  const empty = await itemUpdate(call, "sync", [{ op: "ask_round", questions: [] }]);
  assert.equal(empty.value?.code, "validation_failed", empty.text);
  const missing = await itemUpdate(call, "sync", [{ op: "ask_round", questions: [{ question: "Offline?", recommended: "Yes." }] }]);
  assert.equal(missing.value?.code, "validation_failed", "settles and blocking are required");
  const long = await itemUpdate(call, "sync", [{ op: "ask_round", questions: [question("Offline?", { recommended: "y".repeat(201) })] }]);
  assert.equal(long.value?.code, "validation_failed", "a recommended answer has at most 200 characters");
});

test("§17: a round records its questions and opens one decision gate per question with the recommended answer as its option", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const value = await itemDone(call, "sync", [{ op: "ask_round", questions: [question("Do offline clients sync?", { recommended: "Yes, on reconnect.", settles: "Whether offline edits are in scope." }), question("Is history kept?", { blocking: false })] }]);
  assert.deepEqual(value.openedGates.map((gate) => [gate.kind, gate.purpose]), [["decision", "question"], ["decision", "question"]]);
  const [first, second] = value.record.questions;
  assert.deepEqual([first.round, first.question, first.recommended, first.settles, first.blocking, first.answer, first.withdrawn], [1, "Do offline clients sync?", "Yes, on reconnect.", "Whether offline edits are in scope.", true, null, false]);
  assert.match(first.id, /^question-[0-9a-f]{8}$/);
  assert.equal(first.gate, value.openedGates[0].id);
  assert.equal(second.blocking, false);
  const gate = await gateOf(call, "sync", first.gate);
  assert.equal(gate.kind, "decision");
  assert.equal(gate.question, "Do offline clients sync?");
  assert.deepEqual(gate.options.map((option) => [option.id, option.label]), [["recommended", "Yes, on reconnect."]]);
  assert.equal(gate.recommended.option, "recommended");
  assert.match(gate.context, /Whether offline edits are in scope\./);
  assert.match(gate.context, /cannot become ready/i);
  assert.match((await gateOf(call, "sync", second.gate)).context, /can become ready without/i);
  const next = await itemDone(call, "sync", [{ op: "ask_round", questions: [question("A follow-up?")] }]);
  assert.equal(next.record.questions.at(-1).round, 2);
});

test("§18: a round's gates wait for the person like any gate: Attention lists them and wait_for_user_gate returns the answer", async (context) => {
  const { root, call, review } = await itemProject(context);
  const [gate] = await askRound(call, "sync", [question("Do offline clients sync?")]);
  const { loadAttention } = await import("../../dist/server/review/workspace-model.mjs");
  const attention = await loadAttention(root);
  assert.ok(JSON.stringify(attention).includes(gate), "Attention lists the round's gate");
  await answer(review, "sync", gate, "recommended");
  const waited = await call("wait_for_user_gate", { initiative: "sync", gateIds: [gate], maxWaitMinutes: 0.1 });
  assert.match(waited.text, /answered/, waited.text);
});

test("§19: an answer in the review app is recorded on its question, the recommended answer as text and a free answer as the note", async (context) => {
  const { call, review } = await itemProject(context);
  const [first, second] = await askRound(call, "sync", [question("Do offline clients sync?", { recommended: "Yes, on reconnect." }), question("Is history kept?")]);
  const changedAt = (await workItem(call, "sync")).record.changedAt;
  await answer(review, "sync", first, "recommended", "Within a minute.");
  await answer(review, "sync", second, null, "Only for thirty days.");
  const record = (await workItem(call, "sync")).record;
  const [one, two] = record.questions;
  assert.equal(one.answer.choice, "recommended");
  assert.match(one.answer.text, /^Yes, on reconnect\./);
  assert.match(one.answer.text, /Within a minute\./);
  assert.deepEqual([two.answer.choice, two.answer.text], [null, "Only for thirty days."]);
  assert.equal(typeof one.answer.answeredAt, "string");
  assert.equal(one.answer.by?.name, "Ada Reviewer");
  assert.equal(record.changedAt, changedAt, "a person's answer leaves changedAt as it was");
});

test("§20: an unanswered question can be withdrawn, closing its gate, and an answered one cannot", async (context) => {
  const { call, review } = await itemProject(context);
  const [first, second] = await askRound(call, "sync", [question("Offline?"), question("History?")]);
  const ids = (await workItem(call, "sync")).record.questions.map((item) => item.id);
  await answer(review, "sync", first, "recommended");
  const refused = await itemUpdate(call, "sync", [{ op: "withdraw_question", question: ids[0] }]);
  assert.equal(refused.value?.code, "question_answered", refused.text);
  await itemDone(call, "sync", [{ op: "withdraw_question", question: ids[1] }]);
  assert.equal((await workItem(call, "sync")).record.questions[1].withdrawn, true);
  const state = (await call("get_coordination_state", { initiative: "sync" })).value.state;
  assert.ok(!(state.pending ?? []).some((gate) => gate.id === second), "the withdrawn question's gate is closed");
});

test("§21, §22: a Draft requirement reference waits for an answered round, and an unanswered question blocks it again", async (context) => {
  const { call, review } = await itemProject(context);
  const before = await itemUpdate(call, "sync", [{ op: "cite", requirements: ["sync.md§1"] }]);
  assert.equal(before.value?.code, "round_unanswered", before.text);
  assert.match(before.text, /sync/);
  const viaRoadmap = await roadmapUpdate(call, [{ op: "update_initiative", id: "sync", requirements: ["sync.md§1"] }]);
  assert.equal(viaRoadmap.value?.code, "round_unanswered", viaRoadmap.text);
  const added = await roadmapUpdate(call, [{ op: "add_initiative", id: "fresh", title: "Fresh", intent: "New.", band: "Later", requirements: ["sync.md§1"] }]);
  assert.equal(added.value?.code, "round_unanswered", "a new entry that cites only a Draft file is emerging without a round");
  const approved = await itemUpdate(call, "sync", [{ op: "cite", requirements: ["export.md§1"] }]);
  assert.equal(approved.value?.code ?? null, null, "citing an Approved file drafts nothing");
  const [first, second] = await askRound(call, "sync", [question("Offline?"), question("History?")]);
  await answer(review, "sync", first, "recommended");
  const partly = await itemUpdate(call, "sync", [{ op: "cite", requirements: ["sync.md§1"] }]);
  assert.equal(partly.value?.code, "round_unanswered", "a round with an open question is not answered");
  const withdrawn = (await workItem(call, "sync")).record.questions[1].id;
  await itemDone(call, "sync", [{ op: "withdraw_question", question: withdrawn }]);
  await itemDone(call, "sync", [{ op: "cite", requirements: ["sync.md§1"] }]);
  assert.ok((await workItem(call, "sync")).requirements.some((reference) => reference.startsWith("docs/requirements/sync.md")));
  await askRound(call, "sync", [question("Conflicts?")]);
  const again = await itemUpdate(call, "sync", [{ op: "uncite", requirements: ["sync.md§1"] }, { op: "cite", requirements: ["sync.md§1"] }]);
  assert.equal(again.value?.code, "round_unanswered", "a newer unanswered round blocks Draft references again");
  assert.ok(second, "the second question's gate was opened");
});
