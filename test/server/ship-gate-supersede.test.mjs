import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { finishedProject, roadmapOperation } from "./fixtures/shipped-work.mjs";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { answerGate, checkout, git, isolateGit, ok, refused, reviewBrowser, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// One rule decides which pending gate is not open work for a ship, with or without a record store, and a ship's history marks are committed only from the checkout.

const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TEST_FILE = "test/reports.test.mjs";
const CONTRACT = "# Reports\n\n## Contract\n1. `check.mjs` exits 0.\n\n## Changes\n- change `check.mjs`: exits 0 (§1).\n";
const QUESTION = { kind: "correctness", question: "Ship the reports initiative?", context: "Every slice passed verification.", artifacts: [] };

// A checkout with a record store whose one-slice initiative passed verification and has a roadmap entry.
async function finishedWithStore(context) {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: { [TEST_FILE]: "import test from \"node:test\";\ntest(\"check exits 0\", () => {});\n" } });
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api);
  const review = await reviewBrowser(context, api);
  ok(await createInitiative(prism, "reports"));
  await writeArtifact(prism, "docs/plans/reports/slice.md", CONTRACT);
  const revision = async () => ok(await prism.call("get_initiative", { initiative: "reports" })).revision;
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(), operations: [{ op: "propose_design", slug: "reports", operations: [{ op: "accept_design", slug: "reports", frozenTests: [TEST_FILE], review: "none" }] }] }));
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(), operations: [{ op: "accept_proposal", slug: "reports", reviewRequired: [] }] }));
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(), operations: [{ op: "set_status", slug: "reports", status: "in-progress" }] }));
  const asked = ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports" }));
  assert.equal((await answerGate(review, { initiative: "reports", id: asked.gateId, choice: "allow" })).status, 200);
  assert.equal(ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports", approvalGate: asked.gateId })).status, "passed");
  ok(await prism.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  return { place, api, prism, review };
}

async function askCorrectness(prism) {
  const state = ok(await prism.call("get_coordination_state", { initiative: "reports" }));
  return ok(await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: state.revision, changes: { gateOperations: [{ op: "ask", ...QUESTION }] } }));
}
const shipAfter = async (prism, afterGate) => prism.call("update_roadmap", { expectedRevision: ok(await prism.call("get_roadmap", {})).revision, operations: [{ op: "ship", id: "reports", afterGate }] });
const reportsOf = (roadmap) => roadmap.derived.find((item) => item.id === "reports");

test("without a store, a ship naming an approved pending correctness gate ships and closes it", async (context) => {
  const { root, call } = await finishedProject(context);
  const state = await call("get_coordination_state", { initiative: "reports" });
  const asked = await call("update_coordination_state", { initiative: "reports", expectedRevision: state.value.revision ?? null, changes: { gateOperations: [{ op: "ask", ...QUESTION }] } });
  assert.equal(asked.error, null, asked.error?.message);
  const gate = asked.value.openedGates[0].id;
  const review = await reviewBrowser(context, root);
  assert.equal((await answerGate(review, { initiative: "reports", id: gate, choice: "approve" })).status, 200);
  const shipped = await roadmapOperation(call, { op: "ship", id: "reports", afterGate: gate });
  assert.equal(shipped.error, null, shipped.error?.message);
  assert.equal(shipped.value.record.initiatives[0].decision.gate, gate);
  assert.deepEqual((await call("get_coordination_state", { initiative: "reports" })).value.state.pending, [], "a shipped initiative keeps no pending gate");
});

test("with a store, a new correctness gate supersedes an answered one, so readyToShip and the ship with the new gate agree", async (context) => {
  const { prism, review } = await finishedWithStore(context);
  const first = (await askCorrectness(prism)).openedGates[0].id;
  assert.equal((await answerGate(review, { initiative: "reports", id: first, choice: "request-changes", note: "Check the docs." })).status, 200);
  refused(await shipAfter(prism, first), "ship_unconfirmed");
  const asked = await askCorrectness(prism);
  const second = asked.openedGates[0].id;
  assert.deepEqual(asked.supersededGates, [first], "the result names the superseded gate");
  assert.deepEqual(asked.state.pending.map((gate) => gate.id), [second], "the answered gate no longer waits on the person");
  assert.equal((await answerGate(review, { initiative: "reports", id: second, choice: "approve" })).status, 200);
  const ready = reportsOf(ok(await prism.call("get_roadmap", {})));
  assert.equal(ready.readyToShip, true, JSON.stringify(ready.diagnostics));
  const shipped = ok(await shipAfter(prism, second));
  assert.equal(shipped.record.initiatives[0].decision.gate, second);
  assert.deepEqual(ok(await prism.call("get_coordination_state", { initiative: "reports" })).state.pending, [], "a shipped initiative keeps no pending gate");
});

test("with a store, an unanswered earlier correctness gate stays open work for readyToShip and for the ship alike", async (context) => {
  const { prism, review } = await finishedWithStore(context);
  const first = (await askCorrectness(prism)).openedGates[0].id;
  const asked = await askCorrectness(prism);
  const second = asked.openedGates[0].id;
  assert.equal(asked.supersededGates, undefined, "an unanswered gate stays the person's question");
  assert.equal((await answerGate(review, { initiative: "reports", id: second, choice: "approve" })).status, 200);
  const derived = reportsOf(ok(await prism.call("get_roadmap", {})));
  assert.equal(derived.readyToShip, false);
  const diagnostic = derived.diagnostics.find((item) => item.code === "open_work");
  assert.deepEqual(diagnostic?.gates.map((gate) => gate.id), [first], "the diagnostic names the earlier gate");
  const error = refused(await shipAfter(prism, second), "open_work");
  assert.deepEqual(error.data.gates.map((gate) => gate.id), [first]);
});

async function findFiles(dir, name, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== ".git") await findFiles(full, name, out);
    else if (entry.name === name) out.push(full);
  }
  return out;
}

test("with a store, the history marks of a shipped initiative are shared and nothing asks to commit them", async (context) => {
  const { place, prism, review } = await finishedWithStore(context);
  const gate = (await askCorrectness(prism)).openedGates[0].id;
  assert.equal((await answerGate(review, { initiative: "reports", id: gate, choice: "approve" })).status, 200);
  const shipped = ok(await shipAfter(prism, gate));
  assert.deepEqual(shipped.historyMarks, ["docs/plans/reports/slice.md"]);
  // An initiative that shipped before ship recorded its documents is marked at its first read, which reports the marks in a text line.
  const [roadmapFile] = (await findFiles(place.store, "roadmap.json"));
  const record = JSON.parse(await readFile(roadmapFile, "utf8"));
  for (const key of ["documents", "documentsRecordedAt", "documentsFrom"]) delete record.initiatives[0].decision[key];
  await writeFile(roadmapFile, `${JSON.stringify(record, null, 2)}\n`);
  const [sliceFile] = (await findFiles(path.join(place.store, "artifacts"), "slice.md"));
  await writeFile(sliceFile, CONTRACT);
  const read = await prism.call("get_initiative", { initiative: "reports" });
  const value = ok(read);
  assert.deepEqual(value.shippedHistory.marked, ["docs/plans/reports/slice.md"]);
  const line = read.result.content.slice(1).map((item) => item.text).join("\n");
  assert.match(line, /docs\/plans\/reports\/slice\.md/);
  assert.doesNotMatch(line, /\bcommit (them|it)\b|Commit/, "the line asks for no commit");
  assert.match(line, /nothing to commit/);
});

test("the orchestrate skill and the user guide ask to commit history marks only without a store", async () => {
  const orchestrate = await readFile(path.join(ROOT, "skills/orchestrate/SKILL.md"), "utf8");
  const step = orchestrate.split("\n").find((line) => line.includes("`historyMarks`"));
  assert.match(step, /in a project without a store, when commit is on, commit/);
  assert.match(step, /with a store they are already shared and need no commit/);
  const guide = await readFile(path.join(ROOT, "docs/user-guide/workflow.md"), "utf8");
  assert.doesNotMatch(guide, /^Commit the marked documents\.$/m);
  assert.match(guide, /^In a project without a record store, commit the marked documents\.$/m);
  for (const file of ["src/server/workflow/roadmap.mjs", "src/server/workflow/initiative.mjs", "src/server/mcp.mjs", "src/server/conservation/conservation-tools.mts"]) {
    assert.doesNotMatch(await readFile(path.join(ROOT, file), "utf8"), /to commit apart from the task's changes\./, file);
  }
});
