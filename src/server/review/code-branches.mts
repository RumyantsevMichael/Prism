// The branch model of one code clone: for each branch, the branch it most likely started from, where it forked, how many files it changes,
// when it last moved, and who committed to it, read from commits and trees alone, so no file's contents are fetched.
// Git records no branch that a branch started from, so the base is inferred: unowned branches, branches that receive merges, and branches that others were built on rank as bases.
// Every Git command names a commit, never a branch name, so a branch named like an option never reaches Git as one.
//
// Choosing a base compares every branch with every other, so the model holds one count for each ordered pair of distinct tips, as 4-byte numbers indexed by tip position:
// 16 MB for 2000 distinct tips, plus the tips in each branch's first-parent history, at most 4 bytes per pair, and a few records per branch.
// All Git work runs in a background read, one at a time per clone, that a newer set of tips or owners supersedes, and the answer is kept for its tips, default branch, and owners,
// so a request with the answer ready does no work that grows faster than the number of branches.

const BRANCHES = "refs/heads/";
// How many Git commands of one model run at a time.
const PARALLEL = 8;

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

type Git = (args: string[]) => Promise<{ ok: boolean; text: string; stdout: Buffer }>;
type Live = () => boolean;

/** Thrown by a read that a newer request superseded, so it stops before its next Git command. */
export class Superseded extends Error {}

// Map items through an async function with at most limit calls running at once, keeping their order, and stopping before the next call once live() is false.
async function mapLimit<T, R>(items: T[], limit: number, action: (item: T, index: number) => Promise<R>, live: Live = () => true): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (!live()) throw new Superseded("a newer read superseded this one");
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

/**
 * The facts of a clone's branches that depend only on their tips and default branch: { key, defaultBranch, branches, tips, own, totals, merges, firstParentTips },
 * with each branch { name, commit, committedAt, tip } in name order, tip its position in tips, own[b * tips.length + c] the commits that tip b holds and tip c does not,
 * totals each tip's commit count, and, by branch position, its merge commits that the default branch lacks and the tips in its first-parent history that the default branch lacks.
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
  const mainIndex = read.findIndex((branch) => branch.name === defaultBranch);
  if (mainIndex < 0) return null;
  const main = read[mainIndex];
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
  const own = new Uint32Array(size * size);
  const totals = new Uint32Array(size);
  // One for-each-ref per tip with ahead-behind, or rev-list per pair where this Git lacks it.
  await mapLimit(tips, PARALLEL, async (tip, row) => {
    totals[row] = await count(git, [tip]);
    const compared = await git(["for-each-ref", `--format=%(objectname) %(ahead-behind:${tip})`, BRANCHES]);
    if (compared.ok) {
      for (const line of lines(compared.text)) {
        const [commit, , behind] = line.split(" ");
        const column = tipIndex.get(commit);
        if (column !== undefined) own[row * size + column] = Number(behind);
      }
    } else {
      for (let column = 0; column < size; column += 1) {
        if (!live()) throw new Superseded("a newer read superseded this one");
        if (column !== row) own[row * size + column] = await count(git, [tip, `^${tips[column]}`]);
      }
    }
  }, live);
  const merges = new Uint32Array(read.length);
  const firstParentTips: Int32Array[] = new Array(read.length);
  await mapLimit(read, PARALLEL, async (branch, index) => {
    if (index === mainIndex) {
      firstParentTips[index] = new Int32Array(0);
      return;
    }
    merges[index] = await count(git, ["--merges", branch.commit, `^${main.commit}`]);
    const history = await git(["rev-list", "--first-parent", branch.commit, `^${main.commit}`]);
    const held: number[] = [];
    for (const commit of history.ok ? lines(history.text) : []) {
      const found = tipIndex.get(commit);
      if (found !== undefined) held.push(found);
    }
    firstParentTips[index] = Int32Array.from(held);
  }, live);
  return { key, defaultBranch, branches: read, tips, own, totals, merges, firstParentTips };
}

type Facts = NonNullable<Awaited<ReturnType<typeof readBranchFacts>>>;

/** Order the branches other than the default one as clause 8 ranks them, given the names of the branches that a slice owns. */
export function rankBranches(facts: Facts, owned: Set<string>) {
  const size = facts.tips.length;
  const mainIndex = facts.branches.findIndex((branch) => branch.name === facts.defaultBranch);
  const main = facts.branches[mainIndex];
  const positions = new Map(facts.branches.map((branch, index) => [branch, index]));
  const others = facts.branches.filter((branch) => branch !== main);
  const ownOfMain = (branch: any) => facts.own[branch.tip * size + main.tip];
  const mergesOf = (branch: any) => facts.merges[positions.get(branch)!];
  const ranked = [...others].sort((left, right) =>
    Number(owned.has(left.name)) - Number(owned.has(right.name))
    || mergesOf(right) - mergesOf(left)
    || ownOfMain(right) - ownOfMain(left)
    || byText(left.name, right.name));
  const rank = new Map(ranked.map((branch, index) => [branch, index]));
  const byTip = new Map<number, any[]>();
  for (const branch of ranked) {
    if (!byTip.has(branch.tip)) byTip.set(branch.tip, []);
    byTip.get(branch.tip)!.push(branch);
  }
  // A branch whose tip another branch's first-parent history holds moves just before the first such branch, so a branch built on another's tip never becomes its base.
  const before = (branch: any) => {
    const found = new Set<any>();
    for (const tip of facts.firstParentTips[positions.get(branch)!]) {
      if (tip === branch.tip) continue;
      for (const other of byTip.get(tip) ?? []) found.add(other);
    }
    return [...found].sort((left, right) => rank.get(left)! - rank.get(right)!);
  };
  const order: any[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (branch: any) => {
    if (placed.has(branch.name) || visiting.has(branch.name)) return;
    visiting.add(branch.name);
    for (const earlier of before(branch)) place(earlier);
    visiting.delete(branch.name);
    placed.add(branch.name);
    order.push(branch);
  };
  for (const branch of ranked) place(branch);
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
  const order = rankBranches(facts, owned);
  const bases = new Map<string, any>();
  order.forEach((branch: any, index: number) => {
    const row = branch.tip * size;
    const total = facts.totals[branch.tip];
    let chosen: any = null;
    let fewest = Infinity;
    // The default branch comes first and the earlier ranked branches follow, so a tie goes to the default branch and then to the earlier ranked one.
    for (let candidate = -1; candidate < index; candidate += 1) {
      const other = candidate < 0 ? main : order[candidate];
      const owns = facts.own[row + other.tip];
      // A branch that holds every commit of this one's history shares none of it when this one holds all its commits apart from it.
      if (owns >= total && total > 0) continue;
      if (owns < fewest) {
        fewest = owns;
        chosen = other;
      }
    }
    bases.set(branch.name, chosen);
  });
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
      // Only the newest tips' facts are kept, so a read holds one table of pair counts at a time.
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
    running = (async () => {
      let last = null;
      while (wanted && wanted !== last && done?.key !== wanted.key) {
        last = wanted;
        try {
          await readOne(wanted);
        } catch (error) {
          if (!(error instanceof Superseded)) {
            // A failed read is tried again at the next request.
            wanted = null;
            facts = null;
            factsKey = null;
          }
        }
      }
    })().finally(() => { running = null; });
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
