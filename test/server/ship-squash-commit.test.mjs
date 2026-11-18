import assert from "node:assert/strict";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { alias, bareRemote, checkout, commitFiles, git, isolateGit, ok, place, server } from "./fixtures/workspace-view.mjs";
import { answerGate, reviewBrowser } from "./fixtures/workspace-artifacts.mjs";

// Ship finds the default-branch commit that holds a slice's verified work when later commits on its branch changed its files before a squash merge.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const TEST_FILE = "test/reports.test.mjs";
const FROZEN = "import test from \"node:test\";\ntest(\"reports\", () => {});\n";
const REPORT = "export const report = () => \"signed\";\n";
const LATER = "export const report = () => \"signed and dated\";\n";

// A checkout without a store whose slice reports passed verification on branch feature-x after adding src/report.js and removing src/old.js.
async function verified(context) {
  const where = await place(context);
  const code = await bareRemote(where.parent, "api-code.git", { files: null });
  alias("https://github.com/acme/api.git", code);
  const root = await checkout(where, "api", { store: null, files: { "check.mjs": "process.exit(0);\n", [TEST_FILE]: FROZEN, "src/old.js": "export const old = 1;\n" } });
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
  const asked = ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports" }));
  assert.equal(asked.status, "approval_needed");
  assert.equal((await answerGate(review, { initiative: "reports", id: asked.gateId, choice: "allow" })).status, 200);
  const run = ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports", approvalGate: asked.gateId }));
  assert.equal(run.status, "passed");
  const record = JSON.parse(await readFile(path.join(root, run.run), "utf8"));
  assert.ok(record.files.some((file) => file.path === "src/report.js"));
  ok(await prism.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  return { where, code, root, prism, head: git(root, "rev-parse", "HEAD") };
}

// The default branch on the remote takes the given report as one squash commit, after an unrelated commit, and returns the squash commit.
async function squash(where, code, report) {
  const work = path.join(where.parent, "squash");
  git(where.parent, "clone", "-q", "-b", "main", code, work);
  await commitFiles(work, { "README.md": "# api\n" }, "unrelated");
  await writeFile(path.join(work, "src", "report.js"), report);
  await unlink(path.join(work, "src", "old.js"));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "Reports (#12)");
  const squashed = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", "origin", "main");
  return squashed;
}

const ship = async (prism) => ok(await prism.call("update_roadmap", { expectedRevision: ok(await prism.call("get_roadmap", {})).revision, operations: [{ op: "ship", id: "reports" }] }));
const decisionOf = async (prism) => ok(await prism.call("get_roadmap", {})).initiatives.find((item) => item.id === "reports").decision;

test("ship records the squash commit of a branch whose later commit changed a verified file", async (context) => {
  const { where, code, root, prism, head } = await verified(context);
  await commitFiles(root, { "src/report.js": LATER }, "later slice");
  git(root, "push", "-q", "origin", "feature-x");
  const squashed = await squash(where, code, LATER);
  const shipped = await ship(prism);
  assert.deepEqual(shipped.noShipCommit, []);
  const decision = await decisionOf(prism);
  assert.equal(decision.slices.reports.verified, head);
  assert.equal(decision.slices.reports.shipped, squashed);
});

test("a later version that no commit descending from the verified one holds does not count as shipped", async (context) => {
  const { where, code, prism } = await verified(context);
  await squash(where, code, LATER);
  const shipped = await ship(prism);
  assert.deepEqual(shipped.noShipCommit, ["reports"]);
  assert.equal((await decisionOf(prism)).slices.reports.shipped, null);
});

test("a fast-forward of the default branch to the verified commit records that commit", async (context) => {
  const { root, prism, head } = await verified(context);
  git(root, "push", "-q", "origin", "feature-x:main");
  const shipped = await ship(prism);
  assert.deepEqual(shipped.noShipCommit, []);
  assert.equal((await decisionOf(prism)).slices.reports.shipped, head);
});

test("a merge commit of the branch records the merge commit", async (context) => {
  const { where, code, root, prism } = await verified(context);
  await commitFiles(root, { "src/report.js": LATER }, "later slice");
  git(root, "push", "-q", "origin", "feature-x");
  const work = path.join(where.parent, "merge");
  git(where.parent, "clone", "-q", "-b", "main", code, work);
  await commitFiles(work, { "README.md": "# api\n" }, "unrelated");
  git(work, "fetch", "-q", "origin", "feature-x");
  git(work, "merge", "-q", "--no-ff", "-m", "Merge feature-x", "FETCH_HEAD");
  const merged = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", "origin", "main");
  const shipped = await ship(prism);
  assert.deepEqual(shipped.noShipCommit, []);
  assert.equal((await decisionOf(prism)).slices.reports.shipped, merged);
});
