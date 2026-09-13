import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCoordinationState, updateCoordinationState } from "../state.mjs";

async function stateFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-state-"));
  const statePath = "docs/plans/demo/state.json";
  await mkdir(path.join(root, path.dirname(statePath)), { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));
  return { projectRoot: root, statePath };
}

function active(slice, worker = `${slice}-worker`) {
  return [{ slice, activity: "design", workers: [worker], workspace: `/work/${slice}` }];
}

test("creates and updates a validated coordination state atomically", async (context) => {
  const fixture = await stateFixture(context);
  const initial = await readCoordinationState(fixture);
  assert.equal(initial.exists, false);
  assert.equal(initial.revision, null);

  const created = await updateCoordinationState({
    ...fixture,
    expectedRevision: null,
    changes: {
      settings: { autonomy: "full", agentFlow: "mono", commit: "off", push: "off", continuation: "stepwise", models: "defaults" },
      active: active("download"),
      pending: ["User decision: retention"],
      next: ["Run the design audit"],
      evidence: ["download/recovery.md"]
    }
  });
  assert.equal(created.created, true);
  assert.equal(created.valid, true);
  assert.equal(created.state.schemaVersion, 1);
  assert.deepEqual(created.state.active, active("download"));

  const updated = await updateCoordinationState({
    ...fixture,
    expectedRevision: created.revision,
    changes: { active: active("download", "review-worker"), next: [] }
  });
  assert.equal(updated.created, false);
  assert.deepEqual(updated.changedFields, ["active", "next"]);
  assert.deepEqual(updated.state.active, active("download", "review-worker"));
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.projectRoot, fixture.statePath), "utf8")), updated.state);
});

test("rejects unsupported autonomy and agent flow values", async (context) => {
  const fixture = await stateFixture(context);

  await assert.rejects(
    updateCoordinationState({
      ...fixture,
      expectedRevision: null,
      changes: { settings: { autonomy: "reckless", agentFlow: "hybrid" } }
    }),
    (caught) => caught.code === "invalid_state" && caught.errors.some((item) => item.includes("settings.autonomy")) && caught.errors.some((item) => item.includes("settings.agentFlow"))
  );
});

test("accepts every autonomy and agent flow value", async (context) => {
  const fixture = await stateFixture(context);
  let expectedRevision = null;
  for (const autonomy of ["conservative", "broad", "full"]) {
    for (const agentFlow of ["mono", "multi"]) {
      const updated = await updateCoordinationState({
        ...fixture,
        expectedRevision,
        changes: { settings: { autonomy, agentFlow } }
      });
      assert.equal(updated.valid, true);
      assert.equal(updated.state.settings.autonomy, autonomy);
      assert.equal(updated.state.settings.agentFlow, agentFlow);
      expectedRevision = updated.revision;
    }
  }
});

test("keeps legacy state valid without the additive settings", async (context) => {
  const fixture = await stateFixture(context);
  const created = await updateCoordinationState({ ...fixture, expectedRevision: null, changes: { active: active("legacy") } });
  assert.deepEqual(created.state.settings, {});
  assert.equal(created.valid, true);
  const loaded = await readCoordinationState(fixture);
  assert.deepEqual(loaded.state.settings, {});
  assert.equal(loaded.valid, true);
});

test("rejects a stale update without changing the state", async (context) => {
  const fixture = await stateFixture(context);
  const created = await updateCoordinationState({ ...fixture, expectedRevision: null, changes: { active: active("first") } });
  const before = await readFile(path.join(fixture.projectRoot, fixture.statePath), "utf8");

  await assert.rejects(
    updateCoordinationState({ ...fixture, expectedRevision: "stale", changes: { active: active("second") } }),
    (caught) => caught.code === "revision_conflict"
  );
  assert.equal(await readFile(path.join(fixture.projectRoot, fixture.statePath), "utf8"), before);
  assert.notEqual(created.revision, "stale");
});

test("rejects invalid state changes without changing the state", async (context) => {
  const fixture = await stateFixture(context);
  const created = await updateCoordinationState({ ...fixture, expectedRevision: null, changes: { active: active("first") } });
  const before = await readFile(path.join(fixture.projectRoot, fixture.statePath), "utf8");

  await assert.rejects(
    updateCoordinationState({
      ...fixture,
      expectedRevision: created.revision,
      changes: { active: [{ slice: "first", activity: "design", workers: ["same", "same"], workspace: "/work/first" }] }
    }),
    (caught) => caught.code === "invalid_state" && caught.errors.some((item) => item.includes("workers[1]"))
  );
  assert.equal(await readFile(path.join(fixture.projectRoot, fixture.statePath), "utf8"), before);
});

test("allows only one concurrent writer with the same revision", async (context) => {
  const fixture = await stateFixture(context);
  const created = await updateCoordinationState({ ...fixture, expectedRevision: null, changes: { active: active("initial") } });
  const results = await Promise.allSettled([
    updateCoordinationState({ ...fixture, expectedRevision: created.revision, changes: { active: active("left") } }),
    updateCoordinationState({ ...fixture, expectedRevision: created.revision, changes: { active: active("right") } })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "revision_conflict").length, 1);
  const finalState = await readCoordinationState(fixture);
  assert.ok(["left", "right"].includes(finalState.state.active[0].slice));
});

test("reports malformed state and rejects paths outside the project", async (context) => {
  const fixture = await stateFixture(context);
  const stateFile = path.join(fixture.projectRoot, fixture.statePath);
  await writeFile(stateFile, "not json\n");
  const invalid = await readCoordinationState(fixture);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors[0], /valid JSON/);
  const missingDirectory = await readCoordinationState({ projectRoot: fixture.projectRoot, statePath: "docs/not-yet/state.json" });
  assert.equal(missingDirectory.exists, false);
  await assert.rejects(
    readCoordinationState({ projectRoot: fixture.projectRoot, statePath: "../outside/state.json" }),
    (caught) => caught.code === "invalid_path"
  );
  await assert.rejects(
    access(path.join(fixture.projectRoot, "docs", "plans", "demo", "state.json.lock")),
    (caught) => caught.code === "ENOENT"
  );
});
