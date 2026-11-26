// Generated from src/server/review/code-branches.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
const BRANCHES = "refs/heads/";
const PARALLEL = 8;
const CANDIDATES = 32;
const TURN = 500;
const NAME_KEPT = 20;
const ANSWERS = 8;
const pointOrder = (unit) => unit >= 57344 ? unit - 2048 : unit >= 55296 ? unit + 8192 : unit;
function byCodePoint(left, right) {
  const shorter = Math.min(left.length, right.length);
  for (let at = 0; at < shorter; at += 1) {
    const a = left.charCodeAt(at);
    const b = right.charCodeAt(at);
    if (a !== b) return pointOrder(a) - pointOrder(b);
  }
  return left.length - right.length;
}
const byText = byCodePoint;
const pause = () => new Promise((resolve) => setImmediate(resolve));
class Superseded extends Error {
}
const stopUnless = (live) => {
  if (!live()) throw new Superseded("a newer read superseded this one");
};
async function mapLimit(items, limit, action, live = () => true) {
  const results = new Array(items.length);
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
const count = async (git, args) => {
  const counted = await git(["rev-list", "--count", ...args]);
  return counted.ok ? Number(counted.text) : 0;
};
const lines = (text) => text.split("\n").filter(Boolean);
async function eachLine(git, args, take, { maxRecord, input } = {}) {
  let going = true;
  const listed = await git(args, { line: (line) => going = going && (!line || take(line)), ...maxRecord ? { maxRecord } : {}, ...input !== void 0 ? { input } : {} });
  if (!listed.streamed && listed.ok) {
    for (const line of lines(listed.text)) if (!take(line)) break;
  }
  return listed.ok;
}
const tipsKeyOf = (headRef, branches) => [headRef, ...branches.map((branch) => `${branch.name}\0${branch.commit}`)].join("\n");
async function changedPaths(git, from, to) {
  if (from === to) return /* @__PURE__ */ new Set();
  const listed = await git(["diff-tree", "-r", "-z", "--no-renames", "--name-only", from, to]);
  return new Set(listed.ok ? listed.stdout.toString("utf8").split("\0").filter(Boolean) : []);
}
async function changedBlobs(git, from, to) {
  const changed = /* @__PURE__ */ new Map();
  if (from === to) return changed;
  const listed = await git(["diff-tree", "-r", "-z", "--no-renames", "--raw", "--no-abbrev", from, to]);
  const fields = listed.ok ? listed.stdout.toString("utf8").split("\0") : [];
  const object = (value) => /^0+$/.test(value) ? null : value;
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, , before, after] = fields[index].split(" ");
    if (before === void 0 || after === void 0 || !fields[index + 1]) continue;
    changed.set(fields[index + 1], [object(before), object(after)]);
  }
  return changed;
}
const WALK_LINE = 64 * 1024 * 1024;
const WALK_TIPS = 8192;
async function walkTips(git, negative, tips, tipIndex, live, { own, merges, nearest }) {
  for (let from = 0; from < tips.length; from += WALK_TIPS) {
    stopUnless(live);
    const batch = tips.slice(from, from + WALK_TIPS);
    const words = Math.ceil(batch.length / 32);
    const pending = /* @__PURE__ */ new Map();
    const release = (reach) => {
      if (!reach || --reach.holders > 0 || !(reach.commits || reach.merges)) return;
      for (let word = 0; word < words; word += 1) {
        for (let bits = reach.bits[word]; bits; bits &= bits - 1) {
          const row = from + word * 32 + 31 - Math.clz32(bits & -bits);
          own[row] += reach.commits;
          if (merges) merges[row] += reach.merges;
        }
      }
    };
    const hold = (reach) => {
      reach.holders += 1;
      return reach;
    };
    const ownSet = (reach) => {
      if (reach && reach.holders === 1 && !reach.commits && !reach.merges) return reach;
      const made = { bits: reach ? reach.bits.slice() : new Uint32Array(words), commits: 0, merges: 0, holders: 1 };
      release(reach);
      return made;
    };
    let read = 0;
    let stopped = false;
    let long = false;
    const listed = await eachLine(git, ["rev-list", "--topo-order", "--parents", "--stdin"], (line) => {
      if (++read % 4096 === 0 && !live()) {
        stopped = true;
        return false;
      }
      if (line.startsWith("\0")) {
        long = true;
        return false;
      }
      const [commit, ...parents] = line.split(" ");
      const found = pending.get(commit) ?? { reach: null, seekers: null };
      pending.delete(commit);
      let { reach } = found;
      let seekers = found.seekers;
      const row = tipIndex.get(commit);
      if (row !== void 0 && nearest) {
        for (const seeker of seekers ?? []) nearest[seeker] = row;
        seekers = row >= from && row < from + batch.length ? [row] : null;
      }
      if (row !== void 0 && row >= from && row < from + batch.length) {
        reach = ownSet(reach);
        reach.bits[row - from >>> 5] |= 1 << (row - from & 31);
      }
      if (!reach) reach = hold({ bits: new Uint32Array(words), commits: 0, merges: 0, holders: 0 });
      reach.commits += 1;
      if (parents.length > 1) reach.merges += 1;
      parents.forEach((parent, index) => {
        const next = pending.get(parent) ?? { reach: null, seekers: null };
        if (!next.reach) next.reach = hold(reach);
        else if (next.reach !== reach) {
          const joined = ownSet(next.reach);
          for (let word = 0; word < words; word += 1) joined.bits[word] |= reach.bits[word];
          next.reach = joined;
        }
        if (index === 0 && seekers?.length) {
          if (!next.seekers) next.seekers = seekers;
          else {
            const [longer, shorter] = next.seekers.length >= seekers.length ? [next.seekers, seekers] : [seekers, next.seekers];
            for (const seeker of shorter) longer.push(seeker);
            next.seekers = longer;
          }
        }
        pending.set(parent, next);
      });
      release(reach);
      return true;
    }, { maxRecord: WALK_LINE, input: `${batch.join("\n")}
^${negative}
` });
    if (stopped) throw new Superseded("a newer read superseded this one");
    if (long) throw new Error("Git listed a commit with more parents than a branch read keeps");
    if (!listed) throw new Error("Git could not list the commits that a branch read counts");
    for (const { reach } of pending.values()) release(reach);
  }
}
async function ownColumn(git, commit, tips, tipIndex, live) {
  const column = new Uint32Array(tips.length);
  await walkTips(git, commit, tips, tipIndex, live, { own: column });
  return column;
}
async function readBranchFacts(git, live = () => true) {
  const head = await git(["symbolic-ref", "--quiet", "HEAD"]);
  if (!head.ok) throw new Error("Git could not read the clone's HEAD.");
  const headRef = head.text.trim();
  const listed = await git(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)", BRANCHES]);
  if (!listed.ok) throw new Error("Git could not list the clone's branches.");
  const read = lines(listed.text).map((line) => {
    const [ref, commit, date] = line.split("\0");
    return { name: ref.slice(BRANCHES.length), commit, committedAt: new Date(Number(date) * 1e3).toISOString(), tip: 0 };
  }).sort((left, right) => byText(left.name, right.name));
  const key = tipsKeyOf(headRef, read);
  if (!headRef.startsWith(BRANCHES)) return null;
  const defaultBranch = headRef.slice(BRANCHES.length);
  const main = read.find((branch) => branch.name === defaultBranch);
  if (!main) return null;
  const tips = [];
  const tipIndex = /* @__PURE__ */ new Map();
  for (const branch of read) {
    if (!tipIndex.has(branch.commit)) {
      tipIndex.set(branch.commit, tips.length);
      tips.push(branch.commit);
    }
    branch.tip = tipIndex.get(branch.commit);
  }
  const size = tips.length;
  const mainTip = main.tip;
  const ownOfMain = new Uint32Array(size);
  const merges = new Uint32Array(size);
  const nearest = new Int32Array(size).fill(-1);
  const ownOfNearest = new Uint32Array(size);
  await walkTips(git, main.commit, tips, tipIndex, live, { own: ownOfMain, merges, nearest });
  await mapLimit(tips, PARALLEL, async (tip, row) => {
    if (nearest[row] >= 0) ownOfNearest[row] = await count(git, [tip, `^${tips[nearest[row]]}`]);
  }, live);
  return { key, defaultBranch, branches: read, tips, mainTip, ownOfMain, merges, nearest, ownOfNearest, columns: /* @__PURE__ */ new Map(), pairs: /* @__PURE__ */ new Map() };
}
async function mergeRuns(left, right, compare) {
  const merged = [];
  let l = 0;
  let r = 0;
  while (l < left.length || r < right.length) {
    merged.push(r >= right.length || l < left.length && compare(left[l], right[r]) <= 0 ? left[l++] : right[r++]);
    if (merged.length % TURN === 0) await pause();
  }
  return merged;
}
async function sortInTurns(items, compare) {
  let runs = [];
  for (let at = 0; at < items.length; at += TURN) {
    runs.push(items.slice(at, at + TURN).sort(compare));
    await pause();
  }
  while (runs.length > 1) {
    const next = [];
    for (let at = 0; at < runs.length; at += 2) next.push(at + 1 < runs.length ? await mergeRuns(runs[at], runs[at + 1], compare) : runs[at]);
    runs = next;
  }
  return runs[0] ?? [];
}
async function rankBranches(facts, owned) {
  const main = facts.branches.find((branch) => branch.name === facts.defaultBranch);
  const others = facts.branches.filter((branch) => branch !== main);
  const ranked = await sortInTurns(others, (left, right) => Number(owned.has(left.name)) - Number(owned.has(right.name)) || facts.merges[right.tip] - facts.merges[left.tip] || facts.ownOfMain[right.tip] - facts.ownOfMain[left.tip] || byText(left.name, right.name));
  const byTip = /* @__PURE__ */ new Map();
  for (const branch of ranked) {
    if (!byTip.has(branch.tip)) byTip.set(branch.tip, []);
    byTip.get(branch.tip).push(branch);
  }
  const order = [];
  const placed = /* @__PURE__ */ new Set();
  const placedAt = /* @__PURE__ */ new Map();
  const settled = (tip) => (placedAt.get(tip) ?? 0) >= (byTip.get(tip)?.length ?? 0);
  let steps = 0;
  const step = async () => {
    if (++steps % TURN === 0) await pause();
  };
  const put = async (branch) => {
    placed.add(branch);
    placedAt.set(branch.tip, (placedAt.get(branch.tip) ?? 0) + 1);
    order.push(branch);
    await step();
  };
  for (let index = 0; index < ranked.length; index += 1) {
    await step();
    const branch = ranked[index];
    if (placed.has(branch)) continue;
    const chain = [];
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
async function readBranches(git, facts, owned, { live = () => true, derived = /* @__PURE__ */ new Map() } = {}) {
  const size = facts.tips.length;
  const main = facts.branches.find((branch) => branch.name === facts.defaultBranch);
  const order = await rankBranches(facts, owned);
  const position = new Map(order.map((branch, index) => [branch, index]));
  const firstAtTip = /* @__PURE__ */ new Map();
  for (const branch of order) if (!firstAtTip.has(branch.tip)) firstAtTip.set(branch.tip, branch);
  const first = order.slice(0, CANDIDATES);
  const columnTips = new Set(first.map((branch) => branch.tip).filter((tip) => tip !== facts.mainTip));
  const recent = [];
  const candidates = [];
  for (let index = 0; index < order.length; index += 1) {
    if (index % TURN === TURN - 1) await pause();
    const branch = order[index];
    const found = /* @__PURE__ */ new Map();
    const add = (other) => {
      if (!other || position.get(other) >= index) return;
      const kept = found.get(other.tip);
      if (!kept || position.get(other) < position.get(kept)) found.set(other.tip, other);
    };
    for (const other of first) add(other);
    add(firstAtTip.get(facts.nearest[branch.tip]));
    if (owned.has(branch.name)) {
      for (const other of recent) add(other);
      recent.push(branch);
      if (recent.length > CANDIDATES) recent.shift();
    }
    candidates.push([...found.values()].sort((left, right) => position.get(left) - position.get(right)));
  }
  const ownPair = (branch, other) => other.tip === branch.tip || other.tip === facts.mainTip || columnTips.has(other.tip) || facts.nearest[branch.tip] === other.tip ? null : branch.tip * size + other.tip;
  const known = (branch, other) => {
    if (other.tip === branch.tip) return 0;
    if (other.tip === facts.mainTip) return facts.ownOfMain[branch.tip];
    const column = facts.columns.get(other.tip);
    if (column) return column[branch.tip];
    if (facts.nearest[branch.tip] === other.tip) return facts.ownOfNearest[branch.tip];
    return facts.pairs.get(branch.tip * size + other.tip);
  };
  for (const tip of facts.columns.keys()) if (!columnTips.has(tip)) facts.columns.delete(tip);
  const tipIndex = new Map(facts.tips.map((tip, index) => [tip, index]));
  for (const tip of columnTips) {
    if (facts.columns.has(tip)) continue;
    stopUnless(live);
    facts.columns.set(tip, await ownColumn(git, facts.tips[tip], facts.tips, tipIndex, live));
  }
  const wanted = /* @__PURE__ */ new Set();
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
  const bases = /* @__PURE__ */ new Map();
  for (let index = 0; index < order.length; index += 1) {
    if (index % TURN === TURN - 1) await pause();
    const branch = order[index];
    let chosen = null;
    let fewest = Infinity;
    for (const other of [main, ...candidates[index]]) {
      const owns = known(branch, other);
      if (owns < fewest) {
        fewest = owns;
        chosen = other;
      }
    }
    bases.set(branch.name, chosen);
  }
  const used = /* @__PURE__ */ new Set();
  const described = await mapLimit(facts.branches, PARALLEL, async (branch, index) => {
    if (index % TURN === TURN - 1) await pause();
    if (branch === main) return { name: branch.name, commit: branch.commit, default: true, base: null, fork: null, files: 0, paths: [], blobs: [], committedAt: branch.committedAt, people: { last: null, count: 0 } };
    const base = bases.get(branch.name);
    const key = `${branch.commit}\0${base?.commit ?? ""}`;
    used.add(key);
    if (!derived.has(key)) derived.set(key, await derive(git, branch.commit, base?.commit ?? null));
    const { fork, files, paths, blobs, people } = derived.get(key);
    return { name: branch.name, commit: branch.commit, default: false, base: fork === null ? null : base.name, fork, files, paths, blobs, committedAt: branch.committedAt, people };
  }, live);
  for (const key of derived.keys()) if (!used.has(key)) derived.delete(key);
  return { defaultBranch: facts.defaultBranch, branches: described };
}
async function derive(git, tip, baseTip) {
  let fork = null;
  let files = null;
  let paths = null;
  let blobs = null;
  if (baseTip) {
    const found = await git(["merge-base", tip, baseTip]);
    fork = found.ok && found.text ? lines(found.text)[0] : null;
  }
  if (fork) {
    const sinceFork = await changedBlobs(git, fork, tip);
    const fromBase = sinceFork.size ? await changedPaths(git, baseTip, tip) : /* @__PURE__ */ new Set();
    paths = [...sinceFork.keys()].filter((file) => fromBase.has(file)).sort(byText);
    files = paths.length;
    blobs = paths.map((file) => sinceFork.get(file));
  }
  const since = [tip, ...fork ? [`^${fork}`] : []];
  let last = null;
  const names = /* @__PURE__ */ new Set();
  await eachLine(git, ["log", "--format=%an", ...since], (name) => {
    last ??= name;
    names.add(name.length <= NAME_KEPT ? name : `\0${createHash("sha1").update(name).digest().toString("base64", 0, 12)}`);
    return true;
  });
  if (last?.startsWith("\0")) {
    const newest = await git(["log", "-1", "--format=%an", ...since]);
    last = newest.ok ? newest.text : null;
  }
  return { fork, files, paths, blobs, people: { last, count: names.size } };
}
function createBranchReader(git) {
  let facts = null;
  let factsKey = null;
  const answers = /* @__PURE__ */ new Map();
  const queued = /* @__PURE__ */ new Map();
  let latest = null;
  let running = null;
  let derived = /* @__PURE__ */ new Map();
  const keep = (key, model) => {
    answers.delete(key);
    answers.set(key, model);
    while (answers.size > ANSWERS) answers.delete(answers.keys().next().value);
  };
  async function readOne(job) {
    const live = () => latest === job.tipsKey;
    if (factsKey !== job.tipsKey) {
      facts = null;
      factsKey = null;
      derived = /* @__PURE__ */ new Map();
      answers.clear();
      const read = await readBranchFacts(git, live);
      factsKey = read?.key ?? job.tipsKey;
      facts = read;
    }
    if (facts === null) {
      keep(job.key, { defaultBranch: null, branches: [] });
      return;
    }
    const model = await readBranches(git, facts, job.owned, { live, derived });
    keep(`${factsKey}\0\0${[...job.owned].sort(byText).join("\0")}`, model);
  }
  function start() {
    let run = null;
    run = (async () => {
      await null;
      try {
        while (queued.size) {
          const job = queued.values().next().value;
          queued.delete(job.key);
          if (answers.has(job.key)) continue;
          try {
            await readOne(job);
          } catch {
          }
        }
      } finally {
        if (running === run) running = null;
      }
    })();
    running = run;
  }
  const keyOf = (tipsKey, names) => `${tipsKey}\0\0${[...names].sort(byText).join("\0")}`;
  return {
    /** The model for these tips and owners when it is read, and otherwise undefined, without queuing a read, for tips that a running fetch may still move. */
    ready(tipsKey, owned) {
      const key = keyOf(tipsKey, new Set(owned));
      if (!answers.has(key)) return void 0;
      const model = answers.get(key);
      keep(key, model);
      return model;
    },
    answer(tipsKey, owned) {
      const names = new Set(owned);
      const key = keyOf(tipsKey, names);
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
      while (queued.size > ANSWERS) queued.delete(queued.keys().next().value);
      if (!running) start();
      return void 0;
    },
    /** Whether a read is running, so a caller can hold back a fetch that would supersede it. */
    get reading() {
      return running !== null;
    },
    /** Settles once no read runs, for tests and for a caller that waits on the answer. */
    async idle() {
      while (running) await running;
    }
  };
}
export {
  Superseded,
  byCodePoint,
  createBranchReader,
  rankBranches,
  readBranchFacts,
  readBranches,
  tipsKeyOf
};
