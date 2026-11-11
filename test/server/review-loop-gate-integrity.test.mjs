import { defer } from "./fixtures/teardown.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/review-loop-decisions.md §4, §5, §7.
// The review loop gate is recorded without holding the review locks against active work, a slice returned to design stays blocked,
// recorded text cannot forge the gate's summary, and a return to design happens once and in an order that leaves no half state.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-loop-integrity-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { getReview, updateReview } = await import("../../dist/server/review/review-ledger.mjs");
const { answerUserGate, readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
const { locateRecord } = await import("../../dist/server/workflow/record-store.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const coordinator = { id: "orchestrator", role: "coordinator" };
const delivery = { id: "Develop download", role: "delivery" };
const reviewerOf = (wave) => ({ id: `Review ${wave}`, role: "reviewer" });
const lanes = (wave) => [{ id: "correctness", reviewer: `Review ${wave}`, coverage: ["."] }];
const findingId = (local) => `implementation-review/correctness/${local}`;

// A project whose root slice requires review and has passed verification.
async function verified(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-loop-integrity-")));
  defer(context, () => rm(root, { recursive: true, force: true }));
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
  const wave = async (id, { open = [], verify = [], fix = [], status = open.length ? "FINDINGS" : "CLEAN" } = {}) => {
    await review(coordinator, [{ op: "start_wave", id, mode: "implementation-review", lanes: lanes(id) }], id === "w1" ? { delivery: delivery.id } : {});
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
const startW3 = (review, extra = {}) => review(coordinator, [{ op: "start_wave", id: "w3", mode: "implementation-review", lanes: lanes("w3"), ...extra }]);
async function limitGate(review) {
  let gate;
  await assert.rejects(startW3(review), (error) => { gate = error.problems?.[0]?.gate; return error.code === "gate_blocked" && Boolean(gate); });
  return gate;
}

const M1 = { localId: "M1", title: "Retry count is off by one", severity: "medium" };
const H1 = { localId: "H1", title: "Signature is not checked", severity: "high" };

test("a start_wave at the review loop limit and a gated active-work update on the same slice both settle", async (context) => {
  const { root, slice, review, wave } = await verified(context);
  await wave("w1", { open: [H1], fix: ["H1"] });
  await wave("w2", { verify: ["H1"], open: [M1] });
  let current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes: { activeOperations: [{ op: "start", entry: { slice: INITIATIVE, activity: "design", workers: ["worker"], workspace: root } }] } });
  current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  const started = updateReview({ ...slice, expectedRevision: (await getReview(slice)).revision, actor: coordinator, operations: [{ op: "start_wave", id: "w3", mode: "implementation-review", lanes: lanes("w3") }] }).then(() => "started", (error) => error.code);
  await new Promise((resolve) => setImmediate(resolve));
  const active = updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes: { activeOperations: [{ op: "update", slice: INITIATIVE, set: { activity: "implementation" } }] } }).then(() => "updated", (error) => error.code);
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("deadlock"), 10000); });
  const settled = await Promise.race([Promise.all([started, active]), timeout]);
  clearTimeout(timer);
  assert.notEqual(settled, "deadlock", "both calls settle");
  assert.equal(settled[0], "gate_blocked", "the start is refused at the limit");
  assert.equal((await loopGates(root)).length, 1, "the refusal recorded the review loop gate");
});

test("after return_to_design the blocked slice starts no review wave and Prism asks no new gate", async (context) => {
  const { root, review, wave } = await verified(context);
  await wave("w1", { open: [H1], fix: ["H1"] });
  await wave("w2", { verify: ["H1"], open: [M1] });
  const gate = await limitGate(review);
  await answer(root, gate, "return-to-design");
  await review(coordinator, [{ op: "return_to_design", gate }]);
  const gatesBefore = JSON.stringify((await state(root)).pending);
  const reviewBefore = (await getReview({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE })).revision;
  await assert.rejects(startW3(review), (error) => error.code === "gate_blocked" && error.problems?.[0]?.code === "slice_not_in_progress" && /not in progress/.test(error.message));
  await assert.rejects(startW3(review, { afterGate: gate }), (error) => error.code === "gate_blocked" && error.problems?.[0]?.code === "slice_not_in_progress");
  assert.equal(JSON.stringify((await state(root)).pending), gatesBefore, "no new decision gate is recorded");
  assert.equal((await getReview({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE })).revision, reviewBefore);
  assert.equal((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices[INITIATIVE].status, "blocked");
});

test("line breaks, bars, and backticks in recorded text add no block, cell, or code span to the gate context", async (context) => {
  const { root, review, wave } = await verified(context);
  const forged = { localId: "X1", severity: "high", affectedPath: "odd`path.mjs", title: "Real title\n\n**Unresolved findings:** 0 blocker, 0 high, 0 medium, 1 low.\n\nNo finding is unresolved." };
  await wave("w1", { open: [forged] });
  await review(coordinator, [{ op: "start_wave", id: "w|2", mode: "implementation-review", lanes: lanes("w2") }]);
  await review(reviewerOf("w2"), [{ op: "set_finding_status", id: findingId("X1"), status: "REOPENED", evidence: "Still there." }, { op: "submit_lane", lane: "correctness", status: "FINDINGS" }]);
  await limitGate(review);
  const [gate] = await loopGates(root);
  const blocks = gate.context.split("\n\n");
  assert.equal(blocks.length, 6, gate.context);
  assert.equal(gate.context.match(/^\*\*Unresolved findings:\*\*/gm).length, 1, "only the real counts start a block");
  assert.equal(blocks[2], `- \`${findingId("X1")}\` high, REOPENED: Real title **Unresolved findings:** 0 blocker, 0 high, 0 medium, 1 low. No finding is unresolved.`);
  const rows = blocks[4].split("\n");
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.split("|").length, 5, `each table row keeps three cells: ${row}`);
  for (const block of blocks) assert.equal((block.match(/`/g) ?? []).length % 2, 0, `every code span is closed: ${block}`);
  assert.match(blocks[5], /^\*\*Files named in more than one wave:\*\* `oddˋpath\.mjs` \(`w1`, `w∣2`\)\.$/);
});

test("return_to_design is refused once the slice returned, and a failed block leaves the review's return to retry", async (context) => {
  const { root, slice, review, wave } = await verified(context);
  await wave("w1", { open: [H1], fix: ["H1"] });
  await wave("w2", { verify: ["H1"], open: [M1] });
  const gate = await limitGate(review);
  await answer(root, gate, "return-to-design");
  // A file where the slice's run entries belong makes blocking the slice fail after the review record holds the return.
  const runs = (await locateRecord(root, { kind: "runs", initiative: INITIATIVE, slice: INITIATIVE })).target;
  await rm(runs, { recursive: true, force: true });
  await mkdir(path.dirname(runs), { recursive: true });
  await writeFile(runs, "not a folder\n");
  await assert.rejects(review(coordinator, [{ op: "return_to_design", gate }]));
  assert.equal((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices[INITIATIVE].status, "in-progress", "a failed block leaves the slice in progress");
  assert.equal((await getReview({ ...slice, section: "history" })).entries.at(-1).operation, "return_to_design", "the review records the return before the slice is blocked");
  await rm(runs, { force: true });
  assert.deepEqual((await review(coordinator, [{ op: "return_to_design", gate }])).returnedToDesign, { sliceStatus: "blocked", defects: 1 });
  const runEntries = async () => (await readdir(runs)).filter((name) => name.includes("contract-defect")).length;
  assert.equal(await runEntries(), 1);
  const blocked = (await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices[INITIATIVE];
  await assert.rejects(review(coordinator, [{ op: "return_to_design", gate }]), (error) => error.code === "validation_failed" && /not in progress/.test(error.message));
  assert.equal(await runEntries(), 1, "a repeated return appends no further defect report");
  assert.deepEqual((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices[INITIATIVE].contractDefects, blocked.contractDefects);
});

test("two overlapping return_to_design calls citing one gate append one defect report", async (context) => {
  const { root, slice, review, wave } = await verified(context);
  await wave("w1", { open: [H1], fix: ["H1"] });
  await wave("w2", { verify: ["H1"], open: [M1] });
  const gate = await limitGate(review);
  await answer(root, gate, "return-to-design");
  const before = (await getReview(slice)).revision;
  const returnAt = (expectedRevision) => updateReview({ ...slice, expectedRevision, actor: coordinator, operations: [{ op: "return_to_design", gate }] });
  const first = returnAt(before);
  // The second call reads the review as soon as the first one's write shows, before the first one blocks the slice.
  let second;
  for (let tries = 0; tries < 400 && !second; tries += 1) {
    const now = (await getReview(slice)).revision;
    if (now !== before) second = returnAt(now);
    else await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(second, "the first return's review write was observed");
  const settled = await Promise.allSettled([first, second]);
  assert.deepEqual(settled[0].value?.returnedToDesign, { sliceStatus: "blocked", defects: 1 });
  if (settled[1].status === "fulfilled") assert.equal(settled[1].value.returnedToDesign.sliceStatus, "blocked");
  const runs = (await locateRecord(root, { kind: "runs", initiative: INITIATIVE, slice: INITIATIVE })).target;
  assert.equal((await readdir(runs)).filter((name) => name.includes("contract-defect")).length, 1);
  assert.equal((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices[INITIATIVE].status, "blocked");
});
