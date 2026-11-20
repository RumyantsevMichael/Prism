// Generated from src/server/review/workspace-identity.mts by scripts/native-build/compile.mjs.
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
async function readHead(gitDirectory) {
  const head = (await readFile(path.join(gitDirectory, "HEAD"), "utf8").catch(() => "")).trim();
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  if (branch) return { branch, detached: false };
  return /^[0-9a-f]{7,}$/i.test(head) ? { branch: head.slice(0, 7), detached: true } : { branch: null, detached: false };
}
async function readWorkspaceIdentity(projectRoot) {
  const folder = { repository: path.basename(projectRoot), worktree: null, branch: null, detached: false };
  const dotGit = path.join(projectRoot, ".git");
  const info = await stat(dotGit).catch(() => null);
  if (!info) return folder;
  if (info.isDirectory()) return { ...folder, ...await readHead(dotGit) };
  const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8").catch(() => ""))?.[1]?.trim();
  if (!pointer) return folder;
  const gitDirectory = path.resolve(projectRoot, pointer);
  const head = await readHead(gitDirectory);
  const common = (await readFile(path.join(gitDirectory, "commondir"), "utf8").catch(() => "")).trim();
  if (!common) return { ...folder, ...head };
  const commonDirectory = path.resolve(gitDirectory, common);
  const repositoryFolder = path.basename(commonDirectory) === ".git" ? path.dirname(commonDirectory) : commonDirectory;
  return { repository: path.basename(repositoryFolder).replace(/\.git$/, ""), worktree: path.basename(projectRoot), ...head };
}
function workspaceName(identity) {
  if (identity.branch) return identity.detached ? `detached ${identity.branch}` : identity.branch;
  return identity.worktree;
}
function workspaceLabel(identity) {
  const name = workspaceName(identity);
  return name ? `${identity.repository}/${name}` : identity.repository;
}
function hostLabel() {
  return os.hostname().split(".")[0] || "an unnamed host";
}
function checkoutLabel(identity, host = hostLabel()) {
  return `${workspaceLabel(identity)} on ${host}`;
}
function workspaceTitle({ workspaceName: kept = null, identity = null, root = null }) {
  if (kept) return kept;
  if (identity) {
    const last = identity.replace(/^file:/, "").split(/[\\/:]+/).filter(Boolean).pop() ?? identity;
    return last.replace(/\.git$/i, "") || last;
  }
  return root ? path.basename(root) : "workspace";
}
export {
  checkoutLabel,
  hostLabel,
  readWorkspaceIdentity,
  workspaceLabel,
  workspaceName,
  workspaceTitle
};
