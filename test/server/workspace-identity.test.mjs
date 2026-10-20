import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readWorkspaceIdentity, workspaceLabel } from "../../dist/server/review/workspace-identity.mjs";

async function folder(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-identity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a plain checkout is named by its folder and reads the branch from HEAD", async (context) => {
  const root = path.join(await folder(context), "payments");
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/feature/retries\n");
  const identity = await readWorkspaceIdentity(root);
  assert.deepEqual(identity, { repository: "payments", worktree: null, branch: "feature/retries" });
  assert.equal(workspaceLabel(identity), "payments");
});

test("a linked worktree is named by its main repository and its own folder", async (context) => {
  const base = await folder(context);
  const gitDirectory = path.join(base, "payments", ".git", "worktrees", "retry-fix");
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(path.join(gitDirectory, "commondir"), "../..\n");
  await writeFile(path.join(gitDirectory, "HEAD"), "ref: refs/heads/claude/retry-fix\n");
  const worktree = path.join(base, "payments", ".claude", "worktrees", "retry-fix");
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
  const identity = await readWorkspaceIdentity(worktree);
  assert.deepEqual(identity, { repository: "payments", worktree: "retry-fix", branch: "claude/retry-fix" });
  assert.equal(workspaceLabel(identity), "payments/retry-fix");
});

test("a worktree of a bare repository drops the .git suffix", async (context) => {
  const base = await folder(context);
  const gitDirectory = path.join(base, "payments.git", "worktrees", "main");
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(path.join(gitDirectory, "commondir"), "../..\n");
  await writeFile(path.join(gitDirectory, "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  const worktree = path.join(base, "main");
  await mkdir(worktree);
  await writeFile(path.join(worktree, ".git"), "gitdir: ../payments.git/worktrees/main\n");
  assert.deepEqual(await readWorkspaceIdentity(worktree), { repository: "payments", worktree: "main", branch: "0123456" });
});

test("a submodule or a folder without git keeps its folder name", async (context) => {
  const base = await folder(context);
  const moduleDirectory = path.join(base, "parent", ".git", "modules", "lib");
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(path.join(moduleDirectory, "HEAD"), "ref: refs/heads/main\n");
  const submodule = path.join(base, "parent", "lib");
  await mkdir(submodule);
  await writeFile(path.join(submodule, ".git"), `gitdir: ${moduleDirectory}\n`);
  assert.deepEqual(await readWorkspaceIdentity(submodule), { repository: "lib", worktree: null, branch: "main" });
  const plain = path.join(base, "notes");
  await mkdir(plain);
  assert.deepEqual(await readWorkspaceIdentity(plain), { repository: "notes", worktree: null, branch: null });
  await writeFile(path.join(plain, ".git"), "not a pointer\n");
  assert.deepEqual(await readWorkspaceIdentity(plain), { repository: "notes", worktree: null, branch: null });
});
