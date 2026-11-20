import assert from "node:assert/strict";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { alias, bareRemote, blobOf, checkout, commitFiles, git, isolateGit, ok, place, server } from "./fixtures/workspace-view.mjs";
import { answerGate, reviewBrowser } from "./fixtures/workspace-artifacts.mjs";

// Contract clauses 51-53 of the workspace-view design: verification records each slice file's blob hash, and ship records the commit that holds them.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const TEST_FILE = "test/reports.test.mjs";
const FROZEN = "import test from \"node:test\";\ntest(\"reports\", () => {});\n";
const REPORT = "export const report = () => \"signed\";\n";

// A checkout without a store whose slice reports passed verification on branch feature-x after adding src/report.js and removing src/old.js.
async function verified(context) {
  const where = await place(context);
  const code = await bareRemote(where.parent, "api-code.git", { files: null });
  alias("https://github.com/acme/api.git", code);
  const root = await checkout(where, "api", { store: null, files: { "check.mjs": "process.exit(0);\n", [TEST_FILE]: FROZEN, "src/old.js": "export const old = 1;\n" } });
  git(root, "config", "user.name", "Ada Reviewer");
  git(root, "push", "-q", "-u", "origin", "main");
  const prism = await server(context, where, root);
  const review = await reviewBrowser(context, root);
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: null, operations: [{ op: "create", slug: "reports", title: "Reports", requirements: ["r.md#1"] }] }));
  await commitFiles(root, { "docs/plans/reports/slice.md": "# Reports\n\n## Contract\n1. `src/report.js` reports.\n\n## Changes\n- add `src/report.js`: report (§1).\n" }, "design");
  const revision = async () => ok(await prism.call("get_initiative", { initiative: "reports" })).revision;
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(), operations: [{ op: "accept_design", slug: "reports", frozenTests: [TEST_FILE], review: "none" }] }));
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(), operations: [{ op: "set_status", slug: "reports", status: "in-progress" }] }));
  git(root, "checkout", "-q", "-b", "feature-x");
  await writeFile(path.join(root, "src", "report.js"), REPORT);
  await unlink(path.join(root, "src", "old.js"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "report");
  git(root, "push", "-q", "origin", "feature-x");
  const asked = ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports" }));
  assert.equal(asked.status, "approval_needed");
  assert.equal((await answerGate(review, { initiative: "reports", id: asked.gateId, choice: "allow" })).status, 200);
  const run = ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports", approvalGate: asked.gateId }));
  assert.equal(run.status, "passed");
  const record = JSON.parse(await readFile(path.join(root, run.run), "utf8"));
  ok(await prism.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  return { where, code, root, prism, record, head: git(root, "rev-parse", "HEAD") };
}

// The default branch on the remote takes the slice's changes as one squash commit, and a later commit changes the report again.
async function squash(where, code) {
  const work = path.join(where.parent, "squash");
  git(where.parent, "clone", "-q", "-b", "main", code, work);
  await writeFile(path.join(work, "src", "report.js"), REPORT);
  await unlink(path.join(work, "src", "old.js"));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "Reports (#12)");
  const squashed = git(work, "rev-parse", "HEAD");
  await commitFiles(work, { "src/report.js": "export const report = () => \"changed\";\n" }, "later");
  git(work, "push", "-q", "origin", "main");
  return squashed;
}

const ship = async (prism) => ok(await prism.call("update_roadmap", { expectedRevision: ok(await prism.call("get_roadmap", {})).revision, operations: [{ op: "ship", id: "reports" }] }));

test("clause 51: a verification run records the blob hash of each slice file and no file bytes", async (context) => {
  const { record } = await verified(context);
  assert.deepEqual(record.files, [
    { path: "src/old.js", blob: null },
    { path: "src/report.js", blob: blobOf(REPORT) },
    { path: TEST_FILE, blob: blobOf(FROZEN) }
  ]);
  assert.equal(record.filesFrom, "start-content");
  assert.equal(record.filesTruncated, undefined);
  assert.doesNotMatch(JSON.stringify(record), /signed/, "the run holds no file bytes");
});

test("clause 52: a run's checkout names this machine's host", async (context) => {
  const { record, head } = await verified(context);
  assert.equal(record.checkout.host, os.hostname().split(".")[0]);
  assert.equal(record.checkout.head, head);
  assert.equal(record.checkout.branch, "feature-x");
});

test("clause 53: ship records the oldest commit of the default branch that holds every verified file", async (context) => {
  const { where, code, prism, head } = await verified(context);
  const squashed = await squash(where, code);
  const shipped = await ship(prism);
  assert.deepEqual(shipped.noShipCommit, []);
  const entry = ok(await prism.call("get_roadmap", {})).initiatives.find((item) => item.id === "reports");
  assert.equal(entry.decision.kind, "shipped");
  assert.deepEqual(entry.decision.slices, { reports: { repository: entry.decision.slices.reports.repository, verified: head, shipped: squashed } });
  assert.equal(typeof entry.decision.slices.reports.repository, "string");
});

test("clause 53: a ship before the squash merge records no ship commit and names the slice", async (context) => {
  const { prism, head } = await verified(context);
  const shipped = await ship(prism);
  assert.deepEqual(shipped.noShipCommit, ["reports"]);
  const entry = ok(await prism.call("get_roadmap", {})).initiatives.find((item) => item.id === "reports");
  assert.deepEqual(entry.decision.slices.reports.verified, head);
  assert.equal(entry.decision.slices.reports.shipped, null);
});
