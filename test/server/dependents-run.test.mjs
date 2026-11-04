import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, THREE, command, componentProject, failing, node, planAndAccept, read, refusal, runLog, update, workflow, write } from "./fixtures/components.mjs";
import { splitEvidence } from "./fixtures/split-evidence.mjs";

// Requirements: docs/requirements/components.md §17, §18, §19.
// Contract: docs/plans/components/component-slices/slice.md clauses 24-31.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-dependents-run-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { answerUserGate } = await import("../../dist/server/workflow/state.mjs");
const { updateRoadmap, getRoadmap } = await import("../../dist/server/workflow/roadmap.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

// shared is used by billing and admin, and web uses billing; web and admin have no test command of their own, and docs depends on nothing.
const DEPENDENTS = [
  "## Components",
  "- shared: packages/shared",
  `  - Test command: ${command("shared")}`,
  "- billing: packages/billing",
  `  - Test command: ${command("billing")}`,
  "  - Depends on: shared",
  "- web: apps/web",
  "  - Depends on: billing",
  "- admin: apps/admin",
  "  - Depends on: shared",
  "- docs: handbook",
  `  - Test command: ${command("docs", 1)}`,
  "- Shared paths: package-lock.json",
  ""
].join("\n");
const FILES = { "apps/admin/index.mjs": "export const admin = 1;\n", "apps/admin/test/admin.test.mjs": "// frozen admin test\n", "handbook/test/guide.test.mjs": "// frozen guide test\n" };

const verify = (root, slice, extra = {}) => verifySlice({ projectRoot: root, initiative: INITIATIVE, slice, ...extra });
const dependents = (root, scope, extra = {}) => verify(root, scope, { dependents: true, ...extra });
const allow = (root, id, choice = "allow", note = null) => answerUserGate({ projectRoot: root, initiative: INITIATIVE, id, ...(choice === null ? {} : { choice }), note });

// Start a slice and verify it, allowing its command when Prism asks, so a slice marked review none is done.
async function finish(root, slug) {
  await update(root, [{ op: "set_status", slug, status: "in-progress" }]);
  let result = await verify(root, slug);
  if (result.status === "approval_needed") {
    await allow(root, result.gateId);
    result = await verify(root, slug, { approvalGate: result.gateId });
  }
  assert.equal(result.status, "passed", result.outputTail);
  return result;
}

// Run a scope's dependents, allowing every listed pair when Prism asks.
async function runDependents(root, scope) {
  const first = await dependents(root, scope);
  if (first.status !== "approval_needed") return first;
  await allow(root, first.gateId);
  return dependents(root, scope, { approvalGate: first.gateId });
}

// A one-slice scope: the initiative's root slice takes its own design for one component.
async function oneSlice(context, { component = "shared", changes = ["change `packages/shared/index.mjs`: `shared` (§2)"], tests = ["packages/shared/test/shared.test.mjs"], config = workflow({ components: DEPENDENTS }) } = {}) {
  const root = await componentProject(context, { config, files: FILES, requirements: ["r.md#2"] });
  await writeFile(path.join(root, `docs/plans/${INITIATIVE}/slice.md`), `# Work\n\n## Contract\n1. Billing totals.\n2. Shared values.\n\n## Changes\n${changes.map((line) => `- ${line}`).join("\n")}\n`);
  await update(root, [{ op: "propose_design", slug: INITIATIVE, operations: [{ op: "accept_design", slug: INITIATIVE, frozenTests: tests, review: "none", ...(component ? { component } : {}) }] }]);
  await update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]);
  return root;
}

// A root split into two parts with evidence, each a one-slice scope: tools in the root component and values in shared.
async function twoParts(context) {
  const root = await componentProject(context, { config: workflow({ components: DEPENDENTS }), files: FILES, requirements: ["r.md#1", "r.md#2"] });
  const evidence = await splitEvidence(root, `docs/plans/${INITIATIVE}`, "values");
  await update(root, [{ op: "split", parent: INITIATIVE, children: [{ slug: "tools", title: "Tools", requirements: ["r.md#1"] }, { slug: "values", title: "Values", requirements: ["r.md#2"] }], evidence }]);
  for (const [slug, component, change, test] of [["tools", "root", "change `README.md`: overview (§1)", "test/root.test.mjs"], ["values", "shared", "change `packages/shared/index.mjs`: `shared` (§2)", "packages/shared/test/shared.test.mjs"]]) {
    await write(root, { [`docs/plans/${INITIATIVE}/${slug}/slice.md`]: `# ${slug}\n\n## Contract\n1. Billing totals.\n2. Shared values.\n\n## Changes\n- ${change}\n` });
    await update(root, [{ op: "propose_design", slug, operations: [{ op: "accept_design", slug, frozenTests: [test], review: "none", component }] }]);
    await update(root, [{ op: "accept_proposal", slug, reviewRequired: [] }]);
  }
  return root;
}

const roadmap = async (root) => {
  const current = await getRoadmap({ projectRoot: root });
  if (!current.record?.initiatives?.some((item) => item.id === INITIATIVE)) await updateRoadmap({ projectRoot: root, expectedRevision: current.revision ?? null, operations: [{ op: "add_initiative", id: INITIATIVE, title: "Work", intent: "Ship the work.", band: "Now" }] });
};
async function ship(root) {
  await roadmap(root);
  const current = await getRoadmap({ projectRoot: root });
  return updateRoadmap({ projectRoot: root, expectedRevision: current.revision, operations: [{ op: "ship", id: INITIATIVE }] });
}

test("clauses 24 and 25: only a fit scope whose leaves are all done runs its dependents", async (context) => {
  const root = await componentProject(context, { config: workflow({ components: DEPENDENTS }), files: FILES });
  await planAndAccept(root, THREE);
  await finish(root, "billing-totals");
  const waiting = await refusal(dependents(root, INITIATIVE), "scope_unfinished");
  assert.deepEqual(waiting.waiting, ["shared-values", "web-pages"]);
  await refusal(dependents(root, "billing-totals"), "validation_failed");
  await refusal(dependents(root, INITIATIVE, { contractDefects: [{ clause: "§1", reason: "both" }] }), "validation_failed");

  const parts = await twoParts(context);
  await finish(parts, "tools");
  await finish(parts, "values");
  await refusal(dependents(parts, INITIATIVE), "validation_failed");
  const tools = await dependents(parts, "tools");
  assert.equal(tools.status, "no_dependents", "nothing depends on the root component here");
  assert.equal((await runDependents(parts, "values")).status, "passed", "a part of a split is a fit scope of its own");
});

test("clause 26: dependents are every transitive dependent, also for a scope inside one component, and a scope without any records nothing", async (context) => {
  const root = await oneSlice(context);
  await finish(root, INITIATIVE);
  const result = await runDependents(root, INITIATIVE);
  assert.equal(result.status, "passed");
  assert.equal(result.scope, INITIATIVE);
  assert.deepEqual(result.components.map((item) => item.name), ["billing", "web", "admin"]);

  const docs = await oneSlice(context, { component: "docs", changes: ["change `handbook/guide.md`: guide (§2)"], tests: ["handbook/test/guide.test.mjs"] });
  await finish(docs, INITIATIVE);
  const none = await dependents(docs, INITIATIVE);
  assert.equal(none.status, "no_dependents");
  assert.equal(none.scope, INITIATIVE);
  assert.deepEqual(none.components, []);
  assert.equal((await read(docs)).dependents, undefined, "nothing was recorded");

  const legacy = await oneSlice(context);
  const current = await read(legacy);
  const file = path.join(legacy, current.recordPath);
  const raw = JSON.parse(await readFile(file, "utf8"));
  delete raw.slices[INITIATIVE].component;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
  await finish(legacy, INITIATIVE);
  assert.equal((await dependents(legacy, INITIATIVE)).status, "no_dependents", "a leaf without a component adds no dependents");
});

test("clause 27: each distinct command and folder runs once, in dependency order, and a dependent without a command or folder is refused", async (context) => {
  const runs = await runLog(context);
  const root = await oneSlice(context);
  await finish(root, INITIATIVE);
  const result = await runDependents(root, INITIATIVE);
  assert.deepEqual(result.components.map(({ name, folder, command: text, status }) => ({ name, folder, command: text, status })), [
    { name: "billing", folder: "packages/billing", command: command("billing"), status: "passed" },
    { name: "web", folder: "", command: command("root", 0), status: "passed" },
    { name: "admin", folder: "", command: command("root", 0), status: "passed" }
  ]);
  assert.deepEqual((await runs()).map((entry) => [entry.name, entry.cwd]), [["shared", path.join(root, "packages/shared")], ["billing", path.join(root, "packages/billing")], ["root", root]], "the shared slice, then billing, then one run for web and admin");

  const commandless = await oneSlice(context, { config: workflow({ components: DEPENDENTS, stack: null }) });
  await finish(commandless, INITIATIVE);
  assert.equal((await refusal(dependents(commandless, INITIATIVE), "test_command_missing")).component, "web");
  const folderless = await oneSlice(context);
  await finish(folderless, INITIATIVE);
  await rm(path.join(folderless, "packages/billing"), { recursive: true, force: true });
  const missing = await refusal(dependents(folderless, INITIATIVE), "component_folder_missing");
  assert.equal(missing.component, "billing");
  assert.equal(missing.folder, "packages/billing");
});

test("clause 28: one gate lists every pair not yet allowed, a decline blocks its components while allowed pairs run, and a note alone is unclear", async (context) => {
  const runs = await runLog(context);
  const root = await twoParts(context);
  await finish(root, "tools");
  await finish(root, "values");
  const asked = await dependents(root, "values");
  assert.equal(asked.status, "approval_needed");
  assert.equal(asked.scope, "values");
  assert.deepEqual(asked.commands, [{ command: command("billing"), folder: "packages/billing", components: ["billing"] }], "the repository's command in the project root was allowed for the tools slice");
  assert.equal((await dependents(root, "values")).gateId, asked.gateId, "an unanswered gate is reused");
  await allow(root, asked.gateId, "decline", "Not billing.");
  const declined = await dependents(root, "values", { approvalGate: asked.gateId });
  assert.equal(declined.status, "failed");
  assert.deepEqual(declined.components.map((item) => [item.name, item.status]), [["billing", "declined"], ["web", "passed"], ["admin", "passed"]]);
  assert.deepEqual(declined.blocked, ["billing"]);
  assert.deepEqual((await runs()).filter((entry) => entry.name !== "shared").map((entry) => entry.name), ["root", "root"], "the tools slice, then one run of the allowed pair; billing never ran");

  const unclear = await dependents(root, "values");
  assert.equal(unclear.status, "approval_needed", "a declined pair is asked again by the next run");
  await allow(root, unclear.gateId, null, "Which billing tests?");
  assert.equal((await dependents(root, "values", { approvalGate: unclear.gateId })).status, "approval_unclear");
});

test("clause 29: the run is recorded on the scope with each dependent's result, and changed project files block every dependent", async (context) => {
  failing(context, "billing");
  const root = await oneSlice(context);
  await finish(root, INITIATIVE);
  const failed = await runDependents(root, INITIATIVE);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.components.map((item) => [item.name, item.status]), [["billing", "failed"], ["web", "passed"], ["admin", "passed"]]);
  assert.deepEqual(failed.blocked, ["billing"]);
  const run = JSON.parse(await readFile(path.join(root, failed.run), "utf8"));
  assert.equal(run.kind, "dependents");
  assert.equal(run.passed, false);
  assert.deepEqual(run.components.map((item) => [item.name, item.folder, item.command, item.status]), failed.components.map((item) => [item.name, item.folder, item.command, item.status]));
  assert.ok(failed.run.includes(INITIATIVE));

  const touching = DEPENDENTS.replace("- admin: apps/admin\n", `- admin: apps/admin\n  - Test command: ${node} -e "require('fs').writeFileSync('touched.txt', 'x')"\n`);
  const changed = await oneSlice(context, { config: workflow({ components: touching }) });
  delete process.env.FAIL_billing;
  await finish(changed, INITIATIVE);
  const result = await runDependents(changed, INITIATIVE);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "tracked_files_changed");
  assert.deepEqual(result.blocked, ["billing", "web", "admin"]);
});

test("clause 30: get_initiative reports each scope's latest dependents' run without reading components", async (context) => {
  failing(context, "billing");
  const root = await oneSlice(context);
  await finish(root, INITIATIVE);
  const failed = await runDependents(root, INITIATIVE);
  await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: "## Components\n- billing: packages\n- shared: packages/shared\n" }));
  const blocked = (await read(root)).dependents[INITIATIVE];
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.run, failed.run);
  assert.deepEqual(blocked.blocked, ["billing"]);
  assert.ok(Number.isFinite(Date.parse(blocked.finishedAt)));
  await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: DEPENDENTS }));
  delete process.env.FAIL_billing;
  const passed = await runDependents(root, INITIATIVE);
  assert.equal(passed.status, "passed");
  const latest = (await read(root)).dependents[INITIATIVE];
  assert.deepEqual({ ...latest, finishedAt: null }, { status: "passed", run: passed.run, finishedAt: null, blocked: [] });
});

test("clause 31: shipping waits for a passing dependents' run of every finished scope, and a repository without components ships as before", async (context) => {
  const root = await oneSlice(context);
  await finish(root, INITIATIVE);
  const notRun = await refusal(ship(root), "dependents_blocked");
  assert.deepEqual(notRun.scopes, [{ scope: INITIATIVE, blocked: ["billing", "web", "admin"], reason: "not_run" }]);
  failing(context, "billing");
  await runDependents(root, INITIATIVE);
  const red = await refusal(ship(root), "dependents_blocked");
  assert.deepEqual(red.scopes, [{ scope: INITIATIVE, blocked: ["billing"], reason: "failed" }]);
  delete process.env.FAIL_billing;
  assert.equal((await runDependents(root, INITIATIVE)).status, "passed");
  const grown = DEPENDENTS.replace("- docs: handbook\n", "- docs: handbook\n  - Depends on: shared\n");
  await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: grown }));
  const missing = await refusal(ship(root), "dependents_blocked");
  assert.deepEqual(missing.scopes, [{ scope: INITIATIVE, blocked: ["docs"], reason: "not_run" }], "a dependent declared after the run has not run");
  await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: DEPENDENTS }));
  const shipped = await ship(root);
  assert.equal(shipped.record.initiatives.find((item) => item.id === INITIATIVE).decision.kind, "shipped");

  const plain = await oneSlice(context, { component: null, config: workflow({ components: null }), changes: ["change `packages/shared/index.mjs`: `shared` (§2)"] });
  await finish(plain, INITIATIVE);
  assert.equal((await ship(plain)).record.initiatives.find((item) => item.id === INITIATIVE).decision.kind, "shipped");
});
