import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { eventually as waitFor, git, isolateGit } from "./fixtures/workspace-view.mjs";
import { codeWorkspace } from "./fixtures/code-place.mjs";

// Requirements: docs/requirements/code-place.md §7, §20, §25.
// Contract: docs/plans/code-place/slice.md clauses 8 and 12, through GET ./api/code/branches of a workspace page,
// for repositories whose branch count anyone who can push to a registered remote sets.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const WEB = { name: "web", files: { "README.md": "web\n" } };
const INFRA = { name: "infra", files: { "main.tf": "terraform\n" } };
// Most pairs of commits whose commits apart a read counts, for each branch it reads, when no slice owns a branch.
const PAIRS_PER_BRANCH = 36;

// Every Git command of this file and of the app that it starts is traced to one file, so a test can count the commit counts that a read asks Git for.
const trace = path.join(environment, "trace2.txt");
git(environment, "config", "--file", path.join(environment, "gitconfig"), "trace2.normalTarget", trace);
const traced = async () => (await readFile(trace, "utf8").catch(() => "")).split("\n").filter((line) => / start git /.test(line));

// The pairs of commits whose commits apart the traced Git commands from line `from` on counted: a for-each-ref with ahead-behind counts one pair for each of the `refs` branches it lists,
// and a rev-list --count with an excluded commit counts one pair.
async function pairsSince(from, refs) {
  let pairs = 0;
  for (const line of (await traced()).slice(from)) {
    if (/ for-each-ref /.test(line) && /ahead-behind:/.test(line)) pairs += refs;
    else if (/ rev-list /.test(line) && / --count /.test(line) && / '?\^/.test(line)) pairs += 1;
  }
  return pairs;
}

// Write commits straight into a bare remote: each item { name, parent, seconds } becomes refs/heads/<name>, one commit that adds <name>.txt on parent
// (main or an earlier item), committed `seconds` seconds before now, so thousands of branches take a moment.
function importBranches(bare, items) {
  const now = Math.floor(Date.now() / 1000);
  const marks = new Map();
  const main = git(bare, "rev-parse", "main");
  const commands = items.map(({ name, parent, seconds }, index) => {
    marks.set(name, index + 1);
    const from = marks.has(parent) && parent !== name ? `:${marks.get(parent)}` : main;
    const body = `${name}\n`;
    return `commit refs/heads/${name}\nmark :${index + 1}\ncommitter Prism Test <test@example.invalid> ${now - seconds} +0000\ndata ${name.length}\n${name}\nfrom ${from}\nM 100644 inline ${name}.txt\ndata ${body.length}\n${body}\n`;
  });
  execFileSync("git", ["-C", bare, "fast-import", "--quiet"], { input: commands.join(""), maxBuffer: 64 * 1024 * 1024 });
}

// The branches answer of web once it lists `count` branches, waiting up to five minutes, while another Code request of the same app is timed every 20 ms.
async function settled(workspace, count) {
  const slowest = { ms: 0 };
  let reading = true;
  const probe = (async () => {
    while (reading) {
      const started = performance.now();
      assert.equal((await workspace.api("branches?repository=infra")).status, 404);
      slowest.ms = Math.max(slowest.ms, performance.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  let got = null;
  try {
    await waitFor(async () => {
      const answer = await workspace.api("branches?repository=web");
      got = answer.status === 200 ? answer.json : null;
      return got?.branches.length === count;
    }, 300000, `the ${count} branches of web after a fetch`).catch(() => null);
  } finally {
    reading = false;
    await probe;
  }
  return { got, slowest: slowest.ms };
}

test("clause 12: a read of 2000 branches that each start from main counts commits apart for a bounded number of pairs per branch, and other requests answer meanwhile", { timeout: 400000 }, async (context) => {
  const workspace = await codeWorkspace(context, { repositories: [WEB, INFRA], on: ["web"] });
  await workspace.ready("branches?repository=web");
  const count = 2000;
  importBranches(workspace.remotes.web.bare, Array.from({ length: count }, (_, index) => ({ name: `b${String(index).padStart(5, "0")}`, parent: "main", seconds: count - index })));
  const from = (await traced()).length;
  const { got, slowest } = await settled(workspace, count + 1);
  assert.ok(got, "every branch is listed");
  assert.deepEqual([...new Set(got.branches.filter((branch) => !branch.default).map((branch) => `${branch.base} ${branch.files}`))], ["main 1"], "each branch takes main as its base with its one file");
  const pairs = await pairsSince(from, count + 1);
  assert.ok(pairs <= PAIRS_PER_BRANCH * (count + 1), `the read counted commits apart for ${pairs} pairs, more than ${PAIRS_PER_BRANCH} for each of ${count + 1} branches`);
  assert.ok(slowest < 1000, `another request waited ${Math.round(slowest)} ms while the branches were read`);
});

test("clauses 8 and 12: in a chain of 1500 branches, each built on the tip of the one before, each takes the one before as its base within the same bounds", { timeout: 400000 }, async (context) => {
  const workspace = await codeWorkspace(context, { repositories: [WEB, INFRA], on: ["web"] });
  await workspace.ready("branches?repository=web");
  const count = 1500;
  const name = (index) => `c${String(index).padStart(5, "0")}`;
  importBranches(workspace.remotes.web.bare, Array.from({ length: count }, (_, index) => ({ name: name(index), parent: index === 0 ? "main" : name(index - 1), seconds: count - index })));
  const from = (await traced()).length;
  const { got, slowest } = await settled(workspace, count + 1);
  assert.ok(got, "the chain is read");
  const byName = new Map(got.branches.map((branch) => [branch.name, branch]));
  assert.deepEqual([byName.get(name(0)).base, byName.get(name(0)).files], ["main", 1]);
  const wrong = [];
  for (let index = 1; index < count; index += 1) {
    const branch = byName.get(name(index));
    if (branch.base !== name(index - 1) || branch.files !== 1) wrong.push(`${branch.name}: ${branch.base} ${branch.files}`);
  }
  assert.deepEqual(wrong.slice(0, 5), [], "every link takes the link before it as its base and changes only its own file");
  const pairs = await pairsSince(from, count + 1);
  assert.ok(pairs <= PAIRS_PER_BRANCH * (count + 1), `the read counted commits apart for ${pairs} pairs, more than ${PAIRS_PER_BRANCH} for each of ${count + 1} branches`);
  assert.ok(slowest < 1000, `another request waited ${Math.round(slowest)} ms while the branches were read`);
});
