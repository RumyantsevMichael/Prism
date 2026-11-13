import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adrFile, checkout, git, isolateGit, notes, ok, requirementFile, server, syncedWorkspace, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// What a person and an agent read about a store after a smoke test on a real machine: the move report names only references a reader should update,
// a refused call is no warning, the log says when a sync shared records and why one did not, and a file that moved in Approved or Accepted reads as accepted in its moved bytes.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { log } = await import("../../dist/server/log.mjs");
const { cancelRecordSyncs, configureRecordSync, syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
test.after(() => cancelRecordSyncs());

async function logFolder(context) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "prism-store-log-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}
const logLines = async (folder) => (await readFile(path.join(folder, "prism.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("the move report leaves out the workflow configuration, whose configured folders stay the artifacts' addresses, and still names other files that name a moved folder", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { paths: ["- Requirements: docs/requirements", "- Plans: docs/plans"], files: {
    "docs/requirements/billing.md": requirementFile("Billing", "Approved", "2026-10-01"),
    "AGENTS.md": "# Agents\n\nRead docs/requirements before changing code.\n"
  } });
  const prism = await server(context, place, api);
  const report = notes(await prism.call("get_artifact", {}));
  assert.match(report, /docs\/requirements\/billing\.md -> /, "the move is reported");
  assert.match(report, /AGENTS\.md:3\b/, "a file that tells readers to open the moved folder is named");
  assert.doesNotMatch(report, /\.prism\/workflow\.md/, "the configuration's own Paths lines are no reference to update");
});

test("a refused call logs its code as information without a stack, not as a failed request", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const folder = await logFolder(context);
  const prism = await server(context, place, api, { env: { PRISM_LOG_LEVEL: "info", PRISM_LOG_DIR: folder } });
  const refused = await prism.call("update_roadmap", { operations: [{ op: "add", initiative: "reports", band: "now", requirements: ["docs/requirements/reports.md"] }] });
  assert.ok(refused.error || refused.result?.isError, "the call is refused");
  await prism.close();
  const lines = await logLines(folder);
  const refusal = lines.find((line) => line.event === "request_refused");
  assert.ok(refusal, JSON.stringify(lines));
  assert.equal(refusal.tool, "update_roadmap");
  assert.match(refusal.code, /^[a-z]+(_[a-z0-9]+)*$/);
  assert.equal(refusal.level, "info");
  assert.equal(refusal.stack, undefined, "a refusal carries no stack");
  assert.equal(lines.some((line) => line.event === "request_failed"), false, "a refusal is no failure");
});

test("the log names a sync that shared records, a failure once until its reason changes, and the sync that ends the failures", async (context) => {
  const place = await syncedWorkspace(context);
  const api = await checkout(place.a, "api");
  const prism = await server(context, place.a, api);
  await writeArtifact(prism, "docs/plans/foo/slice.md", "# Foo\n");
  await prism.close();
  const folder = await logFolder(context);
  log.configure({ name: "test", directory: folder, level: 20 });
  configureRecordSync({ log });
  context.after(() => { configureRecordSync({ log: null }); log.configure({ name: "test", directory: null }); });

  await writeFile(path.join(place.storeA, "artifacts", "plans", "foo", "slice.md"), "# Foo\n\nChanged.\n");
  assert.equal((await syncRecordStoreNow(place.storeA)).state, "ok");
  assert.equal((await syncRecordStoreNow(place.storeA)).state, "ok", "a sync with nothing to share");
  await log.flush();
  const synced = (await logLines(folder)).filter((line) => line.event === "store_synced");
  assert.equal(synced.length, 1, "only the sync that shared a change is logged");
  assert.equal(synced[0].store, place.storeA);
  assert.notEqual(synced[0].from, synced[0].to);

  // The remote goes away, so each sync fails the same way until it is back.
  const away = `${place.remote}.away`;
  await rename(place.remote, away);
  context.after(() => rename(away, place.remote).catch(() => {}));
  await writeFile(path.join(place.storeA, "artifacts", "plans", "foo", "slice.md"), "# Foo\n\nChanged again.\n");
  assert.notEqual((await syncRecordStoreNow(place.storeA)).state, "ok");
  assert.notEqual((await syncRecordStoreNow(place.storeA)).state, "ok");
  await log.flush();
  const failures = (await logLines(folder)).filter((line) => line.event === "store_sync_failed");
  assert.equal(failures.length, 1, "a failure that repeats is logged once");
  assert.equal(failures[0].level, "warn");
  assert.ok(failures[0].state && failures[0].message, JSON.stringify(failures[0]));

  await rename(away, place.remote);
  assert.equal((await syncRecordStoreNow(place.storeA)).state, "ok");
  await log.flush();
  const after = (await logLines(folder)).filter((line) => line.event === "store_synced");
  assert.equal(after.length, 2, "the sync that pushes again is logged");
});

const PATHS = ["- Requirements: docs/requirements", "- ADRs: docs/adrs", "- Plans: docs/plans"];
const statusFile = (store, location) => path.join(store, "artifact-status", location, "status.json");
const recordAt = async (store, location) => JSON.parse(await readFile(statusFile(store, location), "utf8"));

test("a file that moves in Approved or Accepted keeps its moved bytes as its accepted version, and one that moves in Draft or Proposed has none", async (context) => {
  const place = await workspace(context);
  const files = {
    "docs/requirements/billing.md": requirementFile("Billing", "Approved", "2026-10-01"),
    "docs/requirements/refunds.md": requirementFile("Refunds"),
    "docs/adrs/ledger.md": adrFile("Ledger", "Accepted"),
    "docs/adrs/queue.md": adrFile("Queue")
  };
  const api = await checkout(place, "api", { paths: PATHS, files });
  const prism = await server(context, place, api);
  assert.match(notes(await prism.call("get_artifact", {})), /docs\/requirements\/billing\.md -> /, "the files moved");
  // The move itself records the accepted version, before any read of the artifact.
  for (const [file, accepted] of [["docs/requirements/billing.md", true], ["docs/requirements/refunds.md", false], ["docs/adrs/ledger.md", true], ["docs/adrs/queue.md", false]]) {
    const location = `repositories/api/${file.replace("docs/", "")}`;
    const record = await recordAt(place.store, location);
    assert.equal(record.acceptedVersion, accepted ? version(files[file]) : null, file);
    assert.deepEqual(record.history.map((entry) => entry.event), accepted ? ["moved"] : [], file);
    const read = ok(await prism.call("get_artifact", { path: file }));
    assert.equal(read.location, location);
    assert.equal(read.changedSinceAccepted, !accepted, file);
  }
  const accepted = ok(await prism.call("get_artifact", { path: "docs/requirements/billing.md", accepted: true }));
  assert.equal(accepted.content, files["docs/requirements/billing.md"]);
});

// A record as a move wrote it before moves kept an accepted version: the written status alone.
const earlierMoveRecord = (status) => `${JSON.stringify({ status, acceptedVersion: null, approval: null, pending: [], closed: [], history: [] })}\n`;

test("a file that moved in Approved before moves kept an accepted version takes its moved bytes as one on its next read, though it changed since", async (context) => {
  const place = await syncedWorkspace(context);
  const moved = requirementFile("Billing", "Approved", "2026-10-01");
  const api = await checkout(place.a, "api", { paths: PATHS, files: { "docs/requirements/billing.md": moved, "docs/requirements/refunds.md": requirementFile("Refunds") } });
  let prism = await server(context, place.a, api);
  ok(await prism.call("get_artifact", { path: "docs/requirements/billing.md" }));
  await prism.close();
  assert.equal((await syncRecordStoreNow(place.storeA)).state, "ok");

  // The store as an earlier move left it, and an edit made since, both shared.
  const location = "repositories/api/requirements/billing.md";
  await writeFile(statusFile(place.storeA, location), earlierMoveRecord("Approved"));
  await rm(path.join(place.storeA, "artifact-accepted"), { recursive: true, force: true });
  const edited = moved.replace("Something is missing.", "Something is still missing.");
  await writeFile(path.join(place.storeA, "artifacts", location), edited);
  assert.equal((await syncRecordStoreNow(place.storeA)).state, "ok");
  assert.equal(git(place.storeA, "status", "--porcelain").trim(), "", "the earlier state is committed");

  prism = await server(context, place.a, api);
  const read = ok(await prism.call("get_artifact", { path: "docs/requirements/billing.md" }));
  assert.equal(read.version, version(edited));
  assert.equal(read.acceptedVersion, version(moved), "the bytes it moved in with are the accepted ones");
  assert.equal(read.changedSinceAccepted, true, "the later edit shows as a change since then");
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/requirements/billing.md", accepted: true })).content, moved);
  const record = await recordAt(place.storeA, location);
  assert.deepEqual(record.history.map((entry) => entry.event), ["moved"], "the record says how it was accepted, once");
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/requirements/billing.md" })).acceptedVersion, version(moved));
  assert.equal((await recordAt(place.storeA, location)).history.length, 1, "a later read records nothing more");
  const draft = ok(await prism.call("get_artifact", { path: "docs/requirements/refunds.md" }));
  assert.equal(draft.acceptedVersion, null, "a Draft file stays without one");
});

test("in a store Prism runs no Git in, a file that moved in Approved earlier takes its current bytes as its accepted version on its next read", async (context) => {
  const place = await workspace(context);
  const moved = adrFile("Ledger", "Accepted");
  const api = await checkout(place, "api", { paths: PATHS, files: { "docs/adrs/ledger.md": moved } });
  let prism = await server(context, place, api);
  ok(await prism.call("get_artifact", { path: "docs/adrs/ledger.md" }));
  await prism.close();
  const location = "repositories/api/adrs/ledger.md";
  await writeFile(statusFile(place.store, location), earlierMoveRecord("Accepted"));
  await rm(path.join(place.store, "artifact-accepted"), { recursive: true, force: true });

  prism = await server(context, place, api);
  const read = ok(await prism.call("get_artifact", { path: "docs/adrs/ledger.md" }));
  assert.equal(read.acceptedVersion, version(moved));
  assert.equal(read.changedSinceAccepted, false);
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/adrs/ledger.md", accepted: true })).content, moved);
});
