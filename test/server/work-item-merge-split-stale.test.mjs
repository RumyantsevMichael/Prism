import assert from "node:assert/strict";
import test from "node:test";
import { INPUT, answer, askRound, itemDone, itemProject, question, workItem } from "./fixtures/work-items.mjs";

// A merge or split proposal that no longer fits its items when the person answers closes as stale with why, and changes no item or roadmap entry.

const ENTRIES = [
  { id: "sync", title: "Sync changes", intent: "Clients see changes.", band: "Next" },
  { id: "live", title: "Live updates", intent: "Screens update live.", band: "Next" }
];

test("a merge whose other item gained an open question since the proposal closes as stale and merges nothing", async (context) => {
  const { call, review } = await itemProject(context, { entries: ENTRIES });
  await itemDone(call, "sync", [{ op: "add_input", ...INPUT }]);
  await itemDone(call, "live", [{ op: "add_input", link: "https://docs.example.invalid/live", note: "Live notes." }]);
  const gate = (await itemDone(call, "sync", [{ op: "propose_merge", with: "live", recommended: "keep-this", reason: "One need." }])).openedGates[0].id;
  await askRound(call, "live", [question("Is offline in scope?")]);
  await answer(review, "sync", gate, "keep-this");
  const [sync, live] = [await workItem(call, "sync"), await workItem(call, "live")];
  assert.deepEqual([sync.stage, live.stage], ["emerging", "emerging"]);
  assert.equal(sync.proposal, null);
  const closed = sync.record.proposals.at(-1);
  assert.deepEqual([closed.kind, closed.outcome, closed.code], ["merge", "stale", "questions_open"]);
  assert.equal(sync.record.inputs.length, 1);
  assert.deepEqual(sync.record.merges, []);
  const entries = (await call("get_roadmap", {})).value.record.initiatives;
  assert.deepEqual(entries.map((entry) => entry.decision), [null, null]);
});

test("a split whose part identifier the roadmap gained since the proposal closes as stale and adds no entry", async (context) => {
  const { call, review } = await itemProject(context, { entries: ENTRIES });
  const record = (await itemDone(call, "sync", [{ op: "add_input", ...INPUT }])).record;
  const part = (id, inputs) => ({ id, title: id, intent: `${id}.`, inputs, questions: [], findings: [], gaps: [], requirements: [], adrs: [] });
  const gate = (await itemDone(call, "sync", [{ op: "propose_split", reason: "Two needs.", parts: [part("sync-a", record.inputs.map((entry) => entry.id)), part("sync-b", [])] }])).openedGates[0].id;
  const current = await call("get_roadmap", {});
  const added = await call("update_roadmap", { expectedRevision: current.value.revision, operations: [{ op: "add_initiative", id: "sync-a", title: "Taken", intent: "Taken.", band: "Later" }] });
  assert.equal(added.value?.code ?? null, null, added.text);
  await answer(review, "sync", gate, "split");
  const sync = await workItem(call, "sync");
  assert.equal(sync.stage, "emerging");
  assert.equal(sync.record.splitInto, null);
  assert.equal(sync.record.proposals.at(-1).outcome, "stale");
  const ids = (await call("get_roadmap", {})).value.record.initiatives.map((entry) => entry.id);
  assert.deepEqual(ids, ["sync", "live", "sync-a"]);
});
