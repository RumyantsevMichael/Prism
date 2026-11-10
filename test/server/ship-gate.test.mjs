import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addEntries, finished, finishedProject, roadmapOperation, ship, shippedProject, slice, writeClaim, writeInitiative } from "./fixtures/shipped-work.mjs";

// Ship refuses while work is open, get_roadmap says why an initiative is not ready, and a shipped roadmap entry keeps its content.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-ship-gate-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { answerUserGate } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

async function ask(call, initiative, question, sliceSlug = "audit") {
  const state = await call("get_coordination_state", { initiative });
  const asked = await call("update_coordination_state", { initiative, expectedRevision: state.value?.revision ?? null, changes: { gateOperations: [{ op: "ask", kind: "visual-review", slice: sliceSlug, question }] } });
  assert.equal(asked.error, null, asked.error?.message);
  return asked.value.state.pending.find((gate) => gate.question === question).id;
}

const decisionOf = async (call, id) => (await call("get_roadmap")).value.record.initiatives.find((item) => item.id === id).decision;

test("§1 ship checks an existing decision first and open work before unfinished leaves", async (context) => {
  const { root, call } = await finishedProject(context);
  await writeInitiative(root, "reports", { ...finished(), audit: slice("Audit downloads", "in-progress", "root", ["docs/requirements/reports.md#2"]) });
  await writeClaim(root, "reports", "audit");
  const refused = await ship(call, "reports");
  assert.equal(refused.value?.code, "open_work", "open work is named before the unfinished leaf");
  await writeInitiative(root, "reports", finished());
  await rm(path.join(root, ".prism/initiatives/reports/claims"), { recursive: true, force: true });
  assert.equal((await ship(call, "reports")).error, null);
  const again = await ship(call, "reports");
  assert.equal(again.value?.code, "validation_failed", "an existing decision is refused as before");
  assert.match(again.error.message, /already has a shipped decision/);
});

test("§2 ship refuses an unanswered or answered pending gate and names each one", async (context) => {
  const { root, call } = await finishedProject(context);
  const open = await ask(call, "reports", "Does the export look right?");
  const answered = await ask(call, "reports", "Is the audit wording clear?", "download");
  await answerUserGate({ projectRoot: root, initiative: "reports", id: answered, choice: "approve" });
  const refused = await ship(call, "reports");
  assert.equal(refused.value?.code, "open_work");
  assert.deepEqual(refused.value.gates, [
    { id: open, slice: "audit", question: "Does the export look right?", answered: false },
    { id: answered, slice: "download", question: "Is the audit wording clear?", answered: true }
  ]);
  assert.deepEqual(refused.value.claims, []);
  assert.deepEqual(refused.value.proposals, []);
  assert.match(refused.error.message, new RegExp(open));
  assert.match(refused.error.message, new RegExp(answered));
  assert.equal(await decisionOf(call, "reports"), null, "nothing was recorded");
});

test("§2 ship refuses a live claim and a pending design proposal and names each one", async (context) => {
  const { root, call } = await finishedProject(context);
  await writeClaim(root, "reports", "download", "design");
  await writeInitiative(root, "reports", finished(), { proposals: { audit: { operations: [{ op: "update_slice", slug: "audit", title: "Audit every download" }], proposedAt: "2026-11-08T10:00:00.000Z" } } });
  const refused = await ship(call, "reports");
  assert.equal(refused.value?.code, "open_work");
  assert.deepEqual(refused.value.gates, []);
  assert.equal(refused.value.claims.length, 1);
  assert.deepEqual({ ...refused.value.claims[0], expiresAt: typeof refused.value.claims[0].expiresAt }, { slice: "download", label: "main on other-host", activity: "design", expiresAt: "string" });
  assert.deepEqual(refused.value.proposals, ["audit"]);
  assert.match(refused.error.message, /download/);
  assert.match(refused.error.message, /audit/);
  assert.equal(await decisionOf(call, "reports"), null);
});

test("§3 get_roadmap reports an initiative with open work as not ready to ship and says why", async (context) => {
  const { root, call } = await finishedProject(context);
  const before = (await call("get_roadmap")).value.derived.find((item) => item.id === "reports");
  assert.equal(before.readyToShip, true);
  await writeClaim(root, "reports", "audit");
  const after = (await call("get_roadmap")).value.derived.find((item) => item.id === "reports");
  assert.equal(after.readyToShip, false);
  const diagnostic = after.diagnostics.find((item) => item.code === "open_work");
  assert.ok(diagnostic, "an open_work diagnostic explains it");
  assert.deepEqual(diagnostic.claims.map((claim) => claim.slice), ["audit"]);
  assert.deepEqual(diagnostic.gates, []);
  assert.deepEqual(diagnostic.proposals, []);
});

test("§4 a shipped roadmap entry refuses update_initiative and set_requires and keeps its content", async (context) => {
  const { call, shippedAt } = await shippedProject(context);
  await addEntries(call, [{ id: "later" }]);
  const before = await call("get_roadmap");
  for (const operation of [
    { op: "update_initiative", id: "reports", title: "Renamed" },
    { op: "update_initiative", id: "reports", intent: "Another intent." },
    { op: "update_initiative", id: "reports", requirements: ["docs/requirements/reports.md#2"] },
    { op: "set_requires", id: "reports", requires: ["later"] }
  ]) {
    const refused = await roadmapOperation(call, operation);
    assert.equal(refused.value?.code, "initiative_shipped", JSON.stringify(operation));
    assert.equal(refused.value.initiative, "reports");
    assert.equal(refused.value.shippedAt, shippedAt);
    assert.match(refused.error.message, /new initiative that references it/);
  }
  const after = await call("get_roadmap");
  assert.equal(after.value.revision, before.value.revision, "no record changed");
  assert.match((await roadmapOperation(call, { op: "place", id: "reports", band: "Next" })).error.message, /keeps its place in history/);
  assert.equal((await roadmapOperation(call, { op: "set_requires", id: "later", requires: ["reports"] })).error, null, "another entry may still require it");
});
