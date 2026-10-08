// Generated from src/server/repository-intelligence/shared-dependencies.mts by scripts/native-build/compile.mjs.
const CODE_KINDS = /* @__PURE__ */ new Set(["function", "method"]);
const DEPENDENCY_KINDS = /* @__PURE__ */ new Set(["calls", "instantiates", "references"]);
const TARGET_KINDS = /* @__PURE__ */ new Set(["function", "method", "class", "constant", "variable"]);
const MIN_SHARED = 3, MAX_MEMBERS = 50;
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i;
const isTestFile = (file) => TEST_FILE.test(file);
const CORE_OPERATIONS = /* @__PURE__ */ new Set([
  // JavaScript and TypeScript
  "Array",
  "Boolean",
  "Map",
  "Number",
  "Object",
  "Set",
  "String",
  "Symbol",
  "WeakMap",
  "WeakSet",
  "at",
  "concat",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "flat",
  "flatMap",
  "forEach",
  "from",
  "fromEntries",
  "get",
  "has",
  "includes",
  "indexOf",
  "isArray",
  "join",
  "keys",
  "localeCompare",
  "map",
  "max",
  "min",
  "padEnd",
  "padStart",
  "pop",
  "push",
  "reduce",
  "repeat",
  "replace",
  "replaceAll",
  "reverse",
  "set",
  "shift",
  "slice",
  "some",
  "sort",
  "splice",
  "split",
  "startsWith",
  "endsWith",
  "toLowerCase",
  "toUpperCase",
  "toString",
  "trim",
  "trimEnd",
  "trimStart",
  "unshift",
  "values",
  "add",
  "delete",
  "clear",
  // Python
  "any",
  "all",
  "append",
  "bool",
  "dict",
  "enumerate",
  "extend",
  "float",
  "int",
  "isinstance",
  "items",
  "len",
  "list",
  "lower",
  "print",
  "range",
  "reversed",
  "round",
  "setdefault",
  "sorted",
  "str",
  "strip",
  "sum",
  "tuple",
  "upper",
  "zip"
]);
const operation = (name) => name.split(/::|[.#:]/).filter(Boolean).pop() || name;
function dependencyProfiles(index, include = () => true) {
  const byId = new Map(index.units.map((unit) => [unit.id, unit]));
  const profiles = /* @__PURE__ */ new Map();
  const add = (source, name) => {
    const unit = byId.get(source);
    if (!unit || !CODE_KINDS.has(unit.kind) || !include(unit) || name === unit.name) return;
    (profiles.get(source) || profiles.set(source, /* @__PURE__ */ new Set()).get(source)).add(name);
  };
  for (const edge of index.edges) if (DEPENDENCY_KINDS.has(edge.kind) && edge.source !== edge.target && TARGET_KINDS.has(byId.get(edge.target)?.kind || "")) add(edge.source, operation(byId.get(edge.target).name));
  for (const reference of index.unresolvedReferences || []) if (!CORE_OPERATIONS.has(operation(reference.name))) add(reference.source, operation(reference.name));
  return profiles;
}
function sharedDependencyGroups(index, options = {}) {
  const byId = new Map(index.units.map((unit) => [unit.id, unit]));
  const profiles = dependencyProfiles(index, options.include);
  const total = index.units.filter((unit) => CODE_KINDS.has(unit.kind) && (options.include || (() => true))(unit)).length;
  const users = /* @__PURE__ */ new Map();
  for (const [id, names] of profiles) for (const name of names) (users.get(name) || users.set(name, []).get(name)).push(id);
  const count = profiles.size, common = Math.min(200, Math.max(10, Math.ceil(count * 0.1)));
  const weight = (name) => Math.log(count / users.get(name).length);
  const rare = (name) => users.get(name).length >= 2 && users.get(name).length <= common;
  const pairs = /* @__PURE__ */ new Map();
  for (const [name, ids] of users) if (rare(name)) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (byId.get(ids[i]).file === byId.get(ids[j]).file) continue;
    const key = ids[i] < ids[j] ? `${ids[i]}\0${ids[j]}` : `${ids[j]}\0${ids[i]}`;
    (pairs.get(key) || pairs.set(key, []).get(key)).push(name);
  }
  const byMembers = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  for (const names of pairs.values()) {
    if (names.length < MIN_SHARED) continue;
    names.sort();
    const key = names.join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    const [first, ...rest] = [...names].sort((a, b) => users.get(a).length - users.get(b).length);
    const members = users.get(first).filter((id) => rest.every((name) => profiles.get(id).has(name))).sort();
    if (new Set(members.map((id) => byId.get(id).file)).size < 2) continue;
    const group = { names, members, weight: names.reduce((sum, name) => sum + weight(name), 0) };
    const memberKey = members.join("\0"), previous = byMembers.get(memberKey);
    if (!previous || group.weight > previous.weight) byMembers.set(memberKey, group);
  }
  const ranked = [...byMembers.values()].sort((a, b) => b.weight * Math.log2(b.members.length) - a.weight * Math.log2(a.members.length) || a.names.join().localeCompare(b.names.join()));
  const overlap = (a, b) => a.filter((item) => b.includes(item)).length / Math.min(a.length, b.length);
  const accepted = [];
  for (const group of ranked) {
    if (accepted.some((other) => overlap(group.members, other.members) >= 2 / 3 && overlap(group.names, other.names) >= 0.5)) continue;
    accepted.push(group);
    if (accepted.length >= (options.limit || 20)) break;
  }
  const profileWeight = (id) => [...profiles.get(id)].reduce((sum, name) => sum + (users.get(name).length >= 2 ? weight(name) : Math.log(count)), 0);
  const groups = accepted.map((group) => ({
    dependencies: [...group.names].sort((a, b) => weight(b) - weight(a)).map((name) => ({ name, users: users.get(name).length })),
    weight: Number(group.weight.toFixed(2)),
    members: group.members.slice(0, MAX_MEMBERS).map((id) => {
      const unit = byId.get(id);
      return { file: unit.file, selector: unit.selector || unit.qualifiedName || unit.name, kind: unit.kind, range: unit.range, share: Number((group.weight / profileWeight(id)).toFixed(2)) };
    })
  }));
  return { groups, coverage: { units: total, profiledUnits: count, unresolvedNames: Boolean(index.unresolvedReferences) } };
}
export {
  dependencyProfiles,
  isTestFile,
  sharedDependencyGroups
};
