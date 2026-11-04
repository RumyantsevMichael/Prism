import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, THREE, command, commitAll, componentProject, git, node, planAndAccept, read, refusal, runLog, update, workflow, write } from "./fixtures/components.mjs";

// Requirements: docs/requirements/components.md §10, §15, §16, §19.
// Contract: docs/plans/components/component-slices/slice.md clauses 16-23.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-component-verification-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { verificationBrief, verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { answerUserGate, readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const verify = (root, slice, extra = {}) => verifySlice({ projectRoot: root, initiative: INITIATIVE, slice, ...extra });
const start = (root, slug) => update(root, [{ op: "set_status", slug, status: "in-progress" }]);

// Verify a slice, allowing its command in the review browser when Prism asks.
async function verifyAllowed(root, slice) {
  const first = await verify(root, slice);
  if (first.status !== "approval_needed") return first;
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: first.gateId, choice: "allow", note: null });
  return verify(root, slice, { approvalGate: first.gateId });
}

// A project with the usual declaration and the three-slice plan accepted, and the named slice started.
async function started(context, slug = "billing-totals", options = {}) {
  const root = await componentProject(context, options);
  await planAndAccept(root, options.plan ?? THREE);
  await start(root, slug);
  return root;
}

const recorded = async (root, result) => JSON.parse(await readFile(path.join(root, result.run ?? result.path), "utf8"));

// Remove a slice's component from its record, as a slice accepted before components existed has none.
async function forgetComponent(root, slug) {
  const current = await read(root);
  const file = path.join(root, current.recordPath);
  const raw = JSON.parse(await readFile(file, "utf8"));
  delete raw.slices[slug].component;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
}

test("clause 16: a slice runs its component's command in the component's folder, or the repository's command in the project root", async (context) => {
  const runs = await runLog(context);
  const root = await started(context);
  const own = await verifyAllowed(root, "billing-totals");
  assert.equal(own.status, "passed", own.outputTail);
  assert.equal(own.command, command("billing"));
  await start(root, "web-pages");
  const inherited = await verifyAllowed(root, "web-pages");
  assert.equal(inherited.status, "passed", inherited.outputTail);
  assert.equal(inherited.command, command("root", 0), "a component without its own command runs the repository's");
  assert.deepEqual((await runs()).map((entry) => [entry.name, entry.cwd]), [["billing", path.join(root, "packages/billing")], ["root", root]]);

  const rootSlice = { slug: "billing-totals", component: "root", requirement: "r.md#1", changes: ["change `README.md`: overview (§1)"], tests: ["test/root.test.mjs"] };
  const rootProject = await componentProject(context, { config: workflow({ components: "## Components\n- root-tools: tools\n  - Test command: tools-only\n" }), requirements: ["r.md#1"] });
  await planAndAccept(rootProject, [rootSlice]);
  await start(rootProject, "billing-totals");
  const rooted = await verifyAllowed(rootProject, "billing-totals");
  assert.equal(rooted.status, "passed", rooted.outputTail);
  assert.equal(rooted.command, command("root", 0), "the root component always runs the repository's command");
  assert.equal(rooted.folder, "");
});

test("clause 16: a slice without a component runs the repository's command in the project root and reads no components", async (context) => {
  const runs = await runLog(context);
  const root = await started(context);
  await forgetComponent(root, "billing-totals");
  await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: "## Components\n- billing: packages\n- shared: packages/shared\n" }));
  const legacy = await verifyAllowed(root, "billing-totals");
  assert.equal(legacy.status, "passed", legacy.outputTail);
  assert.equal(legacy.command, command("root", 0));
  assert.equal(legacy.folder, "");
  assert.equal(Object.hasOwn(legacy, "component"), false);
  assert.equal(Object.hasOwn(legacy, "boundary"), false);
  assert.deepEqual((await runs()).map((entry) => entry.cwd), [root]);
});

test("clause 17: results, recorded runs, and brief results name the working folder and the component", async (context) => {
  const root = await started(context);
  const asked = await verify(root, "billing-totals");
  assert.equal(asked.status, "approval_needed");
  assert.equal(asked.command, command("billing"));
  assert.equal(asked.folder, "packages/billing");
  assert.equal(asked.component, "billing");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow", note: null });
  const passed = await verify(root, "billing-totals", { approvalGate: asked.gateId });
  assert.equal(passed.status, "passed", passed.outputTail);
  assert.equal(passed.folder, "packages/billing");
  assert.equal(passed.component, "billing");
  const run = await recorded(root, passed);
  assert.equal(run.command, command("billing"));
  assert.equal(run.folder, "packages/billing");
  assert.equal(run.component, "billing");
  const brief = verificationBrief(passed);
  assert.equal(brief.component, "billing");
  assert.equal(brief.folder, "packages/billing");
  assert.equal(brief.boundary, "checked");
});

test("clause 18: a component that is gone, a missing test command, or a missing folder is refused before any approval", async (context) => {
  const gone = await started(context);
  await writeFile(path.join(gone, ".prism/workflow.md"), workflow({ components: "## Components\n- shared: packages/shared\n- web: apps/web\n" }));
  const unknown = await refusal(verify(gone, "billing-totals"), "component_unknown");
  assert.equal(unknown.slice, "billing-totals");
  assert.equal(unknown.component, "billing");
  assert.deepEqual(unknown.components, ["root", "shared", "web"]);

  const commandless = await started(context, "web-pages", { config: workflow({ stack: null }) });
  const missing = await refusal(verify(commandless, "web-pages"), "test_command_missing");
  assert.equal(missing.component, "web");

  const folderless = await started(context);
  await rm(path.join(folderless, "packages/billing"), { recursive: true, force: true });
  const noFolder = await refusal(verify(folderless, "billing-totals"), "component_folder_missing");
  assert.equal(noFolder.component, "billing");
  assert.equal(noFolder.folder, "packages/billing");
  for (const root of [gone, commandless, folderless]) assert.deepEqual((await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state?.pending ?? [], [], "no approval was asked");
});

test("clause 19: each pair of command and folder is allowed once, and an approval from before components still allows the project root", async (context) => {
  const same = `${node} ../../check.mjs same`;
  const config = workflow({ components: `## Components\n- billing: packages/billing\n  - Test command: ${same}\n- shared: packages/shared\n  - Test command: ${same}\n- web: apps/web\n` });
  const root = await started(context, "billing-totals", { config });
  const first = await verify(root, "billing-totals");
  assert.equal(first.status, "approval_needed");
  const gate = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((item) => item.id === first.gateId);
  assert.ok(gate.question.includes(same), "the question names the command");
  assert.ok(gate.question.includes("packages/billing"), "the question names the folder");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: first.gateId, choice: "allow", note: null });
  assert.equal((await verify(root, "billing-totals", { approvalGate: first.gateId })).status, "passed");
  await start(root, "shared-values");
  const other = await verify(root, "shared-values");
  assert.equal(other.status, "approval_needed", "the same command in another folder asks again");
  assert.equal(other.folder, "packages/shared");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: other.gateId, choice: "allow", note: null });
  assert.equal((await verify(root, "shared-values", { approvalGate: other.gateId })).status, "passed");

  // The approvals file of Prism 0.17.0 keys an approval by the project root and the command text.
  const earlier = await started(context, "web-pages");
  const rootCommand = command("root", 0);
  const file = path.join(privateData, "verification-approvals.json");
  const approvals = await readFile(file, "utf8").then(JSON.parse, () => ({ schemaVersion: 1, approved: {}, requests: {} }));
  approvals.approved[createHash("sha256").update(`${earlier}\n${rootCommand}`).digest("hex")] = { root: earlier, command: rootCommand, approvedAt: "2026-11-01T10:00:00.000Z", gate: "gate-0000000000" };
  await writeFile(file, `${JSON.stringify(approvals, null, 2)}\n`);
  const allowed = await verify(earlier, "web-pages");
  assert.equal(allowed.status, "passed", "the earlier approval of the repository's command still allows it in the project root");
  assert.equal(allowed.folder, "");
});

test("clauses 20-22: changes since the slice started that leave its component fail the run without running the command", async (context) => {
  const runs = await runLog(context);
  const root = await componentProject(context);
  await planAndAccept(root, THREE);
  // A change made before the slice starts is part of its start content.
  await write(root, { "apps/web/index.mjs": "export const web = 0;\n" });
  await start(root, "billing-totals");
  const asked = await verify(root, "billing-totals");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow", note: null });
  await write(root, { "packages/shared/index.mjs": "export const shared = 2;\n" });
  commitAll(root, "committed change in shared");
  await write(root, { "apps/web/index.mjs": "export const web = 2;\n", "package-lock.json": "{\"lock\":2}\n", "config/shared/base.json": "{\"base\":2}\n", "packages/billing/index.mjs": "export const total = 2;\n" });
  await mkdir(path.join(root, "packages/billing/lib"), { recursive: true });
  await rename(path.join(root, "README.md"), path.join(root, "packages/billing/lib/README.md"));
  // The other unfinished slices' frozen tests go back in place for a design revision, which is no change of this slice.
  await update(root, [{ op: "restore_tests", slug: INITIATIVE }]);
  const failed = await verify(root, "billing-totals", { approvalGate: asked.gateId });
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "component_boundary");
  assert.match(failed.message, /component/);
  assert.deepEqual(failed.crossing, ["README.md", "apps/web/index.mjs", "packages/shared/index.mjs"]);
  assert.equal(failed.crossingCount, 3);
  assert.deepEqual(await runs(), [], "the command did not run");
  const run = await recorded(root, failed);
  assert.equal(run.passed, false);
  assert.equal(run.reason, "component_boundary");
  assert.deepEqual(run.crossing, failed.crossing);
  assert.equal(verificationBrief(failed).reason, "component_boundary");
  assert.notEqual((await read(root)).record.slices["billing-totals"].status, "done");

  await rename(path.join(root, "packages/billing/lib/README.md"), path.join(root, "README.md"));
  git(root, "checkout", "-q", "HEAD~1", "--", "packages/shared/index.mjs");
  await write(root, { "apps/web/index.mjs": "export const web = 0;\n" });
  const passed = await verify(root, "billing-totals");
  assert.equal(passed.status, "passed", passed.outputTail);
  assert.equal(passed.boundary, "checked");
  assert.equal((await read(root)).record.slices["billing-totals"].status, "done");
});

test("clause 22: a run lists at most 200 crossing paths and counts them all", async (context) => {
  const root = await started(context);
  const asked = await verify(root, "billing-totals");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow", note: null });
  await write(root, Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`packages/shared/generated/file-${String(index).padStart(3, "0")}.mjs`, "export {};\n"])));
  const failed = await verify(root, "billing-totals", { approvalGate: asked.gateId });
  assert.equal(failed.reason, "component_boundary");
  assert.equal(failed.crossing.length, 200);
  assert.equal(failed.crossing[0], "packages/shared/generated/file-000.mjs");
  assert.equal(failed.crossingCount, 205);
});

test("clauses 20 and 23: a slice started where Git could not hash the work tree runs without the boundary check and says so", async (context) => {
  const runs = await runLog(context);
  const root = await componentProject(context);
  await planAndAccept(root, THREE);
  await rm(path.join(root, ".git"), { recursive: true, force: true });
  await start(root, "billing-totals");
  git(root, "init", "-q", "-b", "main");
  commitAll(root, "start again");
  await write(root, { "packages/shared/index.mjs": "export const shared = 3;\n" });
  const result = await verifyAllowed(root, "billing-totals");
  assert.equal(result.status, "passed", result.outputTail);
  assert.equal(result.boundary, "unchecked");
  assert.equal((await recorded(root, result)).boundary, "unchecked");
  assert.deepEqual((await runs()).map((entry) => entry.name), ["billing"]);
});
