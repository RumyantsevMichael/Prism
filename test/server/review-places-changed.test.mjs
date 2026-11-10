import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { demoProject, serveProject, useAppDirectory } from "./fixtures/kit-browser.mjs";

// Changed this week, read from the review server over the demo, which is a Git repository without a commit.
// The dated case commits every file a month ago, then commits a change to the retry requirements two days ago and a rename of a decision a day ago,
// and leaves the glossary modified and a new requirements file untracked.

const DAY = 24 * 60 * 60 * 1000;
const RECORD_FILES = 9; // four requirements files, three decisions, the glossary, and one diagram

function git(root, args, { author = "Old Author", daysAgo = 30 } = {}) {
  const date = new Date(Date.now() - daysAgo * DAY).toISOString();
  execFileSync("git", ["-c", `user.name=${author}`, "-c", "user.email=author@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: root, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  });
}

async function changed(context, prepare) {
  await useAppDirectory(context);
  const root = await demoProject(context);
  if (prepare) await prepare(root);
  const { base } = await serveProject(context, root);
  return (await fetch(`${base}/api/changed`)).json();
}

test("clauses 61, 62, 64: uncommitted record changes come first, then this week's commits newest first, with their authors, and a rename counts", { timeout: 60000 }, async (context) => {
  const result = await changed(context, async (root) => {
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "Start"]);
    await writeFile(path.join(root, "docs/requirements/retries.md"), "# Retry requirements\n\nStatus: Approved\n\n## 1. Total deadline\n\nChanged.\n");
    git(root, ["commit", "-q", "-am", "Change the retry requirements"], { author: "Ada Lovelace", daysAgo: 2 });
    git(root, ["mv", "docs/ADRs/reporting/signed-exports.md", "docs/ADRs/reporting/sign-exported-reports.md"]);
    git(root, ["commit", "-q", "-m", "Rename a decision"], { author: "Grace Hopper", daysAgo: 1 });
    await writeFile(path.join(root, "docs/Glossary.md"), "# Glossary\n\n| Term | Definition |\n| --- | --- |\n| Retry deadline | Changed. |\n");
    await writeFile(path.join(root, "docs/requirements/billing.md"), "# Billing\n\nStatus: Draft\n");
  });
  assert.equal(result.available, true);
  assert.equal(result.reason, null);
  const uncommitted = result.records.filter((record) => record.uncommitted);
  assert.deepEqual(uncommitted.map((record) => record.ref).sort(), ["docs/Glossary.md", "docs/requirements/billing.md"], "a modified and an untracked record file");
  assert.equal(result.records.findIndex((record) => !record.uncommitted), uncommitted.length, "uncommitted changes come first");
  const committed = result.records.filter((record) => !record.uncommitted);
  assert.deepEqual(committed.map((record) => [record.ref, record.kind, record.title, record.author]), [
    ["docs/ADRs/reporting/sign-exported-reports.md", "decision", "Sign exported reports", "Grace Hopper"],
    ["docs/requirements/retries.md", "requirement", "Retry requirements", "Ada Lovelace"]
  ], "newest first, a rename counting as a change, and the commit of a month ago left out");
  assert.ok(Math.abs(Date.parse(committed[1].at) - (Date.now() - 2 * DAY)) < 60 * 60 * 1000, "the time of the last change");
  assert.deepEqual(result.undated, []);
});

test("clauses 63, 64: a repository without a commit lists nothing as changed and every record file as undated", { timeout: 60000 }, async (context) => {
  const result = await changed(context);
  assert.equal(result.available, false);
  assert.equal(result.reason, "the repository has no commits");
  assert.deepEqual(result.records, []);
  assert.equal(result.undated.length, RECORD_FILES);
  assert.ok(result.undated.some((record) => record.ref === "docs/requirements/retries.md" && record.kind === "requirement" && record.title === "Retry requirements"));
});

test("clause 63: a project that is not a Git repository says so", { timeout: 60000 }, async (context) => {
  const result = await changed(context, (root) => rm(path.join(root, ".git"), { recursive: true, force: true }));
  assert.equal(result.available, false);
  assert.equal(result.reason, "the project is not a Git repository");
  assert.deepEqual(result.records, []);
  assert.equal(result.undated.length, RECORD_FILES);
});

test("clause 63: when Git cannot be run the page says so", { timeout: 60000 }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "Start"]);
  const { base } = await serveProject(context, root);
  const previous = process.env.PATH;
  process.env.PATH = path.join(root, "no-such-bin");
  let result;
  try {
    result = await (await fetch(`${base}/api/changed`)).json();
  } finally {
    process.env.PATH = previous;
  }
  assert.equal(result.available, false);
  assert.equal(result.reason, "Git could not be run");
  assert.deepEqual(result.records, []);
  assert.equal(result.undated.length, RECORD_FILES);
});
