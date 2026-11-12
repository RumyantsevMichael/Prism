import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { addEntries, mcp, project, recordFile, ship, writeClaim } from "./fixtures/shipped-work.mjs";

// get_roadmap reports open work for an initiative whose ship refuses with open_work, also when its initiative record is missing or invalid.
async function projectWithEntry(context) {
  const root = await project(context);
  const call = await mcp(context, root);
  const added = await addEntries(call, [{ id: "reports" }]);
  assert.equal(added.error, null, added.error?.message);
  return { root, call };
}

const openWorkOf = async (call) => (await call("get_roadmap")).value.derived.find((item) => item.id === "reports");

test("an initiative without a record reports and refuses open work", async (context) => {
  const { root, call } = await projectWithEntry(context);
  await writeClaim(root, "reports", "audit");
  const derived = await openWorkOf(call);
  assert.equal(derived.readyToShip, false);
  const diagnostic = derived.diagnostics.find((item) => item.code === "open_work");
  assert.ok(diagnostic, "an open_work diagnostic explains it");
  assert.deepEqual(diagnostic.claims.map((claim) => claim.slice), ["audit"]);
  assert.deepEqual(diagnostic.gates, []);
  assert.deepEqual(diagnostic.proposals, []);
  assert.equal((await ship(call, "reports")).value?.code, "open_work");
});

test("an initiative with an invalid record reports its pending proposals as open work", async (context) => {
  const { root, call } = await projectWithEntry(context);
  await mkdir(path.dirname(recordFile(root, "reports")), { recursive: true });
  await writeFile(recordFile(root, "reports"), `${JSON.stringify({ schemaVersion: 1, id: "reports", slices: {}, history: [], proposals: { audit: { operations: [], proposedAt: "2026-11-08T10:00:00.000Z" } } })}\n`);
  const derived = await openWorkOf(call);
  assert.equal(derived.readyToShip, false);
  const diagnostic = derived.diagnostics.find((item) => item.code === "open_work");
  assert.ok(diagnostic, "an open_work diagnostic explains it");
  assert.deepEqual(diagnostic.proposals, ["audit"]);
  assert.equal((await ship(call, "reports")).value?.code, "open_work");
});
