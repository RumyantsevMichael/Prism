import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const { getInitiative, initiativeAcknowledgement, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { answerUserGate, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
const { CONTRACT_TOKEN_BUDGET } = await import("../../dist/server/workflow/slice-design.mjs");

const INITIATIVE = "reports";
const PLANS = `docs/plans/${INITIATIVE}`;
const children = [{ slug: "download", title: "Download reports", requirements: ["req.md#R1"] }, { slug: "audit", title: "Audit downloads", requirements: ["req.md#R2"] }];
const plan = [
  { op: "split", parent: INITIATIVE, children },
  { op: "set_dependencies", slug: "audit", dependencies: ["download"] },
  { op: "accept_design", slug: "download", frozenTests: ["test/download.test.mjs"], review: "none" },
  { op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "required" }
];

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-proposal-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await mkdir(path.join(root, PLANS), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans\n");
  await writeFile(path.join(root, PLANS, "slice.md"), "# Signed reports\n\n## Contract\n1. Downloads write the report.\n");
  await writeFile(path.join(root, "test", "download.test.mjs"), "// frozen download test\n");
  await writeFile(path.join(root, "test", "audit.test.mjs"), "// frozen audit test\n");
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1", "req.md#R2"] }] });
  return root;
}

async function update(root, operations) {
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  return updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations });
}

const exists = (file) => stat(file).then(() => true, () => false);

test("a design proposal is checked at once and changes no slice until the orchestrator accepts it", async (context) => {
  const root = await project(context);
  const proposed = await update(root, [{ op: "propose_design", slug: INITIATIVE, operations: plan }]);
  assert.equal(proposed.record.slices[INITIATIVE].status, "not-started");
  assert.equal(proposed.record.slices.download, undefined);
  assert.equal(proposed.record.proposals[INITIATIVE].operations.length, 4);
  assert.equal(initiativeAcknowledgement(proposed, [{ op: "propose_design", slug: INITIATIVE, operations: plan }]).slices[INITIATIVE].proposal, "pending");
  assert.equal(await exists(path.join(root, "test", "audit.test.mjs")), true, "a proposal stages no tests");
  await assert.rejects(update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: ["missing"] }]), /missing takes no design in this proposal/);
  const accepted = await update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: ["download"] }]);
  assert.equal(accepted.record.slices[INITIATIVE].status, "split");
  assert.equal(accepted.record.slices.download.design.review, "required", "the orchestrator's review marks replace design's recommendations");
  assert.equal(accepted.record.slices.audit.design.review, "none");
  assert.deepEqual(accepted.record.slices.audit.dependencies, ["download"]);
  assert.equal(accepted.record.proposals, undefined);
  assert.deepEqual(accepted.withdrawn.sort(), ["test/audit.test.mjs", "test/download.test.mjs"]);
  const brief = initiativeAcknowledgement(accepted, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: ["download"] }]);
  assert.deepEqual(Object.keys(brief.slices).sort(), ["audit", "download", INITIATIVE]);
  await assert.rejects(update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]), /no pending design proposal/);
});

test("a proposal that Prism would refuse is refused when it is proposed", async (context) => {
  const root = await project(context);
  const propose = (operations) => update(root, [{ op: "propose_design", slug: INITIATIVE, operations }]);
  await assert.rejects(propose([{ op: "split", parent: INITIATIVE, children }]), { code: "split_unjustified" });
  await assert.rejects(propose([{ op: "split", parent: INITIATIVE, children: [children[0]] }, { ...plan[2] }]), /Incomplete child coverage/);
  await assert.rejects(propose([...plan.slice(0, 2), { ...plan[2], frozenTests: ["test/missing.test.mjs"] }, plan[3]]), /does not exist/);
  await writeFile(path.join(root, "test", "large.test.mjs"), "x".repeat(CONTRACT_TOKEN_BUDGET * 4 + 4));
  await assert.rejects(propose([...plan.slice(0, 2), { ...plan[2], frozenTests: ["test/download.test.mjs", "test/large.test.mjs"] }, plan[3]]), { code: "contract_too_large" });
  await assert.rejects(update(root, [{ op: "propose_design", slug: INITIATIVE, operations: plan }, { op: "regenerate_markdown" }]), /propose_design must be the only operation/);
  const unchanged = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  assert.equal(unchanged.record.proposals, undefined);
  assert.equal(unchanged.record.slices[INITIATIVE].status, "not-started");
});

test("a proposal changes only its scope and the slices inside it", async (context) => {
  const root = await project(context);
  await update(root, [{ op: "propose_design", slug: INITIATIVE, operations: plan }]);
  await update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]);
  await assert.rejects(update(root, [{ op: "propose_design", slug: "download", operations: [{ op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "none" }] }]), /changes only its scope download and the slices inside it, not audit/);
  await assert.rejects(update(root, [{ op: "propose_design", slug: "download", operations: [{ op: "split", parent: "audit", children: [{ slug: "x", title: "X", requirements: ["req.md#R2"] }] }] }]), /not audit/);
});

test("a proposed split the person asked for is accepted only with the gate where the person approved it", async (context) => {
  const root = await project(context);
  await update(root, [{ op: "propose_design", slug: INITIATIVE, operations: [{ op: "split", parent: INITIATIVE, children, evidence: { kind: "user_gate" } }] }]);
  await assert.rejects(update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]), /name the user gate where the person approved the split/);
  const asked = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "visual-review", slice: INITIATIVE, question: "Split the reports into download and audit parts?", artifacts: [`${PLANS}/slice.md`] }] } });
  const gate = asked.openedGates[0].id;
  await assert.rejects(update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [], gate }]), /not pending with an answer/);
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: gate, choice: "approve" });
  const accepted = await update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [], gate }]);
  assert.deepEqual(accepted.record.slices[INITIATIVE].splitEvidence, { kind: "user_gate", gate });
  assert.match(await readFile(path.join(root, PLANS, "initiative.md"), "utf8"), /download/);
});
