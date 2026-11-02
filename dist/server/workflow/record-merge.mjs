// Store sync merges a record that changed on both sides by its structure when the record's kind registers a merge here.
// Each entry names the module that owns the kind and is imported only when a merge needs it, so this module imports no record module
// and the record store, its sync, and the record modules form no import cycle.
const MERGES = [
  { matches: (relative) => relative === "roadmap.json", load: async () => (await import("./roadmap.mjs")).mergeRoadmapRecord },
  { matches: (relative) => /^initiatives\/[A-Za-z0-9_-]+\/initiative\.json$/.test(relative), load: async () => (await import("./initiative.mjs")).mergeInitiativeRecord }
];

/** Whether a store-relative record path has a structural merge. */
export const hasRecordMerge = (relative) => MERGES.some((entry) => entry.matches(relative));

/**
 * The structural merge of a store-relative record path, or null when its kind has none.
 * The merge takes { path, base, local, upstream } as UTF-8 text, base null when the file is new, and returns { contents } or { conflict }.
 */
export async function recordMergeFor(relative) {
  const entry = MERGES.find((candidate) => candidate.matches(relative));
  return entry ? entry.load() : null;
}

/** JSON with object keys sorted, so two values compare equal exactly when they hold the same content. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

export class MergeConflict extends Error {}

const ABSENT = Symbol("absent");

/** The three-way rule for one unit: unchanged on one side takes the other side; changed the same way on both takes it; otherwise a conflict. ABSENT means removed. */
export function mergeUnit(label, base, local, upstream) {
  const [b, l, u] = [base, local, upstream].map((value) => value === ABSENT ? "\0absent" : canonicalJson(value));
  if (l === u || u === b) return local;
  if (l === b) return upstream;
  throw new MergeConflict(`${label} changed differently on both sides.`);
}

/** Merge maps of units keyed by id; the result holds each surviving key with its merged value. */
export function mergeKeyed(label, base, local, upstream) {
  const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(upstream)])];
  const merged = {};
  const value = (map, key) => Object.hasOwn(map, key) ? map[key] : ABSENT;
  for (const key of keys) {
    const result = mergeUnit(`${label} ${key}`, value(base, key), value(local, key), value(upstream, key));
    if (result !== ABSENT) merged[key] = result;
  }
  return merged;
}

/** Merge the top-level scalars of a record other than the named structured parts, in the upstream's key order. */
export function mergeScalars(base, local, upstream, structured) {
  const keys = [...new Set([...Object.keys(upstream), ...Object.keys(local), ...Object.keys(base)])].filter((key) => !structured.includes(key));
  const merged = {};
  const value = (record, key) => Object.hasOwn(record, key) ? record[key] : ABSENT;
  for (const key of keys) {
    const result = mergeUnit(key, value(base, key), value(local, key), value(upstream, key));
    if (result !== ABSENT) merged[key] = result;
  }
  return merged;
}

/**
 * Keep every base entry that both sides still hold, in base order, then every entry only one side added, by `at` with local first on a tie,
 * and keep the last `limit` entries as the writers do.
 */
export function mergeHistory(base, local, upstream, limit) {
  const counts = (entries) => entries.reduce((map, entry) => map.set(canonicalJson(entry), (map.get(canonicalJson(entry)) ?? 0) + 1), new Map());
  const take = (map, key) => { const left = map.get(key) ?? 0; if (left > 0) map.set(key, left - 1); return left > 0; };
  const inLocal = counts(local);
  const inUpstream = counts(upstream);
  const kept = [];
  for (const entry of base) {
    const key = canonicalJson(entry);
    const held = [take(inLocal, key), take(inUpstream, key)];
    if (held[0] && held[1]) kept.push(entry);
  }
  // What remains in each count is what that side added; an entry both sides added the same way is kept once.
  const added = (entries, left) => entries.filter((entry) => take(left, canonicalJson(entry)));
  const localAdded = added(local, inLocal);
  const shared = counts(localAdded);
  const upstreamAdded = added(upstream, inUpstream).filter((entry) => !take(shared, canonicalJson(entry)));
  const at = (entry) => typeof entry?.at === "string" ? entry.at : "";
  const appended = [...localAdded.map((entry) => [entry, 0]), ...upstreamAdded.map((entry) => [entry, 1])]
    .sort((left, right) => at(left[0]) < at(right[0]) ? -1 : at(left[0]) > at(right[0]) ? 1 : left[1] - right[1])
    .map(([entry]) => entry);
  return [...kept, ...appended].slice(-limit);
}

/**
 * Merge the order of ids: the relative order of ids on all three sides comes from the side that changed it,
 * and an id that one side added goes right after its nearest preceding id in that side's list, or first.
 */
export function mergeOrder(label, base, local, upstream, survivors) {
  const everywhere = base.filter((id) => local.includes(id) && upstream.includes(id));
  const relative = (list) => list.filter((id) => everywhere.includes(id)).join("\0");
  const [b, l, u] = [base, local, upstream].map(relative);
  if (l !== b && u !== b && l !== u) throw new MergeConflict(`${label} was reordered differently on both sides.`);
  const order = (l !== b ? local : upstream).filter((id) => everywhere.includes(id) && survivors.has(id));
  // Upstream additions are placed first, so a local addition after the same id lands before them.
  for (const side of [upstream, local]) {
    for (const [index, id] of side.entries()) {
      if (order.includes(id) || !survivors.has(id)) continue;
      const before = side.slice(0, index).reverse().find((candidate) => order.includes(candidate));
      order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
    }
  }
  return order;
}

/** Parse the three versions of a record, or throw a conflict; a file new on both sides merges against the kind's empty record. */
export function parseVersions({ base, local, upstream }, empty) {
  try {
    return { base: base === null ? empty() : JSON.parse(base), local: JSON.parse(local), upstream: JSON.parse(upstream) };
  } catch {
    throw new MergeConflict("A version of the record is not valid JSON.");
  }
}
