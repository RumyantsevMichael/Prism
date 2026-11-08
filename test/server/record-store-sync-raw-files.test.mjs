import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A store sync uses Git only as an object store, so neither the store's ignore and attributes files, the person's Git settings, nor a file Prism does not write changes what it commits or writes.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-raw-env-")));
const gitconfig = path.join(environment, "gitconfig");
await writeFile(gitconfig, "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment,
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
const { cancelRecordSyncs, configureRecordSync, prepareStoreFiles, syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, args, input) => execFileSync("git", ["-C", cwd, ...args], { input, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const raw = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] });
const exists = (target) => access(target).then(() => true, () => false);
const ok = async (store) => {
  const status = await syncRecordStore(store);
  assert.equal(status.state, "ok", JSON.stringify(status));
  return status;
};

// Two stores cloned from one bare remote that holds a record and an artifact.
async function stores(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-raw-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  git(parent, ["clone", "-q", "remote.git", "a"]);
  const storeA = path.join(parent, "a");
  git(storeA, ["checkout", "-q", "-b", "main"]);
  await mkdir(path.join(storeA, "artifacts", "plans", "bar"), { recursive: true });
  await writeFile(path.join(storeA, "artifacts", "plans", "slice.md"), "# Slice\n");
  await writeFile(path.join(storeA, "artifacts", "plans", "bar", "slice.md"), "# Bar\n");
  await writeFile(path.join(storeA, "roadmap.json"), "{}\n");
  git(storeA, ["add", "."]);
  git(storeA, ["commit", "-q", "-m", "init"]);
  git(storeA, ["push", "-q", "-u", "origin", "main"]);
  git(parent, ["clone", "-q", "remote.git", "b"]);
  return { parent, remote: path.join(parent, "remote.git"), storeA, storeB: path.join(parent, "b") };
}

// The remote branch's tree, path by path, as "mode object".
const remoteTree = (remote) => Object.fromEntries(git(remote, ["ls-tree", "-r", "main"]).split("\n").filter(Boolean).map((line) => [line.split("\t")[1], line.split("\t")[0].split(" ").filter((_, at) => at !== 1).join(" ")]));
const remoteBytes = (remote, file) => raw(remote, ["cat-file", "blob", `main:${file}`]);

// Push from store a a commit on top of the remote's branch whose files are exactly these bytes, built with plumbing so no attribute or ignore rule shapes it.
function pushFiles(storeA, files, message = "teammate") {
  git(storeA, ["fetch", "-q", "origin"]);
  const index = path.join(storeA, ".git", "teammate-index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync("git", ["-C", storeA, "read-tree", "origin/main"], { env });
  for (const [file, contents] of Object.entries(files)) {
    if (contents === null) { execFileSync("git", ["-C", storeA, "update-index", "--force-remove", file], { env }); continue; }
    const object = git(storeA, ["hash-object", "-w", "--no-filters", "--stdin"], contents);
    execFileSync("git", ["-C", storeA, "update-index", "--add", "--cacheinfo", `100644,${object},${file}`], { env });
  }
  const tree = execFileSync("git", ["-C", storeA, "write-tree"], { env }).toString().trim();
  const commit = git(storeA, ["commit-tree", tree, "-p", "origin/main", "-m", message]);
  git(storeA, ["push", "-q", "origin", `${commit}:refs/heads/main`]);
  return commit;
}

test("files Prism does not write that the store's history holds stay as the remote holds them, whatever this machine does to them, and never stop a sync", async (context) => {
  const { remote, storeA, storeB } = await stores(context);
  // An earlier Prism committed every file it did not ignore, so a store's history can hold Finder's files.
  pushFiles(storeA, { ".DS_Store": "finder\n", "artifacts/plans/bar/.DS_Store": "finder\n" }, "an earlier sync");
  await ok(storeB);
  assert.equal(await exists(path.join(storeB, ".DS_Store")), false, "a file Prism does not write is never written to disk");
  // This machine removes one, rewrites the other, and removes the artifact beside it; the remote moves meanwhile.
  await mkdir(path.join(storeB, "artifacts", "plans", "bar"), { recursive: true });
  await writeFile(path.join(storeB, "artifacts", "plans", "bar", ".DS_Store"), "finder rewrote it\n");
  await rm(path.join(storeB, "artifacts", "plans", "bar", "slice.md"));
  pushFiles(storeA, { "artifacts/plans/a.md": "# A\n" });
  await ok(storeB);
  await writeFile(path.join(storeB, "artifacts", "plans", "b.md"), "# B\n");
  await ok(storeB);
  assert.equal(remoteBytes(remote, "artifacts/plans/b.md").toString(), "# B\n");
  assert.equal(remoteBytes(remote, "artifacts/plans/a.md").toString(), "# A\n");
  assert.equal(remoteTree(remote)["artifacts/plans/bar/slice.md"], undefined, "the artifact's removal reached the remote");
  assert.equal(remoteBytes(remote, ".DS_Store").toString(), "finder\n", "no local commit changes or removes a file Prism does not write");
  assert.equal(remoteBytes(remote, "artifacts/plans/bar/.DS_Store").toString(), "finder\n");
  assert.equal(await readFile(path.join(storeB, "artifacts", "plans", "bar", ".DS_Store"), "utf8"), "finder rewrote it\n", "the sync leaves the local file alone");
  // Someone removes one from the remote's branch; every later sync takes that and stays ok.
  pushFiles(storeA, { ".DS_Store": null, "roadmap.json": "{\"later\":true}\n" });
  await ok(storeB);
  assert.equal(await readFile(path.join(storeB, "roadmap.json"), "utf8"), "{\"later\":true}\n");
  assert.equal(git(storeB, ["ls-tree", "HEAD", ".DS_Store"]), "");
  await ok(storeB);
});

for (const diverged of [false, true]) {
  test(`a local commit that holds a file Prism does not write or a link never puts it on the remote${diverged ? " after the remote moved" : ""}`, async (context) => {
    const { parent, remote, storeA, storeB } = await stores(context);
    // A commit that an earlier Prism made, or one made by hand, which never reached the remote.
    await writeFile(path.join(storeB, ".DS_Store"), "finder\n");
    await symlink(path.join(parent, "outside.md"), path.join(storeB, "artifacts", "plans", "link.md"));
    await writeFile(path.join(storeB, "artifacts", "plans", "local.md"), "# Local\n");
    git(storeB, ["add", "-f", ".DS_Store", "artifacts/plans/link.md", "artifacts/plans/local.md"]);
    git(storeB, ["commit", "-q", "-m", "by hand"]);
    if (diverged) pushFiles(storeA, { "artifacts/plans/a.md": "# A\n" });
    await ok(storeB);
    const tree = remoteTree(remote);
    assert.equal(tree[".DS_Store"], undefined);
    assert.equal(tree["artifacts/plans/link.md"], undefined);
    assert.equal(remoteBytes(remote, "artifacts/plans/local.md").toString(), "# Local\n", "the file Prism writes still reaches the remote");
    assert.equal(await readFile(path.join(storeB, ".DS_Store"), "utf8"), "finder\n", "the local file stays on disk");
    git(storeA, ["pull", "-q", "origin", "main"]);
    await ok(storeA);
  });
}

test("an upstream attributes file with lines Prism does not write never changes what a sync hashes or writes, even with a filter the store's configuration requires", async (context) => {
  const { remote, storeA, storeB } = await stores(context);
  // Any of these lines would make git add re-encode, convert, or refuse every file.
  pushFiles(storeA, { ".gitattributes": "* working-tree-encoding=UTF-16\n* text eol=crlf\n* filter=boom\n" });
  git(storeB, ["config", "filter.boom.clean", "false"]);
  git(storeB, ["config", "filter.boom.smudge", "false"]);
  git(storeB, ["config", "filter.boom.required", "true"]);
  await ok(storeB);
  await writeFile(path.join(storeB, "artifacts", "plans", "slice.md"), "# Slice\n\nLocal edit.\n");
  await ok(storeB);
  assert.deepEqual(remoteBytes(remote, "artifacts/plans/slice.md"), Buffer.from("# Slice\n\nLocal edit.\n"), "the local edit reaches the remote with its bytes");
  pushFiles(storeA, { ".gitattributes": "/roadmap.json linguist-generated=true\n", "artifacts/plans/a.md": "# A\r\nCRLF kept\r\n" });
  await ok(storeB);
  assert.deepEqual(await readFile(path.join(storeB, "artifacts", "plans", "a.md")), Buffer.from("# A\r\nCRLF kept\r\n"), "a file is written as its blob's bytes");
});

test("the person's line-ending and excludes settings never change what a sync hashes or commits", async (context) => {
  const { remote, storeB } = await stores(context);
  const excludes = path.join(environment, "excludes");
  await writeFile(excludes, "*.md\ninitiatives/\n");
  await writeFile(gitconfig, `[core]\n\tautocrlf = true\n\tsafecrlf = true\n\texcludesFile = ${excludes.replaceAll("\\", "/")}\n`);
  context.after(() => writeFile(gitconfig, ""));
  await mkdir(path.join(storeB, "initiatives", "reports"), { recursive: true });
  await writeFile(path.join(storeB, "initiatives", "reports", "initiative.json"), "{\r\n}\r\n");
  await writeFile(path.join(storeB, "artifacts", "plans", "crlf.md"), "# CRLF\r\n");
  await ok(storeB);
  assert.deepEqual(remoteBytes(remote, "initiatives/reports/initiative.json"), Buffer.from("{\r\n}\r\n"));
  assert.deepEqual(remoteBytes(remote, "artifacts/plans/crlf.md"), Buffer.from("# CRLF\r\n"));
});

test("an upstream ignore file never keeps a new record or artifact out of a commit", async (context) => {
  const { remote, storeA, storeB } = await stores(context);
  pushFiles(storeA, { ".gitignore": "/initiatives/\n/artifacts/\n*.json\n" });
  await ok(storeB);
  await mkdir(path.join(storeB, "initiatives", "reports"), { recursive: true });
  await writeFile(path.join(storeB, "initiatives", "reports", "initiative.json"), "{}\n");
  await writeFile(path.join(storeB, "artifacts", "plans", "new.md"), "# New\n");
  const status = await ok(storeB);
  assert.equal(status.ahead, 0);
  assert.equal(remoteBytes(remote, "initiatives/reports/initiative.json").toString(), "{}\n");
  assert.equal(remoteBytes(remote, "artifacts/plans/new.md").toString(), "# New\n");
});

test("a file that an earlier first clone checked out with CR LF line endings is no local change, and an upstream change of it still applies", async (context) => {
  const { remote, storeA, storeB } = await stores(context);
  await writeFile(path.join(storeB, "roadmap.json"), "{}\r\n");
  const status = await ok(storeB);
  assert.equal(status.ahead, 0);
  assert.deepEqual(remoteBytes(remote, "roadmap.json"), Buffer.from("{}\n"), "no line-ending change is pushed");
  pushFiles(storeA, { "roadmap.json": "{\"later\":true}\n" });
  await ok(storeB);
  assert.equal(await readFile(path.join(storeB, "roadmap.json"), "utf8"), "{\"later\":true}\n");
});

test("a clone whose files an earlier Prism checked out with CR LF line endings is migrated once, and a later change of line endings alone is pushed", async (context) => {
  const { remote, storeB } = await stores(context);
  // Git's line-ending conversion wrote every text file with CR LF; one file also holds a real local change.
  await writeFile(path.join(storeB, "roadmap.json"), "{}\r\n");
  await writeFile(path.join(storeB, "artifacts", "plans", "slice.md"), "# Slice\r\n");
  await writeFile(path.join(storeB, "artifacts", "plans", "bar", "slice.md"), "# Bar, changed\r\n");
  await prepareStoreFiles(storeB);
  assert.deepEqual(await readFile(path.join(storeB, "roadmap.json")), Buffer.from("{}\n"), "a converted copy gets its blob's bytes again");
  assert.deepEqual(await readFile(path.join(storeB, "artifacts", "plans", "slice.md")), Buffer.from("# Slice\n"));
  assert.deepEqual(await readFile(path.join(storeB, "artifacts", "plans", "bar", "slice.md")), Buffer.from("# Bar, changed\r\n"), "a real change stays as written");
  assert.equal(await exists(path.join(storeB, ".prism-sync", "raw-files.json")), true, "the clone records that it is migrated");
  const status = await ok(storeB);
  assert.equal(status.ahead, 0);
  assert.deepEqual(remoteBytes(remote, "roadmap.json"), Buffer.from("{}\n"), "no converted copy is pushed");
  assert.deepEqual(remoteBytes(remote, "artifacts/plans/bar/slice.md"), Buffer.from("# Bar, changed\r\n"));
  // From now on a file whose only change is its line endings is a change like any other.
  await writeFile(path.join(storeB, "artifacts", "plans", "slice.md"), "# Slice\r\n");
  await ok(storeB);
  assert.deepEqual(remoteBytes(remote, "artifacts/plans/slice.md"), Buffer.from("# Slice\r\n"), "a line-ending change reaches the remote");
});

test("a branch whose remote branch was deleted publishes it again without a link or a file Prism does not write that only its own commits hold", async (context) => {
  const { parent, remote, storeA, storeB } = await stores(context);
  await writeFile(path.join(storeB, ".DS_Store"), "finder\n");
  await symlink(path.join(parent, "outside.md"), path.join(storeB, "artifacts", "plans", "link.md"));
  git(storeB, ["add", "-f", ".DS_Store", "artifacts/plans/link.md"]);
  git(storeB, ["commit", "-q", "-m", "by hand"]);
  git(remote, ["update-ref", "-d", "refs/heads/main"]);
  git(storeB, ["fetch", "-q", "--prune", "origin"]);
  await writeFile(path.join(storeB, "roadmap.json"), "{\"local\":true}\n");
  await ok(storeB);
  const tree = remoteTree(remote);
  assert.equal(tree["artifacts/plans/link.md"], undefined, "no link reaches the remote's branch");
  assert.equal(tree[".DS_Store"], undefined, "no file Prism does not write reaches the remote's branch");
  assert.equal(remoteBytes(remote, "roadmap.json").toString(), "{\"local\":true}\n");
  await ok(storeA);
  assert.equal(await readFile(path.join(storeA, "roadmap.json"), "utf8"), "{\"local\":true}\n", "another machine takes the published branch");
});

// Git 2.43 and later refuse, in every fetch and clone that checks objects, a .gitattributes blob with a line over 2048 bytes, and a pushed object stays in the remote's history for good.
const refusedAttributes = `${"*.md".padEnd(3000, " ")} text\n`;
const checkedClone = (remote, target) => execFileSync("git", ["-c", "transfer.fsckObjects=true", "clone", "-q", `file://${remote}`, target], { stdio: "pipe" });

test("a store file whose object Git's object check refuses is never committed, the sync names it, and every other change still syncs", async (context) => {
  const { parent, remote, storeA, storeB } = await stores(context);
  await writeFile(path.join(storeB, ".gitattributes"), refusedAttributes);
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
  const status = await ok(storeB);
  assert.deepEqual(status.withheld.map((entry) => entry.path), [".gitattributes"]);
  assert.match(status.withheld[0].reason, /gitattributesLineLength/);
  assert.ok(status.message.includes("\".gitattributes\""), status.message);
  assert.equal(remoteBytes(remote, "roadmap.json").toString(), "{\"b\":true}\n", "the other change is pushed");
  assert.equal(remoteTree(remote)[".gitattributes"], undefined, "the refused file never reaches the remote");
  assert.equal(git(storeB, ["rev-list", "--objects", "HEAD"]).includes(git(storeB, ["hash-object", "--no-filters", ".gitattributes"])), false, "no local commit holds it");
  checkedClone(remote, path.join(parent, "fresh"));
  await ok(storeA);
  await writeFile(path.join(storeB, ".gitattributes"), "* -text\n");
  const fixed = await ok(storeB);
  assert.equal(fixed.withheld, undefined);
  assert.equal(remoteBytes(remote, ".gitattributes").toString(), "* -text\n");
});

test("a sync refuses to push a commit made by hand whose objects Git's object check refuses, and names the file", async (context) => {
  const { parent, remote, storeB } = await stores(context);
  const before = git(remote, ["rev-parse", "main"]);
  await writeFile(path.join(storeB, ".gitattributes"), refusedAttributes);
  git(storeB, ["add", ".gitattributes"]);
  git(storeB, ["commit", "-q", "-m", "by hand"]);
  const status = await syncRecordStore(storeB);
  assert.equal(status.state, "merge_failed", JSON.stringify(status));
  assert.ok(status.message.includes("\".gitattributes\"") && status.message.includes("gitattributesLineLength"), status.message);
  assert.equal(git(remote, ["rev-parse", "main"]), before, "nothing was pushed");
  checkedClone(remote, path.join(parent, "fresh"));
});
