import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { adrFile, answerGate, checkout, git, isolateGit, ok, refused, reviewBrowser, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// With a record store, a ship accepts only the ADRs that slice.md files link, so it refuses while a Proposed ADR cites the initiative's requirements and no slice.md links it.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const TEST_FILE = "test/reports.test.mjs";
const TEST_SOURCE = "import test from \"node:test\";\ntest(\"check exits 0\", () => {});\n";
const SLICE = "docs/plans/reports/slice.md";
const CONTRACT = "# Reports\n\n## Contract\n1. `check.mjs` exits 0.\n";
const OWN = "docs/ADRs/reports/own.md";
const citing = (title) => adrFile(title).replace("## Requirements\n\nn/a", "## Requirements\n\n- [Reports](../../requirements/r.md) §1.");

const revision = async (prism) => ok(await prism.call("get_initiative", { initiative: "reports" })).revision;
const roadmap = async (prism) => ok(await prism.call("get_roadmap", {}));
const ship = async (prism, afterGate) => prism.call("update_roadmap", { expectedRevision: (await roadmap(prism)).revision, operations: [{ op: "ship", id: "reports", afterGate }] });
const derivedOf = async (prism) => (await roadmap(prism)).derived.find((item) => item.id === "reports");
const statusOf = async (prism, file) => ok(await prism.call("get_artifact", { path: file })).status;

// An initiative of one slice in checkout api whose roadmap entry cites r.md§1, verified and done, with the given ADRs written first.
async function finished(context, adrs) {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: { [TEST_FILE]: TEST_SOURCE } });
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api);
  const review = await reviewBrowser(context, api);
  for (const [file, content] of Object.entries(adrs)) await writeArtifact(prism, file, content);
  ok(await createInitiative(prism, "reports"));
  await writeArtifact(prism, SLICE, CONTRACT);
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(prism), operations: [{ op: "accept_design", slug: "reports", frozenTests: [TEST_FILE], review: "none" }] }));
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(prism), operations: [{ op: "set_status", slug: "reports", status: "in-progress" }] }));
  const asked = ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports" }));
  if (asked.status === "approval_needed") {
    assert.equal((await answerGate(review, { initiative: "reports", id: asked.gateId, choice: "allow" })).status, 200);
    assert.equal(ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports", approvalGate: asked.gateId })).status, "passed");
  } else assert.equal(asked.status, "passed");
  ok(await prism.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  return { prism, review };
}

async function approved(prism, review) {
  const state = ok(await prism.call("get_coordination_state", { initiative: "reports" }));
  const id = ok(await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: state.revision, changes: { gateOperations: [{ op: "ask", kind: "correctness", question: "Ship the reports initiative?", context: "Every slice passed verification.", artifacts: [] }] } })).openedGates[0].id;
  assert.equal((await answerGate(review, { initiative: "reports", id, choice: "approve" })).status, 200);
  return id;
}

test("ship refuses, and readyToShip is false, while a Proposed ADR cites the initiative's requirements and no slice.md links it", async (context) => {
  const { prism, review } = await finished(context, { [OWN]: citing("Own") });
  const entry = await derivedOf(prism);
  assert.equal(entry.readyToShip, false);
  const diagnostic = entry.diagnostics.find((item) => item.code === "adr_unlinked");
  assert.deepEqual(diagnostic.adrs, [{ path: OWN, scope: "workspace", requirements: ["docs/requirements/r.md"] }]);
  const gate = await approved(prism, review);
  const refusal = refused(await ship(prism, gate), "adr_unlinked");
  assert.deepEqual(refusal.data.adrs, diagnostic.adrs);
  assert.match(refusal.message, /docs\/ADRs\/reports\/own\.md in scope workspace/);
  assert.equal(await statusOf(prism, OWN), "Proposed");
  assert.equal((await roadmap(prism)).initiatives.find((item) => item.id === "reports").decision ?? null, null, "a refused ship records no decision");

  const current = ok(await prism.call("get_artifact", { path: SLICE }));
  await writeArtifact(prism, SLICE, `${CONTRACT}\nDecision: [own](../../ADRs/reports/own.md).\n`, { expectedVersion: current.version });
  assert.equal((await derivedOf(prism)).readyToShip, true);
  const shipped = ok(await ship(prism, await approved(prism, review)));
  assert.deepEqual(shipped.acceptedAdrs.map((adr) => adr.path), [OWN]);
  assert.equal(await statusOf(prism, OWN), "Accepted");
});

test("an ADR that cites other requirements, or that another plan's slice.md links, does not stop the ship", async (context) => {
  const OTHER = "docs/ADRs/billing/ledger.md";
  const UNRELATED = "docs/ADRs/billing/unrelated.md";
  const { prism, review } = await finished(context, { [OTHER]: citing("Ledger"), [UNRELATED]: adrFile("Unrelated").replace("## Requirements\n\nn/a", "## Requirements\n\n- [Billing](../../requirements/billing.md) §1.") });
  await writeArtifact(prism, "docs/plans/billing/slice.md", "# Billing\n\n## Contract\n1. Ledgers follow [the ledger decision](../../ADRs/billing/ledger.md).\n");
  assert.equal((await derivedOf(prism)).readyToShip, true);
  const shipped = ok(await ship(prism, await approved(prism, review)));
  assert.deepEqual(shipped.acceptedAdrs, []);
  assert.equal(await statusOf(prism, OTHER), "Proposed");
  assert.equal(await statusOf(prism, UNRELATED), "Proposed");
});

test("a person's approval accepts a Proposed ADR that a shipped initiative realized, and the shipped decision stays as it is", async (context) => {
  const { prism, review } = await finished(context, {});
  ok(await ship(prism, await approved(prism, review)));
  const decision = (await roadmap(prism)).initiatives.find((item) => item.id === "reports").decision;
  // The ADR was written after the ship, as one an older ship left Proposed.
  await writeArtifact(prism, OWN, citing("Own"));
  const LOOSE = "docs/ADRs/billing/loose.md";
  await writeArtifact(prism, LOOSE, adrFile("Loose"));
  refused(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: OWN, status: "Accepted", context: "No initiative named." }] }), "status_by_ship");
  refused(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: OWN, shipped: "billing", context: "Not a shipped initiative." }] }), "validation_failed");
  refused(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: LOOSE, shipped: "reports", context: "An ADR the initiative never cited." }] }), "validation_failed");
  refused(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: OWN, shipped: "reports", status: "Superseded", context: "Another status." }] }), "validation_failed");

  const gate = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: OWN, shipped: "reports", context: "The reports initiative shipped while this ADR stayed Proposed." }] })).artifacts[0].gate;
  assert.equal((await answerGate(review, { id: gate, choice: "approve" })).status, 200);
  const read = ok(await prism.call("get_artifact", { path: OWN }));
  assert.equal(read.status, "Accepted");
  assert.match(read.content, /^Status: Accepted$/m);
  assert.equal(read.acceptance.initiative, "reports");
  assert.equal(read.acceptance.gate, gate);
  assert.equal(read.acceptance.afterShip, true);
  assert.deepEqual(read.acceptance.verifiedBy, Object.keys(decision.slices).map((slice) => ({ slice, repository: decision.slices[slice].repository, commit: decision.slices[slice].verified })));
  assert.deepEqual((await roadmap(prism)).initiatives.find((item) => item.id === "reports").decision, decision, "the shipped decision is unchanged");
  refused(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: OWN, shipped: "reports", context: "Again." }] }), "validation_failed");
});
