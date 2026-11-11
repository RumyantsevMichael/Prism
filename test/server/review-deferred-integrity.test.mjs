import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";

// Requirements: docs/requirements/review-loop-decisions.md §1, §2.
// Only the user's decision can defer a finding: a conversation choice never replaces a browser answer, a stored deferral that accept_wave
// could not have written is refused, and a refused deferral reports every problem whatever the follow-up length or the transport.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-deferred-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
// The test and the MCP server it starts act as one host session, so the server holds the claim that verification took here.
process.env.CLAUDE_CODE_SESSION_ID = "019a-deferral-agent";
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { checkReviewGate, getReview, updateReview } = await import("../../dist/server/review/review-ledger.mjs");
const { answerUserGate, readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
const { locateRecord } = await import("../../dist/server/workflow/record-store.mjs");
const SERVER_PATH = fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url));
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

const resolveGate = async (root, operation) => {
  const current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  return updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes: { gateOperations: [{ op: "resolve", ...operation }] } });
};
const recordPath = async (root, record) => (await locateRecord(root, { initiative: INITIATIVE, ...record })).target;
async function editRecord(root, record, change) {
  const file = await recordPath(root, record), document = JSON.parse(await readFile(file, "utf8"));
  change(document);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
}

test("a resolve choice cannot replace the option the user chose in the review browser", async (context) => {
  const { root, slice, review } = await reviewed(context, LOW);
  const gate = await ask(root);
  await answer(root, gate, "continue-review");
  await assert.rejects(resolveGate(root, { id: gate, choice: "accept-deferred" }), (error) => error.code === "invalid_changes" && /continue-review/.test(error.message));
  assert.ok((await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.some((item) => item.id === gate), "the refused resolve leaves the gate pending");
  await resolveGate(root, { id: gate, choice: "continue-review" });
  await assert.rejects(review(coordinator, [deferAll(gate)]), (error) => error.code === "deferral_refused" && error.problems.some((problem) => problem.code === "gate_invalid"));
  // A closed gate stored with a choice that contradicts its browser answer is reported invalid, and the browser answer still decides.
  await editRecord(root, { kind: "state" }, (state) => { state.closed.find((item) => item.id === gate).choice = "accept-deferred"; });
  const stored = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  assert.equal(stored.valid, false);
  assert.ok(stored.errors.some((item) => /choice/.test(JSON.stringify(item))), JSON.stringify(stored.errors));
  await assert.rejects(review(coordinator, [deferAll(gate)]), (error) => error.code === "deferral_refused" && error.problems.some((problem) => problem.code === "gate_invalid"));
  assert.ok((await getReview(slice)).entries.every((finding) => finding.status === "OPEN"));
});

test("an answer the user gave for another slice or an earlier wave cannot be moved to defer this slice's findings", async (context) => {
  const { root, slice, review } = await reviewed(context, LOW);
  const gate = await ask(root, { slice: "other-slice" });
  await answer(root, gate, "accept-deferred");
  const replace = async (change, gateOperations) => {
    const current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
    const pending = current.state.pending.map((item) => item.id === gate ? change(item) : item);
    return updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes: { pending, ...(gateOperations ? { gateOperations } : {}) } });
  };
  const refused = (error) => error.code === "invalid_changes" && error.message.includes(gate);
  const later = new Date(Date.now() + 60_000).toISOString();
  await assert.rejects(replace((item) => ({ ...item, slice: INITIATIVE, askedAt: later })), refused, "moving the gate to this slice");
  await assert.rejects(replace((item) => ({ ...item, askedAt: later })), refused, "refreshing when it was asked");
  await assert.rejects(replace((item) => ({ ...item, question: "May the low findings be deferred?" })), refused, "rewording the question");
  await assert.rejects(replace((item) => ({ ...item, options: item.options.map((option) => ({ ...option, label: `${option.label}.` })) })), refused, "rewording the options");
  await assert.rejects(replace(({ answer: _answer, ...item }) => item), refused, "removing the answer");
  await assert.rejects(replace((item) => ({ ...item, slice: INITIATIVE }), [{ op: "resolve", id: gate }]), refused, "moving and resolving in one change");
  // The gate as it stands, with its fields in another order, is no change.
  await replace((item) => Object.fromEntries(Object.entries(item).reverse()));
  const stored = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((item) => item.id === gate);
  assert.equal(stored.slice, "other-slice");
  await assert.rejects(review(coordinator, [deferAll(gate)]), (error) => error.code === "deferral_refused" && error.problems.some((problem) => problem.code === "gate_invalid"));
  assert.ok((await getReview(slice)).entries.every((finding) => finding.status === "OPEN"));
});

test("a stored deferral that accept_wave could not have written is refused by every reader and writer of the review", async (context) => {
  const forgeries = {
    "a high finding": (finding) => { finding.severity = "high"; },
    "no deferral": (finding) => { delete finding.deferral; },
    "no DEFERRED history entry": (finding) => { finding.history.pop(); },
    "a deferral wave that is not the history's": (finding) => { finding.deferral.wave = "w9"; },
    "an untrimmed follow-up": (finding) => { finding.deferral.followUp = " #101"; finding.history.at(-1).evidence = " #101"; }
  };
  const { root, slice, review } = await reviewed(context, LOW);
  const file = await recordPath(root, { kind: "review", slice: INITIATIVE });
  const original = await readFile(file, "utf8");
  const deferred = JSON.parse(original);
  const at = new Date().toISOString();
  for (const finding of deferred.findings) {
    finding.status = "DEFERRED";
    finding.deferral = { gate: "gate-0123456789ab", followUp: "#101", wave: "w1", actor: coordinator.id, at };
    finding.history.push({ actor: coordinator.id, status: "DEFERRED", wave: "w1", at, evidence: "#101" });
  }
  const expectRefused = async (label) => {
    for (const [name, read] of [["get_review", () => getReview(slice)], ["check_review_gate", () => checkReviewGate({ ...slice, gate: "completion" })], ["accept_wave", () => updateReview({ ...slice, expectedRevision: null, actor: coordinator, operations: [{ op: "accept_wave" }] })]]) {
      await assert.rejects(read(), (error) => error.code === "validation_failed", `${name} with ${label}`);
    }
  };
  for (const [label, forge] of Object.entries(forgeries)) {
    const document = structuredClone(deferred);
    forge(document.findings[0]);
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    await expectRefused(label);
  }
  const stray = JSON.parse(original);
  stray.findings[0].deferral = { gate: "gate-0123456789ab", followUp: "#101", wave: "w1", actor: coordinator.id, at };
  await writeFile(file, `${JSON.stringify(stray, null, 2)}\n`);
  await expectRefused("a deferral on an OPEN finding");
  await writeFile(file, original);
  assert.equal((await getReview(slice)).entries.length, 2, "the record as Prism wrote it still reads");
  await assert.rejects(review(coordinator, [{ op: "accept_wave" }]), (error) => error.code === "gate_blocked");
});

test("a follow-up is trimmed before its length is judged, at any length the request allows", async (context) => {
  const { root, slice, review } = await reviewed(context, LOW);
  const gate = await ask(root);
  await answer(root, gate, "accept-deferred");
  await assert.rejects(review(coordinator, [{ op: "accept_wave", gate, deferrals: [{ finding: findingId("L1"), followUp: "#101" }, { finding: findingId("L2"), followUp: "x".repeat(9000) }] }]), (error) => {
    assert.equal(error.code, "deferral_refused");
    assert.deepEqual(error.problems.map((problem) => [problem.code, problem.finding]), [["follow_up_missing", findingId("L2")]]);
    return true;
  });
  const result = await review(coordinator, [{ op: "accept_wave", gate, deferrals: [{ finding: findingId("L1"), followUp: `${" ".repeat(9000)}#101` }, { finding: findingId("L2"), followUp: `#102${"\n".repeat(9000)}` }] }]);
  assert.equal(result.accepted, true);
  assert.deepEqual((await getReview(slice)).deferred.map((item) => item.followUp), ["#101", "#102"]);
});

test("a deferral refused through MCP keeps every problem in its error data", async (context) => {
  const { root, slice } = await reviewed(context, LOW);
  const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PLUGIN_DATA: privateData, CLAUDE_CODE_SESSION_ID: "", CLAUDE_PROJECT_DIR: root, PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)) });
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => { const message = JSON.parse(line); waiting.get(message.id)?.(message); waiting.delete(message.id); });
  context.after(() => new Promise((resolve) => { child.once("exit", resolve); child.stdin.end(); }));
  let id = 0;
  const send = (method, params) => new Promise((resolve) => { id += 1; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
  const call = (name, args) => send("tools/call", { name, arguments: { projectRoot: root, initiative: INITIATIVE, ...args }, _meta: { sessionId: process.env.CLAUDE_CODE_SESSION_ID } });
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  // An invalid gate names 100 findings that do not exist, so the refusal has 100 gate_invalid, 100 finding_not_unresolved, and 2 follow_up_missing problems.
  const deferrals = Array.from({ length: 100 }, (_, index) => ({ finding: findingId(`N${index}`), followUp: `#${index}` }));
  const refused = await call("update_review", { slice: slice.slice, expectedRevision: (await getReview(slice)).revision, actor: coordinator, operations: [{ op: "accept_wave", gate: "gate-0123456789ab", deferrals }] });
  assert.equal(refused.error?.data?.code, "deferral_refused", JSON.stringify(refused.error ?? refused.result).slice(0, 500));
  const counts = Object.entries(Object.groupBy(refused.error.data.problems, (problem) => problem.code)).map(([code, items]) => [code, items.length]);
  assert.deepEqual(counts, [["gate_invalid", 100], ["finding_not_unresolved", 100], ["follow_up_missing", 2]]);
  assert.deepEqual(refused.error.data.problems.slice(-2).map((problem) => problem.finding), [findingId("L1"), findingId("L2")]);
});
