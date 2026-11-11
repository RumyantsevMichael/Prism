import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { refuseShipped } from "../../dist/server/workflow/shipped-history.mjs";
import { updateCoordinationState } from "../../dist/server/workflow/state.mjs";

// A roadmap record that exists but cannot be parsed leaves it unknown whether an initiative shipped, so a change is refused rather than let through.
async function project(context, roadmap) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-unreadable-roadmap-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans: docs/plans/\n- Roadmap: docs/roadmap.md\n");
  if (roadmap !== null) await writeFile(path.join(root, ".prism/roadmap.json"), roadmap);
  return root;
}

test("a change is refused with invalid_roadmap when the roadmap record cannot be parsed, and writes nothing", async (context) => {
  const root = await project(context, "{ \"schemaVersion\": 1, \"initiatives\": [");
  await assert.rejects(refuseShipped(root, "reports"), (error) => error.code === "invalid_roadmap" && error.initiative === "reports");
  const before = await readdir(path.join(root, ".prism"));
  await assert.rejects(updateCoordinationState({ projectRoot: root, initiative: "reports", expectedRevision: null, changes: { next: ["Design the reports slice."] } }), (error) => error.code === "invalid_roadmap");
  assert.deepEqual(await readdir(path.join(root, ".prism")), before, "the refused change writes no record");
});

test("a project without a roadmap record still accepts a change", async (context) => {
  const root = await project(context, null);
  await refuseShipped(root, "reports");
  const result = await updateCoordinationState({ projectRoot: root, initiative: "reports", expectedRevision: null, changes: { next: ["Design the reports slice."] } });
  assert.equal(result.created, true);
});
