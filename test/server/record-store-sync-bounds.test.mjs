import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkout, closeServers, isolateGit, notes, requirementFile, server } from "./fixtures/workspace-artifacts.mjs";

// A file above its kind's bound never passes through Git or memory on this machine, never reaches the remote, and a file that a merge saves is named for the cause it was saved for.
const environment = await isolateGit();
const { cancelRecordSyncs, configureRecordSync, markManagedStore, readSavedConflict, syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 << 26 }).toString().trim();
const MiB = 1024 * 1024;
const SLICE = "artifacts/plans/foo/slice.md";
const rec = (value) => `${JSON.stringify(value)}\n`;

async function put(root, files) {
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, ...file.split("/"));
    if (contents === null) { await rm(target, { force: true }); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

function push(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  git(root, ["push", "-q", "origin", "main"]);
}

// Two machines' stores cloned from one bare remote that holds the initial files.
async function stores(context, initial = {}) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-bounds-")));
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  const remote = path.join(parent, "remote.git");
  git(parent, ["clone", "-q", remote, "a"]);
  const a = path.join(parent, "a");
  git(a, ["checkout", "-q", "-b", "main"]);
  await put(a, { "README.md": "Prism store\n", [SLICE]: "# Foo\n", ...initial });
  git(a, ["add", "-A"]);
  git(a, ["commit", "-q", "-m", "init"]);
  git(a, ["push", "-q", "-u", "origin", "main"]);
  git(parent, ["clone", "-q", remote, "b"]);
  const b = path.join(parent, "b");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  return { parent, remote, a, b };
}

// The largest object the store's Git holds, loose or packed, read from Git's object listing alone.
const largestObject = (root) => Math.max(0, ...git(root, ["cat-file", "--batch-all-objects", "--batch-check=%(objectsize)"]).split("\n").filter(Boolean).map(Number));

// Every file below the store's conflicts folder, by its path below its stamp.
async function savedFiles(root) {
  const found = {};
  const folder = path.join(root, ".prism-sync", "conflicts");
  const visit = async (directory, relative) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), child);
      else found[child.split("/").slice(1).join("/")] = path.join(directory, entry.name);
    }
  };
  await visit(folder, "");
  return found;
}

for (const [file, upstream] of [["README.md", "edit"], ["README.md", "remove"], ["artifacts/plans/foo/other.md", "edit"], ["artifact-comments/plans/foo/slice.md/2026-11-09T10-00-02-000Z-0123abce.json", "remove"]]) {
  test(`a withheld ${file} of 70 MiB that the other machine's sync ${upstream === "edit" ? "edits" : "removes"} is moved aside unread as a saved copy, and every other change syncs`, { timeout: 240000 }, async (context) => {
    const { remote, a, b } = await stores(context, { [file]: file.endsWith(".json") ? rec({ text: "small" }) : "small\n" });
    await put(a, { [file]: upstream === "edit" ? (file.endsWith(".json") ? rec({ text: "edited" }) : "small\nedited\n") : null });
    push(a, upstream);
    await truncate(path.join(b, ...file.split("/")), 70 * MiB);
    const before = await lstat(path.join(b, ...file.split("/")));
    await put(b, { [SLICE]: "# Foo\n\nChanged on b.\n" });
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "conflicts", JSON.stringify(status));
    assert.ok(git(remote, ["show", `main:${SLICE}`]).includes("Changed on b."), "this machine's other change reaches the remote");
    assert.deepEqual(status.conflicts.map((conflict) => conflict.path), [file], "the withheld file is named as a saved copy");
    assert.match(status.message, /this machine's versions are saved/, status.message);
    const saved = (await savedFiles(b))[file];
    assert.ok(saved, "the saved copy sits in the conflicts folder");
    const copy = await lstat(saved);
    assert.equal(copy.size, 70 * MiB, "and holds the whole local file");
    assert.equal(copy.ino, before.ino, "which a rename moved there, so its bytes were never read");
    assert.ok(largestObject(b) < MiB, "and no Git object of this machine holds the file");
    assert.equal(await readFile(path.join(b, ...file.split("/")), "utf8").catch(() => null), upstream === "edit" ? git(a, ["show", `HEAD:${file}`]) + "\n" : null, "the store holds the other machine's version");
    const again = await syncRecordStoreNow(b);
    assert.equal(again.state, "ok", JSON.stringify(again));
  });
}

test("a withheld file of 70 MiB whose path the other machine leaves alone stays where it is, unread, and out of Git", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await put(a, { "artifacts/plans/foo/other.md": "# Other\n" });
  push(a, "other");
  await truncate(path.join(b, "README.md"), 70 * MiB);
  const before = await lstat(path.join(b, "README.md"));
  await put(b, { [SLICE]: "# Foo\n\nChanged on b.\n" });
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.deepEqual(status.withheld.map((entry) => entry.path), ["README.md"]);
  assert.match(status.message, /Every other change synced as usual/, status.message);
  assert.equal((await lstat(path.join(b, "README.md"))).ino, before.ino, "the file stays on disk as it was");
  assert.deepEqual(await savedFiles(b), {}, "and nothing is saved");
  assert.ok(largestObject(b) < MiB, "and no Git object of this machine holds it");
  assert.equal(git(remote, ["show", "main:README.md"]), "Prism store");
});

test("a sync refuses to push a README above 1 MiB that a commit made by hand put on the branch, names it, and syncs again once the commit is taken off as the message says", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  await truncate(path.join(b, "README.md"), 2 * MiB);
  git(b, ["add", "--", "README.md"]);
  git(b, ["commit", "-q", "-m", "by hand"]);
  await put(b, { [SLICE]: "# Foo\n\nChanged on b.\n" });
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "merge_failed", JSON.stringify(status));
  assert.match(status.message, /The store's branch holds "README\.md", which holds 2097152 bytes, above the 1 MiB/, status.message);
  const tip = git(b, ["rev-parse", "@{upstream}"]);
  assert.ok(status.message.includes(`run git reset --soft ${tip} in the store, which keeps every file on disk and moves the branch back to the tip of the remote's branch`), `the message says how to take the commit off: ${status.message}`);
  assert.doesNotMatch(status.message, /Every other change synced/, "and never claims that the other changes synced");
  assert.match(status.message, /committed on this machine only/, status.message);
  assert.equal(git(remote, ["cat-file", "-s", "main:README.md"]), "12", "the remote never takes the file");
  await put(a, { "artifacts/plans/foo/other.md": "# Other\n" });
  push(a, "other");
  git(b, ["reset", "-q", "--soft", tip]);
  const fixed = await syncRecordStoreNow(b);
  assert.equal(fixed.state, "ok", JSON.stringify(fixed));
  assert.deepEqual(fixed.withheld.map((entry) => entry.path), ["README.md"], "the file stays withheld while it is above its bound");
  assert.ok(git(remote, ["show", `main:${SLICE}`]).includes("Changed on b."), "and every other change reaches the remote");
  assert.equal(git(remote, ["cat-file", "-s", "main:README.md"]), "12");
});

test("a sync refuses to push a commit made by hand that the remote lacks and that holds a file above its bound, also when a later commit shrinks it again", { timeout: 240000 }, async (context) => {
  const { remote, b } = await stores(context);
  await truncate(path.join(b, "README.md"), 2 * MiB);
  git(b, ["add", "--", "README.md"]);
  git(b, ["commit", "-q", "-m", "by hand"]);
  await writeFile(path.join(b, "README.md"), "Prism store\n");
  git(b, ["add", "--", "README.md"]);
  git(b, ["commit", "-q", "-m", "by hand again"]);
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "merge_failed", JSON.stringify(status));
  assert.match(status.message, /A commit of the store's branch that the remote does not hold yet holds "README\.md", which holds 2097152 bytes/, status.message);
  assert.ok(status.message.includes(`run git reset --soft ${git(b, ["rev-parse", "@{upstream}"])} in the store`), status.message);
  assert.equal(git(remote, ["rev-list", "--count", "main"]), "1", "the remote takes none of those commits");
});

// A location whose artifact, identity, and status record paths fit the 512-byte store path bound while a comment path below it does not.
const W = "requirements/billing.md";
const LONG = `repositories/${"r".repeat(140)}/components/${"c".repeat(140)}/requirements/${"f".repeat(150)}.md`;
const CNAME = "2026-11-09T10-00-02-000Z-0123abce.json";
const artifact = (location) => ({ [`artifacts/${location}`]: requirementFile("X"), [`artifact-identity/${location}`]: rec({ id: "1".repeat(32) }), [`artifact-status/${location}/status.json`]: rec({ status: "Draft" }) });
const gone = (location) => ({ [`artifacts/${location}`]: null, [`artifact-identity/${location}`]: null, [`artifact-status/${location}/status.json`]: null });
const comment = (text) => rec({ location: W, version: `sha256:${"0".repeat(64)}`, line: 1, text, author: { name: "Ada", host: "vm" }, at: "2026-11-09T10:00:02.000Z", entry: "a".repeat(32), by: { name: "Ada", email: null, checkout: "c" }, via: "review-app" });

for (const mover of ["this machine", "the other machine"]) {
  test(`a comment whose path would be too long where ${mover} moved its artifact is saved and named for that cause, with the artifact's new location, and never as a removal`, { timeout: 240000 }, async (context) => {
    const { parent, a, b } = await stores(context, artifact(W));
    assert.ok(`artifact-comments/${LONG}/${CNAME}`.length > 512 && `artifact-status/${LONG}/status.json`.length <= 512);
    const [commenter, moving] = mover === "this machine" ? [a, b] : [b, a];
    await put(commenter, { [`artifact-comments/${W}/${CNAME}`]: comment("from the commenter") });
    await put(moving, { ...gone(W), ...artifact(LONG) });
    push(a, mover === "this machine" ? "comment" : "move");
    const synced = await syncRecordStoreNow(b);
    assert.equal(synced.state, "conflicts", JSON.stringify(synced));
    assert.deepEqual(synced.conflicts.map((conflict) => [conflict.path, conflict.tooLongAt, Boolean(conflict.theirs)]), [[`artifact-comments/${W}/${CNAME}`, LONG, mover === "this machine"]]);
    assert.doesNotMatch(synced.message, /removal stands|this machine removed/, synced.message);
    assert.ok(synced.message.includes(`${mover === "this machine" ? "the other machine's" : "this machine's"} change to a file of a moved artifact is saved, because its path would hold a name of more than 200 bytes or more than 512 bytes in all`), synced.message);
    assert.ok(synced.message.includes(`at the artifact's new location "artifacts/${LONG}"`), synced.message);
    assert.ok(git(b, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").includes(`artifacts/${LONG}`), "the store keeps the artifact at its new location");
    const machine = { parent, storeSetting: "../b", app: path.join(parent, "app-b"), sync: "on" };
    const prism = await server(context, machine, await checkout(machine, "api"));
    const said = notes(await prism.call("get_artifact", {}));
    await closeServers();
    assert.doesNotMatch(said, /had removed|holds no such artifact/, said);
    assert.match(said, /because its path at the artifact's new location would hold a name of more than 200 bytes/, said);
    assert.ok(said.includes(`${"f".repeat(150)}.md in scope ${"r".repeat(140)}/${"c".repeat(140)}`) || said.includes(`artifacts/${LONG}`), `the note names the artifact's new location: ${said}`);
    assert.ok(said.includes(`a comment on line 1: "from the commenter" (${mover === "this machine" ? "the other machine's" : "this machine's"} version: `), said);
  });
}

test("a saved record copy above its kind's bound, or one that is a link, is named by its size and never read, while a copy within the bound reads as text", async (context) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-saved-read-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const stamp = "2026-11-10T14-22-55-187Z";
  const folder = path.join(base, ".prism-sync", "conflicts", stamp);
  await put(folder, { "roadmap.json": "", "initiatives/a/initiative.json": rec({ title: "saved" }) });
  await truncate(path.join(folder, "roadmap.json"), 70 * MiB);
  await put(base, { "roadmap.json": rec({ current: true }), "initiatives/a/initiative.json": rec({ title: "current" }), "elsewhere.json": rec({ secret: true }) });
  await mkdir(path.join(folder, "initiatives", "b"), { recursive: true });
  await symlink(path.join(base, "elsewhere.json"), path.join(folder, "initiatives", "b", "initiative.json"));
  const over = await readSavedConflict(base, `.prism-sync/conflicts/${stamp}/roadmap.json`);
  assert.deepEqual(over, { path: "roadmap.json", saved: null, current: rec({ current: true }), tooLarge: { saved: 70 * MiB }, bound: MiB });
  const linked = await readSavedConflict(base, `.prism-sync/conflicts/${stamp}/initiatives/b/initiative.json`);
  assert.equal(linked.saved, null, "a link is not followed");
  assert.deepEqual(linked.tooLarge, { saved: null });
  assert.deepEqual(await readSavedConflict(base, `.prism-sync/conflicts/${stamp}/initiatives/a/initiative.json`), { path: "initiatives/a/initiative.json", saved: rec({ title: "saved" }), current: rec({ title: "current" }) });
});

// Comment file names in the form Prism writes, one per millisecond of one second's thousand.
const commentName = (index) => `2026-11-09T10-00-00-${String(index).padStart(3, "0")}Z-${index.toString(16).padStart(8, "0")}.json`;

test("a comment file above its bound that a full comment folder leaves no room for is moved aside unread as a saved comment, and the sync goes on", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  const folder = "artifact-comments/plans/foo/slice.md";
  await put(a, Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`${folder}/${commentName(index)}`, rec({ index })])));
  push(a, "a thousand comments");
  const big = `${folder}/2026-11-09T11-00-00-000Z-0badf00d.json`;
  await put(b, { [big]: "", [SLICE]: "# Foo\n\nChanged on b.\n" });
  await truncate(path.join(b, ...big.split("/")), 70 * MiB);
  const before = await lstat(path.join(b, ...big.split("/")));
  const status = await syncRecordStoreNow(b);
  assert.notEqual(status.state, "merge_failed", JSON.stringify(status));
  assert.ok(git(remote, ["show", `main:${SLICE}`]).includes("Changed on b."), "this machine's other change reaches the remote");
  assert.equal(await lstat(path.join(b, ...big.split("/"))).catch(() => null), null, "the file leaves the full comment folder");
  const saved = (await savedFiles(b))[big];
  assert.ok(saved, "and is saved");
  assert.equal((await lstat(saved)).ino, before.ino, "by a move, so no byte of it was read");
  assert.ok(largestObject(b) < MiB, "and no Git object holds it");
});

test("a store with no commits yet that takes the remote's branch moves a local file above its bound aside unread before the remote's version replaces it", { timeout: 240000 }, async (context) => {
  const { parent, remote } = await stores(context);
  const fresh = path.join(parent, "fresh");
  await mkdir(fresh);
  git(fresh, ["init", "-q", "-b", "main"]);
  git(fresh, ["remote", "add", "origin", remote]);
  await put(fresh, { "README.md": "" });
  await truncate(path.join(fresh, "README.md"), 70 * MiB);
  const before = await lstat(path.join(fresh, "README.md"));
  markManagedStore(fresh);
  const status = await syncRecordStoreNow(fresh);
  assert.equal(status.state, "conflicts", JSON.stringify(status));
  assert.deepEqual(status.conflicts.map((conflict) => conflict.path), ["README.md"]);
  assert.equal(await readFile(path.join(fresh, "README.md"), "utf8"), "Prism store\n", "the store holds the remote's README");
  assert.equal((await lstat((await savedFiles(fresh))["README.md"])).ino, before.ino, "and this machine's is saved by a move, unread");
  assert.ok(largestObject(fresh) < MiB, "and no Git object holds it");
  assert.equal(git(fresh, ["rev-parse", "HEAD"]), git(remote, ["rev-parse", "main"]), "the branch takes the remote's");
});

// A git that makes GROW_FILE GROW_SIZE bytes long the first time a sync hashes the store's files into Git, which comes right after the sync checked each file's size,
// as a file written in place while a sync runs grows between the two.
const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
const GROWING_GIT = `#!/bin/sh
if [ -n "$GROW_FILE" ] && [ ! -e "$GROW_FILE.grown" ]; then
  case " $* " in *" hash-object -w "*) truncate -s "$GROW_SIZE" "$GROW_FILE" && : > "$GROW_FILE.grown" ;; esac
fi
exec "${realGit}" "$@"
`;

// Sync a store with one of its files growing to size bytes right after its size was checked, through that git, which sits beside the store.
async function syncWhileGrowing(root, file, size) {
  const wrapper = path.join(path.dirname(root), "growing-git", "git");
  await mkdir(path.dirname(wrapper), { recursive: true });
  await writeFile(wrapper, GROWING_GIT);
  await chmod(wrapper, 0o755);
  const target = path.join(root, ...file.split("/"));
  const saved = { PATH: process.env.PATH, GROW_FILE: process.env.GROW_FILE, GROW_SIZE: process.env.GROW_SIZE };
  Object.assign(process.env, { PATH: `${path.dirname(wrapper)}:${process.env.PATH}`, GROW_FILE: target, GROW_SIZE: String(size) });
  try { return await syncRecordStoreNow(root); }
  finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    assert.ok(await lstat(`${target}.grown`).then(() => true, () => false), "the file grew during the sync");
    await rm(`${target}.grown`, { force: true });
  }
}

test("a file that grows past its kind's bound after the sync checked its size is withheld by the size of its hashed object, so no commit of the sync holds it and the next sync pushes", { timeout: 240000 }, async (context) => {
  const { remote, b } = await stores(context);
  await put(b, { "README.md": "Prism store, changed\n", [SLICE]: "# Foo\n\nChanged on b.\n" });
  const status = await syncWhileGrowing(b, "README.md", 2 * MiB);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.deepEqual(status.withheld.map((entry) => [entry.path, /holds 2097152 bytes, above the 1 MiB/.test(entry.reason)]), [["README.md", true]], JSON.stringify(status.withheld));
  assert.match(status.message, /Make each file above its kind's bound smaller than that bound/, status.message);
  assert.equal(git(b, ["cat-file", "-s", "HEAD:README.md"]), "12", "the branch keeps the earlier version");
  assert.equal(git(remote, ["cat-file", "-s", "main:README.md"]), "12", "and so does the remote");
  assert.ok(git(remote, ["show", `main:${SLICE}`]).includes("Changed on b."), "while every other change syncs");
  await put(b, { "README.md": "Prism store, smaller\n", [SLICE]: "# Foo\n\nChanged on b again.\n" });
  const later = await syncRecordStoreNow(b);
  assert.equal(later.state, "ok", JSON.stringify(later));
  assert.doesNotMatch(later.message ?? "", /made by hand/, "no refusal names a commit made by hand");
  assert.equal(git(remote, ["show", "main:README.md"]), "Prism store, smaller");
  assert.ok(git(remote, ["show", `main:${SLICE}`]).includes("Changed on b again."));
});

test("a shared comment that grows past a comment's bound after the sync checked its size is withheld for its size, while a full folder keeps every shared comment and the sync ends ok", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  const folder = "artifact-comments/plans/foo/slice.md";
  await put(a, Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`${folder}/${commentName(index)}`, rec({ index })])));
  push(a, "a thousand comments");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  const last = `${folder}/${commentName(999)}`;
  const early = `${folder}/2026-11-09T09-00-00-000Z-0badf00d.json`;
  await put(b, { [early]: rec({ early: true }), [SLICE]: "# Foo\n\nChanged on b.\n" });
  const status = await syncWhileGrowing(b, last, 70 * 1024);
  assert.equal(status.state, "ok", JSON.stringify(status));
  const reasons = Object.fromEntries((status.withheld ?? []).map((entry) => [entry.path, entry.reason]));
  assert.deepEqual(Object.keys(reasons).sort(), [early, last].sort(), JSON.stringify(status.withheld));
  assert.match(reasons[last], /holds 71680 bytes, above the 64 KiB/, reasons[last]);
  assert.match(reasons[early], /its comment folder holds more than 1000 comment files/, reasons[early]);
  assert.match(status.message, /Make each file above its kind's bound smaller/, status.message);
  assert.equal(git(b, ["cat-file", "-s", `HEAD:${last}`]), String(rec({ index: 999 }).length), "the branch keeps the shared comment's earlier version");
  assert.equal(git(remote, ["ls-tree", "--name-only", "main", `${folder}/`]).split("\n").length, 1000);
  assert.ok(git(remote, ["show", `main:${SLICE}`]).includes("Changed on b."));
});

test("a local comment whose name sorts before the 1000 that its folder already shares is withheld, while every shared comment stays and the push goes through", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  const folder = "artifact-comments/plans/foo/slice.md";
  const shared = Array.from({ length: 1000 }, (_, index) => `${folder}/${commentName(index)}`);
  await put(a, Object.fromEntries(shared.map((file, index) => [file, rec({ index })])));
  push(a, "a thousand comments");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  const early = `${folder}/2026-11-09T09-00-00-000Z-0badf00d.json`;
  await put(b, { [early]: rec({ early: true }), [SLICE]: "# Foo\n\nChanged on b.\n" });
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.deepEqual((status.withheld ?? []).map((entry) => entry.path), [early]);
  assert.match(status.message, /Move each comment file that the sync did not commit out of its comment folder/, status.message);
  assert.doesNotMatch(status.message, /made by hand/, status.message);
  for (const tree of [git(b, ["ls-tree", "-r", "--name-only", "HEAD", `${folder}/`]), git(remote, ["ls-tree", "-r", "--name-only", "main", `${folder}/`])]) {
    assert.deepEqual(tree.split("\n"), shared, "every shared comment stays, and the early one is not committed");
  }
  assert.ok(git(remote, ["show", `main:${SLICE}`]).includes("Changed on b."), "and the other change reaches the remote");
  assert.ok(await lstat(path.join(b, ...early.split("/"))), "the withheld comment stays on disk");
});

for (const how of ["a clone of an empty remote", "a store whose remote was added by hand"]) {
  for (const first of [true, false]) {
    test(`on the first publish of ${how}, a refusal of a hand commit ${first ? "that is the branch's first" : "after another commit"} that holds a README above 1 MiB names a command that runs, after which the next sync pushes the other changes`, { timeout: 240000 }, async (context) => {
      const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-bounds-")));
      context.after(() => rm(parent, { recursive: true, force: true }));
      git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
      const remote = path.join(parent, "remote.git");
      const b = path.join(parent, "b");
      if (how.startsWith("a clone")) git(parent, ["clone", "-q", remote, "b"]);
      else { await mkdir(b); git(b, ["init", "-q", "-b", "main"]); git(b, ["remote", "add", "origin", remote]); }
      if (!first) { await put(b, { "README.md": "Prism store\n" }); git(b, ["add", "-A"]); git(b, ["commit", "-q", "-m", "first"]); }
      await put(b, { "README.md": "" });
      await truncate(path.join(b, "README.md"), 2 * MiB);
      git(b, ["add", "-A"]);
      git(b, ["commit", "-q", "-m", "by hand"]);
      await put(b, { [SLICE]: "# Foo\n" });
      markManagedStore(b);
      const status = await syncRecordStoreNow(b);
      assert.equal(status.state, "merge_failed", JSON.stringify(status));
      const command = status.message.match(/run (git (?:reset --soft [0-9a-f]{40,64}|update-ref -d HEAD)) in the store/)?.[1];
      assert.equal(command, first ? "git update-ref -d HEAD" : `git reset --soft ${git(b, ["rev-parse", "HEAD~2"])}`, status.message);
      git(b, command.split(" ").slice(1));
      const next = await syncRecordStoreNow(b);
      assert.equal(next.state, "ok", JSON.stringify(next));
      assert.deepEqual(next.withheld.map((entry) => entry.path), ["README.md"]);
      assert.equal(git(remote, ["show", `main:${SLICE}`]), "# Foo");
      assert.equal(git(remote, ["ls-tree", "--name-only", "main", "README.md"]), first ? "" : "README.md");
      if (!first) assert.equal(git(remote, ["show", "main:README.md"]), "Prism store");
    });
  }
}

test("a refusal of a hand commit names the parent of the first commit the remote lacks that holds the file, when the remote branch has no tip that the store tracks", { timeout: 240000 }, async (context) => {
  const { remote, b } = await stores(context);
  git(b, ["branch", "--unset-upstream"]);
  git(b, ["update-ref", "-d", "refs/remotes/origin/main"]);
  git(remote, ["branch", "-m", "main", "old"]);
  const before = git(b, ["rev-parse", "HEAD"]);
  await truncate(path.join(b, "README.md"), 2 * MiB);
  git(b, ["add", "--", "README.md"]);
  git(b, ["commit", "-q", "-m", "by hand"]);
  markManagedStore(b);
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "merge_failed", JSON.stringify(status));
  assert.ok(status.message.includes(`run git reset --soft ${before} in the store, which keeps every file on disk and moves the branch back to the commit before the first commit of it that the remote lacks and that holds the file`), status.message);
});

// The notes of the next tool result of a Prism server of this machine, which uses the store at b.
async function nextNotes(context, parent) {
  const machine = { parent, storeSetting: "../b", app: path.join(parent, "app-b"), sync: "on" };
  const prism = await server(context, machine, await checkout(machine, "api"));
  const said = notes(await prism.call("get_artifact", {}));
  await closeServers();
  return said;
}

test("an artifact above its bound that this machine held back and the other machine then changed is named for that cause in the next tool result, not as a change of the same lines", { timeout: 240000 }, async (context) => {
  const file = "artifacts/plans/foo/other.md";
  const { parent, a, b } = await stores(context, { [file]: "small\n" });
  await put(a, { [file]: "small\nedited\n" });
  push(a, "edit");
  await truncate(path.join(b, ...file.split("/")), 70 * MiB);
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "conflicts", JSON.stringify(status));
  const savedAs = (await savedFiles(b))[file];
  assert.ok(savedAs, "this machine's file is saved");
  const said = await nextNotes(context, parent);
  assert.doesNotMatch(said, /changed the same lines/, said);
  assert.match(said, /Store sync saved 1 file of this machine's that was above the bound that a store file of its kind may hold, so this machine's sync held it back from the store, and that another machine then changed or removed; the store keeps the other machine's version, and this machine's copy is saved at the path named below\./, said);
  assert.ok(said.includes(`other.md`) && said.includes(`(this machine's copy: ${savedAs})`), said);
});

test("a status record saved beside an artifact above 2 GiB, which no whole read takes, is named as a record of an artifact that the store still holds", { timeout: 240000 }, async (context) => {
  const location = "plans/foo/other.md";
  const record = `artifact-status/${location}/status.json`;
  const { parent, a, b } = await stores(context, { [`artifacts/${location}`]: "small\n", [record]: rec({ status: "Draft" }) });
  await put(a, { [record]: rec({ status: "Approved on a" }) });
  push(a, "status on a");
  await put(b, { [record]: rec({ status: "Approved on b" }) });
  // A sparse file, so it takes no disk space, of more bytes than a whole read in Node may take.
  await truncate(path.join(b, "artifacts", ...location.split("/")), 3 * 1024 * MiB);
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "conflicts", JSON.stringify(status));
  assert.deepEqual(status.conflicts.map((conflict) => conflict.path), [record]);
  const said = await nextNotes(context, parent);
  assert.match(said, /Store sync found 1 status record of an artifact that this machine changed while another machine changed the same record/, said);
  assert.doesNotMatch(said, /no longer holds the artifact/, said);
});
