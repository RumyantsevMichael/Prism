import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { changedBlobs, objectsAt } from "../../dist/server/workflow/git-objects.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

// A project in the folder app of a repository, whose second commit changes, adds, and removes files inside and outside it.
async function repository(context) {
  const top = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-git-objects-")));
  context.after(() => rm(top, { recursive: true, force: true }));
  git(top, "init", "-q");
  git(top, "config", "user.name", "Test");
  git(top, "config", "user.email", "test@example.com");
  const project = path.join(top, "app");
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "src", "kept.js"), "kept\n");
  await writeFile(path.join(project, "src", "gone.js"), "gone\n");
  await writeFile(path.join(top, "outside.txt"), "one\n");
  git(top, "add", "-A");
  git(top, "commit", "-q", "-m", "one");
  const before = git(top, "rev-parse", "HEAD^{tree}");
  await writeFile(path.join(project, "src", "kept.js"), "changed\n");
  await writeFile(path.join(project, "src", "a*b.js"), "pattern\n");
  await rm(path.join(project, "src", "gone.js"));
  await writeFile(path.join(top, "outside.txt"), "two\n");
  git(top, "add", "-A");
  git(top, "commit", "-q", "-m", "two");
  return { project, before, after: git(top, "rev-parse", "HEAD^{tree}"), blob: (file) => git(top, "rev-parse", `HEAD:app/${file}`) };
}

test("changedBlobs lists a project's changed paths relative to it, with null for a removed path", async (context) => {
  const { project, before, after, blob } = await repository(context);
  assert.deepEqual(await changedBlobs(project, before, after), [
    { path: "src/a*b.js", blob: blob("src/a*b.js") },
    { path: "src/gone.js", blob: null },
    { path: "src/kept.js", blob: blob("src/kept.js") }
  ]);
  assert.deepEqual(await changedBlobs(project, before, before), []);
  assert.equal(await changedBlobs(project, before, "0".repeat(40)), null);
});

test("objectsAt reads project-relative paths literally, with null for a path the tree does not hold", async (context) => {
  const { project, after, blob } = await repository(context);
  const found = await objectsAt(project, after, ["src/a*b.js", "src/gone.js", "src/kept.js"]);
  assert.deepEqual([...found], [["src/a*b.js", blob("src/a*b.js")], ["src/gone.js", null], ["src/kept.js", blob("src/kept.js")]]);
  assert.equal(await objectsAt(project, "0".repeat(40), ["src/kept.js"]), null);
});
