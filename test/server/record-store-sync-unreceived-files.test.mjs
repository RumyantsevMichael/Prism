import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkout, isolateGit, ok, remoteFile, server, syncedWorkspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// A sync commits the removal of a shared file only when the disk once held it as the branch does.
// A shared file that the disk never received, as when an older Prism moved the branch past files its version does not write, is never pushed as a removal:
// the sync writes it back from the branch, and its status names it.
const environment = await isolateGit();
const { cancelRecordSyncs, configureRecordSync, readSyncStatus, syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const rec = (value) => `${JSON.stringify(value)}\n`;
const ACCEPTED = `artifact-accepted/${"a".repeat(64)}`;
const STATUS = "artifact-status/requirements/billing.md/status.json";
const IDENTITY = "artifact-identity/requirements/billing.md";
const SHARED = { [ACCEPTED]: "accepted bytes\n", [STATUS]: rec({ status: "Accepted" }), [IDENTITY]: rec({ id: "1".repeat(32) }) };
const remoteFiles = (remote) => git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n").filter(Boolean).sort();

async function put(root, files) {
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

// A bare remote, the clone of another machine that pushed a roadmap and the shared files, and this machine's clone, synced once so it holds both on disk.
async function stores(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-unreceived-files-")));
  context.after(() => rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  const remote = path.join(parent, "remote.git");
  git(parent, ["clone", "-q", remote, "other"]);
  const other = path.join(parent, "other");
  git(other, ["checkout", "-q", "-b", "main"]);
  await put(other, { "roadmap.json": rec({ initiatives: [] }) });
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "roadmap"]);
  git(other, ["push", "-q", "origin", "main"]);
  git(parent, ["clone", "-q", remote, "mine"]);
  const mine = path.join(parent, "mine");
  return { remote, other, mine };
}

test("files that an older Prism moved the branch past without writing them are written back, not pushed as removals", async (context) => {
  const { remote, other, mine } = await stores(context);
  await put(other, SHARED);
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "status records"]);
  git(other, ["push", "-q", "origin", "main"]);
  // An older Prism's sync moves the branch and index to the upstream commit and writes only the paths that its version shares, so these files never reach the disk.
  git(mine, ["fetch", "-q", "origin"]);
  git(mine, ["update-ref", "HEAD", "origin/main"]);
  git(mine, ["read-tree", "HEAD"]);

  const status = await syncRecordStoreNow(mine);
  assert.equal(status.state, "ok", status.message);
  assert.deepEqual(remoteFiles(remote), [...Object.keys(SHARED), "roadmap.json"].sort(), "the remote keeps every shared file");
  for (const [file, contents] of Object.entries(SHARED)) assert.equal(await readFile(path.join(mine, ...file.split("/")), "utf8"), contents, `${file} is back on disk`);
  assert.deepEqual(status.restored, Object.keys(SHARED).sort());
  assert.match(status.message, /the disk never received/);
  assert.deepEqual((await readSyncStatus(mine)).restored, Object.keys(SHARED).sort());

  const again = await syncRecordStoreNow(mine);
  assert.equal(again.state, "ok");
  assert.equal(again.restored, undefined, "a later sync has nothing to write back");
});

test("a file removed on disk after this Prism's last sync still syncs as a removal", async (context) => {
  const { remote, other, mine } = await stores(context);
  await put(other, SHARED);
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "status records"]);
  git(other, ["push", "-q", "origin", "main"]);
  assert.equal((await syncRecordStoreNow(mine)).state, "ok");
  // The store's own messages ask a person to remove files from the store by hand, as when a store holds more files than it may, and the next sync commits those removals.
  await rm(path.join(mine, ...ACCEPTED.split("/")));

  const status = await syncRecordStoreNow(mine);
  assert.equal(status.state, "ok", status.message);
  assert.deepEqual(remoteFiles(remote), [IDENTITY, STATUS, "roadmap.json"].sort());
  assert.equal(status.restored, undefined);
});

test("a clone that no sync of this Prism has recorded keeps every file it lacks, as a clone made by an older Prism does", async (context) => {
  const { remote, other, mine } = await stores(context);
  await put(other, SHARED);
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "status records"]);
  git(other, ["push", "-q", "origin", "main"]);
  git(mine, ["pull", "-q", "origin", "main"]);
  for (const folder of ["artifact-accepted", "artifact-status", "artifact-identity"]) await rm(path.join(mine, folder), { recursive: true, force: true });

  const status = await syncRecordStoreNow(mine);
  assert.equal(status.state, "ok", status.message);
  assert.deepEqual(remoteFiles(remote), [...Object.keys(SHARED), "roadmap.json"].sort());
  assert.equal(git(remote, ["log", "-1", "--format=%s", "main"]), "status records", "no commit removed them");
  for (const [file, contents] of Object.entries(SHARED)) assert.equal(await readFile(path.join(mine, ...file.split("/")), "utf8"), contents);
  assert.deepEqual(status.restored, Object.keys(SHARED).sort());
});

test("a removal that Prism made still reaches the remote", async (context) => {
  const place = await syncedWorkspace(context);
  const a = { ...place.a, sync: "off" };
  const prism = await server(context, a, await checkout(a, "api"));
  const written = await writeArtifact(prism, "docs/plans/foo/slice.md", "# Foo\n\nLine one.\n");
  assert.equal((await syncRecordStoreNow(place.storeA)).state, "ok");
  assert.ok(remoteFile(place.remote, "artifacts/plans/foo/slice.md"), "the artifact was pushed");
  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: "docs/plans/foo/slice.md", expectedVersion: written.version }] }));

  const status = await syncRecordStoreNow(place.storeA);
  assert.equal(status.state, "ok", status.message);
  assert.equal(remoteFile(place.remote, "artifacts/plans/foo/slice.md"), null, "the removal reached the remote");
  assert.equal(remoteFile(place.remote, "artifact-identity/plans/foo/slice.md"), null, "with its identity");
  assert.equal(status.restored, undefined);
});
