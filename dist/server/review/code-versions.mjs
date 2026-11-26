// Generated from src/server/review/code-versions.mts by scripts/native-build/compile.mjs.
import { byCodePoint } from "./code-branches.mjs";
import { ReadFailed, Superseded } from "./byte-cache.mjs";
import { secretPath, binaryPath } from "./review-server.mjs";
const PARALLEL = 4;
async function mapLimit(items, limit, action) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await action(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }));
  return results;
}
function stopping(contents, signal) {
  const guarded = {};
  for (const [name, read] of Object.entries(contents)) {
    guarded[name] = typeof read !== "function" ? read : (...args) => {
      if (signal.aborted) return Promise.reject(signal.reason instanceof Superseded ? signal.reason : new Superseded());
      return read(...args);
    };
  }
  return guarded;
}
const byName = /* @__PURE__ */ new WeakMap();
function branchNamed(branches, name) {
  let built = byName.get(branches);
  if (built?.length !== branches.length) {
    built = { length: branches.length, index: /* @__PURE__ */ new Map() };
    for (const branch of branches) if (!built.index.has(branch.name)) built.index.set(branch.name, branch);
    byName.set(branches, built);
  }
  return built.index.get(name) ?? null;
}
const branchOf = (state, repository, name) => {
  const branches = state.models.get(repository)?.branches;
  return branches ? branchNamed(branches, name) : null;
};
function scopeLines(state, scope) {
  const { answer } = state;
  const listed = [];
  const every = () => answer.work.flatMap((item) => [...item.slices.flatMap((slice) => slice.branches), ...item.branches]);
  if (scope === "all") listed.push(...every(), ...answer.branches);
  else if (scope.startsWith("work:")) {
    const named = scope.slice("work:".length);
    const slash = named.indexOf("/");
    const item = answer.work.find((each) => each.initiative === (slash < 0 ? named : named.slice(0, slash)));
    if (!item) return null;
    if (slash < 0) {
      listed.push(...item.slices.flatMap((slice) => slice.branches), ...item.branches);
    } else {
      const slice = item.slices.find((each) => each.slice === named.slice(slash + 1));
      if (!slice) return null;
      listed.push(...slice.branches);
    }
  } else if (scope.startsWith("branch:")) {
    const named = scope.slice("branch:".length);
    const slash = named.indexOf("/");
    if (slash < 0) return null;
    const repository = named.slice(0, slash);
    const branch = named.slice(slash + 1);
    const found = [...every(), ...answer.branches].find((line) => line.repository === repository && line.branch === branch);
    if (!found) return null;
    listed.push(found);
  } else return null;
  const seen = /* @__PURE__ */ new Set();
  const lines = [];
  for (const { repository, branch: name } of listed) {
    const key = `${repository}\0${name}`;
    const branch = branchOf(state, repository, name);
    if (seen.has(key) || !branch) continue;
    seen.add(key);
    lines.push({ repository, name, branch, owners: state.owners.get(key) ?? [] });
  }
  return lines;
}
function marksOf(state, line) {
  if (line.owners.length) return line.owners.map((owner) => ({ kind: "agent", name: state.slice(owner).agent }));
  const { last, count } = line.branch.people ?? {};
  if (!count) return [];
  return [{ kind: "person", name: count === 1 && last ? last : `${count} people` }];
}
const addMarks = (into, marks) => {
  for (const mark of marks) if (!into.has(`${mark.kind}\0${mark.name}`)) into.set(`${mark.kind}\0${mark.name}`, mark);
};
function changeIndex(lines, repository) {
  const index = /* @__PURE__ */ new Map();
  for (const line of lines) {
    if (line.repository !== repository) continue;
    const paths = line.branch.paths ?? [];
    const blobs = line.branch.blobs ?? [];
    paths.forEach((file, at) => {
      if (secretPath(file)) return;
      if (!index.has(file)) index.set(file, []);
      index.get(file).push({ line, fork: blobs[at]?.[0] ?? null, tip: blobs[at]?.[1] ?? null });
    });
  }
  return index;
}
function changeOf(changes) {
  if (!changes?.length) return null;
  const kind = changes.every((change) => change.fork === null) ? "new" : changes.every((change) => change.tip === null) ? "removed" : "changed";
  return { kind, versions: new Set(changes.map((change) => change.tip ?? "")).size + 1 };
}
async function componentsOf(contents, repository, shown) {
  const declared = await mapLimit(shown, PARALLEL, (branch) => contents.components(branch.commit));
  const byFolder = /* @__PURE__ */ new Map();
  const put = (folder, name, branch) => {
    if (!byFolder.has(folder)) byFolder.set(folder, /* @__PURE__ */ new Map());
    const names = byFolder.get(folder);
    if (!names.has(name)) names.set(name, []);
    if (!names.get(name).includes(branch)) names.get(name).push(branch);
  };
  shown.forEach((branch, at) => {
    const declaration = declared[at];
    if (!declaration) return;
    if (!declaration.declared.length) put("", repository, branch.name);
    for (const component of declaration.declared) put(component.folder.replace(/^\/+|\/+$/g, ""), component.name, branch.name);
  });
  const answer = /* @__PURE__ */ new Map();
  for (const [folder, names] of byFolder) {
    answer.set(folder, [...names].sort(([left], [right]) => byCodePoint(left, right)).map(([name, branches]) => ({ name, branches: branches.length, declaredOn: branches.length === shown.length ? [] : [...branches].sort(byCodePoint) })));
  }
  return answer;
}
function shownBranches(state, lines, repository) {
  const model = state.models.get(repository);
  const main = model?.branches.find((branch) => branch.default);
  return [...main ? [{ name: main.name, commit: main.commit }] : [], ...lines.filter((line) => line.repository === repository).map((line) => ({ name: line.name, commit: line.branch.commit }))];
}
function readSlot(route, scope, shown, ...what) {
  return JSON.stringify([route, scope, shown.quietDays, shown.showQuiet, ...what]);
}
function answerKey(state, lines) {
  const tipOf = (repository, name) => name ? branchOf(state, repository, name)?.commit ?? null : null;
  const defaults = [...state.models].map(([repository, model]) => {
    const main = model.branches.find((branch) => branch.default);
    return [repository, main?.name ?? null, main?.commit ?? null];
  });
  return {
    defaults,
    lines: lines.map((line) => [
      line.repository,
      line.name,
      line.branch.commit,
      line.branch.base ?? null,
      line.branch.fork ?? null,
      tipOf(line.repository, line.branch.base),
      line.branch.people ?? null,
      line.owners.map((owner) => [owner.initiative, owner.slice, state.slice(owner)])
    ])
  };
}
async function listFiles(state, lines, folder, contentsOf) {
  if (folder === null) {
    const entries2 = await Promise.all(state.answer.repositories.map(async (repository2) => {
      const contents2 = state.models.has(repository2.name) ? await contentsOf(repository2.name) : null;
      try {
        const components2 = contents2 ? (await componentsOf(contents2, repository2.name, shownBranches(state, lines, repository2.name))).get("") ?? [] : [];
        return { path: repository2.name, type: "repository", state: repository2.state, message: repository2.message ?? null, components: components2, error: null };
      } catch (error) {
        if (!(error instanceof ReadFailed)) throw error;
        return { path: repository2.name, type: "repository", state: repository2.state, message: repository2.message ?? null, components: [], error: { code: error.code, message: error.message } };
      }
    }));
    return { entries: entries2 };
  }
  const slash = folder.indexOf("/");
  const repository = slash < 0 ? folder : folder.slice(0, slash);
  const below = slash < 0 ? "" : folder.slice(slash + 1);
  const listed = state.answer.repositories.find((each) => each.name === repository);
  if (!listed) return { error: { status: 404, code: "repository_unknown", message: "The workspace has no repository of that name." } };
  if (state.answer.preparing.includes(repository)) return { preparing: true };
  const model = state.models.get(repository);
  const contents = model ? await contentsOf(repository) : null;
  const main = model?.branches.find((branch) => branch.default);
  if (!model || !contents || !main) return { error: { status: 404, code: "code_off", message: `The code content of ${repository} is off or not fetched yet, so this machine keeps no clone of it.` } };
  const prefix = below ? `${below}/` : "";
  const index = changeIndex(lines, repository);
  const children = /* @__PURE__ */ new Map();
  for (const entry of await contents.entries(main.commit, below)) {
    if (entry.type === "file" && secretPath(`${prefix}${entry.name}`)) continue;
    children.set(entry.name, entry.type);
  }
  const under = /* @__PURE__ */ new Map();
  for (const [file, changes] of index) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const cut = rest.indexOf("/");
    const child = cut < 0 ? rest : rest.slice(0, cut);
    const type = cut < 0 ? "file" : "folder";
    if (!children.has(child) && changes.some((change) => change.tip !== null)) children.set(child, type);
    if (children.get(child) !== type) continue;
    if (!under.has(child)) under.set(child, []);
    under.get(child).push(file);
  }
  const components = await componentsOf(contents, repository, shownBranches(state, lines, repository));
  const entries = [...children].sort(([leftName, leftType], [rightName, rightType]) => leftType === rightType ? byCodePoint(leftName, rightName) : leftType === "folder" ? -1 : 1).map(([name, type]) => {
    const file = `${prefix}${name}`;
    const marks = /* @__PURE__ */ new Map();
    if (type === "file") {
      const changes = index.get(file);
      for (const change2 of changes ?? []) addMarks(marks, marksOf(state, change2.line));
      const change = changeOf(changes);
      return { path: `${repository}/${file}`, type, change, people: [...marks.values()], touched: change !== null, components: [] };
    }
    const files = under.get(name) ?? [];
    for (const changed of files) for (const change of index.get(changed)) addMarks(marks, marksOf(state, change.line));
    return { path: `${repository}/${file}`, type, change: null, people: [...marks.values()], touched: files.length > 0, components: components.get(file) ?? [] };
  });
  return { entries };
}
const textLines = (text) => text === "" ? [] : text.replace(/\n$/, "").split("\n");
function summaryOf(hunks) {
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
const CONFLICT_RANGES = 64;
const CONFLICT_NAMED = 16;
const CONFLICT_SIDE_RANGES = 8;
const CONFLICT_CHECKS = 256;
const RANGE_COMPARISONS = 4e6;
const COMPARISONS_PER_TURN = 1e4;
function cappedRanges(ranges, most = CONFLICT_RANGES) {
  if (ranges.length <= 2 * most) return ranges;
  const capped = ranges.slice(0, 2 * most);
  capped[2 * most - 1] = ranges[ranges.length - 1];
  return capped;
}
function sideRanges(own, other) {
  const met = [];
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
const turn = () => new Promise((resolve) => setImmediate(resolve));
const PAIR_SHIFT = 2 ** 26;
function pairList() {
  let items = new Float64Array(1024);
  let length = 0;
  return {
    push(first, second) {
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
async function sweepRanges(members, budget, into, unfinished) {
  const starts = [];
  for (const { version, ranges } of members) for (let at = 0; at < ranges.length; at += 2) starts.push([ranges[at], ranges[at + 1], version]);
  starts.sort((left, right) => left[0] - right[0] || left[2] - right[2]);
  const open = /* @__PURE__ */ new Map();
  const heap = [];
  const push = (item) => {
    heap.push(item);
    for (let at = heap.length - 1; at > 0; ) {
      const parent = at - 1 >> 1;
      if (heap[parent][0] <= heap[at][0]) break;
      [heap[parent], heap[at]] = [heap[at], heap[parent]];
      at = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let at = 0; ; ) {
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
  const stop = (from) => {
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
async function fileVersions(state, lines, repository, file, contents) {
  const unavailable = { error: { status: 404, code: "file_unavailable", message: "The clone holds no such file to show: the path is no file of the default branch or of a shown version, or it is a secret." } };
  if (secretPath(file)) return unavailable;
  const model = state.models.get(repository);
  const main = model.branches.find((branch) => branch.default);
  const changes = changeIndex(lines, repository).get(file) ?? [];
  const tipOf = (name) => branchNamed(model.branches, name)?.commit ?? null;
  const byBlob = /* @__PURE__ */ new Map();
  for (const change of changes) {
    const key = change.tip ?? "";
    if (!byBlob.has(key)) byBlob.set(key, []);
    byBlob.get(key).push(change);
  }
  const baseNames = [];
  for (const change of changes) if (change.line.branch.base && !baseNames.includes(change.line.branch.base)) baseNames.push(change.line.branch.base);
  if (!baseNames.length && main) baseNames.push(main.name);
  const bases = await Promise.all(baseNames.map(async (branch) => ({ branch, blob: await contents.blobOf(tipOf(branch), file) })));
  if (!changes.length && bases.every((base) => base.blob === null)) return unavailable;
  const shown = !binaryPath(file);
  const linesOf = async (blob) => {
    if (blob === null) return 0;
    const looked = await contents.shownOf(blob);
    return typeof looked?.lines === "number" ? looked.lines : null;
  };
  const summaries = /* @__PURE__ */ new Map();
  const pairKey = (fork, tip) => `${fork ?? ""}\0${tip ?? ""}`;
  const pending = /* @__PURE__ */ new Map();
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
    const owners = /* @__PURE__ */ new Map();
    const people = /* @__PURE__ */ new Map();
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
  const fileComponents = [...components.get("") ?? [], ...folders.flatMap((folder) => components.get(folder) ?? [])];
  return { repository, path: file, components: fileComponents, bases, versions, conflicts };
}
async function withVerified(answer, verifiedFiles) {
  if (answer?.error) return answer;
  const versions = await Promise.all(answer.versions.map(async (version) => {
    let verified = false;
    for (const owner of version.owners) if ((await verifiedFiles(owner)).has(`${answer.path}\0${version.blob ?? ""}`)) verified = true;
    return { ...version, verified };
  }));
  return { ...answer, versions };
}
async function conflictsOf(contents, versions, held, summary, comparisons = RANGE_COMPARISONS) {
  const groups = [];
  const groupIndex = /* @__PURE__ */ new Map();
  const groupsOf = versions.map(() => []);
  held.forEach((changed, version) => {
    for (const { line, fork, tip } of changed) {
      const base = line.branch.base;
      const ranges = summary(fork, tip)?.ranges;
      if (base === null || base === void 0 || !ranges) continue;
      const key = `${base}\0${fork ?? ""}`;
      if (!groupIndex.has(key)) {
        groupIndex.set(key, groups.length);
        groups.push({ fork, members: /* @__PURE__ */ new Map() });
      }
      const index = groupIndex.get(key);
      const group = groups[index];
      if (!group.members.has(version)) {
        group.members.set(version, cappedRanges(ranges));
        groupsOf[version].push(index);
      }
    }
  });
  const budget = { left: comparisons, sinceTurn: 0 };
  const found = pairList();
  const unfinished = /* @__PURE__ */ new Set();
  for (const group of groups) {
    if (group.members.size < 2) continue;
    const members = [...group.members].map(([version, ranges]) => ({ version, ranges }));
    if (budget.left <= 0) {
      for (const { version } of members) unfinished.add(version);
      continue;
    }
    await sweepRanges(members, budget, found.push, unfinished);
  }
  const pairs = found.distinct();
  const degree = new Int32Array(versions.length + 1);
  for (const pair of pairs) {
    degree[Math.floor(pair / PAIR_SHIFT) + 1] += 1;
    degree[pair % PAIR_SHIFT + 1] += 1;
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
  const meetingGroups = (first, second) => groupsOf[first].filter((index) => groupsOf[second].includes(index) && sideRanges(groups[index].members.get(first), groups[index].members.get(second)).length > 0);
  const known = /* @__PURE__ */ new Map();
  let checks = 0;
  async function resolve(asked) {
    const pending = asked.filter(([first, second]) => !known.has(first * PAIR_SHIFT + second)).map(([first, second]) => ({ first, second, groups: meetingGroups(first, second), next: 0, counted: false }));
    while (pending.length) {
      const round = [];
      for (const pair of [...pending]) {
        const key = pair.first * PAIR_SHIFT + pair.second;
        if (pair.next >= pair.groups.length) {
          known.set(key, null);
          pending.splice(pending.indexOf(pair), 1);
        } else if (!pair.counted && checks >= CONFLICT_CHECKS) {
          known.set(key, pair.groups[pair.next]);
          pending.splice(pending.indexOf(pair), 1);
        } else {
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
  const pairOf = (version, other) => Math.min(version, other) * PAIR_SHIFT + Math.max(version, other);
  for (let version = 0; version < versions.length; version += 1) {
    const own = partners.subarray(degree[version], degree[version + 1]);
    let conflicting = 0;
    let at = 0;
    while (at < own.length && conflicting < CONFLICT_NAMED) {
      const asked = Array.from(own.subarray(at, at + CONFLICT_NAMED - conflicting), (other) => [Math.min(version, other), Math.max(version, other)]);
      await resolve(asked);
      at += asked.length;
      for (const [first, second] of asked) if (known.get(first * PAIR_SHIFT + second) != null) conflicting += 1;
    }
  }
  const entries = [];
  for (let version = 0; version < versions.length; version += 1) {
    const own = partners.subarray(degree[version], degree[version + 1]);
    const named = [];
    let more = 0;
    for (const other of own) {
      const group = known.get(pairOf(version, other));
      if (group === null) continue;
      if (named.length >= CONFLICT_NAMED || group === void 0) {
        more += 1;
        continue;
      }
      const ranges = groups[group].members;
      named.push({ version: versions[other].id, lines: { own: sideRanges(ranges.get(version), ranges.get(other)), other: sideRanges(ranges.get(other), ranges.get(version)) } });
    }
    const complete = !unfinished.has(version);
    if (named.length || more || !complete) entries.push({ version: versions[version].id, with: named, more, complete });
  }
  return entries;
}
async function fileDiff(state, repository, file, name, contents) {
  const unavailable = { error: { status: 404, code: "file_unavailable", message: "Neither the branch's fork nor its tip holds that file, or it is a secret." } };
  if (secretPath(file)) return unavailable;
  const branch = branchOf(state, repository, name);
  if (!branch) return { error: { status: 404, code: "branch_unknown", message: "The clone of that repository holds no such branch." } };
  const fork = branch.default ? null : branch.fork;
  const [before, after] = await Promise.all([branch.default ? null : contents.blobOf(fork, file), contents.blobOf(branch.commit, file)]);
  const from = branch.default ? after : before;
  if (from === null && after === null) return unavailable;
  const answer = { repository, path: file, branch: name, base: branch.default ? null : branch.base, fork };
  const notShown = (reason) => ({ error: { status: 404, code: "file_not_shown", reason, message: `${file} is not available here because ${reason === "binary" ? "it is a binary file" : "it is over 512 KiB"}, which the review app does not show.` } });
  if (binaryPath(file)) return notShown("binary");
  const reads = await Promise.all([from, after].map((blob) => blob === null ? Promise.resolve({ text: "", lines: 0 }) : contents.read(blob)));
  for (const read of reads) if (read?.withheld) return notShown(read.withheld);
  if (reads.some((read) => !read || typeof read.text !== "string")) return unavailable;
  const [beforeLines, afterLines] = reads.map((read) => textLines(read.text));
  const rows = [];
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
    const same = (until) => {
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
export {
  COMPARISONS_PER_TURN,
  CONFLICT_CHECKS,
  CONFLICT_NAMED,
  CONFLICT_RANGES,
  CONFLICT_SIDE_RANGES,
  RANGE_COMPARISONS,
  answerKey,
  cappedRanges,
  conflictsOf,
  fileDiff,
  fileVersions,
  listFiles,
  readSlot,
  scopeLines,
  sideRanges,
  stopping,
  summaryOf,
  sweepRanges,
  withVerified
};
