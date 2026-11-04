import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { splitEvidence } from "./fixtures/split-evidence.mjs";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-verify-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
// Claude Code sets this in a cloud session; each test sets it only where it checks chat approval.
delete process.env.CLAUDE_CODE_REMOTE;
const { getInitiative, initiativeAcknowledgement, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { failingTests, verificationBrief, verifySlice } = await import("../../dist/server/workflow/verification.mjs");
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
    { op: "split", parent: INITIATIVE, children: [{ slug: "download", title: "Download reports", requirements: ["req.md#R1"] }, { slug: "audit", title: "Audit downloads", requirements: ["req.md#R2"] }], evidence: await splitEvidence(root, `docs/plans/${INITIATIVE}`, "download") }
  ] });
  return root;
}

async function initiativeUpdate(root, operations) {
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  return updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations });
}

// A started slice keeps its frozen tests in place when its design is accepted.
const accept = (root, slug = "download", review = "none") => initiativeUpdate(root, [{ op: "set_status", slug, status: "in-progress" }, { op: "accept_design", slug, frozenTests: ["test/acceptance.test.mjs"], review }]);

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
  const split = await initiativeUpdate(root, [{ op: "split", parent: "download", children: [{ slug: "download-zip", title: "Zip download", requirements: ["req.md#R1"] }], evidence: await splitEvidence(root, "docs/plans/reports/download", "download-zip") }]);
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

function inCloud(context) {
  process.env.CLAUDE_CODE_REMOTE = "true";
  context.after(() => { delete process.env.CLAUDE_CODE_REMOTE; });
}

test("in a cloud session the agent records the user's chat approval with their words", async (context) => {
  const root = await project(context);
  await accept(root);
  inCloud(context);
  const asked = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" });
  assert.equal(asked.status, "approval_needed");
  assert.equal(asked.chatApproval, true);
  assert.match(asked.message, /cannot open the review browser/);
  await assert.rejects(verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", chatApproval: { quote: "Yes, run it." } }), /pass that gate's id as approvalGate/);
  const passed = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: asked.gateId, chatApproval: { quote: "Yes, run it." } });
  assert.equal(passed.status, "passed");
  const state = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state;
  assert.equal(state.pending.length, 0);
  assert.match(state.closed.find((item) => item.id === asked.gateId).reason, /in chat.*"Yes, run it\."/);
  const approvals = JSON.parse(await readFile(path.join(privateData, "verification-approvals.json"), "utf8"));
  assert.ok(Object.values(approvals.approved).some((item) => item.gate === asked.gateId && item.via === "chat" && item.quote === "Yes, run it."));
});

test("a session that can open the review browser refuses chat approval", async (context) => {
  const root = await project(context);
  await accept(root);
  const asked = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" });
  assert.equal(asked.chatApproval, undefined);
  await assert.rejects(verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: asked.gateId, chatApproval: { quote: "Yes." } }), (error) => error.code === "chat_approval_unavailable");
});

test("an approval answer with a note and no choice neither allows nor declines", async (context) => {
  const root = await project(context);
  await accept(root);
  const asked = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" });
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, note: "What does it run?" });
  const unclear = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: asked.gateId });
  assert.equal(unclear.status, "approval_unclear");
  assert.equal(unclear.note, "What does it run?");
  assert.equal((await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" })).status, "approval_needed", "the next call asks again");
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

test("a passing run completes the slice, and only project content changes make its gate stale", async (context) => {
  const root = await project(context);
  await accept(root);
  const gateId = await approve(root);
  const passed = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: gateId });
  assert.equal(passed.status, "passed");
  assert.equal(passed.sliceStatus, "done", "a slice whose design marks no review completes on its passing run");
  assert.equal(verificationBrief(passed).initiativeRevision, (await getInitiative({ projectRoot: root, initiative: INITIATIVE })).revision, "the caller gets the revision the completion wrote");
  assert.equal((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices.download.status, "done");
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
  await initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "in-progress" }]);
  await assert.rejects(initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "done" }]), /changed after the verification run/);
  assert.equal((await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" })).status, "passed", "an approved command runs without asking again");
  assert.equal((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices.download.status, "done");
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

test("the test command inherits neither the server's proxy setting nor the host's plugin directories", async (context) => {
  const root = await project(context, `${node} env.mjs`);
  const serverOnly = ["NODE_USE_ENV_PROXY", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "PLUGIN_ROOT"];
  await writeFile(path.join(root, "env.mjs"), `const leaked = ${JSON.stringify(serverOnly)}.filter((name) => process.env[name] !== undefined);\nif (leaked.length) console.log(leaked.join(" "));\nprocess.exit(leaked.length ? 3 : process.env.PRISM_KEPT === "1" ? 0 : 4);\n`);
  await accept(root);
  const gateId = await approve(root);
  const previous = Object.fromEntries([...serverOnly, "PRISM_KEPT"].map((name) => [name, process.env[name]]));
  for (const name of serverOnly) process.env[name] = name.includes("PROXY") ? "1" : path.join(root, "host");
  process.env.PRISM_KEPT = "1";
  context.after(() => { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  const result = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: gateId, dataDirectory: privateData });
  assert.equal(result.status, "passed", result.outputTail);
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
  assert.equal((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices.download.status, "in-progress", "a slice that requires review never completes on a run alone");
  await writeFile(path.join(root, "test", "audit.test.mjs"), "// frozen audit test\n");
  await initiativeUpdate(root, [{ op: "set_status", slug: "audit", status: "in-progress" }, { op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "none" }]);
  assert.equal((await checkSliceGate({ projectRoot: root, initiative: INITIATIVE, slice: "audit", gate: "completion" })).problems[0].code, "verification_missing");
});

test("a review stops for the user after two waves with findings, and a finding the contract causes goes back to design", async (context) => {
  const root = await project(context);
  await accept(root, "download", "required");
  const slice = { projectRoot: root, initiative: INITIATIVE, slice: "download" };
  const review = async (actor, operations, extra = {}) => updateReview({ ...slice, expectedRevision: (await getReview(slice)).revision, actor, operations, ...extra });
  const coordinator = { id: "orchestrator", role: "coordinator" }, delivery = { id: "Develop download", role: "delivery" };
  const lanes = (wave) => [{ id: "correctness", reviewer: `Review ${wave}`, coverage: ["."] }];
  const reviewer = (wave) => ({ id: `Review ${wave}`, role: "reviewer" });
  assert.equal((await verifySlice({ ...slice, approvalGate: await approve(root) })).status, "passed");
  const round = async (wave, extra = {}) => {
    await review(coordinator, [{ op: "start_wave", id: wave, mode: "implementation-review", lanes: lanes(wave), ...extra }], wave === "w1" ? { delivery: "Develop download" } : {});
    await review(reviewer(wave), [{ op: "open_finding", lane: "correctness", localId: "F", title: `Edge case ${wave}`, severity: "high", affectedPath: "source.mjs", evidence: "Wrong.", conditionToClose: "Right." }, { op: "submit_lane", lane: "correctness", status: "FINDINGS" }]);
    await review(delivery, [{ op: "set_finding_status", id: "implementation-review/correctness/F", status: "FIXED", evidence: "Fixed." }].filter(() => wave === "w1"));
  };
  await round("w1");
  await review(coordinator, [{ op: "start_wave", id: "w2", mode: "implementation-review", lanes: lanes("w2") }]);
  await assert.rejects(review(coordinator, [{ op: "start_wave", id: "w3", mode: "implementation-review", lanes: lanes("w3") }]), (error) => error.code === "gate_blocked" && /2 review waves since its design was accepted/.test(error.message));
  const ask = async () => {
    const current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
    const before = new Set((current.state?.pending ?? []).map((gate) => gate.id));
    await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes: { gateOperations: [{ op: "ask", kind: "decision", slice: "download", question: "Keep reviewing?", options: [{ id: "continue", label: "Continue" }, { id: "redesign", label: "Back to design" }] }] } });
    return (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((gate) => !before.has(gate.id)).id;
  };
  const first = await ask();
  await assert.rejects(review(coordinator, [{ op: "start_wave", id: "w3", mode: "implementation-review", lanes: lanes("w3"), afterGate: first }]), /that the user answered/, "an unanswered gate does not let the loop go on");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: first, choice: "continue" });
  await review(coordinator, [{ op: "start_wave", id: "w3", mode: "implementation-review", lanes: lanes("w3"), afterGate: first }]);
  await assert.rejects(review(coordinator, [{ op: "start_wave", id: "w4", mode: "implementation-review", lanes: lanes("w4"), afterGate: first }]), /its own answered decision gate/);
  await review(reviewer("w3"), [{ op: "open_finding", lane: "correctness", localId: "C6", title: "Clause 6 drops attributed files", severity: "high", affectedPath: "source.mjs", evidence: "Any code meeting clause 6 misses this case.", conditionToClose: "The contract handles attributed files.", clause: "Contract 6" }]);
  const second = await ask();
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: second, choice: "continue" });
  await assert.rejects(review(coordinator, [{ op: "start_wave", id: "w4", mode: "implementation-review", lanes: lanes("w4"), afterGate: second }]), (error) => error.code === "gate_blocked" && /name contract clauses \(Contract 6\)/.test(error.message) && /contractDefects/.test(error.message));
  assert.equal((await getReview(slice)).entries.find((item) => item.localId === "C6").clause, "Contract 6");
});

test("review errors say which worker and which revision form an update needs", async (context) => {
  const root = await project(context);
  await accept(root, "download", "required");
  const slice = { projectRoot: root, initiative: INITIATIVE, slice: "download" };
  const lanes = [{ id: "correctness", reviewer: "Review download", coverage: ["."] }];
  await assert.rejects(updateReview({ ...slice, expectedRevision: null, actor: { id: "orchestrator", role: "coordinator" }, operations: [{ op: "start_wave", id: "w1", mode: "implementation-review", lanes }] }), /the implementer's worker id as delivery/);
  await assert.rejects(updateReview({ ...slice, expectedRevision: "abc1234", actor: { id: "orchestrator", role: "coordinator" }, operations: [{ op: "accept_wave" }] }), /expectedRevision: must be the full 64-character SHA-256 revision/);
});

const exists = (file) => readFile(file).then(() => true, () => false);

test("frozen tests of slices that have not started are staged and go in place when each slice starts", async (context) => {
  const root = await project(context);
  await writeFile(path.join(root, "test", "audit.test.mjs"), "// frozen audit test\n");
  const operations = [
    { op: "accept_design", slug: "download", frozenTests: ["test/acceptance.test.mjs"], review: "none" },
    { op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "none" }
  ];
  const result = await initiativeUpdate(root, operations);
  const brief = initiativeAcknowledgement(result, operations);
  assert.equal(brief.record, undefined, "the acknowledgement leaves the record to get_initiative");
  assert.deepEqual(brief.slices, { download: { status: "not-started", design: "staged", frozenTests: 1, review: "none" }, audit: { status: "not-started", design: "staged", frozenTests: 1, review: "none" } });
  assert.deepEqual(brief.stagedTests.sort(), ["test/acceptance.test.mjs", "test/audit.test.mjs"]);
  assert.equal(await exists(path.join(root, "test", "audit.test.mjs")), false, "a staged file leaves the work tree until its slice starts");
  await assert.rejects(verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "audit" }), /has not started/);
  await assert.rejects(initiativeUpdate(root, [{ op: "accept_design", slug: "download", frozenTests: ["test/audit.test.mjs"], review: "none" }]), /does not exist/);
  const restored = await initiativeUpdate(root, [{ op: "restore_tests", slug: INITIATIVE }]);
  assert.deepEqual(restored.installed.sort(), ["test/acceptance.test.mjs", "test/audit.test.mjs"], "a revision gets every staged test of the contract back");
  await assert.rejects(initiativeUpdate(root, [{ op: "accept_design", slug: "download", frozenTests: ["test/audit.test.mjs"], review: "none" }]), /already belongs to another slice/);
  const restaged = await initiativeUpdate(root, operations);
  assert.deepEqual(restaged.withdrawn.sort(), ["test/acceptance.test.mjs", "test/audit.test.mjs"]);
  const started = await initiativeUpdate(root, [{ op: "set_status", slug: "audit", status: "in-progress" }]);
  assert.deepEqual(started.installed, ["test/audit.test.mjs"]);
  assert.equal(await readFile(path.join(root, "test", "audit.test.mjs"), "utf8"), "// frozen audit test\n");
  assert.equal(started.record.slices.audit.design.staged, undefined);
  const gateId = await approve(root, "audit");
  const passed = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "audit", approvalGate: gateId });
  assert.equal(passed.status, "passed");
  assert.equal(passed.sliceStatus, "done");
  await assert.rejects(initiativeUpdate(root, [{ op: "accept_design", slug: "download", frozenTests: ["test/audit.test.mjs"], review: "none" }]), /already belongs to another slice;/, "a staged slice never shares a file, even with a done slice");
});

test("a started slice that returns to not-started stages its tests again, even after they were removed by hand", async (context) => {
  const root = await project(context);
  await initiativeUpdate(root, [{ op: "accept_design", slug: "download", frozenTests: ["test/acceptance.test.mjs"], review: "none" }]);
  await initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "in-progress" }]);
  await writeFile(path.join(root, "test", "acceptance.test.mjs"), "// edited by an implementer\n");
  await assert.rejects(initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "not-started" }]), (error) => error.code === "frozen_tests_changed", "a changed frozen test is never taken out of the work tree");
  await rm(path.join(root, "test", "acceptance.test.mjs"));
  const returned = await initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "not-started" }]);
  assert.deepEqual(returned.withdrawn, ["test/acceptance.test.mjs"]);
  assert.equal(returned.record.slices.download.design.staged, true);
  assert.equal(returned.record.slices.download.design.baselineId, undefined);
  assert.equal(await exists(path.join(root, "test", "acceptance.test.mjs")), false);
  const restarted = await initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "in-progress" }]);
  assert.deepEqual(restarted.installed, ["test/acceptance.test.mjs"]);
  assert.equal(await readFile(path.join(root, "test", "acceptance.test.mjs"), "utf8"), "// frozen acceptance test\n");
});

test("a design accepted after its slice started is staged when the slice returns to not-started", async (context) => {
  const root = await project(context);
  await accept(root);
  const returned = await initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "not-started" }]);
  assert.deepEqual(returned.withdrawn, ["test/acceptance.test.mjs"]);
  assert.equal(await exists(path.join(root, "test", "acceptance.test.mjs")), false);
});

test("a slice starts only after the slices it depends on are done", async (context) => {
  const root = await project(context);
  await initiativeUpdate(root, [{ op: "set_dependencies", slug: "audit", dependencies: ["download"] }]);
  await assert.rejects(initiativeUpdate(root, [{ op: "set_status", slug: "audit", status: "in-progress" }]), (error) => error.code === "dependencies_incomplete" && error.waiting.join() === "download");
  await accept(root);
  const gateId = await approve(root);
  assert.equal((await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: gateId })).sliceStatus, "done");
  const started = await initiativeUpdate(root, [{ op: "set_status", slug: "audit", status: "in-progress" }]);
  assert.equal(started.record.slices.audit.status, "in-progress");
});

test("staging another slice's tests does not make a passing verification stale", async (context) => {
  const root = await project(context);
  await accept(root, "download", "required");
  const gateId = await approve(root);
  await writeFile(path.join(root, "test", "audit.test.mjs"), "// frozen audit test\n");
  assert.equal((await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: gateId })).status, "passed");
  const staged = await initiativeUpdate(root, [{ op: "accept_design", slug: "audit", frozenTests: ["test/audit.test.mjs"], review: "none" }]);
  assert.deepEqual(staged.withdrawn, ["test/audit.test.mjs"]);
  const gate = await checkSliceGate({ projectRoot: root, initiative: INITIATIVE, slice: "download", gate: "completion" });
  assert.equal(gate.problems.some((problem) => problem.code === "verification_stale"), false);
  await writeFile(path.join(root, "source.mjs"), "export const value = 2;\n");
  const stale = await checkSliceGate({ projectRoot: root, initiative: INITIATIVE, slice: "download", gate: "completion" });
  assert.equal(stale.problems.some((problem) => problem.code === "verification_stale"), true, "any other change still makes the run stale");
});

test("accepting and starting a slice in one update keeps its tests in place", async (context) => {
  const root = await project(context);
  const result = await initiativeUpdate(root, [{ op: "accept_design", slug: "download", frozenTests: ["test/acceptance.test.mjs"], review: "none" }, { op: "set_status", slug: "download", status: "in-progress" }]);
  assert.deepEqual(result.withdrawn, []);
  assert.equal(result.record.slices.download.design.staged, undefined);
  assert.equal(await exists(path.join(root, "test", "acceptance.test.mjs")), true);
});

test("an update that fails keeps the tests that an earlier update staged", async (context) => {
  const root = await project(context);
  await initiativeUpdate(root, [{ op: "accept_design", slug: "download", frozenTests: ["test/acceptance.test.mjs"], review: "none" }]);
  await initiativeUpdate(root, [{ op: "restore_tests", slug: "download" }]);
  await writeFile(path.join(root, "test", "acceptance.test.mjs"), "// revised\n");
  await assert.rejects(initiativeUpdate(root, [{ op: "accept_design", slug: "download", frozenTests: ["test/acceptance.test.mjs"], review: "none" }, { op: "set_status", slug: "missing", status: "done" }]), /does not exist/);
  await rm(path.join(root, "test", "acceptance.test.mjs"));
  const started = await initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "in-progress" }]);
  assert.deepEqual(started.installed, ["test/acceptance.test.mjs"]);
  assert.equal(await readFile(path.join(root, "test", "acceptance.test.mjs"), "utf8"), "// frozen acceptance test\n");
});

test("accepting a design refuses a diagram that does not parse or shows too many elements", async (context) => {
  const root = await project(context);
  const folder = path.join(root, "docs", "plans", "reports", "download");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "code.puml"), "@startuml\nclass A {\nA -->> B ::\n@enduml\n");
  await assert.rejects(accept(root), /code\.puml line 2 does not parse/);
  await writeFile(path.join(folder, "code.puml"), `@startuml\n${Array.from({ length: 31 }, (_, index) => `class C${index}`).join("\n")}\n@enduml\n`);
  await assert.rejects(accept(root), /shows 31 elements, more than 30/);
  await writeFile(path.join(folder, "code.puml"), "@startuml\n!include <C4/Missing>\n@enduml\n");
  await assert.rejects(accept(root), /code\.puml line 2 does not parse: cannot include <C4\/Missing>/);
  await writeFile(path.join(folder, "code.puml"), "class Report\n");
  await assert.rejects(accept(root), /code\.puml does not parse: PlantUML does not recognize the diagram/);
  await writeFile(path.join(folder, "code.puml"), "@startuml\nclass Report\nclass Signer\nReport --> Signer\n@enduml\n");
  await writeFile(path.join(root, "docs", "plans", "reports", "overview.puml"), "@startuml\npackage download {\n[Report]\n}\npackage audit {\n[Log]\n}\n[Log] ..> [Report]\n@enduml\n");
  const operations = [{ op: "set_status", slug: "download", status: "in-progress" }, { op: "accept_design", slug: "download", frozenTests: ["test/acceptance.test.mjs"], review: "none" }];
  const brief = initiativeAcknowledgement(await initiativeUpdate(root, operations), operations);
  assert.deepEqual(brief.diagrams, [
    { path: "docs/plans/reports/download/code.puml", elements: 2, relations: 1 },
    { path: "docs/plans/reports/overview.puml", elements: 4, relations: 1 }
  ]);
});

test("a brief verification names the failing tests and the full log", async (context) => {
  const output = ["running 3 tests", "test tui::resize ... FAILED", "test tui::draw ... ok", "not ok 2 - renders the header", "FAILED tests/test_app.py::test_quit - assert 1 == 0", "--- FAIL: TestPane (0.00s)", "  ✖ keeps the cursor (3.2ms)"].join("\n");
  assert.deepEqual(failingTests(output), ["tui::resize", "renders the header", "tests/test_app.py::test_quit", "TestPane", "keeps the cursor"]);
  const brief = verificationBrief({ status: "failed", passed: false, reason: "command_failed", message: "The test command failed.", durationMs: 5, path: ".prism/run.json", log: "/data/run.log", outputTail: `${"x".repeat(5000)}\n${output}`, tree: "abc", frozen: { checked: 1, changed: [], missing: [] } });
  assert.deepEqual(brief.failing.length, 5);
  assert.equal(brief.log, "/data/run.log");
  assert.equal(brief.tree, undefined);
  assert.ok(brief.outputTail.length <= 1500);
  const root = await project(context);
  await writeFile(path.join(root, "check.mjs"), "console.log(\"not ok 1 - signs the report\");\nprocess.exit(3);\n");
  await accept(root);
  const gateId = await approve(root);
  const failed = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: gateId });
  assert.equal(failed.status, "failed");
  assert.deepEqual(verificationBrief(failed).failing, ["signs the report"]);
  assert.match(await readFile(failed.log, "utf8"), /not ok 1 - signs the report/);
  assert.equal(failed.log.startsWith(privateData), true, "the full log stays in plugin data, outside the project");
});

test("a failing run names failures that scrolled out of the kept output, including nested subtests", async (context) => {
  assert.deepEqual(failingTests(["    not ok 2 - keeps the cursor", "not ok 3 - waits for the network # TODO", "not ok 4 - skipped on Windows # SKIP"].join("\n")), ["keeps the cursor"]);
  const root = await project(context);
  const script = [
    "console.log(\"TAP version 13\");",
    "console.log(\"# Subtest: download\");",
    "console.log(\"    not ok 1 - signs the report\");",
    "console.error(\"not ok 2 - checks the archive\");",
    "for (let index = 0; index < 4000; index += 1) console.log(`ok ${index + 3} - passes case ${index}\\n  ---\\n  duration_ms: 1.25\\n  ...`);",
    "process.exitCode = 1;"
  ].join("\n");
  await writeFile(path.join(root, "check.mjs"), `${script}\n`);
  await accept(root);
  const failed = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: await approve(root) });
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(failed.outputTail, /signs the report/, "the failures are no longer in the kept output");
  const names = ["checks the archive", "signs the report"];
  assert.deepEqual([...failed.failing].sort(), names, "stdout and stderr are both read");
  assert.equal(failed.failingCount, 2);
  assert.deepEqual([...verificationBrief(failed).failing].sort(), names);
  const recorded = JSON.parse(await readFile(path.join(root, failed.path), "utf8"));
  assert.deepEqual([...recorded.failing].sort(), names, "the run record keeps the names for the slice page");
  const log = await readFile(failed.log, "utf8");
  assert.ok(log.length > 64 * 1024, `the log keeps more than the output kept in memory (${log.length})`);
  assert.match(log, /signs the report/);
  assert.match(log, /passes case 3999\n/, "the log holds the whole output, start to end");
});

test("an implementer's contract defects block the slice without running anything until design revises the contract", async (context) => {
  const root = await project(context);
  const defects = [{ clause: "Contract 2", reason: "The storage client raises on a missing key instead of returning None." }];
  await assert.rejects(verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", contractDefects: defects }), /has no accepted design/);
  await accept(root);
  await assert.rejects(verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", contractDefects: [] }), /arguments are invalid/);
  const reported = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", contractDefects: defects });
  assert.equal(reported.status, "defects_recorded", "no approval is asked, because nothing runs");
  assert.equal(reported.sliceStatus, "blocked");
  const run = JSON.parse(await readFile(path.join(root, reported.run), "utf8"));
  assert.equal(run.kind, "contract-defect");
  assert.deepEqual(run.defects, defects);
  const record = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  assert.equal(record.revision, reported.initiativeRevision);
  assert.equal(record.record.slices.download.status, "blocked");
  assert.deepEqual(record.record.slices.download.contractDefects.map(({ clause, reason }) => ({ clause, reason })), defects);
  const operations = [{ op: "accept_design", slug: "download", frozenTests: ["test/acceptance.test.mjs"], review: "none" }];
  const revised = await initiativeUpdate(root, operations);
  assert.equal(revised.record.slices.download.contractDefects, undefined, "the next accepted design clears the defects");
  assert.equal(revised.record.slices.download.design.staged, undefined, "a blocked slice keeps its tests in place");
  const restarted = await initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "in-progress" }]);
  assert.equal(restarted.record.slices.download.status, "in-progress");
  await assert.rejects(initiativeUpdate(root, [{ op: "report_contract_defects", slug: "audit", defects }]), /started slice with an accepted design/);
});

test("the acknowledgement counts a slice's contract defects", async (context) => {
  const root = await project(context);
  await accept(root);
  const operations = [{ op: "report_contract_defects", slug: "download", defects: [{ clause: "Contract 1", reason: "Bytes need a trailing newline." }] }];
  const brief = initiativeAcknowledgement(await initiativeUpdate(root, operations), operations);
  assert.equal(brief.slices.download.status, "blocked");
  assert.equal(brief.slices.download.contractDefects, 1);
});
