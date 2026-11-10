import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, command, componentProject, update, workflow, write } from "./fixtures/components.mjs";

// Review regression: a fix slice that finishes after its scope's passing dependents' run changes the scope's components,
// so ship must not accept the dependents' run that predates the fix.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-dwf-review-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { answerUserGate } = await import("../../dist/server/workflow/state.mjs");
const { getRoadmap, updateRoadmap } = await import("../../dist/server/workflow/roadmap.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const BILLING = ["## Components", "- shared: packages/shared", `  - Test command: ${command("shared")}`, "- billing: packages/billing", `  - Test command: ${command("billing")}`, "  - Depends on: shared", ""].join("\n");
const verify = (root, slice, extra = {}) => verifySlice({ projectRoot: root, initiative: INITIATIVE, slice, ...extra });

async function finish(root, slug) {
  await update(root, [{ op: "set_status", slug, status: "in-progress" }]);
  let result = await verify(root, slug);
  if (result.status === "approval_needed") {
    await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: result.gateId, choice: "allow", note: null });
    result = await verify(root, slug, { approvalGate: result.gateId });
  }
  assert.equal(result.status, "passed", result.outputTail);
}

test("a fix slice that finishes after the scope's dependents' run holds ship until the dependents run again", async (context) => {
  const root = await componentProject(context, { config: workflow({ components: BILLING }), requirements: ["r.md#2"] });
  await writeFile(path.join(root, `docs/plans/${INITIATIVE}/slice.md`), "# Work\n\n## Contract\n1. Shared values.\n\n## Changes\n- change `packages/shared/index.mjs`: `shared` (§1)\n");
  await update(root, [{ op: "propose_design", slug: INITIATIVE, operations: [{ op: "accept_design", slug: INITIATIVE, frozenTests: ["packages/shared/test/shared.test.mjs"], review: "none", component: "shared" }] }]);
  await update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]);
  await finish(root, INITIATIVE);
  const asked = await verify(root, INITIATIVE, { dependents: true });
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow", note: null });
  assert.equal((await verify(root, INITIATIVE, { dependents: true, approvalGate: asked.gateId })).status, "passed");
  // A defect in the done root slice is fixed by a fix slice that changes shared, which billing depends on.
  await update(root, [{ op: "report_defect", slug: INITIATIVE, requirements: ["r.md#2"], summary: "Shared values are wrong." }]);
  await write(root, {
    [`docs/plans/${INITIATIVE}/fix-shared/slice.md`]: "# Fix shared\n\n## Contract\n1. Shared values are right.\n\n## Changes\n- change `packages/shared/index.mjs`: `shared` (§1)\n",
    "packages/shared/test/fix.test.mjs": "// frozen fix test\n"
  });
  await update(root, [{ op: "propose_design", slug: INITIATIVE, operations: [
    { op: "add_fix", slug: INITIATIVE, defects: ["d1"], fix: { slug: "fix-shared", title: "Fix shared", outcome: "Shared values are right.", requirements: ["r.md#2"] } },
    { op: "accept_design", slug: "fix-shared", frozenTests: ["packages/shared/test/fix.test.mjs"], review: "none", component: "shared" }
  ] }]);
  await update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]);
  await update(root, [{ op: "set_status", slug: "fix-shared", status: "in-progress" }]);
  await writeFile(path.join(root, "packages/shared/index.mjs"), "export const shared = 2;\n");
  const fixed = await verify(root, "fix-shared");
  assert.equal(fixed.status, "passed", fixed.outputTail);
  let current = await getRoadmap({ projectRoot: root });
  await updateRoadmap({ projectRoot: root, expectedRevision: current.revision ?? null, operations: [{ op: "add_initiative", id: INITIATIVE, title: "Work", intent: "Ship the work.", band: "Now" }] });
  current = await getRoadmap({ projectRoot: root });
  const refused = await updateRoadmap({ projectRoot: root, expectedRevision: current.revision, operations: [{ op: "ship", id: INITIATIVE }] }).then(() => null, (error) => error);
  assert.equal(refused?.code, "dependents_blocked", "ship accepted the dependents' run that ran before the fix changed shared");
  assert.deepEqual(refused.scopes.map(({ scope, blocked, reason }) => ({ scope, blocked, reason })), [{ scope: INITIATIVE, blocked: ["root/billing"], reason: "stale" }]);
  assert.match(refused.scopes[0].run, /\.json$/, "the refusal names the stale run");
  assert.match(refused.message, /predates/);
  const roadmap = await getRoadmap({ projectRoot: root });
  const derived = roadmap.derived.find((item) => item.id === INITIATIVE);
  assert.equal(derived.readyToShip, false);
  assert.ok(derived.diagnostics.some((item) => item.code === "dependents_blocked"));
  // A dependents' run after the fix makes the scope's dependents fresh again.
  assert.equal((await verify(root, INITIATIVE, { dependents: true })).status, "passed");
  current = await getRoadmap({ projectRoot: root });
  await updateRoadmap({ projectRoot: root, expectedRevision: current.revision, operations: [{ op: "ship", id: INITIATIVE }] });
});
