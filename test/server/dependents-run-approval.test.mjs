import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, command, componentProject, refusal, update, workflow } from "./fixtures/components.mjs";

// The dependents' run asks one gate for many commands, so a gate allows exactly the pairs it lists and names each folder without a path of the machine.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-dependents-approval-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { answerUserGate, readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const DECLARATION = [
  "## Components",
  "- shared: packages/shared",
  `  - Test command: ${command("shared")}`,
  "- billing: packages/billing",
  `  - Test command: ${command("billing")}`,
  "  - Depends on: shared",
  "- web: apps/web",
  "  - Depends on: billing",
  ""
].join("\n");

const verify = (root, extra = {}) => verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: INITIATIVE, ...extra });

// A one-slice scope in shared whose slice passed, so billing and web depend on it.
async function finishedScope(context) {
  const root = await componentProject(context, { config: workflow({ components: DECLARATION }), requirements: ["r.md#2"] });
  await writeFile(path.join(root, `docs/plans/${INITIATIVE}/slice.md`), "# Work\n\n## Contract\n1. Shared values.\n\n## Changes\n- change `packages/shared/index.mjs`: `shared` (§1)\n");
  await update(root, [{ op: "propose_design", slug: INITIATIVE, operations: [{ op: "accept_design", slug: INITIATIVE, frozenTests: ["packages/shared/test/shared.test.mjs"], review: "none", component: "shared" }] }]);
  await update(root, [{ op: "accept_proposal", slug: INITIATIVE, reviewRequired: [] }]);
  await update(root, [{ op: "set_status", slug: INITIATIVE, status: "in-progress" }]);
  const asked = await verify(root);
  assert.equal(asked.status, "approval_needed");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow", note: null });
  assert.equal((await verify(root, { approvalGate: asked.gateId })).status, "passed");
  return root;
}

test("a dependents' gate and a slice's gate never answer each other", async (context) => {
  const root = await finishedScope(context);
  const asked = await verify(root, { dependents: true });
  assert.equal(asked.status, "approval_needed");
  assert.deepEqual(asked.commands, [
    { command: command("billing"), folder: "packages/billing", components: ["root/billing"] },
    { command: command("root", 0), folder: "", components: ["root/web"] }
  ]);
  // A changed slice command opens a slice gate, which cannot answer the dependents' gate, nor the other way round.
  await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: DECLARATION.replace(command("shared"), `${command("shared")} again`) }));
  const sliceGate = await verify(root);
  assert.equal(sliceGate.status, "approval_needed");
  await refusal(verify(root, { approvalGate: asked.gateId }), "approval_mismatch");
  await refusal(verify(root, { dependents: true, approvalGate: sliceGate.gateId }), "approval_mismatch");
  assert.equal((await verify(root, { dependents: true })).gateId, asked.gateId, "the unanswered dependents' gate is reused");
});

test("the dependents' question names each command and its project-relative folder, and allowing it allows exactly those pairs", async (context) => {
  const root = await finishedScope(context);
  const asked = await verify(root, { dependents: true });
  const gate = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((item) => item.id === asked.gateId);
  assert.equal(gate.slice, INITIATIVE);
  for (const item of asked.commands) assert.ok(gate.question.includes(item.command), gate.question);
  assert.ok(gate.question.includes("in the folder packages/billing, for root/billing"), gate.question);
  assert.ok(gate.question.includes("in the project root, for root/web"), gate.question);
  assert.equal(gate.question.replaceAll(process.execPath, "").includes(root), false, "no absolute path of the project");

  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow", note: null });
  assert.equal((await verify(root, { dependents: true, approvalGate: asked.gateId })).status, "passed");
  assert.equal((await verify(root, { dependents: true })).status, "passed", "the allowed pairs need no new gate");

  // A new folder for the same command is a new pair, so it is asked about alone.
  await writeFile(path.join(root, ".prism/workflow.md"), workflow({ components: DECLARATION.replace("- web: apps/web\n", `- web: apps/web\n  - Test command: ${command("root", 2)}\n`) }));
  const again = await verify(root, { dependents: true });
  assert.equal(again.status, "approval_needed");
  assert.deepEqual(again.commands, [{ command: command("root", 2), folder: "apps/web", components: ["root/web"] }]);
});
