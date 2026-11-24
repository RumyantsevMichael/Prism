import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { eventually as waitFor, git, isolateGit, sha16 } from "./fixtures/workspace-view.mjs";
import { applySteps, codeWorkspace } from "./fixtures/code-place.mjs";

// How Prism reads the branches of a code clone: in the background, one read at a time, from the clone's current tips and default branch,
// with memory and per-request work that stay bounded as the remote's branch count grows.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { createBranchReader, readBranchFacts, tipsKeyOf } = await import("../../dist/server/review/code-branches.mjs");

const WEB = {
  name: "web",
  files: { "README.md": "web\n", "src/app.ts": "app\n" },
  steps: [
    { branch: "develop", author: "Sam Ortiz", days: 3, files: { "src/app.ts": "app 2\n" } },
    { branch: "feature/table", from: "develop", author: "Dana Kim", days: 2, files: { "src/table.ts": "table\n" } }
  ]
};

const cloneOf = (where) => path.join(where.app, "code", `${sha16("github.com/acme/web")}.git`);

test("the default branch follows the remote's HEAD when it names another branch and no tip moves", async (context) => {
  const { ready, remotes } = await codeWorkspace(context, { repositories: [WEB] });
  const before = await ready("branches?repository=web");
  assert.equal(before.json.defaultBranch, "main");
  git(remotes.web.bare, "symbolic-ref", "HEAD", "refs/heads/develop");
  let got = null;
  await waitFor(async () => {
    got = (await ready("branches?repository=web")).json;
    return got.defaultBranch === "develop";
  }, 20000, "the answer after the remote's HEAD names develop").catch(() => null);
  assert.equal(got?.defaultBranch, "develop");
  const byName = new Map(got.branches.map((branch) => [branch.name, branch]));
  assert.deepEqual([byName.get("develop").default, byName.get("develop").base, byName.get("develop").files], [true, null, 0]);
  assert.equal(byName.get("main").default, false);
  assert.equal(byName.get("main").base, "develop", "main is now a line of work from develop");
  assert.equal(byName.get("feature/table").base, "develop");
});

test("a branches request answers at once while a fetch it started waits on a remote that does not answer", async (context) => {
  const { api, ready, where } = await codeWorkspace(context, { repositories: [WEB] });
  assert.equal((await ready("branches?repository=web")).status, 200);
  // The clone's upload-pack waits until the test releases it, so a fetch hangs as it would on a remote that accepts a connection and never answers.
  const held = path.join(where.parent, "held");
  await mkdir(held, { recursive: true });
  const release = path.join(held, "release");
  const waiter = path.join(held, "wait.mjs");
  await writeFile(waiter, `import { existsSync } from "node:fs";\nconst timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exitCode = 1; } }, 50);\n`);
  const slash = (file) => file.split(path.sep).join("/");
  const clone = cloneOf(where);
  git(clone, "config", "remote.origin.uploadpack", `"${slash(process.execPath)}" "${slash(waiter)}"`);
  const timed = async () => {
    const started = Date.now();
    const answer = await api("branches?repository=web");
    return { status: answer.status, ms: Date.now() - started, json: answer.json };
  };
  try {
    const answers = [];
    await waitFor(async () => {
      answers.push(await timed());
      return answers.at(-1).status === 202;
    }, 20000, "a request that starts a fetch");
    for (let index = 0; index < 3; index += 1) answers.push(await timed());
    assert.deepEqual(answers.slice(-4).map((answer) => [answer.status, answer.json]), Array(4).fill([202, { state: "preparing" }]), "the fetch still waits, so the clone is preparing");
    for (const answer of answers) assert.ok(answer.ms < 5000, `a request answered in ${answer.ms} ms rather than waiting on the fetch`);
  } finally {
    git(clone, "config", "--unset", "remote.origin.uploadpack");
    await writeFile(release, "");
  }
  assert.equal((await ready("branches?repository=web")).status, 200, "the clone answers again once the fetch ends");
});

// A repository whose main holds one commit and that holds count more branches, each one empty commit on main, so every branch has its own tip.
function manyBranches(parent, count) {
  const folder = path.join(parent, `many-${count}`);
  git(parent, "init", "-q", "--bare", "-b", "main", folder);
  const stamp = "1700000000 +0000";
  const commands = [`commit refs/heads/main\nmark :1\ncommitter Prism Test <test@example.invalid> ${stamp}\ndata 4\nmain\n`];
  for (let index = 0; index < count; index += 1) {
    const message = `b${index}`;
    commands.push(`commit refs/heads/b${String(index).padStart(4, "0")}\ncommitter Prism Test <test@example.invalid> ${stamp}\ndata ${message.length}\n${message}\nfrom :1\n`);
  }
  execFileSync("git", ["-C", folder, "fast-import", "--quiet"], { input: commands.join("") });
  return folder;
}

// A Git runner for a folder that counts the commands it runs and the most that run at once.
function countingGit(folder) {
  const counts = { started: 0, running: 0, most: 0 };
  const run = (args) => new Promise((resolve) => {
    counts.started += 1;
    counts.running += 1;
    counts.most = Math.max(counts.most, counts.running);
    const child = execFile("git", ["-C", folder, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      counts.running -= 1;
      resolve({ ok: !error, stdout, text: stdout.toString("utf8").trim() });
    });
    child.stdin?.end();
  });
  return { run, counts };
}

const keyOf = (folder) => {
  const head = git(folder, "symbolic-ref", "HEAD");
  const branches = git(folder, "for-each-ref", "--format=%(refname:strip=2) %(objectname)", "refs/heads/").split("\n").filter(Boolean)
    .map((line) => { const [name, commit] = line.split(" "); return { name, commit }; }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return tipsKeyOf(head, branches);
};

test("the pair counts of the branch facts take 4 bytes for each pair of tips, held as numbers by tip position", async () => {
  const folder = manyBranches(environment, 300);
  const facts = await readBranchFacts(countingGit(folder).run);
  assert.equal(facts.tips.length, 301);
  assert.ok(facts.own instanceof Uint32Array, "the pair counts are one typed array");
  assert.equal(facts.own.byteLength, 301 * 301 * 4, "so 2000 distinct tips take 16 MB");
  assert.ok(facts.firstParentTips.every((tips) => tips instanceof Int32Array && tips.length <= 1), "each branch keeps only the tips in its first-parent history");
  assert.equal(Object.values(facts).filter((value) => value instanceof Map).length, 0, "no map keyed by commit holds a count for each pair");
});

test("a reader answers preparing at once, runs one read at a time, and answers a ready model with no Git command", async () => {
  const folder = manyBranches(environment, 120);
  const { run, counts } = countingGit(folder);
  const reader = createBranchReader(run);
  const key = keyOf(folder);
  for (let index = 0; index < 20; index += 1) assert.equal(reader.answer(key, []), undefined, "the read runs in the background");
  await reader.idle();
  assert.ok(counts.most <= 8, `at most 8 Git commands ran at once, not ${counts.most}`);
  const started = counts.started;
  const model = reader.answer(key, []);
  assert.equal(model.branches.length, 121);
  assert.equal(model.branches.find((branch) => branch.name === "b0007").base, "main");
  assert.equal(counts.started, started, "a ready answer runs no Git command");
  // A change of owners reorders the base choice from the kept facts and reuses each branch's fork, files, and people.
  assert.equal(reader.answer(key, ["b0001"]), undefined);
  await reader.idle();
  assert.equal(counts.started, started, "a change of owners alone runs no Git command here, where no base changes");
  assert.equal(reader.answer(key, ["b0001"]).branches.length, 121);
});

test("a read that newer tips supersede stops, and the newest tips are read once", async () => {
  const folder = manyBranches(environment, 200);
  const baseline = countingGit(folder);
  const alone = createBranchReader(baseline.run);
  alone.answer(keyOf(folder), []);
  await alone.idle();
  const { run, counts } = countingGit(folder);
  const reader = createBranchReader(run);
  const first = keyOf(folder);
  reader.answer(first, []);
  git(folder, "branch", "late", "main");
  const second = keyOf(folder);
  assert.equal(reader.answer(second, []), undefined);
  await reader.idle();
  assert.equal(reader.answer(second, []).branches.length, 202, "the newest tips are answered");
  assert.ok(counts.started < baseline.counts.started * 1.5, `the superseded read stopped early: ${counts.started} commands against ${baseline.counts.started} for one read`);
});
