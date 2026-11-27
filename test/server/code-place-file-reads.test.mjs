import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { alias, bareRemote, commitFiles, eventually, git, isolateGit } from "./fixtures/workspace-view.mjs";

// How the Code place's file reads stay bounded: answers kept per key so a poll after 202 does not read again, caches bounded by bytes,
// conflicts found by a sweep within a budget of range comparisons and with merge checks of at most CONFLICT_CHECKS pairs, each version's entry bounded, and a code event for any fetch that moves tips.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));
const { ReadFailed, byteCache, keptAnswers } = await import("../../dist/server/review/byte-cache.mjs");
const { CONFLICT_CHECKS, CONFLICT_RANGES, RANGE_COMPARISONS, answerKey, cappedRanges, conflictsOf, fileVersions, readSlot, stopping, summaryOf } = await import("../../dist/server/review/code-versions.mjs");
const { cloneContents, createCodeClones } = await import("../../dist/server/review/code-clones.mjs");

test("a read slower than the wait answers null, and the next request answers its kept answer without reading again", async () => {
  const answers = keptAnswers({ waitMs: 20, maxBytes: 1024, keep: (answer) => !answer.preparing });
  let runs = 0;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const work = () => { runs += 1; return done; };
  assert.equal(await answers.read("a", work), null, "the first request answers 202 while the read goes on");
  assert.equal(await answers.read("a", work), null, "a request while it runs joins it");
  finish({ entries: [1, 2, 3] });
  await done;
  assert.deepEqual(await answers.read("a", work), { entries: [1, 2, 3] });
  assert.equal(runs, 1, "the finished answer is kept, so no request reads again");
  let preparing = 0;
  await answers.read("b", async () => { preparing += 1; return { preparing: true }; });
  await answers.read("b", async () => { preparing += 1; return { preparing: true }; });
  assert.equal(preparing, 2, "an answer that is still preparing is never kept");
});

test("kept answers stay within their bytes, except the latest one", async () => {
  const answers = keptAnswers({ waitMs: 1000, maxBytes: 1000, keep: () => true });
  for (let index = 0; index < 20; index += 1) await answers.read(`k${index}`, async () => ({ text: "x".repeat(30) }));
  assert.ok(answers.bytes <= 1000, `${answers.bytes} bytes kept`);
  await answers.read("large", async () => ({ text: "y".repeat(500) }));
  let again = 0;
  await answers.read("large", async () => { again += 1; return {}; });
  assert.equal(again, 0, "the latest answer is kept however large");
});

test("a kept answer's key counts as a fixed size however large the key, so small answers under large keys stay within the bound", async () => {
  const answers = keptAnswers({ waitMs: 1000, maxBytes: 64 * 1024, keep: () => true });
  const large = "k".repeat(4 * 1024 * 1024);
  const answer = { entries: [{ path: "a", type: "file" }] };
  await answers.read(`${large}0`, async () => answer);
  const one = answers.bytes;
  assert.ok(one > JSON.stringify(answer).length && one < 1024, `one kept answer counts ${one} bytes, its JSON and its key's digest`);
  for (let index = 1; index < 2000; index += 1) await answers.read(`${large}${index}`, async () => answer);
  assert.ok(answers.bytes <= 64 * 1024, `${answers.bytes} bytes kept`);
  assert.ok(answers.bytes > 64 * 1024 - 2 * one, "the bound is filled by the answers that fit, each counting its key");
  let again = 0;
  assert.deepEqual(await answers.read(`${large}1999`, async () => { again += 1; return {}; }), answer, "the latest answer is found by its key");
  assert.equal(again, 0);
});

test("200 requests under distinct keys never run more than maxRuns reads at once, and those past it answer null and start on a later request", async () => {
  const answers = keptAnswers({ waitMs: 5, maxBytes: 1 << 20, maxRuns: 8 });
  let live = 0;
  let peak = 0;
  let started = 0;
  const finishes = [];
  const work = () => new Promise((resolve) => {
    started += 1;
    live += 1;
    peak = Math.max(peak, live);
    finishes.push(() => { live -= 1; resolve({ ok: true }); });
  });
  const got = await Promise.all(Array.from({ length: 200 }, (_, index) => answers.read(`key ${index}`, work)));
  assert.ok(got.every((answer) => answer === null), "every request answers 202 while its read goes on or waits for a free run");
  assert.deepEqual([started, peak, answers.running], [8, 8, 8], "at most 8 reads run at once");
  for (const finish of finishes.splice(0)) finish();
  await eventually(() => answers.running === 0, 5000, "the runs end");
  assert.equal(await answers.read("key 100", work), null, "a request past the bound starts its read on a later request");
  assert.equal(started, 9);
  assert.equal(peak, 8);
  for (const finish of finishes.splice(0)) finish();
});

test("a run for a newer key of the same slot supersedes the earlier run, whose Git reads stop at their next step", async () => {
  const answers = keptAnswers({ waitMs: 5, maxBytes: 1 << 20, maxRuns: 8 });
  const reads = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const contents = { blobOf: async (commit) => { reads.push(commit); await gate; return "b".repeat(40); } };
  const work = (tips) => async (signal) => {
    const guarded = stopping(contents, signal);
    await guarded.blobOf(`${tips} first`);
    await guarded.blobOf(`${tips} second`);
    return { tips };
  };
  assert.equal(await answers.read("tips 1", work(1), "versions api f.ts"), null);
  assert.equal(await answers.read("tips 2", work(2), "versions api f.ts"), null, "tips move, so a newer key of the same slot starts");
  release();
  await eventually(() => answers.running === 0, 5000, "both runs end");
  assert.deepEqual(reads, ["1 first", "2 first", "2 second"], "the superseded run reads nothing after the read it was in");
  assert.deepEqual(await answers.read("tips 2", work(2), "versions api f.ts"), { tips: 2 }, "the newer run's answer is kept");
  assert.deepEqual(await answers.read("tips 1", async () => ({ again: true }), "other slot"), { again: true }, "the superseded run kept no answer, so its key reads again");
});

test("two pages that poll one file with different showQuiet settings in turn both answer, since each setting reads in its own slot", async () => {
  const answers = keptAnswers({ waitMs: 5, maxBytes: 1 << 20, maxRuns: 8 });
  let started = 0;
  // Each run outlasts the wait many times over, as a read of a crowded file does.
  const work = (showQuiet) => async (signal) => {
    started += 1;
    for (let step = 0; step < 10; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (signal.aborted) throw signal.reason;
    }
    return { showQuiet };
  };
  const settings = [false, true].map((showQuiet) => ({ quietDays: 30, showQuiet }));
  const slots = settings.map((shown) => readSlot("versions", "all", shown, "api", "src/f.ts"));
  assert.notEqual(slots[0], slots[1], "the quiet settings select the lines, so they are part of the slot");
  // The two keys differ as the lines that each setting shows differ.
  const keys = settings.map((shown) => JSON.stringify(["versions", "api", "src/f.ts", shown]));
  const got = [null, null];
  await eventually(async () => {
    for (const at of [0, 1]) if (got[at] === null) got[at] = await answers.read(keys[at], work(settings[at].showQuiet), slots[at]);
    return got.every((answer) => answer !== null);
  }, 10000, "both settings' answers");
  assert.deepEqual(got, [{ showQuiet: false }, { showQuiet: true }]);
  assert.equal(started, 2, "neither run stopped the other, so each ran once");
});

test("a run that two slots share is stopped only once every slot that started or joined it reads a newer key", async () => {
  const answers = keptAnswers({ waitMs: 5, maxBytes: 1 << 20, maxRuns: 8 });
  const shown = { quietDays: 30, showQuiet: false };
  // Scope all and a work item's scope that shows the only line of work read the same lines, so they share a key and its run.
  const all = readSlot("files", "all", shown, "api");
  const narrowed = readSlot("files", "work:w", shown, "api");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reads = [];
  const contents = { blobOf: async (commit) => { reads.push(commit); await gate; return "b".repeat(40); } };
  const work = (label) => async (signal) => {
    const guarded = stopping(contents, signal);
    await guarded.blobOf(`${label} first`);
    await guarded.blobOf(`${label} second`);
    return { label };
  };
  assert.equal(await answers.read("shared", work("shared"), all), null, "the page on all starts the run");
  assert.equal(await answers.read("shared", work("shared"), narrowed), null, "the narrowed page joins it");
  // A new branch that nobody owns changes all's lines and key, and leaves the narrowed scope's as they were.
  assert.deepEqual(await answers.read("all, new", async () => ({ label: "all, new" }), all), { label: "all, new" });
  release();
  await eventually(() => answers.running === 0, 5000, "the shared run ends");
  assert.deepEqual(reads, ["shared first", "shared second"], "a read of slot all did not stop the run that the narrowed page waits for");
  assert.deepEqual(await answers.read("shared", work("again"), narrowed), { label: "shared" }, "the narrowed page answers the shared run's kept answer");
  let stop;
  const held = new Promise((resolve) => { stop = resolve; });
  let aborted = 0;
  const waiting = async (signal) => {
    signal.addEventListener("abort", () => { aborted += 1; stop(); });
    await held;
    return { stopped: signal.aborted };
  };
  assert.equal(await answers.read("both", waiting, all), null);
  assert.equal(await answers.read("both", waiting, narrowed), null);
  await answers.read("both, all moved", async () => ({}), all);
  assert.equal(aborted, 0, "one slot moving on leaves the run to the slot still on its key");
  await answers.read("both, narrowed moved", async () => ({}), narrowed);
  assert.equal(aborted, 1, "once every slot has moved on, the run is superseded");
  await eventually(() => answers.running === 0, 5000, "the superseded run ends");
});

test("a request that cannot start its run because maxRuns runs go on stops no run of its slot", async () => {
  const answers = keptAnswers({ waitMs: 5, maxBytes: 1 << 20, maxRuns: 1 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let aborted = false;
  assert.equal(await answers.read("tips 1", async (signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    await gate;
    return { tips: 1 };
  }, "slot"), null);
  assert.equal(await answers.read("tips 2", async () => ({ tips: 2 }), "slot"), null, "the cap is reached, so the newer key answers null");
  release();
  await eventually(() => answers.running === 0, 5000, "the first run ends");
  assert.equal(aborted, false, "the request that could not start stopped nothing");
  assert.deepEqual(await answers.read("tips 1", async () => ({ again: true }), "slot"), { tips: 1 }, "the first run's answer is kept");
});

test("an answer that keep refuses is answered to the next request of its key once, and the request after that runs again", async () => {
  const answers = keptAnswers({ waitMs: 5, maxBytes: 1 << 20, keep: (answer) => !answer.failed });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let runs = 0;
  const work = async () => {
    runs += 1;
    await gate;
    return { failed: true, run: runs };
  };
  assert.equal(await answers.read("root", work, "slot"), null);
  release();
  await eventually(() => answers.running === 0, 5000, "the run ends");
  assert.deepEqual(await answers.read("root", work, "slot"), { failed: true, run: 1 }, "the request after the 202 answers what the run found");
  assert.deepEqual(await answers.read("root", work, "slot"), { failed: true, run: 2 }, "nothing was kept, so the next request runs again");
});

// The file reads of a clone whose Git runner fails a command while failing is set, as a lazy fetch of a blob does while the remote is unreachable, and counts the commands it runs.
function flakyClone() {
  const control = { failing: true, runs: 0 };
  const blob = "b".repeat(40);
  const run = async (folder, args) => {
    control.runs += 1;
    const command = args.find((arg) => ["ls-tree", "cat-file", "diff", "merge-file"].includes(arg));
    if (command === "ls-tree") {
      const file = args.at(-1);
      return { ok: true, code: 0, text: "", stdout: Buffer.from(file === "f.ts" ? `100644 blob ${blob}\tf.ts\0` : "") };
    }
    if (control.failing) return { ok: false, code: 128, text: "", stdout: Buffer.alloc(0) };
    if (command === "cat-file") return args.includes("-s") ? { ok: true, code: 0, text: "4", stdout: Buffer.from("4") } : { ok: true, code: 0, text: "one\n", stdout: Buffer.from("one\n") };
    return { ok: true, code: 0, text: "", stdout: Buffer.from("@@ -1 +1 @@\n-one\n+two\n") };
  };
  return { control, blob, contents: cloneContents("/nowhere", "api", { run }) };
}

test("a failed Git read throws ReadFailed rather than answering absent, and no cache keeps it", async () => {
  const { control, blob, contents } = flakyClone();
  assert.equal(await contents.blobOf("c".repeat(40), "absent.ts"), null, "a path that the commit does not hold is absent");
  assert.equal(await contents.blobOf("c".repeat(40), "f.ts"), blob);
  await assert.rejects(contents.shownOf(blob), ReadFailed, "a blob that Git cannot read now is a failure, not an unshown file");
  await assert.rejects(contents.diff(blob, "d".repeat(40)), ReadFailed);
  control.failing = false;
  assert.deepEqual(await contents.shownOf(blob), { lines: 1 }, "the failure was not kept, so the next read runs Git again");
});

test("a versions answer built on a failed read is never kept: the request answers its error and a later one reads again", async () => {
  const { control, contents } = flakyClone();
  const branches = [
    { name: "main", default: true, commit: "c".repeat(40), base: null, paths: [], blobs: [] },
    { name: "fix", default: false, commit: "e".repeat(40), base: "main", people: { last: "Lee Park", count: 1 }, paths: ["f.ts"], blobs: [["a".repeat(40), "d".repeat(40)]] }
  ];
  const state = { answer: { repositories: [{ name: "api", state: "on" }], preparing: [] }, models: new Map([["api", { defaultBranch: "main", branches }]]), owners: new Map(), slice: () => ({ title: "", agent: "Agent" }) };
  const lines = [{ repository: "api", name: "fix", branch: branches[1], owners: [] }];
  const answers = keptAnswers({ waitMs: 5000, maxBytes: 1 << 20 });
  const work = (signal) => fileVersions(state, lines, "api", "f.ts", stopping(contents, signal));
  await assert.rejects(answers.read("versions", work, "slot"), (error) => error instanceof ReadFailed && error.status === 503 && error.code === "read_failed");
  assert.equal(answers.bytes, 0, "nothing is kept");
  control.failing = false;
  const runs = control.runs;
  const got = await answers.read("versions", work, "slot");
  assert.ok(control.runs > runs, "the later request reads again");
  assert.equal(got.versions[0].added, 1, "and answers what the reads now find");
});

test("a byte cache holds at most its bytes of values and never one larger than them", async () => {
  const cache = byteCache(1000, (value) => value.length);
  for (let index = 0; index < 50; index += 1) await cache.read(`k${index}`, async () => "x".repeat(90));
  assert.ok(cache.bytes <= 1000 && cache.size <= 11, `${cache.bytes} bytes in ${cache.size} values`);
  let loads = 0;
  await cache.read("big", async () => { loads += 1; return "y".repeat(5000); });
  await cache.read("big", async () => { loads += 1; return "y".repeat(5000); });
  assert.equal(loads, 2, "a value over the bound is answered but not kept");
  assert.ok(cache.bytes <= 1000);
});

test("a difference's counts and ranges are its rows, with no change joined to a nearby one", () => {
  // Lines 2 and 3 change, line 4 stays, and a line is inserted after it; a line is inserted at the start.
  const summary = summaryOf([{ before: [0, 0], after: [1, 1] }, { before: [2, 2], after: [3, 2] }, { before: [4, 0], after: [6, 1] }]);
  assert.deepEqual([summary.added, summary.removed, [...summary.ranges]], [4, 2, [1, 1, 2, 3, 4, 4]]);
});

// A place state of one repository whose branches each change f.ts from the same fork content, and file reads that count the merge checks they run.
function crowd(hunksOf) {
  const branches = [{ name: "main", default: true, commit: "c".repeat(40), base: null, paths: [], blobs: [] }];
  for (const [index] of hunksOf.entries()) branches.push({ name: `b${index}`, default: false, commit: index.toString(16).padStart(40, "a"), base: "main", people: { last: "Lee Park", count: 1 }, paths: ["f.ts"], blobs: [["f".repeat(40), index.toString(16).padStart(40, "0")]] });
  const state = { answer: { repositories: [{ name: "api", state: "on" }], preparing: [] }, models: new Map([["api", { defaultBranch: "main", branches }]]), owners: new Map(), slice: () => ({ title: "", agent: "Agent" }) };
  const lines = branches.slice(1).map((branch) => ({ repository: "api", name: branch.name, branch, owners: [] }));
  let checks = 0;
  const contents = {
    blobOf: async () => "f".repeat(40),
    shownOf: async () => ({ lines: 100000 }),
    diff: async (fork, tip) => hunksOf[Number.parseInt(tip, 16)],
    conflicts: async () => { checks += 1; return true; },
    components: async () => ({ declared: [], file: false })
  };
  return { state, lines, contents, checks: () => checks };
}

test("each version names at most 16 others and counts the rest, with at most CONFLICT_CHECKS merge checks, all of pairs that an entry would name", async () => {
  const { state, lines, contents, checks } = crowd(Array.from({ length: 40 }, () => [{ before: [1, 1], after: [1, 1] }]));
  const got = await fileVersions(state, lines, "api", "f.ts", contents);
  const ids = got.versions.map((version) => version.id);
  assert.deepEqual(got.conflicts.map((entry) => entry.version), ids);
  for (const entry of got.conflicts) {
    const others = ids.filter((id) => id !== entry.version);
    assert.deepEqual(entry.with.map((other) => other.version), others.slice(0, 16));
    assert.deepEqual([entry.more, entry.complete], [others.length - 16, true]);
  }
  assert.equal(checks(), CONFLICT_CHECKS, "the pairs that entries name are more than the checks, so the checks stop at their bound");
});

test("a pair that Git's merge finds clean is neither named nor counted, and the next version that conflicts is named in its place", async () => {
  const { state, lines, contents } = crowd(Array.from({ length: 20 }, () => [{ before: [1, 1], after: [1, 1] }]));
  const ids = [];
  contents.conflicts = async (fork, first, second) => !(ids.indexOf(first) === 0 && ids.indexOf(second) === 1);
  const first = await fileVersions(state, lines, "api", "f.ts", { ...contents, conflicts: async () => true });
  ids.push(...first.versions.map((version) => version.blob));
  const got = await fileVersions(state, lines, "api", "f.ts", contents);
  const [zero, one] = got.conflicts;
  assert.deepEqual(zero.with.map((other) => other.version), ids.slice(2, 18), "version 0 skips the clean version 1 and names the next 16");
  assert.equal(zero.more, 2, "and counts the 2 after them, not the clean version 1");
  assert.ok(!one.with.some((other) => other.version === ids[0]), "version 1 does not name version 0");
  assert.equal(one.more, 2, "nor counts it");
});

test("a pair whose first group merges clean conflicts when its merge from another group's fork content conflicts", async () => {
  // Two versions, each held by a line on main from fork content X and a line on dev from fork content Y, change line 3 in both groups.
  const versions = [{ id: "v0", blob: "b0" }, { id: "v1", blob: "b1" }];
  const line = (base) => ({ branch: { base } });
  const held = [
    [{ line: line("main"), fork: "x", tip: "b0" }, { line: line("dev"), fork: "y", tip: "b0" }],
    [{ line: line("main"), fork: "x", tip: "b1" }, { line: line("dev"), fork: "y", tip: "b1" }]
  ];
  const forks = [];
  const contents = { conflicts: async (fork) => { forks.push(fork); return fork === "y"; } };
  const got = await conflictsOf(contents, versions, held, () => ({ ranges: Int32Array.from([3, 3]) }));
  assert.deepEqual(forks, ["x", "y"], "the pair is checked in each group in turn until one conflicts");
  assert.deepEqual(got.map((entry) => [entry.version, entry.with.map((other) => other.version)]), [["v0", ["v1"]], ["v1", ["v0"]]]);
  forks.length = 0;
  contents.conflicts = async (fork) => { forks.push(fork); return false; };
  assert.deepEqual(await conflictsOf(contents, versions, held, () => ({ ranges: Int32Array.from([3, 3]) })), [], "a pair clean in every group is not listed");
  assert.deepEqual(forks, ["x", "y"]);
});

test("a version's ranges past the 64th are joined into its 64th, which reaches to the end of its last", async () => {
  const ranges = Int32Array.from(Array.from({ length: 100 }, (_, index) => [4 * index + 1, 4 * index + 2]).flat());
  const capped = cappedRanges(ranges);
  assert.equal(capped.length, 2 * CONFLICT_RANGES);
  assert.deepEqual([capped[0], capped[1], capped[124], capped[125], capped[126], capped[127]], [1, 2, 249, 250, 253, 398]);
  assert.equal(cappedRanges(Int32Array.from([1, 1, 3, 3])).length, 4, "a version with fewer ranges keeps them");
  const versions = [{ id: "v0", blob: "b0" }, { id: "v1", blob: "b1" }];
  const held = versions.map(({ blob }) => [{ line: { branch: { base: "main" } }, fork: "f", tip: blob }]);
  // v0 changes 100 ranges and v1 changes only line 398, which only the joined 64th range of v0 reaches.
  const got = await conflictsOf({ conflicts: async () => true }, versions, held, (fork, tip) => ({ ranges: tip === "b0" ? ranges : Int32Array.from([398, 398]) }));
  assert.deepEqual(got[0].with[0].lines, { own: [[253, 398]], other: [[398, 398]] });
});

test("the sweep compares at most RANGE_COMPARISONS pairs of ranges, and the versions it has not compared in full are incomplete", async () => {
  // Versions 0 to 9 change line 1, and the 3000 after them all change line 5, so comparing every pair of the 3000 would take 4,498,500 comparisons.
  const count = 3010;
  const versions = Array.from({ length: count }, (_, index) => ({ id: `v${index}`, blob: `b${index}` }));
  const held = versions.map(({ blob }) => [{ line: { branch: { base: "main" } }, fork: "f", tip: blob }]);
  const rangesOf = (tip) => Int32Array.from(Number(tip.slice(1)) < 10 ? [1, 1] : [5, 5]);
  let turns = 0;
  const ticking = setInterval(() => { turns += 1; }, 0);
  const started = performance.now();
  const got = await conflictsOf({ conflicts: async () => true }, versions, held, (fork, tip) => ({ ranges: rangesOf(tip) }));
  clearInterval(ticking);
  assert.ok(performance.now() - started < 20000);
  assert.ok(turns > 0, "the sweep gives way to other work while it runs");
  assert.equal(got.length, count, "every version has an entry");
  assert.ok(got.slice(0, 10).every((entry) => entry.complete && entry.with.length === 9 && entry.more === 0), "the versions of line 1 were compared in full before the budget ran out");
  assert.ok(got.slice(10).every((entry) => !entry.complete && entry.with.length <= 16), "the versions of line 5 stay open when the budget runs out, so none was compared in full");
  // The k-th range of line 5 is compared with the k versions before it, version 10 first, after the 45 comparisons of line 1, until the budget runs out partway through one of them.
  let reached = 0;
  let spent = 45;
  for (; spent + reached <= RANGE_COMPARISONS; reached += 1) spent += reached;
  const met = reached - 1 + (RANGE_COMPARISONS > spent ? 1 : 0);
  assert.equal(got[10].more, met - 16, "version 10 counts the versions found to meet it before the budget ran out, and no more");
});

test("100 versions that each change 5000 ranges of one file answer a bounded versions answer within seconds", async () => {
  const hunks = Array.from({ length: 5000 }, (_, index) => ({ before: [2 * index + 1, 1], after: [2 * index + 1, 1] }));
  const { state, lines, contents } = crowd(Array.from({ length: 100 }, () => hunks));
  const started = performance.now();
  const got = await fileVersions(state, lines, "api", "f.ts", contents);
  const bytes = JSON.stringify(got).length;
  assert.ok(performance.now() - started < 10000, `${Math.round(performance.now() - started)} ms`);
  assert.ok(bytes < 2 * 1024 * 1024, `${bytes} bytes`);
  assert.equal(got.conflicts.length, 100);
  assert.ok(got.conflicts.every((entry) => entry.with.length === 16 && entry.more === 83 && entry.with.every((other) => other.lines.own.length === 8)));
});

test("a kept answer's key changes when the default branch, a line's base branch, or a line's base or fork moves", () => {
  const { state, lines } = crowd([[{ before: [1, 1], after: [1, 1] }]]);
  const keyOf = () => JSON.stringify(answerKey(state, lines));
  const before = keyOf();
  const branches = state.models.get("api").branches;
  branches[0].commit = "d".repeat(40);
  const moved = keyOf();
  assert.notEqual(moved, before, "the default branch's tip");
  lines[0].branch.fork = "e".repeat(40);
  assert.notEqual(keyOf(), moved, "a line's fork");
  const forked = keyOf();
  lines[0].branch.base = "dev";
  assert.notEqual(keyOf(), forked, "a line's base");
});

test("a kept answer's key reads each line's base branch by name, not by scanning every branch for each line", () => {
  const branches = [{ name: "main", default: true, commit: "c".repeat(40), base: null }];
  for (let index = 0; index < 20000; index += 1) branches.push({ name: `feature/some-branch-${index}`, default: false, commit: index.toString(16).padStart(40, "a"), base: index % 2 ? "main" : `feature/some-branch-${index - 1}`, fork: index.toString(16).padStart(40, "b"), people: { last: "Lee Park", count: 1 } });
  const state = { models: new Map([["api", { defaultBranch: "main", branches }]]), slice: () => ({ title: "A title", agent: "Agent" }) };
  const lines = branches.slice(1).map((branch) => ({ repository: "api", name: branch.name, branch, owners: [] }));
  const started = performance.now();
  const key = answerKey(state, lines);
  const spent = performance.now() - started;
  assert.equal(key.lines[2][5], branches[2].commit, "a line's base tip is that of its base branch");
  assert.ok(spent < 300, `${Math.round(spent)} ms for 20000 lines of work`);
});

test("a pair that a later version's check finds clean is counted in neither version's more", async () => {
  // 18 versions on one base and fork, all changing line 3; every pair conflicts except (v0, v17), which only v17's entry names among its first 16.
  const versions = Array.from({ length: 18 }, (_, index) => ({ id: `v${index}`, blob: `b${index}` }));
  const held = versions.map(({ blob }) => [{ line: { branch: { base: "main" } }, fork: "x", tip: blob }]);
  const checked = [];
  const contents = { conflicts: async (fork, first, second) => { checked.push([first, second]); return !(first === "b0" && second === "b17"); } };
  const got = await conflictsOf(contents, versions, held, () => ({ ranges: Int32Array.from([3, 3]) }));
  const zero = got.find((entry) => entry.version === "v0");
  const last = got.find((entry) => entry.version === "v17");
  assert.ok(checked.some(([first, second]) => first === "b0" && second === "b17"), "the pair is checked, since v17's entry names v0 first");
  assert.deepEqual([zero.with.length, zero.more], [16, 0], "v0 names 16 and does not count the clean v17");
  assert.ok(!last.with.some((other) => other.version === "v0"));
  assert.deepEqual([last.with.length, last.more], [16, 0], "v17 names the 16 others and counts none");
});

test("the merge checks are spent on CONFLICT_CHECKS distinct pairs, a pair's checks in its several groups counting once", async () => {
  // 40 versions, each held by a line on main from fork content x and a line on dev from fork content y, all changing line 3 and clean in both groups.
  const versions = Array.from({ length: 40 }, (_, index) => ({ id: `v${index}`, blob: `b${index}` }));
  const held = versions.map(({ blob }) => [{ line: { branch: { base: "main" } }, fork: "x", tip: blob }, { line: { branch: { base: "dev" } }, fork: "y", tip: blob }]);
  const pairs = new Set();
  let merges = 0;
  const contents = { conflicts: async (fork, first, second) => { merges += 1; pairs.add(`${first}|${second}`); return false; } };
  await conflictsOf(contents, versions, held, () => ({ ranges: Int32Array.from([3, 3]) }));
  assert.equal(pairs.size, CONFLICT_CHECKS);
  assert.equal(merges, 2 * CONFLICT_CHECKS, "each checked pair is merged from both of its groups' fork content");
});

test("versions that change lines apart from each other are never candidates, however many there are", async () => {
  // Each of 3000 versions changes its own line, two lines apart from the next version's, so no two ranges meet.
  const { state, lines, contents, checks } = crowd(Array.from({ length: 3000 }, (_, index) => [{ before: [3 * index + 1, 1], after: [3 * index + 1, 1] }]));
  const started = performance.now();
  const got = await fileVersions(state, lines, "api", "f.ts", contents);
  assert.deepEqual([got.versions.length, got.conflicts.length, checks()], [3000, 0, 0]);
  assert.ok(performance.now() - started < 10000, "the sweep does not compare every pair");
});

test("an insertion after a line meets a change of the next line, and not of the line after it", async () => {
  const { state, lines, contents } = crowd([[{ before: [2, 0], after: [3, 1] }], [{ before: [3, 1], after: [3, 1] }], [{ before: [4, 1], after: [4, 1] }]]);
  const got = await fileVersions(state, lines, "api", "f.ts", contents);
  const [inserted, next, after] = got.versions.map((version) => version.id);
  assert.deepEqual(got.conflicts.map((entry) => [entry.version, entry.with.map((other) => [other.version, other.lines])]), [
    [inserted, [[next, { own: [[2, 2]], other: [[3, 3]] }]]],
    [next, [[inserted, { own: [[3, 3]], other: [[2, 2]] }], [after, { own: [[3, 3]], other: [[4, 4]] }]]],
    [after, [[next, { own: [[4, 4]], other: [[3, 3]] }]]]
  ]);
});

test("a fetch that a Code request starts and that moves a tip raises the code event for each workspace of the clone", async (context) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-code-reads-")));
  context.after(() => rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const remote = await bareRemote(parent, "api-code.git", { files: { "src/total.js": "export const total = 1;\n" } });
  alias("https://github.com/acme/api-reads.git", remote);
  const moved = [];
  const code = await createCodeClones({ directory: path.join(parent, "app"), onTipsMoved: (workspace) => moved.push(workspace) });
  assert.equal((await code.enable("w1", "api", "https://github.com/acme/api-reads.git")).state, "on");
  assert.equal((await code.enable("w2", "api", "https://github.com/acme/api-reads.git")).state, "on");
  moved.length = 0;
  assert.equal(await code.fetchAll("w1"), false);
  assert.deepEqual(moved, [], "a fetch that moves nothing raises nothing");
  const work = path.join(parent, "api-work");
  git(parent, "clone", "-q", remote, work);
  await commitFiles(work, { "src/total.js": "export const total = 2;\n" }, "total 2");
  git(work, "push", "-q", "origin", "main");
  // No fetch ran within freshMs 0, so the branches request starts its own.
  await code.branches("w1", "api", [], { freshMs: 0 });
  await eventually(async () => moved.length >= 2, 20000, "the code event of the request's fetch");
  assert.deepEqual([...moved].sort(), ["w1", "w2"]);
  moved.length = 0;
  assert.equal(await code.fetchAll("w1"), false, "the workspace's own fetch then finds the tips already moved");
  assert.deepEqual(moved, []);
});
