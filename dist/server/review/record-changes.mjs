import { execFile } from "node:child_process";

// Changed this week reads the repository's Git history of the record files, since requirements, decisions, the glossary, and diagrams live in the repository.
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 10000;
const GIT_BUFFER = 64 * 1024 * 1024;

export const UNAVAILABLE = Object.freeze({
  notRepository: "the project is not a Git repository",
  noCommits: "the repository has no commits",
  noGit: "Git could not be run"
});

// One Git command in the project; Git is looked up through PATH on each call, so a project without Git says so rather than failing.
// Git's messages are read in English whatever the locale.
// A failure keeps Git's exit code, which is a number only when Git ran to its end, and its message, so a command that was killed or overflowed reads as Git not running.
function git(root, args) {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotePath=false", ...args], { cwd: root, env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" }, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_BUFFER, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve(error ? { ok: false, code: error.killed || typeof error.code !== "number" ? null : error.code, stderr: String(stderr ?? ""), stdout: "" } : { ok: true, stdout });
    });
  });
}

// Git says a folder is outside every repository with exit code 128 and this message; any other failure means Git could not answer.
const notRepository = (result) => result.code === 128 && /not a git repository/i.test(result.stderr);
// `rev-parse --verify --quiet HEAD` exits 1 without a message when the repository has no commit yet.
const noCommit = (result) => result.code === 1 && !result.stderr.trim();

const unavailable = (reason, records) => ({ available: false, reason, records: [], undated: records.map(({ kind, title, ref }) => ({ kind, title, ref })) });

/**
 * The record files changed in the last 7 days: those Git reports modified, added, or untracked first, marked uncommitted,
 * then those a commit of the last 7 days changed, newest change first, with the commit's time and author; a renamed file counts under its new name.
 * `records` lists every record file as { kind, title, ref } with `ref` its project-relative path, and `pathspecs` the folders and files that hold them.
 * A merge commit counts with what it changed against its first parent.
 * Without Git, a repository, or a commit, nothing is dated and every record file is listed as undated.
 */
export async function recordChanges(projectRoot, records, pathspecs, { now = Date.now() } = {}) {
  const top = await git(projectRoot, ["rev-parse", "--show-prefix"]);
  if (!top.ok) return unavailable(notRepository(top) ? UNAVAILABLE.notRepository : UNAVAILABLE.noGit, records);
  const head = await git(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!head.ok) return unavailable(noCommit(head) ? UNAVAILABLE.noCommits : UNAVAILABLE.noGit, records);
  // Git names files from the repository's top, so a project inside a larger repository drops its own folder from each name.
  const prefix = top.stdout.trim();
  const local = (name) => prefix && name.startsWith(prefix) ? name.slice(prefix.length) : prefix ? null : name;
  const byRef = new Map(records.map((record) => [record.ref, record]));
  const specs = pathspecs.filter(Boolean);
  if (!specs.length || !byRef.size) return { available: true, reason: null, records: [], undated: [] };
  const status = await git(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...specs]);
  // A merge lists what it brought onto the branch, against its first parent, so a branch merged this week counts at the merge's time and author.
  const log = await git(projectRoot, ["log", "-M", "--diff-merges=first-parent", `--since=${new Date(now - WINDOW_MS).toISOString()}`, "--format=%x1e%cI%x1f%an", "--name-only", "--", ...specs]);
  // rev-parse already found a repository with a commit, so a failure here is Git that could not answer.
  if (!status.ok || !log.ok) return unavailable(UNAVAILABLE.noGit, records);
  const uncommitted = new Set();
  const fields = status.stdout.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    const [x, y, name] = [field[0], field[1], field.slice(3)];
    // A rename or copy names its old path in the next field.
    if (x === "R" || x === "C") index += 1;
    if (x === "D" || y === "D") continue;
    const ref = local(name);
    if (ref !== null && byRef.has(ref)) uncommitted.add(ref);
  }
  const committed = new Map();
  for (const block of log.stdout.split("\x1e").slice(1)) {
    const [header, ...names] = block.split("\n");
    const [time, author] = header.split("\x1f");
    const at = Date.parse(time);
    for (const name of names) {
      const ref = local(name.trim());
      if (!ref || !byRef.has(ref) || uncommitted.has(ref) || committed.has(ref)) continue;
      committed.set(ref, { at: Number.isFinite(at) ? new Date(at).toISOString() : null, author: author?.trim() || null });
    }
  }
  const entry = (ref, change) => ({ kind: byRef.get(ref).kind, title: byRef.get(ref).title, ref, at: change.at, author: change.author, uncommitted: change.uncommitted });
  const listed = [
    ...records.filter((record) => uncommitted.has(record.ref)).map((record) => entry(record.ref, { at: null, author: null, uncommitted: true })),
    ...[...committed.entries()].map(([ref, change]) => entry(ref, { ...change, uncommitted: false })).sort((left, right) => (Date.parse(right.at ?? "") || 0) - (Date.parse(left.at ?? "") || 0))
  ];
  return { available: true, reason: null, records: listed, undated: [] };
}
