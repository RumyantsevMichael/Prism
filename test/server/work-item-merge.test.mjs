import assert from "node:assert/strict";
import test from "node:test";
import { hasRecordMerge, recordMergeFor } from "../../dist/server/workflow/record-merge.mjs";
import { isStoreFile, parseRecordPath, recordPath, storeFileBound } from "../../dist/server/workflow/record-store.mjs";
import { emptyShapingRecord } from "../../dist/server/workflow/work-items.mjs";

// A work item's shaping record is a shared record of its own beside the entry's initiative records, which store sync merges entry by entry.

const PATH = "initiatives/sync/work-item.json";
const record = (fields = {}) => JSON.stringify({ ...emptyShapingRecord(), ...fields });
const input = (id, note) => ({ id, link: "https://example.invalid/brief", note, addedAt: "2026-11-20T00:00:00.000Z" });

test("a shaping record lives beside the entry's initiative records and is shared by a store", () => {
  assert.equal(recordPath({ kind: "work-item", initiative: "sync" }), ".prism/initiatives/sync/work-item.json");
  assert.deepEqual(parseRecordPath(".prism/initiatives/sync/work-item.json"), { kind: "work-item", initiative: "sync" });
  assert.equal(isStoreFile(PATH), true);
  assert.equal(storeFileBound(PATH), 1024 * 1024);
  assert.equal(hasRecordMerge(PATH), true);
});

test("two machines' entries merge by identifier, cited ADRs by path, and changedAt takes the later time", async () => {
  const merge = await recordMergeFor(PATH);
  const base = record({ inputs: [input("input-00000001", "Base.")], changedAt: "2026-11-20T00:00:00.000Z" });
  const local = record({ inputs: [input("input-00000001", "Base."), input("input-00000002", "Local.")], adrs: ["docs/ADRs/a.md"], changedAt: "2026-11-21T00:00:00.000Z" });
  const upstream = record({ inputs: [input("input-00000001", "Base.")], gaps: [{ id: "gap-00000003", note: "Offline.", addedAt: "2026-11-22T00:00:00.000Z" }], adrs: ["docs/ADRs/b.md"], changedAt: "2026-11-22T00:00:00.000Z" });
  const { contents, conflict } = merge({ path: PATH, base, local, upstream });
  assert.equal(conflict, undefined);
  const merged = JSON.parse(contents);
  assert.deepEqual(merged.inputs.map((entry) => entry.id), ["input-00000001", "input-00000002"]);
  assert.deepEqual(merged.gaps.map((entry) => entry.id), ["gap-00000003"]);
  assert.deepEqual([...merged.adrs].sort(), ["docs/ADRs/a.md", "docs/ADRs/b.md"]);
  assert.equal(merged.changedAt, "2026-11-22T00:00:00.000Z");
});

test("an entry or scalar that both machines changed differently conflicts", async () => {
  const merge = await recordMergeFor(PATH);
  const base = record({ inputs: [input("input-00000001", "Base.")] });
  const local = record({ inputs: [input("input-00000001", "Local.")] });
  const upstream = record({ inputs: [input("input-00000001", "Upstream.")] });
  assert.match(merge({ path: PATH, base, local, upstream }).conflict, /input-00000001/);
  const ready = (by) => record({ ready: { gate: "gate-0000000000000001", at: "2026-11-20T00:00:00.000Z", by } });
  assert.match(merge({ path: PATH, base: record(), local: ready("Ada"), upstream: ready("Bo") }).conflict, /ready/);
});
