import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { addEntries, earlierShippedProject, recordFile, roadmapOperation, shippedProject, writeInitiative, finished } from "./fixtures/shipped-work.mjs";

// Every Prism tool refuses to change a shipped initiative's state, before its other checks, and keeps every record.
const exists = (file) => access(file).then(() => true, () => false);

// A shipped initiative's records and project files as bytes, so a refusal can be shown to change none of them.
async function snapshot(root) {
  const files = {};
  const walk = async (folder) => {
    for (const entry of await readdir(path.join(root, folder), { withFileTypes: true }).catch(() => [])) {
      const relative = path.posix.join(folder, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else files[relative] = await readFile(path.join(root, relative), "utf8");
    }
  };
  await walk(".prism");
  await walk("docs/plans");
  return files;
}

function assertShipped(outcome, shippedAt, label) {
  assert.ok(outcome.error, `${label} was refused`);
  assert.equal(outcome.value?.code, "initiative_shipped", `${label}: ${outcome.error?.message}`);
  assert.equal(outcome.value.initiative, "reports", label);
  assert.equal(outcome.value.shippedAt, shippedAt, label);
}

test("§13 update_initiative refuses every operation on a shipped initiative before its revision check", async (context) => {
  const { root, call, shippedAt } = await shippedProject(context);
  const current = await call("get_initiative", { initiative: "reports" });
  const before = await snapshot(root);
  for (const operation of [
    { op: "set_status", slug: "download", status: "in-progress" },
    { op: "update_slice", slug: "audit", title: "Audit every download" },
    { op: "claim", slug: "audit" },
    { op: "release_claim", slug: "audit" },
    { op: "restore_tests", slug: "root" },
    { op: "regenerate_markdown" },
    { op: "remove_records" }
  ]) {
    assertShipped(await call("update_initiative", { initiative: "reports", expectedRevision: current.value.revision, operations: [operation] }), shippedAt, operation.op);
  }
  assertShipped(await call("update_initiative", { initiative: "reports", expectedRevision: "stale-revision", operations: [{ op: "update_slice", slug: "audit", title: "Audit" }] }), shippedAt, "a stale revision");
  assert.deepEqual(await snapshot(root), before, "no record or project file changed");
  assert.equal(await exists(recordFile(root, "reports")), true, "remove_records kept the record");
});

test("§13 coordination state, pause checkpoints, reviews, verification, design views, and change maps refuse a shipped initiative", async (context) => {
  const { root, call, shippedAt } = await shippedProject(context);
  const before = await snapshot(root);
  const requests = [
    ["update_coordination_state", { initiative: "reports", expectedRevision: null, changes: { settings: { autonomy: "broad" } } }],
    ["checkpoint_pause", { initiative: "reports", expectedRevision: null, activeSlice: "audit", recoveryContent: "# Recovery\n\nResume the audit.\n", changes: { next: ["Resume the audit."] } }],
    ["update_review", { initiative: "reports", slice: "download", expectedRevision: null, actor: { id: "coordinator-1", role: "coordinator" }, operations: [{ op: "assign_delivery", worker: "worker-1" }] }],
    ["verify_slice", { initiative: "reports", slice: "download" }],
    ["verify_slice", { initiative: "reports", slice: "download", contractDefects: [{ clause: "1", reason: "The contract is wrong." }] }],
    ["verify_slice", { initiative: "reports", slice: "root", dependents: true }],
    ["update_design_view", { initiative: "reports", slice: "download", examples: [{ clause: 1, file: "test/report.test.mjs", test: "downloads", example: "A download returns the report." }] }],
    ["update_change_map", { initiative: "reports", slice: "download", expectedRevision: null, operations: [{ op: "remove", id: "unit-1" }] }]
  ];
  for (const [name, args] of requests) assertShipped(await call(name, args), shippedAt, name);
  assert.deepEqual(await snapshot(root), before, "no record, recovery note, or run was written");
  assert.equal(await exists(path.join(root, "docs/plans/reports/audit/recovery.md")), false);
});

test("§13 an initiative that shipped before shipped history is refused the same way", async (context) => {
  const { call, shippedAt } = await earlierShippedProject(context);
  const current = await call("get_initiative", { initiative: "reports" });
  assertShipped(await call("update_initiative", { initiative: "reports", expectedRevision: current.value.revision, operations: [{ op: "set_status", slug: "audit", status: "not-started" }] }), shippedAt, "set_status");
  assertShipped(await call("update_coordination_state", { initiative: "reports", expectedRevision: null, changes: { next: ["Nothing."] } }), shippedAt, "update_coordination_state");
});

test("§14 remove_records still removes the records of a superseded initiative", async (context) => {
  const { root, call } = await shippedProject(context);
  await addEntries(call, [{ id: "replaced" }, { id: "successor" }]);
  await writeInitiative(root, "replaced", finished());
  assert.equal((await roadmapOperation(call, { op: "supersede", id: "replaced", by: "successor", reason: "The successor covers it." })).error, null);
  const current = await call("get_initiative", { initiative: "replaced" });
  const removed = await call("update_initiative", { initiative: "replaced", expectedRevision: current.value.revision, operations: [{ op: "remove_records" }] });
  assert.equal(removed.error, null, removed.error?.message);
  assert.equal(await exists(recordFile(root, "replaced")), false);
});

test("§15 the refusal names the initiative, its ship time, and that new work belongs in a new initiative", async (context) => {
  const { call, shippedAt } = await shippedProject(context);
  const refused = await call("update_coordination_state", { initiative: "reports", expectedRevision: null, changes: { next: ["More work."] } });
  assert.equal(refused.error.message.split("\n")[0], `Initiative reports shipped at ${shippedAt}, so its state is history and this change was not applied; start new work as a new initiative that references it.`);
});
