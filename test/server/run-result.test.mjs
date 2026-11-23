import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { INITIATIVE } from "./fixtures/launched-sessions.mjs";
import { actionProject } from "./fixtures/review-actions.mjs";

// Whether an ended run left a result is judged as of the time it ended, so an answer that a store sync brings while Prism checks
// the ended run does not take away the open gate that the run left.
async function runWithGate(t) {
  const { readCoordinationState, updateCoordinationState, recordPersonAction } = await import("../../dist/server/workflow/state.mjs");
  const { root } = await actionProject(t, { gates: false });
  const since = new Date(Date.now() - 60_000).toISOString();
  const read = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  const written = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: read.exists ? read.revision : null, changes: { gateOperations: [{ op: "ask", kind: "decision", question: "Which retention window?", context: "Signed exports stay on disk for a while.", artifacts: [], recommended: { reason: "A month covers an audit." } }] } });
  const gateId = written.openedGates[0].id;
  const answerAt = async (at) => {
    const entry = { id: randomBytes(16).toString("hex"), action: "gate.answer", target: `gate:${INITIATIVE}/${gateId}`, before: null, after: { choice: null, note: "Ninety days." }, at, by: { name: "Grace", email: "grace@example.invalid", checkout: "reports/main on build-2" }, via: "review-app" };
    await recordPersonAction({ projectRoot: root, initiative: INITIATIVE, prepare: async () => ({ entry, answer: { id: gateId, choice: null, note: "Ninety days." } }) });
    const answered = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((gate) => gate.id === gateId).answer;
    assert.ok(answered, "the gate holds the answer");
    return answered.answeredAt;
  };
  return { root, since, answerAt };
}

test("a gate answered after the run ended still counts as the run's result", async (t) => {
  const { runHasResult } = await import("../../dist/server/session/run-result.mjs");
  const { root, since, answerAt } = await runWithGate(t);
  const until = new Date(Date.now() - 1_000).toISOString();
  const answeredAt = await answerAt(new Date().toISOString());
  assert.ok(Date.parse(answeredAt) > Date.parse(until));
  assert.equal(await runHasResult({ checkout: root, initiative: INITIATIVE, since, until }), true);
  assert.equal(await runHasResult({ checkout: root, initiative: INITIATIVE, since }), false, "without an end time the check reads the gate as it is now");
});

test("a gate answered before the run ended is no result of the run", async (t) => {
  const { runHasResult } = await import("../../dist/server/session/run-result.mjs");
  const { root, since, answerAt } = await runWithGate(t);
  const answeredAt = await answerAt(new Date().toISOString());
  const until = new Date(Date.parse(answeredAt) + 1_000).toISOString();
  assert.equal(await runHasResult({ checkout: root, initiative: INITIATIVE, since, until }), false);
});
