import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_REQUIREMENT, INPUT, derivedEntry, itemDone, itemProject, itemUpdate, workItem } from "./fixtures/work-items.mjs";

// A work item's requirement references live on its roadmap entry, so changing them alone leaves the shaping record as it was, and a refused update changes neither.

test("a citation that changes only requirement references neither creates nor rewrites the shaping record", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const cited = await itemDone(call, "sync", [{ op: "cite", requirements: ["export.md§1"] }]);
  assert.deepEqual([cited.revision, cited.previousRevision, cited.record], [null, null, null]);
  const sync = await workItem(call, "sync");
  assert.deepEqual([sync.revision, sync.record, sync.stage], [null, null, "ready"]);
  assert.ok(sync.requirements.includes(`${APPROVED_REQUIREMENT}#1`), JSON.stringify(sync.requirements));
  assert.equal((await derivedEntry(call, "sync")).workItem.stage, "ready");

  const shaped = await itemDone(call, "sync", [{ op: "add_input", ...INPUT }]);
  const uncited = await itemDone(call, "sync", [{ op: "uncite", requirements: ["export.md§1"] }]);
  assert.equal(uncited.revision, shaped.revision, "the record's bytes did not change");
  assert.equal(uncited.record.changedAt, shaped.record.changedAt);
  assert.deepEqual((await workItem(call, "sync")).requirements.includes(`${APPROVED_REQUIREMENT}#1`), false);
});

test("an update refused because the record would exceed its bound leaves the roadmap entry's references unchanged", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const finding = (index) => ({ op: "add_finding", text: `${index}`.padEnd(4000, "x"), source: "https://example.invalid/source" });
  for (let round = 0; round < 5; round++) await itemDone(call, "sync", Array.from({ length: 50 }, (_, index) => finding(round * 50 + index)));
  const before = await workItem(call, "sync");
  const refused = await itemUpdate(call, "sync", [{ op: "cite", requirements: ["export.md§1"] }, ...Array.from({ length: 49 }, (_, index) => finding(250 + index))]);
  assert.equal(refused.value?.code, "artifact_too_large", refused.text);
  const after = await workItem(call, "sync");
  assert.deepEqual(after.requirements, before.requirements, "the refusal left the roadmap entry as it was");
  assert.equal(after.revision, before.revision);
});
