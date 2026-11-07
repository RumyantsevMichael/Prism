import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, exists, git, isolateGit, ok, refused, server, syncedWorkspace, text, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Edge cases of the store artifact tools beyond the design's acceptance tests: links in the store, lock names, nested kinds, the roadmap's scope, layout collisions, byte order marks, special files, the lock that store sync shares, large store files, and copies that two scopes hold.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

test("a symbolic link inside the store's artifacts folder is never followed for a read or a write", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  const outside = path.join(place.parent, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.md"), "# Secret\n");
  await symlink(outside, path.join(place.store, "artifacts", "requirements", "linked"));
  refused(await prism.call("get_artifact", { path: "docs/requirements/linked/secret.md" }), "invalid_path");
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/linked/new.md", content: "# New\n", expectedVersion: null }] }), "invalid_path");
  assert.deepEqual(await readdir(outside), ["secret.md"]);
  await symlink(path.join(outside, "secret.md"), path.join(place.store, "artifacts", "requirements", "file-link.md"));
  refused(await prism.call("get_artifact", { path: "docs/requirements/file-link.md" }), "invalid_path");
  const listed = ok(await prism.call("get_artifact", { path: "docs/requirements" }));
  assert.deepEqual(listed.artifacts.map((entry) => entry.path), ["docs/requirements/first.md"], "a listing skips links");
});

test("lock and temporary file names break the artifact name form, and a listing hides them", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/first.md.lock", content: "x\n", expectedVersion: null }] }), "artifact_name_invalid");
  await writeFile(path.join(place.store, "artifacts", "requirements", ".first.md.1.abc.tmp"), "partial");
  assert.deepEqual(ok(await prism.call("get_artifact", {})).artifacts.map((entry) => entry.path), ["docs/requirements/first.md"]);
});

test("a kind folder inside another kind's folder lists each file under the kind of its longest path, and the roadmap stays in the workspace scope", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { paths: ["- Requirements: specs", "- Plans: specs/plans"] });
  const prism = await server(context, place, api);
  await writeArtifact(prism, "specs/plans/reports/slice.md", "# Plan\n");
  await writeArtifact(prism, "specs/billing.md", "# Billing\n");
  // A file another checkout stored under requirements/plans would have the address of a plan here, so this checkout does not see it.
  await mkdir(path.join(place.store, "artifacts", "requirements", "plans"), { recursive: true });
  await writeFile(path.join(place.store, "artifacts", "requirements", "plans", "hidden.md"), "# Hidden\n");
  const listed = ok(await prism.call("get_artifact", { path: "specs" }));
  assert.deepEqual(listed.artifacts.map((entry) => [entry.path, entry.kind]), [["specs/billing.md", "requirements"], ["specs/plans/reports/slice.md", "plans"]]);
  refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/roadmap.md", content: "# Roadmap\n", expectedVersion: null, scope: "repository" }] }), "scope_invalid");
  await writeArtifact(prism, "docs/roadmap.md", "# Roadmap\n");
  assert.equal(await text(path.join(place.store, "artifacts", "roadmap.md")), "# Roadmap\n");
  refused(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: "docs/roadmap.md", expectedVersion: null, scope: "repository" }] }), "scope_invalid");
});

test("a removal leaves no empty folders behind", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const first = await writeArtifact(prism, "docs/plans/reports/deep/slice.md", "# Deep\n");
  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: "docs/plans/reports/deep/slice.md", expectedVersion: first.version }] }));
  assert.equal(await exists(path.join(place.store, "artifacts", "plans", "reports")), false);
});

test("an update whose write lands on a folder, below a stored file, or below another of its writes is refused before any file changes", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const slice = await writeArtifact(prism, "docs/plans/reports/slice.md", "# Reports\n");
  const attempts = [
    [{ op: "write", path: "docs/requirements/new.md", content: "# New\n", expectedVersion: null }, { op: "write", path: "docs/plans/reports", content: "# Folder\n", expectedVersion: null }],
    [{ op: "write", path: "docs/plans/a", content: "# A\n", expectedVersion: null }, { op: "write", path: "docs/plans/a/b.md", content: "# B\n", expectedVersion: null }],
    [{ op: "write", path: "docs/plans/a/b.md", content: "# B\n", expectedVersion: null }, { op: "write", path: "docs/plans/a", content: "# A\n", expectedVersion: null }],
    [{ op: "write", path: "docs/requirements/new.md", content: "# New\n", expectedVersion: null }, { op: "write", path: "docs/plans/reports/slice.md/notes.md", content: "# Notes\n", expectedVersion: null }]
  ];
  for (const operations of attempts) {
    refused(await prism.call("update_artifact", { operations }), "invalid_path");
    assert.equal(await exists(path.join(place.store, "artifacts", "requirements")), false, "the earlier write did not land");
    assert.equal(await exists(path.join(place.store, "artifacts", "plans", "a")), false, "neither write landed");
    assert.equal(await text(path.join(place.store, "artifacts", "plans", "reports", "slice.md")), "# Reports\n");
  }
  assert.deepEqual(ok(await prism.call("get_artifact", {})).artifacts.map((entry) => [entry.path, entry.version]), [["docs/plans/reports/slice.md", slice.version]]);
});

test("a stored byte order mark is part of the artifact's text, so pages join to the file and an edit keeps it", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Marked\nLine.\n")]);
  await writeFile(path.join(place.store, "artifacts", "requirements", "marked.md"), bytes);
  const read = ok(await prism.call("get_artifact", { path: "docs/requirements/marked.md" }));
  assert.equal(read.content, "﻿# Marked\nLine.\n");
  assert.equal(read.bytes, bytes.length);
  const pages = [];
  for (let offset = 1; offset !== null;) {
    const page = ok(await prism.call("get_artifact", { path: "docs/requirements/marked.md", offset, limit: 1 }));
    pages.push(page.content);
    offset = page.nextOffset;
  }
  assert.deepEqual(Buffer.from(pages.join(""), "utf8"), bytes);
  const edited = ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: "docs/requirements/marked.md", expectedVersion: read.version, edits: [{ oldText: "Line.", newText: "Edited." }] }] })).artifacts[0];
  const stored = await readFile(path.join(place.store, "artifacts", "requirements", "marked.md"));
  assert.deepEqual(stored, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Marked\nEdited.\n")]));
  assert.equal(edited.version, version(stored));
});

test("a pipe at an artifact location is refused at once, and later updates are not held behind it", { skip: process.platform === "win32" }, async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  await writeArtifact(prism, "docs/plans/a/slice.md", "# A\n");
  execFileSync("mkfifo", [path.join(place.store, "artifacts", "plans", "a", "pipe.md")]);
  const prompt = async (call) => {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the call did not answer within 5 seconds")), 5000); });
    try { return await Promise.race([call, late]); } finally { clearTimeout(timer); }
  };
  refused(await prompt(prism.call("get_artifact", { path: "docs/plans/a/pipe.md" })), "invalid_path");
  refused(await prompt(prism.call("update_artifact", { operations: [{ op: "write", path: "docs/plans/a/pipe.md", content: "# Pipe\n", expectedVersion: null }] })), "invalid_path");
  assert.deepEqual(ok(await prompt(prism.call("get_artifact", { path: "docs/plans/a" }))).artifacts.map((entry) => entry.path), ["docs/plans/a/slice.md"], "a listing skips the pipe");
  await prompt(writeArtifact(prism, "docs/plans/a/next.md", "# Next\n"));
  assert.equal(await text(path.join(place.store, "artifacts", "plans", "a", "next.md")), "# Next\n");
});

test("a store sync waits for an artifact update's lock, so it never lands between the update's version check and its write", async (context) => {
  const { cancelRecordSyncs, configureRecordSync, syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");
  const { seenScopes, withArtifactStoreLock } = await import("../../dist/server/workflow/record-store.mjs");
  const { updateArtifact } = await import("../../dist/server/workflow/store-artifacts.mjs");
  configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15, applyLockMs: 100 });
  context.after(() => { cancelRecordSyncs(); configureRecordSync({ debounceMs: 5000, pullIntervalMs: 30000, applyLockMs: 2000 }); });
  const place = await syncedWorkspace(context);
  const api = await checkout(place.a, "api");
  const file = "docs/requirements/first.md";
  const first = (await updateArtifact({ projectRoot: api, operations: [{ op: "write", path: file, content: "# Base\n", expectedVersion: null }] })).artifacts[0];
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  // Another machine changes the artifact upstream.
  git(place.storeB, "pull", "-q");
  await writeFile(path.join(place.storeB, "artifacts", "requirements", "first.md"), "# Upstream\n");
  git(place.storeB, "add", "-A");
  git(place.storeB, "commit", "-q", "-m", "change the artifact upstream");
  git(place.storeB, "push", "-q");

  const head = git(place.storeA, "rev-parse", "HEAD");
  const stored = path.join(place.storeA, "artifacts", "requirements", "first.md");
  let during;
  // An update holds this lock from its version checks until its last write.
  await withArtifactStoreLock(await seenScopes(api), async () => {
    during = await syncRecordStore(place.storeA);
    assert.equal(await text(stored), "# Base\n", "the sync did not replace the artifact while an update held the lock");
  });
  assert.notEqual(during.state, "ok");
  assert.equal(git(place.storeA, "rev-parse", "HEAD"), head, "the branch stayed until the merge could be applied");
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  assert.equal(await text(stored), "# Upstream\n");
  await assert.rejects(updateArtifact({ projectRoot: api, operations: [{ op: "write", path: file, content: "# Mine\n", expectedVersion: first.version }] }),
    (error) => error.code === "version_conflict" && error.version === version("# Upstream\n"));
});

test("a store file above the bound a read takes stays listed with its version, blocks no other artifact, and can be removed", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const prism = await server(context, place, api);
  const first = await writeArtifact(prism, "docs/requirements/first.md", "# First\n");
  const big = Buffer.alloc(17 * 1024 * 1024, "a");
  await writeFile(path.join(place.store, "artifacts", "requirements", "big.md"), big);
  const expected = [["docs/requirements/big.md", version(big), big.length], ["docs/requirements/first.md", first.version, 8]];
  const entries = (listing) => listing.artifacts.map((entry) => [entry.path, entry.version, entry.bytes]);
  assert.deepEqual(entries(ok(await prism.call("get_artifact", {}))), expected);
  assert.deepEqual(entries(ok(await prism.call("get_artifact", { path: "docs/requirements" }))), expected);
  refused(await prism.call("get_artifact", { path: "docs/requirements/big.md" }), "artifact_too_large");
  refused(await prism.call("update_artifact", { operations: [{ op: "edit", path: "docs/requirements/big.md", expectedVersion: version(big), edits: [{ oldText: "a", newText: "b" }] }] }), "artifact_too_large");
  const taken = refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/requirements/big.md", content: "# Small\n", expectedVersion: null, scope: "repository" }] }), "artifact_exists");
  assert.equal(taken.data.scope.label, "workspace");
  refused(await prism.call("update_artifact", { operations: [{ op: "remove", path: "docs/requirements/big.md", expectedVersion: first.version }] }), "version_conflict");
  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: "docs/requirements/big.md", expectedVersion: version(big) }] }));
  assert.deepEqual(entries(ok(await prism.call("get_artifact", {}))), [expected[1]]);
});

test("move_scope of a path that two seen scopes hold moves the one copy whose version is expectedVersion", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { components: ["- web: src/web"] });
  const prism = await server(context, place, api);
  const component = await writeArtifact(prism, "docs/plans/dup.md", "# Component copy\n", { scope: "component", component: "web" });
  await mkdir(path.join(place.store, "artifacts", "plans"), { recursive: true });
  await writeFile(path.join(place.store, "artifacts", "plans", "dup.md"), "# Workspace copy\n");
  const workspaceVersion = version("# Workspace copy\n");
  const moved = ok(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: "docs/plans/dup.md", expectedVersion: workspaceVersion, scope: "repository" }] })).artifacts[0];
  assert.deepEqual([moved.scope.label, moved.version], ["api", workspaceVersion]);
  assert.equal(await exists(path.join(place.store, "artifacts", "plans", "dup.md")), false);
  assert.equal(await text(path.join(place.store, "artifacts", "repositories", "api", "plans", "dup.md")), "# Workspace copy\n");
  assert.equal(await text(path.join(place.store, "artifacts", "repositories", "api", "components", "web", "plans", "dup.md")), "# Component copy\n");
  // With no copy, or both copies, at expectedVersion the refusal says how to resolve the pair rather than asking for a scope.
  await writeFile(path.join(place.store, "artifacts", "repositories", "api", "components", "web", "plans", "dup.md"), "# Workspace copy\n");
  for (const expectedVersion of [component.version, workspaceVersion]) {
    const error = refused(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: "docs/plans/dup.md", expectedVersion, scope: "workspace" }] }), "artifact_ambiguous");
    assert.deepEqual(error.data.scopes, ["api", "api/web"]);
    assert.match(error.message, /remove/);
    assert.doesNotMatch(error.message, /pass scope/);
  }
  assert.equal(await exists(path.join(place.store, "artifacts", "plans", "dup.md")), false, "a refused move changes nothing");
});
