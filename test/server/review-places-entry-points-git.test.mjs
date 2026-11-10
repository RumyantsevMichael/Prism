import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// How Touched by my work and Changed this week use Git: recorded values never reach Git as options, merges count, and a failing Git says so.

const DIST = process.env.PRISM_ENTRY_POINTS_DIST ?? path.join(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const load = (relative) => import(pathToFileURL(path.join(DIST, relative)).href);
const DAY = 24 * 60 * 60 * 1000;

async function scratch(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-entry-points-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(root, args, { author = "Old Author", daysAgo = 30 } = {}) {
  const date = new Date(Date.now() - daysAgo * DAY).toISOString();
  return execFileSync("git", ["-c", `user.name=${author}`, "-c", "user.email=author@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  });
}

async function write(root, relative, text) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), text);
}

// A project whose slice evil/s1 records a start tree for its design and has a passing verification run that tested a recorded tree.
// `trees` is given the scratch folder and the project with its first commit, and answers the two recorded values.
async function recordedTrees(context, trees) {
  const root = await scratch(context);
  const project = path.join(root, "project");
  await mkdir(project);
  git(project, ["init", "-q"]);
  await write(project, "README.md", "# Project\n");
  git(project, ["add", "README.md"]);
  git(project, ["commit", "-q", "-m", "Start"]);
  const [startTree, runTree] = await trees({ root, project });
  await write(project, ".prism/initiatives/evil/initiative.json", JSON.stringify({ schemaVersion: 1, id: "evil", history: [], slices: {
    evil: { title: "Evil", outcome: "o", status: "in-progress", requirements: [], dependencies: [] },
    s1: { title: "S1", outcome: "o", status: "in-progress", parent: "evil", requirements: [], dependencies: [], design: { startTree } }
  } }));
  await write(project, ".prism/initiatives/evil/slices/s1/runs/verification-001794266352196-6dd590.json", JSON.stringify({ kind: "verification", passed: true, tree: runTree }));
  return { root, project };
}

for (const [name, start, run] of [["start tree", (out) => `--output=${out}`, () => "HEAD"], ["verified tree", () => "HEAD", (out) => `--output=${out}`]]) {
  test(`Touched by my work never hands an option-shaped recorded ${name} to Git`, { timeout: 60000 }, async (context) => {
    const { root, project } = await recordedTrees(context, ({ root: folder }) => [start(path.join(folder, "written.txt")), run(path.join(folder, "written.txt"))]);
    const { touchedRecords } = await load("server/review/touched-records.mjs");
    const answer = await touchedRecords(project, "evil/s1");
    assert.deepEqual(await readdir(root), ["project"], "no file was written outside the project");
    assert.deepEqual(answer.groups.find((group) => group.reason === "changes").records, []);
    assert.equal(answer.verifiedUnreadable, undefined, "a recorded value that is not a tree means no verified pair rather than an unreadable one");
  });
}

test("clause 57: Touched by my work still lists a record file that the verified result changed between two recorded trees", { timeout: 60000 }, async (context) => {
  const { project } = await recordedTrees(context, async ({ project: folder }) => {
    git(folder, ["add", "-A"]);
    const start = git(folder, ["write-tree"]).trim();
    await write(folder, "docs/requirements/retries.md", "# Retry requirements\n\nStatus: Approved\n\n## 1. Deadline\n\nText.\n");
    git(folder, ["add", "-A"]);
    return [start, git(folder, ["write-tree"]).trim()];
  });
  const { touchedRecords } = await load("server/review/touched-records.mjs");
  const answer = await touchedRecords(project, "evil/s1");
  assert.deepEqual(answer.groups.find((group) => group.reason === "changes").records.map((record) => [record.ref, record.why]), [["docs/requirements/retries.md", ["Changed by the verified result"]]]);
});

test("clause 62: Changed this week counts a record file a merge of this week brought in, at the merge's time and author", { timeout: 60000 }, async (context) => {
  const root = await scratch(context);
  git(root, ["init", "-q"]);
  await write(root, "docs/requirements/a.md", "# A\n");
  await write(root, "docs/requirements/b.md", "# B\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "Start"], { daysAgo: 60 });
  git(root, ["checkout", "-q", "-b", "topic"]);
  await write(root, "docs/requirements/old.md", "# Old\n");
  git(root, ["rm", "-q", "docs/requirements/b.md"]);
  await write(root, "docs/requirements/a.md", "# A\n\nChanged on the branch.\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "Branch work"], { author: "Branch Author", daysAgo: 20 });
  git(root, ["checkout", "-q", "main"]);
  await write(root, "README.md", "# Main\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "Main work"], { daysAgo: 10 });
  git(root, ["merge", "-q", "--no-ff", "-m", "Merge topic", "topic"], { author: "Merge Author", daysAgo: 1 });
  const { recordChanges } = await load("server/review/record-changes.mjs");
  const records = [{ kind: "requirement", title: "A", ref: "docs/requirements/a.md" }, { kind: "requirement", title: "Old", ref: "docs/requirements/old.md" }];
  const result = await recordChanges(root, records, ["docs/requirements"]);
  assert.equal(result.available, true);
  assert.deepEqual(result.records.map((record) => [record.ref, record.author, record.uncommitted]).sort(), [["docs/requirements/a.md", "Merge Author", false], ["docs/requirements/old.md", "Merge Author", false]]);
  assert.ok(Math.abs(Date.parse(result.records[0].at) - (Date.now() - DAY)) < 60 * 60 * 1000, "the merge's time");
});

test("clause 63: a Git that runs but fails after finding a repository with a commit is reported as Git that could not be run", { timeout: 60000 }, async (context) => {
  const root = await scratch(context);
  const project = path.join(root, "project");
  await mkdir(project);
  git(project, ["init", "-q"]);
  await write(project, "docs/requirements/a.md", "# A\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "Start"]);
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = path.join(root, "bin");
  await mkdir(bin);
  // Prism's own arguments come after `-c core.quotePath=false`, so the third argument names the Git command.
  const { recordChanges, UNAVAILABLE } = await load("server/review/record-changes.mjs");
  const records = [{ kind: "requirement", title: "A", ref: "docs/requirements/a.md" }];
  const previous = process.env.PATH;
  context.after(() => { process.env.PATH = previous; });
  for (const command of ["log", "status", "rev-parse"]) {
    await writeFile(path.join(bin, "git"), `#!/bin/sh\nif [ "$3" = "${command}" ]; then echo "fatal: simulated failure" >&2; exit 128; fi\nexec "${real}" "$@"\n`);
    await chmod(path.join(bin, "git"), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${previous}`;
    const result = await recordChanges(project, records, ["docs/requirements"]);
    process.env.PATH = previous;
    assert.equal(result.reason, UNAVAILABLE.noGit, `a failing git ${command}`);
    assert.deepEqual(result.undated.map((record) => record.ref), ["docs/requirements/a.md"]);
  }
  const outside = path.join(root, "outside");
  await mkdir(outside);
  assert.equal((await recordChanges(outside, records, ["docs/requirements"])).reason, UNAVAILABLE.notRepository, "a folder outside every repository still says so");
});

test("Changed this week's count reuses the record libraries the navigation already read", { timeout: 60000 }, async (context) => {
  const root = await scratch(context);
  const { recordFiles } = await load("server/review/workspace-model.mjs");
  const loaded = {
    config: { paths: { requirements: "reqs", adrs: "adrs", glossary: "G.md", plans: "plans" } },
    glossary: { exists: true, path: "G.md" },
    diagrams: [{ name: "flow", path: "plans/x/flow.puml" }],
    requirements: { entries: [{ title: "Given", path: "reqs/given.md", status: "Approved" }] },
    decisions: { entries: [] }
  };
  const { records, pathspecs } = await recordFiles(root, loaded);
  assert.deepEqual(records.map((record) => [record.kind, record.ref]), [["requirement", "reqs/given.md"], ["glossary", "G.md"], ["diagram", "plans/x/flow.puml"]]);
  assert.deepEqual(pathspecs, ["reqs", "adrs", "G.md", "plans"]);
});

test("Changed this week reads Git without taking its optional locks, so the person's index is never rewritten", { timeout: 60000 }, async (context) => {
  const root = await scratch(context);
  git(root, ["init", "-q"]);
  await write(root, "docs/requirements/a.md", "# A\n");
  git(root, ["add", "docs/requirements/a.md"]);
  git(root, ["commit", "-q", "-m", "Add a"]);
  // A file whose time changed but whose content did not is one that a status read with optional locks refreshes in the index.
  const later = new Date(Date.now() + DAY);
  await utimes(path.join(root, "docs/requirements/a.md"), later, later);
  const index = await readFile(path.join(root, ".git/index"));
  const { recordChanges } = await load("server/review/record-changes.mjs");
  const result = await recordChanges(root, [{ kind: "requirement", title: "A", ref: "docs/requirements/a.md" }], ["docs/requirements"]);
  assert.equal(result.available, true);
  assert.deepEqual(await readFile(path.join(root, ".git/index")), index, "the index is left as Git wrote it");
});
