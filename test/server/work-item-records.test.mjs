import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_REQUIREMENT, DRAFT_ADR, DRAFT_REQUIREMENT, INPUT, addEntries, derivedEntry, itemDone, itemProject, itemUpdate, storeRead, workItem } from "./fixtures/work-items.mjs";
import { answerGate, browserRequest } from "./fixtures/workspace-artifacts.mjs";

// Every roadmap entry is a work item with a shaping record of inputs, findings, research gaps, and citations, read with the comments made since it changed.

const ID = /^(input|question|finding|gap)-[0-9a-f]{8}$/;

test("§1, §8: an identifier that names no roadmap entry is refused by both work item tools", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  assert.equal((await call("get_work_item", { item: "nothing" })).value?.code, "item_unknown");
  assert.equal((await call("update_work_item", { item: "nothing", expectedRevision: null, operations: [{ op: "add_input", ...INPUT }] })).value?.code, "item_unknown");
});

test("§4, §5: an entry that cites no Approved requirement is emerging, and one that cites an Approved file without a shaping record is ready", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const sync = await derivedEntry(call, "sync");
  assert.deepEqual(sync.workItem.stage, "emerging");
  assert.equal(sync.state, "emerging", "an emerging entry without an initiative record shows as emerging, not envisioned");
  assert.deepEqual(sync.workItem.unmet.map((condition) => condition.code), ["no_approved_requirement"]);
  const exported = await derivedEntry(call, "export");
  assert.deepEqual([exported.workItem.stage, exported.state, exported.workItem.unmet], ["ready", "envisioned", []]);
});

test("§4: an entry with a shaping record stays emerging until a ready mark, even when it cites an Approved requirement", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  await itemDone(call, "export", [{ op: "add_input", ...INPUT }]);
  assert.equal((await derivedEntry(call, "export")).workItem.stage, "emerging");
  assert.equal((await workItem(call, "export")).stage, "emerging");
});

test("§6, §7: get_work_item returns the item's facts, a null record before shaping, and its cited artifacts with their statuses", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const before = await workItem(call, "export");
  assert.deepEqual([before.item, before.title, before.intent, before.band, before.revision, before.record, before.proposal], ["export", "Export reports", "People export reports.", "Next", null, null, null]);
  assert.deepEqual(before.requirements, [`${APPROVED_REQUIREMENT}#1`]);
  assert.deepEqual(before.cited.map((entry) => [entry.path, entry.kind, entry.status, entry.scope?.label]), [[APPROVED_REQUIREMENT, "requirements", "Approved", "api"]]);
  await itemDone(call, "export", [{ op: "add_input", ...INPUT }]);
  const after = await workItem(call, "export");
  assert.match(after.revision, /^[0-9a-f]{64}$/);
  for (const key of ["inputs", "questions", "findings", "gaps", "adrs", "ready", "origin", "merges", "splitInto", "mergedInto", "kill", "changedAt"]) assert.ok(Object.hasOwn(after.record, key), key);
  assert.match(after.record.inputs[0].id, ID);
});

test("§8: update_work_item applies all or none, refuses a stale revision, and returns the new revision and record", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const first = await itemDone(call, "sync", [{ op: "add_input", ...INPUT }]);
  assert.equal(first.previousRevision, null);
  assert.match(first.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.openedGates, []);
  const stale = await call("update_work_item", { item: "sync", expectedRevision: null, operations: [{ op: "add_input", ...INPUT }] });
  assert.equal(stale.value?.code, "revision_conflict", stale.text);
  assert.equal(stale.value.currentRevision, first.revision);
  const mixed = await itemUpdate(call, "sync", [{ op: "add_input", link: "https://example.invalid/b", note: "Another." }, { op: "add_input", link: "not a link", note: "Broken." }]);
  assert.equal(mixed.value?.code, "link_invalid", mixed.text);
  assert.equal((await workItem(call, "sync")).record.inputs.length, 1, "none of the refused update applied");
});

test("§10: an input is a link with a one-line note, and Prism keeps no copy of the linked content", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const value = await itemDone(call, "sync", [
    { op: "add_input", ...INPUT },
    { op: "add_input", link: "notion://workspace/page-1", note: "Interview notes." },
    { op: "add_input", link: "docs/notes/interview.md", note: "A file in the project." }
  ]);
  assert.deepEqual(value.record.inputs.map((input) => [input.link, input.note]), [[INPUT.link, INPUT.note], ["notion://workspace/page-1", "Interview notes."], ["docs/notes/interview.md", "A file in the project."]]);
  for (const input of value.record.inputs) {
    assert.deepEqual(Object.keys(input).sort(), ["addedAt", "id", "link", "note"]);
    assert.match(input.id, ID);
  }
  assert.equal(new Set(value.record.inputs.map((input) => input.id)).size, 3);
  for (const [link, note] of [["no scheme here", "x"], [INPUT.link, "two\nlines"], [INPUT.link, "x".repeat(301)]]) {
    const refused = await itemUpdate(call, "sync", [{ op: "add_input", link, note }]);
    assert.ok(["link_invalid", "validation_failed"].includes(refused.value?.code), refused.text);
  }
});

test("§2, §11: an item cites requirement references and ADRs that other items cite too, and uncite removes them", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  await itemDone(call, "sync", [{ op: "cite", requirements: ["export.md§1"], adrs: [DRAFT_ADR] }]);
  await itemDone(call, "export", [{ op: "cite", adrs: [DRAFT_ADR] }]);
  const sync = await workItem(call, "sync");
  assert.deepEqual(sync.requirements, [`${APPROVED_REQUIREMENT}#1`], "the requirement reference lands on the roadmap entry");
  assert.deepEqual(sync.record.adrs, [DRAFT_ADR]);
  const adr = sync.cited.find((entry) => entry.path === DRAFT_ADR);
  assert.deepEqual([adr.kind, adr.status, adr.citedBy], ["adrs", "Draft", ["export"]]);
  assert.deepEqual(sync.cited.find((entry) => entry.path === APPROVED_REQUIREMENT).citedBy, ["export"]);
  await itemDone(call, "sync", [{ op: "cite", adrs: [DRAFT_ADR] }]);
  assert.deepEqual((await workItem(call, "sync")).record.adrs, [DRAFT_ADR], "a citation is kept once");
  const outside = await itemUpdate(call, "sync", [{ op: "cite", adrs: ["docs/notes/x.md"] }]);
  assert.equal(outside.value?.code, "validation_failed", outside.text);
  await itemDone(call, "sync", [{ op: "uncite", requirements: ["export.md§1"], adrs: [DRAFT_ADR] }]);
  const after = await workItem(call, "sync");
  assert.deepEqual([after.requirements, after.record.adrs], [[], []]);
});

test("§3: a cited file that does not exist has status null", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  await itemDone(call, "sync", [{ op: "cite", adrs: ["docs/ADRs/sync/missing.md"] }]);
  assert.equal((await workItem(call, "sync")).cited.find((entry) => entry.path === "docs/ADRs/sync/missing.md").status, null);
});

test("§14: a finding needs a link to its source", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const value = await itemDone(call, "sync", [{ op: "add_finding", text: "Most clients reconnect within a minute.", source: "https://status.example.invalid/report" }]);
  const [finding] = value.record.findings;
  assert.deepEqual([finding.text, finding.source], ["Most clients reconnect within a minute.", "https://status.example.invalid/report"]);
  assert.match(finding.id, /^finding-[0-9a-f]{8}$/);
  for (const source of [undefined, "", "   "]) {
    const refused = await itemUpdate(call, "sync", [{ op: "add_finding", text: "A guess.", ...(source === undefined ? {} : { source }) }]);
    assert.equal(refused.value?.code, "source_missing", refused.text);
  }
  const badLink = await itemUpdate(call, "sync", [{ op: "add_finding", text: "A guess.", source: "my memory" }]);
  assert.equal(badLink.value?.code, "link_invalid", badLink.text);
  assert.equal((await workItem(call, "sync")).record.findings.length, 1);
});

test("§15: research that could not reach outside sources is recorded as a gap, not a finding", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const value = await itemDone(call, "sync", [{ op: "add_research_gap", note: "No network access, so competitor pricing was not checked." }]);
  assert.deepEqual(value.record.findings, []);
  assert.deepEqual(value.record.gaps.map((gap) => gap.note), ["No network access, so competitor pricing was not checked."]);
  assert.match(value.record.gaps[0].id, /^gap-[0-9a-f]{8}$/);
});

test("§12: an item returns every comment on its cited artifacts made since its record last changed, for each item that cites them", async (context) => {
  const { call, review } = await itemProject(context);
  await itemDone(call, "sync", [{ op: "cite", adrs: [DRAFT_ADR] }]);
  await itemDone(call, "export", [{ op: "cite", adrs: [DRAFT_ADR] }]);
  const comment = async (text) => {
    const artifact = await storeRead(call, DRAFT_ADR);
    const target = `artifact:api:${DRAFT_ADR}`;
    const listed = await browserRequest(review, `/api/actions?target=${encodeURIComponent(target)}`);
    const action = listed.body.actions.find((item) => item.id === "artifact.comment");
    const applied = await browserRequest(review, "/api/actions/apply", { method: "POST", body: { action: "artifact.comment", target, input: { line: "1", text }, revision: action.revision ?? artifact.version } });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
  };
  await comment("Prefer polling.");
  for (const item of ["sync", "export"]) {
    const comments = (await workItem(call, item)).comments;
    assert.deepEqual(comments.map((entry) => [entry.artifact.path, entry.text]), [[DRAFT_ADR, "Prefer polling."]], item);
    assert.deepEqual(Object.keys(comments[0]).sort(), ["artifact", "at", "author", "id", "line", "text"]);
  }
  await itemDone(call, "sync", [{ op: "add_input", ...INPUT }]);
  assert.deepEqual((await workItem(call, "sync")).comments, [], "a change to the record sets the point after which comments count");
  await comment("Or push after all.");
  assert.deepEqual((await workItem(call, "sync")).comments.map((entry) => entry.text), ["Or push after all."]);
  assert.deepEqual((await workItem(call, "export")).comments.map((entry) => entry.text), ["Prefer polling.", "Or push after all."]);
});

test("§13: no update_work_item operation writes an answer or a person's words into the record", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  for (const operation of [{ op: "answer", question: "question-00000000", text: "Yes." }, { op: "add_input", ...INPUT, by: "Ada Reviewer" }, { op: "set_record", record: { questions: [] } }]) {
    const refused = await itemUpdate(call, "sync", [operation]);
    assert.equal(refused.value?.code, "validation_failed", `${operation.op}: ${refused.text}`);
  }
  const tools = await call("get_work_item", { item: "sync" });
  assert.equal(tools.value?.code ?? null, null, tools.text);
});

test("§13: the review app offers no action that edits a shaping record", async (context) => {
  const { review } = await itemProject(context);
  const listed = await browserRequest(review, `/api/actions?target=${encodeURIComponent("initiative:sync")}`);
  const ids = (listed.body.actions ?? []).map((action) => action.id);
  assert.ok(!ids.some((id) => /shaping|work-item|input|finding/i.test(id)), ids.join(", "));
  const refused = await answerGate(review, { initiative: "sync", id: "gate-0000000000000000", choice: null, note: "An answer to nothing." });
  assert.notEqual(refused.status, 200);
});

test("§1: a work item whose entry was added later is addressed by its roadmap identifier", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  await addEntries(call, [{ id: "late_item", title: "Late item", intent: "Added later.", band: "Later" }]);
  const value = await workItem(call, "late_item");
  assert.deepEqual([value.item, value.stage, value.band], ["late_item", "emerging", "Later"]);
  assert.equal((await storeRead(call, DRAFT_REQUIREMENT)).status, "Draft");
});
