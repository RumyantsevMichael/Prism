import type { IndexMetadata, SourceRange, SourceUnit } from "./repository-unit-types.mjs";

export interface SharedDependencyOptions { include?: (unit: SourceUnit) => boolean; limit?: number }
export interface SharedDependencyMember { file: string; selector: string; kind: string; range: SourceRange; share: number }
export interface SharedDependencyGroup { dependencies: { name: string; users: number }[]; weight: number; members: SharedDependencyMember[] }

const CODE_KINDS = new Set(["function", "method"]);
const DEPENDENCY_KINDS = new Set(["calls", "instantiates", "references"]);
// Type annotations describe data shapes, not the work that a unit does.
const TARGET_KINDS = new Set(["function", "method", "class", "constant", "variable"]);
const MIN_SHARED = 3, MAX_MEMBERS = 50;

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i;
export const isTestFile = (file: string) => TEST_FILE.test(file);

// Core collection, string, and conversion operations appear in almost any work, so they never show a shared responsibility.
// The list applies only to unresolved library calls. A project function with the same name still counts.
const CORE_OPERATIONS = new Set([
  // JavaScript and TypeScript
  "Array", "Boolean", "Map", "Number", "Object", "Set", "String", "Symbol", "WeakMap", "WeakSet", "at", "concat", "entries", "every", "fill", "filter", "find",
  "findIndex", "findLast", "flat", "flatMap", "forEach", "from", "fromEntries", "get", "has", "includes", "indexOf", "isArray", "join", "keys", "localeCompare",
  "map", "max", "min", "padEnd", "padStart", "pop", "push", "reduce", "repeat", "replace", "replaceAll", "reverse", "set", "shift", "slice", "some", "sort",
  "splice", "split", "startsWith", "endsWith", "toLowerCase", "toUpperCase", "toString", "trim", "trimEnd", "trimStart", "unshift", "values", "add", "delete", "clear",
  // Python
  "any", "all", "append", "bool", "dict", "enumerate", "extend", "float", "int", "isinstance", "items", "len", "list", "lower", "print", "range", "reversed",
  "round", "setdefault", "sorted", "str", "strip", "sum", "tuple", "upper", "zip"
]);

// A member call such as fs.lstat or self._persist depends on the operation, not on the receiver name.
const operation = (name: string) => name.split(/::|[.#:]/).filter(Boolean).pop() || name;

// The profile of a function or method is the set of operations it calls, instantiates, or references.
// Names, not unit IDs, connect copied helpers, because each copy is a different unit with the same name.
export function dependencyProfiles(index: Pick<IndexMetadata, "units" | "edges" | "unresolvedReferences">, include: (unit: SourceUnit) => boolean = () => true) {
  const byId = new Map(index.units.map(unit => [unit.id, unit]));
  const profiles = new Map<string, Set<string>>();
  const add = (source: string, name: string) => {
    const unit = byId.get(source);
    if (!unit || !CODE_KINDS.has(unit.kind) || !include(unit) || name === unit.name) return;
    (profiles.get(source) || profiles.set(source, new Set()).get(source)!).add(name);
  };
  for (const edge of index.edges) if (DEPENDENCY_KINDS.has(edge.kind) && edge.source !== edge.target && TARGET_KINDS.has(byId.get(edge.target)?.kind || "")) add(edge.source, operation(byId.get(edge.target)!.name));
  for (const reference of index.unresolvedReferences || []) if (!CORE_OPERATIONS.has(operation(reference.name))) add(reference.source, operation(reference.name));
  return profiles;
}

// Group units in different files that repeat the same rare set of operations, which often shows a repeated sub-step or a copied responsibility.
export function sharedDependencyGroups(index: Pick<IndexMetadata, "units" | "edges" | "unresolvedReferences">, options: SharedDependencyOptions = {}) {
  const byId = new Map(index.units.map(unit => [unit.id, unit]));
  const profiles = dependencyProfiles(index, options.include);
  const total = index.units.filter(unit => CODE_KINDS.has(unit.kind) && (options.include || (() => true))(unit)).length;
  const users = new Map<string, string[]>();
  for (const [id, names] of profiles) for (const name of names) (users.get(name) || users.set(name, []).get(name)!).push(id);
  // Operations that many units use, such as push or join, are not evidence of a shared responsibility.
  // The limit stays high, because a safety check that dozens of units repeat is itself a finding.
  const count = profiles.size, common = Math.min(200, Math.max(10, Math.ceil(count * 0.1)));
  const weight = (name: string) => Math.log(count / users.get(name)!.length);
  const rare = (name: string) => users.get(name)!.length >= 2 && users.get(name)!.length <= common;
  const pairs = new Map<string, string[]>();
  for (const [name, ids] of users) if (rare(name)) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (byId.get(ids[i])!.file === byId.get(ids[j])!.file) continue;
    const key = ids[i] < ids[j] ? `${ids[i]}\0${ids[j]}` : `${ids[j]}\0${ids[i]}`;
    (pairs.get(key) || pairs.set(key, []).get(key)!).push(name);
  }
  // Each shared set becomes one group with every unit whose profile contains the whole set.
  const byMembers = new Map<string, { names: string[]; members: string[]; weight: number }>();
  const seen = new Set<string>();
  for (const names of pairs.values()) {
    if (names.length < MIN_SHARED) continue;
    names.sort();
    const key = names.join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    const [first, ...rest] = [...names].sort((a, b) => users.get(a)!.length - users.get(b)!.length);
    const members = users.get(first)!.filter(id => rest.every(name => profiles.get(id)!.has(name))).sort();
    if (new Set(members.map(id => byId.get(id)!.file)).size < 2) continue;
    const group = { names, members, weight: names.reduce((sum, name) => sum + weight(name), 0) };
    // For the same members, keep the largest shared set.
    const memberKey = members.join("\0"), previous = byMembers.get(memberKey);
    if (!previous || group.weight > previous.weight) byMembers.set(memberKey, group);
  }
  const ranked = [...byMembers.values()].sort((a, b) => b.weight * Math.log2(b.members.length) - a.weight * Math.log2(a.members.length) || a.names.join().localeCompare(b.names.join()));
  // A group that mostly repeats the members and the operations of a better group shows the same pattern again.
  const overlap = (a: string[], b: string[]) => a.filter(item => b.includes(item)).length / Math.min(a.length, b.length);
  const accepted: typeof ranked = [];
  for (const group of ranked) {
    if (accepted.some(other => overlap(group.members, other.members) >= 2 / 3 && overlap(group.names, other.names) >= 0.5)) continue;
    accepted.push(group);
    if (accepted.length >= (options.limit || 20)) break;
  }
  const profileWeight = (id: string) => [...profiles.get(id)!].reduce((sum, name) => sum + (users.get(name)!.length >= 2 ? weight(name) : Math.log(count)), 0);
  const groups: SharedDependencyGroup[] = accepted.map(group => ({
    dependencies: [...group.names].sort((a, b) => weight(b) - weight(a)).map(name => ({ name, users: users.get(name)!.length })),
    weight: Number(group.weight.toFixed(2)),
    members: group.members.slice(0, MAX_MEMBERS).map(id => {
      const unit = byId.get(id)!;
      return { file: unit.file, selector: unit.selector || unit.qualifiedName || unit.name, kind: unit.kind, range: unit.range, share: Number((group.weight / profileWeight(id)).toFixed(2)) };
    })
  }));
  return { groups, coverage: { units: total, profiledUnits: count, unresolvedNames: Boolean(index.unresolvedReferences) } };
}
