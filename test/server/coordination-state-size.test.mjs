import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeCoordinationState, readCoordinationState, recordPersonAction, updateCoordinationState } from "../../dist/server/workflow/state.mjs";

// Every coordination state writer fits the state to the 1 MiB limit that the structural merge applies, so an accepted state can always merge.
// The oldest history entries and then the oldest closed gates give way first, and a write is refused only when nothing droppable is left.
const LIMIT = 1024 * 1024;
const stateFile = (fixture) => path.join(fixture.projectRoot, ".prism/initiatives", fixture.initiative, "state.json");
const entry = (id, at) => ({ id: id.padEnd(32, "0"), action: "initiative.continuation", target: "initiative:demo", before: "auto", after: "stepwise", at, by: { name: "Ada", email: "ada@example.invalid", checkout: "demo/main on a" }, via: "review-app" });

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-state-size-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { projectRoot: root, initiative: "demo" };
}

// A state whose file is exactly `size` bytes, written through the normal writer.
async function stateOfSize(target, size) {
  const created = await updateCoordinationState({ ...target, expectedRevision: null, changes: { evidence: ["x"] } });
  const padding = size - Buffer.byteLength(await readFile(stateFile(target), "utf8"));
  return updateCoordinationState({ ...target, expectedRevision: created.revision, changes: { evidence: ["x".repeat(1 + padding)] } });
}

test("a coordination state write over 1 MiB with nothing to drop is refused and leaves the state unchanged", async (context) => {
  const target = await fixture(context);
  const created = await updateCoordinationState({ ...target, expectedRevision: null, changes: { evidence: ["small"] } });
  const before = await readFile(stateFile(target), "utf8");
  await assert.rejects(
    updateCoordinationState({ ...target, expectedRevision: created.revision, changes: { evidence: ["x".repeat(LIMIT)] } }),
    (caught) => caught.code === "artifact_too_large"
  );
  assert.equal(await readFile(stateFile(target), "utf8"), before);
});

test("a state of exactly 1 MiB is written, and an accepted state near the limit merges with a change from another machine", async (context) => {
  const target = await fixture(context);
  const written = await stateOfSize(target, LIMIT);
  assert.equal(written.valid, true);
  assert.equal(Buffer.byteLength(await readFile(stateFile(target), "utf8")), LIMIT);
  const other = await fixture(context);
  const based = await stateOfSize(other, LIMIT - 200);
  const base = await readFile(stateFile(other), "utf8");
  await updateCoordinationState({ ...other, expectedRevision: based.revision, changes: { settings: { continuation: "stepwise" } } });
  const upstream = await readFile(stateFile(other), "utf8");
  const result = mergeCoordinationState({ path: "initiatives/demo/state.json", base, local: base, upstream });
  assert.equal(result.conflict, undefined, result.conflict);
  assert.equal(result.contents, upstream);
});

test("a person's action that would grow the state past 1 MiB is refused when no older entry can give way", async (context) => {
  const target = await fixture(context);
  await stateOfSize(target, LIMIT - 10);
  const before = await readFile(stateFile(target), "utf8");
  await assert.rejects(
    recordPersonAction({ ...target, prepare: () => ({ entry: entry("a1", "2026-11-07T00:00:00.000Z"), setting: { name: "continuation", value: "stepwise" } }) }),
    (caught) => caught.code === "artifact_too_large"
  );
  assert.equal(await readFile(stateFile(target), "utf8"), before);
  assert.equal((await readCoordinationState(target)).valid, true);
});

test("a person's action that would grow the state past 1 MiB drops the oldest history entry instead of being refused", async (context) => {
  const target = await fixture(context);
  await updateCoordinationState({ ...target, expectedRevision: null, changes: { evidence: ["x"] } });
  const first = entry("a1", "2026-11-07T00:00:00.000Z");
  await recordPersonAction({ ...target, prepare: () => ({ entry: first, setting: { name: "continuation", value: "stepwise" } }) });
  const current = await readCoordinationState(target);
  const padding = LIMIT - 10 - Buffer.byteLength(await readFile(stateFile(target), "utf8"));
  await updateCoordinationState({ ...target, expectedRevision: current.revision, changes: { evidence: [`x${"x".repeat(padding)}`] } });
  const second = entry("a2", "2026-11-07T00:01:00.000Z");
  const applied = await recordPersonAction({ ...target, prepare: () => ({ entry: second, setting: { name: "continuation", value: "auto" } }) });
  assert.deepEqual(applied.state.history.map((item) => item.id), [second.id]);
  assert.deepEqual(applied.state.personSettings.continuation, { at: second.at, entry: second.id });
  assert.ok(Buffer.byteLength(await readFile(stateFile(target), "utf8")) <= LIMIT);
});
