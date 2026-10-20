import { readFile, stat } from "node:fs/promises";
import path from "node:path";

async function readBranch(gitDirectory) {
  const head = (await readFile(path.join(gitDirectory, "HEAD"), "utf8").catch(() => "")).trim();
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  if (branch) return branch;
  return /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : null;
}

// Names a project by its repository and, for a linked worktree, the worktree folder.
// Only files under .git are read, so no git executable is needed and a missing or odd .git degrades to the folder name.
export async function readWorkspaceIdentity(projectRoot) {
  const folder = { repository: path.basename(projectRoot), worktree: null, branch: null };
  const dotGit = path.join(projectRoot, ".git");
  const info = await stat(dotGit).catch(() => null);
  if (!info) return folder;
  if (info.isDirectory()) return { ...folder, branch: await readBranch(dotGit) };
  const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8").catch(() => ""))?.[1]?.trim();
  if (!pointer) return folder;
  const gitDirectory = path.resolve(projectRoot, pointer);
  const branch = await readBranch(gitDirectory);
  // A submodule's git directory has no commondir; only a linked worktree shares another checkout's repository.
  const common = (await readFile(path.join(gitDirectory, "commondir"), "utf8").catch(() => "")).trim();
  if (!common) return { ...folder, branch };
  const commonDirectory = path.resolve(gitDirectory, common);
  const repositoryFolder = path.basename(commonDirectory) === ".git" ? path.dirname(commonDirectory) : commonDirectory;
  return { repository: path.basename(repositoryFolder).replace(/\.git$/, ""), worktree: path.basename(projectRoot), branch };
}

export function workspaceLabel(identity) {
  return identity.worktree ? `${identity.repository}/${identity.worktree}` : identity.repository;
}
