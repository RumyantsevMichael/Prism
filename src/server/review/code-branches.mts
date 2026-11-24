// The branch model of one code clone: for each branch, the branch it most likely started from, where it forked, how many files it changes,
// when it last moved, and who committed to it, read from commits and trees alone, so no file's contents are fetched.
// Git records no branch that a branch started from, so the base is inferred: unowned branches, branches that receive merges, and branches that others were built on rank as bases.
// Every Git command names a commit, never a branch name, so a branch named like an option never reaches Git as one.
//
// The work grows with the number of branches times a constant: each branch is compared with the default branch, with the branches at the nearest tip of its first-parent history,
// with the first CANDIDATES branches of the ranking, and, when a slice owns it, with the CANDIDATES owned branches ranked nearest before it, and only those counts are held.
// A branch's first-parent history is read only up to that nearest tip or the first commit that the default branch holds.
// The ranking and the base choice run without recursion and give way to the server's other work after at most TURN branches.
// All Git work runs in a background read, one at a time per clone, that a newer set of tips or owners supersedes, and the answer is kept for its tips, default branch, and owners,
// so a request with the answer ready does no work that grows faster than the number of branches.

const BRANCHES = "refs/heads/";
// How many Git commands of one model run at a time.
const PARALLEL = 8;
// How many of the first ranked branches, and of the owned branches ranked nearest before an owned branch, are a branch's candidate bases.
const CANDIDATES = 32;
// How many branches the ranking or the base choice handles before it gives way to the server's other work.
const TURN = 500;

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

type Git = (args: string[]) => Promise<{ ok: boolean; text: string; stdout: Buffer }>;
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

// The position of the nearest tip in a commit's first-parent history after the commit itself that the default branch lacks, or -1,
// read in batches that grow, so the history is read no further than that tip or the first commit that the default branch holds.
async function nearestTip(git: Git, tip: string, mainCommit: string, tipIndex: Map<string, number>, live: Live) {
  let from = tip;
  let skip = true;
  for (let batch = 16; ; batch = Math.min(batch * 2, 1024)) {
    stopUnless(live);
    const history = await git(["rev-list", "--first-parent", "--parents", `--max-count=${batch}`, from, `^${mainCommit}`]);
    const listed = history.ok ? lines(history.text) : [];
    for (const line of listed) {
      const commit = line.slice(0, line.indexOf(" ") < 0 ? line.length : line.indexOf(" "));
      if (skip) {
        skip = false;
        continue;
      }
      const found = tipIndex.get(commit);
      if (found !== undefined) return found;
    }
    if (listed.length < batch) return -1;
    const parent = listed.at(-1)!.split(" ")[1];
    if (!parent) return -1;
    from = parent;
    skip = false;
  }
}

/**
 * The facts of a clone's branches that depend only on their tips and default branch:
 * { key, defaultBranch, branches, tips, mainTip, totals, ownOfMain, merges, nearest, ownOfNearest, columns, pairs },
 * with each branch { name, commit, committedAt, tip } in name order and tip its position in tips, and, by tip position, its commit count, own(tip, default branch),
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
  const totals = new Uint32Array(size);
  const merges = new Uint32Array(size);
  const nearest = new Int32Array(size).fill(-1);
  const ownOfNearest = new Uint32Array(size);
  await mapLimit(tips, PARALLEL, async (tip, row) => {
    totals[row] = await count(git, [tip]);
    if (row === mainTip) return;
    merges[row] = await count(git, ["--merges", tip, `^${main.commit}`]);
    nearest[row] = await nearestTip(git, tip, main.commit, tipIndex, live);
    if (nearest[row] >= 0) ownOfNearest[row] = await count(git, [tip, `^${tips[nearest[row]]}`]);
  }, live);
  return { key, defaultBranch, branches: read, tips, mainTip, totals, ownOfMain, merges, nearest, ownOfNearest, columns: new Map<number, Uint32Array>(), pairs: new Map<number, number>() };
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
  const put = (branch: Branch) => {
    placed.add(branch);
    placedAt.set(branch.tip, (placedAt.get(branch.tip) ?? 0) + 1);
    order.push(branch);
  };
  for (let index = 0; index < ranked.length; index += 1) {
    if (index % TURN === TURN - 1) await pause();
    const branch = ranked[index];
    if (placed.has(branch)) continue;
    const chain: number[] = [];
    for (let tip = facts.nearest[branch.tip]; tip >= 0 && !settled(tip) && chain.length < facts.tips.length; tip = facts.nearest[tip]) chain.push(tip);
    for (let link = chain.length - 1; link >= 0; link -= 1) {
      for (const other of byTip.get(chain[link]) ?? []) if (!placed.has(other)) put(other);
    }
    put(branch);
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
  const position = new Map(order.map((branch, index) => [branch, index]));
  const byTip = new Map<number, Branch[]>();
  for (const branch of order) {
    if (!byTip.has(branch.tip)) byTip.set(branch.tip, []);
    byTip.get(branch.tip)!.push(branch);
  }
  const first = order.slice(0, CANDIDATES);
  const columnTips = new Set(first.map((branch) => branch.tip).filter((tip) => tip !== facts.mainTip));
  const recent: Branch[] = [];
  const candidates: Branch[][] = [];
  for (let index = 0; index < order.length; index += 1) {
    if (index % TURN === TURN - 1) await pause();
    const branch = order[index];
    const found = new Set<Branch>(first.slice(0, index));
    for (const other of byTip.get(facts.nearest[branch.tip]) ?? []) if (position.get(other)! < index) found.add(other);
    if (owned.has(branch.name)) {
      for (const other of recent) found.add(other);
      recent.push(branch);
      if (recent.length > CANDIDATES) recent.shift();
    }
    candidates.push([...found].sort((left, right) => position.get(left)! - position.get(right)!));
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
  order.forEach((branch, index) => {
    for (const other of candidates[index]) {
      const pair = ownPair(branch, other);
      if (pair !== null) wanted.add(pair);
    }
  });
  for (const pair of facts.pairs.keys()) if (!wanted.has(pair)) facts.pairs.delete(pair);
  await mapLimit([...wanted].filter((pair) => !facts.pairs.has(pair)), PARALLEL, async (pair) => {
    facts.pairs.set(pair, await count(git, [facts.tips[Math.floor(pair / size)], `^${facts.tips[pair % size]}`]));
  }, live);
  const bases = new Map<string, Branch | null>();
  for (let index = 0; index < order.length; index += 1) {
    if (index % TURN === TURN - 1) await pause();
    const branch = order[index];
    const total = facts.totals[branch.tip];
    let chosen: Branch | null = null;
    let fewest = Infinity;
    // The default branch comes first and the candidates follow in ranked order, so a tie goes to the default branch and then to the earlier ranked one.
    for (const other of [main, ...candidates[index]]) {
      const owns = known(branch, other);
      // A branch that holds every commit of this one's history shares none of it when this one holds all its commits apart from it.
      if (owns >= total && total > 0) continue;
      if (owns < fewest) {
        fewest = owns;
        chosen = other;
      }
    }
    bases.set(branch.name, chosen);
  }
  const used = new Set<string>();
  const described = await mapLimit(facts.branches, PARALLEL, async (branch: any) => {
    if (branch === main) return { name: branch.name, commit: branch.commit, default: true, base: null, fork: null, files: 0, committedAt: branch.committedAt, people: { last: null, count: 0 } };
    const base = bases.get(branch.name);
    const key = `${branch.commit}\0${base?.commit ?? ""}`;
    used.add(key);
    if (!derived.has(key)) derived.set(key, await derive(git, branch.commit, base?.commit ?? null));
    const { fork, files, people } = derived.get(key);
    return { name: branch.name, commit: branch.commit, default: false, base: base?.name ?? null, fork, files, committedAt: branch.committedAt, people };
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
  const authors = await git(["log", "--format=%an", tip, ...(fork ? [`^${fork}`] : [])]);
  const names = authors.ok ? lines(authors.text) : [];
  return { fork, files, people: { last: names[0] ?? null, count: new Set(names).size } };
}

/**
 * The branch reader of one clone, which runs at most one read at a time and keeps the latest answer.
 * answer(tipsKey, owned) gives the model for the clone's current tips key and owned branch names when it is read, and otherwise starts or retargets the background read and gives undefined;
 * a read whose tips or owners a later call changed stops before its next Git command, and the newest one starts when it ends.
 */
export function createBranchReader(git: Git) {
  let facts: Facts | null = null;
  let factsKey: string | null = null;
  let done: { key: string; model: any } | null = null;
  let wanted: { key: string; tipsKey: string; owned: Set<string> } | null = null;
  let running: Promise<void> | null = null;
  let derived = new Map<string, any>();

  async function readOne(job: { key: string; tipsKey: string; owned: Set<string> }) {
    if (factsKey !== job.tipsKey) {
      // Only the newest tips' facts are kept, so a read holds the counts of one set of tips at a time.
      facts = null;
      factsKey = null;
      derived = new Map();
      const read = await readBranchFacts(git, () => wanted?.tipsKey === job.tipsKey);
      if (read === null) {
        done = { key: job.key, model: { defaultBranch: null, branches: [] } };
        return;
      }
      facts = read;
      factsKey = read.key;
    }
    const model = await readBranches(git, facts!, job.owned, { live: () => wanted?.key === job.key, derived });
    // A fetch between the request and the read changes the tips that the read found, so the answer is kept under the tips that it read.
    done = { key: `${factsKey}\0\0${[...job.owned].sort(byText).join("\0")}`, model };
  }

  function start() {
    let run: Promise<void> | null = null;
    run = (async () => {
      await null;
      try {
        let last = null;
        while (wanted && wanted !== last && done?.key !== wanted.key) {
          last = wanted;
          try {
            await readOne(wanted);
          } catch (error) {
            // A failed read is tried again at the next request, from the facts already read for the same tips.
            if (!(error instanceof Superseded)) wanted = null;
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
      if (done?.key === key) return done.model;
      if (wanted?.key !== key) wanted = { key, tipsKey, owned: names };
      if (!running) start();
      return undefined;
    },
    /** Whether a read is running, so a caller can hold back a fetch that would supersede it. */
    get reading() { return running !== null; },
    /** Settles once no read runs, for tests and for a caller that waits on the answer. */
    async idle() { while (running) await running; }
  };
}
