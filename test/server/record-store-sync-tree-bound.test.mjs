import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

const rec = (value) => `${JSON.stringify(value)}\n`;
const W = "requirements/billing.md";
const W2 = "requirements/ledger.md";
const CNAME = "2026-11-09T10-00-02-000Z-0123abce.json";
const artifact = (location) => ({ [`artifacts/${location}`]: requirementFile("X"), [`artifact-identity/${location}`]: rec({ id: "1".repeat(32) }), [`artifact-status/${location}/status.json`]: rec({ status: "Draft" }) });
const comment = (text) => rec({ location: W, version: `sha256:${"0".repeat(64)}`, line: 1, text, author: { name: "Ada", host: "vm" }, at: "2026-11-09T10:00:02.000Z", entry: "a".repeat(32), by: { name: "Ada", email: null, checkout: "c" }, via: "review-app" });

for (const moved of [false, true]) {
  test(`a merge at the bound on a store tree's files keeps every identity file of the upstream and withholds this machine's comment on disk${moved ? ", where the other machine moved the artifact" : ""}`, { timeout: 240000 }, async (context) => {
    const { remote, a, b } = await stores(context);
    await put(a, artifact(W));
    push(a, "artifact");
    assert.equal((await syncRecordStoreNow(b)).state, "ok");
    await withTreeBound(9, async () => {
      // The upstream reaches the bound: README, slice, the artifact's three files, and four more.
      const files = Object.fromEntries(Array.from({ length: 4 }, (_, n) => [`artifacts/plans/foo/a${n}.md`, "# A\n"]));
      if (moved) {
        for (const file of Object.keys(artifact(W))) await rm(path.join(a, ...file.split("/")));
        Object.assign(files, artifact(W2));
      }
      await put(a, files);
      push(a, moved ? "move and four" : "four");
      const upstream = git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
      const mine = `artifact-comments/${W}/${CNAME}`;
      await put(b, { [mine]: comment("from b") });
      const status = await syncRecordStoreNow(b);
      assert.equal(status.state, "ok", JSON.stringify(status));
      // A comment on an artifact that the other machine moved follows the artifact on disk, as the merge placed it, and is withheld there.
      const placed = `artifact-comments/${moved ? W2 : W}/${CNAME}`;
      assert.deepEqual(status.withheld.map((entry) => entry.path), [placed]);
      assert.ok(existsSync(path.join(b, ...placed.split("/"))), "the withheld comment stays on disk beside its artifact");
      if (moved) assert.ok(!existsSync(path.join(b, ...mine.split("/"))), "and leaves the place that no longer holds its artifact");
      assert.deepEqual(git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n"), upstream, "the store keeps every file of the upstream, its identity files among them");
      assert.equal((await syncRecordStoreNow(a)).state, "ok");
      assert.ok(existsSync(path.join(a, "artifact-identity", ...(moved ? W2 : W).split("/"))), "and the other machine keeps the identity file");
    });
    // Once the store has room, the comment is committed beside its artifact, and never where the artifact no longer is.
    assert.equal((await syncRecordStoreNow(b)).state, "ok");
    const comments = git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n").filter((file) => file.startsWith("artifact-comments/"));
    assert.deepEqual(comments, [`artifact-comments/${moved ? W2 : W}/${CNAME}`]);
  });
}

test("a commit at the bound on a store tree's files withholds an artifact that this machine added with its identity file and status record, never one without the others", { timeout: 240000 }, async (context) => {
  const { remote, b } = await stores(context);
  await withTreeBound(4, async () => {
    await put(b, { ...artifact(W), "artifacts/plans/foo/z.md": "# Z\n" });
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "ok", JSON.stringify(status));
    assert.deepEqual(status.withheld.map((entry) => entry.path).sort(), Object.keys(artifact(W)).sort());
    assert.deepEqual(git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n"), ["README.md", "artifacts/plans/foo/slice.md", "artifacts/plans/foo/z.md"]);
  });
});

function remove(root, files) {
  return Promise.all(files.map((file) => rm(path.join(root, ...file.split("/")))));
}

for (const extra of ["artifacts/plans/foo/b0.md", "artifacts/zz/b0.md"]) {
  test(`a commit at the bound on a store tree's files never withholds an artifact that this machine moved, since a move adds no file, and withholds ${extra} instead`, { timeout: 240000 }, async (context) => {
    const { remote, a, b } = await stores(context);
    await put(a, { ...artifact(W), ...Object.fromEntries(Array.from({ length: 3 }, (_, n) => [`artifacts/plans/foo/a${n}.md`, "# A\n"])) });
    push(a, "artifact and three");
    assert.equal((await syncRecordStoreNow(b)).state, "ok");
    await withTreeBound(8, async () => {
      // The store is at its bound: README, slice, the artifact's three files, and three more; this machine moves the artifact and adds one file.
      await remove(b, Object.keys(artifact(W)));
      await put(b, { ...artifact(W2), [extra]: "# B\n" });
      const status = await syncRecordStoreNow(b);
      assert.equal(status.state, "ok", JSON.stringify(status));
      assert.deepEqual(status.withheld.map((entry) => entry.path), [extra]);
      const tree = git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
      for (const file of Object.keys(artifact(W2))) assert.ok(tree.includes(file), `the store holds the moved artifact's ${file}`);
      for (const file of Object.keys(artifact(W))) assert.ok(!tree.includes(file), `and nothing of it at ${file}`);
      assert.equal((await syncRecordStoreNow(a)).state, "ok");
      assert.ok(existsSync(path.join(a, "artifacts", ...W2.split("/"))), "the other machine holds the artifact at its new place");
    });
  });
}

test("a comment that this machine's commit withheld at the bound on a store tree's files follows its artifact when the other machine moves it, and is committed there once the store has room", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await put(a, { ...artifact(W), ...Object.fromEntries(Array.from({ length: 3 }, (_, n) => [`artifacts/plans/foo/a${n}.md`, "# A\n"])) });
  push(a, "artifact and three");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  const mine = `artifact-comments/${W}/${CNAME}`;
  const placed = `artifact-comments/${W2}/${CNAME}`;
  await withTreeBound(8, async () => {
    await put(b, { [mine]: comment("from b") });
    assert.deepEqual((await syncRecordStoreNow(b)).withheld.map((entry) => entry.path), [mine]);
    // The other machine moves the artifact, so the comment's place holds no artifact any more.
    await remove(a, Object.keys(artifact(W)));
    await put(a, artifact(W2));
    push(a, "move");
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "ok", JSON.stringify(status));
    assert.deepEqual(status.withheld.map((entry) => entry.path), [placed]);
    assert.ok(existsSync(path.join(b, ...placed.split("/"))) && !existsSync(path.join(b, ...mine.split("/"))), "the withheld comment follows its artifact on disk");
    assert.match(await readFile(path.join(b, ...placed.split("/")), "utf8"), new RegExp(`"location":"${W2}"`), "and names its artifact's new place, as a move writes it");
  });
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  const comments = git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n").filter((file) => file.startsWith("artifact-comments/"));
  assert.deepEqual(comments, [placed], "the comment is committed beside its artifact, never where the artifact no longer is");
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

test("a commit at the bound on a store tree's files judges additions by identity: a moved artifact is kept wherever another artifact now stands at its old place, and the new artifact there is withheld", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await put(a, { ...artifactOf(W, "1"), ...Object.fromEntries(Array.from({ length: 3 }, (_, n) => [`artifacts/plans/foo/a${n}.md`, "# A\n"])) });
  push(a, "artifact and three");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  await withTreeBound(8, async () => {
    // This machine moves the artifact and writes a new one at its old place, three files more than the bound allows.
    await remove(b, Object.keys(artifactOf(W, "1")));
    await put(b, { ...artifactOf(W2, "1"), ...artifactOf(W, "2") });
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "ok", JSON.stringify(status));
    assert.deepEqual(status.withheld.map((entry) => entry.path).sort(), Object.keys(artifactOf(W, "2")).sort());
    assert.equal(idAt(remote, W2), "1", "the store holds the moved artifact at its new place");
    assert.equal(idAt(remote, W), null, "and nothing at its old place, which the withheld artifact takes once there is room");
  });
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  assert.deepEqual([idAt(remote, W), idAt(remote, W2)], ["2", "1"]);
});

test("a commit at the bound on a store tree's files keeps both artifacts of a chain of moves and withholds the one file that this machine added", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await put(a, { ...artifactOf(W, "1"), ...artifactOf(L0, "3") });
  push(a, "two artifacts");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  await withTreeBound(8, async () => {
    // One artifact moves to a new place and the other to the first one's old place.
    await remove(b, [...Object.keys(artifactOf(W, "1")), ...Object.keys(artifactOf(L0, "3"))]);
    await put(b, { ...artifactOf(W2, "1"), ...artifactOf(W, "3"), "artifacts/plans/foo/b0.md": "# B\n" });
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "ok", JSON.stringify(status));
    assert.deepEqual(status.withheld.map((entry) => entry.path), ["artifacts/plans/foo/b0.md"]);
    assert.deepEqual([idAt(remote, W2), idAt(remote, W), idAt(remote, L0)], ["1", "3", null]);
  });
});

for (const kind of ["moves", "removes"]) {
  test(`a comment withheld at the bound on a store tree's files never lands on another artifact at its place when the other machine ${kind} its artifact and writes a new one there`, { timeout: 240000 }, async (context) => {
    const { remote, a, b } = await stores(context);
    await put(a, { ...artifactOf(W, "1"), ...Object.fromEntries(Array.from({ length: 3 }, (_, n) => [`artifacts/plans/foo/a${n}.md`, "# A\n"])) });
    push(a, "artifact and three");
    assert.equal((await syncRecordStoreNow(b)).state, "ok");
    const mine = `artifact-comments/${W}/${CNAME}`;
    await withTreeBound(8, async () => {
      await put(b, { [mine]: comment("about the first artifact") });
      assert.deepEqual((await syncRecordStoreNow(b)).withheld.map((entry) => entry.path), [mine]);
      // The other machine takes the artifact away from its place and makes room, then writes a new artifact there.
      await remove(a, [...Object.keys(artifactOf(W, "1")), "artifacts/plans/foo/a0.md", "artifacts/plans/foo/a1.md", "artifacts/plans/foo/a2.md"]);
      if (kind === "moves") await put(a, artifactOf(W2, "1"));
      push(a, kind);
      await put(a, artifactOf(W, "2"));
      push(a, "new artifact at the old place");
      const status = await syncRecordStoreNow(b);
      assert.ok(["ok", "conflicts"].includes(status.state), JSON.stringify(status));
      if (kind === "removes") assert.ok(status.conflicts.some((conflict) => conflict.path === mine), "a comment whose artifact is gone is saved and named");
    });
    assert.equal((await syncRecordStoreNow(b)).state, "ok");
    const comments = git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n").filter((file) => file.startsWith("artifact-comments/"));
    assert.deepEqual(comments, kind === "moves" ? [`artifact-comments/${W2}/${CNAME}`] : [], "the comment follows its artifact's identity and never lands on the new artifact at its place");
  });
}

test("a withheld comment whose move to its artifact's new place was skipped, as when it changed while the merge applied, follows it on the next sync", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await put(a, { ...artifactOf(W, "1"), ...Object.fromEntries(Array.from({ length: 3 }, (_, n) => [`artifacts/plans/foo/a${n}.md`, "# A\n"])) });
  push(a, "artifact and three");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  const mine = `artifact-comments/${W}/${CNAME}`;
  await withTreeBound(8, async () => {
    await put(b, { [mine]: comment("first") });
    assert.deepEqual((await syncRecordStoreNow(b)).withheld.map((entry) => entry.path), [mine]);
    // The other machine moves the artifact, writes a new one at its old place, and keeps the store at the bound.
    await remove(a, [...Object.keys(artifactOf(W, "1")), "artifacts/plans/foo/a0.md", "artifacts/plans/foo/a1.md", "artifacts/plans/foo/a2.md"]);
    await put(a, { ...artifactOf(W2, "1"), ...artifactOf(W, "2") });
    push(a, "move and a new artifact at the old place");
    // The comment changes while the merge applies, so the merge leaves it where it is.
    const status = await syncRecordStoreNow(b, { beforeApply: () => writeFile(path.join(b, ...mine.split("/")), comment("changed")) });
    assert.deepEqual(status.withheld?.map((entry) => entry.path), [mine], JSON.stringify(status));
    // The next sync takes it to its artifact's new place, and never commits it beside the new artifact at the old place.
    const next = await syncRecordStoreNow(b);
    assert.deepEqual(next.withheld.map((entry) => entry.path), [`artifact-comments/${W2}/${CNAME}`]);
    assert.ok(!existsSync(path.join(b, ...mine.split("/"))));
    assert.ok(!git(remote, ["ls-tree", "-r", "--name-only", "main"]).includes(mine));
  });
});
