import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { adrFile, browserRequest, checkout, git, isolateGit, ok, refused, reviewBrowser, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Contract clauses 43 and 44 of the workspace-artifacts design: shipping after a person's confirmation accepts the initiative's Proposed ADRs.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const TEST_FILE = "test/reports.test.mjs";
const CITED = "docs/ADRs/reports/storage.md";
const REJECTED = "docs/ADRs/reports/retries.md";
const UNCITED = "docs/ADRs/reports/caching.md";
const CONTRACT = `# Reports\n\n## Contract\n1. \`check.mjs\` exits 0, as [the storage decision](../../ADRs/reports/storage.md) and [the retry decision](../../ADRs/reports/retries.md) require.\n\n## Changes\n- change \`check.mjs\`: exits 0 (§1).\n`;
const answer = (review, body) => browserRequest(review, "/api/gates/answer", { method: "POST", body });

// An initiative whose one slice cites two ADRs, has passed verification, and is done.
async function finished(context) {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: { [TEST_FILE]: "import test from \"node:test\";\ntest(\"check exits 0\", () => {});\n" } });
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api);
  const review = await reviewBrowser(context, api);
  for (const file of [CITED, REJECTED, UNCITED]) await writeArtifact(prism, file, adrFile(file));
  const rejecting = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: REJECTED, status: "Rejected", context: "Retries were dropped." }] }));
  assert.equal((await answer(review, { artifact: REJECTED, scope: "workspace", id: rejecting.artifacts[0].gate, choice: "approve", note: null })).status, 200);

  ok(await createInitiative(prism, "reports"));
  await writeArtifact(prism, "docs/plans/reports/slice.md", CONTRACT);
  const revision = async () => ok(await prism.call("get_initiative", { initiative: "reports" })).revision;
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(), operations: [{ op: "accept_design", slug: "reports", frozenTests: [TEST_FILE], review: "none" }] }));
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(), operations: [{ op: "set_status", slug: "reports", status: "in-progress" }] }));
  const asked = ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports" }));
  assert.equal(asked.status, "approval_needed");
  assert.equal((await answer(review, { initiative: "reports", id: asked.gateId, choice: "allow", note: null })).status, 200);
  const run = ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports", approvalGate: asked.gateId }));
  assert.equal(run.status, "passed");
  ok(await prism.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  return { api, prism, review, head: git(api, "rev-parse", "HEAD") };
}

const roadmapRevision = async (prism) => ok(await prism.call("get_roadmap", {})).revision;

async function askShip(prism) {
  const state = ok(await prism.call("get_coordination_state", { initiative: "reports" }));
  const asked = ok(await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: state.revision, changes: { gateOperations: [{ op: "ask", kind: "correctness", question: "Ship the reports initiative?", context: "Every slice passed verification.", artifacts: [] }] } }));
  return asked.openedGates[0].id;
}

test("clause 43: with a store, ship needs a correctness gate that the person approved in the review browser", async (context) => {
  const { prism, review } = await finished(context);
  refused(await prism.call("update_roadmap", { expectedRevision: await roadmapRevision(prism), operations: [{ op: "ship", id: "reports" }] }), "ship_unconfirmed");
  const gate = await askShip(prism);
  refused(await prism.call("update_roadmap", { expectedRevision: await roadmapRevision(prism), operations: [{ op: "ship", id: "reports", afterGate: gate }] }), "ship_unconfirmed");
  assert.equal((await answer(review, { initiative: "reports", id: gate, choice: "request-changes", note: "Not yet." })).status, 200);
  refused(await prism.call("update_roadmap", { expectedRevision: await roadmapRevision(prism), operations: [{ op: "ship", id: "reports", afterGate: gate }] }), "ship_unconfirmed");
  assert.equal(ok(await prism.call("get_artifact", { path: CITED })).status, "Proposed", "a refused ship accepts nothing");
});

test("clause 44: shipping accepts each cited Proposed ADR with its gate and the verified commits, and leaves the others", async (context) => {
  const { prism, review, head } = await finished(context);
  const gate = await askShip(prism);
  assert.equal((await answer(review, { initiative: "reports", id: gate, choice: "approve", note: null })).status, 200);
  const shipped = ok(await prism.call("update_roadmap", { expectedRevision: await roadmapRevision(prism), operations: [{ op: "ship", id: "reports", afterGate: gate }] }));
  const verifiedBy = [{ slice: "reports", repository: "api", commit: head }];
  assert.deepEqual(shipped.acceptedAdrs, [{ path: CITED, scope: { kind: "workspace", label: "workspace" }, verifiedBy }]);

  const cited = ok(await prism.call("get_artifact", { path: CITED }));
  assert.equal(cited.status, "Accepted");
  assert.match(cited.content, /^Status: Accepted$/m, "the Status line is rewritten");
  assert.equal(cited.statusMismatch, undefined);
  assert.equal(cited.acceptance.gate, gate);
  assert.deepEqual(cited.acceptance.verifiedBy, verifiedBy);
  assert.equal(cited.acceptedVersion, cited.version);
  assert.equal(ok(await prism.call("get_artifact", { path: REJECTED })).status, "Rejected", "a cited ADR with another status stays as it is");
  const uncited = ok(await prism.call("get_artifact", { path: UNCITED }));
  assert.equal(uncited.status, "Proposed", "an ADR that no slice.md links stays Proposed");
  assert.match(uncited.content, /^Status: Proposed$/m);
});
