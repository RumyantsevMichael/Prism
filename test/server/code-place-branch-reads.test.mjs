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
const { byCodePoint, createBranchReader, rankBranches, readBranchFacts, tipsKeyOf } = await import("../../dist/server/review/code-branches.mjs");

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
    .map((line) => { const [name, commit] = line.split(" "); return { name, commit }; }).sort((left, right) => byCodePoint(left.name, right.name));
  return tipsKeyOf(head, branches);
};

test("the branch facts hold a bounded number of counts for each tip, as numbers by tip position", async () => {
  const folder = manyBranches(environment, 300);
  const facts = await readBranchFacts(countingGit(folder).run);
  assert.equal(facts.tips.length, 301);
  const arrays = Object.values(facts).filter((value) => ArrayBuffer.isView(value));
  assert.ok(arrays.every((array) => array.length === 301), "each count is held once for each tip, never for each pair of tips");
  assert.deepEqual([facts.columns.size, facts.pairs.size], [0, 0], "no count against another branch is read before a base choice asks for it");
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
  assert.ok(counts.started - started <= 1, `a change of owners alone reads only the one column of counts that the new ranking adds, where no base changes, not ${counts.started - started} commands`);
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

test("a request that arrives in any step after a read's loop ends starts the read of its key", async () => {
  const folder = manyBranches(environment, 1);
  const key = keyOf(folder);
  const raw = countingGit(folder).run;
  for (let steps = 0; steps < 15; steps += 1) {
    let reader = null;
    let asked = false;
    // After each Git command answers, a request with other owners waits for the first ready answer and arrives `steps` microtasks after it.
    const run = async (args) => {
      const answered = await raw(args);
      (async () => {
        for (let wait = 0; wait < 60 && !asked; wait += 1) {
          await Promise.resolve();
          if (!asked && reader.answer(key, []) !== undefined) {
            asked = true;
            for (let step = 0; step < steps; step += 1) await Promise.resolve();
            reader.answer(key, ["b0000"]);
          }
        }
      })();
      return answered;
    };
    reader = createBranchReader(run);
    reader.answer(key, []);
    await waitFor(async () => asked, 20000, "the first ready answer");
    await reader.idle();
    assert.notEqual(reader.answer(key, ["b0000"]), undefined, `a request ${steps} microtasks after the read ended was read`);
  }
});

test("a read that fails after its facts were read keeps them, so the next request does not read them again", async () => {
  const folder = manyBranches(environment, 3);
  const key = keyOf(folder);
  const { run: raw } = countingGit(folder);
  let failing = true;
  let listings = 0;
  const run = async (args) => {
    if (args[0] === "for-each-ref" && args.some((arg) => arg.includes("committerdate"))) listings += 1;
    if (failing && args[0] === "merge-base") throw new Error("merge-base failed");
    return raw(args);
  };
  const reader = createBranchReader(run);
  assert.equal(reader.answer(key, []), undefined);
  await reader.idle();
  assert.equal(reader.answer(key, []), undefined, "the failed read answers nothing yet and is tried again");
  await reader.idle();
  failing = false;
  assert.equal(reader.answer(key, []), undefined);
  await reader.idle();
  assert.equal(reader.answer(key, []).branches.length, 4);
  assert.equal(listings, 1, "the branch facts were read once for the unchanged tips");
});

test("the ranking of a chain of 8000 branches runs without exhausting the call stack and gives way to other work", async () => {
  const count = 8000;
  const branches = [];
  const tips = [];
  for (let index = 0; index <= count; index += 1) {
    tips.push(String(index).padStart(40, "0"));
    branches.push({ name: index === 0 ? "main" : `c${String(index).padStart(5, "0")}`, commit: tips[index], committedAt: new Date(0).toISOString(), tip: index });
  }
  const size = tips.length;
  const nearest = Int32Array.from({ length: size }, (_, index) => (index > 1 ? index - 1 : -1));
  const ownOfMain = Uint32Array.from({ length: size }, (_, index) => index);
  const facts = { key: "k", defaultBranch: "main", branches, tips, mainTip: 0, totals: Uint32Array.from({ length: size }, (_, index) => index + 1), ownOfMain, merges: new Uint32Array(size), nearest, ownOfNearest: Uint32Array.from({ length: size }, (_, index) => (index > 1 ? 1 : 0)), columns: new Map(), pairs: new Map() };
  let turns = 0;
  const ticking = setInterval(() => { turns += 1; }, 0);
  const order = await rankBranches(facts, new Set());
  clearInterval(ticking);
  assert.deepEqual(order.map((branch) => branch.tip), Array.from({ length: count }, (_, index) => index + 1), "each link ranks after the link it was built on");
  assert.ok(turns > 0, "the ranking gave way to a timer");
});

// A bare repository from fast-import items { name, parent, commits }: refs/heads/<name> gets `commits` commits on parent (main, or an earlier item), and main holds one commit.
function importRepository(parent, label, items) {
  const folder = path.join(parent, label);
  git(parent, "init", "-q", "--bare", "-b", "main", folder);
  const stamp = "1700000000 +0000";
  const commands = [`commit refs/heads/main\nmark :1\ncommitter Prism Test <test@example.invalid> ${stamp}\ndata 4\nmain\n`];
  const marks = new Map([["main", 1]]);
  let mark = 1;
  for (const { name, parent: from, commits = 1 } of items) {
    let previous = marks.get(from);
    for (let index = 0; index < commits; index += 1) {
      mark += 1;
      const message = `${name} ${index}`;
      const body = `${message}\n`;
      commands.push(`commit refs/heads/${name}\nmark :${mark}\ncommitter Prism Test <test@example.invalid> ${stamp}\ndata ${Buffer.byteLength(message)}\n${message}\nfrom :${previous}\nM 100644 inline ${index}.txt\ndata ${body.length}\n${body}\n`);
      previous = mark;
    }
    marks.set(name, previous);
  }
  execFileSync("git", ["-C", folder, "fast-import", "--quiet"], { input: commands.join(""), maxBuffer: 256 * 1024 * 1024 });
  return folder;
}

// A Git runner like the review app's, which streams a listing's lines to the reader when it asks, and records each streamed command with the lines the reader took.
async function streamingGit(folder) {
  const { runGit, runGitLines } = await import("../../dist/server/workflow/record-store-sync.mjs");
  const streams = [];
  let started = 0;
  const run = (args, { line } = {}) => {
    started += 1;
    if (!line) return runGit(folder, args);
    const stream = { args, taken: 0 };
    streams.push(stream);
    return runGitLines(folder, args, { take: (text) => { stream.taken += 1; return line(text); } });
  };
  return { run, streams, started: () => started };
}

test("branch names are ranked and listed in code-point order, so a name above U+FFFF sorts after one from U+E000 to U+FFFF", async () => {
  assert.ok(byCodePoint("\u{1F600}a", "！b") > 0 && byCodePoint("！b", "\u{1F600}a") < 0, "U+1F600 comes after U+FF01 in code-point order, though its first UTF-16 unit is smaller");
  assert.ok(byCodePoint("a", "ab") < 0 && byCodePoint("b", "a") > 0 && byCodePoint("same", "same") === 0);
  const folder = importRepository(environment, "code-points", [{ name: "share", parent: "main" }]);
  const shared = git(folder, "rev-parse", "share");
  git(folder, "update-ref", "refs/heads/！b", shared);
  git(folder, "update-ref", "refs/heads/\u{1F600}a", shared);
  git(folder, "update-ref", "-d", "refs/heads/share");
  const reader = createBranchReader(countingGit(folder).run);
  const key = keyOf(folder);
  reader.answer(key, []);
  await reader.idle();
  const model = reader.answer(key, []);
  assert.ok(model, "the tips key that the route builds matches the one that the reader keeps");
  assert.deepEqual(model.branches.map((branch) => [branch.name, branch.base]), [["main", null], ["！b", "main"], ["\u{1F600}a", "！b"]]);
});

test("each branch's first-parent history is listed once and read only up to its nearest tip or the first commit that main holds", async () => {
  // A chain of 40 links, each one commit on the one before, and a branch of 3000 commits on main that holds no other tip.
  const links = Array.from({ length: 40 }, (_, index) => ({ name: `c${String(index).padStart(3, "0")}`, parent: index === 0 ? "main" : `c${String(index - 1).padStart(3, "0")}` }));
  const folder = importRepository(environment, "first-parent", [...links, { name: "long", parent: "main", commits: 3000 }]);
  const { run, streams } = await streamingGit(folder);
  const reader = createBranchReader(run);
  const key = keyOf(folder);
  reader.answer(key, []);
  await reader.idle();
  const model = reader.answer(key, []);
  const byName = new Map(model.branches.map((branch) => [branch.name, branch]));
  for (let index = 1; index < links.length; index += 1) assert.equal(byName.get(links[index].name).base, links[index - 1].name);
  assert.equal(byName.get("long").base, "main");
  const walks = streams.filter((stream) => stream.args[0] === "rev-list" && stream.args.includes("--first-parent"));
  assert.equal(walks.length, links.length + 1, "one first-parent listing for each branch other than main, never one for each batch of its history");
  const tipOf = (name) => git(folder, "rev-parse", name);
  const ofTip = (name) => walks.find((stream) => stream.args.includes(tipOf(name)));
  assert.equal(ofTip(links[0].name).taken, 1, "a branch on main reads only its own tip, since its parent is a commit main holds");
  for (const link of links.slice(1)) assert.equal(ofTip(link.name).taken, 2, `${link.name} reads its tip and its nearest tip, and nothing past it`);
  assert.equal(ofTip("long").taken, 3000, "a branch with no other tip reads its history up to the first commit that main holds");
});

test("two sets of owners that share a clone's reader each keep a ready answer, and a change of owners does not stop the running read", async () => {
  const folder = manyBranches(environment, 60);
  const { run, counts } = countingGit(folder);
  const reader = createBranchReader(run);
  const key = keyOf(folder);
  const ownedA = ["b0001", "b0003"];
  const ownedB = ["b0002", "b0004"];
  assert.equal(reader.answer(key, ownedA), undefined);
  assert.equal(reader.answer(key, ownedB), undefined, "the second workspace's owners wait for the read that runs");
  await reader.idle();
  assert.ok(reader.answer(key, ownedA), "the read for the first owners ran to its end");
  assert.ok(reader.answer(key, ownedB), "the read for the second owners followed it");
  const started = counts.started;
  for (let index = 0; index < 10; index += 1) {
    assert.ok(reader.answer(key, index % 2 ? ownedA : ownedB), "each set of owners answers ready while the tips stay");
  }
  await reader.idle();
  assert.equal(counts.started, started, "alternating owners run no Git command");
});
