// Show whether a content tree that verification hashes survives `git gc --prune=now` with and without a local ref, and whether pushes and clones carry that ref.
// Usage: node docs/plans/components/component-slices/probes/start-content-ref.mjs (from the repository root)
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentTree } from "../../../../../dist/server/workflow/slice-gate.mjs";
import { readWorkflowConfig } from "../../../../../dist/server/workflow/workflow-config.mjs";

const base = await mkdtemp(path.join(os.tmpdir(), "prism-probe-"));
const root = path.join(base, "work");
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=p", "-c", "user.email=p@p", ...args], { cwd, stdio: "pipe" }).toString().trim();
const readable = (tree) => { try { git(root, "cat-file", "-e", `${tree}^{tree}`); return true; } catch { return false; } };
try {
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans: docs/plans\n");
  await writeFile(path.join(root, "a.txt"), "a\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  const config = await readWorkflowConfig(root);
  await writeFile(path.join(root, "a.txt"), "a uncommitted\n");
  const kept = await contentTree(root, config);
  git(root, "update-ref", "refs/prism/work/billing-totals/start", kept);
  await writeFile(path.join(root, "a.txt"), "a other\n");
  const loose = await contentTree(root, config);
  git(root, "gc", "-q", "--prune=now");
  git(base, "init", "-q", "--bare", "remote.git");
  git(root, "remote", "add", "origin", path.join(base, "remote.git"));
  git(root, "push", "-q", "origin", "main");
  git(root, "push", "-q", "--all", "origin");
  const pushed = git(path.join(base, "remote.git"), "for-each-ref", "--format=%(refname)");
  git(base, "clone", "-q", path.join(root), "clone");
  const cloned = git(path.join(base, "clone"), "for-each-ref", "--format=%(refname)", "refs/prism");
  console.log(JSON.stringify({ withRef: readable(kept), withoutRef: readable(loose), remoteRefs: pushed.split("\n"), clonedPrismRefs: cloned ? cloned.split("\n") : [] }));
} finally {
  await rm(base, { recursive: true, force: true });
}
