import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { splitEvidence } from "./fixtures/split-evidence.mjs";

// A done slice cannot be reopened, so the completion gate's refusal of a stale run is checked on a slice that a passing run left in progress.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-stale-gate-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CODE_REMOTE;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { verifySlice } = await import("../../dist/server/workflow/verification.mjs");
const { answerUserGate } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";

async function initiativeUpdate(root, operations) {
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  return updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations });
}

test("set_status done refuses a slice whose project changed after its passing verification run", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-stale-gate-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Paths\n- Plans: docs/plans\n\n## Stack\n- Test command: ${process.execPath} check.mjs\n`);
  await writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
  await writeFile(path.join(root, "test", "acceptance.test.mjs"), "// frozen acceptance test\n");
  await writeFile(path.join(root, "source.mjs"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [
    { op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1", "req.md#R2"] },
    { op: "split", parent: INITIATIVE, children: [{ slug: "download", title: "Download reports", requirements: ["req.md#R1"] }, { slug: "audit", title: "Audit downloads", requirements: ["req.md#R2"] }], evidence: await splitEvidence(root, `docs/plans/${INITIATIVE}`, "download") }
  ] });
  // A slice whose design requires review stays in progress after its passing run.
  await initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "in-progress" }, { op: "accept_design", slug: "download", frozenTests: ["test/acceptance.test.mjs"], review: "required" }]);
  const asked = await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download" });
  assert.equal(asked.status, "approval_needed");
  await answerUserGate({ projectRoot: root, initiative: INITIATIVE, id: asked.gateId, choice: "allow", note: null });
  assert.equal((await verifySlice({ projectRoot: root, initiative: INITIATIVE, slice: "download", approvalGate: asked.gateId })).status, "passed");
  assert.equal((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices.download.status, "in-progress");
  await writeFile(path.join(root, "source.mjs"), "export const value = 2;\n");
  await assert.rejects(initiativeUpdate(root, [{ op: "set_status", slug: "download", status: "done" }]), (error) => {
    assert.equal(error.code, "gate_blocked");
    assert.match(error.message, /changed after the verification run/);
    return true;
  });
  assert.equal((await getInitiative({ projectRoot: root, initiative: INITIATIVE })).record.slices.download.status, "in-progress");
});
