import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, exists, git, isolateGit, ok, refused, server, syncedWorkspace, text, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Edge cases of the store artifact tools beyond the design's acceptance tests: links in the store, lock names, nested kinds, the roadmap's scope, layout collisions, byte order marks, special files, the lock that store sync shares, large store files, copies that two scopes hold, the person's own Git excludes, and file systems that ignore letter case.
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

test("store sync commits artifacts that the person's own Git ignore rules match, since only the store's ignore file decides what it tracks", async (context) => {
  const { cancelRecordSyncs, configureRecordSync, syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");
  const { updateArtifact } = await import("../../dist/server/workflow/store-artifacts.mjs");
  configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
  const excludes = path.join(environment, "personal-excludes");
  await writeFile(excludes, "*.log\nbuild/\n");
  await writeFile(process.env.GIT_CONFIG_GLOBAL, `[core]\n\texcludesFile = ${excludes.replaceAll("\\", "/")}\n`);
  context.after(async () => { cancelRecordSyncs(); configureRecordSync({ debounceMs: 5000, pullIntervalMs: 30000 }); await writeFile(process.env.GIT_CONFIG_GLOBAL, ""); });
  const place = await syncedWorkspace(context);
  await writeFile(path.join(place.storeA, ".git", "info", "exclude"), "*.bak\n");
  const api = await checkout(place.a, "api");
  const files = { "docs/plans/x/run.log": "# Run log\n", "docs/plans/x/build/notes.md": "# Build notes\n", "docs/plans/x/old.bak": "# Old\n" };
  await updateArtifact({ projectRoot: api, operations: Object.entries(files).map(([file, content]) => ({ op: "write", path: file, content, expectedVersion: null })) });
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  for (const [file, content] of Object.entries(files)) {
    assert.equal(git(place.remote, "show", `main:artifacts/${file.replace(/^docs\//, "")}`), content.trimEnd(), `${file} reached the remote`);
  }
  // The store's own ignore file still keeps its lock and temporary files out.
  await writeFile(path.join(place.storeA, "artifacts", "plans", "x", "slice.md.lock"), "");
  await syncRecordStore(place.storeA);
  assert.equal(git(place.storeA, "ls-files", "--", "artifacts/plans/x/slice.md.lock"), "");
});

test("store sync makes and removes folders under artifacts only while it holds the artifact lock", async (context) => {
  const { cancelRecordSyncs, configureRecordSync, syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");
  const { seenScopes, withArtifactStoreLock } = await import("../../dist/server/workflow/record-store.mjs");
  const { updateArtifact } = await import("../../dist/server/workflow/store-artifacts.mjs");
  configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15, applyLockMs: 1500 });
  context.after(() => { cancelRecordSyncs(); configureRecordSync({ debounceMs: 5000, pullIntervalMs: 30000, applyLockMs: 2000 }); });
  const place = await syncedWorkspace(context);
  const api = await checkout(place.a, "api");
  await updateArtifact({ projectRoot: api, operations: [{ op: "write", path: "docs/requirements/first.md", content: "# First\n", expectedVersion: null }] });
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  // Another machine adds artifacts in two new folders.
  git(place.storeB, "pull", "-q");
  for (const folder of ["fresh", "shared"]) {
    await mkdir(path.join(place.storeB, "artifacts", "plans", folder), { recursive: true });
    await writeFile(path.join(place.storeB, "artifacts", "plans", folder, "slice.md"), `# ${folder}\n`);
  }
  git(place.storeB, "add", "-A");
  git(place.storeB, "commit", "-q", "-m", "add plans upstream");
  git(place.storeB, "push", "-q");

  const plans = path.join(place.storeA, "artifacts", "plans");
  await withArtifactStoreLock(await seenScopes(api), async () => {
    // An update holding the lock has made a folder for its own write and not yet written into it.
    await mkdir(path.join(plans, "shared"), { recursive: true });
    let madeFresh = false;
    const syncing = syncRecordStore(place.storeA);
    let done = false;
    syncing.finally(() => { done = true; });
    while (!done) {
      if (await exists(path.join(plans, "fresh"))) madeFresh = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.notEqual((await syncing).state, "ok");
    assert.equal(madeFresh, false, "the sync made no folder while the update held the lock");
    assert.equal(await exists(path.join(plans, "shared")), true, "the sync removed no folder while the update held the lock");
  });
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  assert.equal(await text(path.join(plans, "fresh", "slice.md")), "# fresh\n");
  assert.equal(await text(path.join(plans, "shared", "slice.md")), "# shared\n");
});

test("store sync shares only artifacts and record files that the person's own excludes match, never their dotfiles or tool folders", async (context) => {
  const { cancelRecordSyncs, configureRecordSync, syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");
  const { updateArtifact } = await import("../../dist/server/workflow/store-artifacts.mjs");
  configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
  const excludes = path.join(environment, "personal-excludes");
  await writeFile(excludes, "*.log\nbuild/\n.env\n.idea/\n.DS_Store\n");
  await writeFile(process.env.GIT_CONFIG_GLOBAL, `[core]\n\texcludesFile = ${excludes.replaceAll("\\", "/")}\n`);
  context.after(async () => { cancelRecordSyncs(); configureRecordSync({ debounceMs: 5000, pullIntervalMs: 30000 }); await writeFile(process.env.GIT_CONFIG_GLOBAL, ""); });
  const place = await syncedWorkspace(context);
  const api = await checkout(place.a, "api");
  const files = { "docs/plans/x/run.log": "# Run log\n", "docs/plans/x/build/notes.md": "# Build notes\n" };
  await updateArtifact({ projectRoot: api, operations: Object.entries(files).map(([file, content]) => ({ op: "write", path: file, content, expectedVersion: null })) });
  // Files that an editor, a file manager, or the person left in the store, which only the person's excludes keep out of its history.
  const local = [".env", ".idea/workspace.xml", ".DS_Store", "artifacts/plans/x/.DS_Store"];
  for (const file of local) {
    await mkdir(path.dirname(path.join(place.storeA, file)), { recursive: true });
    await writeFile(path.join(place.storeA, file), file === ".env" ? "TOKEN=abc\n" : "local\n");
  }
  assert.equal((await syncRecordStore(place.storeA)).state, "ok");
  for (const [file, content] of Object.entries(files)) {
    assert.equal(git(place.remote, "show", `main:artifacts/${file.replace(/^docs\//, "")}`), content.trimEnd(), `${file} reached the remote`);
  }
  const pushed = git(place.remote, "ls-tree", "-r", "--name-only", "main").split("\n");
  assert.ok(pushed.some((file) => file.startsWith("repositories/")), "the repository's registration reached the remote");
  for (const file of local) assert.equal(pushed.includes(file), false, `${file} stays out of the store's history`);
});

test("on a file system that ignores letter case, a variant of a stored path in another letter case is no artifact and never opens the stored one", async (context) => {
  // This host's file system tells letter case apart, so the server runs with a preload that makes its file calls below the store's artifacts folder ignore letter case, while listings keep each stored name.
  const place = await workspace(context);
  const api = await checkout(place, "api");
  const marker = path.join(place.parent, "case-insensitive.loaded");
  const prism = await server(context, place, api, { env: {
    NODE_OPTIONS: `--import=${new URL("./fixtures/case-insensitive-store.mjs", import.meta.url).href}`,
    PRISM_TEST_CASE_INSENSITIVE: path.join(place.store, "artifacts"),
    PRISM_TEST_CASE_INSENSITIVE_MARKER: marker
  } });
  const stored = await writeArtifact(prism, "docs/plans/x/Plan.md", "# Plan\n");
  assert.ok(await exists(marker), "the server ignores letter case below the artifacts folder");
  const folder = path.join(place.store, "artifacts", "plans", "x");

  refused(await prism.call("get_artifact", { path: "docs/plans/x/plan.md" }), "artifact_not_found");
  refused(await prism.call("get_artifact", { path: "docs/plans/X/Plan.md" }), "artifact_not_found");
  const conflict = refused(await prism.call("update_artifact", { operations: [{ op: "write", path: "docs/plans/x/plan.md", content: "# Other\n", expectedVersion: null }] }), "artifact_name_conflict");
  assert.equal(conflict.data.path, "docs/plans/x/Plan.md");
  for (const operation of [
    { op: "write", path: "docs/plans/x/plan.md", content: "# Other\n", expectedVersion: stored.version },
    { op: "edit", path: "docs/plans/x/plan.md", expectedVersion: stored.version, edits: [{ oldText: "# Plan", newText: "# Other" }] },
    { op: "remove", path: "docs/plans/x/plan.md", expectedVersion: stored.version },
    { op: "move_scope", path: "docs/plans/x/plan.md", expectedVersion: stored.version, scope: "repository" }
  ]) {
    const error = refused(await prism.call("update_artifact", { operations: [operation] }), "version_conflict");
    assert.equal(error.data.version, null, `${operation.op} finds no artifact at the variant`);
  }
  assert.deepEqual(await readdir(folder), ["Plan.md"]);
  assert.equal(await text(path.join(folder, "Plan.md")), "# Plan\n");
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/plans/x/Plan.md" })).content, "# Plan\n");
  assert.equal(await exists(path.join(place.store, "artifacts", "repositories")), false, "no variant moved to another scope");
});
