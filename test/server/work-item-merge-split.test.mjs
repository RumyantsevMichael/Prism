import assert from "node:assert/strict";
import test from "node:test";
import { DRAFT_ADR, INPUT, answer, answeredRound, askRound, derivedEntry, gateOf, itemDone, itemProject, itemUpdate, question, roadmapUpdate, tryAnswer, workItem } from "./fixtures/work-items.mjs";

// A person merges two emerging work items or splits one at a gate, and every input, answer, finding, gap, and citation lands in an item.

const ENTRIES = [
  { id: "sync", title: "Sync changes", intent: "Clients see changes.", band: "Next" },
  { id: "live", title: "Live updates", intent: "Screens update live.", band: "Next" },
  { id: "export", title: "Export reports", intent: "People export reports.", band: "Later", requirements: ["export.md§1"] }
];

// Two shaped items: sync with an input, an answered round, a finding, a gap, and a cited ADR; live with an input and a cited requirement.
async function shapedPair(context) {
  const project = await itemProject(context, { entries: ENTRIES });
  const { call, review } = project;
  await itemDone(call, "sync", [{ op: "add_input", ...INPUT }, { op: "add_finding", text: "Clients reconnect within a minute.", source: "https://status.example.invalid/r" }, { op: "add_research_gap", note: "No access to usage data." }, { op: "cite", adrs: [DRAFT_ADR] }]);
  await answeredRound(call, review, "sync");
  await itemDone(call, "live", [{ op: "add_input", link: "https://docs.example.invalid/live", note: "Live notes." }, { op: "cite", requirements: ["export.md§1"] }]);
  return project;
}

const proposeMerge = (call, recommended = "keep-this") => itemUpdate(call, "sync", [{ op: "propose_merge", with: "live", recommended, reason: "Both make clients show changes without a reload." }]);

test("§39: a merge or split is refused for an item that is not emerging, has an initiative record, has a pending proposal, or has open questions", async (context) => {
  const { call } = await shapedPair(context);
  const notEmerging = await itemUpdate(call, "sync", [{ op: "propose_merge", with: "export", recommended: "keep-this", reason: "r" }]);
  assert.equal(notEmerging.value?.code, "not_emerging", notEmerging.text);
  const created = await call("update_initiative", { initiative: "export", expectedRevision: null, operations: [{ op: "create", slug: "export", title: "Export", requirements: ["export.md§1"] }] });
  assert.equal(created.value?.code ?? null, null, created.text);
  await itemDone(call, "export", [{ op: "add_input", ...INPUT }]);
  const started = await itemUpdate(call, "sync", [{ op: "propose_merge", with: "export", recommended: "keep-this", reason: "r" }]);
  assert.equal(started.value?.code, "design_started", started.text);
  await askRound(call, "live", [question("Is offline in scope?")]);
  const open = await itemUpdate(call, "sync", [{ op: "propose_merge", with: "live", recommended: "keep-this", reason: "r" }]);
  assert.equal(open.value?.code, "questions_open", open.text);
  assert.match(open.text, /Is offline in scope\?/);
  const live = (await workItem(call, "live")).record;
  const part = (id, extra = {}) => ({ id, title: id, intent: `${id}.`, inputs: [], questions: [], findings: [], gaps: [], requirements: [], adrs: [], ...extra });
  const splitOpen = await itemUpdate(call, "live", [{ op: "propose_split", reason: "r", parts: [part("live-a", { inputs: live.inputs.map((entry) => entry.id), questions: live.questions.map((entry) => entry.id), requirements: ["docs/requirements/export.md#1"] }), part("live-b")] }]);
  assert.equal(splitOpen.value?.code, "questions_open", splitOpen.text);
});

test("§39: a proposal stands alone, and a second proposal waits for the first", async (context) => {
  const { call } = await shapedPair(context);
  const mixed = await itemUpdate(call, "sync", [{ op: "propose_merge", with: "live", recommended: "keep-this", reason: "r" }, { op: "add_input", ...INPUT }]);
  assert.equal(mixed.value?.code, "validation_failed", mixed.text);
  assert.equal((await proposeMerge(call)).value?.code ?? null, null);
  const again = await itemUpdate(call, "live", [{ op: "propose_merge", with: "sync", recommended: "keep-this", reason: "r" }]);
  assert.equal(again.value?.code, "proposal_pending", again.text);
});

test("§40: a merge proposal opens a gate that names both items and offers keeping either or keeping both apart", async (context) => {
  const { call } = await shapedPair(context);
  const proposed = await proposeMerge(call, "keep-other");
  assert.equal(proposed.value?.code ?? null, null, proposed.text);
  const gate = await gateOf(call, "sync", proposed.value.openedGates[0].id);
  assert.equal(gate.kind, "decision");
  assert.deepEqual(gate.options.map((option) => option.id), ["keep-this", "keep-other", "separate"]);
  assert.equal(gate.recommended.option, "keep-other");
  for (const text of ["Sync changes", "Live updates", "Clients see changes.", "Screens update live.", "without a reload"]) assert.match(gate.context, new RegExp(text.replace(/[.?]/g, "\\$&")), text);
  assert.deepEqual((await workItem(call, "sync")).proposal, { kind: "merge", gate: gate.id, with: "live" });
});

test("§41: keeping one item merges both records into it under its own identifier, and the other is recorded as merged into it", async (context) => {
  const { call, review } = await shapedPair(context);
  const before = { sync: (await workItem(call, "sync")).record, live: (await workItem(call, "live")).record };
  const gate = (await proposeMerge(call)).value.openedGates[0].id;
  await answer(review, "sync", gate, "keep-other");
  const live = await workItem(call, "live");
  const ids = (key) => [...before.sync[key], ...before.live[key]].map((entry) => entry.id).sort();
  for (const key of ["inputs", "questions", "findings", "gaps"]) assert.deepEqual(live.record[key].map((entry) => entry.id).sort(), ids(key), key);
  assert.ok(live.record.questions.every((entry) => entry.answer !== null || entry.withdrawn), "answers move with their questions");
  assert.deepEqual(live.record.adrs, [DRAFT_ADR]);
  assert.deepEqual(live.requirements, ["docs/requirements/export.md#1"]);
  assert.deepEqual(live.record.merges.map((entry) => [entry.from, entry.gate]), [["sync", gate]]);
  assert.equal(live.record.ready, null);
  const sync = await workItem(call, "sync");
  assert.equal(sync.stage, "merged");
  assert.equal(sync.record.mergedInto, "live");
  assert.equal(sync.record.inputs.length, before.sync.inputs.length, "the merged item keeps its own record");
  const derived = await derivedEntry(call, "sync");
  assert.deepEqual([derived.workItem.stage, derived.band, derived.state], ["merged", null, "merged"]);
  const entry = (await call("get_roadmap", {})).value.record.initiatives.find((item) => item.id === "sync");
  assert.deepEqual([entry.decision.kind, entry.decision.into, entry.decision.gate], ["merged", "live", gate]);
});

test("§41: separate leaves both items as they were", async (context) => {
  const { call, review } = await shapedPair(context);
  const before = [(await workItem(call, "sync")).record, (await workItem(call, "live")).record];
  const gate = (await proposeMerge(call)).value.openedGates[0].id;
  await answer(review, "sync", gate, "separate");
  const after = [await workItem(call, "sync"), await workItem(call, "live")];
  assert.deepEqual(after.map((item) => item.stage), ["emerging", "emerging"]);
  assert.deepEqual(after[1].record.inputs, before[1].inputs);
  assert.deepEqual(after[0].record.inputs, before[0].inputs);
  assert.equal(after[0].proposal, null);
  assert.match(JSON.stringify(after[0].record), /"outcome":"separate"/);
});

test("§42: a split must give every entry, reference, and ADR to a part and use new identifiers", async (context) => {
  const { call } = await shapedPair(context);
  const record = (await workItem(call, "sync")).record;
  const all = { inputs: record.inputs.map((entry) => entry.id), questions: record.questions.map((entry) => entry.id), findings: record.findings.map((entry) => entry.id), gaps: record.gaps.map((entry) => entry.id), requirements: [], adrs: [DRAFT_ADR] };
  const part = (id, extra = {}) => ({ id, title: id, intent: `${id} intent.`, inputs: [], questions: [], findings: [], gaps: [], requirements: [], adrs: [], ...extra });
  const incomplete = await itemUpdate(call, "sync", [{ op: "propose_split", reason: "Two needs.", parts: [part("sync-online", { inputs: all.inputs }), part("sync-offline")] }]);
  assert.equal(incomplete.value?.code, "split_incomplete", incomplete.text);
  assert.match(incomplete.text, new RegExp(all.findings[0]));
  const taken = await itemUpdate(call, "sync", [{ op: "propose_split", reason: "r", parts: [part("live", all), part("sync-offline")] }]);
  assert.equal(taken.value?.code, "validation_failed", "a part cannot take an existing identifier");
  const unknown = await itemUpdate(call, "sync", [{ op: "propose_split", reason: "r", parts: [part("a-part", { ...all, inputs: [...all.inputs, "input-00000000"] }), part("b-part")] }]);
  assert.equal(unknown.value?.code, "validation_failed", "a part cannot take an entry the record lacks");
  const one = await itemUpdate(call, "sync", [{ op: "propose_split", reason: "r", parts: [part("a-part", all)] }]);
  assert.equal(one.value?.code, "validation_failed", "a split has at least two parts");
  const proposed = await itemUpdate(call, "sync", [{ op: "propose_split", reason: "Online and offline sync change independently.", parts: [part("sync-online", all), part("sync-offline", { inputs: all.inputs, adrs: [DRAFT_ADR] })] }]);
  assert.equal(proposed.value?.code ?? null, null, proposed.text);
  const gate = await gateOf(call, "sync", proposed.value.openedGates[0].id);
  assert.deepEqual(gate.options.map((option) => option.id), ["split", "keep-whole"]);
  assert.equal(gate.recommended.option, "split");
  assert.match(gate.context, /sync-online/);
  assert.match(gate.context, /sync-offline/);
  assert.equal((await workItem(call, "sync")).proposal.kind, "split");
});

test("§43: a confirmed split adds each part after the original with what it takes, and records the split on every item", async (context) => {
  const { call, review } = await shapedPair(context);
  const record = (await workItem(call, "sync")).record;
  const inputs = record.inputs.map((entry) => entry.id);
  const parts = [
    { id: "sync-online", title: "Online sync", intent: "Online clients sync.", inputs, questions: record.questions.map((entry) => entry.id), findings: record.findings.map((entry) => entry.id), gaps: [], requirements: [], adrs: [DRAFT_ADR] },
    { id: "sync-offline", title: "Offline sync", intent: "Offline clients sync.", inputs, questions: [], findings: [], gaps: record.gaps.map((entry) => entry.id), requirements: [], adrs: [] }
  ];
  const gate = (await itemDone(call, "sync", [{ op: "propose_split", reason: "Two needs.", parts }])).openedGates[0].id;
  await answer(review, "sync", gate, "split");
  const roadmap = (await call("get_roadmap", {})).value.record.initiatives;
  const order = roadmap.map((entry) => entry.id);
  assert.deepEqual(order.slice(order.indexOf("sync"), order.indexOf("sync") + 3), ["sync", "sync-online", "sync-offline"]);
  const online = await workItem(call, "sync-online");
  assert.deepEqual([online.title, online.intent, online.band, online.stage], ["Online sync", "Online clients sync.", "Next", "emerging"]);
  assert.deepEqual(online.record.inputs.map((entry) => entry.id), inputs);
  assert.deepEqual(online.record.findings, record.findings);
  assert.deepEqual(online.record.questions, record.questions);
  assert.deepEqual(online.record.adrs, [DRAFT_ADR]);
  assert.deepEqual(online.record.origin, { kind: "split", from: "sync", gate });
  const offline = await workItem(call, "sync-offline");
  assert.deepEqual([offline.record.gaps, offline.record.findings, offline.record.adrs], [record.gaps, [], []]);
  const original = await workItem(call, "sync");
  assert.equal(original.stage, "split");
  assert.deepEqual(original.record.splitInto, ["sync-online", "sync-offline"]);
  const decision = roadmap.find((entry) => entry.id === "sync").decision;
  assert.deepEqual([decision.kind, decision.into, decision.gate], ["split", ["sync-online", "sync-offline"], gate]);
  assert.equal((await derivedEntry(call, "sync")).band, null);
});

test("§43: keep-whole leaves the item as it was", async (context) => {
  const { call, review } = await shapedPair(context);
  const record = (await workItem(call, "sync")).record;
  const all = { inputs: record.inputs.map((entry) => entry.id), questions: record.questions.map((entry) => entry.id), findings: record.findings.map((entry) => entry.id), gaps: record.gaps.map((entry) => entry.id), requirements: [], adrs: [DRAFT_ADR] };
  const gate = (await itemDone(call, "sync", [{ op: "propose_split", reason: "r", parts: [{ id: "x-one", title: "One", intent: "One.", ...all }, { id: "x-two", title: "Two", intent: "Two.", inputs: [], questions: [], findings: [], gaps: [], requirements: [], adrs: [] }] }])).openedGates[0].id;
  await answer(review, "sync", gate, "keep-whole");
  assert.equal((await workItem(call, "sync")).stage, "emerging");
  assert.equal((await call("get_roadmap", {})).value.record.initiatives.some((entry) => entry.id === "x-one"), false);
});

test("§10: no merge or split happens without the person's answer, and an agent cannot answer the gate", async (context) => {
  const { call, review } = await shapedPair(context);
  const gate = (await proposeMerge(call)).value.openedGates[0].id;
  const written = await call("update_coordination_state", { initiative: "sync", expectedRevision: (await call("get_coordination_state", { initiative: "sync" })).value.revision, changes: { gateOperations: [{ op: "answer", id: gate, choice: "keep-this" }] } });
  assert.notEqual(written.value?.code ?? null, null, "an agent write cannot answer a gate");
  assert.deepEqual([(await workItem(call, "sync")).stage, (await workItem(call, "live")).stage], ["emerging", "emerging"]);
  const free = await tryAnswer(review, "sync", gate, null, "Not sure these are one.");
  assert.equal(free.status, 200, JSON.stringify(free.body));
  assert.deepEqual([(await workItem(call, "sync")).stage, (await workItem(call, "live")).stage], ["emerging", "emerging"], "a free answer merges nothing");
  assert.equal((await workItem(call, "sync")).proposal, null);
  assert.match(JSON.stringify((await workItem(call, "sync")).record), /"outcome":"declined"/);
  const placed = await roadmapUpdate(call, [{ op: "place", id: "sync", band: "Now" }]);
  assert.equal(placed.value?.code ?? null, null, placed.text);
});

test("§50: a merged or split entry leaves the bands, refuses place and update_initiative, and appears in the roadmap view's history", async (context) => {
  const { call, review } = await shapedPair(context);
  const gate = (await proposeMerge(call)).value.openedGates[0].id;
  await answer(review, "sync", gate, "keep-this");
  for (const operation of [{ op: "place", id: "live", band: "Now" }, { op: "update_initiative", id: "live", title: "Renamed" }]) {
    const refused = await roadmapUpdate(call, [operation]);
    assert.notEqual(refused.value?.code ?? null, null, operation.op);
  }
  const view = (await call("get_artifact", { path: "docs/roadmap.md" })).value.content;
  assert.match(view, /^## Merged context$/m);
  assert.match(view, /Live updates[^\n]*Sync changes/);
  const bands = view.split(/^## Sequencing rationale$/m)[0];
  assert.doesNotMatch(bands, /\*\*Live updates\*\*/, "the merged entry is in no band");
});
