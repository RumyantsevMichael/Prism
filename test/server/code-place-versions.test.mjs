import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { blobOf, eventually, git, isolateGit } from "./fixtures/workspace-view.mjs";
import { DEADLINE_STRATEGY, METRICS_STRATEGY, STRATEGY, TIDY_STRATEGY, codePlaceWorkspace, commitWork, edited } from "./fixtures/code-place.mjs";

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
  assert.deepEqual(got.conflicts, [{ first: deadline.id, second: metrics.id, lines: { first: [[2, 2], [4, 4]], second: [[2, 4]] } }]);
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

test("clauses 33 and 39: a push after verification makes the new version unverified at the next fetch", TIMEOUT, async () => {
  const { owner } = await workspace();
  git(owner.root, "checkout", "-q", "claude/tidy");
  const later = edited(TIDY_STRATEGY, { 10: "  } // tidied" });
  await writeFile(path.join(owner.root, "src/retry/strategy.ts"), later);
  await commitWork(owner.root, { title: "tidy more" });
  git(owner.root, "push", "-q", "origin", "claude/tidy");
  git(owner.root, "checkout", "-q", "main");
  const tidy = await eventually(async () => {
    const got = await (await workspace()).ready("versions?scope=all&repository=api&path=src%2Fretry%2Fstrategy.ts");
    return got.json?.versions?.find((version) => version.blob === blobOf(later)) ?? null;
  }, 20000, "the pushed version of strategy.ts");
  assert.equal(tidy.verified, false, "no passing run recorded the pushed blob");
});
