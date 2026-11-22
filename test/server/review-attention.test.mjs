import assert from "node:assert/strict";
import test from "node:test";
import { answerState } from "../../dist/server/review/public/views/attention.js";

const review = { kind: "visual-review" };
const pick = (state) => [state.choice, state.ready, state.noteRequired, state.submitLabel, state.hint];

test("a review answer waits for an explicit choice and never guesses one from the note", () => {
  assert.deepEqual(pick(answerState(review, { choice: null, note: "" })), [null, false, false, "Send answer", "Pick Approve or Request changes."]);
  assert.deepEqual(pick(answerState(review, { choice: null, note: "The arrows point the wrong way." })), [null, false, false, "Send answer", "Pick Approve or Request changes to send your note."]);
  assert.deepEqual(pick(answerState({ kind: "correctness" }, { choice: "approve", note: "" })), ["approve", true, false, "Approve", ""]);
  assert.deepEqual(pick(answerState(review, { choice: "approve", note: "Looks right." })), ["approve", true, false, "Approve", ""]);
});

test("request changes makes the note required and stays disabled until it has text", () => {
  assert.deepEqual(pick(answerState(review, { choice: "request-changes", note: "" })), ["request-changes", false, true, "Request changes", "Write what should change to send this."]);
  assert.equal(answerState(review, { choice: "request-changes", note: "   \n" }).ready, false, "whitespace is not a note, as on the server");
  assert.deepEqual(pick(answerState(review, { choice: "request-changes", note: "Split the parser." })), ["request-changes", true, true, "Request changes", ""]);
  assert.equal(answerState(review, { choice: "request-changes" }).noteLabel, "What should change");
});

test("a decision accepts an option or a note alone, and a choice the gate does not list counts as none", () => {
  const decision = { kind: "decision", options: [{ id: "keep", label: "Keep" }, { id: "drop", label: "Drop" }] };
  assert.deepEqual(pick(answerState(decision, { choice: null, note: "" })), [null, false, false, "Send answer", "Pick an option or write your answer."]);
  assert.deepEqual(pick(answerState(decision, { choice: "keep", note: "" })), ["keep", true, false, "Send answer", ""]);
  assert.deepEqual(pick(answerState(decision, { choice: null, note: "Keep it for a week." })), [null, true, false, "Send answer", ""]);
  assert.equal(answerState(decision, { choice: "approve", note: "" }).choice, null);
  assert.deepEqual(pick(answerState({ kind: "decision", options: null }, { choice: null, note: "" })), [null, false, true, "Send answer", "Write your answer to send it."]);
  assert.equal(answerState({ kind: "decision" }, { choice: null, note: "Use the old schema." }).ready, true);
});

test("an assistance gate answers done with an optional note", () => {
  assert.deepEqual(pick(answerState({ kind: "assistance" }, { choice: null, note: "" })), ["done", true, false, "Mark as done", ""]);
  assert.deepEqual(pick(answerState({ kind: "assistance" }, { choice: null, note: "Installed it." })), ["done", true, false, "Mark as done", ""]);
});

test("the shared renderer sends a gate's answer on the rules its listing gives, and a one-option answer such as Done needs no pick", async () => {
  const { actionFormState } = await import("../../dist/server/review/public/views/actions.js");
  const choice = (options, extra = {}) => ({ name: "choice", kind: "choice", label: "Answer", options: options.map((value) => ({ value, label: value, consequence: null })), required: false, requiredWhen: null, ...extra });
  const note = (extra = {}) => ({ name: "note", kind: "text", label: "Note", maxLength: 4000, multiline: true, required: false, requiredWhen: null, ...extra });
  const action = (fields) => ({ id: "gate.answer", available: true, value: null, fields });
  const review = action([choice(["approve", "request-changes"], { required: true }), note({ requiredWhen: { field: "choice", values: ["request-changes"] } })]);
  const ready = (subject, values) => actionFormState(subject, { values }).ready;
  assert.deepEqual([ready(review, {}), ready(review, { note: "Looks right." }), ready(review, { choice: "approve" }), ready(review, { choice: "request-changes", note: "  " }), ready(review, { choice: "request-changes", note: "Split it." })], [false, false, true, false, true]);
  const decision = action([choice(["keep", "drop"]), note({ requiredWhen: { field: "choice", values: [null] } })]);
  assert.deepEqual([ready(decision, {}), ready(decision, { choice: "keep" }), ready(decision, { note: "Keep it a week." })], [false, true, true]);
  const assistance = action([choice(["done"], { required: true }), note()]);
  assert.equal(actionFormState(assistance, null).input.choice, "done");
  assert.equal(ready(assistance, {}), true);
});
