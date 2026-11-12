// Probe: how Git tags and stages index entries that are not ordinary merged entries (assume-unchanged, skip-worktree, unmerged), and which files mark a merge, rebase, am, cherry-pick, or revert in progress.
// Usage: node git-index-states.mjs <scratch folder>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const base = path.resolve(process.argv[2]);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: base, GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@example.invalid", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@example.invalid", GIT_EDITOR: "true" };
const run = (cwd, ...args) => { try { return { code: 0, out: execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trimEnd() }; } catch (error) { return { code: error.status, out: `${error.stdout}${error.stderr}`.trimEnd() }; } };
const lines = (text) => text.split("\n").filter(Boolean);
const repo = (name, files) => {
  const folder = path.join(base, name);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  run(folder, "init", "-q", "-b", "main");
  write(folder, files);
  run(folder, "add", "-A");
  run(folder, "commit", "-q", "-m", "base");
  return folder;
};
const write = (folder, files) => { for (const [name, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(folder, name)), { recursive: true }); writeFileSync(path.join(folder, name), text); } };
const markers = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer/todo"];
const inProgress = (folder) => markers.filter((marker) => existsSync(path.resolve(folder, run(folder, "rev-parse", "--git-path", marker).out)));
const facts = (folder) => ({
  t: lines(run(folder, "ls-files", "-t").out),
  v: lines(run(folder, "ls-files", "-v").out),
  deleted: lines(run(folder, "ls-files", "--deleted").out),
  status: lines(run(folder, "status", "--porcelain").out),
  markers: inProgress(folder),
});
const staged = (folder) => { run(folder, "add", "-A"); return lines(run(folder, "diff", "--cached", "--name-status").out); };
const files = { "docs/a.md": "# A\n", "docs/b.md": "# B\n", "docs/c.md": "# C\n" };
const result = {};

// Assume-unchanged: one entry edited, one removed; then the bit is cleared.
{
  const folder = repo("assume", files);
  run(folder, "update-index", "--assume-unchanged", "docs/a.md", "docs/b.md");
  writeFileSync(path.join(folder, "docs/a.md"), "# A, local\n");
  rmSync(path.join(folder, "docs/b.md"));
  const before = facts(folder);
  const addAll = staged(folder);
  const commitAll = run(folder, "commit", "-q", "-am", "removal").code;
  const head = lines(run(folder, "ls-tree", "-r", "--name-only", "HEAD").out);
  run(folder, "update-index", "--no-assume-unchanged", "docs/a.md", "docs/b.md");
  result.assumeUnchanged = { before, addAll, commitAllExit: commitAll, head, afterClear: { status: facts(folder).status, addAll: staged(folder) } };
  // Both bits on one entry, set one at a time.
  const both = repo("both", files);
  run(both, "update-index", "--assume-unchanged", "docs/a.md");
  run(both, "update-index", "--skip-worktree", "docs/a.md");
  result.assumeUnchanged.bothBits = { t: lines(run(both, "ls-files", "-t", "docs/a.md").out), v: lines(run(both, "ls-files", "-v", "docs/a.md").out) };
  // git rm stages the removal of an assume-unchanged entry.
  const rm = repo("assume-rm", files);
  run(rm, "update-index", "--assume-unchanged", "docs/b.md");
  rmSync(path.join(rm, "docs/b.md"));
  run(rm, "rm", "-q", "docs/b.md");
  result.assumeUnchanged.gitRm = lines(run(rm, "diff", "--cached", "--name-status").out);
}

// A merge that stops: a and b conflict, c merges cleanly into a stage 0 entry with uncommitted bytes.
{
  const folder = repo("merge", files);
  run(folder, "checkout", "-qb", "feature");
  write(folder, { "docs/a.md": "# A, feature\n", "docs/c.md": "# C, feature\n" });
  run(folder, "rm", "-q", "docs/b.md");
  run(folder, "commit", "-qam", "feature");
  run(folder, "checkout", "-q", "main");
  write(folder, { "docs/a.md": "# A, main\n", "docs/b.md": "# B, main\n" });
  run(folder, "commit", "-qam", "main");
  const merge = run(folder, "merge", "feature").code;
  const stopped = { ...facts(folder), stages: lines(run(folder, "ls-files", "-s").out).map((line) => line.replace(/ [0-9a-f]{40}/, "")) };
  rmSync(path.join(folder, "docs/a.md"));
  rmSync(path.join(folder, "docs/c.md"));
  const removed = facts(folder);
  const partial = run(folder, "commit", "-q", "-m", "only the removal", "--", "docs/c.md");
  result.merge = { mergeExit: merge, stopped, afterRemovingAAndC: { deleted: removed.deleted, status: removed.status }, partialCommit: { exit: partial.code, out: partial.out }, addAll: staged(folder) };
  run(folder, "merge", "--abort");
  result.merge.afterAbort = facts(folder).markers;
}

// The operations that leave a marker while they stop, each stopped by a conflict.
{
  const conflicting = (name) => {
    const folder = repo(name, files);
    run(folder, "checkout", "-qb", "feature");
    write(folder, { "docs/a.md": "# A, feature\n" });
    run(folder, "commit", "-qam", "feature");
    run(folder, "checkout", "-q", "main");
    write(folder, { "docs/a.md": "# A, main\n" });
    run(folder, "commit", "-qam", "main");
    return folder;
  };
  const stops = {};
  let folder = conflicting("rebase");
  run(folder, "checkout", "-q", "feature");
  stops.rebase = { exit: run(folder, "rebase", "main").code, markers: inProgress(folder), t: lines(run(folder, "ls-files", "-t", "docs/a.md").out) };
  folder = conflicting("rebase-apply");
  run(folder, "checkout", "-q", "feature");
  stops.rebaseApply = { exit: run(folder, "rebase", "--apply", "main").code, markers: inProgress(folder) };
  folder = conflicting("am");
  const patch = path.join(base, "feature.patch");
  writeFileSync(patch, run(folder, "format-patch", "-1", "--stdout", "feature").out + "\n");
  stops.am = { exit: run(folder, "am", "-3", patch).code, markers: inProgress(folder) };
  folder = conflicting("cherry-pick");
  stops.cherryPick = { exit: run(folder, "cherry-pick", "feature").code, markers: inProgress(folder) };
  folder = conflicting("revert");
  run(folder, "checkout", "-q", "feature");
  write(folder, { "docs/a.md": "# A, feature again\n" });
  run(folder, "commit", "-qam", "again");
  stops.revert = { exit: run(folder, "revert", "--no-edit", "HEAD~1").code, markers: inProgress(folder) };
  folder = repo("cherry-pick-n", files);
  run(folder, "checkout", "-qb", "feature");
  write(folder, { "docs/b.md": "# B, feature\n" });
  run(folder, "commit", "-qam", "feature");
  run(folder, "checkout", "-q", "main");
  stops.cherryPickNoCommit = { exit: run(folder, "cherry-pick", "-n", "feature").code, markers: inProgress(folder) };
  // A cherry-pick of two commits whose first conflicts: once that pick is committed, only the sequencer's todo list marks the rest.
  folder = conflicting("cherry-pick-two");
  run(folder, "checkout", "-q", "feature");
  write(folder, { "docs/b.md": "# B, feature\n" });
  run(folder, "commit", "-qam", "second");
  run(folder, "checkout", "-q", "main");
  const picks = run(folder, "cherry-pick", "main..feature").code;
  write(folder, { "docs/a.md": "# A, resolved\n" });
  run(folder, "add", "docs/a.md");
  run(folder, "commit", "-q", "--no-edit");
  stops.cherryPickSequence = { exit: picks, markers: inProgress(folder), status: lines(run(folder, "status").out)[1] };
  // A linked worktree keeps its own markers, which --git-path resolves.
  folder = conflicting("linked");
  const linked = path.join(base, "linked-two");
  rmSync(linked, { recursive: true, force: true });
  run(folder, "worktree", "add", "-q", linked, "feature");
  stops.linkedWorktree = { exit: run(linked, "merge", "main").code, markers: inProgress(linked), mainMarkers: inProgress(folder), gitPath: path.relative(base, path.resolve(linked, run(linked, "rev-parse", "--git-path", "MERGE_HEAD").out)) };
  result.inProgress = stops;
}

// A stash pop that conflicts leaves unmerged entries and no marker.
{
  const folder = repo("stash", files);
  write(folder, { "docs/a.md": "# A, stashed\n" });
  run(folder, "stash", "-q");
  write(folder, { "docs/a.md": "# A, committed\n" });
  run(folder, "commit", "-qam", "next");
  const pop = run(folder, "stash", "pop").code;
  result.stashPop = { exit: pop, ...facts(folder) };
}

console.log(JSON.stringify(result, null, 1));
