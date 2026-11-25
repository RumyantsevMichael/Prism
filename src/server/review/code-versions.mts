// The Code place's files tree, a file's versions, and a version's difference, read for the lines of work that a scope of the Code sidebar shows.
// The tree and its marks come from the branch models, which hold each line of work's changed paths with their objects at its fork and its tip,
// so listing a folder reads trees alone, and only opening a file reads its blobs: line counts, differences, and Git's three-way conflict check.
// Nothing here writes to the record store, and file reads go through a clone's own reads, which name only commits and blobs that its branch model names.

import { byCodePoint } from "./code-branches.mjs";
import { ReadFailed, Superseded } from "./byte-cache.mjs";
import { secretPath, binaryPath } from "./review-server.mjs";

// How many Git reads of one file's versions run at a time.
const PARALLEL = 4;

type Owner = { initiative: string; slice: string };
type Mark = { kind: "agent" | "person"; name: string };
type Line = { repository: string; name: string; branch: any; owners: Owner[] };
type Contents = {
  entries: (commit: string, below: string) => Promise<{ name: string; type: string; blob: string | null }[]>;
  blobOf: (commit: string | null, file: string) => Promise<string | null>;
  read: (blob: string) => Promise<{ text?: string; lines?: number; withheld?: string } | null>;
  shownOf: (blob: string) => Promise<{ lines?: number; withheld?: string } | null>;
  diff: (before: string, after: string, options?: { whole?: boolean; lines?: number }) => Promise<any[] | null>;
  conflicts: (base: string | null, first: string | null, second: string | null) => Promise<boolean | null>;
  components: (commit: string) => Promise<{ declared: { name: string; folder: string }[]; file: boolean } | null>;
};

/** The place's state that the files, versions, and differences read: the place's answer, the branch models by repository, and the slices that own each line of work. */
export type PlaceState = {
  answer: any;
  models: Map<string, { defaultBranch: string | null; branches: any[] }>;
  owners: Map<string, Owner[]>;
  // The title and agent of a slice, as the Work sidebar names its claim's host.
  slice: (owner: Owner) => { title: string; agent: string };
};

// Each item's action, at most limit at a time, in which a failure stops every worker before its next item, so a failed read starts no further reads.
async function mapLimit<T, R>(items: T[], limit: number, action: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await action(items[index]); }
      catch (error) {
        failed = true;
        throw error;
      }
    }
  }));
  return results;
}

/** A clone's file reads that stop once signal is aborted: each read then throws Superseded before it starts, so a superseded answer's Git work stops at its next step. */
export function stopping(contents: Contents, signal: AbortSignal): Contents {
  const guarded: any = {};
  for (const [name, read] of Object.entries(contents) as [string, any][]) {
    guarded[name] = typeof read !== "function" ? read : (...args: any[]) => {
      if (signal.aborted) return Promise.reject(signal.reason instanceof Superseded ? signal.reason : new Superseded());
      return read(...args);
    };
  }
  return guarded;
}

// Each branch model's branches by name, built once for each model's branches, so finding a branch never scans them all.
const byName = new WeakMap<any[], { length: number; index: Map<string, any> }>();
function branchNamed(branches: any[], name: string) {
  let built = byName.get(branches);
  if (built?.length !== branches.length) {
    built = { length: branches.length, index: new Map() };
    for (const branch of branches) if (!built.index.has(branch.name)) built.index.set(branch.name, branch);
    byName.set(branches, built);
  }
  return built.index.get(name) ?? null;
}
const branchOf = (state: PlaceState, repository: string, name: string) => {
  const branches = state.models.get(repository)?.branches;
  return branches ? branchNamed(branches, name) : null;
};

/**
 * The lines of work that a scope shows, in sidebar order and each once, or null for a scope that the place does not list:
 * `all` for every line of work the sidebar lists, `work:<initiative>` and `work:<initiative>/<slice>` for those of a work item or slice row, and `branch:<repository>/<branch>` for one line of work row.
 */
export function scopeLines(state: PlaceState, scope: string): Line[] | null {
  const { answer } = state;
  const listed: { repository: string; branch: string }[] = [];
  const every = () => answer.work.flatMap((item: any) => [...item.slices.flatMap((slice: any) => slice.branches), ...item.branches]);
  if (scope === "all") listed.push(...every(), ...answer.branches);
  else if (scope.startsWith("work:")) {
    const named = scope.slice("work:".length);
    const slash = named.indexOf("/");
    const item = answer.work.find((each: any) => each.initiative === (slash < 0 ? named : named.slice(0, slash)));
    if (!item) return null;
    // A listed work item that changes no code yet is a scope too, with no line of work, so its answers show the base and nothing changed.
    if (slash < 0) {
      listed.push(...item.slices.flatMap((slice: any) => slice.branches), ...item.branches);
    } else {
      const slice = item.slices.find((each: any) => each.slice === named.slice(slash + 1));
      if (!slice) return null;
      listed.push(...slice.branches);
    }
  } else if (scope.startsWith("branch:")) {
    const named = scope.slice("branch:".length);
    const slash = named.indexOf("/");
    if (slash < 0) return null;
    const repository = named.slice(0, slash);
    const branch = named.slice(slash + 1);
    const found = [...every(), ...answer.branches].find((line: any) => line.repository === repository && line.branch === branch);
    if (!found) return null;
    listed.push(found);
  } else return null;
  const seen = new Set<string>();
  const lines: Line[] = [];
  for (const { repository, branch: name } of listed) {
    const key = `${repository}\0${name}`;
    const branch = branchOf(state, repository, name);
    if (seen.has(key) || !branch) continue;
    seen.add(key);
    lines.push({ repository, name, branch, owners: state.owners.get(key) ?? [] });
  }
  return lines;
}

// The agent or person marks of a line of work: each owning slice's agent, or the person that clause 20 names for a branch nobody owns.
function marksOf(state: PlaceState, line: Line): Mark[] {
  if (line.owners.length) return line.owners.map((owner) => ({ kind: "agent", name: state.slice(owner).agent }));
  const { last, count } = line.branch.people ?? {};
  if (!count) return [];
  return [{ kind: "person", name: count === 1 && last ? last : `${count} people` }];
}

const addMarks = (into: Map<string, Mark>, marks: Mark[]) => {
  for (const mark of marks) if (!into.has(`${mark.kind}\0${mark.name}`)) into.set(`${mark.kind}\0${mark.name}`, mark);
};

// Each changed path of a repository's shown lines with the lines that change it and their objects at the fork and the tip, from the branch models alone.
function changeIndex(lines: Line[], repository: string) {
  const index = new Map<string, { line: Line; fork: string | null; tip: string | null }[]>();
  for (const line of lines) {
    if (line.repository !== repository) continue;
    const paths: string[] = line.branch.paths ?? [];
    const blobs: [string | null, string | null][] = line.branch.blobs ?? [];
    paths.forEach((file, at) => {
      if (secretPath(file)) return;
      if (!index.has(file)) index.set(file, []);
      index.get(file)!.push({ line, fork: blobs[at]?.[0] ?? null, tip: blobs[at]?.[1] ?? null });
    });
  }
  return index;
}

// A file's change for its shown versions, as clause 29 states it, or null when no shown version changes it.
function changeOf(changes: { fork: string | null; tip: string | null }[] | undefined) {
  if (!changes?.length) return null;
  const kind = changes.every((change) => change.fork === null) ? "new" : changes.every((change) => change.tip === null) ? "removed" : "changed";
  return { kind, versions: new Set(changes.map((change) => change.tip ?? "")).size + 1 };
}

/**
 * The components that each folder of a repository's shown branches declares: a Map of folder ("" for the repository's own entry) to [{ name, branches, declaredOn }],
 * with the repository's root component, named as the repository, on "" for each shown branch that declares none.
 */
async function componentsOf(contents: Contents, repository: string, shown: { name: string; commit: string }[]) {
  const declared = await mapLimit(shown, PARALLEL, (branch) => contents.components(branch.commit));
  const byFolder = new Map<string, Map<string, string[]>>();
  const put = (folder: string, name: string, branch: string) => {
    if (!byFolder.has(folder)) byFolder.set(folder, new Map());
    const names = byFolder.get(folder)!;
    if (!names.has(name)) names.set(name, []);
    if (!names.get(name)!.includes(branch)) names.get(name)!.push(branch);
  };
  shown.forEach((branch, at) => {
    const declaration = declared[at];
    if (!declaration) return;
    if (!declaration.declared.length) put("", repository, branch.name);
    for (const component of declaration.declared) put(component.folder.replace(/^\/+|\/+$/g, ""), component.name, branch.name);
  });
  const answer = new Map<string, { name: string; branches: number; declaredOn: string[] }[]>();
  for (const [folder, names] of byFolder) {
    answer.set(folder, [...names].sort(([left], [right]) => byCodePoint(left, right))
      .map(([name, branches]) => ({ name, branches: branches.length, declaredOn: branches.length === shown.length ? [] : [...branches].sort(byCodePoint) })));
  }
  return answer;
}

// The default branch and the shown lines of a repository, as the branches whose declarations the tree shows.
function shownBranches(state: PlaceState, lines: Line[], repository: string) {
  const model = state.models.get(repository);
  const main = model?.branches.find((branch: any) => branch.default);
  return [...(main ? [{ name: main.name, commit: main.commit }] : []), ...lines.filter((line) => line.repository === repository).map((line) => ({ name: line.name, commit: line.branch.commit }))];
}

/**
 * The slot of a files or versions read: its route with everything of the request that selects its lines of work and what it reads,
 * the scope, quietDays, showQuiet, and the folder, or the repository and path, so only a read for newer tips of the same request supersedes it.
 */
export function readSlot(route: "files" | "versions", scope: string, shown: { quietDays: number; showQuiet: boolean }, ...what: (string | null)[]) {
  return JSON.stringify([route, scope, shown.quietDays, shown.showQuiet, ...what]);
}

/**
 * Everything of the branch models that a files or versions answer for a scope's lines reads, as a value to key a kept answer on:
 * each repository's default branch and its tip, and each line's repository, branch, tip, base, fork, base tip, and people, and each owner with the title and agent that the answer names,
 * so a kept answer is never answered after the default branch, a base branch, or a line's base or fork moves.
 */
export function answerKey(state: PlaceState, lines: Line[]) {
  const tipOf = (repository: string, name: string | null | undefined) => (name ? branchOf(state, repository, name)?.commit ?? null : null);
  const defaults = [...state.models].map(([repository, model]) => {
    const main = model.branches.find((branch: any) => branch.default);
    return [repository, main?.name ?? null, main?.commit ?? null];
  });
  return {
    defaults,
    lines: lines.map((line) => [line.repository, line.name, line.branch.commit, line.branch.base ?? null, line.branch.fork ?? null, tipOf(line.repository, line.branch.base), line.branch.people ?? null,
      line.owners.map((owner) => [owner.initiative, owner.slice, state.slice(owner)])])
  };
}

/**
 * The answer of GET ./api/code/files for a scope's lines: with folder null, every registered repository as { path, type: "repository", state, message, components, error },
 * where error is null, or { code: "read_failed", message } with no component for a repository whose read failed;
 * otherwise the files and folders of <repository>/<path>, folders first and each in name order, as { path, type, change, people, touched, components },
 * or { error } with a status and code for a folder that the place cannot list.
 */
export async function listFiles(state: PlaceState, lines: Line[], folder: string | null, contentsOf: (repository: string) => Promise<Contents | null>) {
  if (folder === null) {
    const entries = await Promise.all(state.answer.repositories.map(async (repository: any) => {
      const contents = state.models.has(repository.name) ? await contentsOf(repository.name) : null;
      // A repository whose read fails is marked by its error with no component, and the others answer as usual.
      try {
        const components = contents ? (await componentsOf(contents, repository.name, shownBranches(state, lines, repository.name))).get("") ?? [] : [];
        return { path: repository.name, type: "repository", state: repository.state, message: repository.message ?? null, components, error: null };
      } catch (error) {
        if (!(error instanceof ReadFailed)) throw error;
        return { path: repository.name, type: "repository", state: repository.state, message: repository.message ?? null, components: [], error: { code: error.code, message: error.message } };
      }
    }));
    return { entries };
  }
  const slash = folder.indexOf("/");
  const repository = slash < 0 ? folder : folder.slice(0, slash);
  const below = slash < 0 ? "" : folder.slice(slash + 1);
  const listed = state.answer.repositories.find((each: any) => each.name === repository);
  if (!listed) return { error: { status: 404, code: "repository_unknown", message: "The workspace has no repository of that name." } };
  if (state.answer.preparing.includes(repository)) return { preparing: true };
  const model = state.models.get(repository);
  const contents = model ? await contentsOf(repository) : null;
  const main = model?.branches.find((branch: any) => branch.default);
  if (!model || !contents || !main) return { error: { status: 404, code: "code_off", message: `The code content of ${repository} is off or not fetched yet, so this machine keeps no clone of it.` } };
  const prefix = below ? `${below}/` : "";
  const index = changeIndex(lines, repository);
  // The default branch's entries, then the files and folders that a shown version adds below the folder.
  const children = new Map<string, string>();
  for (const entry of await contents.entries(main.commit, below)) {
    if (entry.type === "file" && secretPath(`${prefix}${entry.name}`)) continue;
    children.set(entry.name, entry.type);
  }
  // The changed paths below the folder, each under the child of the folder that holds it.
  const under = new Map<string, string[]>();
  for (const [file, changes] of index) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const cut = rest.indexOf("/");
    const child = cut < 0 ? rest : rest.slice(0, cut);
    const type = cut < 0 ? "file" : "folder";
    if (!children.has(child) && changes.some((change) => change.tip !== null)) children.set(child, type);
    if (children.get(child) !== type) continue;
    if (!under.has(child)) under.set(child, []);
    under.get(child)!.push(file);
  }
  const components = await componentsOf(contents, repository, shownBranches(state, lines, repository));
  const entries = [...children].sort(([leftName, leftType], [rightName, rightType]) => (leftType === rightType ? byCodePoint(leftName, rightName) : leftType === "folder" ? -1 : 1))
    .map(([name, type]) => {
      const file = `${prefix}${name}`;
      const marks = new Map<string, Mark>();
      if (type === "file") {
        const changes = index.get(file);
        for (const change of changes ?? []) addMarks(marks, marksOf(state, change.line));
        const change = changeOf(changes);
        return { path: `${repository}/${file}`, type, change, people: [...marks.values()], touched: change !== null, components: [] };
      }
      const files = under.get(name) ?? [];
      for (const changed of files) for (const change of index.get(changed)!) addMarks(marks, marksOf(state, change.line));
      return { path: `${repository}/${file}`, type, change: null, people: [...marks.values()], touched: files.length > 0, components: components.get(file) ?? [] };
    });
  return { entries };
}

const textLines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** A version's difference from one fork, as clause 36's rows count it: its add and del rows, and its ranges [from, to] of the fork's lines, flat in one array. */
type Summary = { added: number; removed: number; ranges: Int32Array };

/**
 * The counts and ranges of a difference without context, from Git's hunks { before: [from, count], after: [from, count] }:
 * each hunk is one run of del and add rows between same rows, its range holds the before numbers of its del rows,
 * and a hunk of only add rows is [n, n] for the line n that it follows, or [1, 1] at the start of the file, so no change is joined to a nearby one.
 */
export function summaryOf(hunks: { before: number[]; after: number[] }[]): Summary {
  const ranges = new Int32Array(2 * hunks.length);
  let added = 0;
  let removed = 0;
  hunks.forEach(({ before: [from, count], after: [, plus] }, at) => {
    added += plus;
    removed += count;
    ranges[2 * at] = count > 0 ? from : Math.max(from, 1);
    ranges[2 * at + 1] = count > 0 ? from + count - 1 : Math.max(from, 1);
  });
  return { added, removed, ranges };
}

// The bounds of clause 35: the ranges kept for each version, the versions an entry names and the ranges a side of each, the pairs that Git merges check in one answer,
// and the comparisons of ranges that one answer's sweep makes, with a turn given to the server's other work after each COMPARISONS_PER_TURN of them.
export const CONFLICT_RANGES = 64;
export const CONFLICT_NAMED = 16;
export const CONFLICT_SIDE_RANGES = 8;
export const CONFLICT_CHECKS = 256;
export const RANGE_COMPARISONS = 4_000_000;
export const COMPARISONS_PER_TURN = 10_000;

/** A version's ranges, flat as [from, to, ...] in line order, with every range past the most-th joined into the most-th, which then reaches to the end of the last, so no change is dropped. */
export function cappedRanges(ranges: Int32Array, most = CONFLICT_RANGES): Int32Array {
  if (ranges.length <= 2 * most) return ranges;
  const capped = ranges.slice(0, 2 * most);
  capped[2 * most - 1] = ranges[ranges.length - 1];
  return capped;
}

/**
 * The ranges of own, flat and in line order, that overlap or directly follow a range of other, as [from, to] pairs in line order,
 * at most CONFLICT_SIDE_RANGES of them, the last joined to the end of the last one that it stands for.
 */
export function sideRanges(own: Int32Array, other: Int32Array): number[][] {
  const met: number[][] = [];
  let next = 0;
  for (let at = 0; at < own.length; at += 2) {
    const from = own[at];
    const to = own[at + 1];
    while (next < other.length && other[next + 1] + 1 < from) next += 2;
    if (next >= other.length) break;
    if (other[next] > to + 1) continue;
    if (met.length < CONFLICT_SIDE_RANGES) met.push([from, to]);
    else met[CONFLICT_SIDE_RANGES - 1][1] = to;
  }
  return met;
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The comparisons of ranges left to one answer, shared by the sweeps of all its groups. */
type Budget = { left: number; sinceTurn: number };

// A growing list of pairs of version indexes, each packed in one number as first * 2^26 + second, with first below second.
const PAIR_SHIFT = 2 ** 26;
function pairList() {
  let items = new Float64Array(1024);
  let length = 0;
  return {
    push(first: number, second: number) {
      if (length === items.length) {
        const grown = new Float64Array(items.length * 2);
        grown.set(items);
        items = grown;
      }
      items[length++] = first * PAIR_SHIFT + second;
    },
    // The distinct pairs, sorted by first and then second.
    distinct() {
      const sorted = items.subarray(0, length).sort();
      let kept = 0;
      for (let at = 0; at < sorted.length; at += 1) if (at === 0 || sorted[at] !== sorted[at - 1]) sorted[kept++] = sorted[at];
      return sorted.subarray(0, kept);
    }
  };
}

/**
 * One sweep of a group's ranges sorted by their start, which reports each meeting of two versions' ranges that overlap or directly follow each other:
 * a version's ranges never overlap each other, so each version's latest range has its furthest end, and only versions whose furthest end reaches the next range's start stay open.
 * Each comparison of a range with an open version spends one of the budget, and when the budget is spent the sweep stops,
 * adding to unfinished each version that it had not compared in full: those of the ranges it had not reached and those still open.
 */
export async function sweepRanges(members: { version: number; ranges: Int32Array }[], budget: Budget, into: (first: number, second: number) => void, unfinished: Set<number>) {
  const starts: [number, number, number][] = [];
  for (const { version, ranges } of members) for (let at = 0; at < ranges.length; at += 2) starts.push([ranges[at], ranges[at + 1], version]);
  starts.sort((left, right) => left[0] - right[0] || left[2] - right[2]);
  // The furthest end of each open version, and a heap of [end, version] that finds the versions whose end no longer reaches.
  const open = new Map<number, number>();
  const heap: [number, number][] = [];
  const push = (item: [number, number]) => {
    heap.push(item);
    for (let at = heap.length - 1; at > 0;) {
      const parent = (at - 1) >> 1;
      if (heap[parent][0] <= heap[at][0]) break;
      [heap[parent], heap[at]] = [heap[at], heap[parent]];
      at = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let at = 0; ;) {
        const left = 2 * at + 1;
        const right = left + 1;
        let least = at;
        if (left < heap.length && heap[left][0] < heap[least][0]) least = left;
        if (right < heap.length && heap[right][0] < heap[least][0]) least = right;
        if (least === at) break;
        [heap[least], heap[at]] = [heap[at], heap[least]];
        at = least;
      }
    }
    return top;
  };
  const stop = (from: number) => {
    for (const version of open.keys()) unfinished.add(version);
    for (let at = from; at < starts.length; at += 1) unfinished.add(starts[at][2]);
  };
  for (let index = 0; index < starts.length; index += 1) {
    const [from, to, version] = starts[index];
    while (heap.length && heap[0][0] + 1 < from) {
      const [end, closed] = pop();
      if (open.get(closed) === end) open.delete(closed);
    }
    for (const other of open.keys()) {
      if (other === version) continue;
      if (budget.left <= 0) return stop(index);
      budget.left -= 1;
      into(Math.min(other, version), Math.max(other, version));
      if (++budget.sinceTurn >= COMPARISONS_PER_TURN) {
        budget.sinceTurn = 0;
        await turn();
      }
    }
    if ((open.get(version) ?? -Infinity) < to) {
      open.set(version, to);
      push([to, version]);
    }
  }
}

/**
 * The answer of GET ./api/code/versions for a scope's lines, without the verified marks that withVerified adds: { repository, path, components, bases, versions, conflicts }, read with the clone's file reads,
 * or { error } for a path that the place does not show. The answer depends only on what answerKey names, so a caller may keep it for that key.
 * A read that fails, rather than finds nothing, throws ReadFailed, so no answer is built on it.
 * Its Git work is two blob reads and one difference for each version and fork, and Git merges for at most CONFLICT_CHECKS pairs, each read at most once for each of its groups, and its memory is linear in the versions' changed ranges.
 */
export async function fileVersions(state: PlaceState, lines: Line[], repository: string, file: string, contents: Contents) {
  const unavailable = { error: { status: 404, code: "file_unavailable", message: "The clone holds no such file to show: the path is no file of the default branch or of a shown version, or it is a secret." } };
  if (secretPath(file)) return unavailable;
  const model = state.models.get(repository)!;
  const main = model.branches.find((branch: any) => branch.default);
  const changes = changeIndex(lines, repository).get(file) ?? [];
  const tipOf = (name: string) => branchNamed(model.branches, name)?.commit ?? null;
  // Each distinct tip object of the lines that change the file, in sidebar order.
  const byBlob = new Map<string, typeof changes>();
  for (const change of changes) {
    const key = change.tip ?? "";
    if (!byBlob.has(key)) byBlob.set(key, []);
    byBlob.get(key)!.push(change);
  }
  const baseNames: string[] = [];
  for (const change of changes) if (change.line.branch.base && !baseNames.includes(change.line.branch.base)) baseNames.push(change.line.branch.base);
  if (!baseNames.length && main) baseNames.push(main.name);
  const bases = await Promise.all(baseNames.map(async (branch) => ({ branch, blob: await contents.blobOf(tipOf(branch), file) })));
  if (!changes.length && bases.every((base) => base.blob === null)) return unavailable;
  const shown = !binaryPath(file);
  // A blob's number of lines when the review app shows it, 0 for an absent file, or null.
  const linesOf = async (blob: string | null) => {
    if (blob === null) return 0;
    const looked = await contents.shownOf(blob);
    return typeof looked?.lines === "number" ? looked.lines : null;
  };
  // The summary of each distinct fork and tip that a shown line holds, read once, or null for a file that the review app does not show.
  const summaries = new Map<string, Summary | null>();
  const pairKey = (fork: string | null, tip: string | null) => `${fork ?? ""}\0${tip ?? ""}`;
  const pending = new Map<string, { fork: string | null; tip: string | null }>();
  for (const change of changes) pending.set(pairKey(change.fork, change.tip), change);
  await mapLimit([...pending], PARALLEL, async ([key, { fork, tip }]) => {
    if (!shown) return summaries.set(key, null);
    const [before, after] = await Promise.all([linesOf(fork), linesOf(tip)]);
    if (before === null || after === null) return summaries.set(key, null);
    if (fork === null) return summaries.set(key, { added: after, removed: 0, ranges: Int32Array.from(after ? [1, 1] : []) });
    if (tip === null) return summaries.set(key, { added: 0, removed: before, ranges: Int32Array.from(before ? [1, before] : []) });
    const hunks = await contents.diff(fork, tip);
    return summaries.set(key, hunks ? summaryOf(hunks) : null);
  });
  const held = [...byBlob.values()];
  const versions = held.map((changed) => {
    const blob = changed[0].tip;
    const owners = new Map<string, any>();
    const people = new Map<string, Mark>();
    for (const { line } of changed) {
      for (const owner of line.owners) {
        const key = `${owner.initiative}\0${owner.slice}`;
        if (!owners.has(key)) owners.set(key, { initiative: owner.initiative, slice: owner.slice, ...state.slice(owner) });
      }
      if (!line.owners.length) addMarks(people, marksOf(state, line));
    }
    const first = summaries.get(pairKey(changed[0].fork, blob));
    return {
      id: blob ?? "removed",
      blob,
      branches: changed.map(({ line }) => ({ repository: line.repository, branch: line.name, base: line.branch.base })),
      owners: [...owners.values()],
      people: [...people.values()],
      added: first ? first.added : null,
      removed: first ? first.removed : null,
      verified: false
    };
  });
  const conflicts = shown ? await conflictsOf(contents, versions, held, (fork, tip) => summaries.get(pairKey(fork, tip)) ?? null) : [];
  const components = await componentsOf(contents, repository, shownBranches(state, lines, repository));
  const folders = file.split("/").slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).join("/"));
  const fileComponents = [...(components.get("") ?? []), ...folders.flatMap((folder) => components.get(folder) ?? [])];
  return { repository, path: file, components: fileComponents, bases, versions, conflicts };
}

/**
 * A versions answer with each version's verified mark, true only when a passing verification run of an owning slice recorded the path with that blob,
 * read afresh for each request, so a store sync that brings a run shows on an answer kept for unchanged tips. verifiedFiles(owner) gives the `<path>\0<blob>` pairs.
 */
export async function withVerified(answer: any, verifiedFiles: (owner: Owner) => Promise<Set<string>>) {
  if (answer?.error) return answer;
  const versions = await Promise.all(answer.versions.map(async (version: any) => {
    let verified = false;
    for (const owner of version.owners) if ((await verifiedFiles(owner)).has(`${answer.path}\0${version.blob ?? ""}`)) verified = true;
    return { ...version, verified };
  }));
  return { ...answer, versions };
}

/**
 * The conflicts of clause 35, one entry { version, with, more, complete } per version in clause 34's order that conflicts with another or whose search did not finish.
 * The versions are grouped by each base branch and fork content of a line that holds them, with at most CONFLICT_RANGES ranges each, and each group's ranges are swept for the pairs that meet,
 * within one budget of `comparisons` comparisons of ranges for the answer.
 * Each version then names, in clause 34's order, the first CONFLICT_NAMED versions that it conflicts with: a pair is checked with Git's three-way merge from the fork content of each group where its ranges meet,
 * in turn until one conflicts, for the first CONFLICT_CHECKS distinct pairs of the answer in clause 34's order of version and then of named version, and a pair past them is taken to conflict without that check;
 * every check is settled before any entry is built, so a pair that every check finds clean is neither named nor counted on either side, and `more` counts the further versions whose ranges meet.
 */
export async function conflictsOf(contents: Pick<Contents, "conflicts">, versions: { id: string; blob: string | null }[], held: { line: { branch: { base?: string | null } }; fork: string | null; tip: string | null }[][],
  summary: (fork: string | null, tip: string | null) => { ranges: Int32Array } | null, comparisons = RANGE_COMPARISONS) {
  const groups: { fork: string | null; members: Map<number, Int32Array> }[] = [];
  const groupIndex = new Map<string, number>();
  const groupsOf: number[][] = versions.map(() => []);
  held.forEach((changed, version) => {
    for (const { line, fork, tip } of changed) {
      const base = line.branch.base;
      const ranges = summary(fork, tip)?.ranges;
      if (base === null || base === undefined || !ranges) continue;
      const key = `${base}\0${fork ?? ""}`;
      if (!groupIndex.has(key)) {
        groupIndex.set(key, groups.length);
        groups.push({ fork, members: new Map() });
      }
      const index = groupIndex.get(key)!;
      const group = groups[index];
      if (!group.members.has(version)) {
        group.members.set(version, cappedRanges(ranges));
        groupsOf[version].push(index);
      }
    }
  });
  const budget = { left: comparisons, sinceTurn: 0 };
  const found = pairList();
  const unfinished = new Set<number>();
  for (const group of groups) {
    if (group.members.size < 2) continue;
    const members = [...group.members].map(([version, ranges]) => ({ version, ranges }));
    if (budget.left <= 0) {
      for (const { version } of members) unfinished.add(version);
      continue;
    }
    await sweepRanges(members, budget, found.push, unfinished);
  }
  // Each version's partners, the versions whose ranges meet its own, in clause 34's order: the distinct pairs sorted by first and then second fill them in ascending order.
  const pairs = found.distinct();
  const degree = new Int32Array(versions.length + 1);
  for (const pair of pairs) {
    degree[Math.floor(pair / PAIR_SHIFT) + 1] += 1;
    degree[(pair % PAIR_SHIFT) + 1] += 1;
  }
  for (let at = 1; at < degree.length; at += 1) degree[at] += degree[at - 1];
  const partners = new Int32Array(2 * pairs.length);
  const filled = degree.slice(0, versions.length);
  for (const pair of pairs) {
    const first = Math.floor(pair / PAIR_SHIFT);
    const second = pair % PAIR_SHIFT;
    partners[filled[first]++] = second;
    partners[filled[second]++] = first;
  }
  // The groups where a pair's ranges meet, in the order the groups were found.
  const meetingGroups = (first: number, second: number) => groupsOf[first].filter((index) => groupsOf[second].includes(index) && sideRanges(groups[index].members.get(first)!, groups[index].members.get(second)!).length > 0);
  // What is known of each pair that some version considered: the group of its conflict, or null when every check found it clean.
  const known = new Map<number, number | null>();
  let checks = 0;
  async function resolve(asked: [number, number][]) {
    const pending = asked.filter(([first, second]) => !known.has(first * PAIR_SHIFT + second)).map(([first, second]) => ({ first, second, groups: meetingGroups(first, second), next: 0, counted: false }));
    while (pending.length) {
      const round: { pair: (typeof pending)[number]; group: number }[] = [];
      for (const pair of [...pending]) {
        const key = pair.first * PAIR_SHIFT + pair.second;
        if (pair.next >= pair.groups.length) {
          known.set(key, null);
          pending.splice(pending.indexOf(pair), 1);
        } else if (!pair.counted && checks >= CONFLICT_CHECKS) {
          known.set(key, pair.groups[pair.next]);
          pending.splice(pending.indexOf(pair), 1);
        } else {
          // A pair spends one of the answer's checks however many of its groups Git's merge reads, which its bases bound.
          if (!pair.counted) checks += 1;
          pair.counted = true;
          round.push({ pair, group: pair.groups[pair.next] });
        }
      }
      const results = await mapLimit(round, PARALLEL, ({ pair, group }) => contents.conflicts(groups[group].fork, versions[pair.first].blob, versions[pair.second].blob));
      round.forEach(({ pair, group }, at) => {
        if (results[at] === false) pair.next += 1;
        else {
          known.set(pair.first * PAIR_SHIFT + pair.second, group);
          pending.splice(pending.indexOf(pair), 1);
        }
      });
    }
  }
  const pairOf = (version: number, other: number) => Math.min(version, other) * PAIR_SHIFT + Math.max(version, other);
  // First every check, in clause 34's order of version and then of named version, until each version has CONFLICT_NAMED conflicts or none left to find.
  for (let version = 0; version < versions.length; version += 1) {
    const own = partners.subarray(degree[version], degree[version + 1]);
    let conflicting = 0;
    let at = 0;
    while (at < own.length && conflicting < CONFLICT_NAMED) {
      const asked = Array.from(own.subarray(at, at + CONFLICT_NAMED - conflicting), (other): [number, number] => [Math.min(version, other), Math.max(version, other)]);
      await resolve(asked);
      at += asked.length;
      for (const [first, second] of asked) if (known.get(first * PAIR_SHIFT + second) != null) conflicting += 1;
    }
  }
  // Then the entries, once every check is settled, so a pair that any check found clean is neither named nor counted on either side,
  // and a pair that no check read is taken to conflict.
  const entries: { version: string; with: { version: string; lines: { own: number[][]; other: number[][] } }[]; more: number; complete: boolean }[] = [];
  for (let version = 0; version < versions.length; version += 1) {
    const own = partners.subarray(degree[version], degree[version + 1]);
    const named: { version: string; lines: { own: number[][]; other: number[][] } }[] = [];
    let more = 0;
    for (const other of own) {
      const group = known.get(pairOf(version, other));
      if (group === null) continue;
      if (named.length >= CONFLICT_NAMED || group === undefined) {
        more += 1;
        continue;
      }
      const ranges = groups[group].members;
      named.push({ version: versions[other].id, lines: { own: sideRanges(ranges.get(version)!, ranges.get(other)!), other: sideRanges(ranges.get(other)!, ranges.get(version)!) } });
    }
    const complete = !unfinished.has(version);
    if (named.length || more || !complete) entries.push({ version: versions[version].id, with: named, more, complete });
  }
  return entries;
}

/**
 * The answer of GET ./api/code/diff for one branch of a repository: { repository, path, branch, base, fork, rows } covering the whole file,
 * the default branch answering its file as rows that are all same, or { error } for a path that the place does not show.
 */
export async function fileDiff(state: PlaceState, repository: string, file: string, name: string, contents: Contents) {
  const unavailable = { error: { status: 404, code: "file_unavailable", message: "Neither the branch's fork nor its tip holds that file, or it is a secret." } };
  if (secretPath(file)) return unavailable;
  const branch = branchOf(state, repository, name);
  if (!branch) return { error: { status: 404, code: "branch_unknown", message: "The clone of that repository holds no such branch." } };
  const fork = branch.default ? null : branch.fork;
  const [before, after] = await Promise.all([branch.default ? null : contents.blobOf(fork, file), contents.blobOf(branch.commit, file)]);
  const from = branch.default ? after : before;
  if (from === null && after === null) return unavailable;
  const answer = { repository, path: file, branch: name, base: branch.default ? null : branch.base, fork };
  const notShown = (reason: string) => ({ error: { status: 404, code: "file_not_shown", reason, message: `${file} is not available here because ${reason === "binary" ? "it is a binary file" : "it is over 512 KiB"}, which the review app does not show.` } });
  if (binaryPath(file)) return notShown("binary");
  const reads = await Promise.all([from, after].map((blob) => (blob === null ? Promise.resolve<any>({ text: "", lines: 0 }) : contents.read(blob))));
  for (const read of reads) if (read?.withheld) return notShown(read.withheld);
  if (reads.some((read) => !read || typeof read.text !== "string")) return unavailable;
  const [beforeLines, afterLines] = reads.map((read) => textLines(read!.text!));
  const rows: { op: string; before: number | null; after: number | null; text: string }[] = [];
  if (branch.default || from === after) {
    afterLines.forEach((text, at) => rows.push({ op: "same", before: at + 1, after: at + 1, text }));
  } else if (from === null) {
    afterLines.forEach((text, at) => rows.push({ op: "add", before: null, after: at + 1, text }));
  } else if (after === null) {
    beforeLines.forEach((text, at) => rows.push({ op: "del", before: at + 1, after: null, text }));
  } else {
    const hunks = await contents.diff(from, after, { whole: true, lines: Math.max(beforeLines.length, afterLines.length) });
    if (!hunks) return unavailable;
    let old = 1;
    let next = 1;
    const same = (until: number) => {
      while (old < until) rows.push({ op: "same", before: old, after: next++, text: beforeLines[old++ - 1] });
    };
    for (const hunk of hunks) {
      same(hunk.before[1] === 0 ? hunk.before[0] + 1 : hunk.before[0]);
      for (const line of hunk.lines) {
        if (line.startsWith("-")) rows.push({ op: "del", before: old++, after: null, text: line.slice(1) });
        else if (line.startsWith("+")) rows.push({ op: "add", before: null, after: next++, text: line.slice(1) });
        else rows.push({ op: "same", before: old++, after: next++, text: line.slice(1) });
      }
    }
    same(beforeLines.length + 1);
  }
  return { ...answer, rows };
}
