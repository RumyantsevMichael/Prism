import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DRAFT_ADR, INPUT, answer, itemDone, itemProject, itemUpdate, roadmapUpdate, storeRead, workItem } from "./fixtures/work-items.mjs";
import { browserRequest } from "./fixtures/workspace-artifacts.mjs";

// Applying a confirmed merge or split: what a split re-checks at the answer, the changedAt a merge keeps, and a failed write closing the proposal with the roadmap put back.

const ENTRIES = [
  { id: "sync", title: "Sync changes", intent: "Clients see changes.", band: "Next" },
  { id: "live", title: "Live updates", intent: "Screens update live.", band: "Next" }
];

const part = (id, extra = {}) => ({ id, title: id, intent: `${id}.`, inputs: [], questions: [], findings: [], gaps: [], requirements: [], adrs: [], ...extra });

// The folder of an item's shaping record in the store, found beside another item's record.
async function recordFolder(root, beside, item) {
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === "work-item.json" && path.basename(entry.parentPath) === beside) return path.join(path.dirname(entry.parentPath), item);
  }
  throw new Error(`no shaping record of ${beside} under ${root}`);
}

test("a split whose entry gained a requirement reference through update_roadmap while it was pending closes as stale and adds no entry", async (context) => {
  const { call, review } = await itemProject(context, { entries: ENTRIES });
  const record = (await itemDone(call, "sync", [{ op: "add_input", ...INPUT }])).record;
  const gate = (await itemDone(call, "sync", [{ op: "propose_split", reason: "Two needs.", parts: [part("sync-a", { inputs: record.inputs.map((entry) => entry.id) }), part("sync-b")] }])).openedGates[0].id;
  const cited = await roadmapUpdate(call, [{ op: "update_initiative", id: "sync", requirements: ["export.md§1"] }]);
  assert.equal(cited.value?.code ?? null, null, cited.text);
  await answer(review, "sync", gate, "split");
  const sync = await workItem(call, "sync");
  assert.equal(sync.stage, "emerging");
  assert.equal(sync.proposal, null);
  assert.deepEqual([sync.record.proposals.at(-1).outcome, sync.record.proposals.at(-1).code], ["stale", "split_incomplete"]);
  const entries = (await call("get_roadmap", {})).value.record.initiatives;
  assert.deepEqual(entries.map((entry) => [entry.id, entry.decision]), [["sync", null], ["live", null]]);
  assert.deepEqual(entries.find((entry) => entry.id === "sync").requirements, ["docs/requirements/export.md#1"]);
});

test("a merge keeps the earlier changedAt, so the survivor still lists a comment that the merged item listed", async (context) => {
  const { call, review } = await itemProject(context, { entries: ENTRIES });
  await itemDone(call, "live", [{ op: "cite", adrs: [DRAFT_ADR] }]);
  const artifact = await storeRead(call, DRAFT_ADR);
  const target = `artifact:api:${DRAFT_ADR}`;
  const listed = await browserRequest(review, `/api/actions?target=${encodeURIComponent(target)}`);
  const action = listed.body.actions.find((item) => item.id === "artifact.comment");
  const commented = await browserRequest(review, "/api/actions/apply", { method: "POST", body: { action: "artifact.comment", target, input: { line: "1", text: "Prefer polling." }, revision: action.revision ?? artifact.version } });
  assert.equal(commented.status, 200, JSON.stringify(commented.body));
  await itemDone(call, "sync", [{ op: "add_input", ...INPUT }]);
  const gate = (await itemDone(call, "sync", [{ op: "propose_merge", with: "live", recommended: "keep-this", reason: "One need." }])).openedGates[0].id;
  assert.deepEqual((await workItem(call, "live")).comments.map((entry) => entry.text), ["Prefer polling."]);
  const earlier = (await workItem(call, "live")).record.changedAt;
  await answer(review, "sync", gate, "keep-this");
  const sync = await workItem(call, "sync");
  assert.equal(sync.record.mergedInto ?? null, null);
  assert.equal(sync.record.changedAt, earlier);
  assert.deepEqual(sync.comments.map((entry) => entry.text), ["Prefer polling."]);
});

test("a split whose record write fails closes as stale, puts back only what it changed on the roadmap, and lets the item propose again", async (context) => {
  const { place, call, review } = await itemProject(context, { entries: ENTRIES });
  const record = (await itemDone(call, "sync", [{ op: "add_input", ...INPUT }])).record;
  const parts = [part("sync-a", { inputs: record.inputs.map((entry) => entry.id) }), part("sync-b")];
  const gate = (await itemDone(call, "sync", [{ op: "propose_split", reason: "Two needs.", parts }])).openedGates[0].id;
  // A folder where the first part's shaping record goes makes its write fail.
  const blocked = path.join(await recordFolder(place.store, "sync", "sync-a"), "work-item.json");
  await mkdir(blocked, { recursive: true });
  await writeFile(path.join(blocked, "keep"), "x");
  const renamed = await roadmapUpdate(call, [{ op: "update_initiative", id: "live", title: "Live screens" }]);
  assert.equal(renamed.value?.code ?? null, null, renamed.text);
  await answer(review, "sync", gate, "split");
  const sync = await workItem(call, "sync");
  assert.equal(sync.stage, "emerging");
  assert.equal(sync.proposal, null);
  const closed = sync.record.proposals.at(-1);
  assert.deepEqual([closed.kind, closed.outcome], ["split", "stale"]);
  assert.equal(typeof closed.code, "string");
  const roadmap = (await call("get_roadmap", {})).value.record;
  assert.deepEqual(roadmap.initiatives.map((entry) => [entry.id, entry.title, entry.decision]), [["sync", "Sync changes", null], ["live", "Live screens", null]]);
  assert.equal(roadmap.history.at(-1).operation, "restore_work_items");
  const again = await itemUpdate(call, "sync", [{ op: "propose_split", reason: "Two needs.", parts: [part("sync-c", { inputs: record.inputs.map((entry) => entry.id) }), part("sync-d")] }]);
  assert.equal(again.value?.code ?? null, null, again.text);
});
