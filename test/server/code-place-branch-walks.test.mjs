import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { git, isolateGit } from "./fixtures/workspace-view.mjs";

// Requirements: docs/requirements/code-place.md §7, §20.
// Contract: docs/plans/code-place/slice.md clauses 8, 11, and 12, through the branch model of a code clone:
// which commits each Git command of a read walks, how far each listing is read, and how long the ranking holds the event loop.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { byCodePoint, createBranchReader, rankBranches, readBranchFacts, readBranches, tipsKeyOf } = await import("../../dist/server/review/code-branches.mjs");
const { runGit, runGitLines } = await import("../../dist/server/workflow/record-store-sync.mjs");

// A bare repository written by fast-import from commits { ref, from, merge, author }, each one empty commit whose mark is its position from 1;
// from and merge name earlier marks, and the first commit is main's.
function repository(label, commits) {
  const folder = path.join(environment, label);
  git(environment, "init", "-q", "--bare", "-b", "main", folder);
  const commands = commits.map(({ ref, from, merge, author = "Prism Test" }, index) => {
    const message = `${ref} ${index + 1}`;
    return `commit refs/heads/${ref}\nmark :${index + 1}\nauthor ${author} <test@example.invalid> ${1700000000 + index} +0000\ncommitter Prism Test <test@example.invalid> ${1700000000 + index} +0000\ndata ${message.length}\n${message}\n`
      + `${from ? `from :${from}\n` : ""}${merge ? `merge :${merge}\n` : ""}`;
  });
  execFileSync("git", ["-C", folder, "fast-import", "--quiet"], { input: commands.join(""), maxBuffer: 64 * 1024 * 1024 });
  return folder;
}

// A Git runner like the review app's, which streams a listing to the reader when it asks, and records each command, whether it streamed, and the lines the reader took.
function recordingGit(folder) {
  const commands = [];
  const run = (args, { line } = {}) => {
    const command = { args, streamed: Boolean(line), taken: 0 };
    commands.push(command);
    if (!line) return runGit(folder, args);
    return runGitLines(folder, args, { take: (text) => { command.taken += 1; return line(text); } });
  };
  return { run, commands };
}

const keyOf = (folder) => {
  const head = git(folder, "symbolic-ref", "HEAD");
  const branches = git(folder, "for-each-ref", "--format=%(refname:strip=2) %(objectname)", "refs/heads/").split("\n").filter(Boolean)
    .map((line) => { const [name, commit] = line.split(" "); return { name, commit }; }).sort((left, right) => byCodePoint(left.name, right.name));
  return tipsKeyOf(head, branches);
};

test("a clone whose HEAD names a branch it lacks answers every set of owners from one read", async () => {
  const empty = path.join(environment, "empty");
  git(environment, "init", "-q", "--bare", "-b", "main", empty);
  const moved = repository("moved", [{ ref: "main" }, { ref: "work", from: 1 }]);
  git(moved, "symbolic-ref", "HEAD", "refs/heads/gone");
  for (const folder of [empty, moved]) {
    let reads = 0;
    const raw = recordingGit(folder).run;
    const reader = createBranchReader((args, options) => {
      if (args[0] === "symbolic-ref") reads += 1;
      return raw(args, options);
    });
    const key = keyOf(folder);
    for (const owned of [["x"], ["y"]]) {
      assert.equal(reader.answer(key, owned), undefined, "the first request of each set of owners waits for its read");
      await reader.idle();
    }
    for (let round = 0; round < 5; round += 1) {
      for (const owned of [["x"], ["y"]]) assert.deepEqual(reader.answer(key, owned), { defaultBranch: null, branches: [] }, `${path.basename(folder)} answers the owners ${owned} while its tips stay`);
      await reader.idle();
    }
    assert.equal(reads, 1, `${path.basename(folder)}'s facts were read once for its tips`);
  }
});

test("in a chain of branches with merges, no count walks a branch's whole history or the history its nearest tip holds, and merges are summed down the chain", async () => {
  // main (1); side (2) on main; withmerge (3) on main merging side; ontop (4) on withmerge; side2 (5) on main; ontop2 (6) on ontop merging side2;
  // and links c0 to c19, each one commit on the one before, from ontop2.
  const commits = [
    { ref: "main" }, { ref: "side", from: 1 }, { ref: "withmerge", from: 1, merge: 2 }, { ref: "ontop", from: 3 }, { ref: "side2", from: 1 }, { ref: "ontop2", from: 4, merge: 5 }
  ];
  for (let index = 0; index < 20; index += 1) commits.push({ ref: `c${String(index).padStart(2, "0")}`, from: commits.length });
  const folder = repository("merge-chain", commits);
  const { run, commands } = recordingGit(folder);
  const facts = await readBranchFacts(run);
  const tipOf = (name) => facts.branches.find((branch) => branch.name === name).tip;
  const nameOf = (tip) => facts.branches.find((branch) => branch.tip === tip)?.name ?? null;
  for (const branch of facts.branches) {
    if (branch.name === "main") continue;
    assert.equal(facts.merges[branch.tip], Number(git(folder, "rev-list", "--count", "--merges", branch.commit, "^main")), `${branch.name}'s merges that main lacks`);
  }
  assert.deepEqual(["withmerge", "ontop", "ontop2", "c00", "c01", "c19"].map((name) => nameOf(facts.nearest[tipOf(name)])), [null, "withmerge", "ontop", "ontop2", "c00", "c18"]);
  const counts = commands.filter((command) => command.args[0] === "rev-list" && command.args.includes("--count"));
  assert.ok(counts.length > 0);
  for (const command of counts) assert.ok(command.args.some((arg) => arg.startsWith("^")), `rev-list ${command.args.slice(1).join(" ")} excludes a commit, so it never counts a whole history`);
  for (const name of ["ontop", "ontop2", "c00", "c10", "c19"]) {
    const nearestTip = facts.tips[facts.nearest[tipOf(name)]];
    const own = counts.filter((command) => command.args.includes(facts.tips[tipOf(name)]));
    assert.ok(own.length > 0 && own.every((command) => command.args.includes(`^${nearestTip}`)), `each count of ${name} excludes its nearest tip`);
  }
  const listings = commands.filter((command) => command.args[0] === "rev-list" && !command.args.includes("--count"));
  assert.equal(listings.length, 1, "the merges and nearest tips of every branch come from one listing");
  assert.ok(listings[0].streamed && listings[0].args.includes(`^${facts.tips[facts.mainTip]}`), "the listing is streamed and excludes main");
  assert.equal(listings[0].taken, commits.length - 1, "each commit that main lacks is read once");
});

test("branches that each merge one shared side history read it once, not once for each branch", async () => {
  // main (1 to 3); a side history (4 to 203) on main's first commit that no branch names; and 30 branches, each one merge of main~1 and that side history.
  const commits = [{ ref: "main" }, { ref: "main", from: 1 }, { ref: "main", from: 2 }];
  for (let index = 0; index < 200; index += 1) commits.push({ ref: "side", from: index ? commits.length : 1 });
  const sideTop = commits.length;
  for (let index = 0; index < 30; index += 1) commits.push({ ref: `f${String(index).padStart(2, "0")}`, from: 2, merge: sideTop });
  const folder = repository("fan", commits);
  git(folder, "update-ref", "-d", "refs/heads/side");
  const { run, commands } = recordingGit(folder);
  const facts = await readBranchFacts(run);
  for (const branch of facts.branches) {
    if (branch.name === "main") continue;
    assert.equal(facts.merges[branch.tip], 1, `${branch.name} lacks only its own merge`);
    assert.equal(facts.nearest[branch.tip], -1, `${branch.name}'s first-parent history reaches main at once`);
  }
  const walked = commands.filter((command) => command.args[0] === "rev-list");
  assert.deepEqual(walked.map((command) => command.taken), [200 + 30], "one listing reads the side history and each merge once, and nothing else walks it");
});

test("an author name longer than a streamed line keeps still counts as one person and names the newest commit", async () => {
  const long = "L".repeat(5000);
  const folder = repository("long-author", [
    { ref: "main" }, { ref: "work", from: 1, author: "alice" }, { ref: "work", from: 2, author: long }, { ref: "work", from: 3, author: "carol" }, { ref: "work", from: 4, author: long }
  ]);
  const { run } = recordingGit(folder);
  const facts = await readBranchFacts(run);
  const model = await readBranches(run, facts, new Set());
  assert.deepEqual(model.branches.find((branch) => branch.name === "work").people, { last: long, count: 3 });
});

test("a branch that shares no commit with any candidate has no base, fork, or files, with no count of its whole history", async () => {
  // main (1, 2), feature (3) on main, and orphan (4, 5), a history of its own.
  const folder = repository("orphan", [{ ref: "main" }, { ref: "main", from: 1 }, { ref: "feature", from: 2 }, { ref: "orphan" }, { ref: "orphan", from: 4 }]);
  const { run, commands } = recordingGit(folder);
  const facts = await readBranchFacts(run);
  const model = await readBranches(run, facts, new Set());
  const byName = new Map(model.branches.map((branch) => [branch.name, branch]));
  assert.deepEqual([byName.get("orphan").base, byName.get("orphan").fork, byName.get("orphan").files], [null, null, null]);
  assert.deepEqual([byName.get("feature").base, byName.get("feature").files], ["main", 0]);
  assert.deepEqual(byName.get("orphan").people, { last: "Prism Test", count: 1 }, "an orphan's people are read from its whole history");
  assert.ok(commands.every((command) => command.args[0] !== "rev-list" || !command.args.includes("--count") || command.args.some((arg) => arg.startsWith("^"))), "no count of a whole history");
});

test("a branch's people are streamed from its author log, holding only its distinct names", async () => {
  const long = "An author whose name is far longer than twenty characters";
  const folder = repository("people", [
    { ref: "main" }, { ref: "work", from: 1, author: long }, { ref: "work", from: 2, author: "Ann" }, { ref: "work", from: 3, author: long }, { ref: "work", from: 4, author: `${long}!` }
  ]);
  const { run, commands } = recordingGit(folder);
  const facts = await readBranchFacts(run);
  const model = await readBranches(run, facts, new Set());
  assert.deepEqual(model.branches.find((branch) => branch.name === "work").people, { last: `${long}!`, count: 3 });
  const log = commands.find((command) => command.args[0] === "log");
  assert.ok(log.streamed, "the author log is read line by line");
  assert.equal(log.taken, 4);
});

test("the ranking places a chain of 20000 branches giving way after at most 500 branches, even within the chain", async () => {
  const count = 20000;
  const branches = [];
  const tips = [];
  for (let index = 0; index <= count; index += 1) {
    tips.push(String(index).padStart(40, "0"));
    branches.push({ name: index === 0 ? "main" : `c${String(index).padStart(5, "0")}`, commit: tips[index], committedAt: new Date(0).toISOString(), tip: index });
  }
  const size = tips.length;
  // The top of the chain has the most own commits, so it ranks first and its chain of nearest tips holds every other branch.
  let steps = 0;
  const nearest = new Proxy(Int32Array.from({ length: size }, (_, index) => (index > 1 ? index - 1 : -1)), {
    get: (target, key) => {
      if (typeof key === "string" && /^\d+$/.test(key)) steps += 1;
      return Reflect.get(target, key);
    }
  });
  const facts = { key: "k", defaultBranch: "main", branches, tips, mainTip: 0, ownOfMain: Uint32Array.from({ length: size }, (_, index) => index), merges: new Uint32Array(size), nearest, ownOfNearest: new Uint32Array(size), columns: new Map(), pairs: new Map() };
  let most = 0;
  let since = 0;
  let going = true;
  const tick = () => {
    most = Math.max(most, steps - since);
    since = steps;
    if (going) setImmediate(tick);
  };
  setImmediate(tick);
  const order = await rankBranches(facts, new Set());
  going = false;
  most = Math.max(most, steps - since);
  assert.deepEqual(order.map((branch) => branch.tip), Array.from({ length: count }, (_, index) => index + 1), "each link ranks after the link it was built on");
  assert.ok(most <= 1000, `one turn followed ${most} links of the chain`);
});
