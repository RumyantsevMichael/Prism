import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { checkout, isolateGit, ok, refused, server, workspace } from "./fixtures/workspace-artifacts.mjs";

// A migration from a legacy roadmap records initiatives that shipped before Prism kept records as shipped, without the ship gate they could never pass.

const environment = await isolateGit();
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-legacy-ship-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getRoadmap, updateRoadmap } = await import("../../dist/server/workflow/roadmap.mjs");
const { updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
test.after(async () => {
  await rm(privateData, { recursive: true, force: true });
  await rm(environment, { recursive: true, force: true });
});

const LEGACY_PLAN = "# Billing\n\nTrack 1 shipped in the spring.\n";
const add = (id, band = "Now") => ({ op: "add_initiative", id, title: `Title ${id}`, intent: `Intent ${id}.`, band });

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-legacy-ship-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Roadmap: docs/roadmap.md\n- Plans (scratch): docs/plans/\n");
  await mkdir(path.join(root, "docs/plans/billing"), { recursive: true });
  await writeFile(path.join(root, "docs/plans/billing/slice.md"), LEGACY_PLAN);
  return root;
}

test("a migration records legacy shipped initiatives as shipped without the ship gate", async (context) => {
  const projectRoot = await project(context);
  const migrated = await updateRoadmap({ projectRoot, expectedRevision: null, actor: "setup", operations: [
    add("billing"), add("search"), add("reports", "Next"),
    { op: "record_legacy_ship", id: "billing" },
    { op: "supersede", id: "search", by: "billing", reason: "Billing search covers it." },
    { op: "replace_hand_written_projection" }
  ] });
  assert.deepEqual(migrated.legacyShips, ["billing"]);
  const decision = migrated.record.initiatives.find((item) => item.id === "billing").decision;
  assert.equal(decision.kind, "shipped");
  assert.equal(decision.legacy, true);
  assert.equal(decision.actor, "setup");
  assert.deepEqual(decision.slices, {});
  assert.deepEqual(decision.documents, []);
  assert.equal(decision.gate, undefined);
  assert.deepEqual(migrated.derived.map((item) => [item.id, item.state]), [["billing", "shipped"], ["search", "superseded"], ["reports", "envisioned"]]);
  assert.match(await readFile(path.join(projectRoot, "docs/roadmap.md"), "utf8"), /^- \*\*Title billing\*\* \(`billing`\): Intent billing\. Shipped before Prism, recorded \d{4}-\d{2}-\d{2}\.$/m);
  // The legacy plan document stays as it was, at the migration and at a later read.
  await getRoadmap({ projectRoot });
  assert.equal(await readFile(path.join(projectRoot, "docs/plans/billing/slice.md"), "utf8"), LEGACY_PLAN);
  // Once the record exists, every ship goes through the gate, so a later call cannot record legacy history.
  const later = await updateRoadmap({ projectRoot, expectedRevision: migrated.revision, operations: [add("audit")] });
  await assert.rejects(updateRoadmap({ projectRoot, expectedRevision: later.revision, operations: [{ op: "record_legacy_ship", id: "audit" }] }), (error) => error.code === "validation_failed" && /creates the roadmap record/.test(error.message));
  await assert.rejects(updateRoadmap({ projectRoot, expectedRevision: later.revision, operations: [{ op: "ship", id: "audit" }] }), (error) => error.code === "gate_blocked");
});

test("a migration refuses legacy history for an initiative with Prism records or a decision", async (context) => {
  const projectRoot = await project(context);
  await updateInitiative({ projectRoot, initiative: "billing", expectedRevision: null, operations: [{ op: "create", slug: "billing", title: "Billing", requirements: ["r.md#1"] }] });
  await assert.rejects(updateRoadmap({ projectRoot, expectedRevision: null, operations: [add("billing"), { op: "record_legacy_ship", id: "billing" }] }), (error) => error.code === "validation_failed" && /initiative record/.test(error.message));
  await assert.rejects(updateRoadmap({ projectRoot, expectedRevision: null, operations: [add("search"), add("audit"), { op: "supersede", id: "search", by: "audit", reason: "Covered." }, { op: "record_legacy_ship", id: "search" }] }), (error) => error.code === "validation_failed" && /already has a superseded decision/.test(error.message));
  assert.equal((await getRoadmap({ projectRoot })).revision, null, "a refused migration writes no record");
});

test("with a record store, a migration records legacy shipped initiatives without a correctness gate", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const migrated = ok(await prism.call("update_roadmap", { expectedRevision: null, actor: "setup", operations: [add("billing"), add("reports"), { op: "record_legacy_ship", id: "billing" }] }));
  assert.deepEqual(migrated.legacyShips, ["billing"]);
  assert.equal(migrated.derived.find((item) => item.id === "billing").state, "shipped");
  assert.equal(migrated.record.initiatives.find((item) => item.id === "billing").decision.legacy, true);
  ok(await createInitiative(prism, "reports"));
  const roadmap = ok(await prism.call("get_roadmap", {}));
  refused(await prism.call("update_roadmap", { expectedRevision: roadmap.revision, operations: [{ op: "record_legacy_ship", id: "reports" }] }), "validation_failed");
});
