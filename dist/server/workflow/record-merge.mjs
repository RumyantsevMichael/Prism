// Generated from src/server/workflow/record-merge.mts by scripts/native-build/compile.mjs.
import { JSON_DEPTH_MAX, nestedDeeperThan, parseStoreJson } from "./store-json.mjs";
const MERGES = [
  { matches: (relative) => relative === "roadmap.json", load: async () => (await import("./roadmap.mjs")).mergeRoadmapRecord },
  { matches: (relative) => /^initiatives\/[A-Za-z0-9_-]+\/initiative\.json$/.test(relative), load: async () => (await import("./initiative.mjs")).mergeInitiativeRecord },
  { matches: (relative) => /^initiatives\/[A-Za-z0-9_-]+\/state\.json$/.test(relative), load: async () => (await import("./state.mjs")).mergeCoordinationState },
  // A work item's shaping record merges entry by entry, so inputs, findings, and gaps that two machines add to one item all survive.
  { matches: (relative) => /^initiatives\/[A-Za-z0-9_-]+\/work-item\.json$/.test(relative), load: async () => (await import("./work-items.mjs")).mergeShapingRecord },
  // A status record merges by what its versions say, so a ship's acceptance on one machine and an approval asked on another leave the ADR's file and recorded status agreeing.
  { matches: (relative) => /^artifact-status\/.+\/status\.json$/.test(relative), load: async () => (await import("./artifact-status.mjs")).mergeStatusRecord }
];
const hasRecordMerge = (relative) => MERGES.some((entry) => entry.matches(relative));
async function recordMergeFor(relative) {
  const entry = MERGES.find((candidate) => candidate.matches(relative));
  return entry ? entry.load() : null;
}
function canonicalJson(value) {
  const parts = [];
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item instanceof Text) {
      parts.push(item.text);
      continue;
    }
    if (Array.isArray(item)) {
      parts.push("[");
      pending.push(new Text("]"));
      for (let index = item.length - 1; index >= 0; index -= 1) {
        pending.push(item[index]);
        if (index > 0) pending.push(new Text(","));
      }
    } else if (item && typeof item === "object") {
      parts.push("{");
      pending.push(new Text("}"));
      const keys = Object.keys(item).sort();
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        pending.push(item[keys[index]], new Text(`${index > 0 ? "," : ""}${JSON.stringify(keys[index])}:`));
      }
    } else parts.push(JSON.stringify(item ?? null));
  }
  return parts.join("");
}
class Text {
  constructor(text) {
    this.text = text;
  }
}
class MergeConflict extends Error {
}
const ABSENT = Symbol("absent");
function mergeUnit(label, base, local, upstream) {
  const [b, l, u] = [base, local, upstream].map((value) => value === ABSENT ? "\0absent" : canonicalJson(value));
  if (l === u || u === b) return local;
  if (l === b) return upstream;
  throw new MergeConflict(`${label} changed differently on both sides.`);
}
function mergeKeyed(label, base, local, upstream) {
  const keys = [.../* @__PURE__ */ new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(upstream)])];
  const merged = {};
  const value = (map, key) => Object.hasOwn(map, key) ? map[key] : ABSENT;
  for (const key of keys) {
    const result = mergeUnit(`${label} ${key}`, value(base, key), value(local, key), value(upstream, key));
    if (result !== ABSENT) merged[key] = result;
  }
  return merged;
}
function mergeScalars(base, local, upstream, structured) {
  const keys = [.../* @__PURE__ */ new Set([...Object.keys(upstream), ...Object.keys(local), ...Object.keys(base)])].filter((key) => !structured.includes(key));
  const merged = {};
  const value = (record, key) => Object.hasOwn(record, key) ? record[key] : ABSENT;
  for (const key of keys) {
    const result = mergeUnit(key, value(base, key), value(local, key), value(upstream, key));
    if (result !== ABSENT) merged[key] = result;
  }
  return merged;
}
function mergeHistory(base, local, upstream, limit) {
  const counts = (entries) => entries.reduce((map, entry) => map.set(canonicalJson(entry), (map.get(canonicalJson(entry)) ?? 0) + 1), /* @__PURE__ */ new Map());
  const take = (map, key) => {
    const left = map.get(key) ?? 0;
    if (left > 0) map.set(key, left - 1);
    return left > 0;
  };
  const inLocal = counts(local);
  const inUpstream = counts(upstream);
  const kept = [];
  for (const entry of base) {
    const key = canonicalJson(entry);
    const held = [take(inLocal, key), take(inUpstream, key)];
    if (held[0] && held[1]) kept.push(entry);
  }
  const added = (entries, left) => entries.filter((entry) => take(left, canonicalJson(entry)));
  const localAdded = added(local, inLocal);
  const shared = counts(localAdded);
  const upstreamAdded = added(upstream, inUpstream).filter((entry) => !take(shared, canonicalJson(entry)));
  const at = (entry) => typeof entry?.at === "string" ? entry.at : "";
  const appended = [...localAdded.map((entry) => [entry, 0]), ...upstreamAdded.map((entry) => [entry, 1])].sort((left, right) => at(left[0]) < at(right[0]) ? -1 : at(left[0]) > at(right[0]) ? 1 : left[1] - right[1]).map(([entry]) => entry);
  return [...kept, ...appended].slice(-limit);
}
function mergeOrder(label, base, local, upstream, survivors, { upstreamFirst = false } = {}) {
  const everywhere = base.filter((id) => local.includes(id) && upstream.includes(id));
  const relative = (list) => list.filter((id) => everywhere.includes(id)).join("\0");
  const [b, l, u] = [base, local, upstream].map(relative);
  if (l !== b && u !== b && l !== u) throw new MergeConflict(`${label} was reordered differently on both sides.`);
  const order = (l !== b ? local : upstream).filter((id) => everywhere.includes(id) && survivors.has(id));
  for (const side of upstreamFirst ? [local, upstream] : [upstream, local]) {
    for (const [index, id] of side.entries()) {
      if (order.includes(id) || !survivors.has(id)) continue;
      const before = side.slice(0, index).reverse().find((candidate) => order.includes(candidate));
      order.splice(before === void 0 ? 0 : order.indexOf(before) + 1, 0, id);
    }
  }
  return order;
}
function parseVersions({ base, local, upstream }, empty) {
  let versions;
  try {
    versions = { base: base === null ? empty() : parseStoreJson(base), local: parseStoreJson(local), upstream: parseStoreJson(upstream) };
  } catch (error) {
    throw new MergeConflict(`A version of the record is not valid JSON: ${error.message}`);
  }
  return versions;
}
export {
  JSON_DEPTH_MAX,
  MergeConflict,
  canonicalJson,
  hasRecordMerge,
  mergeHistory,
  mergeKeyed,
  mergeOrder,
  mergeScalars,
  mergeUnit,
  nestedDeeperThan,
  parseVersions,
  recordMergeFor
};
