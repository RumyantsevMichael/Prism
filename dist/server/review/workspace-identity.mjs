import { readFile, stat } from "node:fs/promises";
import path from "node:path";

// A detached HEAD reports its short commit as the branch and sets detached.
async function readHead(gitDirectory) {
  const head = (await readFile(path.join(gitDirectory, "HEAD"), "utf8").catch(() => "")).trim();
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  if (branch) return { branch, detached: false };
  return /^[0-9a-f]{7,}$/i.test(head) ? { branch: head.slice(0, 7), detached: true } : { branch: null, detached: false };
}

// Names a project by its repository, its checked-out branch, and, for a linked worktree, the worktree folder.
// Only files under .git are read, so no git executable is needed and a missing or odd .git degrades to the folder name.
export async function readWorkspaceIdentity(projectRoot) {
  const folder = { repository: path.basename(projectRoot), worktree: null, branch: null, detached: false };
  const dotGit = path.join(projectRoot, ".git");
  const info = await stat(dotGit).catch(() => null);
  if (!info) return folder;
  if (info.isDirectory()) return { ...folder, ...(await readHead(dotGit)) };
  const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8").catch(() => ""))?.[1]?.trim();
  if (!pointer) return folder;
  const gitDirectory = path.resolve(projectRoot, pointer);
  const head = await readHead(gitDirectory);
  // A submodule's git directory has no commondir; only a linked worktree shares another checkout's repository.
  const common = (await readFile(path.join(gitDirectory, "commondir"), "utf8").catch(() => "")).trim();
  if (!common) return { ...folder, ...head };
  const commonDirectory = path.resolve(gitDirectory, common);
  const repositoryFolder = path.basename(commonDirectory) === ".git" ? path.dirname(commonDirectory) : commonDirectory;
  return { repository: path.basename(repositoryFolder).replace(/\.git$/, ""), worktree: path.basename(projectRoot), ...head };
}

// A checkout is named by its branch, because a worktree folder is often a generated name; the folder is the fallback.
export function workspaceName(identity) {
  if (identity.branch) return identity.detached ? `detached ${identity.branch}` : identity.branch;
  return identity.worktree;
}

export function workspaceLabel(identity) {
  const name = workspaceName(identity);
  return name ? `${identity.repository}/${name}` : identity.repository;
}
