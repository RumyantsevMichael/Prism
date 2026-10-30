import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const { getInitiative, initiativeAcknowledgement, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { answerUserGate, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
const { CONTRACT_TOKEN_BUDGET } = await import("../../dist/server/workflow/slice-design.mjs");

const INITIATIVE = "reports";
const PLANS = `docs/plans/${INITIATIVE}`;
const children = [{ slug: "download", title: "Download reports", requirements: ["req.md#R1"] }, { slug: "audit", title: "Audit downloads", requirements: ["req.md#R2"] }];
const large = "x".repeat(CONTRACT_TOKEN_BUDGET * 4 + 4);

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-split-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await mkdir(path.join(root, PLANS), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans\n");
  await writeFile(path.join(root, "test", "download.test.mjs"), "// frozen download test\n");
  await writeFile(path.join(root, "test", "audit.test.mjs"), "// frozen audit test\n");
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1", "req.md#R2"] }] });
  return root;
}

async function update(root, operations) {
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  return updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations });
}

const split = (evidence) => ({ op: "split", parent: INITIATIVE, children, ...(evidence ? { evidence } : {}) });
const plan = [
  { op: "accept_design", slug: "download", frozenTests: ["test/download.test.mjs"], review: "none" },
  { op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "none" }
];

test("a split into parts needs evidence, while a contract's slice plan needs none", async (context) => {
  const root = await project(context);
  await assert.rejects(update(root, [split()]), (error) => error.code === "split_unjustified" && /design it as one contract first/.test(error.message));
  await assert.rejects(update(root, [split(), plan[0]]), { code: "split_unjustified" }, "a plan accepts every part in the same update");
  const accepted = await update(root, [split(), ...plan]);
  assert.equal(accepted.record.slices[INITIATIVE].status, "split");
  assert.equal(accepted.record.slices[INITIATIVE].splitEvidence, undefined);
});

test("an Unprobed assumption of the scope's contract justifies a split when one part settles it", async (context) => {
  const root = await project(context);
  await writeFile(path.join(root, PLANS, "slice.md"), "# Signed reports\n\n## Assumptions\n- Probed: the storage client returns None for a missing key.\n- Unprobed: the `audit store` keeps download order; listings sort by time.\n");
  const unfrozen = (assumption, settledBy = "download") => split({ kind: "unfrozen", assumption, settledBy });
  await assert.rejects(update(root, [unfrozen("the audit store keeps download order", "export")]), /export is not one of its parts/);
  await assert.rejects(update(root, [unfrozen("the storage client returns None")]), /no Unprobed assumption/, "a probed assumption is settled already");
  await assert.rejects(update(root, [unfrozen("order")]), /quote the Unprobed assumption/);
  const result = await update(root, [unfrozen("The audit store keeps download order")]);
  assert.deepEqual(result.record.slices[INITIATIVE].splitEvidence, { kind: "unfrozen", assumption: "The audit store keeps download order", settledBy: "download" });
  assert.equal(initiativeAcknowledgement(result, [unfrozen("x")]).slices[INITIATIVE].splitEvidence, "unfrozen");
});

test("contract files measured above the budget justify a split, and acceptance refuses a contract above it", async (context) => {
  const root = await project(context);
  await writeFile(path.join(root, "test", "draft.test.mjs"), large);
  await writeFile(path.join(root, PLANS, "slice.md"), "# Signed reports\n\n## Contract\n1. Downloads write the report.\n");
  await assert.rejects(update(root, [split(), { ...plan[0], frozenTests: ["test/download.test.mjs", "test/draft.test.mjs"] }, plan[1]]), (error) => {
    assert.equal(error.code, "contract_too_large");
    assert.equal(error.scope, INITIATIVE);
    assert.ok(error.tokens > CONTRACT_TOKEN_BUDGET);
    assert.deepEqual(error.files, [`${PLANS}/slice.md`, "test/audit.test.mjs", "test/download.test.mjs", "test/draft.test.mjs"]);
    return true;
  });
  await assert.rejects(update(root, [split({ kind: "contract_size", files: [`${PLANS}/slice.md`, "test/download.test.mjs"] })]), /within the contract budget/);
  await assert.rejects(update(root, [split({ kind: "contract_size", files: ["test/missing.test.mjs"] })]), /test\/missing\.test\.mjs does not exist/);
  const result = await update(root, [split({ kind: "contract_size", files: [`${PLANS}/slice.md`, "test/draft.test.mjs"] })]);
  const evidence = result.record.slices[INITIATIVE].splitEvidence;
  assert.equal(evidence.kind, "contract_size");
  assert.ok(evidence.tokens > CONTRACT_TOKEN_BUDGET);
  assert.deepEqual(evidence.files, [`${PLANS}/slice.md`, "test/draft.test.mjs"]);
});

test("a gate where the person answered justifies a split, and an unanswered or rejected one does not", async (context) => {
  const root = await project(context);
  const asked = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, changes: { gateOperations: [
    { op: "ask", kind: "visual-review", slice: INITIATIVE, question: "Split the reports into download and audit parts?", artifacts: [] },
    { op: "ask", kind: "visual-review", slice: "download", question: "Review the download design.", artifacts: [] },
    { op: "ask", kind: "visual-review", slice: INITIATIVE, question: "Split again?", artifacts: [] }
  ] } });
  const [splitGate, otherGate, rejectedGate] = asked.openedGates.map((gate) => gate.id);
  const byGate = (gate) => split({ kind: "user_gate", gate });
  await assert.rejects(update(root, [byGate(splitGate)]), /not pending with an answer/);
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: otherGate, choice: "approve" });
  await assert.rejects(update(root, [byGate(otherGate)]), /is about download/);
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: rejectedGate, choice: "request-changes", note: "Keep one contract." });
  await assert.rejects(update(root, [byGate(rejectedGate)]), /requested changes/);
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: splitGate, choice: "approve" });
  const result = await update(root, [byGate(splitGate)]);
  assert.deepEqual(result.record.slices[INITIATIVE].splitEvidence, { kind: "user_gate", gate: splitGate });
});
