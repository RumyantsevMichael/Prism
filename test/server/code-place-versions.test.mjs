import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { blobOf, eventually, git, isolateGit } from "./fixtures/workspace-view.mjs";
import { DEADLINE_STRATEGY, METRICS_STRATEGY, STRATEGY, TIDY_STRATEGY, applySteps, codePlaceWorkspace, commitWork, edited, startedWork } from "./fixtures/code-place.mjs";

// Requirements: docs/requirements/code-place.md §2, §9, §15 to §20, §22, §23, §25, §26, §31.
// Contract: docs/plans/code-place/slice.md clauses 26 to 39, through GET ./api/code/files, versions, and diff of a workspace page.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const cleanups = [];
const suite = { after: (cleanup) => cleanups.push(cleanup) };
test.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
let shared = null;
const workspace = () => (shared ??= codePlaceWorkspace(suite));
const TIMEOUT = { timeout: 600000 };

async function get(route) {
  const got = await (await workspace()).ready(route);
  assert.equal(got.status, 200, `${route}: ${got.body}`);
  return got.json;
}
const files = (scope, folder, query = "") => get(`files?scope=${encodeURIComponent(scope)}${folder === null ? "" : `&folder=${encodeURIComponent(folder)}`}${query}`);
const versions = (scope, repository, file, query = "") => get(`versions?scope=${encodeURIComponent(scope)}&repository=${repository}&path=${encodeURIComponent(file)}${query}`);
const entry = (listing, file) => listing.entries.find((item) => item.path === file);

test("clause 27: without a folder the tree's top level lists every repository with its state and root component", TIMEOUT, async () => {
  const got = await files("all", null);
  assert.equal(got.scope, "all");
  assert.deepEqual(got.entries.map(({ path: name, type, state }) => [name, type, state]), [["api", "repository", "on"], ["infra", "repository", "on"], ["mobile", "repository", "off"], ["web", "repository", "on"]]);
  assert.deepEqual(entry(got, "infra").components, [{ name: "infra", branches: 1, declaredOn: [] }], "infra declares no component, so its root component is on its row");
  assert.deepEqual(entry(got, "web").components, [], "web declares its components on folders");
  assert.deepEqual(entry(got, "mobile").components, []);
});

test("clauses 27 to 29: a folder lists the default branch's entries and what shown versions add, with each file's change", TIMEOUT, async () => {
  const retry = await files("all", "api/src/retry");
  assert.deepEqual(retry.entries.map((item) => [item.path, item.type]), [["api/src/retry/backoff.ts", "file"], ["api/src/retry/deadline.ts", "file"], ["api/src/retry/legacy.ts", "file"], ["api/src/retry/metrics.ts", "file"], ["api/src/retry/strategy.ts", "file"]]);
  assert.deepEqual(entry(retry, "api/src/retry/strategy.ts").change, { kind: "changed", versions: 4 }, "the base, the deadline version that review/deadline also holds, metrics, and tidy");
  assert.deepEqual(entry(retry, "api/src/retry/deadline.ts").change, { kind: "new", versions: 2 });
  assert.deepEqual(entry(retry, "api/src/retry/legacy.ts").change, { kind: "removed", versions: 2 });
  assert.equal(entry(retry, "api/src/retry/backoff.ts").change, null, "only the hidden quiet branch changes backoff.ts");
  const src = await files("all", "api/src");
  assert.deepEqual(src.entries.map((item) => [item.path, item.type, item.touched]), [["api/src/http", "folder", true], ["api/src/reports", "folder", true], ["api/src/retry", "folder", true]], "folders first, each holding a changed file");
  const http = await files("all", "api/src/http");
  assert.deepEqual(entry(http, "api/src/http/client.ts").change, { kind: "changed", versions: 3 }, "the base, the deadline slice's version, and feature/http's");
});

test("clause 28: a quiet branch's versions count once quiet branches are shown", TIMEOUT, async () => {
  const retry = await files("all", "api/src/retry", "&showQuiet=true");
  assert.deepEqual(entry(retry, "api/src/retry/backoff.ts").change, { kind: "changed", versions: 2 });
});

test("clause 26: a narrowed scope shows only its lines of work's versions and the files they add", TIMEOUT, async () => {
  const metrics = await files("work:retries/metrics", "api/src/retry");
  assert.equal(metrics.scope, "work:retries/metrics");
  assert.deepEqual(metrics.entries.map((item) => item.path), ["api/src/retry/backoff.ts", "api/src/retry/legacy.ts", "api/src/retry/metrics.ts", "api/src/retry/strategy.ts"], "deadline.ts is added only by a line of work this scope does not show");
  assert.deepEqual(entry(metrics, "api/src/retry/strategy.ts").change, { kind: "changed", versions: 2 });
  assert.equal(entry(metrics, "api/src/retry/legacy.ts").change, null);
  const retries = await files("work:retries", "api/src/retry");
  assert.deepEqual(entry(retries, "api/src/retry/strategy.ts").change, { kind: "changed", versions: 3 }, "a work item shows each of its slices' versions");
  const http = await files("branch:api/feature/http", "api/src/http");
  assert.deepEqual(entry(http, "api/src/http/client.ts").change, { kind: "changed", versions: 2 });
  const top = await files("branch:api/feature/http", "api/src");
  assert.deepEqual(top.entries.map((item) => [item.path, item.touched]), [["api/src/http", true], ["api/src/retry", false]]);
});

test("clause 26: a scope that the place does not list is refused", TIMEOUT, async () => {
  const { api } = await workspace();
  await files("all", null);
  for (const scope of ["work:nothing", "work:retries/nothing", "branch:api/nothing", "branch:api/main", "everything"]) {
    const refused = await api(`files?scope=${encodeURIComponent(scope)}&folder=api`);
    assert.deepEqual([refused.status, refused.json?.code], [404, "scope_unknown"], scope);
  }
});

test("clause 30: people names each agent and person behind a file's versions, and a folder's people cover its files", TIMEOUT, async () => {
  const retry = await files("all", "api/src/retry");
  const people = entry(retry, "api/src/retry/strategy.ts").people;
  assert.deepEqual(people.filter((mark) => mark.kind === "person"), [{ kind: "person", name: "Dana Kim" }]);
  assert.ok(people.some((mark) => mark.kind === "agent" && typeof mark.name === "string" && mark.name), "the slices' claim holders show as their agent");
  assert.equal(new Set(people.map((mark) => `${mark.kind}\0${mark.name}`)).size, people.length, "each mark once");
  const src = await files("all", "api/src");
  assert.ok(entry(src, "api/src/http").people.some((mark) => mark.kind === "person" && mark.name === "Dana Kim"), "feature/http's change of client.ts shows on its folder");
});

test("clause 31: a component that only some shown branches declare names them", TIMEOUT, async () => {
  const packages = await files("all", "web/packages");
  assert.deepEqual(packages.entries.map((item) => item.path), ["web/packages/charts", "web/packages/reports", "web/packages/shell"]);
  assert.deepEqual(entry(packages, "web/packages/charts").components, [{ name: "charts", branches: 1, declaredOn: ["feature/charts"] }]);
  assert.deepEqual(entry(packages, "web/packages/reports").components, [{ name: "report-ui", branches: 2, declaredOn: [] }]);
  assert.equal(entry(packages, "web/packages/charts").touched, true);
});

test("clauses 32 to 34: a file shows its base and one version per distinct content, labelled with its owners, people, counts, and verification", TIMEOUT, async () => {
  const got = await versions("all", "api", "src/retry/strategy.ts");
  assert.deepEqual([got.repository, got.path], ["api", "src/retry/strategy.ts"]);
  assert.deepEqual(got.bases, [{ branch: "main", blob: blobOf(STRATEGY) }]);
  assert.deepEqual(got.versions.map((version) => version.blob), [blobOf(DEADLINE_STRATEGY), blobOf(METRICS_STRATEGY), blobOf(TIDY_STRATEGY)], "owned versions in sidebar order");
  const [deadline, metrics, tidy] = got.versions;
  assert.deepEqual(deadline.branches, [{ repository: "api", branch: "claude/retry-deadline", base: "main" }, { repository: "api", branch: "review/deadline", base: "main" }], "identical content on two branches is one version");
  assert.deepEqual(deadline.owners.map(({ initiative, slice, title }) => [initiative, slice, title]), [["retries", "deadline", "Retry timed-out requests until a deadline"]]);
  assert.equal(typeof deadline.owners[0].agent, "string");
  assert.deepEqual(deadline.people, [{ kind: "person", name: "Dana Kim" }], "the colleague's branch that holds the same content");
  assert.deepEqual([deadline.added, deadline.removed, deadline.verified], [3, 2, true]);
  assert.deepEqual([metrics.added, metrics.removed, metrics.verified], [4, 3, true]);
  assert.deepEqual([tidy.added, tidy.removed, tidy.verified], [1, 1, true]);
  for (const version of got.versions) {
    const rows = (await get(`diff?repository=api&path=src/retry/strategy.ts&branch=${encodeURIComponent(version.branches[0].branch)}`)).rows;
    assert.deepEqual([version.added, version.removed], [rows.filter((row) => row.op === "add").length, rows.filter((row) => row.op === "del").length], `${version.branches[0].branch}: the counts are the difference's rows`);
  }
  assert.equal(typeof deadline.id, "string");
  assert.equal(new Set(got.versions.map((version) => version.id)).size, 3);
});

test("clause 32: a new file's base is absent and a removed file's version is a removal", TIMEOUT, async () => {
  const added = await versions("all", "api", "src/retry/deadline.ts");
  assert.deepEqual(added.bases, [{ branch: "main", blob: null }]);
  assert.deepEqual(added.versions.map((version) => [version.blob, version.added, version.removed]), [[blobOf("export const deadlineMs = 10_000;\n"), 1, 0]]);
  const removed = await versions("all", "api", "src/retry/legacy.ts");
  assert.deepEqual(removed.versions.map((version) => [version.blob, version.added, version.removed]), [[null, 0, 1]]);
  const untouched = await versions("all", "api", "package.json");
  assert.deepEqual(untouched.versions.map((version) => version.branches.map((branch) => branch.branch)), [["release/2026.11"]]);
  assert.equal(untouched.versions[0].verified, false, "no run verified a branch nobody owns");
  assert.deepEqual(untouched.versions[0].people, [{ kind: "person", name: "Sam Ortiz" }]);
});

test("clause 35: two versions that change overlapping lines of one base conflict, and far-apart changes do not", TIMEOUT, async () => {
  const got = await versions("all", "api", "src/retry/strategy.ts");
  const [deadline, metrics] = got.versions;
  assert.deepEqual(got.conflicts, [
    { version: deadline.id, with: [{ version: metrics.id, lines: { own: [[2, 2], [4, 4]], other: [[2, 4]] } }], more: 0, complete: true },
    { version: metrics.id, with: [{ version: deadline.id, lines: { own: [[2, 4]], other: [[2, 2], [4, 4]] } }], more: 0, complete: true }
  ], "each conflicting version names the other, and the versions that change far-apart lines have no entry");
  const narrowed = await versions("work:retries/deadline", "api", "src/retry/strategy.ts");
  assert.deepEqual(narrowed.conflicts, [], "a narrowed file shows only its own version, so nothing conflicts");
});

test("clause 36: a version's difference covers the whole file with the line numbers at its fork and its tip", TIMEOUT, async () => {
  const { remotes } = await workspace();
  const got = await get("diff?repository=api&path=src/retry/strategy.ts&branch=claude/retry-deadline");
  assert.deepEqual([got.repository, got.path, got.branch, got.base], ["api", "src/retry/strategy.ts", "claude/retry-deadline", "main"]);
  assert.equal(got.fork, git(remotes.api.bare, "merge-base", "claude/retry-deadline", "main"));
  assert.deepEqual(got.rows.slice(0, 8), [
    { op: "same", before: 1, after: 1, text: "export class RequestRetryStrategy {" },
    { op: "del", before: 2, after: null, text: "  constructor(private attempts = 3) {}" },
    { op: "add", before: null, after: 2, text: "  constructor(private attempts = 3, private deadlineMs = 10_000) {}" },
    { op: "same", before: 3, after: 3, text: "" },
    { op: "del", before: 4, after: null, text: "  shouldRetry(error: Error, attempt: number) {" },
    { op: "add", before: null, after: 4, text: "  shouldRetry(error: Error, attempt: number, elapsedMs: number) {" },
    { op: "add", before: null, after: 5, text: "    if (elapsedMs >= this.deadlineMs) return false;" },
    { op: "same", before: 5, after: 6, text: "    return attempt < this.attempts && error.name === \"TimeoutError\";" }
  ]);
  assert.equal(got.rows.length, 14);
  assert.deepEqual(got.rows.at(-1), { op: "same", before: 11, after: 12, text: "}" });
  const base = await get("diff?repository=api&path=src/retry/strategy.ts&branch=main");
  assert.equal(base.rows.length, 11);
  assert.ok(base.rows.every((row, index) => row.op === "same" && row.before === index + 1 && row.after === index + 1));
  const added = await get("diff?repository=api&path=src/retry/deadline.ts&branch=claude/retry-deadline");
  assert.deepEqual(added.rows, [{ op: "add", before: null, after: 1, text: "export const deadlineMs = 10_000;" }]);
  const removed = await get("diff?repository=api&path=src/retry/legacy.ts&branch=claude/retry-deadline");
  assert.deepEqual(removed.rows, [{ op: "del", before: 1, after: null, text: "export const legacy = true;" }]);
});

test("clause 37: a secret, a binary file, and a path neither commit holds are not shown", TIMEOUT, async () => {
  const { api } = await workspace();
  await files("all", null);
  const secret = await api("diff?repository=api&path=.env&branch=main");
  assert.deepEqual([secret.status, secret.json?.code], [404, "file_unavailable"]);
  assert.doesNotMatch(secret.body, /secret-token-of-api/);
  const binary = await api("diff?repository=api&path=assets/logo.bin&branch=main");
  assert.deepEqual([binary.status, binary.json?.code, binary.json?.reason], [404, "file_not_shown", "binary"]);
  const missing = await api("diff?repository=api&path=src/none.ts&branch=claude/retry-deadline");
  assert.deepEqual([missing.status, missing.json?.code], [404, "file_unavailable"]);
  const secretVersions = await api("versions?scope=all&repository=api&path=.env");
  assert.deepEqual([secretVersions.status, secretVersions.json?.code], [404, "file_unavailable"]);
  const listed = await files("all", "api");
  assert.equal(entry(listed, "api/.env"), undefined, "the tree lists no secret");
});

test("clause 38: no Code request leaves file content or a difference in the record store", TIMEOUT, async () => {
  const { store } = await workspace();
  await versions("all", "api", "src/retry/strategy.ts");
  await get("diff?repository=api&path=src/retry/strategy.ts&branch=claude/retry-deadline");
  const commits = git(store.bare, "rev-list", "--all").split("\n").filter(Boolean);
  for (const needle of ["deadlineMs", "RequestRetryStrategy", "secret-token-of-api"]) {
    let found = "";
    try { found = execFileSync("git", ["grep", "-l", "-F", needle, ...commits], { cwd: store.bare, stdio: "pipe" }).toString(); } catch (error) { if (error.status !== 1) throw error; }
    assert.equal(found, "", `the store holds no file with ${needle}`);
  }
});

test("clauses 33 and 39: a push after verification makes the new version unverified at the next fetch, counted as Git counts its difference", TIMEOUT, async () => {
  const { owner } = await workspace();
  git(owner.root, "checkout", "-q", "claude/tidy");
  // Line 9 stays changed, line 10 stays as it is, and a line follows it, so Git counts one changed line and one added line, two hunks with an unchanged line between.
  const later = edited(TIDY_STRATEGY, { 10: ["  }", "  // tidied"] });
  await writeFile(path.join(owner.root, "src/retry/strategy.ts"), later);
  await commitWork(owner.root, { title: "tidy more" });
  git(owner.root, "push", "-q", "origin", "claude/tidy");
  git(owner.root, "checkout", "-q", "main");
  const tidy = await eventually(async () => {
    const got = await (await workspace()).ready("versions?scope=all&repository=api&path=src%2Fretry%2Fstrategy.ts");
    return got.json?.versions?.find((version) => version.blob === blobOf(later)) ?? null;
  }, 20000, "the pushed version of strategy.ts");
  assert.equal(tidy.verified, false, "no passing run recorded the pushed blob");
  assert.deepEqual([tidy.added, tidy.removed], [2, 1], "an insertion after an unchanged line is not joined to the change before it");
  const rows = (await get("diff?repository=api&path=src/retry/strategy.ts&branch=claude%2Ftidy")).rows;
  assert.deepEqual([tidy.added, tidy.removed], [rows.filter((row) => row.op === "add").length, rows.filter((row) => row.op === "del").length], "the counts are the difference's rows");
});

// It runs after the clauses' own tests, since it adds a work item and a commit of the default branch to the shared workspace.
test("clauses 14 and 26: an In progress work item that changes no code yet is a listed scope whose files and versions change nothing", TIMEOUT, async () => {
  const { owner } = await workspace();
  await startedWork(owner, { initiative: "waiting", title: "Wait for retry budgets" });
  const listed = await eventually(async () => (await (await workspace()).ready("place")).json?.work?.find((item) => item.initiative === "waiting") ?? null, 20000, "the started work item in the place's work");
  assert.deepEqual(listed, { initiative: "waiting", title: "Wait for retry budgets", files: 0, slices: [], branches: [] }, "the place lists the work item with nothing changed");
  const top = await files("work:waiting", null);
  assert.equal(top.scope, "work:waiting");
  assert.deepEqual(top.entries.map(({ path: name, type, state }) => [name, type, state]), [["api", "repository", "on"], ["infra", "repository", "on"], ["mobile", "repository", "off"], ["web", "repository", "on"]]);
  const src = await files("work:waiting", "api/src");
  assert.deepEqual(src.entries.map((item) => [item.path, item.touched]), [["api/src/http", false], ["api/src/retry", false]], "no folder holds a changed file");
  const retry = await files("work:waiting", "api/src/retry");
  assert.deepEqual(retry.entries.map((item) => [item.path, item.change]), [["api/src/retry/backoff.ts", null], ["api/src/retry/legacy.ts", null], ["api/src/retry/strategy.ts", null]], "the default branch's entries only, none changed");
  assert.ok(retry.entries.every((item) => item.people.length === 0));
  const strategy = await versions("work:waiting", "api", "src/retry/strategy.ts");
  assert.deepEqual([strategy.bases, strategy.versions, strategy.conflicts], [[{ branch: "main", blob: blobOf(STRATEGY) }], [], []], "only the base");
  const { api } = await workspace();
  const refused = await api(`files?scope=${encodeURIComponent("work:waiting/nothing")}&folder=api`);
  assert.deepEqual([refused.status, refused.json?.code], [404, "scope_unknown"], "a slice the place does not list stays unknown");
});

// It runs after the others, since its branches join every later answer of the shared workspace.
test("clause 35: each of many versions that change the same lines names at most 16 others and counts the rest, so the answer grows with the versions, not with their pairs", TIMEOUT, async () => {
  const { owner } = await workspace();
  const crowd = Array.from({ length: 34 }, (_, index) => `crowd/${String(index).padStart(2, "0")}`);
  await applySteps(owner.root, crowd.map((branch, index) => ({ branch, author: "Lee Park", days: 1, files: { "src/retry/backoff.ts": `export const backoff = (attempt: number) => attempt * ${101 + index};\n` } })));
  const got = await eventually(async () => {
    const answer = await (await workspace()).ready("versions?scope=all&repository=api&path=src%2Fretry%2Fbackoff.ts");
    return answer.json?.versions?.length === crowd.length ? answer.json : null;
  }, 60000, "the 34 pushed versions of backoff.ts");
  const ids = got.versions.map((version) => version.id);
  assert.deepEqual(got.conflicts.map((entry) => entry.version), ids, "every version changes line 1 of the same base, so each has an entry, in the order of clause 34");
  for (const entry of got.conflicts) {
    const others = ids.filter((id) => id !== entry.version);
    assert.deepEqual(entry.with.map((other) => other.version), others.slice(0, 16), "it names the first 16 other versions in the order of clause 34");
    assert.equal(entry.more, others.length - 16, "and counts the 17 it leaves out");
    assert.equal(entry.complete, true);
    assert.ok(entry.with.every((other) => JSON.stringify(other.lines) === JSON.stringify({ own: [[1, 1]], other: [[1, 1]] })));
  }
});

// It runs after the others but one, since it moves the default branch of the shared workspace.
test("clause 35: a pair of versions that change many of the same lines names at most 8 ranges a side, the 8th reaching to the last", TIMEOUT, async () => {
  const { owner } = await workspace();
  const wide = (mark) => Array.from({ length: 400 }, (_, index) => (mark && index % 4 === 0 ? `${mark} ${index + 1}` : `line ${index + 1}`)).join("\n") + "\n";
  await applySteps(owner.root, [
    { branch: "main", files: { "src/retry/wide.ts": wide(null) }, message: "add wide.ts" },
    { branch: "wide/a", author: "Lee Park", files: { "src/retry/wide.ts": wide("a") } },
    { branch: "wide/b", author: "Ana Ruiz", files: { "src/retry/wide.ts": wide("b") } }
  ]);
  const got = await eventually(async () => {
    const answer = await (await workspace()).ready("versions?scope=all&repository=api&path=src%2Fretry%2Fwide.ts");
    return answer.json?.versions?.length === 2 ? answer.json : null;
  }, 60000, "the two pushed versions of wide.ts");
  const [first, second] = got.versions.map((version) => version.id);
  // Each version changes the 100 lines 1, 5, 9, ..., 397, so each has 100 ranges that all meet the other's.
  const ranges = [[1, 1], [5, 5], [9, 9], [13, 13], [17, 17], [21, 21], [25, 25], [29, 397]];
  assert.deepEqual(got.conflicts, [
    { version: first, with: [{ version: second, lines: { own: ranges, other: ranges } }], more: 0, complete: true },
    { version: second, with: [{ version: first, lines: { own: ranges, other: ranges } }], more: 0, complete: true }
  ]);
});

// It runs last, since it pushes branches to web and api and moves their remotes away for a while.
// Windows refuses to rename a folder that a running Git process works in, as the server's fetch of a code remote does for a moment, so the rename is tried again for a while.
async function moveFolder(from, to) {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (!["EBUSY", "EPERM", "EACCES"].includes(error.code) || Date.now() > deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("clauses 27 and 37: a read that fails while a remote is away answers 503 read_failed for that repository only, is kept nowhere, and is read again on a later request", TIMEOUT, async () => {
  const { api, owner, remotes } = await workspace();
  const NAV_WORKFLOW = "## Components\n- report-ui: packages/reports\n- shell: packages/shell\n- nav: packages/nav\n";
  const JITTER = "export const jitter = (delay: number) => delay * Math.random();\n";
  // Reading first fetches every blob that the tree's marks and strategy.ts's versions need of the branches so far.
  await files("all", null);
  await files("all", "api/src/retry");
  await versions("all", "api", "src/retry/strategy.ts");
  // Each branch brings a blob that the blobless clones have never fetched: web's .prism/workflow.md of feature/nav, and api's new jitter.ts of feature/jitter.
  await applySteps(remotes.web.work, [{ branch: "feature/nav", author: "Lee Park", files: { ".prism/workflow.md": NAV_WORKFLOW, "packages/nav/menu.ts": "menu\n" } }]);
  await applySteps(owner.root, [{ branch: "feature/jitter", author: "Lee Park", files: { "src/retry/jitter.ts": JITTER } }]);
  // The place reads commits and trees only, so waiting for it fetches the new tips and none of their blobs.
  await eventually(async () => {
    const place = (await (await workspace()).ready("place")).json;
    return ["feature/nav", "feature/jitter"].every((name) => place?.branches?.some((line) => line.branch === name)) ? place : null;
  }, 60000, "the pushed branches feature/nav and feature/jitter");
  const away = (name) => `${remotes[name].bare}.away`;
  await moveFolder(remotes.web.bare, away("web"));
  await moveFolder(remotes.api.bare, away("api"));
  try {
    const top = await files("all", null);
    assert.deepEqual(top.entries.map(({ path: name, error }) => [name, error?.code ?? null]), [["api", null], ["infra", null], ["mobile", null], ["web", "read_failed"]], "only web, whose new .prism/workflow.md cannot be read, is marked, and the other repositories answer");
    const web = entry(top, "web");
    assert.deepEqual(web.components, [], "a failed repository's entry lists no component");
    assert.match(web.error.message, /\bweb\b/, "the mark names the repository");
    assert.deepEqual(entry(top, "infra").components, [{ name: "infra", branches: 1, declaredOn: [] }], "a repository that reads answers as usual beside the failed one");
    assert.ok(top.entries.filter((item) => item.path !== "web").every((item) => item.error === null), "every other entry's error is null");
    const folder = await api(`files?scope=all&folder=${encodeURIComponent("web/packages")}`);
    assert.deepEqual([folder.status, folder.json?.code], [503, "read_failed"], "a folder of the failed repository answers 503");
    const retry = await files("all", "api/src/retry");
    assert.deepEqual(entry(retry, "api/src/retry/jitter.ts").change, { kind: "new", versions: 2 }, "api's tree reads commits and trees only, so it answers while api's remote is away");
    const failed = await (await workspace()).ready("versions?scope=all&repository=api&path=src%2Fretry%2Fjitter.ts");
    assert.deepEqual([failed.status, failed.json?.code], [503, "read_failed"], `a version whose blob cannot be read answers 503, never 404: ${failed.body}`);
    assert.match(failed.json.message, /\bapi\b/);
    const diff = await api("diff?repository=api&path=src%2Fretry%2Fjitter.ts&branch=feature%2Fjitter");
    assert.deepEqual([diff.status, diff.json?.code], [503, "read_failed"], diff.body);
    const again = await (await workspace()).ready("versions?scope=all&repository=api&path=src%2Fretry%2Fjitter.ts");
    assert.deepEqual([again.status, again.json?.code], [503, "read_failed"], "while the remote stays away, each request reads again and fails again");
    const strategy = await versions("all", "api", "src/retry/strategy.ts");
    assert.equal(strategy.versions.length, 3, "a file whose blobs the clone holds answers 200 while the same repository's remote is away");
  } finally {
    await moveFolder(away("web"), remotes.web.bare);
    await moveFolder(away("api"), remotes.api.bare);
  }
  // The first request after the remotes return reads again, since no answer, blob, count, or difference of a failed read was kept.
  const top = await files("all", null);
  assert.ok(top.entries.every((item) => item.error === null), "no entry is marked once web reads again");
  const packages = await files("all", "web/packages");
  assert.deepEqual(entry(packages, "web/packages/nav").components, [{ name: "nav", branches: 1, declaredOn: ["feature/nav"] }], "web's new component shows once its declaration reads");
  const jitter = await versions("all", "api", "src/retry/jitter.ts");
  assert.deepEqual(jitter.versions.map((version) => [version.branches[0].branch, version.added, version.removed]), [["feature/jitter", 1, 0]]);
  const rows = (await get("diff?repository=api&path=src%2Fretry%2Fjitter.ts&branch=feature%2Fjitter")).rows;
  assert.deepEqual(rows, [{ op: "add", before: null, after: 1, text: "export const jitter = (delay: number) => delay * Math.random();" }]);
});
