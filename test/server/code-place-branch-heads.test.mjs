import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { git, isolateGit } from "./fixtures/workspace-view.mjs";

// A code clone's branch model is never kept from a read in which Git could not read HEAD or list the branches, as while another Git process rewrites HEAD on Windows,
// so the next request reads the clone again rather than showing a repository with no default branch until its tips move.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { byCodePoint, createBranchReader, readBranchFacts, tipsKeyOf } = await import("../../dist/server/review/code-branches.mjs");
const { runGit, runGitLines } = await import("../../dist/server/workflow/record-store-sync.mjs");

// A bare repository with main and one branch from it, each holding one empty commit.
function repository(label) {
  const folder = path.join(environment, label);
  git(environment, "init", "-q", "--bare", "-b", "main", folder);
  const commit = (ref, mark, from) => `commit refs/heads/${ref}\nmark :${mark}\ncommitter Prism Test <test@example.invalid> ${1700000000 + mark} +0000\ndata 4\nc ${mark}\n${from ? `from :${from}\n` : ""}`;
  execFileSync("git", ["-C", folder, "fast-import", "--quiet"], { input: commit("main", 1) + commit("work", 2, 1) });
  return folder;
}

// A Git runner like the review app's, whose first `failing` commands that start with the named Git subcommand fail as an unreadable file makes Git fail.
function flakyGit(folder, subcommand, failing) {
  let left = failing;
  return (args, { line, maxRecord, input } = {}) => {
    if (args[0] === subcommand && left > 0) {
      left -= 1;
      return Promise.resolve({ ok: false, code: 128, missing: false, stdout: Buffer.alloc(0), text: "", stderr: "fatal: unable to read HEAD" });
    }
    if (!line) return runGit(folder, args, input === undefined ? {} : { input });
    return runGitLines(folder, args, { input, ...(maxRecord ? { maxRecord } : {}), take: line });
  };
}

const keyOf = (folder) => {
  const branches = git(folder, "for-each-ref", "--format=%(refname:strip=2) %(objectname)", "refs/heads/").split("\n").filter(Boolean)
    .map((line) => { const [name, commit] = line.split(" "); return { name, commit }; }).sort((left, right) => byCodePoint(left.name, right.name));
  return tipsKeyOf(git(folder, "symbolic-ref", "HEAD"), branches);
};

for (const subcommand of ["symbolic-ref", "for-each-ref"]) {
  test(`facts whose ${subcommand} fails throw rather than answer a clone with no default branch`, async () => {
    const folder = repository(`facts-${subcommand}`);
    await assert.rejects(readBranchFacts(flakyGit(folder, subcommand, 1)), /Git could not/);
    const facts = await readBranchFacts(flakyGit(folder, subcommand, 0));
    assert.equal(facts.defaultBranch, "main");
  });

  test(`a branch read whose ${subcommand} fails keeps no answer, and the next request reads the clone's default branch and branches`, async () => {
    const folder = repository(`reader-${subcommand}`);
    const reader = createBranchReader(flakyGit(folder, subcommand, 1));
    const key = keyOf(folder);
    assert.equal(reader.answer(key, []), undefined, "the first request waits for its read");
    await reader.idle();
    assert.equal(reader.answer(key, []), undefined, "the failed read kept no answer, so the request reads again");
    await reader.idle();
    const model = reader.answer(key, []);
    assert.equal(model?.defaultBranch, "main", JSON.stringify(model));
    assert.deepEqual(model.branches.map((branch) => branch.name).sort(byCodePoint), ["main", "work"]);
  });
}
