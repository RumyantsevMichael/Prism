import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { eventually, git, isolateGit, ok } from "./fixtures/workspace-view.mjs";
import { codePlaceWorkspace, commitWork } from "./fixtures/code-place.mjs";

// Requirements: docs/requirements/code-place.md §4, §5, §6, §7, §11, §12, §24.
// Contract: docs/plans/code-place/slice.md clauses 11 and 13 to 18, through GET ./api/code/place of a workspace page.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

// One shared workspace: building it verifies five slices, so every test reads the same one, and it is removed after the last test.
const cleanups = [];
const suite = { after: (cleanup) => cleanups.push(cleanup) };
test.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
let shared = null;
const workspace = () => (shared ??= codePlaceWorkspace(suite));

async function place(context, query = "") {
  const got = await (await workspace()).ready(`place${query}`);
  assert.equal(got.status, 200, got.body);
  return got.json;
}

const line = (repository, branch, base, files) => ({ repository, branch, base, files });

test("clause 13: the answer lists the repositories with their states and counts the lines of work it lists", { timeout: 600000 }, async (context) => {
  const got = await place(context);
  assert.deepEqual(Object.keys(got).sort(), ["branches", "lines", "preparing", "quiet", "repositories", "work"]);
  assert.deepEqual(got.repositories.map(({ name, state }) => [name, state]), [["api", "on"], ["infra", "on"], ["mobile", "off"], ["web", "on"]]);
  assert.deepEqual(got.preparing, []);
  const pairs = new Set([
    ...got.work.flatMap((item) => [...item.branches, ...item.slices.flatMap((slice) => slice.branches)]).map((entry) => `${entry.repository}\0${entry.branch}`),
    ...got.branches.map((entry) => `${entry.repository}\0${entry.branch}`)
  ]);
  assert.equal(got.lines, pairs.size);
});

test("clauses 14 to 16: work lists the In progress initiatives with their slices and lines of work", { timeout: 600000 }, async (context) => {
  const got = await place(context);
  assert.deepEqual(got.work.map((item) => item.initiative), ["retries", "export", "tidy"], "the Work place's In progress group in its order");
  const [retries, exported, tidy] = got.work;
  assert.deepEqual(retries, {
    initiative: "retries", title: "Harden request retries", files: 6, branches: [],
    slices: [
      { slice: "deadline", title: "Retry timed-out requests until a deadline", files: 5, branches: [line("api", "claude/retry-deadline", "main", 5)] },
      { slice: "metrics", title: "Report retry attempts as metrics", files: 2, branches: [line("api", "codex/retry-metrics", "main", 2)] }
    ]
  }, "strategy.ts, deadline.ts, legacy.ts, client.ts, and retries.feature, and metrics.ts, with strategy.ts once");
  assert.deepEqual(exported, {
    initiative: "export", title: "Export activity reports", files: 3, branches: [],
    slices: [{ slice: "download", title: "Download signed reports", files: 3, branches: [line("api", "claude/signed-download", "main", 2), line("api", "claude/signed-download-ui", "main", 1)] }]
  }, "a scope lists the lines of work of the leaves below it");
  assert.deepEqual(tidy, { initiative: "tidy", title: "Tidy retry limits", files: 1, slices: [], branches: [line("api", "claude/tidy", "main", 1)] }, "an initiative without child slices lists its own line of work");
});

test("clause 17: branches lists the lines of work no slice owns that change a file or share no history, newest first", { timeout: 600000 }, async (context) => {
  const got = await place(context);
  const listed = got.branches.map((entry) => `${entry.repository} · ${entry.branch}`);
  assert.deepEqual(listed, ["api · review/deadline", "web · feature/charts", "api · feature/http", "api · release/2026.11", "api · gh-pages"]);
  const release = got.branches.find((entry) => entry.branch === "release/2026.11");
  assert.deepEqual(Object.keys(release).sort(), ["base", "branch", "committedAt", "files", "people", "quiet", "repository"]);
  assert.deepEqual([release.base, release.files, release.people, release.quiet], ["main", 1, { last: "Sam Ortiz", count: 1 }, false]);
  const pages = got.branches.find((entry) => entry.branch === "gh-pages");
  assert.deepEqual([pages.base, pages.files], [null, null], "a branch that shares no history is listed with no base");
  assert.equal(listed.includes("api · feature/empty"), false, "a branch that changes no file is left out");
  assert.equal(listed.includes("api · claude/tidy"), false, "an owned branch is left out");
  assert.equal(listed.some((entry) => entry.endsWith(" · main")), false, "a default branch is no line of work");
  const times = got.branches.map((entry) => Date.parse(entry.committedAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test("clauses 17 and 18: a quiet branch is left out and counted unless the request shows quiet branches", { timeout: 600000 }, async (context) => {
  const hidden = await place(context);
  assert.deepEqual(hidden.quiet, { hidden: 1, days: 30 });
  assert.equal(hidden.branches.some((entry) => entry.branch === "old/experiment"), false);
  const shown = await place(context, "?showQuiet=true");
  assert.deepEqual(shown.quiet, { hidden: 0, days: 30 });
  const old = shown.branches.find((entry) => entry.branch === "old/experiment");
  assert.deepEqual([old.quiet, old.files, old.people], [true, 1, { last: "Ana Ruiz", count: 1 }]);
  assert.equal(shown.lines, hidden.lines + 1);
  const longer = await place(context, "?quietDays=40");
  assert.deepEqual(longer.quiet, { hidden: 0, days: 40 });
  assert.equal(longer.branches.find((entry) => entry.branch === "old/experiment")?.quiet, false);
});

test("clause 11: the place answer refuses a threshold or a show choice it cannot read", { timeout: 600000 }, async (context) => {
  const { api } = await workspace();
  await place(context);
  for (const query of ["quietDays=0", "quietDays=400", "showQuiet=yes", "showQuiet=1"]) {
    const refused = await api(`place?${query}`);
    assert.deepEqual([refused.status, refused.json?.code], [400, "invalid_request"], query);
  }
});

test("clause 14: a designed initiative that nobody started is not listed as work", { timeout: 600000 }, async (context) => {
  const { owner } = await workspace();
  const { server: prism } = owner;
  const call = async (name, args) => ok(await prism.call(name, args));
  await call("update_initiative", { initiative: "later", expectedRevision: null, operations: [{ op: "create", slug: "later", title: "Later work", requirements: ["docs/requirements/code.md#1"] }] });
  await call("update_roadmap", { expectedRevision: (await call("get_roadmap", {})).revision, operations: [{ op: "add_initiative", id: "later", title: "Later work", intent: "Later.", band: "Next" }] });
  const got = await place(context);
  assert.equal(got.work.some((item) => item.initiative === "later"), false);
});

test("clause 13: a push to a line of work changes the answer at the next fetch", { timeout: 600000 }, async (context) => {
  const { owner, ready } = await workspace();
  git(owner.root, "checkout", "-q", "claude/tidy");
  await commitWork(owner.root, { title: "more tidying", files: { "src/retry/limits.ts": "export const limit = 5_000;\n" } });
  git(owner.root, "push", "-q", "origin", "claude/tidy");
  git(owner.root, "checkout", "-q", "main");
  const tidy = await eventually(async () => {
    const got = await ready("place");
    const item = got.json?.work?.find((entry) => entry.initiative === "tidy");
    return item?.files === 2 ? item : null;
  }, 20000, "the pushed file in the tidy line of work");
  assert.deepEqual(tidy.branches, [line("api", "claude/tidy", "main", 2)]);
});
