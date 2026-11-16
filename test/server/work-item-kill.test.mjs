import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DRAFT_ADR, DRAFT_REQUIREMENT, INPUT, addEntries, answer, answeredRound, askRound, derivedEntry, draftAdr, gateOf, itemDone, itemProject, itemUpdate, question, roadmapUpdate, storeRead, storeWrite, tryAnswer, workItem } from "./fixtures/work-items.mjs";

// A person kills an emerging work item after seeing every use of its requirement files and ADRs, and decides each artifact's fate.

const LINKED_ADR = "docs/ADRs/sync/link-check.md";

// sync cites the Draft sync.md and the Draft change-delivery.md; nothing else uses either.
async function killable(context, { files = {} } = {}) {
  const project = await itemProject(context, { files });
  const { call, review } = project;
  await answeredRound(call, review, "sync");
  await itemDone(call, "sync", [{ op: "add_input", ...INPUT }, { op: "cite", requirements: ["sync.md§1"], adrs: [DRAFT_ADR] }]);
  return project;
}

const choices = (requirement = "withdraw", adr = "decline") => [{ path: DRAFT_REQUIREMENT, choice: requirement }, { path: DRAFT_ADR, choice: adr }];
const proposeKill = (call, artifacts = choices()) => itemUpdate(call, "sync", [{ op: "propose_kill", reason: "Clients reload often enough.", artifacts }]);

// The kill gate and each artifact's gate, from the recorded proposal.
async function gates(call) {
  const proposal = (await workItem(call, "sync")).proposal;
  return { kill: proposal.gate, ...Object.fromEntries(proposal.artifacts.map((entry) => [entry.path, entry.gate])) };
}

test("§44: a kill takes exactly one choice per cited artifact, and only choices that fit its kind", async (context) => {
  const { call } = await killable(context);
  const missing = await proposeKill(call, [{ path: DRAFT_REQUIREMENT, choice: "keep" }]);
  assert.equal(missing.value?.code, "kill_incomplete", missing.text);
  const extra = await proposeKill(call, [...choices(), { path: "docs/requirements/export.md", choice: "keep" }]);
  assert.equal(extra.value?.code, "kill_incomplete", extra.text);
  const wrong = await proposeKill(call, choices("decline", "decline"));
  assert.equal(wrong.value?.code, "validation_failed", "a requirement file is withdrawn, not declined");
  const wrongAdr = await proposeKill(call, choices("withdraw", "withdraw"));
  assert.equal(wrongAdr.value?.code, "validation_failed", "an ADR is declined, not withdrawn");
  const mixed = await itemUpdate(call, "sync", [{ op: "propose_kill", reason: "r", artifacts: choices() }, { op: "add_input", ...INPUT }]);
  assert.equal(mixed.value?.code, "validation_failed", "propose_kill stands alone");
});

test("§44: a kill is refused for an item that is not emerging or whose design started, and open questions do not stop it", async (context) => {
  const { call } = await killable(context);
  const ready = await itemUpdate(call, "export", [{ op: "propose_kill", reason: "r", artifacts: [{ path: "docs/requirements/export.md", choice: "keep" }] }]);
  assert.equal(ready.value?.code, "not_emerging", ready.text);
  await askRound(call, "sync", [question("Still needed?")]);
  const proposed = await proposeKill(call);
  assert.equal(proposed.value?.code ?? null, null, proposed.text);
});

test("§45: a kill proposal lists every use of each cited artifact by other items, designs, feature files, requirements, and ADRs", async (context) => {
  const feature = `Feature: Sync\n\n  Rule: Sync changes\n    # Requirement: [Sync](../requirements/sync.md#1)\n\n    Example: A change syncs\n      Given a change\n      When a client connects\n      Then it sees the change\n`;
  const { root, call, review } = await killable(context);
  await mkdir(path.join(root, "docs/Features"), { recursive: true });
  await writeFile(path.join(root, "docs/Features/sync.feature"), feature);
  await storeWrite(call, "docs/requirements/mobile.md", (await storeRead(call, "docs/requirements/export.md")).content.replace("Related: n/a", "Related: [sync.md§1](sync.md#1)").replace("Status: Approved", "Status: Draft").replace("Approved: 2026-11-10", "Approved: n/a"));
  await storeWrite(call, LINKED_ADR, draftAdr("Check links").replace("## Requirements\n\nn/a", "## Requirements\n\n- [sync.md§1](../../requirements/sync.md#1)"));
  await addEntries(call, [{ id: "mobile", title: "Mobile sync", intent: "Phones sync.", band: "Later" }]);
  await answeredRound(call, review, "mobile");
  await itemDone(call, "mobile", [{ op: "cite", requirements: ["sync.md§1"] }]);
  await addEntries(call, [{ id: "billing", title: "Billing", intent: "Bills.", band: "Later", requirements: ["export.md§1"] }]);
  const created = await call("update_initiative", { initiative: "billing", expectedRevision: null, operations: [{ op: "create", slug: "billing", title: "Billing", requirements: ["export.md§1"] }] });
  assert.equal(created.value?.code ?? null, null, created.text);
  await storeWrite(call, "docs/plans/billing/slice.md", "# Billing\n\n## Contract\n\n1. Billing follows [the delivery choice](../../ADRs/sync/change-delivery.md).\n");
  const proposed = await proposeKill(call, choices("keep", "keep"));
  assert.equal(proposed.value?.code ?? null, null, proposed.text);
  const uses = Object.fromEntries(proposed.value.uses.map((entry) => [entry.path, entry.uses]));
  const sorted = (list) => list.map((use) => JSON.stringify([use.kind, use.item ?? use.path ?? `${use.initiative}/${use.slice}`])).sort();
  assert.deepEqual(sorted(uses[DRAFT_REQUIREMENT]), sorted([
    { kind: "work-item", item: "mobile" },
    { kind: "feature", path: "docs/Features/sync.feature" },
    { kind: "requirement", path: "docs/requirements/mobile.md" },
    { kind: "adr", path: LINKED_ADR }
  ]));
  assert.deepEqual(sorted(uses[DRAFT_ADR]), sorted([{ kind: "design", path: "docs/plans/billing/slice.md" }]));
  const requirementUse = uses[DRAFT_REQUIREMENT].find((use) => use.kind === "requirement");
  assert.equal(requirementUse.scope?.label, "api");
});

test("§45: a design use names the initiative slice whose requirements name the file", async (context) => {
  const { call, review } = await killable(context);
  await addEntries(call, [{ id: "mobile", title: "Mobile sync", intent: "Phones sync.", band: "Later", requirements: ["export.md§1"] }]);
  const created = await call("update_initiative", { initiative: "mobile", expectedRevision: null, operations: [{ op: "create", slug: "mobile", title: "Mobile", requirements: ["export.md§1"] }] });
  assert.equal(created.value?.code ?? null, null, created.text);
  await answeredRound(call, review, "sync");
  await itemDone(call, "sync", [{ op: "cite", requirements: ["export.md§1"] }]);
  const proposed = await proposeKill(call, [...choices("keep", "keep"), { path: "docs/requirements/export.md", choice: "keep" }]);
  const uses = proposed.value.uses.find((entry) => entry.path === "docs/requirements/export.md").uses;
  assert.ok(uses.some((use) => use.kind === "design" && use.initiative === "mobile" && use.slice === "mobile"), JSON.stringify(uses));
  assert.ok(uses.some((use) => use.kind === "work-item" && use.item === "export"), JSON.stringify(uses));
});

test("§46: a kill proposal opens a kill gate and one gate per artifact recommending the proposed choice", async (context) => {
  const { call } = await killable(context);
  const proposed = await proposeKill(call, choices("withdraw", "keep"));
  assert.equal(proposed.value?.code ?? null, null, proposed.text);
  assert.deepEqual(proposed.value.openedGates.map((gate) => gate.purpose).sort(), ["artifact", "artifact", "kill"]);
  const ids = await gates(call);
  const kill = await gateOf(call, "sync", ids.kill);
  assert.deepEqual(kill.options.map((option) => option.id), ["kill", "keep"]);
  assert.equal(kill.recommended.option, "kill");
  assert.match(kill.context, /Clients reload often enough\./);
  const requirement = await gateOf(call, "sync", ids[DRAFT_REQUIREMENT]);
  assert.deepEqual(requirement.options.map((option) => option.id), ["keep", "withdraw"]);
  assert.equal(requirement.recommended.option, "withdraw");
  assert.match(requirement.question, /sync\.md/);
  const adr = await gateOf(call, "sync", ids[DRAFT_ADR]);
  assert.deepEqual(adr.options.map((option) => option.id), ["keep", "decline"]);
  assert.equal(adr.recommended.option, "keep");
  const proposal = (await workItem(call, "sync")).proposal;
  assert.equal(proposal.kind, "kill");
  assert.deepEqual(proposal.artifacts.map((entry) => [entry.path, entry.choice, entry.scope?.label]), [[DRAFT_REQUIREMENT, "withdraw", "api"], [DRAFT_ADR, "keep", "api"]]);
});

test("§47: withdrawing an artifact that something else uses is refused with each use, and a use by an artifact this kill declines does not count", async (context) => {
  const { call, review } = await killable(context);
  await storeWrite(call, LINKED_ADR, draftAdr("Check links").replace("## Requirements\n\nn/a", "## Requirements\n\n- [sync.md§1](../../requirements/sync.md#1)"));
  await itemDone(call, "sync", [{ op: "cite", adrs: [LINKED_ADR] }]);
  await addEntries(call, [{ id: "mobile", title: "Mobile sync", intent: "Phones sync.", band: "Later" }]);
  await answeredRound(call, review, "mobile");
  await itemDone(call, "mobile", [{ op: "cite", adrs: [DRAFT_ADR] }]);
  const proposed = await itemUpdate(call, "sync", [{ op: "propose_kill", reason: "Not needed.", artifacts: [...choices(), { path: LINKED_ADR, choice: "decline" }] }]);
  assert.equal(proposed.value?.code ?? null, null, proposed.text);
  const ids = await gates(call);
  const inUse = await tryAnswer(review, "sync", ids[DRAFT_ADR], "decline");
  assert.notEqual(inUse.status, 200);
  assert.equal(inUse.body.code, "artifact_in_use", JSON.stringify(inUse.body));
  assert.match(inUse.body.message, /mobile/);
  assert.equal((await gateOf(call, "sync", ids[DRAFT_ADR])).answer, undefined, "the refused answer recorded nothing");
  const early = await tryAnswer(review, "sync", ids[DRAFT_REQUIREMENT], "withdraw");
  assert.equal(early.body.code, "artifact_in_use", "the linking ADR's gate is not answered yet");
  assert.match(early.body.message, /link-check\.md/);
  await answer(review, "sync", ids[LINKED_ADR], "decline");
  await answer(review, "sync", ids[DRAFT_REQUIREMENT], "withdraw");
  await answer(review, "sync", ids[DRAFT_ADR], "keep");
});

test("§48: the kill answer waits for every artifact's answer and the person's reason", async (context) => {
  const { call, review } = await killable(context);
  await proposeKill(call);
  const ids = await gates(call);
  const early = await tryAnswer(review, "sync", ids.kill, "kill", "Clients reload often enough.");
  assert.equal(early.body.code, "dispositions_unanswered", JSON.stringify(early.body));
  await answer(review, "sync", ids[DRAFT_REQUIREMENT], "withdraw");
  await answer(review, "sync", ids[DRAFT_ADR], "decline");
  const noReason = await tryAnswer(review, "sync", ids.kill, "kill");
  assert.equal(noReason.body.code, "reason_required", JSON.stringify(noReason.body));
  await addEntries(call, [{ id: "mobile", title: "Mobile sync", intent: "Phones sync.", band: "Later" }]);
  await answeredRound(call, review, "mobile");
  await itemDone(call, "mobile", [{ op: "cite", requirements: ["sync.md§1"] }]);
  const gained = await tryAnswer(review, "sync", ids.kill, "kill", "Clients reload often enough.");
  assert.equal(gained.body.code, "artifact_in_use", "sync.md gained a use after its answer");
  assert.equal((await workItem(call, "sync")).stage, "emerging");
});

test("§49: a confirmed kill withdraws and declines the chosen artifacts, keeps the rest, and records the person's reason", async (context) => {
  const { call, review } = await killable(context);
  await askRound(call, "sync", [question("Still needed?")]);
  await proposeKill(call, choices("withdraw", "keep"));
  const ids = await gates(call);
  await answer(review, "sync", ids[DRAFT_REQUIREMENT], "withdraw");
  await answer(review, "sync", ids[DRAFT_ADR], "keep");
  const adrBefore = await storeRead(call, DRAFT_ADR);
  await answer(review, "sync", ids.kill, "kill", "Reloading is enough for now.");
  const requirement = await storeRead(call, DRAFT_REQUIREMENT);
  assert.equal(requirement.status, "Withdrawn");
  assert.match(requirement.content, /^Status: Withdrawn$/m);
  const adr = await storeRead(call, DRAFT_ADR);
  assert.deepEqual([adr.status, adr.version], ["Draft", adrBefore.version], "a kept artifact is unchanged");
  const value = await workItem(call, "sync");
  assert.equal(value.stage, "killed");
  assert.equal(value.record.kill.reason, "Reloading is enough for now.");
  assert.equal(value.record.kill.gate, ids.kill);
  assert.equal(value.record.kill.by?.name, "Ada Reviewer");
  assert.deepEqual(value.record.kill.artifacts.map((entry) => [entry.path, entry.choice]), [[DRAFT_REQUIREMENT, "withdraw"], [DRAFT_ADR, "keep"]]);
  const entry = (await call("get_roadmap", {})).value.record.initiatives.find((item) => item.id === "sync");
  assert.deepEqual([entry.decision.kind, entry.decision.reason, entry.decision.gate], ["killed", "Reloading is enough for now.", ids.kill]);
  const pending = (await call("get_coordination_state", { initiative: "sync" })).value.state.pending ?? [];
  assert.ok(!pending.some((gate) => gate.question === "Still needed?" && gate.answer === undefined), "the open question's gate closed");
});

test("§49: a declined ADR is Declined, and keep closes the proposal without changing anything", async (context) => {
  const { call, review } = await killable(context);
  await proposeKill(call, choices("keep", "decline"));
  let ids = await gates(call);
  await answer(review, "sync", ids[DRAFT_REQUIREMENT], "keep");
  await answer(review, "sync", ids[DRAFT_ADR], "decline");
  await answer(review, "sync", ids.kill, "keep", "Keep it for now.");
  assert.deepEqual([(await workItem(call, "sync")).stage, (await storeRead(call, DRAFT_ADR)).status], ["emerging", "Draft"]);
  assert.match(JSON.stringify((await workItem(call, "sync")).record), /"outcome":"keep"/);
  await proposeKill(call, choices("keep", "decline"));
  ids = await gates(call);
  await answer(review, "sync", ids[DRAFT_REQUIREMENT], "keep");
  await answer(review, "sync", ids[DRAFT_ADR], "decline");
  await answer(review, "sync", ids.kill, "kill", "Dropped.");
  const adr = await storeRead(call, DRAFT_ADR);
  assert.equal(adr.status, "Declined");
  assert.match(adr.content, /^Status: Declined$/m);
  assert.equal((await storeRead(call, DRAFT_REQUIREMENT)).status, "Draft");
});

test("§16, §50: a killed item leaves every band and stays in the roadmap's history with its reason", async (context) => {
  const { call, review } = await killable(context);
  await proposeKill(call, choices("keep", "keep"));
  const ids = await gates(call);
  await answer(review, "sync", ids[DRAFT_REQUIREMENT], "keep");
  await answer(review, "sync", ids[DRAFT_ADR], "keep");
  await answer(review, "sync", ids.kill, "kill", "Reloading is enough.");
  const derived = await derivedEntry(call, "sync");
  assert.deepEqual([derived.band, derived.state, derived.workItem.stage], [null, "killed", "killed"]);
  for (const operation of [{ op: "place", id: "sync", band: "Now" }, { op: "update_initiative", id: "sync", title: "Back" }]) {
    assert.notEqual((await roadmapUpdate(call, [operation])).value?.code ?? null, null, operation.op);
  }
  const closed = await itemUpdate(call, "sync", [{ op: "add_input", ...INPUT }]);
  assert.equal(closed.value?.code, "item_closed", closed.text);
  const view = (await call("get_artifact", { path: "docs/roadmap.md" })).value.content;
  assert.match(view, /^## Killed context$/m);
  assert.match(view, /Sync changes[^\n]*Reloading is enough\./);
  assert.doesNotMatch(view.split(/^## Sequencing rationale$/m)[0], /\*\*Sync changes\*\*/);
});
