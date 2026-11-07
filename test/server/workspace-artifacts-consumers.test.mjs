import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { browserRequest, checkout, commitFiles, exists, isolateGit, ok, refused, reviewBrowser, server, text, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Contract clauses 19, 22, and 23 of the workspace-artifacts design: Prism's own design, pause, and view files, and the review browser, use the store.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const CONTRACT = "# Reports\n\n## Contract\n1. `check.mjs` exits 0.\n\n## Changes\n- change `check.mjs`: exits 0 (§1).\n";
const DIAGRAM = "@startuml\ncomponent Check\n@enduml\n";
const TEST_FILE = "test/reports.test.mjs";
const TEST_SOURCE = "import test from \"node:test\";\ntest(\"check exits 0\", () => {});\n";

async function designed(context, { scope } = {}) {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: { [TEST_FILE]: TEST_SOURCE } });
  const prism = await server(context, place, api);
  ok(await createInitiative(prism, "reports"));
  await writeArtifact(prism, "docs/plans/reports/slice.md", CONTRACT, scope ? { scope } : {});
  await writeArtifact(prism, "docs/plans/reports/code.puml", DIAGRAM);
  return { place, api, prism };
}

const revision = async (prism) => ok(await prism.call("get_initiative", { initiative: "reports" })).revision;

test("clause 22: design proposal, acceptance, and the design view read slice.md and diagrams from the store, and the generated views are written there", async (context) => {
  const { place, api, prism } = await designed(context);
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(prism), operations: [{ op: "propose_design", slug: "reports", operations: [{ op: "accept_design", slug: "reports", frozenTests: [TEST_FILE], review: "none" }] }] }));
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(prism), operations: [{ op: "accept_proposal", slug: "reports", reviewRequired: [] }] }));
  const accepted = ok(await prism.call("get_initiative", { initiative: "reports" }));
  assert.ok(accepted.record.slices.reports.design, "the design was accepted from the store's slice.md");
  ok(await prism.call("update_design_view", { initiative: "reports", slice: "reports", examples: [{ clause: 1, file: TEST_FILE, test: "check exits 0", example: "Running check.mjs exits 0." }] }));

  assert.match(await text(path.join(place.store, "artifacts", "plans", "reports", "initiative.md")) ?? "", /Reports/, "the initiative view is generated in the store");
  ok(await prism.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  assert.match(await text(path.join(place.store, "artifacts", "roadmap.md")) ?? "", /Reports/, "the roadmap view is generated in the store");
  assert.equal(await exists(path.join(api, "docs", "plans")), false, "nothing was written under the checkout's plans folder");
  assert.equal(await exists(path.join(api, "docs", "roadmap.md")), false, "no roadmap view was written into the checkout");
});

test("clause 22: the recovery note of a pause is written in the store, beside its initiative's plans", async (context) => {
  const { place, api, prism } = await designed(context, { scope: "repository" });
  const started = ok(await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: null, changes: {
    activeOperations: [{ op: "start", entry: { slice: "download", activity: "implementation", workers: ["worker"], workspace: api } }]
  } }));
  ok(await prism.call("checkpoint_pause", { initiative: "reports", expectedRevision: started.revision, activeSlice: "download", recoveryContent: "Continue the download.", changes: { next: ["Continue"] } }));
  assert.equal(await text(path.join(place.store, "artifacts", "repositories", "api", "plans", "reports", "download", "recovery.md")), "Continue the download.\n", "the note lands in the scope that holds the initiative's plans folder");
  assert.equal(await exists(path.join(api, "docs", "plans")), false);
  assert.equal((await readdir(path.join(place.store, "artifacts", "repositories", "api", "plans", "reports"))).includes("initiative.md"), true, "the generated initiative view follows the plans folder's scope");
});

test("clause 22: a slice.md that only the checkout holds is not read", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: { [TEST_FILE]: TEST_SOURCE } });
  const prism = await server(context, place, api);
  ok(await createInitiative(prism, "reports"));
  await commitFiles(api, { "docs/plans/reports/slice.md": CONTRACT }, "a stray checkout copy");
  const response = await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(prism), operations: [{ op: "accept_design", slug: "reports", frozenTests: [TEST_FILE], review: "none" }] });
  assert.ok(response.error, "acceptance does not fall back to the checkout's slice.md");
  assert.equal(ok(await prism.call("get_initiative", { initiative: "reports" })).record.slices.reports.design, undefined);
});

test("clause 19: a frozen test cannot be an artifact path", async (context) => {
  const { prism } = await designed(context);
  await writeArtifact(prism, "docs/plans/reports/probe.test.mjs", TEST_SOURCE);
  refused(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(prism), operations: [{ op: "accept_design", slug: "reports", frozenTests: ["docs/plans/reports/probe.test.mjs"], review: "none" }] }), "frozen_test_in_store");
});

test("clause 23: the review browser lists the store's artifacts with their scopes and serves their bytes", async (context) => {
  const { api, prism } = await designed(context);
  await writeArtifact(prism, "docs/requirements/billing.md", "# Billing\n\nStored text.\n");
  await writeArtifact(prism, "docs/requirements/api.md", "# API\n", { scope: "repository" });
  const review = await reviewBrowser(context, api);
  const index = await browserRequest(review, "/api/index");
  assert.equal(index.status, 200);
  for (const file of ["docs/requirements/billing.md", "docs/requirements/api.md", "docs/plans/reports/slice.md", "docs/plans/reports/code.puml"]) assert.ok(index.body.artifacts.includes(file), `${file} is listed`);
  assert.equal(index.body.artifactScopes["docs/requirements/billing.md"], "workspace");
  assert.equal(index.body.artifactScopes["docs/requirements/api.md"], "api");
  const served = await browserRequest(review, `/api/artifact?path=${encodeURIComponent("docs/requirements/billing.md")}`);
  assert.equal(served.status, 200);
  assert.match(JSON.stringify(served.body), /Stored text\./);
});
