// The branch model of one code clone: for each branch, the branch it most likely started from, where it forked, how many files it changes,
// when it last moved, and who committed to it, read from commits and trees alone, so no file's contents are fetched.
// Git records no branch that a branch started from, so the base is inferred: unowned branches, branches that receive merges, and branches that others were built on rank as bases.
// Every Git command names a commit, never a branch name, so a branch named like an option never reaches Git as one.

const BRANCHES = "refs/heads/";
// How many Git commands of one model run at a time.
const PARALLEL = 8;

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

type Git = (args: string[]) => Promise<{ ok: boolean; text: string; stdout: Buffer }>;

// Map items through an async function with at most limit calls running at once, keeping their order.
async function mapLimit<T, R>(items: T[], limit: number, action: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await action(items[index]);
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

// The paths that differ between two commits, read from their trees alone, with a rename as a removal and an addition.
async function changedPaths(git: Git, from: string, to: string) {
  if (from === to) return new Set<string>();
  const listed = await git(["diff-tree", "-r", "-z", "--no-renames", "--name-only", from, to]);
  return new Set(listed.ok ? listed.stdout.toString("utf8").split("\0").filter(Boolean) : []);
}

/**
 * The facts of a clone's branches that depend only on their tips: the default branch, each branch's tip, committer date, commit count,
 * merge commits that the default branch lacks, commits it holds that each other branch lacks, and its first-parent commits that the default branch lacks.
 * It answers null when the clone names no default branch that it holds.
 */
export async function readBranchFacts(git: Git) {
  const head = await git(["symbolic-ref", "--quiet", "HEAD"]);
  const headRef = head.ok ? head.text.trim() : "";
  const listed = await git(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)", BRANCHES]);
  if (!listed.ok) return null;
  const branches = lines(listed.text).map((line) => {
    const [ref, commit, date] = line.split("\0");
    return { name: ref.slice(BRANCHES.length), commit, committedAt: new Date(Number(date) * 1000).toISOString() };
  }).sort((left, right) => byText(left.name, right.name));
  if (!headRef.startsWith(BRANCHES)) return null;
  const defaultBranch = headRef.slice(BRANCHES.length);
  const main = branches.find((branch) => branch.name === defaultBranch);
  if (!main) return null;
  const others = branches.filter((branch) => branch !== main);
  const tips = [...new Set(branches.map((branch) => branch.commit))];
  // own[B][C], the commits that B holds and C does not, by tip: one for-each-ref per tip with ahead-behind, or rev-list per pair where this Git lacks it.
  const own = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  await mapLimit(tips, PARALLEL, async (tip) => {
    totals.set(tip, await count(git, [tip]));
    const row = new Map<string, number>();
    const compared = await git(["for-each-ref", `--format=%(objectname) %(ahead-behind:${tip})`, BRANCHES]);
    if (compared.ok) {
      for (const line of lines(compared.text)) {
        const [commit, , behind] = line.split(" ");
        row.set(commit, Number(behind));
      }
    } else {
      for (const other of tips) row.set(other, other === tip ? 0 : await count(git, [tip, `^${other}`]));
    }
    own.set(tip, row);
  });
  const merges = new Map<string, number>();
  const firstParents = new Map<string, Set<string>>();
  await mapLimit(others, PARALLEL, async (branch) => {
    merges.set(branch.name, await count(git, ["--merges", branch.commit, `^${main.commit}`]));
    const history = await git(["rev-list", "--first-parent", branch.commit, `^${main.commit}`]);
    firstParents.set(branch.name, new Set(history.ok ? lines(history.text) : []));
  });
  return { defaultBranch, branches, own, totals, merges, firstParents, derived: new Map<string, any>() };
}

/** Order the branches other than the default one as clause 8 ranks them, given the names of the branches that a slice owns. */
export function rankBranches(facts: any, owned: Set<string>) {
  const main = facts.branches.find((branch: any) => branch.name === facts.defaultBranch);
  const others = facts.branches.filter((branch: any) => branch !== main);
  const ownOf = (branch: any, other: any) => facts.own.get(branch.commit)?.get(other.commit) ?? 0;
  const ranked = [...others].sort((left: any, right: any) =>
    Number(owned.has(left.name)) - Number(owned.has(right.name))
    || facts.merges.get(right.name) - facts.merges.get(left.name)
    || ownOf(right, main) - ownOf(left, main)
    || byText(left.name, right.name));
  // A branch whose tip another branch's first-parent history holds moves just before the first such branch, so a branch built on another's tip never becomes its base.
  const before = (branch: any) => ranked.filter((other: any) => other !== branch && other.commit !== branch.commit && facts.firstParents.get(branch.name)?.has(other.commit));
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
 */
export async function readBranches(git: Git, facts: any, owned: Set<string>) {
  const main = facts.branches.find((branch: any) => branch.name === facts.defaultBranch);
  const order = rankBranches(facts, owned);
  const ownOf = (branch: any, other: any) => facts.own.get(branch.commit)?.get(other.commit) ?? 0;
  const bases = new Map<string, any>();
  order.forEach((branch: any, index: number) => {
    const total = facts.totals.get(branch.commit) ?? 0;
    let chosen: any = null;
    let fewest = Infinity;
    // The default branch comes first and the earlier ranked branches follow, so a tie goes to the default branch and then to the earlier ranked one.
    for (const candidate of [main, ...order.slice(0, index)]) {
      const owns = ownOf(branch, candidate);
      // A branch that holds every commit of this one's history shares none of it when this one holds all its commits apart from it.
      if (owns >= total && total > 0) continue;
      if (owns < fewest) {
        fewest = owns;
        chosen = candidate;
      }
    }
    bases.set(branch.name, chosen);
  });
  const described = await mapLimit(facts.branches, PARALLEL, async (branch: any) => {
    if (branch === main) return { name: branch.name, commit: branch.commit, default: true, base: null, fork: null, files: 0, committedAt: branch.committedAt, people: { last: null, count: 0 } };
    const base = bases.get(branch.name);
    const key = `${branch.commit}\0${base?.commit ?? ""}`;
    if (!facts.derived.has(key)) facts.derived.set(key, derive(git, branch.commit, base?.commit ?? null));
    const { fork, files, people } = await facts.derived.get(key);
    return { name: branch.name, commit: branch.commit, default: false, base: base?.name ?? null, fork, files, committedAt: branch.committedAt, people };
  });
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
