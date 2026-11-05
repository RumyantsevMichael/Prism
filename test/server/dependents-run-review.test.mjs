import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, THREE, command, componentProject, failing, node, planAndAccept, runLog, update, workflow, write } from "./fixtures/components.mjs";
import { splitEvidence } from "./fixtures/split-evidence.mjs";

// Regressions found by reviewing the dependents' run: a chat answer allows only what the chat question named,
// a leaf whose component was removed adds no dependents to the run nor to ship, a call after a decline joins the run it started,
// and only a run with declined pairs is returned again for its gate, until a call without that gate asks again.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-dependents-review-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { answerUserGate, readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
const { getRoadmap, updateRoadmap } = await import("../../dist/server/workflow/roadmap.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

// slow.mjs logs when it starts and ends, outside the project, and takes the given milliseconds.
const SLOW = [
  'import { appendFileSync } from "node:fs";',
  "const [name, ms = \"400\"] = process.argv.slice(2);",
  "const log = (at) => { if (process.env.COMPONENT_LOG) appendFileSync(process.env.COMPONENT_LOG, `${JSON.stringify({ name, at })}\\n`); };",
  "log(\"start\");",
  "setTimeout(() => log(\"end\"), Number(ms));",
  ""
].join("\n");
const slow = (name, ms, depth = 2) => `${node} ${"../".repeat(depth)}slow.mjs ${name} ${ms}`;
const FILES = { "slow.mjs": SLOW, "apps/admin/index.mjs": "export const admin = 1;\n" };

const verify = (root, slice, extra = {}) => verifySlice({ projectRoot: root, initiative: INITIATIVE, slice, ...extra });
const allow = (root, id, choice = "allow") => answerUserGate({ projectRoot: root, initiative: INITIATIVE, id, choice, note: null });
const pendingGates = async (root) => (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.map((item) => item.id);

async function finish(root, slug) {
  await update(root, [{ op: "set_status", slug, status: "in-progress" }]);
  let result = await verify(root, slug);
  if (result.status === "approval_needed") {
    await allow(root, result.gateId);
    result = await verify(root, slug, { approvalGate: result.gateId });
  }
  assert.equal(result.status, "passed", result.outputTail);
}

// A one-slice scope in shared whose slice passed.
async function sharedScope(context, components) {
  const root = await componentProject(context, { config: workflow({ components }), files: FILES, requirements: ["r.md#2"] });
  await writeFile(path.join(root, `docs/plans/${INITIATIVE}/slice.md`), "# Work\n\n## Contract\n1. Shared values.\n\n## Changes\n- change `packages/shared/index.mjs`: `shared` (§1)\n");
  await update(root, [{ op: "propose_design", slug: INITIATIVE, operations: [{ op: "accept_design", slug: INITIATIVE, frozenTests: ["packages/shared/test/shared.test.mjs"], review: "none", component: "shared" }] }]);
  await update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]);
  await finish(root, INITIATIVE);
  return root;
}

async function ship(root) {
  let current = await getRoadmap({ projectRoot: root });
  if (!current.record?.initiatives?.some((item) => item.id === INITIATIVE)) await updateRoadmap({ projectRoot: root, expectedRevision: current.revision ?? null, operations: [{ op: "add_initiative", id: INITIATIVE, title: "Work", intent: "Ship the work.", band: "Now" }] });
  current = await getRoadmap({ projectRoot: root });
  return updateRoadmap({ projectRoot: root, expectedRevision: current.revision, operations: [{ op: "ship", id: INITIATIVE }] });
}

const BILLING_WEB = ["## Components", "- shared: packages/shared", `  - Test command: ${command("shared")}`, "- billing: packages/billing", `  - Test command: ${command("billing")}`, "  - Depends on: shared", "- web: apps/web", "  - Depends on: billing", ""].join("\n");

test("a chat answer allows only the pairs that the chat question named", async (context) => {
  const root = await sharedScope(context, BILLING_WEB);
  process.env.CLAUDE_CODE_REMOTE = "true";
  try {
    const first = await verify(root, INITIATIVE, { dependents: true });
    assert.deepEqual(first.commands.map((item) => item.folder), ["packages/billing", ""]);
    // web no longer depends on billing, so only billing's pair is needed, and the gate that also asks about web's is not reused.
    await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: BILLING_WEB.replace("  - Depends on: billing\n", "") }));
    const second = await verify(root, INITIATIVE, { dependents: true });
    assert.equal(second.status, "approval_needed");
    assert.notEqual(second.gateId, first.gateId);
    assert.deepEqual(second.commands.map((item) => item.folder), ["packages/billing"]);
    assert.ok(!second.message.includes(`${command("root", 0)} in the project root`), "the chat question names only billing");
    assert.equal((await verify(root, INITIATIVE, { dependents: true, approvalGate: second.gateId, chatApproval: { quote: `Yes, run ${command("billing")} in packages/billing.` } })).status, "passed");
    // web depends on billing again, and its root command in the project root was never named in an answered chat question.
    await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: BILLING_WEB }));
    const third = await verify(root, INITIATIVE, { dependents: true });
    assert.equal(third.status, "approval_needed");
    assert.deepEqual(third.commands, [{ command: command("root", 0), folder: "", components: ["root/web"] }]);
    assert.ok(third.message.includes(`${command("root", 0)} in the project root`), third.message);
  } finally { delete process.env.CLAUDE_CODE_REMOTE; }
});

test("a leaf whose component was removed adds no dependents to the dependents' run or to ship", async (context) => {
  const declaration = (withWeb) => ["## Components", "- shared: packages/shared", `  - Test command: ${command("shared")}`, "- billing: packages/billing", `  - Test command: ${command("billing")}`, "  - Depends on: shared", ...(withWeb ? ["- web: apps/web", "  - Depends on: billing"] : []), "- admin: apps/admin", `  - Test command: ${command("admin")}`, "  - Depends on: shared", ""].join("\n");
  const root = await componentProject(context, { config: workflow({ components: declaration(true) }), files: FILES });
  await planAndAccept(root, THREE);
  for (const slug of ["billing-totals", "shared-values", "web-pages"]) await finish(root, slug);
  // web, which nothing depends on, is removed while web-pages still records it.
  await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: declaration(false) }));
  const refused = await ship(root).then(() => null, (error) => error);
  assert.equal(refused?.code, "dependents_blocked");
  assert.deepEqual(refused.scopes, [{ scope: INITIATIVE, blocked: ["root/billing", "root/admin"], reason: "not_run" }]);
  const asked = await verify(root, INITIATIVE, { dependents: true });
  assert.equal(asked.status, "approval_needed");
  await allow(root, asked.gateId);
  const ran = await verify(root, INITIATIVE, { dependents: true, approvalGate: asked.gateId });
  assert.equal(ran.status, "passed");
  assert.deepEqual(ran.components.map((item) => item.name), refused.scopes[0].blocked);
  assert.equal((await ship(root)).record.initiatives.find((item) => item.id === INITIATIVE).decision.kind, "shipped");
});

test("after a decline, calling again with the same arguments joins the running dependents' run and opens no new gate", async (context) => {
  const declaration = (again) => ["## Components", "- shared: packages/shared", `  - Test command: ${command("shared")}`, "- billing: packages/billing", `  - Test command: ${command("billing")}${again}`, "  - Depends on: shared", "- admin: apps/admin", `  - Test command: ${slow("admin", 1500)}`, "  - Depends on: shared", ""].join("\n");
  const runs = await runLog(context);
  const root = await sharedScope(context, declaration(""));
  const first = await verify(root, INITIATIVE, { dependents: true });
  await allow(root, first.gateId);
  assert.equal((await verify(root, INITIATIVE, { dependents: true, approvalGate: first.gateId })).status, "passed");
  // billing's changed command is a new pair, which the user declines while admin's allowed pair still runs.
  await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: declaration(" again") }));
  const asked = await verify(root, INITIATIVE, { dependents: true });
  assert.equal(asked.status, "approval_needed");
  await allow(root, asked.gateId, "decline");
  const arguments_ = { dependents: true, approvalGate: asked.gateId, maxWaitMs: 200 };
  assert.equal((await verify(root, INITIATIVE, arguments_)).status, "running");
  const gates = await pendingGates(root);
  const again = await verify(root, INITIATIVE, arguments_);
  assert.equal(again.status, "running", "the same arguments join the running run");
  const finished = await verify(root, INITIATIVE, { ...arguments_, maxWaitMs: 10000 });
  assert.equal(finished.status, "failed");
  assert.deepEqual(finished.components.map(({ name, status }) => ({ name, status })), [{ name: "root/billing", status: "declined" }, { name: "root/admin", status: "passed" }]);
  // Once the run finished, the same arguments still return that run.
  const later = await verify(root, INITIATIVE, arguments_);
  assert.equal(later.run, finished.run);
  assert.deepEqual(await pendingGates(root), gates, "no new gate opened");
  assert.equal((await runs()).filter((item) => item.name === "admin" && item.at === "start").length, 2, "admin ran once for each started run");
});

test("the dependents' runs of two scopes in one work tree run one after the other", async (context) => {
  const declaration = ["## Components", "- shared: packages/shared", `  - Test command: ${command("shared")}`, "- billing: packages/billing", `  - Test command: ${slow("billing", 600)}`, "  - Depends on: shared", "- docs: handbook", `  - Test command: ${slow("docs", 600, 1)}`, "  - Depends on: root", ""].join("\n");
  const runs = await runLog(context);
  const root = await componentProject(context, { config: workflow({ components: declaration }), files: FILES, requirements: ["r.md#1", "r.md#2"] });
  const evidence = await splitEvidence(root, `docs/plans/${INITIATIVE}`, "values");
  await update(root, [{ op: "split", parent: INITIATIVE, children: [{ slug: "tools", title: "Tools", requirements: ["r.md#1"] }, { slug: "values", title: "Values", requirements: ["r.md#2"] }], evidence }]);
  for (const [slug, component, change, frozen] of [["tools", "root", "change `README.md`: overview (§1)", "test/root.test.mjs"], ["values", "shared", "change `packages/shared/index.mjs`: `shared` (§2)", "packages/shared/test/shared.test.mjs"]]) {
    await write(root, { [`docs/plans/${INITIATIVE}/${slug}/slice.md`]: `# ${slug}\n\n## Contract\n1. Billing totals.\n2. Shared values.\n\n## Changes\n- ${change}\n` });
    await update(root, [{ op: "propose_design", slug, operations: [{ op: "accept_design", slug, frozenTests: [frozen], review: "none", component }] }]);
    await update(root, [{ op: "accept_proposal", slug, reviewRequired: [] }]);
    await finish(root, slug);
  }
  // Each scope's dependents are allowed and pass once, so the runs below write no gate while the other runs.
  for (const scope of ["tools", "values"]) {
    const asked = await verify(root, scope, { dependents: true });
    assert.equal(asked.status, "approval_needed");
    await allow(root, asked.gateId);
    assert.equal((await verify(root, scope, { dependents: true, approvalGate: asked.gateId })).status, "passed");
  }
  const before = (await runs()).length;
  const results = await Promise.all(["tools", "values"].map((scope) => verify(root, scope, { dependents: true })));
  assert.deepEqual(results.map((item) => item.status), ["passed", "passed"]);
  assert.deepEqual((await runs()).slice(before).map((item) => item.at), ["start", "end", "start", "end"], "one run ends before the other starts");
});

const BILLING = ["## Components", "- shared: packages/shared", `  - Test command: ${command("shared")}`, "- billing: packages/billing", `  - Test command: ${command("billing")}`, "  - Depends on: shared", ""].join("\n");

test("after a failed dependents' run is fixed, calling again with its allowed gate runs the dependents again", async (context) => {
  const root = await sharedScope(context, BILLING);
  failing(context, "billing");
  const asked = await verify(root, INITIATIVE, { dependents: true });
  assert.equal(asked.status, "approval_needed");
  await allow(root, asked.gateId);
  const failed = await verify(root, INITIATIVE, { dependents: true, approvalGate: asked.gateId });
  assert.equal(failed.status, "failed");
  assert.ok(!failed.message.includes("without approvalGate"), failed.message);
  // billing is fixed, and the dependents' run is called again with the same arguments.
  delete process.env.FAIL_billing;
  const again = await verify(root, INITIATIVE, { dependents: true, approvalGate: asked.gateId });
  assert.equal(again.status, "passed");
  assert.notEqual(again.run, failed.run, "a new run started");
});

test("a run without the gate leaves no older run to return for that gate", async (context) => {
  const runs = await runLog(context);
  const root = await sharedScope(context, BILLING);
  const asked = await verify(root, INITIATIVE, { dependents: true });
  await allow(root, asked.gateId);
  const passed = await verify(root, INITIATIVE, { dependents: true, approvalGate: asked.gateId });
  assert.equal(passed.status, "passed");
  failing(context, "billing");
  const fresh = await verify(root, INITIATIVE, { dependents: true });
  assert.equal(fresh.status, "failed");
  const stale = await verify(root, INITIATIVE, { dependents: true, approvalGate: asked.gateId });
  assert.equal(stale.status, "failed");
  assert.ok(![passed.run, fresh.run].includes(stale.run), "the old gate starts a new run");
  // A dependent declared since then needs a new approval, which the old gate does not give.
  await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: `${BILLING}- web: apps/web\n  - Test command: echo web\n  - Depends on: billing\n` }));
  const declared = await verify(root, INITIATIVE, { dependents: true, approvalGate: asked.gateId });
  assert.equal(declared.status, "approval_needed");
  assert.deepEqual(declared.commands.map((item) => item.components), [["root/web"]]);
  assert.equal((await runs()).filter((item) => item.name === "billing").length, 3, "billing ran once for each started run");
});

test("a declined run is returned for its gate and says to call without the gate, which asks again", async (context) => {
  const root = await sharedScope(context, BILLING);
  const asked = await verify(root, INITIATIVE, { dependents: true });
  await allow(root, asked.gateId, "decline");
  const declined = await verify(root, INITIATIVE, { dependents: true, approvalGate: asked.gateId });
  assert.equal(declined.status, "failed");
  assert.ok(declined.message.includes("without approvalGate"), declined.message);
  const repeated = await verify(root, INITIATIVE, { dependents: true, approvalGate: asked.gateId });
  assert.equal(repeated.run, declined.run);
  assert.ok(repeated.message.includes("without approvalGate"), repeated.message);
  const again = await verify(root, INITIATIVE, { dependents: true });
  assert.equal(again.status, "approval_needed");
  assert.notEqual(again.gateId, asked.gateId);
  // Once asked again, the declined gate no longer returns its run.
  const old = await verify(root, INITIATIVE, { dependents: true, approvalGate: asked.gateId });
  assert.equal(old.status, "approval_needed");
  assert.equal(old.gateId, again.gateId);
});
