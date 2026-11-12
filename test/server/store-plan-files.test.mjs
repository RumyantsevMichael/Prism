import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { checkout, exists, isolateGit, ok, server, text, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// With a record store, Prism writes the recovery note of a pause into the store, in the scope that holds its initiative's plans, and never into the checkout.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

test("a pause writes its recovery note in the scope that holds the initiative's plans, and a refused pause leaves the earlier note", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  ok(await createInitiative(prism, "reports"));
  await writeArtifact(prism, "docs/plans/reports/slice.md", "# Reports\n", { scope: "repository" });
  const started = ok(await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: null, changes: {
    activeOperations: [{ op: "start", entry: { slice: "download", activity: "design", workers: ["worker"], workspace: api } }]
  } }));
  const paused = ok(await prism.call("checkpoint_pause", { initiative: "reports", expectedRevision: started.revision, activeSlice: "download", recoveryContent: "Continue the download.", changes: { next: ["Continue"] } }));
  assert.equal(paused.recoveryPath, "docs/plans/reports/download/recovery.md");
  const note = path.join(place.store, "artifacts", "repositories", "api", "plans", "reports", "download", "recovery.md");
  assert.equal(await text(note), "Continue the download.\n");
  assert.equal(await exists(path.join(api, "docs", "plans")), false, "nothing was written under the checkout's plans folder");
  // The view was generated before any plan file chose a scope, so it moves to the plans folder's scope when it is generated again.
  assert.equal(await exists(path.join(place.store, "artifacts", "plans", "reports", "initiative.md")), true);
  const current = ok(await prism.call("get_initiative", { initiative: "reports" }));
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: current.revision, operations: [{ op: "regenerate_markdown" }] }));
  assert.equal((await readdir(path.join(place.store, "artifacts", "repositories", "api", "plans", "reports"))).includes("initiative.md"), true, "the initiative view follows the plans folder's scope");
  assert.equal(await exists(path.join(place.store, "artifacts", "plans", "reports")), false, "the view left the workspace scope, and its emptied folder with it");
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/plans/reports/download/recovery.md" })).content, "Continue the download.\n", "the note is a store artifact the tools read");

  const again = ok(await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: paused.revision, changes: {
    activeOperations: [{ op: "start", entry: { slice: "download", activity: "design", workers: ["worker"], workspace: api } }]
  } }));
  const refused = await prism.call("checkpoint_pause", { initiative: "reports", expectedRevision: again.revision, activeSlice: "download", recoveryContent: "A second note.", changes: { next: [""] } });
  assert.ok(refused.error, "an invalid state change refuses the pause");
  assert.equal(await text(note), "Continue the download.\n", "the refused pause restores the earlier note");
});
