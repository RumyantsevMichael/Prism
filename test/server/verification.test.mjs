import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-verify-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { checkSliceGate } = await import("../../dist/server/workflow/slice-gate.mjs");
const { getReview, updateReview } = await import("../../dist/server/review/review-ledger.mjs");
const { answerUserGate, readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const node = process.execPath;

async function project(context, command = `${node} check.mjs`) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-verify-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${command}\n`);
  await writeFile(path.join(root, "check.mjs"), "process.exit(Number(process.env.PRISM_TEST_EXIT ?? 0));\n");
  await writeFile(path.join(root, "sleep.mjs"), "setTimeout(() => {}, Number(process.argv[2]));\n");
  await writeFile(path.join(root, "test", "acceptance.test.mjs"), "// frozen acceptance test\n");
  await writeFile(path.join(root, "source.mjs"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [
    { op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1", "req.md#R2"] },
    { op: "split", parent: INITIATIVE, children: [{ slug: "download", title: "Download reports", requirements: ["req.md#R1"] }, { slug: "audit", title: "Audit downloads", requirements: ["req.md#R2"] }] }
  ] });
  return root;
}

async function initiativeUpdate(root, operations) {
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  return updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations });
}

const accept = (root, slug = "download", review = "none") => initiativeUpdate(root, [{ op: "accept_design", slug, frozenTests: ["test/acceptance.test.mjs"], review }]);

async function approve(root, slice = "download", choice = "allow") {
  const asked = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice });
  assert.equal(asked.status, "approval_needed");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice, note: choice === "allow" ? null : "Not this command." });
  return asked.gateId;
}

test("accepting a design stores frozen test digests, the review mark, and a projection line", async (context) => {
  const root = await project(context);
  const result = await accept(root, "download", "required");
  const design = result.record.slices.download.design;
  assert.equal(design.review, "required");
  assert.deepEqual(design.frozenTests.map((item) => item.path), ["test/acceptance.test.mjs"]);
  assert.match(design.frozenTests[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(await readFile(path.join(root, "docs/plans/reports/initiative.md"), "utf8"), /Design accepted \d{4}-\d{2}-\d{2}: 1 frozen test files, review required/);
  await assert.rejects(initiativeUpdate(root, [{ op: "accept_design", slug: INITIATIVE, frozenTests: ["test/acceptance.test.mjs"], review: "none" }]), /split slice is designed through its children/);
  await assert.rejects(initiativeUpdate(root, [{ op: "accept_design", slug: "audit", frozenTests: ["test/missing.test.mjs"], review: "none" }]), /does not exist/);
  await assert.rejects(initiativeUpdate(root, [{ op: "accept_design", slug: "audit", frozenTests: ["../outside.mjs"], review: "none" }]), /normalized project-relative path/);
  const split = await initiativeUpdate(root, [{ op: "split", parent: "download", children: [{ slug: "download-zip", title: "Zip download", requirements: ["req.md#R1"] }] }]);
  assert.equal(split.record.slices.download.design, undefined);
});

test("a slice with an accepted design starts implementation without a design audit", async (context) => {
  const root = await project(context);
  assert.equal((await checkSliceGate({ projectRoot: root, initiative: INITIATIVE, slice: "download", gate: "implementation" })).ready, false);
  await accept(root);
  assert.equal((await checkSliceGate({ projectRoot: root, initiative: INITIATIVE, slice: "download", gate: "implementation" })).ready, true);
  const state = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, changes: { activeOperations: [{ op: "start", entry: { slice: "download", activity: "implementation", workers: ["Develop download"], workspace: "." } }] } });
  assert.equal(state.state.active[0].activity, "implementation");
});

test("verification needs an accepted design and a configured test command", async (context) => {
  const root = await project(context);
  await assert.rejects(verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" }), /no accepted design/);
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans\n");
  await accept(root);
  await assert.rejects(verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" }), /no test command/);
});

test("the first run of a command waits for the user's browser approval, and a decline runs nothing", async (context) => {
  const root = await project(context);
  await accept(root);
  const asked = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" });
  assert.equal(asked.status, "approval_needed");
  assert.equal(asked.command, `${node} check.mjs`);
  const gate = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((item) => item.id === asked.gateId);
  assert.match(gate.question, /check\.mjs/);
  assert.deepEqual(gate.options.map((option) => option.id), ["allow", "decline"]);
  const again = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" });
  assert.equal(again.gateId, asked.gateId, "an unanswered request is reused rather than asked twice");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "decline", note: "Not this command." });
  const declined = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: asked.gateId });
  assert.equal(declined.status, "declined");
  assert.equal(declined.note, "Not this command.");
  assert.equal((await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.length, 0, "the answered gate is resolved");
  await assert.rejects(readdir(path.join(root, ".prism/initiatives/reports/slices/download/runs")), { code: "ENOENT" });
});

test("an agent-opened gate answered Allow does not approve a command", async (context) => {
  const root = await project(context);
  await accept(root);
  const forged = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "decision", question: "Allow?", options: [{ id: "allow", label: "Allow" }] }] } });
  const forgedId = forged.openedGates[0].id;
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: forgedId, choice: "allow" });
  const result = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: forgedId });
  assert.equal(result.status, "approval_needed");
  assert.notEqual(result.gateId, forgedId);
});

test("a passing run completes the slice until project content changes, and record writes never make it stale", async (context) => {
  const root = await project(context);
  await accept(root);
  const gateId = await approve(root);
  const passed = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: gateId });
  assert.equal(passed.status, "passed");
  assert.equal(passed.exitCode, 0);
  assert.match(passed.tree, /^[0-9a-f]{40,64}$/);
  assert.deepEqual(passed.frozen, { checked: 1, changed: [], missing: [] });
  const stored = JSON.parse(await readFile(path.join(root, passed.path), "utf8"));
  assert.equal(stored.kind, "verification");
  assert.equal(stored.output, undefined, "the record keeps only the output tail");
  await initiativeUpdate(root, [{ op: "update_slice", slug: "download", outcome: "Users download signed reports." }]);
  assert.equal((await checkSliceGate({ projectRoot: root, initiative: INITIATIVE, slice: "download", gate: "completion" })).ready, true);
  await writeFile(path.join(root, "source.mjs"), "export const value = 2;\n");
  const stale = await checkSliceGate({ projectRoot: root, initiative: INITIATIVE, slice: "download", gate: "completion" });
  assert.deepEqual(stale.problems.map((problem) => problem.code), ["verification_stale"]);
  await assert.rejects(initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "done" }]), /changed after the verification run/);
  assert.equal((await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" })).status, "passed", "an approved command runs without asking again");
  const done = await initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "done" }]);
  assert.equal(done.record.slices.download.status, "done");
});

test("a failing command or a changed frozen test blocks completion", async (context) => {
  const root = await project(context);
  await accept(root);
  const gateId = await approve(root);
  process.env.PRISM_TEST_EXIT = "3";
  context.after(() => { delete process.env.PRISM_TEST_EXIT; });
  const failed = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: gateId });
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.reason, "command_failed");
  await assert.rejects(initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "done" }]), /did not pass/);
  delete process.env.PRISM_TEST_EXIT;
  await writeFile(path.join(root, "test", "acceptance.test.mjs"), "// weakened\n");
  const frozen = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" });
  assert.equal(frozen.reason, "frozen_tests_changed");
  assert.equal(frozen.exitCode, null, "the command does not run against changed frozen tests");
  assert.deepEqual(frozen.frozen.changed, ["test/acceptance.test.mjs"]);
});

test("a changed command asks again", async (context) => {
  const root = await project(context);
  await accept(root);
  const gateId = await approve(root);
  assert.equal((await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: gateId })).status, "passed");
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${node} check.mjs --again\n`);
  assert.equal((await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" })).status, "approval_needed");
});

test("the test command does not inherit the server's own proxy setting", async (context) => {
  const root = await project(context, `${node} env.mjs`);
  await writeFile(path.join(root, "env.mjs"), "process.exit(process.env.NODE_USE_ENV_PROXY === undefined ? 0 : 3);\n");
  await accept(root);
  const gateId = await approve(root);
  const previous = process.env.NODE_USE_ENV_PROXY;
  process.env.NODE_USE_ENV_PROXY = "1";
  context.after(() => { if (previous === undefined) delete process.env.NODE_USE_ENV_PROXY; else process.env.NODE_USE_ENV_PROXY = previous; });
  const result = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: gateId });
  assert.equal(result.status, "passed");
});

test("a run past its timeout fails, and an early return keeps the same run going", async (context) => {
  const root = await project(context, `${node} sleep.mjs 1500`);
  await accept(root);
  const gateId = await approve(root);
  const early = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: gateId, maxWaitMs: 100 });
  assert.equal(early.status, "running");
  const joined = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" });
  assert.equal(joined.status, "passed");
  assert.equal((await readdir(path.join(root, ".prism/initiatives/reports/slices/download/runs"))).length, 1, "the second call joined the first run");
  process.env.PRISM_VERIFY_TIMEOUT_MINUTES = "0.005";
  context.after(() => { delete process.env.PRISM_VERIFY_TIMEOUT_MINUTES; });
  const timedOut = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" });
  assert.equal(timedOut.reason, "timed_out");
  assert.equal(timedOut.timedOut, true);
});

test("cancelling the call stops the run", async (context) => {
  const root = await project(context, `${node} sleep.mjs 20000`);
  await accept(root);
  const gateId = await approve(root);
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  const cancelled = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: gateId, signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  assert.ok(Date.now() - started < 10000);
});

test("a slice whose design requires review completes on a review of its verified result", async (context) => {
  const root = await project(context);
  await accept(root, "download", "required");
  const slice = { projectRoot: root, initiative: INITIATIVE, slice: "download" };
  const review = async (actor, operations, extra = {}) => updateReview({ ...slice, expectedRevision: (await getReview(slice)).revision, actor, operations, ...extra });
  const coordinator = { id: "orchestrator", role: "coordinator" }, reviewer = { id: "Review download", role: "reviewer" }, delivery = { id: "Develop download", role: "delivery" };
  const lanes = [{ id: "security", reviewer: "Review download", coverage: ["."] }];
  await assert.rejects(review(coordinator, [{ op: "start_wave", id: "w1", mode: "implementation-review", lanes }], { delivery: "Develop download" }), /Run verify_slice until it passes/);
  const gateId = await approve(root);
  assert.equal((await verifySlice({ ...slice, approvalGate: gateId })).status, "passed");
  let gate = await checkSliceGate({ ...slice, gate: "completion" });
  assert.deepEqual(gate.problems.map((problem) => problem.code), ["evidence_missing"]);
  await review(coordinator, [{ op: "start_wave", id: "w1", mode: "implementation-review", base: "abc1234", lanes }], { delivery: "Develop download" });
  await review(reviewer, [{ op: "open_finding", lane: "security", localId: "F1", title: "Signature is not checked", severity: "high", affectedPath: "source.mjs", evidence: "No check.", conditionToClose: "Downloads check the signature." }]);
  await assert.rejects(review(reviewer, [{ op: "record_assessment", assessment: { id: "a1", lane: "security", kind: "manual", observationIds: ["x"], evidence: [{ path: "source.mjs" }], reason: "checked" } }]), /records findings and lane results only/);
  await review(delivery, [{ op: "set_finding_status", id: "implementation-review/security/F1", status: "FIXED", evidence: "Added the check." }]);
  await review(reviewer, [{ op: "set_finding_status", id: "implementation-review/security/F1", status: "VERIFIED", evidence: "Checked." }, { op: "submit_lane", lane: "security", status: "CLEAN" }]);
  await review(coordinator, [{ op: "accept_wave" }]);
  gate = await checkSliceGate({ ...slice, gate: "completion" });
  assert.equal(gate.ready, true, JSON.stringify(gate.problems));
  await writeFile(path.join(root, "source.mjs"), "export const value = 3;\n");
  assert.equal((await verifySlice(slice)).status, "passed");
  gate = await checkSliceGate({ ...slice, gate: "completion" });
  assert.deepEqual(gate.problems.map((problem) => problem.code), ["review_stale"]);
  await accept(root, "audit", "none");
  assert.equal((await checkSliceGate({ projectRoot: root, initiative: INITIATIVE, slice: "audit", gate: "completion" })).problems[0].code, "verification_missing");
});
