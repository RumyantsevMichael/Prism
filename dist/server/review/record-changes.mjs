// Generated from src/server/review/record-changes.mts by scripts/native-build/compile.mjs.
import { execFile } from "node:child_process";
const WINDOW_MS = 7 * 24 * 60 * 60 * 1e3;
const GIT_TIMEOUT_MS = 1e4;
const GIT_BUFFER = 64 * 1024 * 1024;
const UNAVAILABLE = Object.freeze({
  notRepository: "the project is not a Git repository",
  noCommits: "the repository has no commits",
  noGit: "Git could not be run"
});
function git(root, args) {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotePath=false", ...args], { cwd: root, env: { ...process.env, LC_ALL: "C", LANGUAGE: "C", GIT_OPTIONAL_LOCKS: "0" }, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_BUFFER, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      resolve(error ? { ok: false, code: error.killed || typeof error.code !== "number" ? null : error.code, stderr: String(stderr ?? ""), stdout: "" } : { ok: true, stdout });
    });
  });
}
const notRepository = (result) => result.code === 128 && /not a git repository/i.test(result.stderr);
const noCommit = (result) => result.code === 1 && !result.stderr.trim();
const unavailable = (reason, records) => ({ available: false, reason, records: [], undated: records.map(({ kind, title, ref }) => ({ kind, title, ref })) });
async function recordChanges(projectRoot, records, pathspecs, { now = Date.now() } = {}) {
  const top = await git(projectRoot, ["rev-parse", "--show-prefix"]);
  if (!top.ok) return unavailable(notRepository(top) ? UNAVAILABLE.notRepository : UNAVAILABLE.noGit, records);
  const head = await git(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!head.ok) return unavailable(noCommit(head) ? UNAVAILABLE.noCommits : UNAVAILABLE.noGit, records);
  const prefix = top.stdout.trim();
  const local = (name) => prefix && name.startsWith(prefix) ? name.slice(prefix.length) : prefix ? null : name;
  const byRef = new Map(records.map((record) => [record.ref, record]));
  const specs = pathspecs.filter(Boolean);
  if (!specs.length || !byRef.size) return { available: true, reason: null, records: [], undated: [] };
  const status = await git(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...specs]);
  const log = await git(projectRoot, ["log", "-M", "--diff-merges=first-parent", `--since=${new Date(now - WINDOW_MS).toISOString()}`, "--format=%x1e%cI%x1f%an", "--name-only", "--", ...specs]);
  if (!status.ok || !log.ok) return unavailable(UNAVAILABLE.noGit, records);
  const uncommitted = /* @__PURE__ */ new Set();
  const fields = status.stdout.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    const [x, y, name] = [field[0], field[1], field.slice(3)];
    if (x === "R" || x === "C") index += 1;
    if (x === "D" || y === "D") continue;
    const ref = local(name);
    if (ref !== null && byRef.has(ref)) uncommitted.add(ref);
  }
  const committed = /* @__PURE__ */ new Map();
  for (const block of log.stdout.split("").slice(1)) {
    const [header, ...names] = block.split("\n");
    const [time, author] = header.split("");
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
export {
  UNAVAILABLE,
  recordChanges
};
