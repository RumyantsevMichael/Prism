// The Code place's files tree, a file's versions, and a version's difference, read for the lines of work that a scope of the Code sidebar shows.
// The tree and its marks come from the branch models, which hold each line of work's changed paths with their objects at its fork and its tip,
// so listing a folder reads trees alone, and only opening a file reads its blobs: line counts, differences, and Git's three-way conflict check.
// Nothing here writes to the record store, and file reads go through a clone's own reads, which name only commits and blobs that its branch model names.

import { byCodePoint } from "./code-branches.mjs";
import { secretPath, binaryPath } from "./review-server.mjs";

// How many versions of one file are checked pairwise for conflicts, so a file that many branches change costs a bounded number of merge checks.
export const CONFLICT_VERSIONS = 32;
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
  mergeBase: (first: string, second: string) => Promise<string | null>;
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

async function mapLimit<T, R>(items: T[], limit: number, action: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await action(items[index]);
    }
  }));
  return results;
}

const branchOf = (state: PlaceState, repository: string, name: string) => state.models.get(repository)?.branches.find((branch: any) => branch.name === name) ?? null;

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
    if (slash < 0) {
      if (!item.slices.length && !item.branches.length) return null;
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
 * The answer of GET ./api/code/files for a scope's lines: with folder null, every registered repository as { path, type: "repository", state, message, components };
 * otherwise the files and folders of <repository>/<path>, folders first and each in name order, as { path, type, change, people, touched, components },
 * or { error } with a status and code for a folder that the place cannot list.
 */
export async function listFiles(state: PlaceState, lines: Line[], folder: string | null, contentsOf: (repository: string) => Promise<Contents | null>) {
  if (folder === null) {
    const entries = await Promise.all(state.answer.repositories.map(async (repository: any) => {
      const contents = state.models.has(repository.name) ? await contentsOf(repository.name) : null;
      const components = contents ? (await componentsOf(contents, repository.name, shownBranches(state, lines, repository.name))).get("") ?? [] : [];
      return { path: repository.name, type: "repository", state: repository.state, message: repository.message ?? null, components };
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

/**
 * The regions of the earlier file that a difference without context changes, in order, as { from, to, added, removed } with from and to its lines:
 * an insertion after line k is read at line k, so it changes nothing there on its own, and an insertion right after a changed line's neighbour joins that change,
 * taking the line between, as Git's three-way merge reads changes that touch as one; the counts of a version and the conflict ranges both come from these regions.
 */
export function changedRegions(hunks: { before: number[]; after: number[] }[]) {
  const regions: { from: number; to: number; added: number; removed: number }[] = [];
  for (const { before: [from, count], after: [, added] } of hunks) {
    const previous = regions.at(-1);
    if (count > 0) regions.push({ from, to: from + count - 1, added, removed: count });
    else if (previous && previous.removed > 0 && previous.to === from - 1) Object.assign(previous, { to: from, added: previous.added + 1 + added, removed: previous.removed + 1 });
    else regions.push({ from: Math.max(from, 1), to: Math.max(from, 1), added, removed: 0 });
  }
  return regions;
}

// The earlier file's line ranges [from, to] that a difference's regions change.
const rangesOf = (hunks: any[]) => changedRegions(hunks).map((region) => [region.from, region.to]);

/**
 * The answer of GET ./api/code/versions for a scope's lines: { repository, path, components, bases, versions, conflicts }, read with the clone's file reads,
 * or { error } for a path that the place does not show. verifiedFiles(owner) gives the `<path>\0<blob>` pairs that the passing runs of an owning slice recorded.
 */
export async function fileVersions(state: PlaceState, lines: Line[], repository: string, file: string, contents: Contents, verifiedFiles: (owner: Owner) => Promise<Set<string>>) {
  const unavailable = { error: { status: 404, code: "file_unavailable", message: "The clone holds no such file to show: the path is no file of the default branch or of a shown version, or it is a secret." } };
  if (secretPath(file)) return unavailable;
  const model = state.models.get(repository)!;
  const main = model.branches.find((branch: any) => branch.default);
  const changes = changeIndex(lines, repository).get(file) ?? [];
  const tipOf = (name: string) => model.branches.find((branch: any) => branch.name === name)?.commit ?? null;
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
  const counted = await mapLimit([...byBlob.values()], PARALLEL, async (held) => {
    const { fork, tip } = held[0];
    const none = { added: null, removed: null };
    if (!shown) return none;
    const [before, after] = await Promise.all([linesOf(fork), linesOf(tip)]);
    if (before === null || after === null) return none;
    if (fork === null || tip === null) return { added: after, removed: before };
    const hunks = await contents.diff(fork, tip);
    if (!hunks) return none;
    const regions = changedRegions(hunks);
    return { added: regions.reduce((sum, region) => sum + region.added, 0), removed: regions.reduce((sum, region) => sum + region.removed, 0) };
  });
  const versions = await Promise.all([...byBlob.values()].map(async (held, at) => {
    const blob = held[0].tip;
    const owners = new Map<string, any>();
    const people = new Map<string, Mark>();
    for (const { line } of held) {
      for (const owner of line.owners) {
        const key = `${owner.initiative}\0${owner.slice}`;
        if (!owners.has(key)) owners.set(key, { initiative: owner.initiative, slice: owner.slice, ...state.slice(owner) });
      }
      if (!line.owners.length) addMarks(people, marksOf(state, line));
    }
    let verified = false;
    for (const owner of owners.values()) if ((await verifiedFiles(owner)).has(`${file}\0${blob ?? ""}`)) verified = true;
    return {
      id: blob ?? "removed",
      blob,
      branches: held.map(({ line }) => ({ repository: line.repository, branch: line.name, base: line.branch.base })),
      owners: [...owners.values()],
      people: [...people.values()],
      ...counted[at],
      verified
    };
  }));
  const conflicts = shown ? await conflictsOf(contents, file, versions.slice(0, CONFLICT_VERSIONS), [...byBlob.values()], tipOf, linesOf) : [];
  const components = await componentsOf(contents, repository, shownBranches(state, lines, repository));
  const folders = file.split("/").slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).join("/"));
  const fileComponents = [...(components.get("") ?? []), ...folders.flatMap((folder) => components.get(folder) ?? [])];
  return { repository, path: file, components: fileComponents, bases, versions, conflicts };
}

// The pairs of versions whose lines of work share a base branch and whose file Git's three-way merge from the merge base of their branches reports as a conflict.
async function conflictsOf(contents: Contents, file: string, versions: any[], held: any[][], tipOf: (name: string) => string | null, linesOf: (blob: string | null) => Promise<number | null>) {
  const pairs: [number, number, any, any][] = [];
  for (let first = 0; first < versions.length; first += 1) {
    for (let second = first + 1; second < versions.length; second += 1) {
      let shared: [any, any] | null = null;
      for (const left of held[first]) {
        const right = held[second].find((change: any) => change.line.branch.base !== null && change.line.branch.base === left.line.branch.base);
        if (right) {
          shared = [left, right];
          break;
        }
      }
      if (shared) pairs.push([first, second, shared[0], shared[1]]);
    }
  }
  const checked = await mapLimit(pairs, PARALLEL, async ([first, second, left, right]) => {
    const tips = [tipOf(left.line.name), tipOf(right.line.name)];
    if (!tips[0] || !tips[1]) return null;
    const mergeBase = await contents.mergeBase(tips[0], tips[1]);
    const base = mergeBase ? await contents.blobOf(mergeBase, file) : null;
    const [baseLines, firstLines, secondLines] = await Promise.all([linesOf(base), linesOf(versions[first].blob), linesOf(versions[second].blob)]);
    if (baseLines === null || firstLines === null || secondLines === null) return null;
    if (!(await contents.conflicts(base, versions[first].blob, versions[second].blob))) return null;
    // A removal changes every line of the merge base, and a file that the merge base lacks is read as changing its first line.
    const changed = async (blob: string | null) => {
      if (blob === null) return [[1, Math.max(1, baseLines)]];
      if (base === null) return [[1, 1]];
      return rangesOf(await contents.diff(base, blob) ?? []);
    };
    return { first: versions[first].id, second: versions[second].id, lines: { first: await changed(versions[first].blob), second: await changed(versions[second].blob) } };
  });
  return checked.filter(Boolean);
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
