import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { rewriteStatusLines, writtenStatus } from "../../dist/server/workflow/artifact-status.mjs";
import { checkout, eventually, isolateGit, ok, remoteFile, requirementFile, server, syncedWorkspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Status records of store artifacts: how status lines are read and rewritten, and that a record syncs with its artifact.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

test("the written status is the first Status line before the first level-two heading", () => {
  assert.equal(writtenStatus("# T\r\n\r\nStatus: Approved\r\nStatus: Draft\r\n"), "Approved");
  assert.equal(writtenStatus("# T\n\n## Part\n\nStatus: Approved\n"), null);
  assert.equal(writtenStatus("Status:   Superseded by [x](x.md)  \n"), "Superseded by [x](x.md)");
});

test("approving rewrites the status lines and keeps the file's line endings", () => {
  assert.equal(rewriteStatusLines("# T\r\n\r\nStatus: Draft\r\nApproved: n/a\r\n\r\n## A\r\nApproved: keep\r\n", "Approved", "2026-11-08"), "# T\r\n\r\nStatus: Approved\r\nApproved: 2026-11-08\r\n\r\n## A\r\nApproved: keep\r\n");
  assert.equal(rewriteStatusLines("# T\n\nStatus: Proposed\n", "Superseded", "2026-11-08"), "# T\n\nStatus: Superseded\n");
  assert.equal(rewriteStatusLines("# T\n\n## A\n", "Approved", "2026-11-08"), "# T\n\nStatus: Approved\nApproved: 2026-11-08\n\n## A\n");
  assert.equal(rewriteStatusLines("# T\n\nStatus: Draft", "Approved", "2026-11-08"), "# T\n\nStatus: Approved\nApproved: 2026-11-08");
});

test("a status record syncs beside its artifact, and moves and goes with it", async (context) => {
  const machines = await syncedWorkspace(context);
  const api = await checkout(machines.a, "api");
  const prism = await server(context, machines.a, api);
  const file = "docs/requirements/billing.md";
  const record = "artifact-status/requirements/billing.md/status.json";
  await writeArtifact(prism, file, requirementFile("Billing"));
  const gate = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: file, context: "Billing." }] })).artifacts[0].gate;
  await eventually(() => remoteFile(machines.remote, record)?.includes(gate), 30000, "the status record with its gate reaching the remote");
  assert.ok(remoteFile(machines.remote, "artifacts/requirements/billing.md"));

  const current = ok(await prism.call("get_artifact", { path: file }));
  ok(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: file, expectedVersion: current.version, scope: "repository" }] }));
  const moved = "artifact-status/repositories/api/requirements/billing.md/status.json";
  await eventually(() => remoteFile(machines.remote, moved)?.includes(gate) && remoteFile(machines.remote, record) === null, 30000, "the status record moving with its artifact");
  assert.equal(ok(await prism.call("get_artifact", { path: file })).status, "Draft");

  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: file, expectedVersion: current.version }] }));
  await eventually(() => remoteFile(machines.remote, moved) === null, 30000, "the status record going with its artifact");
});
