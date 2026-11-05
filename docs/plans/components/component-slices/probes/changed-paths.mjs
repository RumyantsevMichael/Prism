// Show which paths `git diff-tree` reports between two content trees that verification hashes: committed, uncommitted, deleted, and renamed files.
// Usage: node docs/plans/components/component-slices/probes/changed-paths.mjs (from the repository root)
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentTree } from "../../../../../dist/server/workflow/slice-gate.mjs";
import { readWorkflowConfig } from "../../../../../dist/server/workflow/workflow-config.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "prism-probe-"));
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
try {
  await mkdir(path.join(root, "packages/billing"), { recursive: true });
  await mkdir(path.join(root, "packages/shared"), { recursive: true });
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans: docs/plans\n");
  await writeFile(path.join(root, "packages/billing/a.ts"), "a\n");
  await writeFile(path.join(root, "packages/shared/b.ts"), "b\n");
  await writeFile(path.join(root, "packages/shared/old.ts"), "old\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "-m", "start");
  const config = await readWorkflowConfig(root);
  const start = await contentTree(root, config);
  await writeFile(path.join(root, "packages/billing/a.ts"), "a2\n");
  git("add", "-A");
  git("-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "-m", "committed change");
  await writeFile(path.join(root, "packages/shared/b.ts"), "b2\n");
  await rename(path.join(root, "packages/shared/old.ts"), path.join(root, "packages/billing/moved.ts"));
  await mkdir(path.join(root, "docs/plans/x"), { recursive: true });
  await writeFile(path.join(root, "docs/plans/x/slice.md"), "plan\n");
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans: docs/plans\n\n## Components\n");
  const now = await contentTree(root, config);
  console.log(git("diff-tree", "-r", "--no-renames", "--name-status", start, now));
} finally {
  await rm(root, { recursive: true, force: true });
}
