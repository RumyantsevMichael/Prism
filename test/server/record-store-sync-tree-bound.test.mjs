import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeServers, isolateGit, requirementFile } from "./fixtures/workspace-artifacts.mjs";

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

// What a sync stopped at the bound on a store tree's files leaves as it was: the branch, the checked commit, the index, and every file on disk outside Git's and the sync's own folders, with its bytes.
async function stateOf(root) {
  const disk = {};
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (relative === ".git" || relative === ".prism-sync") continue;
      if (entry.isDirectory()) await walk(full); else disk[relative] = await readFile(full, "utf8");
    }
  };
  await walk(root);
  const ref = (name) => { try { return git(root, ["rev-parse", "--verify", "--quiet", name]); } catch { return null; } };
  return { head: ref("HEAD"), checked: ref("refs/prism-checked/branch"), index: git(root, ["ls-files", "-s"]), disk };
}

// The message of a sync that stopped at the bound on a store tree's files, with the count of the tree it would push, the bound, and the fix.
const stopAt = (files, max) => new RegExp(`^The tree that the sync would push, this machine's changes merged with the upstream's as fetched, would hold ${files} files, more than ${max}, the most files that a store's tree may hold, so the sync committed, merged, and pushed nothing, and every file stays on disk as it is\\. Remove files that the store no longer needs, on this machine or another, until it holds at most ${max}, and the next sync shares every change\\.$`);
const remoteFiles = (remote) => git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n");

// Whether every commit of a branch's history holds at most max files, as no sync commits a tree past the bound.
const historyWithin = (cwd, ref, max) => git(cwd, ["rev-list", ref]).split("\n").every((commit) => git(cwd, ["ls-tree", "-r", "--name-only", commit]).split("\n").length <= max);

function remove(root, files) {
  return Promise.all(files.map((file) => rm(path.join(root, ...file.split("/")))));
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

test("a sync whose own changes would take the tree past its bound commits, merges, and pushes nothing and leaves the store as it was, and the first sync after files are removed shares every change, the other machine's too", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await withTreeBound(10, async () => {
    const added = Array.from({ length: 12 }, (_, n) => `artifacts/plans/foo/n${String(n).padStart(2, "0")}.md`);
    await put(b, { ...Object.fromEntries(added.map((file) => [file, "# N\n"])), [SLICE]: "# Foo\n\nChanged on b.\n" });
    await put(a, { "README.md": "Prism store, edited on a\n" });
    push(a, "from a");
    const tip = git(remote, ["rev-parse", "main"]);
    const before = await stateOf(b);
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "merge_failed", JSON.stringify(status));
    assert.match(status.message, stopAt(14, 10), status.message);
    assert.equal(status.withheld, undefined, "no file is withheld for the bound");
    assert.deepEqual(await stateOf(b), before, "the branch, the index, and every file on disk stay as they were, and no lock is left");
    assert.equal(git(remote, ["rev-parse", "main"]), tip, "and nothing is pushed");
    await remove(b, added.slice(8));
    const next = await syncRecordStoreNow(b);
    assert.equal(next.state, "ok", JSON.stringify(next));
    const tree = remoteFiles(remote);
    assert.equal(tree.length, 10);
    for (const file of added.slice(0, 8)) assert.ok(tree.includes(file), `${file} is shared`);
    assert.ok(git(remote, ["show", `main:${SLICE}`]).includes("Changed on b."));
    assert.equal(git(remote, ["show", "main:README.md"]), "Prism store, edited on a", "and the other machine's change stays");
    assert.equal(git(b, ["show", "HEAD:README.md"]), "Prism store, edited on a");
  });
});

test("a commit made by hand that takes the branch past the bound on a store tree's files is refused before the merge with the command that takes it off, after which the sync stops at the bound until files are removed and then shares every change", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await withTreeBound(10, async () => {
    const before = git(b, ["rev-parse", "HEAD"]);
    const added = Array.from({ length: 12 }, (_, n) => `artifacts/plans/foo/n${String(n).padStart(2, "0")}.md`);
    await put(b, Object.fromEntries(added.map((file) => [file, "# N\n"])));
    git(b, ["add", "-A"]);
    git(b, ["commit", "-q", "-m", "by hand"]);
    await put(b, { [SLICE]: "# Foo\n\nChanged on b.\n" });
    await put(a, { "README.md": "Prism store, edited on a\n" });
    push(a, "from a");
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "merge_failed", JSON.stringify(status));
    assert.match(status.message, /^The store's branch holds more than 10 files, the most files that a store's tree may hold, so it was not merged or pushed/, status.message);
    assert.match(status.message, /; then remove files that the store no longer needs from it until it holds at most 10, and the next sync shares every change\.$/, status.message);
    assert.equal(takeOffCommand(status.message), `git reset --soft ${before}`, status.message);
    git(b, ["reset", "-q", "--soft", before]);
    const stopped = await syncRecordStoreNow(b);
    assert.equal(stopped.state, "merge_failed", JSON.stringify(stopped));
    assert.match(stopped.message, stopAt(14, 10), stopped.message);
    assert.equal(git(b, ["rev-parse", "HEAD"]), before);
    await remove(b, added.slice(8));
    const next = await syncRecordStoreNow(b);
    assert.equal(next.state, "ok", JSON.stringify(next));
    assert.equal(remoteFiles(remote).length, 10);
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

test("a merge of this machine's changes with the upstream's that would take the tree past its bound is not made: the sync takes off the commit it made, leaves the store as it was, and shares every change once files are removed", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await withTreeBound(10, async () => {
    const theirs = Array.from({ length: 4 }, (_, n) => `artifacts/plans/foo/a${n}.md`);
    await put(a, Object.fromEntries(theirs.map((file) => [file, "# A\n"])));
    push(a, "four on a");
    const tip = git(remote, ["rev-parse", "main"]);
    const mine = Array.from({ length: 6 }, (_, n) => `artifacts/plans/foo/b${n}.md`);
    await put(b, Object.fromEntries(mine.map((file) => [file, "# B\n"])));
    const before = await stateOf(b);
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "merge_failed", JSON.stringify(status));
    assert.match(status.message, stopAt(12, 10), status.message);
    assert.equal(status.withheld, undefined, "no file is withheld for the bound");
    assert.deepEqual(await stateOf(b), before, "the branch, the checked commit, the index, and every file on disk stay as they were");
    assert.equal(git(remote, ["rev-parse", "main"]), tip, "and nothing is pushed");
    await remove(b, mine.slice(4));
    const next = await syncRecordStoreNow(b);
    assert.equal(next.state, "ok", JSON.stringify(next));
    const tree = remoteFiles(remote);
    assert.equal(tree.length, 10);
    for (const file of [...theirs, ...mine.slice(0, 4)]) assert.ok(tree.includes(file), `${file} is shared`);
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

// A commit on a's branch that adds count empty files below folders named by names, built from Git's objects alone.
function nestedCommit(a, names, count) {
  const empty = git(a, ["hash-object", "-w", "--stdin"], "");
  let tree = git(a, ["mktree"], `${Array.from({ length: count }, (_, n) => `100644 blob ${empty}\t${n}.md`).join("\n")}\n`);
  for (const name of [...names].reverse()) tree = git(a, ["mktree"], `040000 tree ${tree}\t${name}\n`);
  const kept = git(a, ["ls-tree", "HEAD"]).split("\n").filter((line) => !line.endsWith("\tjunk"));
  const root = git(a, ["mktree"], `${[...kept, `040000 tree ${tree}\tjunk`].join("\n")}\n`);
  return git(a, ["commit-tree", root, "-p", "HEAD", "-m", "long paths"]);
}

test("a sync lists no more of a tree than its bound on files at the longest store path allows, and refuses an upstream whose listing passes it, or that holds a path no machine holds, without keeping the rest", { timeout: 240000 }, async (context) => {
  const { a, b } = await stores(context);
  await withTreeBound(10, async () => {
    // Five files whose paths each hold about 3000 bytes: within the bound on files, past what ten paths of a store's longest path take.
    git(a, ["push", "-q", "origin", `${nestedCommit(a, ["d".repeat(3000)], 5)}:refs/heads/main`]);
    const wide = await syncRecordStoreNow(b);
    assert.equal(wide.state, "merge_failed", JSON.stringify(wide));
    assert.match(wide.message, /^The upstream holds a tree whose listing holds more than 6400 bytes, more than a tree of 10 files, .* Remove files, or shorten their paths, from the remote's branch/, wide.message);
  });
  // One file below nine folders of 4000-byte names, a path longer than any supported machine holds.
  git(a, ["push", "-q", "-f", "origin", `${nestedCommit(a, Array.from({ length: 9 }, (_, n) => `${n}`.repeat(4000)), 1)}:refs/heads/main`]);
  const long = await syncRecordStoreNow(b);
  assert.equal(long.state, "merge_failed", JSON.stringify(long));
  assert.match(long.message, /^The upstream holds an entry whose path holds more than 32767 bytes, the most that any supported machine holds, "junk\/0{59}…", which no store may hold/, long.message);
  assert.ok(long.message.length < 2000, "the path is shown by its first characters only");
});

test("a push whose history that the remote lacks lists more than a sync reads is refused by name, while a merge lists only what it changes itself, and the push goes once the history is within the bound", { timeout: 240000 }, async (context) => {
  const { parent, remote, a, b } = await stores(context);
  // The other machine replaces many files that a store does not share while this machine's pushes fail, so this machine's merges of it stay unpushed.
  git(b, ["config", "remote.origin.pushurl", path.join(parent, "nowhere.git")]);
  await put(a, Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`junk/${String(n).padStart(4, "0")}-${"x".repeat(100)}.txt`, `${n}\n`])));
  push(a, "junk");
  configureRecordSync({ historyBytesMax: 8192 });
  try {
    await put(b, { [SLICE]: "# Foo\n\nChanged on b.\n" });
    const merged = await syncRecordStoreNow(b);
    assert.equal(merged.state, "push_rejected", JSON.stringify(merged));
    // A commit made by hand that adds as many files lists more than the bound, so its push is refused by name, with the store as it was, and the process goes on.
    await put(b, Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`mine/${String(n).padStart(4, "0")}-${"y".repeat(100)}.txt`, `${n}\n`])));
    git(b, ["add", "-A"]);
    git(b, ["commit", "-q", "-m", "by hand"]);
    const hand = git(b, ["rev-parse", "HEAD"]);
    const refused = await syncRecordStoreNow(b);
    assert.equal(refused.state, "merge_failed", JSON.stringify(refused));
    assert.match(refused.message, new RegExp(`^Git's listing of the (?:objects|changes) of commit ${hand} holds more than 8192 bytes or 256 entries, more than a sync reads for one commit, so the store's branch was not pushed\\. Take that commit made by hand off the store's branch, such as by running git reset --soft ${hand}\\^ in the store`), refused.message);
  } finally { configureRecordSync({ historyBytesMax: 256 * 1024 * 1024 }); }
  git(b, ["config", "--unset", "remote.origin.pushurl"]);
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(git(remote, ["rev-parse", "main"]), git(b, ["rev-parse", "HEAD"]));
});

test("a first commit made by hand whose listing passes what a sync reads for one commit is refused with the command that takes every commit off, since Git resets to no commit before a branch's first", { timeout: 240000 }, async (context) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-tree-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  const remote = path.join(parent, "remote.git");
  const b = path.join(parent, "b");
  await mkdir(b);
  git(b, ["init", "-q", "-b", "main"]);
  git(b, ["remote", "add", "origin", remote]);
  await put(b, Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`mine/${String(n).padStart(4, "0")}-${"y".repeat(100)}.txt`, `${n}\n`])));
  git(b, ["add", "-A"]);
  git(b, ["commit", "-q", "-m", "by hand"]);
  await put(b, { [SLICE]: "# Foo\n" });
  markManagedStore(b);
  configureRecordSync({ historyBytesMax: 8192 });
  try {
    const refused = await syncRecordStoreNow(b);
    assert.equal(refused.state, "merge_failed", JSON.stringify(refused));
    assert.match(refused.message, /^Git's listing of the (?:objects|changes) of commit [0-9a-f]{40,64} holds more than 8192 bytes or 256 entries, more than a sync reads for one commit, so the store's branch was not pushed\. Take that commit made by hand off the store's branch, such as by running git update-ref -d HEAD in the store, which keeps every file on disk and takes every commit off the branch, since that commit is its first/, refused.message);
    git(b, ["update-ref", "-d", "HEAD"]);
  } finally { configureRecordSync({ historyBytesMax: 256 * 1024 * 1024 }); }
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.deepEqual(git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n"), [SLICE], "the next sync commits the store's files as the branch's first commit");
});

test("the push check walks each commit of an honest history once, so a store whose fetches and pushes failed for many syncs pushes them all, whatever their total size", { timeout: 240000 }, async (context) => {
  const { parent, remote, b } = await stores(context);
  configureRecordSync({ historyBytesMax: 8192 });
  try {
    // Many syncs' commits, first while the push fails and then while the fetch fails too, hold far more than the bound together and far less each.
    git(b, ["config", "remote.origin.pushurl", path.join(parent, "nowhere.git")]);
    for (let n = 0; n < 15; n++) {
      await put(b, { [SLICE]: `# Foo\n\nSync ${n}.\n` });
      assert.equal((await syncRecordStoreNow(b)).state, "push_rejected");
    }
    const url = git(b, ["config", "remote.origin.url"]);
    git(b, ["config", "remote.origin.url", path.join(parent, "nowhere.git")]);
    for (let n = 15; n < 30; n++) {
      await put(b, { [SLICE]: `# Foo\n\nSync ${n}.\n` });
      assert.equal((await syncRecordStoreNow(b)).state, "fetch_failed");
    }
    git(b, ["config", "remote.origin.url", url]);
    git(b, ["config", "--unset", "remote.origin.pushurl"]);
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "ok", JSON.stringify(status));
    assert.equal(git(remote, ["rev-parse", "main"]), git(b, ["rev-parse", "HEAD"]));
    assert.equal(Number(git(remote, ["rev-list", "--count", "main"])), 31);
  } finally { configureRecordSync({ historyBytesMax: 256 * 1024 * 1024 }); }
});

// The artifact at a location with the given identity's id.
const artifactOf = (location, id) => ({ [`artifacts/${location}`]: requirementFile(id), [`artifact-identity/${location}`]: rec({ id: id.repeat(32) }), [`artifact-status/${location}/status.json`]: rec({ status: "Draft" }) });
const idAt = (cwd, location) => { try { return JSON.parse(git(cwd, ["show", `main:artifact-identity/${location}`])).id[0]; } catch { return null; } };
const L0 = "requirements/alpha.md";
const rec = (value) => `${JSON.stringify(value)}\n`;
const W = "requirements/billing.md";
const W2 = "requirements/ledger.md";
const CNAME = "2026-11-09T10-00-02-000Z-0123abce.json";
const comment = (text) => rec({ location: W, version: `sha256:${"0".repeat(64)}`, line: 1, text, author: { name: "Ada", host: "vm" }, at: "2026-11-09T10:00:02.000Z", entry: "a".repeat(32), by: { name: "Ada", email: null, checkout: "c" }, via: "review-app" });

for (const chain of [false, true]) {
  test(`a sync stopped at the bound on a store tree's files loses nothing of ${chain ? "a chain of moves" : "a move and a new artifact at the old place"}: once files are removed, each artifact reaches the store with its own identity`, { timeout: 240000 }, async (context) => {
    const { remote, a, b } = await stores(context);
    await put(a, chain ? { ...artifactOf(W, "1"), ...artifactOf(L0, "3") } : { ...artifactOf(W, "1"), ...Object.fromEntries(Array.from({ length: 3 }, (_, n) => [`artifacts/plans/foo/a${n}.md`, "# A\n"])) });
    push(a, "artifacts");
    assert.equal((await syncRecordStoreNow(b)).state, "ok");
    await withTreeBound(8, async () => {
      // One artifact moves to a new place and another takes its old place, a new one or the second artifact of a chain of moves, with more files than the bound allows.
      await remove(b, [...Object.keys(artifactOf(W, "1")), ...(chain ? Object.keys(artifactOf(L0, "3")) : [])]);
      await put(b, { ...artifactOf(W2, "1"), ...artifactOf(W, chain ? "3" : "2"), ...(chain ? { "artifacts/plans/foo/b0.md": "# B\n" } : {}) });
      const before = await stateOf(b);
      const status = await syncRecordStoreNow(b);
      assert.equal(status.state, "merge_failed", JSON.stringify(status));
      assert.match(status.message, stopAt(chain ? 9 : 11, 8), status.message);
      assert.deepEqual(await stateOf(b), before, "every file stays on disk as it is");
      await remove(b, chain ? ["artifacts/plans/foo/b0.md"] : ["artifacts/plans/foo/a0.md", "artifacts/plans/foo/a1.md", "artifacts/plans/foo/a2.md"]);
      const next = await syncRecordStoreNow(b);
      assert.equal(next.state, "ok", JSON.stringify(next));
    });
    assert.deepEqual([idAt(remote, W2), idAt(remote, W), idAt(remote, L0)], ["1", chain ? "3" : "2", null]);
  });
}

for (const kind of ["moves", "removes"]) {
  test(`a comment that a sync stopped at the bound on a store tree's files kept on disk follows its artifact's identity once the other machine removes files, and never lands on a new artifact at its place, where the other machine ${kind} the artifact`, { timeout: 240000 }, async (context) => {
    const { remote, a, b } = await stores(context);
    await put(a, { ...artifactOf(W, "1"), ...Object.fromEntries(Array.from({ length: 4 }, (_, n) => [`artifacts/plans/foo/a${n}.md`, "# A\n"])) });
    push(a, "artifact and four");
    assert.equal((await syncRecordStoreNow(b)).state, "ok");
    const mine = `artifact-comments/${W}/${CNAME}`;
    await withTreeBound(9, async () => {
      await put(b, { [mine]: comment("about the first artifact") });
      assert.match((await syncRecordStoreNow(b)).message, stopAt(10, 9));
      // The other machine takes the artifact away from its place and makes room, then writes a new artifact there.
      await remove(a, [...Object.keys(artifactOf(W, "1")), ...Array.from({ length: 4 }, (_, n) => `artifacts/plans/foo/a${n}.md`)]);
      if (kind === "moves") await put(a, artifactOf(W2, "1"));
      push(a, kind);
      await put(a, artifactOf(W, "2"));
      push(a, "new artifact at the old place");
      // This machine's own commit would still pass the bound, but merged with the upstream's removals the tree fits, so the sync merges the comment as if it were committed.
      const status = await syncRecordStoreNow(b);
      assert.ok(["ok", "conflicts"].includes(status.state), JSON.stringify(status));
      if (kind === "removes") assert.ok(status.conflicts.some((conflict) => conflict.path === mine), `a comment whose artifact is gone is saved and named: ${JSON.stringify(status)}`);
    });
    const comments = remoteFiles(remote).filter((file) => file.startsWith("artifact-comments/"));
    assert.deepEqual(comments, kind === "moves" ? [`artifact-comments/${W2}/${CNAME}`] : [], "the comment follows its artifact's identity and never lands on the new artifact at its place");
    assert.equal(idAt(remote, W), "2");
    if (kind === "moves") assert.match(await readFile(path.join(b, "artifact-comments", ...W2.split("/"), CNAME), "utf8"), new RegExp(`"location":"${W2}"`), "and names its artifact's new place, as a move writes it");
  });
}

test("a sync whose own commit would pass the bound on a store tree's files fetches and merges this machine's changes with the upstream's, and commits only the merge, which fits", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  const theirs = Array.from({ length: 6 }, (_, n) => `artifacts/plans/foo/a${n}.md`);
  await put(a, Object.fromEntries(theirs.map((file) => [file, "# A\n"])));
  push(a, "six on a");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  await withTreeBound(10, async () => {
    // This machine adds four files, a commit of eleven files, while the other machine removes three and changes the slice.
    const mine = Array.from({ length: 3 }, (_, n) => `artifacts/plans/foo/b${n}.md`);
    await put(b, { ...Object.fromEntries(mine.map((file) => [file, "# B\n"])), "README.md": "Prism store, edited on b\n" });
    await put(a, { [SLICE]: "# Foo\n\nChanged on a.\n" });
    await remove(a, theirs.slice(0, 3));
    push(a, "a makes room");
    const head = git(b, ["rev-parse", "HEAD"]);
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "ok", JSON.stringify(status));
    const tree = remoteFiles(remote);
    assert.equal(tree.length, 8);
    for (const file of [...mine, ...theirs.slice(3)]) assert.ok(tree.includes(file), `${file} is shared`);
    assert.equal(git(remote, ["show", "main:README.md"]), "Prism store, edited on b");
    assert.ok(git(remote, ["show", `main:${SLICE}`]).includes("Changed on a."));
    assert.deepEqual(git(remote, ["rev-list", "--parents", "-n", "1", "main"]).split(" ").slice(1), [head, git(a, ["rev-parse", "HEAD"])], "the merge's parents are the branch as it was and the upstream");
    assert.ok(historyWithin(remote, "main", 10), "no commit of the branch's history holds more files than the bound");
  });
});

test("a stop at the bound on a store tree's files after an earlier attempt of the sync merged and lost its push says that the merge stays", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await withTreeBound(5, async () => {
    await put(b, { "artifacts/plans/foo/b0.md": "# B\n" });
    await put(a, { "artifacts/plans/foo/a0.md": "# A\n" });
    push(a, "one on a");
    let raced = false;
    // The other machine pushes again while this machine's first push is under way, so the second attempt's merge would pass the bound.
    const status = await syncRecordStoreNow(b, { beforePush: async () => {
      if (raced) return;
      raced = true;
      await put(a, { "artifacts/plans/foo/a1.md": "# A\n", "artifacts/plans/foo/a2.md": "# A\n" });
      push(a, "two more on a");
    } });
    assert.equal(status.state, "merge_failed", JSON.stringify(status));
    assert.match(status.message, /^The tree that the sync would push, this machine's changes merged with the upstream's as fetched, would hold 6 files, more than 5, the most files that a store's tree may hold, so the sync pushed nothing: it keeps the merge of the upstream that it made before another machine pushed first, and this machine's later changes stay on disk as they are, in no commit\./, status.message);
    assert.ok(git(b, ["log", "--format=%s", "-1"]).startsWith("prism: merge records"), "the first attempt's merge stays on the branch");
    assert.ok(historyWithin(b, "HEAD", 5));
    assert.equal(remoteFiles(remote).length, 5);
  });
});
