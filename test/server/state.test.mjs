import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { answerUserGate, readCoordinationState, updateCoordinationState } from "../../dist/server/workflow/state.mjs";

const stateFile = (fixture) => path.join(fixture.projectRoot, ".prism/initiatives", fixture.initiative, "state.json");

async function stateFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { projectRoot: root, initiative: "demo" };
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
      activeOperations: active("download").map(entry => ({ op: "start", entry })),
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
    changes: { activeOperations: [{ op: "update", slice: "download", set: { workers: ["review-worker"] } }], next: [] }
  });
  assert.equal(updated.created, false);
  assert.deepEqual(updated.changedFields, ["active", "next"]);
  assert.deepEqual(updated.state.active, active("download", "review-worker"));
  assert.deepEqual(JSON.parse(await readFile(stateFile(fixture), "utf8")), updated.state);
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
  const created = await updateCoordinationState({ ...fixture, expectedRevision: null, changes: { activeOperations: active("legacy").map(entry => ({ op: "start", entry })) } });
  assert.deepEqual(created.state.settings, {});
  assert.equal(created.valid, true);
  const loaded = await readCoordinationState(fixture);
  assert.deepEqual(loaded.state.settings, {});
  assert.equal(loaded.valid, true);
});

test("rejects a stale update without changing the state", async (context) => {
  const fixture = await stateFixture(context);
  const created = await updateCoordinationState({ ...fixture, expectedRevision: null, changes: { activeOperations: active("first").map(entry => ({ op: "start", entry })) } });
  const before = await readFile(stateFile(fixture), "utf8");

  await assert.rejects(
    updateCoordinationState({ ...fixture, expectedRevision: "stale", changes: { activeOperations: active("second").map(entry => ({ op: "start", entry })) } }),
    (caught) => caught.code === "revision_conflict"
  );
  assert.equal(await readFile(stateFile(fixture), "utf8"), before);
  assert.notEqual(created.revision, "stale");
});

test("rejects invalid state changes without changing the state", async (context) => {
  const fixture = await stateFixture(context);
  const created = await updateCoordinationState({ ...fixture, expectedRevision: null, changes: { activeOperations: active("first").map(entry => ({ op: "start", entry })) } });
  const before = await readFile(stateFile(fixture), "utf8");

  await assert.rejects(
    updateCoordinationState({
      ...fixture,
      expectedRevision: created.revision,
      changes: { activeOperations: [{ op: "update", slice: "first", set: { workers: ["same", "same"] } }] }
    }),
    (caught) => caught.code === "invalid_state" && caught.errors.some((item) => item.includes("workers[1]"))
  );
  assert.equal(await readFile(stateFile(fixture), "utf8"), before);
});

test("allows only one concurrent writer with the same revision", async (context) => {
  const fixture = await stateFixture(context);
  const created = await updateCoordinationState({ ...fixture, expectedRevision: null, changes: { activeOperations: active("initial").map(entry => ({ op: "start", entry })) } });
  const results = await Promise.allSettled([
    updateCoordinationState({ ...fixture, expectedRevision: created.revision, changes: { activeOperations: [{ op: "release", slice: "initial" }, ...active("left").map(entry => ({ op: "start", entry }))] } }),
    updateCoordinationState({ ...fixture, expectedRevision: created.revision, changes: { activeOperations: [{ op: "release", slice: "initial" }, ...active("right").map(entry => ({ op: "start", entry }))] } })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "revision_conflict").length, 1);
  const finalState = await readCoordinationState(fixture);
  assert.ok(["left", "right"].includes(finalState.state.active[0].slice));
});

test("reports malformed state and rejects paths outside the project", async (context) => {
  const fixture = await stateFixture(context);
  await mkdir(path.dirname(stateFile(fixture)), { recursive: true });
  await writeFile(stateFile(fixture), "not json\n");
  const invalid = await readCoordinationState(fixture);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors[0], /valid JSON/);
  const missingDirectory = await readCoordinationState({ projectRoot: fixture.projectRoot, initiative: "not-yet" });
  assert.equal(missingDirectory.exists, false);
  await assert.rejects(
    readCoordinationState({ projectRoot: fixture.projectRoot, initiative: "../outside" }),
    (caught) => caught.code === "invalid_path"
  );
  await assert.rejects(
    access(`${stateFile(fixture)}.lock`),
    (caught) => caught.code === "ENOENT"
  );
});

test("records and resolves user gates beside legacy pending items", async (context) => {
  const fixture = await stateFixture(context);
  const created = await updateCoordinationState({
    ...fixture,
    expectedRevision: null,
    changes: {
      pending: ["User decision: retention"],
      gateOperations: [{ op: "ask", kind: "visual-review", slice: "download", question: "Review the download design.", artifacts: ["docs/plans/demo/download/slice.md"] }]
    }
  });
  assert.equal(created.openedGates.length, 1);
  const [gate] = created.openedGates;
  assert.match(gate.id, /^gate-[0-9a-f]{12}$/);
  assert.equal(created.state.pending[0], "User decision: retention");
  assert.deepEqual({ ...created.state.pending[1], askedAt: undefined }, { id: gate.id, kind: "visual-review", slice: "download", question: "Review the download design.", artifacts: ["docs/plans/demo/download/slice.md"], askedAt: undefined });
  assert.ok(!Number.isNaN(Date.parse(created.state.pending[1].askedAt)));

  const unknown = await updateCoordinationState({ ...fixture, expectedRevision: created.revision, changes: { gateOperations: [{ op: "resolve", id: "gate-000000000000" }] } }).catch(error => error);
  assert.equal(unknown.code, "unknown_gate");
  for (const operation of [
    { op: "ask", kind: "approval", question: "Approve?", artifacts: [] },
    { op: "ask", kind: "decision", question: " ", artifacts: [] },
    { op: "ask", kind: "decision", question: "Which store?", artifacts: ["../outside.md"] },
    { op: "ask", kind: "decision", question: "Which store?", artifacts: ["/abs.md"] },
    { op: "ask", kind: "decision", question: "Which store?", artifacts: [], id: "gate-abcdefabcdef" },
    { op: "close", id: gate.id }
  ]) {
    const rejected = await updateCoordinationState({ ...fixture, expectedRevision: created.revision, changes: { gateOperations: [operation] } }).catch(error => error);
    assert.equal(rejected.code, "invalid_changes", JSON.stringify(operation));
  }
  const forged = await updateCoordinationState({ ...fixture, expectedRevision: created.revision, changes: { pending: [{ id: "not-a-gate", kind: "decision", question: "Q", artifacts: [], askedAt: "2026-10-13T00:00:00Z" }] } }).catch(error => error);
  assert.equal(forged.code, "invalid_state");

  const resolved = await updateCoordinationState({ ...fixture, expectedRevision: created.revision, changes: { gateOperations: [{ op: "resolve", id: gate.id }] } });
  assert.deepEqual(resolved.state.pending, ["User decision: retention"]);
  assert.deepEqual(resolved.openedGates, []);
});

test("records one browser answer per gate and keeps agents from forging answers", async (context) => {
  const fixture = await stateFixture(context);
  const created = await updateCoordinationState({ ...fixture, expectedRevision: null, changes: { gateOperations: [
    { op: "ask", kind: "visual-review", slice: "download", question: "Review the design.", artifacts: [] },
    { op: "ask", kind: "decision", question: "Which store?", artifacts: [], options: [{ id: "postgres", label: "Postgres" }, { id: "sqlite", label: "SQLite" }] },
    { op: "ask", kind: "assistance", question: "Run review in a separate task.", artifacts: [] }
  ] } });
  const [review, decision, assistance] = created.openedGates.map((gate) => gate.id);
  assert.deepEqual(created.state.pending[1].options.map((option) => option.id), ["postgres", "sqlite"]);
  for (const options of [[], [{ id: "Bad Id", label: "x" }], [{ id: "a", label: "A" }, { id: "a", label: "B" }]]) {
    const rejected = await updateCoordinationState({ ...fixture, expectedRevision: created.revision, changes: { gateOperations: [{ op: "ask", kind: "decision", question: "Q", artifacts: [], options }] } }).catch(error => error);
    assert.equal(rejected.code, "invalid_changes", JSON.stringify(options));
  }
  const reviewOptions = await updateCoordinationState({ ...fixture, expectedRevision: created.revision, changes: { gateOperations: [{ op: "ask", kind: "visual-review", question: "Q", artifacts: [], options: [{ id: "a", label: "A" }] }] } }).catch(error => error);
  assert.equal(reviewOptions.code, "invalid_changes");

  for (const [id, choice, note] of [[review, "maybe", null], [review, "request-changes", null], [decision, "mysql", null], [decision, null, null], [assistance, "approve", null], [review, "approve", "x".repeat(4001)]]) {
    const rejected = await answerUserGate({ ...fixture, id, choice, note }).catch(error => error);
    assert.equal(rejected.code, "invalid_answer", `${choice} ${note?.length}`);
  }
  const answered = await answerUserGate({ ...fixture, id: decision, choice: "sqlite", note: "  Keep it local.  " });
  assert.deepEqual({ ...answered.gate.answer, answeredAt: undefined }, { choice: "sqlite", note: "Keep it local.", via: "browser", answeredAt: undefined });
  assert.equal((await answerUserGate({ ...fixture, id: decision, choice: "postgres" }).catch(error => error)).code, "gate_answered");
  await answerUserGate({ ...fixture, id: review, choice: "request-changes", note: "Name the deadline." });
  await answerUserGate({ ...fixture, id: assistance, choice: "done" });

  const current = await readCoordinationState(fixture);
  const forged = current.state.pending.map((gate) => gate.id === decision ? { ...gate, answer: { ...gate.answer, choice: "postgres" } } : gate);
  assert.equal((await updateCoordinationState({ ...fixture, expectedRevision: current.revision, changes: { pending: forged } }).catch(error => error)).code, "invalid_changes");
  const invented = await updateCoordinationState({ ...fixture, expectedRevision: current.revision, changes: { pending: [...current.state.pending, { id: "gate-abcdefabcdef", kind: "assistance", question: "Q", artifacts: [], askedAt: "2026-10-13T00:00:00Z", answer: { choice: "done", note: null, via: "browser", answeredAt: "2026-10-13T00:00:00Z" } }] } }).catch(error => error);
  assert.equal(invented.code, "invalid_changes");
  const kept = await updateCoordinationState({ ...fixture, expectedRevision: current.revision, changes: { next: ["Apply the answers"] } });
  assert.equal(kept.state.pending.filter((gate) => gate.answer).length, 3);

  const resolved = await updateCoordinationState({ ...fixture, expectedRevision: kept.revision, changes: { gateOperations: [{ op: "resolve", id: decision }] } });
  assert.equal(resolved.state.pending.some((gate) => gate.id === decision), false);
  assert.equal((await answerUserGate({ ...fixture, id: decision, choice: "sqlite" }).catch(error => error)).code, "unknown_gate");
});
