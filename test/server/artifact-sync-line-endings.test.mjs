import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, exists, git, isolateGit, ok, server, syncedWorkspace, version, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// A Prism write that changes only an artifact's line endings is a change like any other, while a clone that an earlier Prism checked out with CR LF line endings is migrated once when a server opens it.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { syncRecordStoreNow: syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");

const LF = "# Foo\n\nOne.\nTwo.\nThree.\n";
const CRLF = LF.replaceAll("\n", "\r\n");
const FILE = "docs/plans/foo/slice.md";
const STORED = "artifacts/plans/foo/slice.md";
// The remote's bytes exactly, which the fixture's remoteFile trims.
const remoteBytes = (remote, file) => execFileSync("git", ["-C", remote, "cat-file", "blob", `main:${file}`]);

test("an update_artifact write that changes only line endings reaches the remote, and both machines then read one version", async (context) => {
  const place = await syncedWorkspace(context);
  const onA = await server(context, place.a, await checkout(place.a, "api"));
  const onB = await server(context, place.b, await checkout(place.b, "web"));
  const first = await writeArtifact(onA, FILE, LF);
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  assert.equal((await syncRecordStore(place.storeB)).state, "ok");
  const written = await writeArtifact(onA, FILE, CRLF, { expectedVersion: first.version });
  assert.equal(written.version, version(CRLF));
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  assert.deepEqual(remoteBytes(place.remote, STORED), Buffer.from(CRLF), "the line-ending change is committed and pushed");
  assert.equal((await syncRecordStore(place.storeB)).state, "ok");
  assert.deepEqual(await readFile(path.join(place.storeB, STORED)), Buffer.from(CRLF));
  for (const prism of [onA, onB]) assert.equal(ok(await prism.call("get_artifact", { path: FILE })).version, version(CRLF));
});

test("a server that opens a clone an earlier Prism checked out with CR LF line endings migrates it before any write, and a later CR LF write is pushed", async (context) => {
  const place = await syncedWorkspace(context);
  const onA = await server(context, place.a, await checkout(place.a, "api"));
  await writeArtifact(onA, FILE, LF);
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  // Store b takes the artifact by hand, as an earlier Prism did, through Git's line-ending conversion.
  git(place.storeB, "pull", "-q", "origin", "main");
  await writeFile(path.join(place.storeB, STORED), CRLF);
  const onB = await server(context, place.b, await checkout(place.b, "web"));
  const read = ok(await onB.call("get_artifact", { path: FILE }));
  assert.equal(read.version, version(LF), "the converted copy reads as the branch's version");
  assert.deepEqual(await readFile(path.join(place.storeB, STORED)), Buffer.from(LF));
  assert.equal(await exists(path.join(place.storeB, ".prism-sync", "raw-files.json")), true);
  await writeArtifact(onB, FILE, CRLF, { expectedVersion: read.version });
  assert.equal((await syncRecordStore(place.storeB)).state, "ok");
  assert.deepEqual(remoteBytes(place.remote, STORED), Buffer.from(CRLF), "the later write's line endings reach the remote");
});
