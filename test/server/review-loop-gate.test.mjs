import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/review-loop-decisions.md §4, §5, §6, §7.
// At the review wave limit Prism records the review loop decision gate itself, and a return to design blocks the slice with its unresolved findings.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-loop-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { getReview, updateReview } = await import("../../dist/server/review/review-ledger.mjs");
const { answerUserGate, readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const coordinator = { id: "orchestrator", role: "coordinator" };
const delivery = { id: "Develop download", role: "delivery" };
const reviewerOf = (wave) => ({ id: `Review ${wave}`, role: "reviewer" });
const lanes = (wave) => [{ id: "correctness", reviewer: `Review ${wave}`, coverage: ["."] }];
const findingId = (local) => `implementation-review/correctness/${local}`;
const CONSEQUENCES = {
  "continue-review": ["Continue the review", "Prism allows one more review wave with fresh reviewers after the implementer fixes the open findings."],
  "return-to-design": ["Return the slice to design", "The slice is blocked, and design revises its contract with every unresolved finding as a defect."],
  "accept-deferred": ["Accept with deferred low findings", "The review wave is accepted, and each low finding stays on record as deferred with a follow-up in the project's tracker."]
};
const options = (...ids) => ids.map((id) => ({ id, label: CONSEQUENCES[id][0], consequence: CONSEQUENCES[id][1] }));

// A project whose root slice requires review and has passed verification.
async function verified(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-loop-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${process.execPath} check.mjs\n`);
  await writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
  await writeFile(path.join(root, "test", "acceptance.test.mjs"), "// frozen acceptance test\n");
  await writeFile(path.join(root, "source.mjs"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1"] }] });
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "set_status", slug: INITIATIVE, status: "in-progress" }, { op: "accept_design", slug: INITIATIVE, frozenTests: ["test/acceptance.test.mjs"], review: "required" }] });
  const slice = { projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE };
  const asked = await verifySlice(slice);
  assert.equal(asked.status, "approval_needed");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow" });
  assert.equal((await verifySlice({ ...slice, approvalGate: asked.gateId })).status, "passed");
  const review = async (actor, operations, extra = {}) => updateReview({ ...slice, expectedRevision: (await getReview(slice)).revision, actor, operations, ...extra });
  // One wave: its reviewer verifies the findings named in verify, opens the findings given, and submits the lane; fix names findings the implementer then fixes.
  const wave = async (id, { open = [], verify = [], fix = [], status = open.length ? "FINDINGS" : "CLEAN", extra = {} } = {}) => {
    await review(coordinator, [{ op: "start_wave", id, mode: "implementation-review", lanes: lanes(id), ...extra }], id === "w1" ? { delivery: delivery.id } : {});
    await review(reviewerOf(id), [
      ...verify.map((local) => ({ op: "set_finding_status", id: findingId(local), status: "VERIFIED", evidence: "Checked." })),
      ...open.map((finding) => ({ op: "open_finding", lane: "correctness", affectedPath: "source.mjs", evidence: "Seen in the diff.", conditionToClose: "The case is handled.", ...finding })),
      { op: "submit_lane", lane: "correctness", status }
    ]);
    if (fix.length) await review(delivery, fix.map((local) => ({ op: "set_finding_status", id: findingId(local), status: "FIXED", evidence: "Fixed." })));
  };
  return { root, slice, review, wave };
}

const state = async (root) => (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state;
const loopGates = async (root) => ((await state(root))?.pending ?? []).filter((gate) => gate.kind === "decision" && (gate.options ?? []).some((option) => option.id === "continue-review"));
const answer = (root, id, choice) => answerUserGate({ projectRoot: root, initiative: INITIATIVE, id, choice });

// The refusal at the limit, returning the error after checking clause 12's shape.
async function limitRefusal(review, id = "w3", waves = 2) {
  let refusal;
  await assert.rejects(review(coordinator, [{ op: "start_wave", id, mode: "implementation-review", lanes: lanes(id) }]), (error) => {
    refusal = error;
    return true;
  });
  assert.equal(refusal.code, "gate_blocked", refusal.message);
  assert.equal(refusal.problems.length, 1);
  assert.equal(refusal.problems[0].code, "review_loop_limit");
  assert.equal(refusal.problems[0].waves, waves);
  assert.ok(/^gate-[0-9a-f]{8,32}$/.test(refusal.problems[0].gate ?? ""), `the refusal names the review loop gate: ${JSON.stringify(refusal.problems)}`);
  return refusal;
}

const M1 = { localId: "M1", title: "Retry count is off by one", severity: "medium" };
const L1 = { localId: "L1", title: "Help text has a typo", severity: "low", affectedPath: "docs.md" };
const H1 = { localId: "H1", title: "Signature is not checked", severity: "high" };

test("clauses 12, 14, 15, 16, 19: at the limit Prism records one gate with the summary, the options that apply, and the rule's recommendation", async (context) => {
  const { root, review, wave } = await verified(context);
  await wave("w1", { open: [H1, L1], fix: ["H1"] });
  await wave("w2", { verify: ["H1"], open: [M1] });
  assert.deepEqual(await loopGates(root), [], "no gate before the limit");
  const refusal = await limitRefusal(review);
  const id = refusal.problems[0].gate;
  assert.equal(refusal.message, `The slice had 2 review waves since its design was accepted, so Prism asked the review loop decision gate ${id} for slice ${INITIATIVE}. When the user chose continue-review, start the wave with afterGate ${id}; for return-to-design, call update_review with return_to_design and the gate; for accept-deferred, call accept_wave with the gate and a follow-up for each unresolved finding.`);
  assert.doesNotMatch(refusal.message, /narrow/i);
  const [gate] = await loopGates(root);
  assert.equal(gate.id, id);
  assert.equal(gate.kind, "decision");
  assert.equal(gate.slice, INITIATIVE);
  assert.equal(gate.question, `How should the review of slice ${INITIATIVE} continue after 2 review waves?`);
  assert.deepEqual(gate.artifacts, []);
  assert.deepEqual(gate.options, options("continue-review", "return-to-design"), "accepting is not offered while a medium finding is unresolved");
  assert.equal(gate.context.trimEnd(), [
    `Slice \`${INITIATIVE}\` had 2 implementation review waves since its design was accepted, so a further wave needs a decision.`,
    "",
    "**Unresolved findings:** 0 blocker, 0 high, 1 medium, 1 low.",
    "",
    `- \`${findingId("M1")}\` medium, OPEN: Retry count is off by one`,
    `- \`${findingId("L1")}\` low, OPEN: Help text has a typo`,
    "",
    "**Findings by wave:**",
    "",
    "| Wave | Raised | Closed |",
    "| --- | --- | --- |",
    "| `w1` | 2 | 0 |",
    "| `w2` | 1 | 1 |",
    "",
    "**Files named in more than one wave:** `source.mjs` (`w1`, `w2`)."
  ].join("\n"));
  assert.deepEqual(gate.recommended, { option: "return-to-design", reason: "The latest wave w2 raised 1 findings above low severity, and the wave before it, w1, raised 1, so fixing forward is not converging." });
  const again = await limitRefusal(review);
  assert.equal(again.problems[0].gate, id, "a second refusal names the same gate");
  assert.equal((await loopGates(root)).length, 1);
});

test("clauses 15, 18: while every unresolved finding is low, accepting is offered and recommended, and the deferral it chooses is accepted", async (context) => {
  const { root, slice, review, wave } = await verified(context);
  await wave("w1", { open: [H1], fix: ["H1"] });
  await wave("w2", { verify: ["H1"], open: [{ ...L1, affectedPath: "source.mjs" }, { localId: "L2", title: "Log line names the wrong report", severity: "low" }] });
  const refusal = await limitRefusal(review);
  const [gate] = await loopGates(root);
  assert.deepEqual(gate.options, options("continue-review", "return-to-design", "accept-deferred"));
  assert.deepEqual(gate.recommended, { option: "accept-deferred", reason: "Every unresolved finding is low severity, so the slice can be accepted with each one deferred to a tracked follow-up." });
  assert.match(gate.context, /\*\*Unresolved findings:\*\* 0 blocker, 0 high, 0 medium, 2 low\./);
  await answer(root, refusal.problems[0].gate, "accept-deferred");
  const accepted = await review(coordinator, [{ op: "accept_wave", gate: gate.id, deferrals: [{ finding: findingId("L1"), followUp: "#11" }, { finding: findingId("L2"), followUp: "#12" }] }]);
  assert.equal(accepted.accepted, true);
  assert.deepEqual((await getReview(slice)).deferred.map((item) => item.id), [findingId("L1"), findingId("L2")]);
});

test("clause 20: a latest wave that raised fewer findings above low than the wave before recommends continuing", async (context) => {
  const { root, review, wave } = await verified(context);
  await wave("w1", { open: [H1, { localId: "H2", title: "Expiry is ignored", severity: "blocker" }], fix: ["H1", "H2"] });
  await wave("w2", { verify: ["H1", "H2"], open: [M1] });
  await limitRefusal(review);
  const [gate] = await loopGates(root);
  assert.deepEqual(gate.recommended, { option: "continue-review", reason: "The latest wave w2 raised 1 findings above low severity, fewer than the 2 that the wave before it, w1, raised, so the review is converging." });
  assert.match(gate.context, /\*\*Files named in more than one wave:\*\* `source\.mjs` \(`w1`, `w2`\)\./);
});

test("clause 16: a summary without unresolved findings or repeated files says so", async (context) => {
  const { root, review, wave } = await verified(context);
  await wave("w1", { open: [H1], fix: ["H1"] });
  await wave("w2", { verify: ["H1"] });
  await limitRefusal(review);
  const [gate] = await loopGates(root);
  assert.ok(gate.context.includes("\n\nNo finding is unresolved.\n\n"), gate.context);
  assert.ok(gate.context.trimEnd().endsWith("**Files named in more than one wave:** none."), gate.context);
  assert.deepEqual(gate.options.map((option) => option.id), ["continue-review", "return-to-design", "accept-deferred"], "accepting is offered when no finding is unresolved");
});

test("clause 17: the summary cuts long titles and keeps twenty findings", async (context) => {
  const { root, review, wave } = await verified(context);
  const lows = Array.from({ length: 22 }, (_, index) => ({ localId: `L${String(index + 1).padStart(2, "0")}`, title: index === 0 ? "A".repeat(200) : `Low finding ${index + 1}`, severity: "low" }));
  await wave("w1", { open: lows });
  await wave("w2", { status: "FINDINGS" });
  await limitRefusal(review);
  const [gate] = await loopGates(root);
  const items = gate.context.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(items.length, 21);
  assert.equal(items[0], `- \`${findingId("L01")}\` low, OPEN: ${"A".repeat(119)}…`);
  assert.equal(items[19], `- \`${findingId("L20")}\` low, OPEN: Low finding 20`);
  assert.equal(items[20], "- and 2 more");
  assert.ok(gate.context.length <= 8000);
});

test("clauses 13, 21: an answered gate that chose another option does not allow a wave, and a new gate replaces it", async (context) => {
  const { root, review, wave } = await verified(context);
  await wave("w1", { open: [H1], fix: ["H1"] });
  await wave("w2", { verify: ["H1"], open: [L1] });
  const first = (await limitRefusal(review)).problems[0].gate;
  await answer(root, first, "return-to-design");
  await assert.rejects(review(coordinator, [{ op: "start_wave", id: "w3", mode: "implementation-review", lanes: lanes("w3"), afterGate: first }]), (error) => error.code === "gate_blocked" && error.message === `The decision gate ${first} chose return-to-design, so it does not allow another review wave.`);
  const second = (await limitRefusal(review)).problems[0].gate;
  assert.notEqual(second, first, "a gate that chose another option is not named again");
  await answer(root, second, "accept-deferred");
  await assert.rejects(review(coordinator, [{ op: "start_wave", id: "w3", mode: "implementation-review", lanes: lanes("w3"), afterGate: second }]), (error) => error.code === "gate_blocked" && error.message === `The decision gate ${second} chose accept-deferred, so it does not allow another review wave.`);
  const third = (await limitRefusal(review)).problems[0].gate;
  await answer(root, third, "continue-review");
  assert.equal((await limitRefusal(review)).problems[0].gate, third, "a gate that chose to continue is named until a wave uses it");
  await review(coordinator, [{ op: "start_wave", id: "w3", mode: "implementation-review", lanes: lanes("w3"), afterGate: third }]);
  const fourth = (await limitRefusal(review, "w4", 3)).problems[0].gate;
  assert.notEqual(fourth, third, "a used gate is not named again");
});

test("clauses 22, 23, 25: returning to design blocks the slice with every unresolved finding as a defect and keeps the findings", async (context) => {
  const { root, slice, review, wave } = await verified(context);
  await wave("w1", { open: [H1, L1], fix: ["H1"] });
  await wave("w2", { verify: ["H1"], open: [M1] });
  const gate = (await limitRefusal(review)).problems[0].gate;
  await assert.rejects(review(coordinator, [{ op: "return_to_design", gate }]), (error) => error.code === "gate_blocked", "an unanswered gate does not return the slice");
  await answer(root, gate, "return-to-design");
  await assert.rejects(review(reviewerOf("w2"), [{ op: "return_to_design", gate }]), (error) => error.code === "gate_blocked", "only the coordinator returns a slice");
  await assert.rejects(review(coordinator, [{ op: "return_to_design", gate }, { op: "regenerate_markdown" }]), (error) => error.code === "validation_failed", "the operation stands alone");
  const before = (await getReview(slice)).entries.map((finding) => [finding.id, finding.status]);
  const result = await review(coordinator, [{ op: "return_to_design", gate }]);
  assert.deepEqual(result.returnedToDesign, { sliceStatus: "blocked", defects: 2 });
  const record = (await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices[INITIATIVE];
  assert.equal(record.status, "blocked");
  assert.deepEqual(record.contractDefects.map(({ clause, reason }) => ({ clause, reason })), [
    { clause: `Review finding ${findingId("M1")}`, reason: `${findingId("M1")} (medium): Retry count is off by one` },
    { clause: `Review finding ${findingId("L1")}`, reason: `${findingId("L1")} (low): Help text has a typo` }
  ]);
  const after = await getReview(slice);
  assert.deepEqual(after.entries.map((finding) => [finding.id, finding.status]), before);
  assert.equal((await getReview({ ...slice, section: "history" })).entries.at(-1).operation, "return_to_design");
});

test("clauses 22, 23: a gate that chose another option, or one asked before the latest wave, does not return the slice", async (context) => {
  const { root, review, wave } = await verified(context);
  await wave("w1", { open: [H1], fix: ["H1"] });
  await wave("w2", { verify: ["H1"], open: [M1] });
  const gate = (await limitRefusal(review)).problems[0].gate;
  await answer(root, gate, "continue-review");
  await assert.rejects(review(coordinator, [{ op: "return_to_design", gate }]), (error) => error.code === "gate_blocked");
  await review(coordinator, [{ op: "start_wave", id: "w3", mode: "implementation-review", lanes: lanes("w3"), afterGate: gate }]);
  await assert.rejects(review(coordinator, [{ op: "return_to_design", gate }]), (error) => error.code === "gate_blocked");
  assert.equal((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices[INITIATIVE].status, "in-progress");
});

// A decision gate asked by the coordinator itself, with the review loop options, so a slice can return before the limit.
async function askLoopGate(root) {
  const current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  const result = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes: { gateOperations: [{ op: "ask", kind: "decision", slice: INITIATIVE, question: "How should the review continue?", context: "The reviewers keep finding problems in the same place.", options: options("continue-review", "return-to-design"), recommended: { option: "return-to-design", reason: "The findings recur." } }] } });
  return result.openedGates[0].id;
}

test("clause 23: a finding that names a contract clause keeps it as the defect's clause", async (context) => {
  const { root, review, wave } = await verified(context);
  await wave("w1", { open: [{ ...H1, clause: "Contract 3" }] });
  const gate = await askLoopGate(root);
  await answer(root, gate, "return-to-design");
  await review(coordinator, [{ op: "return_to_design", gate }]);
  const record = (await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices[INITIATIVE];
  assert.deepEqual(record.contractDefects.map(({ clause, reason }) => ({ clause, reason })), [{ clause: "Contract 3", reason: `${findingId("H1")} (high): Signature is not checked` }]);
});

test("clause 24: with no unresolved finding the defect names the decision, and more than fifty are summarized", async (context) => {
  const { root, review, wave } = await verified(context);
  await wave("w1");
  const gate = await askLoopGate(root);
  await answer(root, gate, "return-to-design");
  assert.deepEqual((await review(coordinator, [{ op: "return_to_design", gate }])).returnedToDesign, { sliceStatus: "blocked", defects: 1 });
  const record = (await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices[INITIATIVE];
  assert.deepEqual(record.contractDefects.map(({ clause, reason }) => ({ clause, reason })), [{ clause: "Review loop decision", reason: `The user returned the slice to design at ${gate}.` }]);

  const many = await verified(context);
  const lows = Array.from({ length: 53 }, (_, index) => ({ localId: `L${String(index + 1).padStart(2, "0")}`, title: `Low finding ${index + 1}`, severity: "low" }));
  await many.wave("w1", { open: lows });
  const manyGate = await askLoopGate(many.root);
  await answer(many.root, manyGate, "return-to-design");
  assert.deepEqual((await many.review(coordinator, [{ op: "return_to_design", gate: manyGate }])).returnedToDesign, { sliceStatus: "blocked", defects: 50 });
  const defects = (await getInitiative({ projectRoot: many.root, initiative: INITIATIVE })).record.slices[INITIATIVE].contractDefects;
  assert.equal(defects.length, 50);
  assert.equal(defects[48].clause, `Review finding ${findingId("L49")}`);
  assert.deepEqual({ clause: defects[49].clause, reason: defects[49].reason }, { clause: "Review findings", reason: "4 more unresolved findings; read them with get_review." });
});
