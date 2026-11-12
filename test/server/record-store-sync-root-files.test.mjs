import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkout, closeServers, isolateGit, notes, server } from "./fixtures/workspace-artifacts.mjs";

// The README and license files at a store's root take a bound of 1 MiB, and the .gitattributes and .gitignore there one of 64 KiB, as every other kind of store file takes its own:
// a sync refuses an upstream above the bound by name, withholds a local file above it, and line-merges, saves, and names such a file as it does every other.
const environment = await isolateGit();
const { cancelRecordSyncs, configureRecordSync, syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const MiB = 1024 * 1024;
const SLICE = "artifacts/plans/foo/slice.md";
// A README of exactly bytes bytes, in lines of 100 bytes as a person writes one.
const readme = (bytes) => `${"x".repeat(99)}\n`.repeat(Math.ceil(bytes / 100)).slice(0, bytes - 1) + "\n";

async function put(root, files) {
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
}

function push(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  git(root, ["push", "-q", "origin", "main"]);
}

// Two machines' stores cloned from one bare remote that holds a small README and an artifact.
async function stores(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-root-")));
  context.after(async () => { await closeServers(); await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  const remote = path.join(parent, "remote.git");
  git(parent, ["clone", "-q", remote, "a"]);
  const a = path.join(parent, "a");
  git(a, ["checkout", "-q", "-b", "main"]);
  await put(a, { "README.md": "Prism store\n", [SLICE]: "# Foo\n" });
  git(a, ["add", "-A"]);
  git(a, ["commit", "-q", "-m", "init"]);
  git(a, ["push", "-q", "-u", "origin", "main"]);
  git(parent, ["clone", "-q", remote, "b"]);
  const b = path.join(parent, "b");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");
  return { parent, remote, a, b };
}

test("a sync refuses an upstream README above 1 MiB, or a .gitignore above 64 KiB, by name with merge_failed, and leaves the store as it was", { timeout: 240000 }, async (context) => {
  for (const [file, contents] of [["README.md", readme(MiB + 1)], [".gitignore", `${"*.tmp\n".repeat(11000)}`]]) {
    const { a, b } = await stores(context);
    const before = await readFile(path.join(b, file), "utf8").catch(() => null);
    await put(a, { [file]: contents });
    push(a, `a large ${file}`);
    await put(b, { [SLICE]: "# Foo\n\nChanged on b.\n" });
    const status = await syncRecordStoreNow(b);
    assert.equal(status.state, "merge_failed", JSON.stringify(status));
    assert.ok(status.message.includes(file), `the refusal names ${file}: ${status.message}`);
    assert.match(status.message, new RegExp(`above the ${file === "README.md" ? "1 MiB" : "64 KiB"}`), status.message);
    assert.equal(await readFile(path.join(b, file), "utf8").catch(() => null), before, `the ${file} above its bound never reaches this machine's disk`);
    assert.ok(!git(b, ["ls-tree", "HEAD", "--", file]).includes(git(b, ["rev-parse", `@{upstream}:${file}`])), "and the branch does not take it");
  }
});

test("a sync withholds a local README above 1 MiB with a fix that fits, keeps it on disk, and syncs every other change", { timeout: 240000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  const big = readme(MiB + 1);
  await put(b, { "README.md": big, [SLICE]: "# Foo\n\nChanged on b.\n" });
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.deepEqual(status.withheld.map((entry) => entry.path), ["README.md"]);
  assert.match(status.withheld[0].reason, /above the 1 MiB/, status.withheld[0].reason);
  assert.match(status.message, /Make each file above its kind's bound smaller than that bound/, status.message);
  assert.doesNotMatch(status.message, /[Rr]ename|shorter name/, "no fix that would not let the file sync");
  assert.equal(await readFile(path.join(b, "README.md"), "utf8"), big, "the README stays on disk");
  assert.equal(git(remote, ["show", "main:README.md"]), "Prism store", "the remote keeps the README it held");
  assert.match(git(remote, ["show", `main:${SLICE}`]), /Changed on b/, "this machine's other change reaches the remote");
  git(a, ["pull", "-q", "origin", "main"]);
  assert.equal(await readFile(path.join(a, "README.md"), "utf8"), "Prism store\n", "and no other machine gets it");
});

test("a small README that both machines changed line-merges: changes to different lines combine, and a conflict keeps the upstream's version and saves this machine's", { timeout: 120000 }, async (context) => {
  const { remote, a, b } = await stores(context);
  const lines = (first, last) => `${first}\n\nThe store holds the records.\n\n${last}\n`;
  await put(a, { "README.md": lines("Prism store", "Kept by the team.") });
  push(a, "a README");
  assert.equal((await syncRecordStoreNow(b)).state, "ok");

  await put(a, { "README.md": lines("Prism store of the team", "Kept by the team.") });
  push(a, "the first line");
  await put(b, { "README.md": lines("Prism store", "Kept by the team, from b.") });
  const merged = await syncRecordStoreNow(b);
  assert.equal(merged.state, "ok", JSON.stringify(merged));
  const both = lines("Prism store of the team", "Kept by the team, from b.");
  assert.equal(await readFile(path.join(b, "README.md"), "utf8"), both, "both machines' changes combine");
  assert.equal(git(remote, ["show", "main:README.md"]), both.trim());

  git(a, ["pull", "-q", "origin", "main"]);
  await put(a, { "README.md": lines("Prism store of a", "Kept by the team, from b.") });
  push(a, "a conflicting first line");
  await put(b, { "README.md": lines("Prism store of b", "Kept by the team, from b.") });
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "conflicts", JSON.stringify(status));
  const conflict = status.conflicts.find((entry) => entry.path === "README.md");
  assert.ok(conflict?.savedAs, `the README is named with its saved copy: ${JSON.stringify(status.conflicts)}`);
  assert.equal(await readFile(path.join(b, ...conflict.savedAs.split("/")), "utf8"), lines("Prism store of b", "Kept by the team, from b."));
  assert.equal(await readFile(path.join(b, "README.md"), "utf8"), lines("Prism store of a", "Kept by the team, from b."), "the upstream's README stays");
  assert.equal(git(remote, ["show", "main:README.md"]), lines("Prism store of a", "Kept by the team, from b.").trim());
});

// The notes of the next two tool results of a Prism server that uses a store, started after the store's sync.
async function laterNotes(context, store) {
  const parent = path.dirname(store);
  const machine = { parent, storeSetting: `../${path.basename(store)}`, app: path.join(parent, `app-${path.basename(store)}`), sync: "on" };
  const prism = await server(context, machine, await checkout(machine, "api"));
  const said = [notes(await prism.call("get_artifact", {})), notes(await prism.call("get_artifact", {}))];
  await closeServers();
  return said;
}

test("a README line that both machines changed is named as a change of both machines, with this machine's saved copy, and never as a withheld file", { timeout: 200000 }, async (context) => {
  const { a, b } = await stores(context);
  const lines = (first) => `${first}\n\nThe store holds the records.\n`;
  await put(a, { "README.md": lines("Prism store of a") });
  push(a, "the first line on a");
  await put(b, { "README.md": lines("Prism store of b") });
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "conflicts", JSON.stringify(status));
  assert.equal(status.message, "Concurrent changes to store files were resolved; the store keeps the upstream's side, and this machine's versions are saved.");
  const savedAs = status.conflicts.find((conflict) => conflict.path === "README.md")?.savedAs;
  assert.ok(savedAs, JSON.stringify(status.conflicts));
  assert.equal(await readFile(path.join(b, ...savedAs.split("/")), "utf8"), lines("Prism store of b"), "the saved copy holds this machine's README");

  const [first, second] = await laterNotes(context, b);
  assert.match(first, /^Store sync found 1 store file at the store's root, such as its README, that this machine changed while another machine also changed that file; the store keeps the other machine's version, and this machine's copy is saved at the path named below\./m, first);
  assert.ok(first.includes(`- README.md in the record store at ${b} (this machine's copy: ${path.join(b, ...savedAs.split("/"))})`), first);
  assert.doesNotMatch(first, /withheld/, first);
  assert.doesNotMatch(second, /README/, "the saved copy is named once");
});

test("a removal of the README that gives way to another machine's edit is named once as an undone removal", { timeout: 200000 }, async (context) => {
  const { a, b } = await stores(context);
  await put(a, { "README.md": "Prism store of a\n" });
  push(a, "an edit on a");
  await rm(path.join(b, "README.md"));
  const status = await syncRecordStoreNow(b);
  assert.equal(status.state, "conflicts", JSON.stringify(status));
  assert.equal(status.message, "Concurrent changes to store files were resolved; this machine's removal of a file gave way to the upstream's change, so the store holds the upstream's version there again.");
  assert.doesNotMatch(status.message, /versions are saved/, "no copy is named, since this machine's removal saved none");
  assert.equal(await readFile(path.join(b, "README.md"), "utf8"), "Prism store of a\n", "the store holds the other machine's README again");

  const [first, second] = await laterNotes(context, b);
  assert.match(first, /^Store sync undid this machine's removal of 1 store file at the store's root, such as its README, because another machine changed it before this machine's removal reached the store; the store holds it again with the other machine's version\./m, first);
  assert.ok(first.includes(`- README.md in the record store at ${b}`), first);
  assert.doesNotMatch(second, /README/, "the undone removal is named once");
});
