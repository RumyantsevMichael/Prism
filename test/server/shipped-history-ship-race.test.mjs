import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withRecordLock } from "../../dist/server/workflow/record-store.mjs";
import { finishedProject, ship } from "./fixtures/shipped-work.mjs";

// A writer that holds an initiative's state lock when ship starts finishes first, so ship reads the gate it added as open work instead of shipping past it.
test("a pending gate written under the state lock while ship waits is open work that refuses the ship", async (context) => {
  const { root, call } = await finishedProject(context);
  const stateFile = path.join(root, ".prism/initiatives/reports/state.json");
  const state = await call("get_coordination_state", { initiative: "reports" });
  const asked = await call("update_coordination_state", { initiative: "reports", expectedRevision: state.value?.revision ?? null, changes: { gateOperations: [{ op: "ask", kind: "visual-review", slice: "download", question: "Does the export look right?" }] } });
  assert.equal(asked.error, null, asked.error?.message);
  const gated = await readFile(stateFile);
  await rm(stateFile);
  let shipping;
  // The test holds the lock a coordination state writer holds, starts the ship, and writes the gate only after ship had time to read open work.
  await withRecordLock(root, { kind: "state", initiative: "reports" }, async () => {
    shipping = ship(call, "reports");
    await new Promise((resolve) => setTimeout(resolve, 750));
    await writeFile(stateFile, gated);
  });
  const shipped = await shipping;
  assert.equal(shipped.value?.code, "open_work", "ship must wait for the writer and see its gate");
  assert.equal(shipped.value.gates.length, 1);
  const decision = (await call("get_roadmap")).value.record.initiatives.find((item) => item.id === "reports").decision;
  assert.equal(decision, null, "nothing was recorded");
});
