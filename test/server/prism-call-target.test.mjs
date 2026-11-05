import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPrismCallTarget } from "../../dist/server/session/prism-call-target.mjs";

const TOOL = "mcp__plugin_prism_prism-review__update_review";
const STATE = { schemaVersion: 1, active: [{ slice: "core", activity: "implementation" }] };
const LEDGER = { schemaVersion: 1, waves: [{ id: "impl-1", mode: "implementation-review", lanes: [] }], findings: [] };
const INITIATIVE = { schemaVersion: 1, slices: { core: { parent: null }, part: { parent: "core" } } };

async function project(context, files) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-call-target-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), JSON.stringify(value));
  }
  return root;
}

const read = (root, toolInput) => readPrismCallTarget({ toolName: TOOL, toolInput: { projectRoot: root, ...toolInput }, projectRoot: root });

test("reads the open wave and active slices from records under .prism and names the root slice for an initiative-only call", async (context) => {
  const root = await project(context, {
    ".prism/initiatives/demo/initiative.json": INITIATIVE,
    ".prism/initiatives/demo/state.json": STATE,
    ".prism/initiatives/demo/slices/core/review.json": LEDGER
  });
  const named = await read(root, { initiative: "demo", slice: "core" });
  assert.deepEqual([named.slice, named.namesSlice, named.openWave, named.activeSlices, named.facts], ["core", true, "impl-1", ["core"], "exact"]);
  const initiativeOnly = await read(root, { initiative: "demo" });
  assert.deepEqual([initiativeOnly.slice, initiativeOnly.namesSlice, initiativeOnly.openWave], ["core", false, "impl-1"]);
});

test("reads records an older Prism kept under the plans path until a write moves them", async (context) => {
  const root = await project(context, {
    "docs/plans/demo/initiative.json": INITIATIVE,
    "docs/plans/demo/state.json": STATE,
    "docs/plans/demo/review.json": LEDGER
  });
  const target = await read(root, { initiative: "demo" });
  assert.deepEqual([target.slice, target.openWave, target.activeSlices, target.facts], ["core", "impl-1", ["core"], "exact"]);
});

test("reads records from the record store that the workflow config names", async (context) => {
  const store = await project(context, {
    "initiatives/demo/initiative.json": INITIATIVE,
    "initiatives/demo/state.json": STATE,
    "initiatives/demo/slices/core/review.json": LEDGER
  });
  const root = await project(context, {});
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), `# Workflow config\n\n## Workspace\n- Store: ${store}\n- Repository: project\n`);
  const target = await read(root, { initiative: "demo" });
  assert.deepEqual([target.slice, target.openWave, target.activeSlices, target.facts], ["core", "impl-1", ["core"], "exact"]);
});

test("names no target for a call without an initiative", async (context) => {
  const root = await project(context, {});
  assert.equal(await read(root, { slice: "core" }), null);
});
