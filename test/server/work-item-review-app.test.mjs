import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DRAFT_ADR, DRAFT_REQUIREMENT, INPUT, answer, answeredRound, itemDone, itemProject, workItem } from "./fixtures/work-items.mjs";

// The review app shows emerging items with their shaping records and unmet conditions, and lists killed, merged, and split items in History.

const model = async () => {
  const module = await import("../../dist/server/review/workspace-model.mjs");
  return { ...module, fresh: () => module.forgetWorkspace?.() };
};

async function shapedSync(context) {
  const project = await itemProject(context, { entries: [
    { id: "sync", title: "Sync changes", intent: "Clients see changes.", band: "Next" },
    { id: "live", title: "Live updates", intent: "Screens update live.", band: "Next" },
    { id: "export", title: "Export reports", intent: "People export reports.", band: "Later", requirements: ["export.md§1"] }
  ] });
  const { call, review } = project;
  await answeredRound(call, review, "sync");
  await itemDone(call, "sync", [{ op: "add_input", ...INPUT }, { op: "add_finding", text: "Clients reconnect within a minute.", source: "https://status.example.invalid/r" }, { op: "add_research_gap", note: "No usage data." }, { op: "cite", requirements: ["sync.md§1"], adrs: [DRAFT_ADR] }]);
  return project;
}

test("§51: the roadmap shows an emerging entry as Emerging with its unmet conditions", async (context) => {
  const { root } = await shapedSync(context);
  const { loadRoadmapView, fresh } = await model();
  fresh();
  const items = (await loadRoadmapView(root)).items;
  const sync = items.find((item) => item.id === "sync");
  assert.equal(sync.state, "emerging");
  assert.equal(sync.workItem.stage, "emerging");
  assert.ok(sync.workItem.unmet.some((condition) => condition.code === "requirement_not_approved"));
  assert.equal(items.find((item) => item.id === "export").state, "envisioned");
  const roadmap = await readFile(new URL("../../dist/server/review/public/views/roadmap.js", import.meta.url), "utf8");
  assert.match(roadmap, /emerging: "Emerging"/, "the roadmap names the emerging state");
  const { statusOf } = await import("../../dist/server/review/public/kit/statuses.js");
  const emerging = statusOf("emerging");
  assert.deepEqual([emerging.known, emerging.label], [true, "Emerging"], "the status registry draws emerging");
  const catalog = await readFile(new URL("../../dist/server/review/public/kit/catalog.js", import.meta.url), "utf8");
  assert.match(catalog, /<prism-status value="emerging"/, "the catalog shows the emerging status");
});

test("§51: an item's page holds its shaping record, its cited artifacts with their statuses, and its unmet conditions", async (context) => {
  const { root, call } = await shapedSync(context);
  const { loadInitiativeView, fresh } = await model();
  fresh();
  const view = await loadInitiativeView(root, "sync");
  const item = view.workItem;
  assert.ok(item, "the initiative view carries the work item");
  const expected = await workItem(call, "sync");
  assert.equal(item.stage, "emerging");
  assert.deepEqual(item.record.inputs.map((input) => [input.link, input.note]), [[INPUT.link, INPUT.note]]);
  assert.deepEqual(item.record.findings.map((finding) => finding.source), ["https://status.example.invalid/r"]);
  assert.deepEqual(item.record.gaps.map((gap) => gap.note), ["No usage data."]);
  assert.equal(item.record.questions[0].answer.choice, "recommended");
  assert.deepEqual(item.cited.map((entry) => [entry.path, entry.status]), expected.cited.map((entry) => [entry.path, entry.status]));
  assert.ok(item.cited.some((entry) => entry.path === DRAFT_REQUIREMENT && entry.status === "Draft"));
  assert.deepEqual(item.unmet, expected.unmet);
  const page = await readFile(new URL("../../dist/server/review/public/views/initiative.js", import.meta.url), "utf8");
  assert.match(page, /workItem/, "the initiative page renders the work item");
});

test("§51: History lists each killed item with the person's reason", async (context) => {
  const { root, call, review } = await shapedSync(context);
  await itemDone(call, "live", [{ op: "add_input", link: "https://example.invalid/live", note: "Live notes." }]);
  const kill = await itemDone(call, "live", [{ op: "propose_kill", reason: "Covered elsewhere.", artifacts: [] }]);
  await answer(review, "live", kill.openedGates.find((gate) => gate.purpose === "kill").id, "kill", "Covered by sync.");
  const proposal = await itemDone(call, "sync", [{ op: "propose_kill", reason: "Dropped.", artifacts: [{ path: DRAFT_REQUIREMENT, choice: "keep" }, { path: DRAFT_ADR, choice: "keep" }] }]);
  for (const gate of proposal.openedGates.filter((item) => item.purpose === "artifact")) await answer(review, "sync", gate.id, "keep");
  await answer(review, "sync", proposal.openedGates.find((gate) => gate.purpose === "kill").id, "kill", "Reloading is enough.");
  const { loadNavigation, fresh } = await model();
  fresh();
  const history = (await loadNavigation(root)).places.history;
  const entry = (id) => history.find((item) => item.id === id);
  assert.deepEqual([entry("live").decision, entry("live").reason], ["killed", "Covered by sync."]);
  assert.deepEqual([entry("sync").decision, entry("sync").reason], ["killed", "Reloading is enough."]);
});

test("§51: History lists a merged item with the item it merged into and a split item with its parts", async (context) => {
  const { root, call, review } = await shapedSync(context);
  await itemDone(call, "live", [{ op: "add_input", link: "https://example.invalid/live", note: "Live notes." }]);
  const merge = await itemDone(call, "live", [{ op: "propose_merge", with: "sync", recommended: "keep-other", reason: "One need." }]);
  await answer(review, "live", merge.openedGates[0].id, "keep-other");
  const record = (await workItem(call, "sync")).record;
  const ids = (key) => record[key].map((item) => item.id);
  const parts = [
    { id: "sync-online", title: "Online sync", intent: "Online.", inputs: ids("inputs"), questions: ids("questions"), findings: ids("findings"), gaps: ids("gaps"), requirements: ["docs/requirements/sync.md#1"], adrs: [DRAFT_ADR] },
    { id: "sync-offline", title: "Offline sync", intent: "Offline.", inputs: [], questions: [], findings: [], gaps: [], requirements: [], adrs: [] }
  ];
  const split = await itemDone(call, "sync", [{ op: "propose_split", reason: "Two needs.", parts }]);
  await answer(review, "sync", split.openedGates[0].id, "split");
  const { loadNavigation, fresh } = await model();
  fresh();
  const history = (await loadNavigation(root)).places.history;
  const entry = (id) => history.find((item) => item.id === id);
  assert.deepEqual([entry("live").decision, entry("live").by], ["merged", "sync"]);
  assert.deepEqual([entry("sync").decision, entry("sync").into], ["split", ["sync-online", "sync-offline"]]);
});
