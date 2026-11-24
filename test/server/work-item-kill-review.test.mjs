import assert from "node:assert/strict";
import test from "node:test";
import { INPUT, answeredRound, itemDone, itemProject, itemUpdate, tryAnswer, workItem } from "./fixtures/work-items.mjs";

// Review findings of the kill slice: a merge or split reads the item's stored stage, and a kill that withdraws a cited file that does not exist applies.

const parts = [
  { id: "export-a", title: "A", intent: "A.", inputs: [], questions: [], findings: [], gaps: [], requirements: ["export.md§1"], adrs: [] },
  { id: "export-b", title: "B", intent: "B.", inputs: [], questions: [], findings: [], gaps: [], requirements: [], adrs: [] }
];

async function readyExport(context) {
  const project = await itemProject(context);
  await answeredRound(project.call, project.review, "sync");
  await itemDone(project.call, "sync", [{ op: "add_input", ...INPUT }]);
  assert.deepEqual([(await workItem(project.call, "export")).stage, (await workItem(project.call, "export")).record], ["ready", null]);
  return project;
}

test("review §39: propose_merge on a ready item without a shaping record is refused with not_emerging", async (context) => {
  const { call } = await readyExport(context);
  const merge = await itemUpdate(call, "export", [{ op: "propose_merge", with: "sync", recommended: "keep-this", reason: "Same." }]);
  assert.equal(merge.value?.code, "not_emerging", merge.text);
});

test("review §39: propose_split on a ready item without a shaping record is refused with not_emerging", async (context) => {
  const { call } = await readyExport(context);
  const split = await itemUpdate(call, "export", [{ op: "propose_split", reason: "Too big.", parts }]);
  assert.equal(split.value?.code, "not_emerging", split.text);
});

test("review §44/§49: a kill that withdraws a cited requirement file that does not exist is refused at the proposal or applies at the answer", async (context) => {
  const { call, review } = await itemProject(context);
  await answeredRound(call, review, "sync");
  await itemDone(call, "sync", [{ op: "add_input", ...INPUT }, { op: "cite", requirements: ["missing.md§1"] }]);
  const proposed = await itemUpdate(call, "sync", [{ op: "propose_kill", reason: "Dropped.", artifacts: [{ path: "docs/requirements/missing.md", choice: "withdraw" }] }]);
  if (proposed.value?.code) return assert.equal(proposed.value.code, "validation_failed", proposed.text);
  const proposal = (await workItem(call, "sync")).proposal;
  await tryAnswer(review, "sync", proposal.artifacts[0].gate, "withdraw");
  await tryAnswer(review, "sync", proposal.gate, "kill", "Dropped.");
  const after = await workItem(call, "sync");
  assert.equal(after.stage, "killed", JSON.stringify(after.record.proposals?.at(-1)));
});
