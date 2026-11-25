// The branch model of one code clone: for each branch, the branch it most likely started from, where it forked, how many files it changes,
// when it last moved, and who committed to it, read from commits and trees alone, so no file's contents are fetched.
// Git records no branch that a branch started from, so the base is inferred: unowned branches, branches that receive merges, and branches that others were built on rank as bases.
// Every Git command names a commit, never a branch name, so a branch named like an option never reaches Git as one.
//
// The work grows with the number of branches times a constant: each branch is compared with the default branch, with the branches at the nearest tip of its first-parent history,
// with the first CANDIDATES branches of the ranking, and, when a slice owns it, with the CANDIDATES owned branches ranked nearest before it, and only those counts are held.
// Branches at one tip tie on every count, so of those candidates each tip weighs only its earliest ranked branch, however many branches point at it.
// A branch's first-parent history is listed once, excluding no commit, and read only up to that nearest tip, a tip that the default branch holds,
// or as many commits as the branch holds that the default branch lacks, and its other counts exclude that nearest tip, so no count walks the history that a branch shares with another,
// and a chain of branches each built on the one before costs each branch only its own commits.
// The ranking and the base choice run without recursion and give way to the server's other work after at most TURN branches.
// All Git work runs in a background read, one at a time per clone, that a newer set of tips supersedes, and the answers are kept for their tips and default branch,
// one for each of the latest few sets of owners, so a request with its answer ready does no work that grows faster than the number of branches.

import { createHash } from "node:crypto";

const BRANCHES = "refs/heads/";
// How many Git commands of one model run at a time.
const PARALLEL = 8;
// How many of the first ranked branches, and of the owned branches ranked nearest before an owned branch, are a branch's candidate bases.
const CANDIDATES = 32;
// How many branches the ranking or the base choice handles before it gives way to the server's other work.
const TURN = 500;
// The longest author name that a branch's people hold as it is; a longer one is held as 12 bytes of its digest.
const NAME_KEPT = 20;
// How many sets of owners a clone's reader keeps a ready answer for, at most one model of the clone's branches each.
const ANSWERS = 8;

// A UTF-16 unit as it sorts in code-point order: a surrogate, which only a character above U+FFFF holds, sorts after every unit from U+E000 to U+FFFF.
const pointOrder = (unit: number) => (unit >= 0xe000 ? unit - 0x800 : unit >= 0xd800 ? unit + 0x2000 : unit);

/** Compare two names in code-point order, the order in which Git lists refs, rather than JavaScript's order of UTF-16 units. */
export function byCodePoint(left: string, right: string) {
  const shorter = Math.min(left.length, right.length);
  for (let at = 0; at < shorter; at += 1) {
    const a = left.charCodeAt(at);
    const b = right.charCodeAt(at);
    if (a !== b) return pointOrder(a) - pointOrder(b);
  }
  return left.length - right.length;
}
const byText = byCodePoint;
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

// A Git runner, which hands each output line to line as it arrives when it can, answering streamed true, and stops Git once line answers false.
type Git = (args: string[], options?: { line?: (line: string) => boolean }) => Promise<{ ok: boolean; text: string; stdout: Buffer; streamed?: boolean }>;
type Live = () => boolean;

/** Thrown by a read that a newer request superseded, so it stops before its next Git command. */
export class Superseded extends Error {}

const stopUnless = (live: Live) => {
  if (!live()) throw new Superseded("a newer read superseded this one");
};

// Map items through an async function with at most limit calls running at once, keeping their order, and stopping before the next call once live() is false.
async function mapLimit<T, R>(items: T[], limit: number, action: (item: T, index: number) => Promise<R>, live: Live = () => true): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      stopUnless(live);
      const index = next++;
      results[index] = await action(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const count = async (git: Git, args: string[]) => {
  const counted = await git(["rev-list", "--count", ...args]);
  return counted.ok ? Number(counted.text) : 0;
};

const lines = (text: string) => text.split("\n").filter(Boolean);

// Hand each line of a Git command's output to take in order until take answers false, as the lines arrive when the runner streams them, so no line after that is read.
async function eachLine(git: Git, args: string[], take: (line: string) => boolean) {
  let going = true;
  const listed = await git(args, { line: (line) => (going = going && (!line || take(line))) });
  if (!listed.streamed && listed.ok) for (const line of lines(listed.text)) if (!take(line)) break;
}

/** The key of a clone's branch tips and default branch, from its HEAD ref and its branches as { name, commit } in name order, which a newer fetch changes. */
export const tipsKeyOf = (headRef: string, branches: { name: string; commit: string }[]) => [headRef, ...branches.map((branch) => `${branch.name}\0${branch.commit}`)].join("\n");

// The paths that differ between two commits, read from their trees alone, with a rename as a removal and an addition.
async function changedPaths(git: Git, from: string, to: string) {
  if (from === to) return new Set<string>();
  const listed = await git(["diff-tree", "-r", "-z", "--no-renames", "--name-only", from, to]);
  return new Set(listed.ok ? listed.stdout.toString("utf8").split("\0").filter(Boolean) : []);
}

// own(B, commit) for every tip B, as commits that B holds and that commit does not, by tip position: one for-each-ref with ahead-behind, or one rev-list per tip where this Git lacks it.
async function ownColumn(git: Git, commit: string, tips: string[], tipIndex: Map<string, number>, live: Live) {
  const column = new Uint32Array(tips.length);
  const compared = await git(["for-each-ref", `--format=%(objectname) %(ahead-behind:${commit})`, BRANCHES]);
  if (compared.ok) {
    for (const line of lines(compared.text)) {
      const [tip, ahead] = line.split(" ");
      const row = tipIndex.get(tip);
      if (row !== undefined) column[row] = Number(ahead);
    }
  } else {
    await mapLimit(tips, PARALLEL, async (tip, row) => {
      if (tip !== commit) column[row] = await count(git, [tip, `^${commit}`]);
    }, live);
  }
  return column;
}

// The position of the nearest tip in a commit's first-parent history after the commit itself that the default branch lacks, or -1, given own(tip, default branch) as own.
// The listing excludes no commit, so Git walks only the commits it prints: it is read up to the first commit that is a tip, which is the nearest tip when the default branch lacks it,
// and otherwise the default branch holds it and every commit after it. The commits that the default branch lacks come first in that history and number at most own,
// so the listing stops after own commits with no tip among them, and a history that holds commits the default branch lacks only through merges is read no further than that.
async function nearestTip(git: Git, tip: string, own: number, ownOfMain: Uint32Array, tipIndex: Map<string, number>, live: Live) {
  stopUnless(live);
  let found = -1;
  let read = 0;
  await eachLine(git, ["rev-list", "--first-parent", tip], (commit) => {
    read += 1;
    const at = read > 1 ? tipIndex.get(commit) : undefined;
    if (at !== undefined) {
      if (ownOfMain[at] > 0) found = at;
      return false;
    }
    return read < own;
  });
  return found;
}

/**
 * The facts of a clone's branches that depend only on their tips and default branch:
 * { key, defaultBranch, branches, tips, mainTip, ownOfMain, merges, nearest, ownOfNearest, columns, pairs },
 * with each branch { name, commit, committedAt, tip } in name order and tip its position in tips, and, by tip position, own(tip, default branch),
 * its merge commits that the default branch lacks, the position of the nearest tip of its first-parent history or -1, and own(tip, that nearest tip).
 * columns and pairs keep the counts that a base choice for the current owners read, so a later read reuses them.
 * It answers null when the clone names no default branch that it holds, and throws Superseded once live() is false.
 */
export async function readBranchFacts(git: Git, live: Live = () => true) {
  const head = await git(["symbolic-ref", "--quiet", "HEAD"]);
  const headRef = head.ok ? head.text.trim() : "";
  const listed = await git(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)", BRANCHES]);
  if (!listed.ok) return null;
  const read = lines(listed.text).map((line) => {
    const [ref, commit, date] = line.split("\0");
    return { name: ref.slice(BRANCHES.length), commit, committedAt: new Date(Number(date) * 1000).toISOString(), tip: 0 };
  }).sort((left, right) => byText(left.name, right.name));
  const key = tipsKeyOf(headRef, read);
  if (!headRef.startsWith(BRANCHES)) return null;
  const defaultBranch = headRef.slice(BRANCHES.length);
  const main = read.find((branch) => branch.name === defaultBranch);
  if (!main) return null;
  const tips: string[] = [];
  const tipIndex = new Map<string, number>();
  for (const branch of read) {
    if (!tipIndex.has(branch.commit)) {
      tipIndex.set(branch.commit, tips.length);
      tips.push(branch.commit);
    }
    branch.tip = tipIndex.get(branch.commit)!;
  }
  const size = tips.length;
  const mainTip = main.tip;
  stopUnless(live);
  const ownOfMain = await ownColumn(git, main.commit, tips, tipIndex, live);
  // Each tip's merges that the default branch lacks are those its nearest tip lacks too, plus those that neither holds, so each count walks only the commits that a tip adds to its nearest tip.
  const ownMerges = new Uint32Array(size);
  const nearest = new Int32Array(size).fill(-1);
  const ownOfNearest = new Uint32Array(size);
  await mapLimit(tips, PARALLEL, async (tip, row) => {
    if (ownOfMain[row] === 0) return;
    nearest[row] = await nearestTip(git, tip, ownOfMain[row], ownOfMain, tipIndex, live);
    const near = nearest[row] >= 0 ? [`^${tips[nearest[row]]}`] : [];
    if (near.length) ownOfNearest[row] = await count(git, [tip, ...near]);
    ownMerges[row] = await count(git, ["--merges", tip, ...near, `^${main.commit}`]);
  }, live);
  // Summed down each chain of nearest tips without recursion: a tip's chain is followed up to a tip already summed, and then summed back down.
  const merges = new Uint32Array(size);
  const summed = new Uint8Array(size);
  const chain: number[] = [];
  for (let row = 0; row < size; row += 1) {
    if (row % TURN === TURN - 1) await pause();
    for (let at = row; at >= 0 && !summed[at] && chain.length < size; at = nearest[at]) chain.push(at);
    while (chain.length) {
      const at = chain.pop()!;
      merges[at] = ownMerges[at] + (nearest[at] >= 0 && summed[nearest[at]] ? merges[nearest[at]] : 0);
      summed[at] = 1;
    }
  }
  return { key, defaultBranch, branches: read, tips, mainTip, ownOfMain, merges, nearest, ownOfNearest, columns: new Map<number, Uint32Array>(), pairs: new Map<number, number>() };
}

type Facts = NonNullable<Awaited<ReturnType<typeof readBranchFacts>>>;
type Branch = Facts["branches"][number];

// Merge two sorted runs, giving way after every TURN items.
async function mergeRuns<T>(left: T[], right: T[], compare: (a: T, b: T) => number) {
  const merged: T[] = [];
  let l = 0;
  let r = 0;
  while (l < left.length || r < right.length) {
    merged.push(r >= right.length || (l < left.length && compare(left[l], right[r]) <= 0) ? left[l++] : right[r++]);
    if (merged.length % TURN === 0) await pause();
  }
  return merged;
}

// Sort items stably in runs of TURN items that are then merged, giving way between them.
async function sortInTurns<T>(items: T[], compare: (a: T, b: T) => number) {
  let runs: T[][] = [];
  for (let at = 0; at < items.length; at += TURN) {
    runs.push(items.slice(at, at + TURN).sort(compare));
    await pause();
  }
  while (runs.length > 1) {
    const next: T[][] = [];
    for (let at = 0; at < runs.length; at += 2) next.push(at + 1 < runs.length ? await mergeRuns(runs[at], runs[at + 1], compare) : runs[at]);
    runs = next;
  }
  return runs[0] ?? [];
}

/**
 * Order the branches other than the default one as clause 8 ranks them, given the names of the branches that a slice owns,
 * without recursion and giving way to the server's other work after every TURN branches.
 */
export async function rankBranches(facts: Facts, owned: Set<string>) {
  const main = facts.branches.find((branch) => branch.name === facts.defaultBranch)!;
  const others = facts.branches.filter((branch) => branch !== main);
  const ranked = await sortInTurns(others, (left, right) =>
    Number(owned.has(left.name)) - Number(owned.has(right.name))
    || facts.merges[right.tip] - facts.merges[left.tip]
    || facts.ownOfMain[right.tip] - facts.ownOfMain[left.tip]
    || byText(left.name, right.name));
  const byTip = new Map<number, Branch[]>();
  for (const branch of ranked) {
    if (!byTip.has(branch.tip)) byTip.set(branch.tip, []);
    byTip.get(branch.tip)!.push(branch);
  }
  // A branch moves before every branch whose first-parent history holds its tip: those histories reach it through the chain of nearest tips,
  // so each branch is placed after the branches of every tip up that chain, nearest the default branch first and each tip's branches in ranked order.
  const order: Branch[] = [];
  const placed = new Set<Branch>();
  const placedAt = new Map<number, number>();
  const settled = (tip: number) => (placedAt.get(tip) ?? 0) >= (byTip.get(tip)?.length ?? 0);
  // Every branch handled or tip followed counts, so placing a whole chain of nearest tips gives way too.
  let steps = 0;
  const step = async () => {
    if (++steps % TURN === 0) await pause();
  };
  const put = async (branch: Branch) => {
    placed.add(branch);
    placedAt.set(branch.tip, (placedAt.get(branch.tip) ?? 0) + 1);
    order.push(branch);
    await step();
  };
  for (let index = 0; index < ranked.length; index += 1) {
    await step();
    const branch = ranked[index];
    if (placed.has(branch)) continue;
    const chain: number[] = [];
    for (let tip = facts.nearest[branch.tip]; tip >= 0 && !settled(tip) && chain.length < facts.tips.length; tip = facts.nearest[tip]) {
      chain.push(tip);
      await step();
    }
    for (let link = chain.length - 1; link >= 0; link -= 1) {
      for (const other of byTip.get(chain[link]) ?? []) if (!placed.has(other)) await put(other);
    }
    await put(branch);
  }
  return order;
}

/**
 * The branch model of a clone: { defaultBranch, branches } with each branch, in name order, as { name, commit, default, base, fork, files, committedAt, people },
 * given the facts that readBranchFacts read and the names of the branches that a slice owns.
 * derived keeps each branch's fork, files, and people by its tip and its base's tip, so a later read reuses them, and it throws Superseded once live() is false.
 */
export async function readBranches(git: Git, facts: Facts, owned: Set<string>, { live = () => true, derived = new Map() }: { live?: Live; derived?: Map<string, any> } = {}) {
  const size = facts.tips.length;
  const main = facts.branches.find((branch) => branch.name === facts.defaultBranch)!;
  const order = await rankBranches(facts, owned);
  // Each branch's candidates other than the default branch, in ranked order: the first CANDIDATES ranked before it, the branches at its nearest tip,
  // and, for an owned branch, the CANDIDATES owned branches ranked nearest before it.
  // Branches at one tip hold the same commits, so they tie on every count and only the earliest ranked of them can be the base: each tip keeps that one candidate,
  // so however many branches share a tip, a branch weighs at most 2 * CANDIDATES + 1 candidates.
  const position = new Map(order.map((branch, index) => [branch, index]));
  const firstAtTip = new Map<number, Branch>();
  for (const branch of order) if (!firstAtTip.has(branch.tip)) firstAtTip.set(branch.tip, branch);
  const first = order.slice(0, CANDIDATES);
  const columnTips = new Set(first.map((branch) => branch.tip).filter((tip) => tip !== facts.mainTip));
  const recent: Branch[] = [];
  const candidates: Branch[][] = [];
  for (let index = 0; index < order.length; index += 1) {
    if (index % TURN === TURN - 1) await pause();
    const branch = order[index];
    const found = new Map<number, Branch>();
    const add = (other: Branch | undefined) => {
      if (!other || position.get(other)! >= index) return;
      const kept = found.get(other.tip);
      if (!kept || position.get(other)! < position.get(kept)!) found.set(other.tip, other);
    };
    for (const other of first) add(other);
    add(firstAtTip.get(facts.nearest[branch.tip]));
    if (owned.has(branch.name)) {
      for (const other of recent) add(other);
      recent.push(branch);
      if (recent.length > CANDIDATES) recent.shift();
    }
    candidates.push([...found.values()].sort((left, right) => position.get(left)! - position.get(right)!));
  }
  // own(B, C) from the counts that the facts hold, where a pair that no column, the default branch, or the nearest tip covers reads its own count.
  const ownPair = (branch: Branch, other: Branch) => (other.tip === branch.tip || other.tip === facts.mainTip || columnTips.has(other.tip) || facts.nearest[branch.tip] === other.tip
    ? null : branch.tip * size + other.tip);
  const known = (branch: Branch, other: Branch) => {
    if (other.tip === branch.tip) return 0;
    if (other.tip === facts.mainTip) return facts.ownOfMain[branch.tip];
    const column = facts.columns.get(other.tip);
    if (column) return column[branch.tip];
    if (facts.nearest[branch.tip] === other.tip) return facts.ownOfNearest[branch.tip];
    return facts.pairs.get(branch.tip * size + other.tip)!;
  };
  // Only the counts of this ranking's candidates are kept: one column for each tip of the first CANDIDATES branches, and one count for each other pair.
  for (const tip of facts.columns.keys()) if (!columnTips.has(tip)) facts.columns.delete(tip);
  const tipIndex = new Map(facts.tips.map((tip, index) => [tip, index]));
  for (const tip of columnTips) {
    if (facts.columns.has(tip)) continue;
    stopUnless(live);
    facts.columns.set(tip, await ownColumn(git, facts.tips[tip], facts.tips, tipIndex, live));
  }
  const wanted = new Set<number>();
  for (let index = 0; index < order.length; index += 1) {
    if (index % TURN === TURN - 1) await pause();
    for (const other of candidates[index]) {
      const pair = ownPair(order[index], other);
      if (pair !== null) wanted.add(pair);
    }
  }
  for (const pair of facts.pairs.keys()) if (!wanted.has(pair)) facts.pairs.delete(pair);
  await mapLimit([...wanted].filter((pair) => !facts.pairs.has(pair)), PARALLEL, async (pair) => {
    facts.pairs.set(pair, await count(git, [facts.tips[Math.floor(pair / size)], `^${facts.tips[pair % size]}`]));
  }, live);
  const bases = new Map<string, Branch | null>();
  for (let index = 0; index < order.length; index += 1) {
    if (index % TURN === TURN - 1) await pause();
    const branch = order[index];
    let chosen: Branch | null = null;
    let fewest = Infinity;
    // The default branch comes first and the candidates follow in ranked order, so a tie goes to the default branch and then to the earlier ranked one.
    // A candidate that shares no commit with this branch counts every commit of it, as many as any candidate can, so the fewest goes to one that shares a commit
    // whenever any does, and when it shares none, no allowed candidate does: its fork, read once the base is chosen, is then null and so is its base.
    for (const other of [main, ...candidates[index]]) {
      const owns = known(branch, other);
      if (owns < fewest) {
        fewest = owns;
        chosen = other;
      }
    }
    bases.set(branch.name, chosen);
  }
  const used = new Set<string>();
  const described = await mapLimit(facts.branches, PARALLEL, async (branch: any, index) => {
    if (index % TURN === TURN - 1) await pause();
    if (branch === main) return { name: branch.name, commit: branch.commit, default: true, base: null, fork: null, files: 0, committedAt: branch.committedAt, people: { last: null, count: 0 } };
    const base = bases.get(branch.name);
    const key = `${branch.commit}\0${base?.commit ?? ""}`;
    used.add(key);
    if (!derived.has(key)) derived.set(key, await derive(git, branch.commit, base?.commit ?? null));
    const { fork, files, people } = derived.get(key);
    return { name: branch.name, commit: branch.commit, default: false, base: fork === null ? null : base!.name, fork, files, committedAt: branch.committedAt, people };
  }, live);
  for (const key of derived.keys()) if (!used.has(key)) derived.delete(key);
  return { defaultBranch: facts.defaultBranch, branches: described };
}

// A branch's fork with its base, the number of files it changes, and its people since the fork, read from commits and trees alone.
async function derive(git: Git, tip: string, baseTip: string | null) {
  let fork: string | null = null;
  let files: number | null = null;
  if (baseTip) {
    const found = await git(["merge-base", tip, baseTip]);
    fork = found.ok && found.text ? lines(found.text)[0] : null;
  }
  if (fork) {
    // A changed file differs between the fork and the tip, and the base does not hold it as the tip does now.
    const sinceFork = await changedPaths(git, fork, tip);
    const fromBase = sinceFork.size ? await changedPaths(git, baseTip!, tip) : new Set<string>();
    files = [...sinceFork].filter((file) => fromBase.has(file)).length;
  }
  // The author log is read line by line, so only its distinct names are held, however long the history, and a long name is held as its digest,
  // which no name can equal because no author name holds a NUL.
  let last: string | null = null;
  const names = new Set<string>();
  await eachLine(git, ["log", "--format=%an", tip, ...(fork ? [`^${fork}`] : [])], (name) => {
    last ??= name;
    names.add(name.length <= NAME_KEPT ? name : `\0${createHash("sha1").update(name).digest().toString("base64", 0, 12)}`);
    return true;
  });
  return { fork, files, people: { last, count: names.size } };
}

/**
 * The branch reader of one clone, which runs at most one read at a time and keeps the answers of the latest ANSWERS sets of owners for the clone's current tips,
 * since workspaces that share a clone each name their own owned branches.
 * answer(tipsKey, owned) gives the model for the clone's current tips key and owned branch names when it is read, and otherwise queues its read and gives undefined;
 * a read whose tips a later call changed stops before its next Git command, and a read for other owners runs to its end, so each set of owners asked is answered in turn.
 */
export function createBranchReader(git: Git) {
  type Job = { key: string; tipsKey: string; owned: Set<string> };
  let facts: Facts | null = null;
  let factsKey: string | null = null;
  // The ready answers by key, least recently asked first.
  const answers = new Map<string, any>();
  // The reads asked for and not yet started, oldest first, all of the newest tips asked.
  const queued = new Map<string, Job>();
  let latest: string | null = null;
  let running: Promise<void> | null = null;
  let derived = new Map<string, any>();

  const keep = (key: string, model: any) => {
    answers.delete(key);
    answers.set(key, model);
    while (answers.size > ANSWERS) answers.delete(answers.keys().next().value!);
  };

  async function readOne(job: Job) {
    const live = () => latest === job.tipsKey;
    if (factsKey !== job.tipsKey) {
      // Only the newest tips' facts and answers are kept, so a read holds the counts of one set of tips at a time.
      facts = null;
      factsKey = null;
      derived = new Map();
      answers.clear();
      const read = await readBranchFacts(git, live);
      // A clone that names no default branch it holds answers the same for every set of owners, so its empty answer is kept for its tips as facts are.
      factsKey = read?.key ?? job.tipsKey;
      facts = read;
    }
    if (facts === null) {
      keep(job.key, { defaultBranch: null, branches: [] });
      return;
    }
    const model = await readBranches(git, facts!, job.owned, { live, derived });
    // A fetch between the request and the read changes the tips that the read found, so the answer is kept under the tips that it read.
    keep(`${factsKey}\0\0${[...job.owned].sort(byText).join("\0")}`, model);
  }

  function start() {
    let run: Promise<void> | null = null;
    run = (async () => {
      await null;
      try {
        while (queued.size) {
          const job: Job = queued.values().next().value!;
          queued.delete(job.key);
          if (answers.has(job.key)) continue;
          try {
            await readOne(job);
          } catch {
            // A superseded read is dropped, and a failed one is tried again at the next request, from the facts already read for the same tips.
          }
        }
      } finally {
        // Cleared in the same step that ends the loop, so a request that arrives after it starts a new read.
        if (running === run) running = null;
      }
    })();
    running = run;
  }

  return {
    answer(tipsKey: string, owned: Iterable<string>) {
      const names = new Set(owned);
      const key = `${tipsKey}\0\0${[...names].sort(byText).join("\0")}`;
      if (answers.has(key)) {
        const model = answers.get(key);
        keep(key, model);
        return model;
      }
      if (latest !== tipsKey) {
        latest = tipsKey;
        queued.clear();
      }
      if (!queued.has(key)) queued.set(key, { key, tipsKey, owned: names });
      while (queued.size > ANSWERS) queued.delete(queued.keys().next().value!);
      if (!running) start();
      return undefined;
    },
    /** Whether a read is running, so a caller can hold back a fetch that would supersede it. */
    get reading() { return running !== null; },
    /** Settles once no read runs, for tests and for a caller that waits on the answer. */
    async idle() { while (running) await running; }
  };
}
