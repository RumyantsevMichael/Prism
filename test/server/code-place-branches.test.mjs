import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { eventually as waitFor, git, isolateGit, sha16 } from "./fixtures/workspace-view.mjs";
import { applySteps, codeWorkspace, prismCheckout, verifiedWork } from "./fixtures/code-place.mjs";

// Requirements: docs/requirements/code-place.md §7, §11, §20, §21, §24, §25.
// Contract: docs/plans/code-place/slice.md clauses 6 to 12, through GET ./api/code/branches of a workspace page.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

// The web repository: develop from main with a merged topic, a feature started from develop's tip, a fresh branch, a release branch,
// a branch that main moved past, a branch squash-merged into main, a quiet branch, an unrelated history, and a branch named like an option.
const WEB = {
  name: "web",
  files: { "README.md": "web\n", "packages/shell/index.ts": "shell\n", "packages/reports/table.ts": "table v1\n" },
  steps: [
    { branch: "develop", author: "Sam Ortiz", days: 20, files: { "packages/reports/table.ts": "table v2\n" } },
    { branch: "develop", author: "Lee Park", days: 15, files: { "packages/charts/bar.ts": "bar\n" } },
    { branch: "topic/merged", from: "develop", author: "Ana Ruiz", days: 12, files: { "packages/charts/line.ts": "line\n" } },
    { branch: "develop", author: "Sam Ortiz", days: 11, merge: "topic/merged" },
    { branch: "feature/report-table", from: "develop", author: "Dana Kim", days: 2, files: { "packages/reports/table.ts": "table v3\n" } },
    { branch: "feature/fresh", from: "develop", author: "Dana Kim", days: 1 },
    { branch: "release/2026.11", author: "Sam Ortiz", days: 5, files: { "packages/shell/index.ts": "shell 2\n" } },
    { branch: "fix/behind", author: "Lee Park", days: 9, files: { "packages/shell/theme.ts": "theme\n" } },
    { branch: "feature/squashed", author: "Lee Park", days: 8, files: { "packages/shell/menu.ts": "menu\n" } },
    { branch: "old/experiment", author: "Ana Ruiz", days: 35, files: { "packages/shell/old.ts": "old\n" } },
    { branch: "gh-pages", orphan: true, author: "Ana Ruiz", days: 6, files: { "index.html": "<p>docs</p>\n" } },
    { branch: "feature/--version", author: "Lee Park", days: 3, files: { "packages/shell/version.ts": "version\n" } },
    { branch: "main", author: "Sam Ortiz", days: 4, files: { "packages/shell/menu.ts": "menu\n" } },
    { branch: "main", author: "Sam Ortiz", days: 3, files: { "README.md": "web 2\n" } }
  ]
};
const INFRA = { name: "infra", files: { "main.tf": "terraform\n" } };

async function web(context, options = {}) {
  const workspace = await codeWorkspace(context, { repositories: [WEB, INFRA], on: ["web"], ...options });
  const answer = async (query = "") => {
    const got = await workspace.ready(`branches?repository=web${query}`);
    assert.equal(got.status, 200, got.body);
    return got.json;
  };
  const byName = async (query) => new Map((await answer(query)).branches.map((branch) => [branch.name, branch]));
  return { ...workspace, answer, byName };
}

const mergeBase = (bare, left, right) => git(bare, "merge-base", left, right);

test("clauses 6 and 7: the answer lists every branch in name order, the default branch first in meaning, with base null and no changed files", async (context) => {
  const { answer, remotes } = await web(context);
  const got = await answer();
  assert.equal(got.repository, "web");
  assert.equal(got.defaultBranch, "main");
  assert.deepEqual(got.branches.map((branch) => branch.name), [...got.branches.map((branch) => branch.name)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "name order");
  const main = got.branches.find((branch) => branch.name === "main");
  assert.deepEqual({ ...main, committedAt: undefined }, { name: "main", default: true, base: null, fork: null, files: 0, committedAt: undefined, quiet: false, people: { last: null, count: 0 }, owners: [] });
  assert.equal(Date.parse(main.committedAt), Number(git(remotes.web.bare, "log", "-1", "--format=%ct", "main")) * 1000);
  for (const branch of got.branches.filter((item) => !item.default)) {
    assert.deepEqual(Object.keys(branch).sort(), ["base", "committedAt", "default", "files", "fork", "name", "owners", "people", "quiet"], `${branch.name} has the fields of clause 6`);
    assert.equal(branch.default, false);
    assert.deepEqual(branch.owners, [], "no slice owns a branch of web");
  }
});

test("clause 8: a branch takes the branch it started from as its base, whatever the branching pattern", async (context) => {
  const { byName, remotes } = await web(context);
  const branches = await byName();
  const bases = Object.fromEntries([...branches.values()].filter((branch) => !branch.default).map((branch) => [branch.name, branch.base]));
  assert.deepEqual(bases, {
    develop: "main",
    "feature/report-table": "develop",
    "feature/fresh": "develop",
    "topic/merged": "develop",
    "release/2026.11": "main",
    "fix/behind": "main",
    "feature/squashed": "main",
    "old/experiment": "main",
    "gh-pages": null,
    "feature/--version": "main"
  });
  assert.equal(branches.get("feature/report-table").fork, mergeBase(remotes.web.bare, "feature/report-table", "develop"), "the fork is the merge base with the base");
  assert.equal(branches.get("develop").fork, mergeBase(remotes.web.bare, "develop", "main"));
});

test("clause 8: a branch built on another's tip never becomes that branch's base, and a branch that shares no history has none", async (context) => {
  const { byName } = await web(context);
  const branches = await byName();
  assert.equal(branches.get("develop").base, "main", "develop's tip is where feature/report-table and feature/fresh started, so neither is its base");
  assert.equal(branches.get("develop").files, 3);
  assert.deepEqual([branches.get("gh-pages").base, branches.get("gh-pages").fork, branches.get("gh-pages").files], [null, null, null]);
});

test("clause 8: a branch that receives merges ranks as a base over a branch with more commits, and a tie goes to the default branch", async (context) => {
  const workspace = await web(context);
  // side starts from integration's first commit and moves on further than integration, which then receives a merge.
  await applySteps(workspace.remotes.web.work, [
    { branch: "integration", from: "develop", author: "Sam Ortiz", days: 1, files: { "packages/charts/pie.ts": "pie\n" } },
    { branch: "side", from: "integration", author: "Lee Park", days: 1, files: { "packages/charts/area.ts": "area\n" } },
    { branch: "side", author: "Lee Park", days: 1, files: { "packages/charts/area.ts": "area 2\n" } },
    { branch: "side", author: "Lee Park", days: 1, files: { "packages/charts/area.ts": "area 3\n" } },
    { branch: "topic/two", from: "integration", author: "Ana Ruiz", days: 1, files: { "packages/charts/dot.ts": "dot\n" } },
    { branch: "integration", author: "Sam Ortiz", days: 1, merge: "topic/two" }
  ]);
  const branches = await workspace.byName();
  assert.equal(branches.get("integration").base, "develop", "integration receives merges, so side, with more commits, is not its base");
  assert.equal(branches.get("side").base, "integration");
  assert.equal(branches.get("side").files, 1);
  assert.equal(branches.get("release/2026.11").base, "main", "release lacks as few commits of develop as of main, and the tie goes to the default branch");
});

test("clause 9: a branch's changed files are those it changed since its fork, leaving out what its base also holds now", async (context) => {
  const { byName } = await web(context);
  const branches = await byName();
  assert.equal(branches.get("feature/report-table").files, 1, "only table.ts, not develop's own changes");
  assert.equal(branches.get("fix/behind").files, 1, "main changed README.md after fix/behind split, which is not fix/behind's change");
  assert.equal(branches.get("feature/squashed").files, 0, "main now holds menu.ts as the branch has it");
  assert.equal(branches.get("topic/merged").files, 0, "a branch merged into its base changes nothing");
  assert.equal(branches.get("feature/fresh").files, 0, "an empty commit on develop's tip changes no file");
  assert.equal(branches.get("release/2026.11").files, 1);
});

test("clause 9: a removed file and a renamed file count as changes", async (context) => {
  const workspace = await web(context);
  const work = workspace.remotes.web.work;
  git(work, "checkout", "-q", "-b", "cleanup", "main");
  git(work, "rm", "-q", "packages/reports/table.ts");
  git(work, "mv", "packages/shell/index.ts", "packages/shell/main.ts");
  git(work, "commit", "-q", "-m", "cleanup");
  git(work, "push", "-q", "origin", "cleanup");
  git(work, "checkout", "-q", "main");
  const branches = await workspace.byName();
  assert.equal(branches.get("cleanup").files, 3, "one removal, and a rename as a removal and an addition");
});

test("clause 6: people names the newest author since the fork and how many authors committed since then", async (context) => {
  const { byName } = await web(context);
  const branches = await byName();
  assert.deepEqual(branches.get("feature/report-table").people, { last: "Dana Kim", count: 1 });
  assert.deepEqual(branches.get("develop").people, { last: "Sam Ortiz", count: 3 }, "Sam Ortiz, Lee Park, and Ana Ruiz through the merged topic");
  assert.deepEqual(branches.get("old/experiment").people, { last: "Ana Ruiz", count: 1 });
});

test("clause 10: a branch whose last commit is older than the threshold is quiet, 30 days unless the request names another", async (context) => {
  const { byName } = await web(context);
  assert.equal((await byName()).get("old/experiment").quiet, true, "35 days without a commit is quiet at the default 30");
  assert.equal((await byName("&quietDays=40")).get("old/experiment").quiet, false);
  const strict = await byName("&quietDays=1");
  assert.equal(strict.get("main").quiet, false, "the default branch is never quiet");
  assert.equal(strict.get("release/2026.11").quiet, true);
  assert.equal(strict.get("feature/fresh").quiet, false, "a commit within the last day is not quiet");
});

test("clause 11: a threshold outside 1 to 365 days, an unknown repository, and a repository with code content off are refused", async (context) => {
  const { api, ready } = await web(context);
  await ready("branches?repository=web");
  for (const value of ["0", "366", "1.5", "x", ""]) {
    const refused = await api(`branches?repository=web&quietDays=${encodeURIComponent(value)}`);
    assert.deepEqual([refused.status, refused.json?.code], [400, "invalid_request"], `quietDays=${value}: ${refused.body}`);
  }
  for (const value of ["1", "365"]) assert.equal((await api(`branches?repository=web&quietDays=${value}`)).status, 200, `quietDays=${value} is allowed`);
  const unknown = await api("branches?repository=mobile");
  assert.deepEqual([unknown.status, unknown.json?.code], [404, "repository_unknown"]);
  const off = await api("branches?repository=infra");
  assert.deepEqual([off.status, off.json?.code], [404, "code_off"]);
});

test("clause 12: the branch answer fetches no blob, and a branch named like an option is read as a branch", async (context) => {
  const { byName, where } = await web(context);
  const clone = path.join(where.app, "code", `${sha16("github.com/acme/web")}.git`);
  const blobs = () => git(clone, "cat-file", "--batch-all-objects", "--batch-check").split("\n").filter((line) => / blob /.test(line)).length;
  const before = blobs();
  const branches = await byName();
  assert.equal(blobs(), before, "no blob arrived for the answer");
  assert.equal(branches.get("feature/--version").base, "main");
  assert.equal(branches.get("feature/--version").files, 1);
});

test("clause 6: owners name each slice whose latest verification run that names a branch names that branch", async (context) => {
  const API = { name: "api", files: { "src/retry/strategy.ts": "export class RequestRetryStrategy {}\n" } };
  const workspace = await codeWorkspace(context, { repositories: [API] });
  const owner = await prismCheckout(context, workspace, "api");
  await verifiedWork(owner, { initiative: "retries", title: "Harden request retries", slices: [
    { slug: "deadline", title: "Retry timed-out requests until a deadline", branch: "claude/retry-deadline", files: { "src/retry/deadline.ts": "export const deadline = 10_000;\n" } },
    { slug: "metrics", title: "Report retry attempts as metrics", branch: "codex/retry-metrics", files: { "src/retry/metrics.ts": "export const metrics = 1;\n" } }
  ] });
  git(owner.root, "checkout", "-q", "-b", "team/review", "main");
  git(owner.root, "commit", "-q", "--allow-empty", "-m", "review notes");
  git(owner.root, "push", "-q", "origin", "team/review");
  const branches = await eventually(workspace, "api", (map) => map.get("codex/retry-metrics"));
  assert.ok(branches.has("claude/retry-deadline") && branches.has("codex/retry-metrics") && branches.has("team/review"), "the answer lists the pushed branches");
  assert.deepEqual(branches.get("claude/retry-deadline").owners, [{ initiative: "retries", slice: "deadline" }]);
  assert.deepEqual(branches.get("codex/retry-metrics").owners, [{ initiative: "retries", slice: "metrics" }]);
  assert.deepEqual(branches.get("team/review").owners, []);
  assert.equal(branches.get("claude/retry-deadline").base, "main");
  assert.equal(branches.get("claude/retry-deadline").files, 1);
});

// The branches of a repository once a fetch has brought the branch that found() looks for.
async function eventually({ ready }, repository, found) {
  let map = new Map();
  await waitFor(async () => {
    const got = await ready(`branches?repository=${repository}`);
    map = new Map((got.json?.branches ?? []).map((branch) => [branch.name, branch]));
    return found(map);
  }, 20000, `the branches of ${repository} after a fetch`).catch(() => null);
  return map;
}
