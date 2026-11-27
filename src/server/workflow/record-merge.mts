import { JSON_DEPTH_MAX, nestedDeeperThan, parseStoreJson } from "./store-json.mjs";

export { JSON_DEPTH_MAX, nestedDeeperThan };

// Store sync merges a record that changed on both sides by its structure when the record's kind registers a merge here.
// Each entry names the module that owns the kind and is imported only when a merge needs it, so this module imports no record module
// and the record store, its sync, and the record modules form no import cycle.
const MERGES = [
  { matches: (relative: string) => relative === "roadmap.json", load: async () => (await import("./roadmap.mjs")).mergeRoadmapRecord },
  { matches: (relative: string) => /^initiatives\/[A-Za-z0-9_-]+\/initiative\.json$/.test(relative), load: async () => (await import("./initiative.mjs")).mergeInitiativeRecord },
  { matches: (relative: string) => /^initiatives\/[A-Za-z0-9_-]+\/state\.json$/.test(relative), load: async () => (await import("./state.mjs")).mergeCoordinationState },
  // A work item's shaping record merges entry by entry, so inputs, findings, and gaps that two machines add to one item all survive.
  { matches: (relative: string) => /^initiatives\/[A-Za-z0-9_-]+\/work-item\.json$/.test(relative), load: async () => (await import("./work-items.mjs")).mergeShapingRecord },
  // A status record merges by what its versions say, so a ship's acceptance on one machine and an approval asked on another leave the ADR's file and recorded status agreeing.
  { matches: (relative: string) => /^artifact-status\/.+\/status\.json$/.test(relative), load: async () => (await import("./artifact-status.mjs")).mergeStatusRecord }
];

/** Whether a store-relative record path has a structural merge. */
export const hasRecordMerge = (relative: string) => MERGES.some((entry) => entry.matches(relative));

/**
 * The structural merge of a store-relative record path, or null when its kind has none.
 * The merge takes { path, base, local, upstream } as UTF-8 text, base null when the file is new, and returns { contents } or { conflict }.
 */
export async function recordMergeFor(relative: string) {
  const entry = MERGES.find((candidate) => candidate.matches(relative));
  return entry ? entry.load() : null;
}

/**
 * JSON with object keys sorted, so two values compare equal exactly when they hold the same content.
 * It walks the value with a stack of its own rather than by recursion, so a value that a synced file nests however deep never exhausts the call stack.
 */
export function canonicalJson(value: unknown) {
  const parts: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item instanceof Text) { parts.push(item.text); continue; }
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
        pending.push((item as Record<string, unknown>)[keys[index]], new Text(`${index > 0 ? "," : ""}${JSON.stringify(keys[index])}:`));
      }
    } else parts.push(JSON.stringify(item ?? null));
  }
  return parts.join("");
}

// A piece of canonicalJson's output that its walk places between values.
class Text { declare text: string; constructor(text: string) { this.text = text; } }

export class MergeConflict extends Error {}

const ABSENT = Symbol("absent");

/** The three-way rule for one unit: unchanged on one side takes the other side; changed the same way on both takes it; otherwise a conflict. ABSENT means removed. */
export function mergeUnit(label: string, base: unknown, local: unknown, upstream: unknown) {
  const [b, l, u] = [base, local, upstream].map((value) => value === ABSENT ? "\0absent" : canonicalJson(value));
  if (l === u || u === b) return local;
  if (l === b) return upstream;
  throw new MergeConflict(`${label} changed differently on both sides.`);
}

/** Merge maps of units keyed by id; the result holds each surviving key with its merged value. */
export function mergeKeyed(label: string, base: any, local: any, upstream: any) {
  const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(upstream)])];
  const merged: Record<string, unknown> = {};
  const value = (map: any, key: string) => Object.hasOwn(map, key) ? map[key] : ABSENT;
  for (const key of keys) {
    const result = mergeUnit(`${label} ${key}`, value(base, key), value(local, key), value(upstream, key));
    if (result !== ABSENT) merged[key] = result;
  }
  return merged;
}

/** Merge the top-level scalars of a record other than the named structured parts, in the upstream's key order. */
export function mergeScalars(base: any, local: any, upstream: any, structured: string[]) {
  const keys = [...new Set([...Object.keys(upstream), ...Object.keys(local), ...Object.keys(base)])].filter((key) => !structured.includes(key));
  const merged: Record<string, unknown> = {};
  const value = (record: any, key: string) => Object.hasOwn(record, key) ? record[key] : ABSENT;
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
export function mergeHistory(base: any, local: any, upstream: any, limit: number) {
  const counts = (entries: unknown[]): Map<string, number> => entries.reduce((map: Map<string, number>, entry) => map.set(canonicalJson(entry), (map.get(canonicalJson(entry)) ?? 0) + 1), new Map<string, number>());
  const take = (map: any, key: string) => { const left = map.get(key) ?? 0; if (left > 0) map.set(key, left - 1); return left > 0; };
  const inLocal = counts(local);
  const inUpstream = counts(upstream);
  const kept: unknown[] = [];
  for (const entry of base) {
    const key = canonicalJson(entry);
    const held = [take(inLocal, key), take(inUpstream, key)];
    if (held[0] && held[1]) kept.push(entry);
  }
  // What remains in each count is what that side added; an entry both sides added the same way is kept once.
  const added = (entries: unknown[], left: Map<string, number>) => entries.filter((entry: any) => take(left, canonicalJson(entry)));
  const localAdded = added(local, inLocal);
  const shared = counts(localAdded);
  const upstreamAdded = added(upstream, inUpstream).filter((entry: any) => !take(shared, canonicalJson(entry)));
  const at = (entry: any) => typeof entry?.at === "string" ? entry.at : "";
  const appended = [...localAdded.map((entry: any): [any, number] => [entry, 0]), ...upstreamAdded.map((entry: any): [any, number] => [entry, 1])]
    .sort((left, right) => at(left[0]) < at(right[0]) ? -1 : at(left[0]) > at(right[0]) ? 1 : left[1] - right[1])
    .map(([entry]) => entry);
  return [...kept, ...appended].slice(-limit);
}

/**
 * Merge the order of ids: the relative order of ids on all three sides comes from the side that changed it,
 * and an id that one side added goes right after its nearest preceding id in that side's list, or first.
 * Where both sides added after the same id, the local addition comes first unless `upstreamFirst` is set.
 */
export function mergeOrder(label: string, base: string[], local: string[], upstream: string[], survivors: Set<string>, { upstreamFirst = false } = {}) {
  const everywhere = base.filter((id: string) => local.includes(id) && upstream.includes(id));
  const relative = (list: string[]) => list.filter((id: string) => everywhere.includes(id)).join("\0");
  const [b, l, u] = [base, local, upstream].map(relative);
  if (l !== b && u !== b && l !== u) throw new MergeConflict(`${label} was reordered differently on both sides.`);
  const order = (l !== b ? local : upstream).filter((id: string) => everywhere.includes(id) && survivors.has(id));
  // The side placed first ends up last after a shared predecessor, because the other side's addition is spliced in right after that predecessor.
  for (const side of upstreamFirst ? [local, upstream] : [upstream, local]) {
    for (const [index, id] of side.entries()) {
      if (order.includes(id) || !survivors.has(id)) continue;
      const before = side.slice(0, index).reverse().find((candidate: string) => order.includes(candidate));
      order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
    }
  }
  return order;
}

/** Parse the three versions of a record, or throw a conflict; a file new on both sides merges against the kind's empty record. */
export function parseVersions<T = any>({ base, local, upstream }: { base: string | null; local: string; upstream: string }, empty: () => T): { base: T; local: T; upstream: T } {
  let versions;
  try {
    versions = { base: base === null ? empty() : parseStoreJson(base), local: parseStoreJson(local), upstream: parseStoreJson(upstream) };
  } catch (error) {
    throw new MergeConflict(`A version of the record is not valid JSON: ${error.message}`);
  }
  return versions;
}
