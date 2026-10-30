import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkpointPause, readCoordinationState, updateCoordinationState } from "../../dist/server/workflow/state.mjs";

test("writes active recovery before state update and rejects stale revisions", async (context) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "prism-pause-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const initiative = "example";
  const recoveryPath = "docs/plans/example/active-slice/recovery.md";
  const created = await updateCoordinationState({ projectRoot, initiative, expectedRevision: null, changes: {
    activeOperations: [{ slice: "active-slice", activity: "design", workers: ["worker"], workspace: "/work" }].map(entry => ({ op: "start", entry }))
  } });
  await assert.rejects(checkpointPause({ projectRoot, initiative, expectedRevision: "0".repeat(64), activeSlice: "active-slice",
    recoveryContent: "Current recovery.", changes: { next: ["Continue"] } }), (error) => error.code === "revision_conflict");
  await assert.rejects(readFile(path.join(projectRoot, recoveryPath), "utf8"), { code: "ENOENT" });
  await assert.rejects(checkpointPause({ projectRoot, initiative, expectedRevision: created.revision, activeSlice: "active-slice",
    recoveryContent: "Incomplete recovery.\n", changes: { next: [""] } }), (error) => error.code === "invalid_state");
  await assert.rejects(readFile(path.join(projectRoot, recoveryPath), "utf8"), { code: "ENOENT" });
  const paused = await checkpointPause({ projectRoot, initiative, expectedRevision: created.revision, activeSlice: "active-slice",
    recoveryContent: "Current recovery.", changes: { next: ["Continue"] } });
  assert.deepEqual(paused.state.active, []);
  assert.ok(paused.state.evidence.includes("active-slice/recovery.md"));
  assert.equal(await readFile(path.join(projectRoot, recoveryPath), "utf8"), "Current recovery.\n");
  assert.equal((await readCoordinationState({ projectRoot, initiative })).revision, paused.revision);
});

test("preserves other active slices during a pause", async (context) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "prism-pause-peers-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const initiative = "example";
  const peer = { slice: "peer", activity: "review", workers: ["reviewer"], workspace: "/work/peer" };
  const created = await updateCoordinationState({ projectRoot, initiative, expectedRevision: null, changes: {
    activeOperations: [{ slice: "child", activity: "design", workers: ["worker"], workspace: "/work/child" }, peer].map(entry => ({ op: "start", entry }))
  } });
  await assert.rejects(checkpointPause({ projectRoot, initiative, expectedRevision: created.revision, activeSlice: "child",
    recoveryContent: "Current recovery.", changes: { active: [] } }),
  (error) => error.code === "invalid_pause");
  const paused = await checkpointPause({ projectRoot, initiative, expectedRevision: created.revision, activeSlice: "child",
    recoveryContent: "Current recovery.", changes: { next: ["Continue child"] } });
  assert.deepEqual(paused.state.active, [peer]);
});
