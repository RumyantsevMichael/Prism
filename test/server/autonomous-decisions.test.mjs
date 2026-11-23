import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// headless-run-questions §17 and §18: under full autonomy a run records its own choice about an undoable step as a closed decision
// with its reason, through one decide operation, and asks the person nothing; under any other autonomy the operation is refused.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const INITIATIVE = "reports";
const stateModule = () => import("../../dist/server/workflow/state.mjs");
const DECISION = {
  op: "decide",
  question: "Park the roadmap entry chore-work-items or leave it in Later?",
  context: "The run found that chore-work-items overlaps this initiative. Parking it can be undone with one roadmap operation.",
  options: [
    { id: "park", label: "Park it", consequence: "The entry moves to Parked and keeps its intent." },
    { id: "keep", label: "Leave it", consequence: "The entry stays in Later." }
  ],
  recommended: { option: "park", reason: "The overlap is complete, and parking can be undone." },
  choice: "park",
  reason: "Decided under full autonomy: the overlap is complete, and a roadmap move can be undone."
};

async function project(context, autonomy) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-decide-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const { updateCoordinationState } = await stateModule();
  const created = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, changes: { settings: { autonomy } } });
  return { root, revision: created.revision };
}
const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
};

test("§17 under full autonomy decide records a closed decision with the choice and reason, and opens nothing", async (t) => {
  const { root, revision } = await project(t, "full");
  const { updateCoordinationState, readCoordinationState } = await stateModule();
  const result = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: revision, changes: { gateOperations: [DECISION] } });
  assert.deepEqual(result.openedGates ?? [], []);
  const { state } = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  assert.deepEqual(state.pending, []);
  assert.equal(state.closed.length, 1);
  const [gate] = state.closed;
  assert.match(gate.id, /^gate-[0-9a-f]{8,32}$/);
  assert.equal(gate.kind, "decision");
  assert.equal(gate.question, DECISION.question);
  assert.equal(gate.context, DECISION.context);
  assert.deepEqual(gate.options, DECISION.options);
  assert.deepEqual(gate.recommended, DECISION.recommended);
  assert.equal(gate.choice, "park");
  assert.equal(gate.reason, DECISION.reason);
  assert.equal(gate.answer, undefined);
  assert.ok(Date.parse(gate.askedAt) <= Date.parse(gate.closedAt));
});

test("§17 decide is refused with autonomy_not_full under conservative and broad autonomy, and changes nothing", async (t) => {
  for (const autonomy of ["conservative", "broad"]) {
    const { root, revision } = await project(t, autonomy);
    const { updateCoordinationState, readCoordinationState } = await stateModule();
    const error = await refusal(updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: revision, changes: { gateOperations: [DECISION] } }));
    assert.equal(error.code, "autonomy_not_full");
    const read = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
    assert.equal(read.revision, revision);
    assert.deepEqual(read.state.closed ?? [], []);
  }
});

test("§17 decide is checked as a decision ask: options need consequences, the choice must be an option, and a reason is required", async (t) => {
  const { root, revision } = await project(t, "full");
  const { updateCoordinationState } = await stateModule();
  const attempt = (change) => refusal(updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: revision, changes: { gateOperations: [{ ...DECISION, ...change }] } }));
  assert.equal((await attempt({ options: [{ id: "park", label: "Park it" }, { id: "keep", label: "Leave it" }] })).code, "gate_context_missing");
  assert.equal((await attempt({ choice: "delete" })).code, "invalid_changes");
  assert.equal((await attempt({ reason: "" })).code, "invalid_changes");
  assert.equal((await attempt({ reason: "x".repeat(1001) })).code, "invalid_changes");
  assert.equal((await attempt({ kind: "assistance" })).code, "invalid_changes", "decide takes no kind");
});

test("§18 the orchestrate skill decides undoable steps under full autonomy through decide, and the workflow defines an undoable step", async () => {
  const orchestrate = await readFile(path.join(ROOT, "skills/orchestrate/SKILL.md"), "utf8");
  assert.match(orchestrate, /`decide`/);
  assert.match(orchestrate, /undoable step/i);
  const workflow = await readFile(path.join(ROOT, "skills/workflow/SKILL.md"), "utf8");
  const terms = workflow.slice(workflow.indexOf("## Common terms"), workflow.indexOf("\n## ", workflow.indexOf("## Common terms") + 1));
  const row = terms.split("\n").find((line) => /^\|\s*Undoable step\s*\|/.test(line));
  assert.ok(row, "Common terms define Undoable step");
  for (const word of ["roadmap", "Draft requirement", "issue", "commit", "push"]) assert.ok(row.includes(word), `the definition names ${word}`);
});
