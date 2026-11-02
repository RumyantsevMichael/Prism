import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backgroundIndexingEnabled, resetBackgroundPreparation, startBackgroundPreparation } from "../../dist/server/repository-intelligence/background-preparation.mjs";

async function project(t, workflow) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-background-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (workflow !== undefined) {
    await mkdir(path.join(root, ".prism"));
    await writeFile(path.join(root, ".prism", "workflow.md"), workflow);
  }
  return root;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test("background preparation starts once per project and returns before the build finishes", async t => {
  resetBackgroundPreparation();
  const root = await project(t);
  const calls = [];
  const prepare = root => { calls.push(root); return new Promise(() => {}); };
  const options = { prepare, available: async () => true };
  const run = startBackgroundPreparation(root, options);
  await settle();
  assert.deepEqual(calls, [root]);
  assert.equal(startBackgroundPreparation(root, options), run, "a second start joins the first");
  await settle();
  assert.deepEqual(calls, [root]);
});

test("a project can turn background indexing off in its workflow config", async t => {
  resetBackgroundPreparation();
  const off = await project(t, "## Repository intelligence\n- CodeNib command: n/a\n- Background indexing: off\n");
  const on = await project(t, "## Repository intelligence\n- CodeNib command: n/a\n");
  assert.equal(await backgroundIndexingEnabled(off), false);
  assert.equal(await backgroundIndexingEnabled(on), true);
  assert.equal(await backgroundIndexingEnabled(await project(t)), true);
  const calls = [];
  const options = { prepare: async root => { calls.push(root); }, available: async () => true };
  await startBackgroundPreparation(off, options);
  await startBackgroundPreparation(on, options);
  assert.deepEqual(calls, [on]);
});

test("a platform without a runtime starts nothing, and a failure before the build is recorded and never thrown", async t => {
  resetBackgroundPreparation();
  const unavailable = await project(t), failing = await project(t);
  const calls = [], recorded = [];
  await startBackgroundPreparation(unavailable, { prepare: async root => { calls.push(root); }, available: async () => false });
  assert.deepEqual(calls, []);
  const error = Object.assign(new Error("The snapshot could not be read."), { code: "invalid_path" });
  await startBackgroundPreparation(failing, { prepare: async () => { throw error; }, available: async () => true, record: async (root, value) => { recorded.push([root, value]); } });
  assert.deepEqual(recorded, [[failing, error]]);
  await startBackgroundPreparation(await project(t), { prepare: async () => { throw error; }, available: async () => true, record: async () => { throw new Error("Recording failed."); } });
});
