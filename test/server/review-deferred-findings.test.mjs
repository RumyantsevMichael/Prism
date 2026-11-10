import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/review-loop-decisions.md §1, §2, §3.
// The coordinator accepts a review wave whose unresolved findings are all low, citing the user's decision gate and a follow-up per finding.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-deferred-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { checkSliceGate } = await import("../../dist/server/workflow/slice-gate.mjs");
const { checkReviewGate, getReview, updateReview } = await import("../../dist/server/review/review-ledger.mjs");
const { answerUserGate, readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const coordinator = { id: "orchestrator", role: "coordinator" };
const delivery = { id: "Develop download", role: "delivery" };
const reviewerOf = (wave) => ({ id: `Review ${wave}`, role: "reviewer" });
const lanes = (wave) => [{ id: "correctness", reviewer: `Review ${wave}`, coverage: ["."] }];
const findingId = (local) => `implementation-review/correctness/${local}`;
const OPTIONS = [
  { id: "continue-review", label: "Continue the review", consequence: "One more wave runs." },
  { id: "return-to-design", label: "Return the slice to design", consequence: "Design revises the contract." },
  { id: "accept-deferred", label: "Accept with deferred low findings", consequence: "The low findings are deferred." }
];

async function initiativeUpdate(root, operations) {
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  return updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations });
}

// A project whose download slice requires review, has passed verification, and whose first review wave raised the given findings.
async function reviewed(context, findings) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-deferred-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${process.execPath} check.mjs\n`);
  await writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
  await writeFile(path.join(root, "test", "acceptance.test.mjs"), "// frozen acceptance test\n");
  await writeFile(path.join(root, "source.mjs"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1"] }] });
  await initiativeUpdate(root, [{ op: "set_status", slug: INITIATIVE, status: "in-progress" }, { op: "accept_design", slug: INITIATIVE, frozenTests: ["test/acceptance.test.mjs"], review: "required" }]);
  const slice = { projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE };
  const asked = await verifySlice(slice);
  assert.equal(asked.status, "approval_needed");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow" });
  assert.equal((await verifySlice({ ...slice, approvalGate: asked.gateId })).status, "passed");
  const review = async (actor, operations, extra = {}) => updateReview({ ...slice, expectedRevision: (await getReview(slice)).revision, actor, operations, ...extra });
  await review(coordinator, [{ op: "start_wave", id: "w1", mode: "implementation-review", lanes: lanes("w1") }], { delivery: delivery.id });
  await review(reviewerOf("w1"), [...findings.map((finding) => ({ op: "open_finding", lane: "correctness", affectedPath: "source.mjs", evidence: "Seen in the diff.", conditionToClose: "The case is handled.", ...finding })), { op: "submit_lane", lane: "correctness", status: "FINDINGS" }]);
  return { root, slice, review };
}

async function ask(root, { slice = INITIATIVE, options = OPTIONS } = {}) {
  const current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  const result = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes: { gateOperations: [{ op: "ask", kind: "decision", slice, question: "How should the review continue?", context: "Two waves ran, and the remaining findings are low.", options, recommended: { option: options.at(-1).id, reason: "Only low findings remain." } }] } });
  return result.openedGates[0].id;
}

const answer = (root, id, choice) => answerUserGate({ projectRoot: root, initiative: INITIATIVE, id, choice });
const LOW = [{ localId: "L1", title: "Log line names the wrong report", severity: "low" }, { localId: "L2", title: "Help text has a typo", severity: "low" }];
const deferAll = (gate, ids = ["L1", "L2"]) => ({ op: "accept_wave", gate, deferrals: ids.map((id) => ({ finding: findingId(id), followUp: `#${100 + Number(id.slice(1))}` })) });

test("clauses 2, 5, 6, 7: an accepted wave records each low finding as deferred with its gate and follow-up, and the slice can complete", async (context) => {
  const { root, slice, review } = await reviewed(context, LOW);
  const gate = await ask(root);
  await answer(root, gate, "accept-deferred");
  const result = await review(coordinator, [{ op: "accept_wave", gate, deferrals: [{ finding: findingId("L1"), followUp: "  #101  " }, { finding: findingId("L2"), followUp: "#102" }] }]);
  assert.equal(result.accepted, true);
  const findings = (await getReview(slice)).entries;
  for (const [local, followUp] of [["L1", "#101"], ["L2", "#102"]]) {
    const finding = findings.find((item) => item.localId === local);
    assert.equal(finding.status, "DEFERRED");
    assert.equal(finding.deferral.gate, gate);
    assert.equal(finding.deferral.followUp, followUp, "the follow-up is kept trimmed");
    assert.equal(finding.deferral.wave, "w1");
    assert.equal(finding.deferral.actor, coordinator.id);
    assert.ok(!Number.isNaN(Date.parse(finding.deferral.at)));
    const last = finding.history.at(-1);
    assert.equal(last.status, "DEFERRED");
    assert.equal(last.actor, coordinator.id);
    assert.equal(last.wave, "w1");
  }
  const reviewRecord = await getReview({ ...slice, section: "waves" });
  assert.equal(reviewRecord.entries[0].lanes[0].result.status, "FINDINGS", "the lane keeps the result its reviewer submitted");
  const gateResult = await checkReviewGate({ ...slice, gate: "completion" });
  assert.equal(gateResult.ready, true, JSON.stringify(gateResult.problems));
  assert.equal((await checkSliceGate({ ...slice, gate: "completion" })).ready, true);
  await initiativeUpdate(root, [{ op: "set_status", slug: INITIATIVE, status: "done" }]);
  assert.equal((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices[INITIATIVE].status, "done");
});

test("clause 2: gate and deferrals come together, and a finding is named once", async (context) => {
  const { root, slice, review } = await reviewed(context, LOW);
  const gate = await ask(root);
  await answer(root, gate, "accept-deferred");
  const before = (await getReview(slice)).revision;
  await assert.rejects(review(coordinator, [{ op: "accept_wave", gate }]), (error) => error.code === "validation_failed");
  await assert.rejects(review(coordinator, [{ op: "accept_wave", deferrals: [{ finding: findingId("L1"), followUp: "#1" }, { finding: findingId("L2"), followUp: "#2" }] }]), (error) => error.code === "validation_failed");
  await assert.rejects(review(coordinator, [{ op: "accept_wave", gate, deferrals: [{ finding: findingId("L1"), followUp: "#1" }, { finding: findingId("L1"), followUp: "#2" }, { finding: findingId("L2"), followUp: "#3" }] }]), (error) => error.code === "validation_failed");
  assert.equal((await getReview(slice)).revision, before, "a refused acceptance changes no record");
});

test("clauses 3, 4: deferring a finding that is not low is refused, names the finding and the reason, and changes no record", async (context) => {
  const { root, slice, review } = await reviewed(context, [...LOW, { localId: "H1", title: "Signature is not checked", severity: "high" }]);
  const gate = await ask(root);
  await answer(root, gate, "accept-deferred");
  const before = (await getReview(slice)).revision;
  await assert.rejects(review(coordinator, [deferAll(gate, ["L1", "L2", "H1"])]), (error) => {
    assert.equal(error.code, "deferral_refused");
    assert.deepEqual(error.problems.map((problem) => [problem.code, problem.finding]), [["severity_not_low", findingId("H1")]]);
    assert.match(error.message, new RegExp(`${findingId("H1")}: `));
    return true;
  });
  assert.equal((await getReview(slice)).revision, before);
  assert.ok((await getReview(slice)).entries.every((finding) => finding.status === "OPEN"));
});

test("clauses 3, 4: an unresolved finding left out, or a follow-up that is empty or too long, is refused as follow_up_missing", async (context) => {
  const { root, slice, review } = await reviewed(context, LOW);
  const gate = await ask(root);
  await answer(root, gate, "accept-deferred");
  const before = (await getReview(slice)).revision;
  await assert.rejects(review(coordinator, [deferAll(gate, ["L1"])]), (error) => error.code === "deferral_refused" && error.problems.length === 1 && error.problems[0].code === "follow_up_missing" && error.problems[0].finding === findingId("L2"));
  for (const followUp of ["   ", "x".repeat(501)]) {
    await assert.rejects(review(coordinator, [{ op: "accept_wave", gate, deferrals: [{ finding: findingId("L1"), followUp: "#1" }, { finding: findingId("L2"), followUp }] }]), (error) => error.code === "deferral_refused" && error.problems.some((problem) => problem.code === "follow_up_missing" && problem.finding === findingId("L2")));
  }
  assert.equal((await getReview(slice)).revision, before);
});

test("clauses 3, 4: a named finding that is not unresolved is refused as finding_not_unresolved", async (context) => {
  const { root, slice, review } = await reviewed(context, [...LOW, { localId: "L3", title: "Spacing in output", severity: "low" }]);
  await review(delivery, [{ op: "set_finding_status", id: findingId("L3"), status: "FIXED", evidence: "Fixed the spacing." }]);
  await review(reviewerOf("w1"), [{ op: "set_finding_status", id: findingId("L3"), status: "VERIFIED", evidence: "Spacing is right." }]);
  const gate = await ask(root);
  await answer(root, gate, "accept-deferred");
  const before = (await getReview(slice)).revision;
  await assert.rejects(review(coordinator, [deferAll(gate, ["L1", "L2", "L3"])]), (error) => error.code === "deferral_refused" && error.problems.length === 1 && error.problems[0].code === "finding_not_unresolved" && error.problems[0].finding === findingId("L3"));
  assert.equal((await getReview(slice)).revision, before);
  await assert.rejects(review(coordinator, [{ op: "accept_wave", gate, deferrals: [{ finding: findingId("L1"), followUp: "#1" }, { finding: findingId("L2"), followUp: "#2" }, { finding: findingId("L3"), followUp: "#3" }, { finding: "implementation-review/correctness/NOPE", followUp: "#4" }] }]), (error) => error.code === "deferral_refused" && error.problems.some((problem) => problem.code === "finding_not_unresolved" && problem.finding === "implementation-review/correctness/NOPE"));
});

test("clauses 3, 4: a gate that is unanswered, chose another option, belongs to another slice, or was asked before the latest wave is refused as gate_invalid for every named finding", async (context) => {
  const { root, slice, review } = await reviewed(context, LOW);
  const expectInvalid = async (gate) => assert.rejects(review(coordinator, [deferAll(gate)]), (error) => {
    assert.equal(error.code, "deferral_refused");
    assert.deepEqual(error.problems.filter((problem) => problem.code === "gate_invalid").map((problem) => problem.finding), [findingId("L1"), findingId("L2")]);
    return true;
  });
  const early = await ask(root);
  await answer(root, early, "accept-deferred");
  await review(coordinator, [{ op: "start_wave", id: "w2", mode: "implementation-review", lanes: lanes("w2") }]);
  await review(reviewerOf("w2"), [{ op: "submit_lane", lane: "correctness", status: "FINDINGS" }]);
  await expectInvalid(early);
  const unanswered = await ask(root);
  await expectInvalid(unanswered);
  const other = await ask(root);
  await answer(root, other, "continue-review");
  await expectInvalid(other);
  const elsewhere = await ask(root, { slice: "audit" });
  await answer(root, elsewhere, "accept-deferred");
  await expectInvalid(elsewhere);
  await expectInvalid("gate-0123456789ab");
  assert.ok((await getReview(slice)).entries.every((finding) => finding.status === "OPEN"));
});

test("clause 1: a gate answered in conversation is resolved with its choice, which a deferral accepts", async (context) => {
  const { root, slice, review } = await reviewed(context, LOW);
  const gate = await ask(root);
  const resolve = async (operation) => {
    const current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
    return updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes: { gateOperations: [{ op: "resolve", ...operation }] } });
  };
  await assert.rejects(resolve({ id: gate, choice: "narrow", reason: "The user answered in chat." }), (error) => error.code === "invalid_changes");
  await assert.rejects(resolve({ id: gate, choice: "accept-deferred" }), (error) => error.code === "invalid_changes", "an unanswered gate still needs a reason");
  const current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes: { gateOperations: [{ op: "ask", kind: "assistance", question: "Run the setup?", context: "The command needs a person." }] } });
  const assistance = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((item) => item.kind === "assistance").id;
  await assert.rejects(resolve({ id: assistance, choice: "accept-deferred", reason: "Done in chat." }), (error) => error.code === "invalid_changes");
  await resolve({ id: gate, choice: "accept-deferred", reason: "The user chose to accept the low findings in chat." });
  const closed = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.closed.find((item) => item.id === gate);
  assert.equal(closed.choice, "accept-deferred");
  assert.equal((await review(coordinator, [deferAll(gate)])).accepted, true);
  assert.ok((await getReview(slice)).entries.every((finding) => finding.status === "DEFERRED"));
});

test("clause 8: a deferred finding cannot change status or be revised", async (context) => {
  const { root, review } = await reviewed(context, LOW);
  const gate = await ask(root);
  await answer(root, gate, "accept-deferred");
  await review(coordinator, [deferAll(gate)]);
  await assert.rejects(review(reviewerOf("w1"), [{ op: "set_finding_status", id: findingId("L1"), status: "REOPENED", evidence: "Still wrong." }]), (error) => error.code === "gate_blocked" && error.message.includes(gate));
  await assert.rejects(review(delivery, [{ op: "set_finding_status", id: findingId("L1"), status: "FIXED", evidence: "Fixed." }]), (error) => error.code === "gate_blocked" && error.message.includes(gate));
  await assert.rejects(review(coordinator, [{ op: "revise_finding", id: findingId("L1"), conditionToClose: "Another condition.", reason: "x" }]), (error) => error.code === "gate_blocked" && error.message.includes(gate));
});

test("clauses 9, 10, 11: get_review, get_initiative, and review.md show each deferred finding with its gate and follow-up", async (context) => {
  const { root, slice, review } = await reviewed(context, LOW);
  const empty = await getReview(slice);
  assert.deepEqual(empty.deferred, []);
  const gate = await ask(root);
  await answer(root, gate, "accept-deferred");
  await review(coordinator, [deferAll(gate)]);
  const expected = LOW.map((finding) => ({ id: findingId(finding.localId), severity: "low", title: finding.title, gate, followUp: `#${100 + Number(finding.localId.slice(1))}`, wave: "w1" }));
  for (const section of [undefined, "waves", "history"]) {
    const read = await getReview({ ...slice, ...(section ? { section } : {}) });
    assert.deepEqual(read.deferred, expected, `section ${section ?? "findings"}`);
  }
  const initiative = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  assert.deepEqual(initiative.derived.deferredFindings, { [INITIATIVE]: expected });
  const markdown = await readFile(path.join(root, "docs/plans", INITIATIVE, "review.md"), "utf8");
  assert.match(markdown, /- Status: DEFERRED/);
  assert.ok(markdown.includes(`- Deferred: gate ${gate}, follow-up #101`));
  assert.ok(markdown.includes(`- Deferred: gate ${gate}, follow-up #102`));
});

test("clause 10: get_initiative leaves out slices without a deferred finding", async (context) => {
  const { root } = await reviewed(context, LOW);
  const initiative = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  assert.deepEqual(initiative.derived.deferredFindings, {});
});
