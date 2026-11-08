import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Every store command runs with the same settings whatever the person's Git configuration, the variables Git inherits, or the store's local refs say,
// so the checks read the objects that the push sends, the push sends one branch and nothing else, and the fetch and the first clone behave as every sync expects.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-settings-env-")));
const plain = path.join(environment, "gitconfig");
await writeFile(plain, "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: plain, GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment, PRISM_REVIEW_APP_DIR: path.join(environment, "app"),
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
const { cancelRecordSyncs, configureRecordSync, syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
const { managedRecordStore, useManagedStores } = await import("../../dist/server/workflow/record-store-remote.mjs");
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, args, input) => execFileSync("git", ["-C", cwd, ...args], { input, env: { ...process.env, GIT_CONFIG_GLOBAL: plain }, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const has = (cwd, ref) => { try { git(cwd, ["rev-parse", "--verify", "--quiet", ref]); return true; } catch { return false; } };
const exists = (target) => access(target).then(() => true, () => false);

// The person's Git configuration as Git reads it from GIT_CONFIG_GLOBAL, with settings that would change what a store command does.
const HOSTILE = `[push]
\tfollowTags = true
\trecurseSubmodules = on-demand
\tdefault = matching
[submodule]
\trecurse = true
[fetch]
\tprune = false
\tpruneTags = true
\twriteCommitGraph = true
\trecurseSubmodules = yes
[core]
\tcommitGraph = true
\tmaxTreeDepth = 10
\tuseReplaceRefs = true
[clone]
\tdefaultRemoteName = upstream
`;

// Run a store sync with the person's configuration and extra variables in place, then restore them.
async function syncWith(store, { config = HOSTILE, variables = {} } = {}) {
  const file = path.join(environment, `hostile-${Math.random().toString(16).slice(2)}.gitconfig`);
  await writeFile(file, config);
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: file, ...variables });
  try {
    return await syncRecordStoreNow(store);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

async function stores(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-settings-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  git(parent, ["clone", "-q", "remote.git", "a"]);
  const storeA = path.join(parent, "a");
  git(storeA, ["checkout", "-q", "-b", "main"]);
  await mkdir(path.join(storeA, "artifacts", "plans"), { recursive: true });
  await writeFile(path.join(storeA, "artifacts", "plans", "slice.md"), "# Slice\n");
  await writeFile(path.join(storeA, "roadmap.json"), "{}\n");
  git(storeA, ["add", "."]);
  git(storeA, ["commit", "-q", "-m", "init"]);
  git(storeA, ["push", "-q", "-u", "origin", "main"]);
  git(parent, ["clone", "-q", "remote.git", "b"]);
  return { parent, remote: path.join(parent, "remote.git"), storeA, storeB: path.join(parent, "b") };
}

const checkedClone = (remote, target) => execFileSync("git", ["-c", "transfer.fsckObjects=true", "clone", "-q", `file://${remote}`, target], { env: { ...process.env, GIT_CONFIG_GLOBAL: plain }, stdio: "pipe" });

// An annotated tag whose tagger date is zero-padded, which every checked fetch refuses, as git mktag of Git 2.25 to 2.30 writes it.
function malformedTag(store, name) {
  const tag = git(store, ["hash-object", "-t", "tag", "--literally", "-w", "--stdin"], `object ${git(store, ["rev-parse", "HEAD"])}\ntype commit\ntag ${name}\ntagger Prism Test <test@example.invalid> 01700000000 +0000\n\n${name}\n`);
  git(store, ["update-ref", `refs/tags/${name}`, tag]);
}

test("with push.followTags in the person's configuration, in the store's, or in an inherited variable, a sync pushes the branch and no tag", async (context) => {
  const { parent, remote, storeA, storeB } = await stores(context);
  malformedTag(storeB, "before-migration");
  git(storeB, ["tag", "-a", "-m", "release", "v1"]);
  git(storeB, ["config", "push.followTags", "true"]);
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":1}\n");
  assert.equal((await syncWith(storeB)).state, "ok");
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":2}\n");
  const inherited = await syncWith(storeB, { config: "", variables: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "push.followTags", GIT_CONFIG_VALUE_0: "true" } });
  assert.equal(inherited.state, "ok");
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"b\":2}");
  assert.equal(git(remote, ["tag", "--list"]), "", "the remote holds no tag");
  assert.ok(has(storeB, "refs/tags/before-migration") && has(storeB, "refs/tags/v1"), "the store keeps its own tags");
  checkedClone(remote, path.join(parent, "fresh"));
  assert.equal((await syncWith(storeA)).state, "ok", "every other machine keeps syncing");
});

test("a replace ref that hides a link at the branch tip leaves the sync reading the real tree, so the link never reaches the remote's tip and every other machine keeps syncing", async (context) => {
  const { remote, storeA, storeB } = await stores(context);
  const clean = git(storeB, ["rev-parse", "HEAD^{tree}"]);
  const target = git(storeB, ["hash-object", "-w", "--stdin"], "../../outside");
  const real = git(storeB, ["mktree"], `${git(storeB, ["ls-tree", "HEAD"])}\n040000 tree ${git(storeB, ["mktree"], `120000 blob ${target}\tlink\n`)}\tnotes\n`);
  git(storeB, ["update-ref", "HEAD", git(storeB, ["commit-tree", real, "-p", "HEAD", "-m", "by hand"])]);
  git(storeB, ["replace", real, clean]);
  const status = await syncWith(storeB);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.doesNotMatch(git(remote, ["ls-tree", "-r", "main"]), /^120000 /m, "the remote's branch tip holds no link");
  assert.equal((await syncWith(storeA)).state, "ok", "every other machine keeps syncing");
});

test("a replace ref or a grafts file that hides a commit of the branch's history leaves the history check reading the real commits, so the push is refused", async (context) => {
  for (const hide of ["replace", "graft"]) {
    const { remote, storeB } = await stores(context);
    const before = git(remote, ["rev-parse", "main"]);
    const head = git(storeB, ["rev-parse", "HEAD"]);
    const blob = git(storeB, ["hash-object", "-w", "--stdin"], "notes\n");
    const holding = git(storeB, ["commit-tree", git(storeB, ["mktree"], `${git(storeB, ["ls-tree", "HEAD"])}\n040000 tree ${git(storeB, ["mktree"], `100644 blob ${blob}\t.GitAttributes\n`)}\tnotes\n`), "-p", head, "-m", "by hand"]);
    const tip = git(storeB, ["commit-tree", git(storeB, ["rev-parse", "HEAD^{tree}"]), "-p", holding, "-m", "removed by hand"]);
    git(storeB, ["update-ref", "HEAD", tip]);
    if (hide === "replace") git(storeB, ["replace", tip, git(storeB, ["commit-tree", git(storeB, ["rev-parse", "HEAD^{tree}"]), "-p", head, "-m", "removed by hand"])]);
    else await writeFile(path.join(storeB, ".git", "info", "grafts"), `${tip} ${head}\n`);
    await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
    const status = await syncWith(storeB);
    assert.equal(status.state, "merge_failed", `${hide}: ${JSON.stringify(status)}`);
    assert.ok(status.message.includes("notes/.GitAttributes"), status.message);
    assert.equal(git(remote, ["rev-parse", "main"]), before, `${hide}: nothing was pushed`);
  }
});

test("remote.<name>.mirror, remote.<name>.push, push.default, and tag and submodule settings leave the push one of the branch alone, and the fetch keeps the store's tags", async (context) => {
  const { remote, storeA, storeB } = await stores(context);
  git(storeA, ["push", "-q", "origin", "main:refs/heads/other"]);
  git(storeB, ["fetch", "-q", "origin"]);
  git(storeB, ["config", "remote.origin.mirror", "true"]);
  git(storeB, ["config", "remote.origin.push", "refs/heads/*:refs/heads/elsewhere/*"]);
  git(storeB, ["config", "remote.origin.tagOpt", "--tags"]);
  git(storeB, ["tag", "local-only"]);
  git(storeA, ["tag", "-a", "-m", "remote", "remote-tag"]);
  git(storeA, ["push", "-q", "origin", "remote-tag"]);
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
  const status = await syncWith(storeB);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"b\":true}");
  assert.deepEqual(git(remote, ["for-each-ref", "--format=%(refname)"]).split("\n").sort(), ["refs/heads/main", "refs/heads/other", "refs/tags/remote-tag"], "the push changed only main");
  assert.ok(has(storeB, "refs/tags/local-only"), "fetch.pruneTags removed no tag of the store");
  assert.ok(!has(storeB, "refs/tags/remote-tag"), "the sync's fetch takes no tag");
  assert.ok(!(await exists(path.join(storeB, ".git", "objects", "info", "commit-graph"))), "the fetch wrote no commit-graph file");
});

test("a branch the remote deleted goes from the store's remote-tracking refs, so the push check never takes its commits as ones the remote holds", async (context) => {
  const { remote, storeA, storeB } = await stores(context);
  git(storeA, ["push", "-q", "origin", "main:refs/heads/other"]);
  git(storeB, ["fetch", "-q", "origin"]);
  git(storeA, ["push", "-q", "origin", ":refs/heads/other"]);
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
  assert.equal((await syncWith(storeB)).state, "ok");
  assert.ok(!has(storeB, "refs/remotes/origin/other"), "the fetch removed the remote-tracking branch the remote no longer holds");
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"b\":true}");
});

test("a sync whose server inherited pathspec, output redirection, and replace-ref variables still syncs as usual", async (context) => {
  const { remote, storeB } = await stores(context);
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
  const status = await syncWith(storeB, { config: "", variables: { GIT_ICASE_PATHSPECS: "1", GIT_LITERAL_PATHSPECS: "1", GIT_REDIRECT_STDOUT: path.join(environment, "stdout"), GIT_NO_REPLACE_OBJECTS: "0" } });
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"b\":true}");
});

test("the first clone of a remote store names its remote origin whatever clone.defaultRemoteName says, and its first sync pushes", async (context) => {
  const { parent, remote } = await stores(context);
  const projectRoot = path.join(parent, "project");
  await mkdir(projectRoot);
  useManagedStores(projectRoot, path.join(parent, "stores"));
  const file = path.join(environment, "clone.gitconfig");
  await writeFile(file, HOSTILE);
  process.env.GIT_CONFIG_GLOBAL = file;
  let base;
  try {
    base = await managedRecordStore(projectRoot, pathToFileURL(remote).href, (message) => new Error(message));
  } finally {
    process.env.GIT_CONFIG_GLOBAL = plain;
  }
  assert.equal(git(base, ["config", "--get", "remote.origin.url"]), pathToFileURL(remote).href);
  await writeFile(path.join(base, "roadmap.json"), "{\"clone\":true}\n");
  const status = await syncWith(base);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"clone\":true}");
});
