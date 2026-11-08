import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A teammate can push a tree whose entry names Git itself never writes, such as "..", because fsck is off by default; no sync may write or remove a file through such a path.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-paths-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment,
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
const { cancelRecordSyncs, configureRecordSync, syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, args, input) => execFileSync("git", ["-C", cwd, ...args], { input, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const exists = (target) => access(target).then(() => true, () => false);

// Two stores cloned from one bare remote, each one level below its own folder, so a path that climbs out of store b lands in a folder the test owns.
async function stores(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-paths-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  await mkdir(path.join(parent, "a"));
  await mkdir(path.join(parent, "b"));
  git(parent, ["clone", "-q", "remote.git", "a/store"]);
  const storeA = path.join(parent, "a", "store");
  git(storeA, ["checkout", "-q", "-b", "main"]);
  await mkdir(path.join(storeA, "artifacts", "plans"), { recursive: true });
  await writeFile(path.join(storeA, "artifacts", "plans", "slice.md"), "# Slice\n");
  await writeFile(path.join(storeA, "roadmap.json"), "{}\n");
  git(storeA, ["add", "."]);
  git(storeA, ["commit", "-q", "-m", "init"]);
  git(storeA, ["push", "-q", "-u", "origin", "main"]);
  git(parent, ["clone", "-q", "remote.git", "b/store"]);
  return { parent, storeA, storeB: path.join(parent, "b", "store") };
}

// Push from store a a commit on top of the remote's branch that adds a file at the path that names lists, part by part, built with mktree as a teammate could.
function pushCrafted(storeA, names, contents = "crafted\n") {
  git(storeA, ["fetch", "-q", "origin"]);
  let entry = `100644 blob ${git(storeA, ["hash-object", "-w", "--stdin"], contents)}\t${names.at(-1)}`;
  for (const name of names.slice(0, -1).reverse()) entry = `040000 tree ${git(storeA, ["mktree"], `${entry}\n`)}\t${name}`;
  const top = names[0];
  const kept = git(storeA, ["ls-tree", "origin/main^{tree}"]).split("\n").filter((line) => line && line.split("\t")[1] !== top);
  const tree = git(storeA, ["mktree"], `${[...kept, entry].join("\n")}\n`);
  const commit = git(storeA, ["commit-tree", tree, "-p", "origin/main", "-m", "crafted"]);
  git(storeA, ["push", "-q", "origin", `${commit}:refs/heads/main`]);
  return commit;
}

// Paths a crafted tree can hold, and where a sync that followed each would have written.
const CRAFTED = [
  { label: "a .. part under artifacts/", names: ["artifacts", "..", "..", "escape.txt"], target: (store) => path.join(path.dirname(store), "escape.txt") },
  { label: "a .. part under initiatives/", names: ["initiatives", "..", "..", "escape.json"], target: (store) => path.join(path.dirname(store), "escape.json") },
  { label: "the store's own Git folder", names: [".git", "hooks", "post-commit"], target: (store) => path.join(store, ".git", "hooks", "post-commit") },
  { label: "Git's folder in another letter case with a trailing dot", names: [".GIT.", "hooks", "post-commit"], target: (store) => path.join(store, ".GIT.", "hooks", "post-commit") },
  { label: "a . part", names: ["artifacts", ".", "plans", "dot.md"], target: (store) => path.join(store, "artifacts", "plans", "dot.md") },
  { label: "a backslash", names: ["artifacts", "plans\\..\\..\\..\\escape.md"], target: (store) => path.join(store, "artifacts", "plans\\..\\..\\..\\escape.md") },
  { label: "a drive form", names: ["artifacts", "C:escape.md"], target: (store) => path.join(store, "artifacts", "C:escape.md") },
  { label: "the sync folder", names: [".prism-sync", "planted"], target: (store) => path.join(store, ".prism-sync", "planted") },
  { label: "the sync folder in another letter case", names: [".Prism-Sync", "conflicts", "planted.md"], target: (store) => path.join(store, ".Prism-Sync", "conflicts", "planted.md") },
  { label: "the sync folder with a trailing dot", names: [".prism-sync.", "status.json"], target: (store) => path.join(store, ".prism-sync.", "status.json") },
  { label: "the sync folder with a trailing space", names: [".PRISM-SYNC ", "planted"], target: (store) => path.join(store, ".PRISM-SYNC ", "planted") }
];

for (const { label, names, target } of CRAFTED) {
  for (const diverged of [false, true]) {
    test(`a sync refuses an upstream path with ${label}${diverged ? " after a local change" : ""}, and writes and removes nothing`, async (context) => {
      const { storeA, storeB } = await stores(context);
      if (diverged) await writeFile(path.join(storeB, "artifacts", "plans", "local.md"), "# Local\n");
      const crafted = pushCrafted(storeA, names);
      // Store b already holds the crafted objects, as after any fetch without checks, so the sync's own path check is what refuses them.
      git(storeB, ["fetch", "-q", "origin"]);
      const status = await syncRecordStore(storeB);
      assert.equal(status.state, "merge_failed", JSON.stringify(status));
      assert.match(status.message, /leads outside the store's files/);
      assert.equal(await exists(target(storeB)), false, "nothing is written through the crafted path");
      assert.equal(isAncestor(storeB, crafted), false, "the branch stays where it was");
      assert.equal(git(storeB, ["status", "--porcelain", "--", ".", ":(exclude).prism-sync"]), "", "the store's files match its branch");
      assert.equal(await exists(path.join(storeB, "artifacts", "plans", "slice.md")), true);
      if (diverged) assert.equal(await exists(path.join(storeB, "artifacts", "plans", "local.md")), true, "the local change stays");
    });
  }
}

function isAncestor(store, commit) {
  try { execFileSync("git", ["-C", store, "merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "pipe" }); return true; } catch { return false; }
}

test("a sync refuses an upstream path that passes through a symbolic link in the store, and writes nothing through it", async (context) => {
  const { parent, storeA, storeB } = await stores(context);
  const outside = path.join(parent, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(storeB, "artifacts", "link"));
  await writeFile(path.join(storeB, ".git", "info", "exclude"), "/artifacts/link\n");
  await mkdir(path.join(storeA, "artifacts", "link"), { recursive: true });
  await writeFile(path.join(storeA, "artifacts", "link", "planted.md"), "# Planted\n");
  git(storeA, ["add", "."]);
  git(storeA, ["commit", "-q", "-m", "add a folder of the link's name"]);
  git(storeA, ["push", "-q", "origin", "main"]);
  const status = await syncRecordStore(storeB);
  assert.equal(status.state, "merge_failed", JSON.stringify(status));
  assert.equal(await exists(path.join(outside, "planted.md")), false, "nothing is written through the link");
  assert.equal(isAncestor(storeB, git(storeA, ["rev-parse", "HEAD"])), false, "the branch stays where it was");
});

test("a fetch checks the objects it receives, so a crafted tree fails the fetch and the store keeps its branch", async (context) => {
  const { storeA, storeB } = await stores(context);
  const before = git(storeB, ["rev-parse", "HEAD"]);
  pushCrafted(storeA, ["artifacts", "..", "..", "escape.txt"]);
  const status = await syncRecordStore(storeB);
  assert.equal(status.state, "fetch_failed", JSON.stringify(status));
  assert.equal(await exists(path.join(path.dirname(storeB), "escape.txt")), false);
  assert.equal(git(storeB, ["rev-parse", "HEAD"]), before);
});

test("a sync with fetch checks on still takes an ordinary upstream change", async (context) => {
  const { storeA, storeB } = await stores(context);
  await writeFile(path.join(storeA, "artifacts", "plans", "slice.md"), "# Slice\n\nMore.\n");
  git(storeA, ["commit", "-q", "-am", "edit"]);
  git(storeA, ["push", "-q", "origin", "main"]);
  assert.equal((await syncRecordStore(storeB)).state, "ok");
  assert.equal(git(storeB, ["show", "HEAD:artifacts/plans/slice.md"]), "# Slice\n\nMore.");
});
