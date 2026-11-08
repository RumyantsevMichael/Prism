import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
// Whether a path is stored on disk in exactly this spelling, as folder listings show it, which a file system that ignores letter case tells apart only that way.
async function stored(base, ...names) {
  let folder = base;
  for (const name of names) {
    if (!(await readdir(folder).catch(() => [])).includes(name)) return false;
    folder = path.join(folder, name);
  }
  return true;
}

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

// Push from store a a commit on top of the remote's branch that adds a file at the path that names lists, part by part, built with mktree as a teammate could;
// mode makes the entry a symbolic link (120000), whose contents are its target, or a submodule link (160000) to a commit the store does not hold.
function pushCrafted(storeA, names, contents = "crafted\n", mode = "100644") {
  git(storeA, ["fetch", "-q", "origin"]);
  const leaf = mode === "160000" ? `160000 commit ${"1".repeat(40)}` : `${mode} blob ${git(storeA, ["hash-object", "-w", "--stdin"], contents)}`;
  let entry = `${leaf}\t${names.at(-1)}`;
  for (const name of names.slice(0, -1).reverse()) entry = `040000 tree ${git(storeA, ["mktree", "--missing"], `${entry}\n`)}\t${name}`;
  const top = names[0];
  const kept = git(storeA, ["ls-tree", "origin/main^{tree}"]).split("\n").filter((line) => line && line.split("\t")[1] !== top);
  const tree = git(storeA, ["mktree", "--missing"], `${[...kept, entry].join("\n")}\n`);
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
  { label: "the sync folder with a trailing space", names: [".PRISM-SYNC ", "planted"], target: (store) => path.join(store, ".PRISM-SYNC ", "planted") },
  // HFS+ ignores a zero-width non-joiner in a name, and Windows gives a long name a short 8.3 one, so each of these is the sync folder on some machine.
  { label: "the sync folder with an invisible character that HFS+ ignores", names: [".prism\u200c-sync", "conflicts", "planted.md"], target: (store) => path.join(store, ".prism\u200c-sync", "conflicts", "planted.md") },
  { label: "the sync folder's 8.3 short name", names: ["PRISM-~1", "status.json"], target: (store) => path.join(store, "PRISM-~1", "status.json") },
  { label: "a symbolic link", names: ["artifacts", "plans", "link.md"], contents: "../../../escape.md", mode: "120000", target: (store) => path.join(store, "artifacts", "plans", "link.md") },
  { label: "a submodule link", names: ["artifacts", "plans", "sub"], mode: "160000", target: (store) => path.join(store, "artifacts", "plans", "sub") },
  // An entry where Prism keeps a folder, or below a file it keeps, would clash with Prism's own files on every machine.
  { label: "a file where Prism keeps a slice's folders", names: ["initiatives", "reports", "slices"], target: (store) => path.join(store, "initiatives", "reports", "slices") },
  { label: "a file below the roadmap record's path", names: ["roadmap.json", "x"], target: (store) => path.join(store, "roadmap.json", "x") },
  // Git for Windows refuses each of these in its index, even for an entry no sync writes to disk, so a Windows machine could never take or build a tree that holds one.
  { label: "a Windows device name", names: ["notes", "aux.md"], target: (store) => path.join(store, "notes", "aux.md") },
  { label: "a Windows device name with spaces before its extension", names: ["repositories", "con .json"], target: (store) => path.join(store, "repositories", "con .json") },
  { label: "a Windows device name as a folder", names: ["notes", "LPT1", "x.md"], target: (store) => path.join(store, "notes", "LPT1", "x.md") },
  { label: "a name ending in a dot", names: ["artifacts", "plans", "end."], target: (store) => path.join(store, "artifacts", "plans", "end.") },
  { label: "a name ending in a space", names: ["notes", "trailing "], target: (store) => path.join(store, "notes", "trailing ") },
  { label: "a character Windows refuses", names: ["notes", "what?.md"], target: (store) => path.join(store, "notes", "what?.md") },
  { label: "a control character", names: ["notes", "bell\u0007.md"], target: (store) => path.join(store, "notes", "bell\u0007.md") },
  // A name of a file Prism shares is written through a temporary file about 30 bytes longer, so one over 200 bytes is too long for some machine to write.
  { label: "an artifact name too long for some machine to write", names: ["artifacts", "plans", `${"n".repeat(230)}.md`], target: (store) => path.join(store, "artifacts", "plans", `${"n".repeat(230)}.md`) }
];

// Regular files at safe paths that Prism does not write, as an earlier Prism or a Git host may have left them: a sync carries them in Git and never writes them.
const CARRIED = [
  { label: "a lock file beside a record", names: ["initiatives", "reports", "initiative.json.lock"] },
  { label: "a file Prism does not write at the store root", names: ["notes.md"] },
  { label: "a README in another letter case", names: ["readme.md"] },
  { label: "a README below the store root", names: ["initiatives", "README.md"] },
  { label: "an artifact name outside the artifact name form", names: ["artifacts", "plans", ".hidden.md"] },
  { label: "Finder's file in an artifact folder", names: ["artifacts", "plans", ".DS_Store"] }
];

for (const { label, names, target, contents, mode } of CRAFTED) {
  for (const diverged of [false, true]) {
    test(`a sync refuses an upstream path with ${label}${diverged ? " after a local change" : ""}, and writes and removes nothing`, async (context) => {
      const { storeA, storeB } = await stores(context);
      if (diverged) await writeFile(path.join(storeB, "artifacts", "plans", "local.md"), "# Local\n");
      const crafted = pushCrafted(storeA, names, contents, mode);
      // Store b already holds the crafted objects, as after any fetch without checks, so the sync's own path check is what refuses them.
      git(storeB, ["fetch", "-q", "origin"]);
      const status = await syncRecordStore(storeB);
      assert.equal(status.state, "merge_failed", JSON.stringify(status));
      assert.match(status.message, /which no store may hold/);
      assert.ok(status.message.includes(JSON.stringify(names.join("/"))), "the refusal names the path");
      assert.equal(await exists(target(storeB)), false, "nothing is written through the crafted path");
      assert.equal(isAncestor(storeB, crafted), false, "the branch stays where it was");
      assert.equal(git(storeB, ["status", "--porcelain", "--", ".", ":(exclude).prism-sync"]), "", "the store's files match its branch");
      assert.equal(await exists(path.join(storeB, "artifacts", "plans", "slice.md")), true);
      if (diverged) assert.equal(await exists(path.join(storeB, "artifacts", "plans", "local.md")), true, "the local change stays");
    });
  }
}

for (const { label, names } of CARRIED) {
  for (const diverged of [false, true]) {
    test(`a sync takes an upstream that adds ${label}${diverged ? " after a local change" : ""}, keeps it in Git only, and never changes it`, async (context) => {
      const { storeA, storeB } = await stores(context);
      const file = names.join("/");
      if (diverged) await writeFile(path.join(storeB, "artifacts", "plans", "local.md"), "# Local\n");
      const crafted = pushCrafted(storeA, names);
      const status = await syncRecordStore(storeB);
      assert.equal(status.state, "ok", JSON.stringify(status));
      assert.equal(isAncestor(storeB, crafted), true, "the branch takes the upstream");
      assert.equal(await exists(path.join(storeB, ...names)), false, "the file is not written to disk");
      assert.equal(git(storeB, ["rev-parse", `HEAD:${file}`]), git(storeB, ["rev-parse", `${crafted}:${file}`]), "the branch holds the upstream's entry");
      if (diverged) assert.equal(git(storeB, ["show", "origin/main:artifacts/plans/local.md"]), "# Local");
      await writeFile(path.join(storeB, "roadmap.json"), "{\"later\":true}\n");
      assert.equal((await syncRecordStore(storeB)).state, "ok");
      assert.equal(git(storeB, ["show", "origin/main:roadmap.json"]), "{\"later\":true}");
      assert.equal(git(storeB, ["show", `origin/main:${file}`]), "crafted", "a later local commit leaves it as the remote holds it");
    });
  }
}

test("a sync takes an executable license file that the upstream adds and writes its bytes", async (context) => {
  const { storeA, storeB } = await stores(context);
  pushCrafted(storeA, ["LICENSE"], "Licensed\n", "100755");
  assert.equal((await syncRecordStore(storeB)).state, "ok");
  assert.equal(await readFile(path.join(storeB, "LICENSE"), "utf8"), "Licensed\n");
  assert.equal(git(storeB, ["ls-tree", "HEAD", "LICENSE"]).split(" ")[0], "100755");
});

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

test("a sync takes a README and a license that the upstream adds at the store root, as plain files", async (context) => {
  const { storeA, storeB } = await stores(context);
  await writeFile(path.join(storeB, "artifacts", "plans", "local.md"), "# Local\n");
  for (const name of ["README.md", "LICENSE", "COPYING"]) pushCrafted(storeA, [name], `${name}\n`);
  const status = await syncRecordStore(storeB);
  assert.equal(status.state, "ok", JSON.stringify(status));
  for (const name of ["README.md", "LICENSE", "COPYING"]) assert.equal(await readFile(path.join(storeB, name), "utf8"), `${name}\n`);
  assert.equal(git(storeB, ["show", "origin/main:artifacts/plans/local.md"]), "# Local");
});

test("a sync with fetch checks on still takes an ordinary upstream change", async (context) => {
  const { storeA, storeB } = await stores(context);
  await writeFile(path.join(storeA, "artifacts", "plans", "slice.md"), "# Slice\n\nMore.\n");
  git(storeA, ["commit", "-q", "-am", "edit"]);
  git(storeA, ["push", "-q", "origin", "main"]);
  assert.equal((await syncRecordStore(storeB)).state, "ok");
  assert.equal(git(storeB, ["show", "HEAD:artifacts/plans/slice.md"]), "# Slice\n\nMore.");
});

// A store that an earlier Prism synced may hold a submodule link from the remote, which Git checks out as an empty folder.
async function storeWithSubmoduleLink(context) {
  const place = await stores(context);
  const crafted = pushCrafted(place.storeA, ["artifacts", "plans", "sub"], undefined, "160000");
  git(place.storeB, ["fetch", "-q", "origin"]);
  git(place.storeB, ["reset", "-q", "--hard", crafted]);
  git(place.storeA, ["fetch", "-q", "origin"]);
  git(place.storeA, ["reset", "-q", "--hard", crafted]);
  assert.equal(git(place.storeB, ["ls-tree", "HEAD", "artifacts/plans/sub"]).split(" ")[0], "160000");
  return place;
}

async function pushTree(storeA, change, message) {
  git(storeA, ["fetch", "-q", "origin"]);
  git(storeA, ["reset", "-q", "--hard", "origin/main"]);
  await change();
  git(storeA, ["commit", "-q", "-m", message]);
  git(storeA, ["push", "-q", "origin", "main"]);
}

for (const diverged of [false, true]) {
  test(`a store that already holds a submodule link refuses each upstream that still holds one, and syncs once the upstream drops it${diverged ? " after a local change" : ""}`, async (context) => {
    const { storeA, storeB } = await storeWithSubmoduleLink(context);
    const local = async (text) => { if (diverged) await writeFile(path.join(storeB, "artifacts", "plans", "slice.md"), text); };
    await local("# Slice\n\nLocal one.\n");
    await pushTree(storeA, async () => { await writeFile(path.join(storeA, "roadmap.json"), "{\"a\":1}\n"); git(storeA, ["add", "roadmap.json"]); }, "ordinary change");
    // A link is unsafe on any machine, so an upstream that holds one is refused as a whole, even when this store took it before, and nothing changes.
    const held = await syncRecordStore(storeB);
    assert.equal(held.state, "merge_failed", JSON.stringify(held));
    assert.ok(held.message.includes("a submodule link at \"artifacts/plans/sub\""), held.message);
    assert.equal(await readFile(path.join(storeB, "roadmap.json"), "utf8"), "{}\n");
    await local("# Slice\n\nLocal two.\n");
    await pushTree(storeA, () => git(storeA, ["update-index", "--cacheinfo", `160000,${"2".repeat(40)},artifacts/plans/sub`]), "move the link");
    assert.equal((await syncRecordStore(storeB)).state, "merge_failed");
    // The upstream replaces the link with a folder of artifacts: the empty folder the link left takes the files.
    await pushTree(storeA, () => {
      git(storeA, ["rm", "-q", "--cached", "artifacts/plans/sub"]);
      execFileSync("sh", ["-c", "mkdir -p artifacts/plans/sub && printf '# In\\n' > artifacts/plans/sub/in.md"], { cwd: storeA });
      git(storeA, ["add", "artifacts/plans/sub/in.md"]);
    }, "replace the link with a folder");
    const replaced = await syncRecordStore(storeB);
    assert.equal(replaced.state, "ok", JSON.stringify(replaced));
    assert.equal(git(storeB, ["show", "HEAD:artifacts/plans/sub/in.md"]), "# In");
    assert.equal(await exists(path.join(storeB, "artifacts", "plans", "sub", "in.md")), true);
    assert.equal(await readFile(path.join(storeB, "roadmap.json"), "utf8"), "{\"a\":1}\n");
    if (diverged) assert.equal(git(storeB, ["show", "origin/main:artifacts/plans/slice.md"]), "# Slice\n\nLocal two.");
  });
}

test("an upstream removal of a submodule link the store holds removes its empty folder and syncs", async (context) => {
  const { storeA, storeB } = await storeWithSubmoduleLink(context);
  await pushTree(storeA, () => git(storeA, ["rm", "-q", "--cached", "artifacts/plans/sub"]), "remove the link");
  const status = await syncRecordStore(storeB);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(await exists(path.join(storeB, "artifacts", "plans", "sub")), false);
  await pushTree(storeA, async () => { await writeFile(path.join(storeA, "roadmap.json"), "{\"b\":2}\n"); git(storeA, ["add", "roadmap.json"]); }, "ordinary change");
  assert.equal((await syncRecordStore(storeB)).state, "ok");
});

test("a sync never shares a file Prism does not write or a link, so no other machine's sync refuses this machine's commit", async (context) => {
  const { parent, storeA, storeB } = await stores(context);
  await writeFile(path.join(storeB, "notes.md"), "# Mine\n");
  await mkdir(path.join(storeB, "PRISM-~1"));
  await writeFile(path.join(storeB, "PRISM-~1", "status.json"), "{}\n");
  await symlink(path.join(parent, "outside.md"), path.join(storeB, "artifacts", "plans", "link.md"));
  await writeFile(path.join(storeB, "artifacts", "plans", "kept.md"), "# Kept\n");
  assert.equal((await syncRecordStore(storeB)).state, "ok");
  const shared = git(storeB, ["ls-tree", "-r", "--name-only", "origin/main"]).split("\n");
  assert.deepEqual(shared.sort(), ["artifacts/plans/kept.md", "artifacts/plans/slice.md", "roadmap.json"]);
  assert.equal(await exists(path.join(storeB, "notes.md")), true, "the file stays on disk");
  git(storeA, ["pull", "-q", "origin", "main"]);
  assert.equal((await syncRecordStore(storeA)).state, "ok");
});

// macOS and Windows read two paths that differ only in letter case as one file or folder, so no machine there could hold both.
for (const [label, names, pair] of [
  ["a file", ["Roadmap.json"], ["Roadmap.json", "roadmap.json"]],
  ["a folder", ["Artifacts", "notes.md"], ["Artifacts", "artifacts"]]
]) {
  test(`a sync refuses an upstream that holds ${label} whose path differs from another only in letter case, and the branch stays`, async (context) => {
    const { storeA, storeB } = await stores(context);
    const crafted = pushCrafted(storeA, names);
    const status = await syncRecordStore(storeB);
    assert.equal(status.state, "merge_failed", JSON.stringify(status));
    for (const place of pair) assert.ok(status.message.includes(JSON.stringify(place)), status.message);
    assert.equal(isAncestor(storeB, crafted), false, "the branch stays where it was");
    assert.equal(await stored(storeB, ...names), false);
  });
}

test("two machines that write artifacts whose paths differ only in letter case keep the first push's and save the other", async (context) => {
  const { storeA, storeB } = await stores(context);
  await writeFile(path.join(storeB, "artifacts", "plans", "Notes.md"), "# Notes from b\n");
  pushCrafted(storeA, ["artifacts", "plans", "notes.md"], "# Notes from a\n");
  const status = await syncRecordStore(storeB);
  assert.equal(status.state, "conflicts", JSON.stringify(status));
  assert.deepEqual(status.conflicts.map((conflict) => conflict.path), ["artifacts/plans/Notes.md"]);
  assert.equal(await readFile(path.join(storeB, status.conflicts[0].savedAs), "utf8"), "# Notes from b\n", "the local file is saved");
  const tree = git(storeB, ["ls-tree", "-r", "--name-only", "origin/main"]).split("\n");
  assert.ok(tree.includes("artifacts/plans/notes.md") && !tree.includes("artifacts/plans/Notes.md"), tree.join(", "));
  assert.equal(await readFile(path.join(storeB, "artifacts", "plans", "notes.md"), "utf8"), "# Notes from a\n");
  assert.equal(await stored(storeB, "artifacts", "plans", "Notes.md"), false);
  assert.equal((await syncRecordStore(storeA)).state, "ok", "the other machine takes the result");
});

test("a branch that took an unportable upstream entry by hand pushes nothing until the remote drops it", async (context) => {
  const { storeA, storeB } = await stores(context);
  const crafted = pushCrafted(storeA, ["notes", "aux.md"]);
  // A person pulls the upstream by hand on a machine whose Git accepts the name.
  git(storeB, ["pull", "-q", "origin", "main"]);
  await writeFile(path.join(storeB, "roadmap.json"), "{\"local\":true}\n");
  const refused = await syncRecordStore(storeB);
  assert.equal(refused.state, "merge_failed", JSON.stringify(refused));
  assert.ok(refused.message.includes("\"notes/aux.md\""), refused.message);
  assert.equal(git(storeA, ["ls-remote", "origin", "main"]).split("\t")[0], crafted, "nothing was pushed");
  git(storeA, ["fetch", "-q", "origin"]);
  git(storeA, ["reset", "-q", "--hard", "origin/main"]);
  git(storeA, ["rm", "-q", "notes/aux.md"]);
  git(storeA, ["commit", "-q", "-m", "drop it"]);
  git(storeA, ["push", "-q", "origin", "main"]);
  const status = await syncRecordStore(storeB);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(git(storeB, ["show", "origin/main:roadmap.json"]), "{\"local\":true}");
});

test("a file Prism shares whose name is too long for some machine to write is never committed, the sync names it, and every other change still syncs", async (context) => {
  const { storeA, storeB } = await stores(context);
  const long = `${"n".repeat(230)}.md`;
  await writeFile(path.join(storeB, "artifacts", "plans", long), "# Long\n");
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
  const status = await syncRecordStore(storeB);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.deepEqual(status.withheld.map((entry) => entry.path), [`artifacts/plans/${long}`]);
  assert.ok(status.message.includes(JSON.stringify(`artifacts/plans/${long}`)), status.message);
  assert.equal(git(storeB, ["show", "origin/main:roadmap.json"]), "{\"b\":true}", "the other change is pushed");
  assert.ok(!git(storeB, ["ls-tree", "-r", "--name-only", "origin/main"]).includes(long), "the long name never reaches the remote");
  assert.equal(await exists(path.join(storeB, "artifacts", "plans", long)), true, "the file stays on disk");
  git(storeA, ["pull", "-q", "origin", "main"]);
  assert.equal((await syncRecordStore(storeA)).state, "ok", "the other machine takes the push");
  await rm(path.join(storeB, "artifacts", "plans", long));
  await writeFile(path.join(storeB, "artifacts", "plans", "short.md"), "# Long\n");
  const renamed = await syncRecordStore(storeB);
  assert.equal(renamed.state, "ok", JSON.stringify(renamed));
  assert.equal(renamed.withheld, undefined);
  assert.equal(git(storeB, ["show", "origin/main:artifacts/plans/short.md"]), "# Long");
});

// An older Git on Windows could commit a name in the machine's code page, so the remote's branch can hold names that are not UTF-8, which macOS and Windows cannot hold.
function pushLegacyNames(storeA) {
  git(storeA, ["fetch", "-q", "origin"]);
  const env = { ...process.env, GIT_INDEX_FILE: path.join(storeA, ".git", "teammate-index") };
  execFileSync("git", ["-C", storeA, "read-tree", "origin/main"], { env });
  const blob = (text) => git(storeA, ["hash-object", "-w", "--stdin"], text);
  const records = Buffer.concat([
    Buffer.from(`100644 ${blob("first\n")}\tnotes/caf`), Buffer.from([0xe8]), Buffer.from(".md\0"),
    Buffer.from(`100644 ${blob("second\n")}\tnotes/caf`), Buffer.from([0xe9]), Buffer.from(".md\0")
  ]);
  execFileSync("git", ["-C", storeA, "update-index", "-z", "--index-info"], { env, input: records });
  const tree = execFileSync("git", ["-C", storeA, "write-tree"], { env }).toString().trim();
  const commit = git(storeA, ["commit-tree", tree, "-p", "origin/main", "-m", "legacy names"]);
  git(storeA, ["push", "-q", "origin", `${commit}:refs/heads/main`]);
  return commit;
}
// Whether the file system below a folder holds a name that is not UTF-8 byte for byte, as Linux does; macOS refuses it as an illegal byte sequence, and Windows stores another name.
async function holdsNotUtf8(folder) {
  const probe = Buffer.concat([Buffer.from("probe-caf"), Buffer.from([0xe8])]);
  const written = await writeFile(Buffer.concat([Buffer.from(`${folder}${path.sep}`), probe]), "").then(() => true, () => false);
  const names = await readdir(folder, { encoding: "buffer" });
  for (const name of names.filter((entry) => entry.toString("latin1").startsWith("probe-caf"))) await rm(Buffer.concat([Buffer.from(`${folder}${path.sep}`), name]));
  return written && names.some((name) => name.equals(probe));
}
const namesOf = (cwd, commit) => execFileSync("git", ["-C", cwd, "ls-tree", "-r", "-z", "--name-only", commit]).toString("latin1").split("\0").filter(Boolean);

test("a sync refuses an upstream entry whose name is not UTF-8, names it with its bytes escaped, and the branch stays", async (context) => {
  const { storeA, storeB } = await stores(context);
  const crafted = pushLegacyNames(storeA);
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
  const status = await syncRecordStore(storeB);
  assert.equal(status.state, "merge_failed", JSON.stringify(status));
  assert.ok(status.message.includes(String.raw`"notes/caf\xe8.md"`), status.message);
  assert.equal(isAncestor(storeB, crafted), false, "the branch stays where it was");
  assert.deepEqual(namesOf(storeA, "origin/main").filter((name) => name.startsWith("notes/")), ["notes/caf\xe8.md", "notes/caf\xe9.md"]);
  assert.equal(git(storeA, ["ls-remote", "origin", "main"]).split("\t")[0], crafted, "nothing was pushed");
});

test("a branch that took entries whose names are not UTF-8 by hand keeps each name's bytes in its commits and pushes nothing until the remote drops them", async (context) => {
  const { storeA, storeB } = await stores(context);
  const crafted = pushLegacyNames(storeA);
  // The branch and the index take the commit by hand; a pull on macOS stops because its file system refuses names that are not UTF-8, so only a host that holds them, as Linux does, writes the files.
  git(storeB, ["fetch", "-q", "origin"]);
  git(storeB, ["read-tree", crafted]);
  git(storeB, ["update-ref", "HEAD", crafted]);
  const legacy = namesOf(storeB, "HEAD").filter((name) => name.startsWith("notes/"));
  const holds = await holdsNotUtf8(path.dirname(storeB));
  if (holds) execFileSync("git", ["-C", storeB, "checkout-index", "-f", "-z", "--stdin"], { input: Buffer.from(`${legacy.join("\0")}\0`, "latin1") });
  const onDisk = () => readdir(path.join(storeB, "notes"), { encoding: "buffer" }).then((names) => names.map((name) => name.toString("latin1")).sort(), () => []);
  assert.deepEqual(await onDisk(), holds ? ["caf\xe8.md", "caf\xe9.md"] : []);
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
  const refused = await syncRecordStore(storeB);
  assert.deepEqual(await onDisk(), holds ? ["caf\xe8.md", "caf\xe9.md"] : [], "the sync writes and removes neither file, whatever the host can hold");
  assert.equal(refused.state, "merge_failed", JSON.stringify(refused));
  assert.ok(refused.message.includes(String.raw`"notes/caf\xe8.md"`), refused.message);
  assert.deepEqual(namesOf(storeB, "HEAD").filter((name) => name.startsWith("notes/")), ["notes/caf\xe8.md", "notes/caf\xe9.md"], "the local commit keeps both names byte for byte");
  assert.equal(git(storeB, ["show", "HEAD:roadmap.json"]), "{\"b\":true}", "the local change is committed");
  assert.equal(git(storeA, ["ls-remote", "origin", "main"]).split("\t")[0], crafted, "nothing was pushed");
});

// Names whose UTF-8 holds characters beyond U+FFFF, whose UTF-16 form pairs a high and a low surrogate, as emoji and some CJK names do.
const ASTRAL = ["\u{10000}", "\u{10080}", "\u{1F4A1} ideas", "\u{1F4C1}", "\u{1F4DD}", "\u{1F4FF}", "\u{1F600}", "\u{20000}", "\u{10FFFF}"];

test("a sync carries upstream entries whose UTF-8 names hold characters beyond U+FFFF byte for byte, and a name with a byte that is not UTF-8 beside them is still refused", async (context) => {
  const { storeA, storeB } = await stores(context);
  git(storeA, ["fetch", "-q", "origin"]);
  const env = { ...process.env, GIT_INDEX_FILE: path.join(storeA, ".git", "teammate-index") };
  execFileSync("git", ["-C", storeA, "read-tree", "origin/main"], { env });
  const blob = git(storeA, ["hash-object", "-w", "--stdin"], "notes\n");
  const entries = ASTRAL.map((name) => Buffer.from(`100644 ${blob}\tnotes/${name}.md\0`));
  execFileSync("git", ["-C", storeA, "update-index", "-z", "--index-info"], { env, input: Buffer.concat(entries) });
  const tree = execFileSync("git", ["-C", storeA, "write-tree"], { env }).toString().trim();
  const commit = git(storeA, ["commit-tree", tree, "-p", "origin/main", "-m", "astral names"]);
  git(storeA, ["push", "-q", "origin", `${commit}:refs/heads/main`]);
  await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
  const status = await syncRecordStore(storeB);
  assert.equal(status.state, "ok", JSON.stringify(status));
  assert.equal(git(storeB, ["show", "origin/main:roadmap.json"]), "{\"b\":true}", "the local change reaches the remote");
  const expected = ASTRAL.map((name) => Buffer.from(`notes/${name}.md`).toString("latin1")).sort();
  assert.deepEqual(namesOf(storeB, "origin/main").filter((name) => name.startsWith("notes/")).sort(), expected, "each name keeps its bytes");
  assert.equal(await exists(path.join(storeB, "notes")), false, "no carried file is written to disk");
  // A byte that is not UTF-8 after such a character still makes the name unsafe.
  git(storeA, ["fetch", "-q", "origin"]);
  execFileSync("git", ["-C", storeA, "read-tree", "origin/main"], { env });
  execFileSync("git", ["-C", storeA, "update-index", "-z", "--index-info"], { env, input: Buffer.concat([Buffer.from(`100644 ${blob}\tnotes/\u{1F4A1}`), Buffer.from([0xe9]), Buffer.from(".md\0")]) });
  const strayTree = execFileSync("git", ["-C", storeA, "write-tree"], { env }).toString().trim();
  const stray = git(storeA, ["commit-tree", strayTree, "-p", "origin/main", "-m", "a stray byte"]);
  git(storeA, ["push", "-q", "origin", `${stray}:refs/heads/main`]);
  const refused = await syncRecordStore(storeB);
  assert.equal(refused.state, "merge_failed", JSON.stringify(refused));
  assert.ok(refused.message.includes(String.raw`"notes/` + "\u{1F4A1}" + String.raw`\xe9.md"`), refused.message);
  assert.equal(isAncestor(storeB, stray), false, "the branch stays where it was");
});
