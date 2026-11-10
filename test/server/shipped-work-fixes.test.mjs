import assert from "node:assert/strict";
import test from "node:test";
import { addEntries, earlierShippedProject, finished, readText, roadmapOperation, shippedProject } from "./fixtures/shipped-work.mjs";

// A fix to shipped work is a new initiative that names what it corrects, and readers of the shipped initiative see it.
const entryOf = async (call, id) => (await call("get_roadmap")).value.record.initiatives.find((item) => item.id === id);

test("§29 a new initiative records the shipped initiative and slices it corrects and shows them in the roadmap Markdown", async (context) => {
  const { root, call } = await shippedProject(context);
  const added = await addEntries(call, [{ id: "reports-fix", corrects: { initiative: "reports", slices: ["download", "audit"] } }]);
  assert.equal(added.error, null, added.error?.message);
  assert.deepEqual((await entryOf(call, "reports-fix")).corrects, { initiative: "reports", slices: ["download", "audit"] });
  assert.match(await readText(root, "docs/roadmap.md"), /Corrects `reports`: `download`, `audit`\./);
  await addEntries(call, [{ id: "plain" }]);
  const updated = await roadmapOperation(call, { op: "update_initiative", id: "plain", corrects: { initiative: "reports", slices: ["audit"] } });
  assert.equal(updated.error, null, updated.error?.message);
  assert.deepEqual((await entryOf(call, "plain")).corrects, { initiative: "reports", slices: ["audit"] });
});

test("§29 corrects refuses unshipped, unknown, and own initiatives, and slices the shipped record does not hold", async (context) => {
  const { call } = await shippedProject(context);
  await addEntries(call, [{ id: "running" }]);
  const unshipped = await addEntries(call, [{ id: "fix-running", corrects: { initiative: "running", slices: ["root"] } }]);
  assert.equal(unshipped.value?.code, "validation_failed");
  assert.match(unshipped.error.message, /report_defect/);
  for (const corrects of [{ initiative: "missing", slices: ["download"] }, { initiative: "reports", slices: [] }, { initiative: "reports", slices: ["export"] }]) {
    assert.equal((await addEntries(call, [{ id: "fix-other", corrects }])).value?.code, "validation_failed", JSON.stringify(corrects));
  }
  const own = await roadmapOperation(call, { op: "update_initiative", id: "running", corrects: { initiative: "running", slices: ["root"] } });
  assert.equal(own.value?.code, "validation_failed");
  assert.equal((await entryOf(call, "fix-other")) ?? null, null, "nothing was added");
});

test("§29 corrects refuses every slice of a shipped initiative whose record is gone", async (context) => {
  const { call } = await earlierShippedProject(context, "reports", finished(), { record: false, documents: false });
  assert.equal((await addEntries(call, [{ id: "reports-fix", corrects: { initiative: "reports", slices: ["download"] } }])).value?.code, "validation_failed");
});

test("§30 shipped history lists the later initiatives that correct it with their state", async (context) => {
  const { call } = await shippedProject(context);
  assert.deepEqual((await call("get_initiative", { initiative: "reports" })).value.shippedHistory.laterFixes, []);
  await addEntries(call, [{ id: "reports-fix", corrects: { initiative: "reports", slices: ["download"] } }, { id: "unrelated" }, { id: "reports-fix-2", corrects: { initiative: "reports", slices: ["audit"] } }]);
  const expected = [
    { initiative: "reports-fix", title: "Title reports-fix", state: "envisioned", slices: ["download"] },
    { initiative: "reports-fix-2", title: "Title reports-fix-2", state: "envisioned", slices: ["audit"] }
  ];
  assert.deepEqual((await call("get_initiative", { initiative: "reports" })).value.shippedHistory.laterFixes, expected);
  assert.deepEqual((await call("get_coordination_state", { initiative: "reports" })).value.shippedHistory.laterFixes, expected);
  assert.deepEqual((await call("get_review", { initiative: "reports", slice: "download" })).value.shippedHistory.laterFixes, expected);
});
