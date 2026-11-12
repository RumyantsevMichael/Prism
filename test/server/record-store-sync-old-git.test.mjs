import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodeTest from "node:test";

// The store sync supports Git from the minimum the user guide states, so its checks hold on a Git that lacks what later releases added.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-old-git-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment, PRISM_REVIEW_APP_DIR: path.join(environment, "app"),
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
const SYNC = new URL("../../dist/server/workflow/record-store-sync.mjs", import.meta.url).href;
const RECORD_STORE = new URL("../../dist/server/workflow/record-store.mjs", import.meta.url).href;
nodeTest.after(() => rm(environment, { recursive: true, force: true }));

const git = (cwd, args, input) => execFileSync("git", ["-C", cwd, ...args], { input, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();

// A git that behaves as an older release: --version reports FAKE_GIT_VERSION when it is set, pack-objects refuses --filter without --stdout as Git up to 2.42 does,
// and index-pack --strict leaves out the .gitattributes checks, which Git before 2.39.1 does not have, the .gitmodules URL check, which Git before 2.30.1 makes of fewer URLs,
// the check of a tree entry name over 4096 bytes, which Git before 2.43 does not have, and any further checks that IGNORE_CHECKS lists, as an older release lacks them.
// It also walks trees of any depth, as Git before 2.43, which has no core.maxTreeDepth, does, whatever limit the sync sets.
// index-pack stops at a check whose name its Git does not know, and a Git that does not know a check lacks it already, so the wrapper leaves out only the checks this machine's Git knows.
// Node finds only an .exe for "git" on Windows, never this bash wrapper, so these tests run only on POSIX.
const POSIX = process.platform !== "win32";
const test = POSIX ? nodeTest : (name) => nodeTest(name, { skip: "the older Git is a bash wrapper on PATH, which Node does not run on Windows" }, () => {});
const realGit = POSIX ? execFileSync("sh", ["-c", "command -v git"]).toString().trim() : "git";
const LEFT_OUT = ["gitattributesLineLength", "gitattributesLarge", "gitattributesMissing", "gitattributesBlob", "gitmodulesUrl", "largePathname"];
const probe = path.join(environment, "probe.git");
if (POSIX) execFileSync(realGit, ["init", "-q", "--bare", probe], { stdio: "pipe" });
const knownChecks = new Map();
// Whether this machine's Git knows a check by name: index-pack reads its --strict list before its input, so an empty input fails on any other ground once every name is known.
function knowsCheck(id) {
  if (!knownChecks.has(id)) knownChecks.set(id, !spawnSync(realGit, ["-C", probe, "index-pack", `--strict=${id}=ignore`, "--stdin"], { input: "", encoding: "utf8" }).stderr.includes("Unhandled message id"));
  return knownChecks.get(id);
}
const leftOut = !POSIX ? "" : LEFT_OUT.filter(knowsCheck).map((id) => `${id}=ignore`).join(",");
const wrapper = path.join(environment, "bin", "git");
await mkdir(path.dirname(wrapper), { recursive: true });
await writeFile(wrapper, `#!/bin/bash
if [[ "$1" == "--version" && -n "$FAKE_GIT_VERSION" ]]; then echo "git version $FAKE_GIT_VERSION"; exit 0; fi
if [[ " $* " == *" pack-objects "* && " $* " == *" --filter="* && " $* " != *" --stdout "* ]]; then echo "fatal: cannot use --filter without --stdout" >&2; exit 128; fi
args=("$@")
for i in "\${!args[@]}"; do [[ "\${args[$i]}" == core.maxTreeDepth=* ]] && args[$i]="core.maxTreeDepth=1000000"; done
if [[ " $* " == *" index-pack "* ]]; then
  ignored=${JSON.stringify(leftOut)}
  [[ -n "$IGNORE_CHECKS" ]] && ignored="\${ignored:+$ignored,}$IGNORE_CHECKS"
  for i in "\${!args[@]}"; do [[ "\${args[$i]}" == "--strict" ]] && args[$i]="--strict\${ignored:+=$ignored}"; done
fi
exec "${realGit}" "\${args[@]}"
`);
await chmod(wrapper, 0o755);
// Further checks a test leaves out, as id=ignore pairs, of which only the ones this machine's Git knows reach index-pack.
const oldGit = (version, ignored) => {
  const known = (ignored ?? "").split(",").filter((pair) => pair && knowsCheck(pair.split("=")[0])).join(",");
  return { ...process.env, PATH: `${path.dirname(wrapper)}:${process.env.PATH}`, ...(version ? { FAKE_GIT_VERSION: version } : {}), ...(known ? { IGNORE_CHECKS: known } : {}) };
};

test("the older Git leaves out every check that this machine's Git knows by name, which on Git 2.43 or later is each of them", () => {
  assert.equal(knowsCheck("prismNoSuchCheck"), false, "a name no Git knows is told apart");
  const [major, minor] = (/(\d+)\.(\d+)/.exec(execFileSync(realGit, ["--version"]).toString()) ?? [0, 0, 0]).slice(1).map(Number);
  if (major > 2 || (major === 2 && minor >= 43)) assert.deepEqual(LEFT_OUT.filter((id) => !knowsCheck(id)), []);
  assert.ok(knowsCheck("gitmodulesUrl") && knowsCheck("duplicateEntries") && knowsCheck("badDate"), "Git from 2.25 knows these checks");
});

// Run a script in a process whose git is the older one, and return what it printed as JSON.
function withOldGit(script, version, ignored) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: oldGit(version, ignored), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
const syncWithOldGit = (store, version, ignored) => withOldGit(`const sync = await import(${JSON.stringify(SYNC)}); sync.configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 }); process.stdout.write(JSON.stringify(await sync.syncRecordStoreNow(${JSON.stringify(store)})));`, version, ignored);

async function stores(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-old-git-")));
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

// Git 2.43 refuses, in every fetch and clone that checks objects, a .gitattributes blob with a line of 2048 bytes or more.
const refusedAttributes = `${"*.md".padEnd(3000, " ")} text\n`;
const checkedClone = (remote, target) => execFileSync("git", ["-c", "transfer.fsckObjects=true", "clone", "-q", `file://${remote}`, target], { stdio: "pipe" });

test("on a Git that packs with a filter only to standard output and lacks the .gitattributes check, a sync still pushes and withholds a .gitattributes that Git 2.43 refuses", async (context) => {
  const { parent, remote, storeB } = await stores(context);
  await writeFile(path.join(storeB, "artifacts", "plans", "slice.md"), "# Slice, by b\n");
  await writeFile(path.join(storeB, ".gitattributes"), refusedAttributes);
  const status = syncWithOldGit(storeB);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.deepEqual(status.withheld.map((entry) => entry.path), [".gitattributes"]);
  assert.match(status.withheld[0].reason, /gitattributesLineLength/);
  assert.equal(git(remote, ["show", "main:artifacts/plans/slice.md"]), "# Slice, by b", "the other change is pushed");
  assert.equal(git(remote, ["ls-tree", "main", ".gitattributes"]), "", "the refused file never reaches the remote");
  checkedClone(remote, path.join(parent, "fresh"));
});

// Commit by hand an entry at a name given as bytes, then a commit that removes it again, so the store's history holds the entry and its tip does not.
function handHistory(store, name, content, mode = "100644") {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(store, ".git", "hand-index") };
  const run = (args, input) => execFileSync("git", ["-C", store, ...args], { input, env, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  const blob = run(["hash-object", "-w", "--no-filters", "--stdin"], content);
  run(["read-tree", "HEAD"]);
  run(["update-index", "-z", "--index-info"], Buffer.concat([Buffer.from(`${mode} ${blob}\t`), Buffer.from(name), Buffer.from([0])]));
  const holding = run(["commit-tree", run(["write-tree"]), "-p", "HEAD", "-m", "by hand"]);
  run(["update-ref", "HEAD", run(["commit-tree", run(["rev-parse", "HEAD^{tree}"]), "-p", holding, "-m", "removed by hand"])]);
  return blob;
}

// A .gitmodules whose git:// URL decodes to a line feed, which Git refuses from 2.30.1 on and older Git takes.
const refusedModules = "[submodule \"x\"]\n\tpath = x\n\turl = git://example.com/%0aevil\n";
const NOT_UTF8 = Buffer.from([0xff]);

// Names that Git 2.43's object check reads as .gitattributes or .gitmodules, given as bytes, with contents that it refuses there; the store holds none of them, since it shares no .gitmodules
// and holds a .gitattributes only as the file at its root, so a sync refuses to push a history that holds one, whatever its Git checks.
const MISNAMED = [
  ["a .gitattributes in another letter case", "notes/.GitAttributes", refusedAttributes],
  ["a Windows short name of .gitattributes", "notes/GITATT~1", refusedAttributes],
  ["a fall-back Windows short name of .gitattributes", "notes/gi7d29~9", refusedAttributes],
  ["a .gitattributes below the root", "notes/.gitattributes", refusedAttributes],
  ["a folder named .gitattributes", "notes/.gitattributes/x.md", "notes\n"],
  ["a folder named .gitattributes at the root", ".gitattributes/x.md", "notes\n"],
  ["a .gitattributes followed by U+FFFE", "notes/.gitattributes\u{FFFE}", refusedAttributes],
  ["a .gitattributes followed by U+FFFF", "notes/.gitattributes\u{FFFF}", refusedAttributes],
  ["a .gitattributes followed by a byte that is not UTF-8", Buffer.concat([Buffer.from("notes/.gitattributes"), NOT_UTF8]), refusedAttributes],
  ["a .gitattributes with a byte that is not UTF-8 after an ignored code point", Buffer.concat([Buffer.from(".git\u200cattributes"), NOT_UTF8]), refusedAttributes],
  ["a .gitattributes followed by a backslash, which Git for Windows reads as a folder separator", "notes/.gitattributes\\", refusedAttributes],
  ["a .gitattributes followed by dots and spaces and a stream name", "notes/.gitattributes. .:stream", refusedAttributes],
  ["a .gitmodules whose git:// URL decodes to a line feed", ".gitmodules", refusedModules],
  ["a .gitmodules in another letter case below the root", "notes/.GitModules", refusedModules],
  ["a Windows short name of .gitmodules", "GITMOD~1", refusedModules],
  ["a .gitmodules followed by U+FFFE", ".gitmodules\u{FFFE}", refusedModules],
  ["a link named .gitattributes at the root", ".gitattributes", "elsewhere", "120000"]
];

for (const [label, name, content, mode] of MISNAMED) {
  test(`on a Git that lacks Git 2.43's checks, a sync refuses to push a history that holds ${label}, and every checked clone still takes the remote`, async (context) => {
    const { parent, remote, storeB } = await stores(context);
    const before = git(remote, ["rev-parse", "main"]);
    handHistory(storeB, name, content, mode);
    await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
    const status = syncWithOldGit(storeB);
    assert.equal(status.state, "merge_failed", JSON.stringify(status));
    assert.ok(status.message.includes("not pushed"), status.message);
    assert.ok(mode ? status.message.includes("gitattributesSymlink") || status.message.includes("reads as .gitattributes or .gitmodules") : status.message.includes("reads as .gitattributes or .gitmodules"), status.message);
    assert.equal(git(remote, ["rev-parse", "main"]), before, "nothing was pushed");
    checkedClone(remote, path.join(parent, "fresh"));
  });
}

// Objects that some Git's checked fetch refuses although an older supported Git takes them, which the sync's own port of Git's checks refuses whatever this machine's Git checks.
// Each hand history ends in a commit that drops the object again, or keeps it at the tip, and the old Git leaves out exactly the check that the release lacks.
const longName = Buffer.from(`notes/${"n".repeat(5000)}.md`);

// Point the store's branch at a commit made by hand on top of HEAD, then, unless kept, at one more that restores HEAD's tree.
function handCommit(store, tree, { kept = false, author } = {}) {
  const head = git(store, ["rev-parse", "HEAD"]);
  const header = `tree ${tree}\nparent ${head}\nauthor ${author ?? "Prism Test <test@example.invalid> 1700000000 +0000"}\ncommitter Prism Test <test@example.invalid> 1700000000 +0000\n\nby hand\n`;
  const holding = git(store, ["hash-object", "--literally", "-t", "commit", "-w", "--stdin"], header);
  git(store, ["update-ref", "HEAD", kept ? holding : git(store, ["commit-tree", git(store, ["rev-parse", "HEAD^{tree}"]), "-p", holding, "-m", "removed by hand"])]);
}

// A tree holding notes/a, notes/a-b, and the folder notes/a, which Git before 2.27 reads as sorted and later Git as a duplicate, since a folder sorts as its name with "/" added.
function fileAndFolderTree(store) {
  const blob = git(store, ["hash-object", "-w", "--no-filters", "--stdin"], "notes\n");
  const inner = git(store, ["mktree"], `100644 blob ${blob}\tx\n`);
  const notes = git(store, ["mktree"], `100644 blob ${blob}\ta\n100644 blob ${blob}\ta-b\n040000 tree ${inner}\ta\n`);
  return git(store, ["mktree"], `${git(store, ["ls-tree", "HEAD"])}\n040000 tree ${notes}\tnotes\n`);
}

function longNameTree(store) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(store, ".git", "hand-index") };
  const run = (args, input) => execFileSync("git", ["-C", store, ...args], { input, env, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  const blob = run(["hash-object", "-w", "--no-filters", "--stdin"], "notes\n");
  run(["read-tree", "HEAD"]);
  run(["update-index", "-z", "--index-info"], Buffer.concat([Buffer.from(`100644 ${blob}\t`), longName, Buffer.from([0])]));
  return run(["write-tree"]);
}

// A tree whose deepest folder sits the given number of folders below the root, as notes/d/d/…/note.md, which Git 2.43 and later walk only to 2048 folders deep.
function deepTree(store, depth) {
  let tree = git(store, ["mktree"], `100644 blob ${git(store, ["hash-object", "-w", "--no-filters", "--stdin"], "deep\n")}\tnote.md\n`);
  for (let level = 1; level < depth; level++) tree = git(store, ["mktree"], `040000 tree ${tree}\td\n`);
  return git(store, ["mktree"], `${git(store, ["ls-tree", "HEAD"])}\n040000 tree ${tree}\tnotes\n`);
}

const STRICTER = [
  ["a folder nested 2049 folders deep in its history, which Git 2.43 refuses to walk", (store) => handCommit(store, deepTree(store, 2049)), "maxTreeDepth", ""],
  ["a tree entry name over 4096 bytes in its history, which Git 2.43 refuses", (store) => handCommit(store, longNameTree(store)), "largePathname", ""],
  ["a tree entry name over 4096 bytes at its tip, which Git 2.43 refuses", (store) => handCommit(store, longNameTree(store), { kept: true }), "largePathname", ""],
  ["a file and a folder of one name that are not adjacent, which Git 2.27 refuses", (store) => handCommit(store, fileAndFolderTree(store)), "duplicateEntries", "duplicateEntries=ignore"],
  ["an author date after a carriage return, which Git 2.40 refuses", (store) => handCommit(store, git(store, ["rev-parse", "HEAD^{tree}"]), { author: "Prism Test <test@example.invalid> \r1700000000 +0000" }), "badDate", "badDate=ignore"]
];

for (const [label, make, reason, ignored] of STRICTER) {
  test(`on a Git that lacks the check, a sync refuses to push a hand commit with ${label}, and every checked clone still takes the remote`, async (context) => {
    const { parent, remote, storeB } = await stores(context);
    const before = git(remote, ["rev-parse", "main"]);
    make(storeB);
    await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
    const status = syncWithOldGit(storeB, undefined, ignored);
    assert.equal(status.state, "merge_failed", JSON.stringify(status).slice(0, 2000));
    assert.ok(status.message.includes("not pushed") && status.message.includes(reason), status.message.slice(0, 2000));
    assert.ok(status.message.length < 4000, "a long name is shown by its first characters only");
    if (reason === "maxTreeDepth") assert.ok(status.message.includes("\"notes/d/d/…\""), status.message);
    assert.equal(git(remote, ["rev-parse", "main"]), before, "nothing was pushed");
    checkedClone(remote, path.join(parent, "fresh"));
  });
}

test("a sync pushes a history whose deepest folder sits exactly 2048 folders deep, which Git 2.43 walks, and refuses one 2049 deep on Git 2.43 itself", async (context) => {
  const { parent, remote, storeA, storeB } = await stores(context);
  handCommit(storeB, deepTree(storeB, 2048));
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
  const pushed = syncWithOldGit(storeB);
  assert.equal(pushed.state, "ok", JSON.stringify(pushed).slice(0, 2000));
  checkedClone(remote, path.join(parent, "fresh"));
  const before = git(remote, ["rev-parse", "main"]);
  handCommit(storeA, deepTree(storeA, 2049));
  await writeFile(path.join(storeA, "roadmap.json"), "{\"a\":true}\n");
  const { syncRecordStoreNow, configureRecordSync } = await import(SYNC);
  configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
  const refused = await syncRecordStoreNow(storeA);
  assert.equal(refused.state, "merge_failed", JSON.stringify(refused).slice(0, 2000));
  assert.ok(refused.message.includes("not pushed") && refused.message.includes("maxTreeDepth"), refused.message);
  assert.equal(git(remote, ["rev-parse", "main"]), before, "nothing was pushed");
});

// Git 2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, 2.44.1, and 2.45.1 refuse a link whose target leads into Git's folder or is longer than 260 bytes, which no other release checks.
for (const [label, target, reason] of [["into Git's folder", "../.git/hooks/post-checkout", "symlinkPointsToGitDir"], ["into Git's folder by a Windows short name", "sub\\GIT~1\\hooks", "symlinkPointsToGitDir"], ["longer than 260 bytes", `${"t".repeat(300)}.md`, "symlinkTargetLength"]]) {
  test(`a sync refuses to push a hand commit whose history holds a link ${label}, which some Git releases refuse, though this Git takes it`, async (context) => {
    const { remote, storeB } = await stores(context);
    const before = git(remote, ["rev-parse", "main"]);
    handHistory(storeB, "notes/link", target, "120000");
    await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
    const status = syncWithOldGit(storeB);
    assert.equal(status.state, "merge_failed", JSON.stringify(status));
    assert.ok(status.message.includes(reason) && status.message.includes("\"notes/link\""), status.message);
    assert.equal(git(remote, ["rev-parse", "main"]), before, "nothing was pushed");
  });
}

test("on a Git that lacks Git 2.43's checks, a store refuses an upstream, a branch tip, and a first clone that holds a .gitmodules or a .gitattributes below the root", async (context) => {
  const { parent, remote, storeA, storeB } = await stores(context);
  const before = git(remote, ["rev-parse", "main"]);
  await mkdir(path.join(storeA, "notes"));
  await writeFile(path.join(storeA, "notes", ".gitattributes"), "* -text\n");
  git(storeA, ["add", "notes"]);
  git(storeA, ["commit", "-q", "-m", "attributes in a folder"]);
  git(storeA, ["push", "-q", "origin", "main"]);
  const upstream = syncWithOldGit(storeB);
  assert.equal(upstream.state, "merge_failed", JSON.stringify(upstream));
  assert.ok(upstream.message.includes("\"notes/.gitattributes\"") && upstream.message.includes(".gitmodules"), upstream.message);
  assert.equal(await readFile(path.join(storeB, "notes", ".gitattributes"), "utf8").catch(() => null), null, "the store was left as it was");
  const root = path.join(parent, "project");
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), `## Workspace\n- Store: file://${remote}\n- Repository: project\n`);
  const clone = withOldGit(`const { recordStoreOf } = await import(${JSON.stringify(RECORD_STORE)}); process.stdout.write(JSON.stringify(await recordStoreOf(${JSON.stringify(root)}).then((store) => ({ base: store.base }), (error) => ({ code: error.code, message: error.message }))));`);
  assert.equal(clone.code, "store_unavailable", JSON.stringify(clone));
  assert.ok(clone.message.includes("\"notes/.gitattributes\""), clone.message);
  git(storeA, ["push", "-q", "-f", "origin", `${before}:main`]);
  git(storeB, ["fetch", "-q", "origin"]);
  git(storeB, ["update-index", "--add", "--cacheinfo", `100644,${git(storeB, ["hash-object", "-w", "--stdin"], "[submodule \"x\"]\n\tpath = x\n\turl = https://example.com/x\n")},.gitmodules`]);
  git(storeB, ["commit", "-q", "-m", "a valid .gitmodules by hand"]);
  const tip = syncWithOldGit(storeB);
  assert.equal(tip.state, "merge_failed", JSON.stringify(tip));
  assert.ok(tip.message.includes("\".gitmodules\"") && tip.message.includes("not pushed"), tip.message);
  assert.equal(git(remote, ["rev-parse", "main"]), before, "nothing was pushed");
  checkedClone(remote, path.join(parent, "fresh"));
});

test("on a Git that lacks the .gitattributes check, a sync refuses to push a .gitattributes below the root whose blob the remote already holds at another path", async (context) => {
  const { parent, remote, storeA, storeB } = await stores(context);
  await mkdir(path.join(storeA, "notes"));
  await writeFile(path.join(storeA, "notes", "long.txt"), refusedAttributes);
  git(storeA, ["add", "notes"]);
  git(storeA, ["commit", "-q", "-m", "a long line in a text file"]);
  git(storeA, ["push", "-q", "origin", "main"]);
  assert.equal(syncWithOldGit(storeB).state, "ok");
  const before = git(remote, ["rev-parse", "main"]);
  git(storeB, ["update-index", "--add", "--cacheinfo", `100644,${git(storeB, ["rev-parse", "HEAD:notes/long.txt"])},notes/.gitattributes`]);
  git(storeB, ["commit", "-q", "-m", "by hand"]);
  const status = syncWithOldGit(storeB);
  assert.equal(status.state, "merge_failed", JSON.stringify(status));
  assert.ok(status.message.includes("\"notes/.gitattributes\"") && status.message.includes("not pushed"), status.message);
  assert.equal(git(remote, ["rev-parse", "main"]), before, "nothing was pushed");
  checkedClone(remote, path.join(parent, "fresh"));
});

test("a Git older than the stated minimum refuses every sync and every store that syncs with store_unavailable naming both versions, and the minimum itself syncs", async (context) => {
  const { parent, storeB } = await stores(context);
  const status = syncWithOldGit(storeB, "2.24.4");
  assert.equal(status.state, "git_failed", JSON.stringify(status));
  assert.ok(status.message.includes("Git 2.24.4") && status.message.includes("Git 2.25 or later"), status.message);
  const resolve = async (name, config) => {
    const root = path.join(parent, name);
    await mkdir(path.join(root, ".prism"), { recursive: true });
    await writeFile(path.join(root, ".prism", "workflow.md"), config);
    return withOldGit(`const { recordStoreOf } = await import(${JSON.stringify(RECORD_STORE)}); process.stdout.write(JSON.stringify(await recordStoreOf(${JSON.stringify(root)}).then((store) => ({ base: store.base }), (error) => ({ code: error.code, message: error.message }))));`, "2.24.4");
  };
  const synced = await resolve("synced", `## Workspace\n- Store: ${storeB}\n- Repository: project\n- Store sync: on\n`);
  assert.equal(synced.code, "store_unavailable", JSON.stringify(synced));
  assert.ok(synced.message.includes("Git 2.24.4") && synced.message.includes("Git 2.25 or later") && synced.message.includes("Store sync"), synced.message);
  const remote = await resolve("remote", `## Workspace\n- Store: file://${path.join(parent, "remote.git")}\n- Repository: project\n`);
  assert.equal(remote.code, "store_unavailable", JSON.stringify(remote));
  assert.ok(remote.message.includes("Git 2.24.4") && remote.message.includes("Git 2.25 or later"), remote.message);
  const unsynced = await resolve("unsynced", `## Workspace\n- Store: ${storeB}\n- Repository: project\n`);
  assert.equal(unsynced.base, storeB, "a path store without sync never runs Git, so any Git serves it");
  assert.equal(syncWithOldGit(storeB, "2.25.0").state, "ok", "the stated minimum syncs");
});

test("the attributes file that a refused .gitattributes left withheld takes the upstream's version once the upstream changes it, saves the local one, and the record still syncs", async (context) => {
  const { remote, storeA, storeB } = await stores(context);
  await writeFile(path.join(storeB, ".gitattributes"), refusedAttributes);
  assert.equal(syncWithOldGit(storeB).state, "ok");
  await writeFile(path.join(storeA, ".gitattributes"), "/artifacts/** -diff\n");
  git(storeA, ["add", ".gitattributes"]);
  git(storeA, ["commit", "-q", "-m", "attributes"]);
  git(storeA, ["push", "-q", "origin", "main"]);
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
  const status = syncWithOldGit(storeB);
  assert.equal(status.state, "conflicts", JSON.stringify(status));
  assert.deepEqual(status.conflicts.map((conflict) => conflict.path), [".gitattributes"]);
  assert.equal(await readFile(path.join(storeB, status.conflicts[0].savedAs), "utf8"), refusedAttributes, "the withheld version is saved");
  assert.equal(await readFile(path.join(storeB, ".gitattributes"), "utf8"), "/artifacts/** -diff\n", "the upstream's version applies");
  assert.equal(git(remote, ["show", "main:roadmap.json"]), "{\"b\":true}", "the record reaches the remote");
});
