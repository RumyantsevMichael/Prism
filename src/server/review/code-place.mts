// The Code place's answer: the lines of work of the initiatives in progress, by their slices, and the other pushed branches that change code,
// read from the branch models of the repositories' code clones and the slices that own their branches, so no file content is read for it.

import { byCodePoint } from "./code-branches.mjs";
import { ownerKey } from "./code-owners.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a branch is quiet: a branch other than the default branch whose tip is more whole days old than quietDays, so a tip exactly one day old is not quiet at 1. */
export const isQuiet = (branch: { default: boolean; committedAt: string }, quietDays: number, now = Date.now()) =>
  !branch.default && Math.floor((now - Date.parse(branch.committedAt)) / DAY_MS) > quietDays;

type Owner = { initiative: string; slice: string };
type Model = { defaultBranch: string | null; branches: any[] };
// An initiative of Work's In progress group with its slice tree: root is its root slice, children its slices' children in record order, and titles its slices' titles.
type WorkItem = { initiative: string; title: string; root: string | null; children: Record<string, string[]>; titles: Record<string, string> };

/**
 * The answer of GET ./api/code/place: { lines, repositories, work, branches, quiet, preparing }.
 * repositories lists each registered repository as { name, state, message }, models holds the branch model of each repository whose branches are read,
 * preparing names those whose branches are still being read, owners maps ownerKey to the slices that own that line of work, and work lists Work's In progress initiatives in order.
 */
export function placeAnswer({ repositories, models, preparing, owners, work, quietDays, showQuiet, now = Date.now() }:
  { repositories: { name: string; state: string; message: string | null }[]; models: Map<string, Model>; preparing: string[]; owners: Map<string, Owner[]>; work: WorkItem[]; quietDays: number; showQuiet: boolean; now?: number }) {
  // Every line of work of the read repositories, in repository and then branch order, with the slices that own it.
  const lines: any[] = [];
  for (const repository of [...models.keys()].sort(byCodePoint)) {
    for (const branch of models.get(repository)!.branches) {
      if (branch.default) continue;
      lines.push({ repository, branch, owners: owners.get(ownerKey(repository, branch.name)) ?? [] });
    }
  }
  const changing = lines.filter((line) => typeof line.branch.files === "number" && line.branch.files > 0);
  const entry = (line: any) => ({ repository: line.repository, branch: line.branch.name, base: line.branch.base, files: line.branch.files });
  const distinctFiles = (owned: any[]) => new Set(owned.flatMap((line) => line.branch.paths.map((file: string) => `${line.repository}\0${file}`))).size;
  // The lines of work that one of the slices named owns, each once, in repository and then branch order.
  const ownedBy = (initiative: string, slugs: Set<string>) => changing.filter((line) => line.owners.some((owner: Owner) => owner.initiative === initiative && slugs.has(owner.slice)));
  const below = (item: WorkItem, slug: string) => {
    const slugs = new Set<string>();
    for (const stack = [slug]; stack.length;) {
      const next = stack.pop()!;
      if (slugs.has(next)) continue;
      slugs.add(next);
      stack.push(...(item.children[next] ?? []));
    }
    return slugs;
  };
  // The repository and branch pairs that the answer lists, which lines counts.
  const listed = new Set<string>();
  const note = (owned: any[]) => {
    for (const line of owned) listed.add(ownerKey(line.repository, line.branch.name));
    return owned;
  };
  const workAnswer = work.map((item) => {
    const all = item.root === null ? [] : ownedBy(item.initiative, below(item, item.root));
    const children = item.root === null ? [] : item.children[item.root] ?? [];
    const slices = children.map((slug) => ({ slug, owned: ownedBy(item.initiative, below(item, slug)) }))
      .filter((slice) => slice.owned.length)
      .map((slice) => ({ ...slice, owned: note(slice.owned) }))
      .map(({ slug, owned }) => ({ slice: slug, title: item.titles[slug] ?? slug, files: distinctFiles(owned), branches: owned.map(entry) }));
    return { initiative: item.initiative, title: item.title, files: distinctFiles(all), slices, branches: children.length ? [] : note(all).map(entry) };
  });
  const unowned = lines.filter((line) => !line.owners.length && ((typeof line.branch.files === "number" && line.branch.files > 0) || line.branch.base === null))
    .map((line) => ({ ...line, quiet: isQuiet(line.branch, quietDays, now) }));
  const shown = unowned.filter((line) => showQuiet || !line.quiet);
  const branches = shown
    .sort((left, right) => Date.parse(right.branch.committedAt) - Date.parse(left.branch.committedAt) || byCodePoint(left.repository, right.repository) || byCodePoint(left.branch.name, right.branch.name))
    .map((line) => {
      listed.add(ownerKey(line.repository, line.branch.name));
      return { ...entry(line), committedAt: line.branch.committedAt, people: line.branch.people, quiet: line.quiet };
    });
  return {
    lines: listed.size,
    repositories: [...repositories].sort((left, right) => byCodePoint(left.name, right.name)),
    work: workAnswer,
    branches,
    quiet: { hidden: unowned.length - shown.length, days: quietDays },
    preparing: [...preparing].sort(byCodePoint)
  };
}
