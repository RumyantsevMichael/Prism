// Show how two linked worktrees of one repository can keep a slice's start content under refs without moving or deleting each other's:
// refs under refs/prism/ are shared, refs under refs/worktree/ are per worktree but another worktree's git gc prunes what they name,
// two clean worktrees at one commit hash the same content tree, so a ref named by its tree cannot tell them apart,
// and a ref named by the project root's real path keeps each worktree's content through either worktree's gc.
// It also shows which pushes, clones, and bundles carry a ref under refs/prism/.
// Usage: node docs/plans/components/component-slices/probes/worktree-refs.mjs (from the repository root)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentTree } from "../../../../../dist/server/workflow/slice-gate.mjs";
import { readWorkflowConfig } from "../../../../../dist/server/workflow/workflow-config.mjs";

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-probe-")));
const main = path.join(base, "main");
const linked = path.join(base, "linked");
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=p", "-c", "user.email=p@p", ...args], { cwd, stdio: "pipe" }).toString().trim();
const readable = (cwd, tree) => { try { git(cwd, "cat-file", "-e", `${tree}^{tree}`); return true; } catch { return false; } };
const refs = (cwd, prefix) => git(cwd, "for-each-ref", "--format=%(refname)", prefix).split("\n").filter(Boolean);
const gc = (cwd) => { try { git(cwd, "gc", "-q", "--prune=now"); return "ok"; } catch (error) { return String(error.stderr).trim().split("\n")[0]; } };
const tree = async (root) => contentTree(root, await readWorkflowConfig(root));
const checkout = (root) => createHash("sha256").update(root).digest("hex").slice(0, 16);
try {
  await mkdir(path.join(main, ".prism"), { recursive: true });
  await writeFile(path.join(main, ".prism/workflow.md"), "## Paths\n- Plans: docs/plans\n");
  await writeFile(path.join(main, "a.txt"), "a\n");
  git(main, "init", "-q", "-b", "main");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "start");
  git(main, "worktree", "add", "-q", "-b", "other", linked);
  const sameContent = (await tree(main)) === (await tree(linked));

  // Shared names: a delete in one worktree removes the other's ref.
  await writeFile(path.join(main, "a.txt"), "main start\n");
  const ofMain = await tree(main);
  git(main, "update-ref", "refs/prism/work/s/start", ofMain);
  git(linked, "update-ref", "-d", "refs/prism/work/s/start");
  const shared = { mainRefsAfterLinkedDelete: refs(main, "refs/prism/") };

  // Per-worktree names: each worktree sees only its own, and gc in one prunes what the other's names.
  await writeFile(path.join(linked, "a.txt"), "linked start\n");
  const ofLinked = await tree(linked);
  git(main, "update-ref", "refs/worktree/prism/work/s/start", ofMain);
  git(linked, "update-ref", "refs/worktree/prism/work/s/start", ofLinked);
  const perWorktree = { gcInMain: gc(main), linkedTreeAfterGcInMain: readable(main, ofLinked), gcInLinked: gc(linked) };
  git(main, "update-ref", "-d", "refs/worktree/prism/work/s/start");
  try { git(linked, "update-ref", "-d", "refs/worktree/prism/work/s/start"); } catch { /* Its object is gone. */ }

  // Names by checkout: each worktree writes and deletes only its own, and both trees outlive gc in either worktree.
  await writeFile(path.join(linked, "a.txt"), "linked start again\n");
  const ofLinkedAgain = await tree(linked);
  git(main, "update-ref", `refs/prism/work/s/${checkout(main)}/start`, ofMain);
  git(linked, "update-ref", `refs/prism/work/s/${checkout(linked)}/start`, ofLinkedAgain);
  git(linked, "update-ref", "-d", `refs/prism/work/s/${checkout(linked)}/start`);
  git(linked, "update-ref", `refs/prism/work/s/${checkout(linked)}/start`, ofLinkedAgain);
  const byCheckout = { refs: refs(main, "refs/prism/work/s/").length, gcInLinked: gc(linked), gcInMain: gc(main), mainTree: readable(linked, ofMain), linkedTree: readable(main, ofLinkedAgain) };

  // What leaves the machine.
  git(base, "init", "-q", "--bare", "plain.git");
  git(base, "init", "-q", "--bare", "mirror.git");
  git(main, "push", "-q", "--all", path.join(base, "plain.git"));
  git(main, "push", "-q", "--mirror", path.join(base, "mirror.git"));
  git(base, "clone", "-q", main, "plain-clone");
  git(base, "clone", "-q", "--mirror", main, "cloned.git");
  git(main, "bundle", "create", "-q", path.join(base, "all.bundle"), "--all");
  const carried = {
    pushAll: refs(path.join(base, "plain.git"), "refs/prism/").length > 0,
    clone: refs(path.join(base, "plain-clone"), "refs/prism/").length > 0,
    pushMirror: refs(path.join(base, "mirror.git"), "refs/prism/").length > 0,
    cloneMirror: refs(path.join(base, "cloned.git"), "refs/prism/").length > 0,
    bundleAll: git(base, "bundle", "list-heads", "all.bundle").includes("refs/prism/")
  };
  console.log(JSON.stringify({ git: git(main, "version"), sameContent, shared, perWorktree, byCheckout, carried }));
} finally {
  await rm(base, { recursive: true, force: true });
}
