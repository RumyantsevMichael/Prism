import assert from "node:assert/strict";
import { rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { alias, bareRemote, blobOf, checkout, git, isolateGit, networkStore, ok, place, server, startApp, workspaceId, writeArtifact } from "./fixtures/workspace-view.mjs";
import { answerGate, reviewBrowser } from "./fixtures/workspace-artifacts.mjs";

// Contract clauses 54-57 of the workspace-view design: a slice's files at its verified or ship commit, whether each still matches, and unpushed work as presence.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const TEST_FILE = "test/reports.test.mjs";
const FROZEN = "import test from \"node:test\";\ntest(\"reports\", () => {});\n";
const REPORT = "export const report = () => \"signed\";\n";
const DIRTY = "export const report = () => \"signed twice\";\n";
const CONTRACT = "# Reports\n\n## Contract\n1. `src/report.js` reports.\n\n## Changes\n- add `src/report.js`: report (§1).\n";

/**
 * A store workspace whose repository api verified the slice reports on branch feature-x, which adds src/report.js and removes src/old.js.
 * pushed false keeps feature-x on this machine, and dirty true verifies an uncommitted change of src/report.js.
 */
async function verifiedSlice(context, { pushed = true, dirty = false, verify = true } = {}) {
  const where = await place(context);
  // The review browser of the checkout runs in this process, so it resolves the store's clone in this machine's application folder.
  process.env.PRISM_REVIEW_APP_DIR = where.app;
  const store = await networkStore(where);
  const code = await bareRemote(where.parent, "api-code.git", { files: null });
  alias("https://github.com/acme/api.git", code);
  const root = await checkout(where, "api", { store: store.url, sync: "on", files: { "check.mjs": "process.exit(0);\n", [TEST_FILE]: FROZEN, "src/old.js": "export const old = 1;\n" } });
  git(root, "config", "user.name", "Ada Reviewer");
  git(root, "push", "-q", "-u", "origin", "main");
  const prism = await server(context, where, root);
  const review = await reviewBrowser(context, root);
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: null, operations: [{ op: "create", slug: "reports", title: "Reports", requirements: ["r.md#1"] }] }));
  await writeArtifact(prism, "docs/plans/reports/slice.md", CONTRACT);
  const revision = async () => ok(await prism.call("get_initiative", { initiative: "reports" })).revision;
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(), operations: [{ op: "accept_design", slug: "reports", frozenTests: [TEST_FILE], review: "none" }] }));
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(), operations: [{ op: "set_status", slug: "reports", status: "in-progress" }] }));
  git(root, "checkout", "-q", "-b", "feature-x");
  await writeFile(path.join(root, "src", "report.js"), REPORT);
  await unlink(path.join(root, "src", "old.js"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "report");
  if (pushed) git(root, "push", "-q", "origin", "feature-x");
  if (dirty) await writeFile(path.join(root, "src", "report.js"), DIRTY);
  if (verify) {
    const asked = ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports" }));
    assert.equal(asked.status, "approval_needed", JSON.stringify(asked));
    assert.equal((await answerGate(review, { initiative: "reports", id: asked.gateId, choice: "allow" })).status, 200);
    assert.equal(ok(await prism.call("verify_slice", { initiative: "reports", slice: "reports", approvalGate: asked.gateId })).status, "passed");
  }
  const app = await startApp(context, where);
  await app.grant();
  await app.register(root);
  const id = workspaceId(store.identity);
  const files = async () => (await app.get(`/w/${id}/api/slice-files?initiative=reports&slice=reports`)).json;
  return { where, store, code, root, prism, review, app, id, files, head: git(root, "rev-parse", "HEAD") };
}

const codeOn = async ({ app, id }) => assert.equal((await app.put(`/w/${id}/api/code/api`, { enabled: true })).status, 200);

test("clauses 54 and 55: while the verified commit is on a branch, the slice's files show there, each the same as verified", async (context) => {
  const slice = await verifiedSlice(context);
  await codeOn(slice);
  const answer = await slice.files();
  assert.deepEqual(answer.shown, { commit: slice.head, source: "verified" });
  assert.equal(answer.verified, slice.head);
  assert.deepEqual(answer.files, [
    { path: "src/old.js", blob: null, shownBlob: null, state: "same as verified" },
    { path: "src/report.js", blob: blobOf(REPORT), shownBlob: blobOf(REPORT), state: "same as verified" },
    { path: TEST_FILE, blob: blobOf(FROZEN), shownBlob: blobOf(FROZEN), state: "same as verified" }
  ]);
});

test("clause 55: a file verified with an uncommitted change is changed after verification at the verified commit", async (context) => {
  const slice = await verifiedSlice(context, { dirty: true });
  await codeOn(slice);
  const report = (await slice.files()).files.find((file) => file.path === "src/report.js");
  assert.deepEqual(report, { path: "src/report.js", blob: blobOf(DIRTY), shownBlob: blobOf(REPORT), state: "changed after verification" });
});

test("clause 54: after a squash merge removes the verified commit, the files show at the commit recorded at ship", async (context) => {
  const slice = await verifiedSlice(context);
  const work = path.join(slice.where.parent, "squash");
  git(slice.where.parent, "clone", "-q", "-b", "main", slice.code, work);
  await writeFile(path.join(work, "src", "report.js"), REPORT);
  await unlink(path.join(work, "src", "old.js"));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "Reports (#12)");
  const squashed = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", "origin", "main", ":feature-x");
  ok(await slice.prism.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  const state = ok(await slice.prism.call("get_coordination_state", { initiative: "reports" }));
  const gate = ok(await slice.prism.call("update_coordination_state", { initiative: "reports", expectedRevision: state.revision, changes: { gateOperations: [{ op: "ask", kind: "correctness", question: "Ship the reports initiative?", context: "Every slice passed verification.", artifacts: [] }] } })).openedGates[0].id;
  assert.equal((await answerGate(slice.review, { initiative: "reports", id: gate, choice: "approve" })).status, 200);
  ok(await slice.prism.call("update_roadmap", { expectedRevision: ok(await slice.prism.call("get_roadmap", {})).revision, operations: [{ op: "ship", id: "reports", afterGate: gate }] }));
  await codeOn(slice);
  const answer = await slice.files();
  assert.deepEqual(answer.shown, { commit: squashed, source: "ship" });
  assert.equal(answer.shipped, squashed);
  assert.ok(answer.files.every((file) => file.state === "same as verified"));
});

test("clause 56: without either commit or without code content the page says why no file is shown", async (context) => {
  const slice = await verifiedSlice(context, { pushed: false });
  const off = await slice.files();
  assert.equal(off.shown, null);
  assert.ok(off.files.every((file) => file.state === "not available"));
  assert.match(off.message, /code/);
  await codeOn(slice);
  const missing = await slice.files();
  assert.equal(missing.shown, null);
  assert.match(missing.message, /verified commit/);
  assert.match(missing.message, /ship/);
  const unverified = await verifiedSlice(context, { verify: false });
  const none = await unverified.files();
  assert.deepEqual(none.files, []);
  assert.match(none.message, /passing/);
});

test("clause 57: unpushed work shows only as presence from runs and claims, never as content", async (context) => {
  const slice = await verifiedSlice(context, { pushed: false });
  await codeOn(slice);
  const entity = (await slice.app.get(`/w/${slice.id}/api/entity?ref=${encodeURIComponent("slice:reports/reports")}`)).json;
  const run = entity.presence.find((item) => item.source === "run");
  const host = os.hostname().split(".")[0];
  assert.deepEqual(run, { source: "run", branch: "feature-x", host, text: `in progress in feature-x on ${host}, not pushed` });
  const content = await slice.app.get(`/w/${slice.id}/api/code/file?repository=api&commit=${slice.head}&path=${encodeURIComponent("src/report.js")}`);
  assert.equal(content.status, 404);
  assert.doesNotMatch(JSON.stringify(entity), /signed/);
  const started = await verifiedSlice(context, { pushed: false, verify: false });
  const claimed = (await started.app.get(`/w/${started.id}/api/entity?ref=${encodeURIComponent("slice:reports/reports")}`)).json;
  const claim = claimed.presence.find((item) => item.source === "claim");
  assert.equal(claim.branch, null);
  assert.match(claim.text, /^in progress on \S/);
});
