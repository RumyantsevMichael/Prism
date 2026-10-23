import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendRecord, ensureRecords, forgetMigrations, isManagedRecordFile, keyOfPath, listInitiatives, listRecordEntries,
  listSliceRecords, readRecord, recordPath, removeInitiativeRecords, sameRecord, sliceDocumentFolder, writeRecord
} from "../../dist/server/workflow/record-store.mjs";

async function project(context, config = "## Paths\n- Plans (scratch): docs/plans/\n- Roadmap: docs/roadmap.md\n") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-records-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), config);
  forgetMigrations();
  return root;
}

async function put(root, relative, contents) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), contents);
}

const exists = (target) => access(target).then(() => true, () => false);

test("addresses every record by identity under .prism", () => {
  assert.equal(recordPath({ kind: "roadmap" }), ".prism/roadmap.json");
  assert.equal(recordPath({ kind: "initiative", initiative: "reports" }), ".prism/initiatives/reports/initiative.json");
  assert.equal(recordPath({ kind: "state", initiative: "reports" }), ".prism/initiatives/reports/state.json");
  assert.equal(recordPath({ kind: "review", initiative: "reports", slice: "reports" }), ".prism/initiatives/reports/slices/reports/review.json");
  assert.equal(recordPath({ kind: "change-map", initiative: "reports", slice: "download" }), ".prism/initiatives/reports/slices/download/change-map.json");
  assert.equal(recordPath({ kind: "runs", initiative: "reports", slice: "download" }), ".prism/initiatives/reports/slices/download/runs");
  assert.throws(() => recordPath({ kind: "state", initiative: "../outside" }), { code: "invalid_path" });
  assert.throws(() => recordPath({ kind: "review", initiative: "reports" }), { code: "invalid_path" });
  assert.equal(isManagedRecordFile(".prism/initiatives/reports/state.json"), true);
  assert.equal(isManagedRecordFile(".prism/.gitattributes"), true);
  assert.equal(isManagedRecordFile(".prism/workflow.md"), false);
});

test("reads create no files and the first write adds the generated-file attributes", async (context) => {
  const root = await project(context);
  const missing = await readRecord(root, { kind: "state", initiative: "reports" });
  assert.equal(missing.bytes, null);
  assert.deepEqual(await listInitiatives(root), []);
  assert.deepEqual((await readdir(path.join(root, ".prism"))).sort(), ["workflow.md"]);
  await writeRecord(root, { kind: "state", initiative: "reports" }, "{}\n");
  assert.deepEqual(await listInitiatives(root), ["reports"]);
  assert.match(await readFile(path.join(root, ".prism/.gitattributes"), "utf8"), /^\/initiatives\/\*\* linguist-generated=true gitlab-generated$/m);
  assert.match(await readFile(path.join(root, ".prism/.gitignore"), "utf8"), /^\*\.lock$/m);
});

test("moves every legacy record at once with its bytes, and keeps a legacy file that conflicts", async (context) => {
  const root = await project(context);
  const initiative = JSON.stringify({ schemaVersion: 1, id: "reports", slices: { export: { title: "Export", status: "split", parent: null, requirements: [], dependencies: [] } }, history: [] });
  await put(root, "docs/roadmap.json", "roadmap bytes");
  await put(root, "docs/plans/reports/initiative.json", initiative);
  await put(root, "docs/plans/reports/state.json", "state bytes");
  await put(root, "docs/plans/reports/review.json", "root review");
  await put(root, "docs/plans/reports/download/concept-delta.json", "legacy map");
  await put(root, "docs/plans/reports/download/slice.md", "# Download\n");
  await put(root, "docs/plans/other/state.json", "other state");
  await put(root, ".prism/initiatives/other/state.json", "different state");
  const report = await ensureRecords(root);
  assert.equal(report.moved.length, 5);
  assert.deepEqual(report.conflicts.map((move) => move.from), ["docs/plans/other/state.json"]);
  assert.equal(await readFile(path.join(root, ".prism/roadmap.json"), "utf8"), "roadmap bytes");
  assert.equal(await readFile(path.join(root, ".prism/initiatives/reports/initiative.json"), "utf8"), initiative);
  // The initiative folder is the root slice's folder, so its review belongs to the slug the record names as root.
  assert.equal(await readFile(path.join(root, ".prism/initiatives/reports/slices/export/review.json"), "utf8"), "root review");
  assert.equal(await readFile(path.join(root, ".prism/initiatives/reports/slices/download/change-map.json"), "utf8"), "legacy map");
  assert.equal(await exists(path.join(root, "docs/plans/reports/state.json")), false);
  assert.equal(await exists(path.join(root, "docs/plans/reports/download/slice.md")), true);
  assert.equal(await readFile(path.join(root, "docs/plans/other/state.json"), "utf8"), "other state");
  assert.equal(await readFile(path.join(root, ".prism/initiatives/other/state.json"), "utf8"), "different state");
  assert.deepEqual(await listSliceRecords(root, "reports"), ["download", "export"]);
});

test("removes a legacy copy that matches the record already in .prism", async (context) => {
  const root = await project(context);
  await put(root, "docs/plans/reports/state.json", "same");
  await put(root, ".prism/initiatives/reports/state.json", "same");
  const report = await ensureRecords(root);
  assert.equal(report.conflicts.length, 0);
  assert.equal(await exists(path.join(root, "docs/plans/reports/state.json")), false);
});

test("maps stored legacy paths to the record they now name", async (context) => {
  const root = await project(context);
  await put(root, ".prism/initiatives/reports/initiative.json", JSON.stringify({ slices: { export: { parent: null } } }));
  assert.deepEqual(await keyOfPath(root, "docs/plans/reports/download/concept-delta.json"), { kind: "change-map", initiative: "reports", slice: "download" });
  assert.deepEqual(await keyOfPath(root, "docs/plans/reports/review.json"), { kind: "review", initiative: "reports", slice: "export" });
  assert.deepEqual(await keyOfPath(root, "docs/roadmap.json"), { kind: "roadmap" });
  assert.equal(await keyOfPath(root, "docs/plans/reports/download/slice.md"), null);
  assert.equal(await sameRecord(root, "docs/plans/reports/download/change-map.json", ".prism/initiatives/reports/slices/download/change-map.json"), true);
  assert.equal(await sameRecord(root, "docs/plans/reports/download/change-map.json", ".prism/initiatives/reports/slices/export/change-map.json"), false);
  assert.equal(await sliceDocumentFolder(root, "reports", "export"), "docs/plans/reports");
  assert.equal(await sliceDocumentFolder(root, "reports", "download"), "docs/plans/reports/download");
});

test("appends immutable entries and never replaces one", async (context) => {
  const root = await project(context);
  const key = { kind: "runs", initiative: "reports", slice: "download" };
  await appendRecord(root, key, "run-2", { order: 2 });
  await appendRecord(root, key, "run-1", { order: 1 });
  await assert.rejects(appendRecord(root, key, "run-1", { order: 3 }), { code: "entry_exists" });
  await assert.rejects(appendRecord(root, key, "../escape", {}), { code: "validation_failed" });
  const entries = await listRecordEntries(root, key);
  assert.deepEqual(entries.map((item) => [item.id, item.entry.order]), [["run-1", 1], ["run-2", 2]]);
});

test("removes an initiative's coordination records but keeps its run entries", async (context) => {
  const root = await project(context);
  const runs = { kind: "runs", initiative: "reports", slice: "download" };
  await writeRecord(root, { kind: "initiative", initiative: "reports" }, "{}\n");
  await writeRecord(root, { kind: "state", initiative: "reports" }, "{}\n");
  await writeRecord(root, { kind: "review", initiative: "reports", slice: "download" }, "{}\n");
  await writeRecord(root, { kind: "change-map", initiative: "reports", slice: "export" }, "{}\n");
  await appendRecord(root, runs, "run-1", { order: 1 });
  await writeRecord(root, { kind: "state", initiative: "search" }, "{}\n");
  await removeInitiativeRecords(root, "reports");
  assert.deepEqual(await listInitiatives(root), ["search"]);
  assert.deepEqual((await listRecordEntries(root, runs)).map((item) => item.id), ["run-1"]);
  assert.equal(await exists(path.join(root, ".prism/initiatives/reports/slices/download/review.json")), false);
  assert.equal(await exists(path.join(root, ".prism/initiatives/reports/slices/export")), false);
  assert.equal(await exists(path.join(root, ".prism/workflow.md")), true);
});
