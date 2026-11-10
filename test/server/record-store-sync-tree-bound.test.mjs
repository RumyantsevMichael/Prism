import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeServers, isolateGit } from "./fixtures/workspace-artifacts.mjs";

// A store's tree holds a bounded number of files, a sync lists no more of a tree than that bound, and what a store knows it shares with other machines outlasts a remote branch it never merged.
const environment = await isolateGit();
const { cancelRecordSyncs, configureRecordSync, markManagedStore, syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
const { STORE_TREE_FILES_MAX } = await import("../../dist/server/workflow/record-store.mjs");
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, args, input) => execFileSync("git", ["-C", cwd, ...args], { input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 << 28 }).toString().trim();
const SLICE = "artifacts/plans/foo/slice.md";
const takeOffCommand = (message) => message.match(/run (git (?:reset --soft [0-9a-f]{40,64}|update-ref -d HEAD)) in the store/)?.[1] ?? null;

async function put(root, files) {
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

function push(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  git(root, ["push", "-q", "origin", "main"]);
}

// Two machines' stores cloned from one bare remote that holds a README and one artifact.
async function stores(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-tree-")));
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  const remote = path.join(parent, "remote.git");
  git(parent, ["clone", "-q", remote, "a"]);
  const a = path.join(parent, "a");
  git(a, ["checkout", "-q", "-b", "main"]);
  await put(a, { "README.md": "Prism store\n", [SLICE]: "# Foo\n" });
  push(a, "init");
  git(parent, ["clone", "-q", remote, "b"]);
  const b = path.join(parent, "b");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  return { parent, remote, a, b };
}

// Run a test with a smaller bound on a store tree's files, and the real one again after it.
async function withTreeBound(max, run) {
  configureRecordSync({ treeFilesMax: max });
  try { return await run(); } finally { configureRecordSync({ treeFilesMax: STORE_TREE_FILES_MAX }); }
}

// A commit on a's branch that adds a folder of count empty files, built from Git's objects alone, without a work tree.
function wideCommit(a, count) {
  const empty = git(a, ["hash-object", "-w", "--stdin"], "");
  const lines = Array.from({ length: count }, (_, n) => `100644 blob ${empty}\t${String(n).padStart(8, "0")}.md`);
  const folder = git(a, ["mktree"], `${lines.join("\n")}\n`);
  const kept = git(a, ["ls-tree", "HEAD"]).split("\n").filter((line) => !line.endsWith("\tjunk"));
  const root = git(a, ["mktree"], `${[...kept, `040000 tree ${folder}\tjunk`].join("\n")}\n`);
  return git(a, ["commit-tree", root, "-p", "HEAD", "-m", "wide"]);
}

test(`a store's tree takes at most ${STORE_TREE_FILES_MAX} files: an upstream of exactly that many syncs, and one of one more is refused with the count and the bound`, { timeout: 240000 }, async (context) => {
  assert.equal(STORE_TREE_FILES_MAX, 250000);
  const { a, b } = await stores(context);
  const at = wideCommit(a, STORE_TREE_FILES_MAX - 2);
  git(a, ["push", "-q", "origin", `${at}:refs/heads/main`]);
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  assert.equal(git(b, ["rev-parse", "HEAD"]), at);
  git(a, ["reset", "-q", "--hard", at]);
  const past = wideCommit(a, STORE_TREE_FILES_MAX - 1);
  git(a, ["push", "-q", "-f", "origin", `${past}:refs/heads/main`]);
  await put(b, { [SLICE]: "# Foo\n\nChanged on b.\n" });
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "merge_failed", JSON.stringify(status));
  assert.match(status.message, new RegExp(`^The upstream holds a tree of more than ${STORE_TREE_FILES_MAX} files, the most files that a store's tree may hold, .* Remove files from the remote's branch until it holds at most ${STORE_TREE_FILES_MAX}\\.$`), status.message);
  assert.equal(git(b, ["rev-parse", "HEAD~1"]), at, "the store keeps its branch, with this machine's change committed on it");
});

test("a sync commits no local change that takes the tree past its bound: this machine's added files past it, by path, stay on disk, out of every commit, and are withheld for that reason", { timeout: 240000 }, async (context) => {
  const { remote, b } = await stores(context);
  await withTreeBound(10, async () => {
    const added = Array.from({ length: 12 }, (_, n) => `artifacts/plans/foo/n${String(n).padStart(2, "0")}.md`);
    await put(b, Object.fromEntries(added.map((file) => [file, "# N\n"])));
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "ok", JSON.stringify(status));
    assert.deepEqual(status.withheld.map((entry) => entry.path), added.slice(8));
    assert.match(status.withheld[0].reason, /^the store's tree would then hold more than 10 files, the most files that a store's tree may hold/);
    assert.match(status.message, /Keep fewer files in the store, by removing files it no longer needs, and the next sync commits the files it withheld/, status.message);
    assert.equal(git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n").length, 10);
    for (const file of added) assert.ok((await readdir(path.join(b, "artifacts", "plans", "foo"))).includes(path.posix.basename(file)), `${file} stays on disk`);
  });
});

test("a commit made by hand that takes the branch past the bound on a store tree's files is refused before the merge with the command that takes it off, after which every other change syncs", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await withTreeBound(10, async () => {
    const before = git(b, ["rev-parse", "HEAD"]);
    await put(b, Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`artifacts/plans/foo/n${String(n).padStart(2, "0")}.md`, "# N\n"])));
    git(b, ["add", "-A"]);
    git(b, ["commit", "-q", "-m", "by hand"]);
    await put(b, { [SLICE]: "# Foo\n\nChanged on b.\n" });
    await put(a, { "README.md": "Prism store, edited on a\n" });
    push(a, "from a");
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "merge_failed", JSON.stringify(status));
    assert.match(status.message, /^The store's branch holds more than 10 files, the most files that a store's tree may hold, so it was not merged or pushed/, status.message);
    assert.equal(takeOffCommand(status.message), `git reset --soft ${before}`, status.message);
    git(b, ["reset", "-q", "--soft", before]);
    const next = await syncRecordStoreNow(b);
    assert.equal(next.state, "ok", JSON.stringify(next));
    assert.ok(next.withheld.length > 0, JSON.stringify(next));
    assert.equal(git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n").length, 10);
    assert.ok(git(remote, ["show", `main:${SLICE}`]).includes("Changed on b."));
    assert.equal(git(remote, ["show", "main:README.md"]), "Prism store, edited on a", "and the other machine's change stays");
  });
});

test("a shared commit of this machine's branch stays known when the remote's branch takes a tip that this machine never merges and is then deleted, so the command a refusal gives keeps it", { timeout: 240000 }, async (context) => {
  const { parent, remote, a, b } = await stores(context);
  await put(b, { "artifacts/plans/foo/b1.md": "b1\n" });
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  const shared = git(b, ["rev-parse", "HEAD"]);
  git(parent, ["clone", "-q", remote, "c"]);
  const c = path.join(parent, "c");
  assert.equal((await syncRecordStoreNow(c)).state, "ok");
  // The remote's branch takes a tip that holds a link, which this machine refuses and so never merges.
  git(a, ["pull", "-q", "--no-rebase", "origin", "main"]);
  await symlink("slice.md", path.join(a, "artifacts", "plans", "foo", "link.md"));
  push(a, "a link");
  assert.equal((await syncRecordStoreNow(b)).state, "merge_failed");
  git(remote, ["update-ref", "-d", "refs/heads/main"]);
  const folder = path.join(b, "artifact-comments", "plans", "foo", "slice.md");
  await mkdir(folder, { recursive: true });
  for (let n = 0; n < 1001; n++) await writeFile(path.join(folder, `2026-01-01T00-00-00-000Z-${n.toString(16).padStart(8, "0")}.json`), "{}\n");
  git(b, ["add", "-A"]);
  git(b, ["commit", "-q", "-m", "by hand"]);
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "merge_failed", JSON.stringify(status));
  assert.equal(takeOffCommand(status.message), `git reset --soft ${shared}`, status.message);
  git(b, ["reset", "-q", "--soft", shared]);
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  assert.equal((await syncRecordStoreNow(c)).state, "ok", "and the machine that shares that commit syncs");
});

test("a merge whose upstream files and this machine's added files would pass the bound keeps every upstream file and withholds this machine's added files past it by path, on disk and out of every commit", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await withTreeBound(10, async () => {
    await put(a, Object.fromEntries(Array.from({ length: 4 }, (_, n) => [`artifacts/plans/foo/a${n}.md`, "# A\n"])));
    push(a, "four on a");
    const mine = Array.from({ length: 6 }, (_, n) => `artifacts/plans/foo/b${n}.md`);
    await put(b, Object.fromEntries(mine.map((file) => [file, "# B\n"])));
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "ok", JSON.stringify(status));
    assert.deepEqual(status.withheld.map((entry) => entry.path), mine.slice(4));
    assert.match(status.withheld[0].reason, /^the store's tree would then hold more than 10 files/);
    assert.match(status.message, /Keep fewer files in the store/, status.message);
    const tree = git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
    assert.equal(tree.length, 10);
    for (let n = 0; n < 4; n++) assert.ok(tree.includes(`artifacts/plans/foo/a${n}.md`), "every upstream file stays");
    for (const file of mine) assert.equal((await readdir(path.join(b, "artifacts", "plans", "foo"))).includes(path.posix.basename(file)), true, `${file} stays on disk`);
    const again = await syncRecordStoreNow(b);
    assert.equal(again.state, "ok", JSON.stringify(again));
    assert.deepEqual(again.withheld.map((entry) => entry.path), mine.slice(4), "and stays withheld while the store holds no room for it");
  });
});

test("the first publish of a long-lived store pushes its whole history, however many objects it holds", { timeout: 240000 }, async (context) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-tree-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  const remote = path.join(parent, "remote.git");
  const b = path.join(parent, "b");
  await mkdir(b);
  git(b, ["init", "-q", "-b", "main"]);
  git(b, ["remote", "add", "origin", remote]);
  // Years of syncs, many more objects than four for each file that the lowered bound lets a tree hold.
  for (let n = 0; n < 30; n++) {
    await put(b, { "README.md": `Prism store ${n}\n`, [SLICE]: `# Foo ${n}\n` });
    git(b, ["add", "-A"]);
    git(b, ["commit", "-q", "-m", `sync ${n}`]);
  }
  markManagedStore(b);
  await withTreeBound(5, async () => {
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "ok", JSON.stringify(status));
    assert.equal(git(remote, ["rev-list", "--count", "main"]), "30");
  });
});
