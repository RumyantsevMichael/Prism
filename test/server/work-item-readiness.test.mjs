import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DRAFT_ADR, INPUT, OPTIONS, addEntries, answer, answeredRound, askRound, derivedEntry, draftAdr, gateOf, itemDone, itemProject, itemUpdate, question, storeRead, storeWrite, workItem } from "./fixtures/work-items.mjs";
import { answerGate, browserRequest } from "./fixtures/workspace-artifacts.mjs";

// A person confirms at a gate that an item is ready, readiness is refused while shaping is incomplete, and design refuses emerging items and Draft ADRs.

const codes = (unmet) => unmet.map((condition) => condition.code);

// The export item after an answered round: it cites the Approved export.md, so its only open step is the person's confirmation.
async function shaped(context) {
  const project = await itemProject(context);
  await answeredRound(project.call, project.review, "export");
  return project;
}

test("§23: request_ready opens a ready gate whose context lists each cited artifact with its status, and records the proposal", async (context) => {
  const { call } = await shaped(context);
  const value = await itemDone(call, "export", [{ op: "request_ready" }]);
  assert.deepEqual(value.openedGates.map((gate) => [gate.kind, gate.purpose]), [["decision", "ready"]]);
  const gate = await gateOf(call, "export", value.openedGates[0].id);
  assert.deepEqual(gate.options.map((option) => option.id), ["ready", "not-ready"]);
  assert.equal(gate.recommended.option, "ready");
  assert.match(gate.context, /docs\/requirements\/export\.md/);
  assert.match(gate.context, /Approved/);
  assert.deepEqual((await workItem(call, "export")).proposal, { kind: "ready", gate: gate.id });
  const mixed = await itemUpdate(call, "export", [{ op: "request_ready" }, { op: "add_input", ...INPUT }]);
  assert.equal(mixed.value?.code, "validation_failed", "request_ready stands alone");
});

test("§24, §25: request_ready is refused with every unmet condition in order, and opens no gate", async (context) => {
  const { call, review } = await itemProject(context);
  const none = await itemUpdate(call, "sync", [{ op: "request_ready" }]);
  assert.equal(none.value?.code, "readiness_unmet", none.text);
  assert.deepEqual(codes(none.value.unmet), ["no_approved_requirement"]);
  await answeredRound(call, review, "sync");
  await storeWrite(call, "docs/ADRs/sync/one-option.md", draftAdr("One option", { options: [OPTIONS[0]] }));
  await itemDone(call, "sync", [{ op: "cite", requirements: ["sync.md§1"], adrs: [DRAFT_ADR, "docs/ADRs/sync/one-option.md"] }]);
  await askRound(call, "sync", [question("Conflicts?"), question("Nice to have?", { blocking: false })]);
  const refused = await itemUpdate(call, "sync", [{ op: "request_ready" }]);
  assert.equal(refused.value?.code, "readiness_unmet", refused.text);
  assert.deepEqual(codes(refused.value.unmet), ["no_approved_requirement", "requirement_not_approved", "draft_adr_nonconforming", "question_unanswered"]);
  const [, notApproved, nonconforming, unanswered] = refused.value.unmet;
  assert.deepEqual([notApproved.path, notApproved.status, notApproved.scope?.label], ["docs/requirements/sync.md", "Draft", "api"]);
  assert.equal(nonconforming.path, "docs/ADRs/sync/one-option.md", "a conforming Draft ADR is no unmet condition");
  assert.ok(nonconforming.findings.length > 0);
  assert.equal(unanswered.text, "Conflicts?", "a question that readiness does not need is no unmet condition");
  assert.match(refused.text, /sync\.md/, "the message names the conditions");
  assert.match(refused.text, /one-option\.md/);
  assert.match(refused.text, /Conflicts\?/);
  assert.deepEqual(refused.value.unmet, (await workItem(call, "sync")).unmet, "get_work_item reports the same conditions");
  const state = (await call("get_coordination_state", { initiative: "sync" })).value.state;
  assert.ok(!(state.pending ?? []).some((gate) => gate.options?.some((option) => option.id === "ready")), "no ready gate was opened");
});

test("§26: the person's ready answer marks the item ready, and design may then start", async (context) => {
  const { call, review } = await shaped(context);
  const gate = (await itemDone(call, "export", [{ op: "request_ready" }])).openedGates[0].id;
  assert.equal((await derivedEntry(call, "export")).workItem.stage, "emerging");
  await answer(review, "export", gate, "ready");
  const value = await workItem(call, "export");
  assert.equal(value.stage, "ready");
  assert.equal(value.record.ready.gate, gate);
  assert.equal(value.record.ready.by?.name, "Ada Reviewer");
  assert.equal((await derivedEntry(call, "export")).workItem.stage, "ready");
  const current = await call("get_initiative", { initiative: "export" });
  const created = await call("update_initiative", { initiative: "export", expectedRevision: current.value?.revision ?? null, operations: [{ op: "create", slug: "export", title: "Export reports", requirements: ["export.md§1"] }] });
  assert.equal(created.value?.code ?? null, null, created.text);
});

test("§26: not-ready closes the proposal with the person's note, and the item stays emerging", async (context) => {
  const { call, review } = await shaped(context);
  const gate = (await itemDone(call, "export", [{ op: "request_ready" }])).openedGates[0].id;
  await answer(review, "export", gate, "not-ready", "Signing is still open.");
  const value = await workItem(call, "export");
  assert.equal(value.stage, "emerging");
  assert.equal(value.record.ready, null);
  assert.equal(value.proposal, null);
  assert.match(JSON.stringify(value.record), /not-ready/);
  assert.match(JSON.stringify(value.record), /Signing is still open\./);
});

test("§26: a ready answer given after a condition became unmet leaves the item emerging with the unmet conditions", async (context) => {
  const { call, review } = await shaped(context);
  const gate = (await itemDone(call, "export", [{ op: "request_ready" }])).openedGates[0].id;
  const asked = await call("update_artifact", { operations: [{ op: "ask_approval", path: "docs/requirements/export.md", status: "Withdrawn", context: "Withdraw it." }] });
  assert.equal(asked.value?.code ?? null, null, asked.text);
  const approval = asked.value.artifacts[0].gate;
  const withdrawn = await answerGate(review, { id: approval, choice: "approve" });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  await answer(review, "export", gate, "ready");
  const value = await workItem(call, "export");
  assert.equal(value.stage, "emerging");
  assert.equal(value.record.ready, null);
  assert.match(JSON.stringify(value.record), /"outcome":"unmet"/);
});

test("§9: a change to the record withdraws a pending ready proposal and clears the ready mark", async (context) => {
  const { call, review } = await shaped(context);
  const pending = (await itemDone(call, "export", [{ op: "request_ready" }])).openedGates[0].id;
  await itemDone(call, "export", [{ op: "add_input", ...INPUT }]);
  assert.equal((await workItem(call, "export")).proposal, null);
  const state = (await call("get_coordination_state", { initiative: "export" })).value.state;
  assert.ok(!(state.pending ?? []).some((item) => item.id === pending), "the ready gate closed as withdrawn");
  const listed = await browserRequest(review, `/api/actions?target=${encodeURIComponent(`gate:export/${pending}`)}`);
  assert.ok(listed.status !== 200 || !listed.body.actions.some((action) => action.id === "gate.answer" && !action.unavailable), "the withdrawn gate takes no answer");
  const gate = (await itemDone(call, "export", [{ op: "request_ready" }])).openedGates[0].id;
  await answer(review, "export", gate, "ready");
  assert.equal((await workItem(call, "export")).stage, "ready");
  await itemDone(call, "export", [{ op: "add_input", link: "https://example.invalid/late", note: "A late input." }]);
  const after = await workItem(call, "export");
  assert.deepEqual([after.stage, after.record.ready], ["emerging", null], "shaping after confirmation needs a new confirmation");
});

test("§27: design does not start for an emerging item, naming the unmet conditions, and an initiative without a roadmap entry is not refused", async (context) => {
  const { call, review } = await itemProject(context);
  const create = (id, requirements) => call("update_initiative", { initiative: id, expectedRevision: null, operations: [{ op: "create", slug: id, title: id, requirements }] });
  const emerging = await create("sync", ["export.md§1"]);
  assert.equal(emerging.value?.code, "item_emerging", emerging.text);
  assert.equal(emerging.value.item, "sync");
  assert.ok(codes(emerging.value.unmet).includes("no_approved_requirement"));
  assert.equal((await call("get_initiative", { initiative: "sync" })).value.exists, false, "nothing changed");
  await answeredRound(call, review, "export");
  const unconfirmed = await create("export", ["export.md§1"]);
  assert.equal(unconfirmed.value?.code, "item_emerging", unconfirmed.text);
  assert.deepEqual(codes(unconfirmed.value.unmet), ["not_confirmed"]);
  const unlisted = await create("unlisted", ["export.md§1"]);
  assert.equal(unlisted.value?.code ?? null, null, unlisted.text);
});

test("§27: a design claim on an emerging item's existing initiative is refused", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  await addEntries(call, [{ id: "legacy", title: "Legacy", intent: "Started before shaping.", band: "Now" }]);
  const created = await call("update_initiative", { initiative: "legacy", expectedRevision: null, operations: [{ op: "create", slug: "legacy", title: "Legacy", requirements: ["export.md§1"] }] });
  assert.equal(created.value?.code, "item_emerging", "the record cannot be created while emerging");
  const claim = await call("update_initiative", { initiative: "export", expectedRevision: null, operations: [{ op: "create", slug: "export", title: "Export", requirements: ["export.md§1"] }, { op: "claim", slug: "export" }] });
  assert.equal(claim.value?.code ?? null, null, "export is ready without a shaping record");
  await itemDone(call, "export", [{ op: "add_input", ...INPUT }]);
  const current = await call("get_initiative", { initiative: "export" });
  const released = await call("update_initiative", { initiative: "export", expectedRevision: current.value.revision, operations: [{ op: "release_claim", slug: "export" }] });
  assert.equal(released.value?.code ?? null, null, released.text);
  const again = await call("get_initiative", { initiative: "export" });
  const refused = await call("update_initiative", { initiative: "export", expectedRevision: again.value.revision, operations: [{ op: "claim", slug: "export" }] });
  assert.equal(refused.value?.code, "item_emerging", "a shaping record without a ready mark makes the item emerging again");
});

test("§28: a design whose slice.md links a Draft ADR is refused, naming each Draft ADR", async (context) => {
  const { root, call } = await itemProject(context, { browser: false });
  const created = await call("update_initiative", { initiative: "export", expectedRevision: null, operations: [{ op: "create", slug: "export", title: "Export", requirements: ["export.md§1"] }, { op: "claim", slug: "export" }] });
  assert.equal(created.value?.code ?? null, null, created.text);
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "test/export.test.mjs"), "import test from \"node:test\";\ntest(\"exports\", () => {});\n");
  const contract = (link) => `# Export\n\n## Contract\n\n1. Exports follow [the choice](${link}).\n\n## Changes\n\n- change \`src/export.mjs\`: export (§1)\n`;
  const written = await storeWrite(call, "docs/plans/export/slice.md", contract("../../ADRs/sync/change-delivery.md"));
  const propose = async () => {
    const current = await call("get_initiative", { initiative: "export" });
    return call("update_initiative", { initiative: "export", expectedRevision: current.value.revision, operations: [{ op: "propose_design", slug: "export", operations: [{ op: "accept_design", slug: "export", frozenTests: ["test/export.test.mjs"], review: "none", component: "api" }] }] });
  };
  const refused = await propose();
  assert.equal(refused.value?.code, "adr_draft", refused.text);
  assert.deepEqual(refused.value.adrs.map((adr) => [adr.path, adr.scope?.label]), [[DRAFT_ADR, "api"]]);
  const adr = await storeRead(call, DRAFT_ADR);
  const decided = await call("update_artifact", { operations: [{ op: "decide", path: DRAFT_ADR, expectedVersion: adr.version, option: "Poll the server", rationale: "Simple.", consequences: "Lag.", mechanism: "Polling." }] });
  assert.equal(decided.value?.code ?? null, null, decided.text);
  assert.ok(written.version, "the contract stays as written, now linking a Proposed ADR");
  const accepted = await propose();
  assert.equal(accepted.value?.code ?? null, null, accepted.text);
});
