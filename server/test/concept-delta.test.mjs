import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { getConceptDelta, updateConceptDelta, CONCEPT_DELTA_LIMITS } from "../concept-delta.mjs";
import { conservationStore } from "../conservation-store.mjs";
import { writeAtomically } from "../artifact-store.mjs";

const examples = JSON.parse(await readFile(new URL("./fixtures/concept-delta.json", import.meta.url), "utf8"));
const codeEntry = examples.concepts[0];
const execFileAsync = promisify(execFile);
async function fixture(t) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "prism-concepts-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  return { projectRoot, deltaPath: "docs/plans/demo/retry/concept-delta.json" };
}
const insert = (entry) => ({ op: "insert", entry });
async function create(input, concepts = examples.concepts) {
  return updateConceptDelta({ ...input, expectedRevision: null, scope: examples.scope, operations: concepts.map(insert) });
}
const file = (input) => path.join(input.projectRoot, input.deltaPath);

test("reads absent artifacts without creating directories", async (t) => {
  const input = await fixture(t);
  const result = await getConceptDelta(input);
  assert.equal(result.exists, false);
  assert.equal(result.revision, null);
  assert.equal(result.ready, false);
  assert.deepEqual(await readdir(input.projectRoot), []);
});
test("creates code and non-code transitions, including consolidation and splitting", async (t) => {
  const input = await fixture(t);
  const result = await create(input);
  assert.equal(result.ready, false);
  assert.deepEqual(result.counts, { KEEP: 1, MODIFY: 1, REPLACE: 2, DELETE: 1, ADD: 1 });
  const read = await getConceptDelta(input);
  assert.equal(read.concepts.length, 6);
  assert.deepEqual(read.concepts.map((item) => item.id), [...read.concepts.map((item) => item.id)].sort());
  assert.equal(JSON.parse(await readFile(file(input))).schemaVersion, 2);
});
test("updates fields, replaces arrays, and removes entries in ordered batches", async (t) => {
  const input = await fixture(t);
  const initial = await create(input);
  const result = await updateConceptDelta({ ...input, expectedRevision: initial.revision, operations: [
    { op: "update", id: codeEntry.id, set: { reason: "A revised reason." } },
    { op: "update", id: "direct-answer", set: { after: [{ path: "instructions/answers.md", selector: "Replacement rule" }] } },
    { op: "remove", id: "legacy-retry" }
  ] });
  assert.deepEqual(result.changedIds, ["direct-answer", "legacy-retry", "retry-policy"]);
  const read = await getConceptDelta(input);
  const updated = read.concepts.find((entry) => entry.id === codeEntry.id);
  assert.equal(updated.reason, "A revised reason.");
  assert.deepEqual(updated.before, codeEntry.before);
  assert.equal(read.concepts.find((entry) => entry.id === "direct-answer").after.length, 1);
  assert.equal(read.concepts.some((entry) => entry.id === "legacy-retry"), false);
});
test("draft addition evidence controls readiness and malformed evidence fails", async (t) => {
  const input = await fixture(t);
  const addition = structuredClone(examples.concepts.at(-1));
  delete addition.reuseEvidence;
  const draft = await create(input, [addition]);
  assert.equal(draft.valid, true);
  assert.equal(draft.ready, false);
  assert.equal(draft.diagnostics[0].code, "addition_evidence_missing");
  await assert.rejects(updateConceptDelta({ ...input, expectedRevision: draft.revision, operations: [
    { op: "update", id: addition.id, set: { reuseEvidence: { method: "Search", candidates: [] } } }
  ] }), (error) => error.code === "validation_failed" && error.errors.some((value) => value.includes("justification")));
  const ready = await updateConceptDelta({ ...input, expectedRevision: draft.revision, operations: [
    { op: "update", id: addition.id, set: { reuseEvidence: { method: "Search. Semantic retrieval unavailable.", candidates: [], justification: "No candidates matched in the searched configuration definitions." } } }
  ] });
  assert.equal(ready.ready, false);
  assert.ok(ready.diagnostics.some(item => item.code === "baseline_missing"));
});
test("empty deltas are ready and no-op updates preserve bytes and revision", async (t) => {
  const input = await fixture(t);
  const baseline = await conservationStore.capture(input.projectRoot, input.deltaPath);
  const created = await updateConceptDelta({ ...input, expectedRevision: null, baselineId: baseline.snapshotId, scope: examples.scope, operations: [] });
  assert.equal(created.ready, true);
  const result = await updateConceptDelta({ ...input, expectedRevision: created.revision, operations: [] });
  assert.equal(result.revision, created.revision);
  assert.deepEqual(result.changedIds, []);
  // A differently formatted valid artifact must also survive a semantic no-op unchanged.
  const contents = JSON.stringify(JSON.parse(await readFile(file(input))));
  await writeFile(file(input), contents);
  const loaded = await getConceptDelta(input);
  const noOp = await updateConceptDelta({ ...input, expectedRevision: loaded.revision, operations: [], scope: examples.scope });
  assert.equal(noOp.revision, loaded.revision);
  assert.equal(await readFile(file(input), "utf8"), contents);
});
test("bad operation batches leave all artifact bytes unchanged", async (t) => {
  const input = await fixture(t);
  const initial = await create(input);
  const before = await readFile(file(input), "utf8");
  for (const operation of [
    { op: "update", id: "absent", set: { reason: "Changed" } },
    { op: "insert", entry: codeEntry },
    { op: "remove", id: "absent" },
    { op: "update", id: codeEntry.id, set: { id: "changed" } },
    { op: "update", id: codeEntry.id, set: { action: "OTHER" } },
    { op: "update", id: codeEntry.id, set: { before: [] } },
    { op: "update", id: codeEntry.id, set: { after: [...codeEntry.after, ...codeEntry.after] } },
    { op: "insert", entry: { ...codeEntry, id: "conflicting-owner" } }
  ]) {
    await assert.rejects(updateConceptDelta({ ...input, expectedRevision: initial.revision, operations: [
      { op: "update", id: codeEntry.id, set: { reason: "Must not persist" } }, operation
    ] }), (error) => error.code === "validation_failed");
    assert.equal(await readFile(file(input), "utf8"), before);
  }
});
test("revision conflicts protect writes and paginated reads", async (t) => {
  const input = await fixture(t);
  const initial = await create(input);
  const first = await getConceptDelta({ ...input, expectedRevision: initial.revision, limit: 2 });
  assert.equal(first.nextOffset, 2);
  const second = await getConceptDelta({ ...input, expectedRevision: initial.revision, offset: first.nextOffset, limit: 2 });
  assert.equal(second.nextOffset, 4);
  const filtered = await getConceptDelta({ ...input, ids: [codeEntry.id] });
  assert.equal(filtered.selectedCount, 1);
  const changed = await updateConceptDelta({ ...input, expectedRevision: initial.revision, operations: [{ op: "remove", id: codeEntry.id }] });
  for (const action of [
    () => getConceptDelta({ ...input, expectedRevision: initial.revision, offset: 4 }),
    () => updateConceptDelta({ ...input, expectedRevision: initial.revision, operations: [] }),
    () => updateConceptDelta({ ...input, expectedRevision: null, operations: [] })
  ]) await assert.rejects(action(), (error) => error.code === "revision_conflict" && error.currentRevision === changed.revision);
});
test("serializes concurrent writers within and across processes", async (t) => {
  for (const external of [false, true]) {
    const input = await fixture(t);
    const initial = await create(input);
    const update = (reason) => ({ ...input, expectedRevision: initial.revision, operations: [{ op: "update", id: codeEntry.id, set: { reason } }] });
    let results;
    if (!external) results = await Promise.allSettled([updateConceptDelta(update("Left")), updateConceptDelta(update("Right"))]);
    else {
      const script = `import {updateConceptDelta} from ${JSON.stringify(new URL("../concept-delta.mjs", import.meta.url).href)}; try { await updateConceptDelta(JSON.parse(process.argv[1])); console.log("success"); } catch (error) { console.log(error.code); }`;
      const output = await Promise.all(["Left", "Right"].map((reason) => execFileAsync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(update(reason))])));
      assert.deepEqual(output.map((item) => item.stdout.trim()).sort(), ["revision_conflict", "success"]);
      continue;
    }
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "revision_conflict");
  }
});
test("rejects escaping paths, symbolic links, and non-file artifacts", async (t) => {
  const input = await fixture(t);
  for (const deltaPath of ["../concept-delta.json", "/tmp/concept-delta.json", "C:\\tmp\\concept-delta.json", "docs/other.json", "concept-delta.json"]) {
    await assert.rejects(getConceptDelta({ ...input, deltaPath }), (error) => error.code === "invalid_path");
  }
  const outside = await mkdtemp(path.join(os.tmpdir(), "prism-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(input.projectRoot, "escape"));
  await assert.rejects(create({ ...input, deltaPath: "escape/new/concept-delta.json" }), (error) => error.code === "invalid_path");
  await mkdir(path.dirname(file(input)), { recursive: true });
  await writeFile(path.join(outside, "data.json"), "{}");
  await symlink(path.join(outside, "data.json"), file(input));
  await assert.rejects(getConceptDelta(input), (error) => error.code === "invalid_path");
  await rm(file(input));
  await mkdir(file(input));
  await assert.rejects(getConceptDelta(input), (error) => error.code === "invalid_path");
});
test("rejects invalid stored schemas and preserves invalid files", async (t) => {
  const input = await fixture(t);
  await mkdir(path.dirname(file(input)), { recursive: true });
  for (const contents of ["not JSON", JSON.stringify({ ...examples, schemaVersion: 99 }), JSON.stringify({ ...examples, unknown: true })]) {
    await writeFile(file(input), contents);
    const loaded = await getConceptDelta(input);
    assert.equal(loaded.valid, false);
    assert.equal(loaded.ready, false);
    await assert.rejects(updateConceptDelta({ ...input, expectedRevision: loaded.revision, operations: [] }), (error) => error.code === "invalid_delta");
    assert.equal(await readFile(file(input), "utf8"), contents);
  }
});
test("enforces page, batch, artifact, and creation limits", async (t) => {
  const input = await fixture(t);
  for (const limit of [0, 101, 1.5]) await assert.rejects(getConceptDelta({ ...input, limit }), (error) => error.code === "validation_failed");
  await assert.rejects(updateConceptDelta({ ...input, expectedRevision: null, operations: [] }), (error) => error.code === "validation_failed");
  await assert.rejects(create(input, Array.from({ length: 101 }, () => codeEntry)), (error) => error.code === "validation_failed");
  await assert.rejects(create(input, [{ ...codeEntry, reason: "x".repeat(CONCEPT_DELTA_LIMITS.bytes) }]), (error) => error.code === "artifact_too_large");
  await writeFile(file(input), "x".repeat(CONCEPT_DELTA_LIMITS.bytes + 1));
  await assert.rejects(getConceptDelta(input), (error) => error.code === "artifact_too_large");
});
test("atomic writer preserves the previous file on rename failure and removes temporary files", async (t) => {
  const input = await fixture(t);
  await create(input);
  const before = await readFile(file(input), "utf8");
  await assert.rejects(writeAtomically(file(input), "replacement", { renameFile: async () => { throw Object.assign(new Error("Write failed"), { code: "EIO" }); } }), (error) => error.code === "EIO");
  assert.equal(await readFile(file(input), "utf8"), before);
  assert.deepEqual(await readdir(path.dirname(file(input))), ["concept-delta.json"]);
});

test("lock timeouts return a stable code without changing the artifact", async (t) => {
  const input = await fixture(t);
  const initial = await create(input);
  const contents = await readFile(file(input), "utf8");
  await writeFile(`${file(input)}.lock`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  await assert.rejects(updateConceptDelta({ ...input, expectedRevision: initial.revision, operations: [] }), (error) => error.code === "lock_timeout");
  assert.equal(await readFile(file(input), "utf8"), contents);
});

test("checks every operation's action rules and canonicalizes reference order", async (t) => {
  const input = await fixture(t);
  const initial = await create(input);
  for (const entry of [
    { ...codeEntry, id: "bad-add", action: "ADD" },
    { ...codeEntry, id: "bad-delete", action: "DELETE" },
    { ...codeEntry, id: "bad-replace", action: "REPLACE", after: [] },
    { ...codeEntry, id: "bad-keep", action: "KEEP", after: [{ path: "other.ts" }] }
  ]) await assert.rejects(updateConceptDelta({ ...input, expectedRevision: initial.revision, operations: [insert(entry)] }), (error) => error.code === "validation_failed");
  const reordered = await updateConceptDelta({ ...input, expectedRevision: initial.revision, operations: [
    { op: "update", id: "direct-answer", set: { before: [...examples.concepts[2].before].reverse() } }
  ] });
  assert.equal(reordered.revision, initial.revision);
  await assert.rejects(updateConceptDelta({ ...input, expectedRevision: initial.revision, scope: ["docs", "./docs"], operations: [] }), (error) => error.code === "validation_failed");
  await assert.rejects(updateConceptDelta({ ...input, expectedRevision: initial.revision, operations: [
    { op: "update", id: "retry-policy", set: { before: [{ path: "../secret", selector: "escape" }] } }
  ] }), (error) => error.code === "validation_failed");
});
