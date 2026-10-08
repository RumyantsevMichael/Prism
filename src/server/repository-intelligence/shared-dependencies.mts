import type { IndexMetadata, SourceRange, SourceUnit } from "./repository-unit-types.mjs";

export interface SharedDependencyOptions { include?: (unit: SourceUnit) => boolean; limit?: number }
export interface SharedDependencyMember { file: string; selector: string; kind: string; range: SourceRange; share: number }
export interface SharedDependencyGroup { dependencies: { name: string; users: number }[]; weight: number; members: SharedDependencyMember[] }

const CODE_KINDS = new Set(["function", "method"]);
const DEPENDENCY_KINDS = new Set(["calls", "instantiates", "references"]);
// Type annotations describe data shapes, not the work that a unit does.
const TARGET_KINDS = new Set(["function", "method", "class", "constant", "variable"]);
const MIN_SHARED = 3, MAX_MEMBERS = 50;

// Test files by layout and name in common languages: test directories, *.test.ts, test_x.py, x_test.go, FooTest.java, Foo.Tests/ projects, and x_unittest.cc.
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.(py|c|cc|cpp)$|_(test|unittest)\.(py|go|c|cc|cpp)$/i;
// Java, Kotlin, and C# name test classes in PascalCase, so the case must match: StoreTest.java is a test, and Contest.java is not.
const TEST_CLASS_FILE = /\wTests?\.(java|kt|cs)$|\.Tests?\//;
export const isTestFile = (file: string) => TEST_FILE.test(file) || TEST_CLASS_FILE.test(file);

// Rust keeps unit tests inside the source file, in a module marked #[cfg(test)], or in functions marked #[test].
function rustTestSpans(content: string) {
  const spans: { start: number; end: number }[] = [];
  for (const match of content.matchAll(/#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{|#\[(?:\w+::)*test\][^\n]*\n(?:\s*#\[[^\n]*\n)*\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+[^{]*\{/g)) {
    let depth = 0, index = match.index! + match[0].length - 1;
    for (; index < content.length; index++) { if (content[index] === "{") depth++; else if (content[index] === "}" && --depth === 0) break; }
    spans.push({ start: match.index!, end: index });
  }
  return spans;
}
// Units arrive grouped by file, so the spans of the last file answer most requests.
let lastSpans: { content: string; spans: { start: number; end: number }[] } | undefined;
// A unit is test code when its file is a test file, or when it sits inside Rust test code in a source file.
export function isTestUnit(unit: SourceUnit, content = "") {
  if (isTestFile(unit.file)) return true;
  if (!unit.file.endsWith(".rs") || !unit.span || !content.includes("test")) return false;
  if (lastSpans?.content !== content) lastSpans = { content, spans: rustTestSpans(content) };
  return lastSpans.spans.some(span => span.start <= unit.span!.start && unit.span!.end <= span.end + 1);
}

// Core collection, string, conversion, and error operations appear in almost any work, so they never show a shared responsibility.
// Each list applies only to unresolved library calls in its language. A project function with the same name still counts.
const words = (text: string) => new Set(text.split(/\s+/).filter(Boolean));
const CORE_OPERATIONS: Record<string, Set<string>> = {
  javascript: words(`Array Boolean Map Number Object Set String Symbol WeakMap WeakSet at concat entries every fill filter find findIndex findLast flat flatMap forEach from
    fromEntries get has includes indexOf isArray join keys localeCompare map max min padEnd padStart pop push reduce repeat replace replaceAll reverse set shift slice
    some sort splice split startsWith endsWith toLowerCase toUpperCase toString trim trimEnd trimStart unshift values add delete clear`),
  python: words(`any all append bool dict enumerate extend float int isinstance items len list lower print range reversed round setdefault sorted str strip sum tuple upper zip
    get keys values join split replace startswith endswith format pop update`),
  go: words(`len cap append make new copy delete panic recover print println close Error String Errorf Sprintf Printf Println Sprint Fprintf New Is As Unwrap
    Contains HasPrefix HasSuffix TrimSpace Split Join Itoa Atoi`),
  rust: words(`Some None Ok Err Box Vec String Option Result clone cloned copied to_string to_owned into from try_from try_into as_ref as_mut as_str as_bytes as_slice as_deref
    as_ptr borrow borrow_mut unwrap unwrap_or unwrap_or_else unwrap_or_default expect expect_err ok ok_or ok_or_else err map map_err and_then or_else is_some is_none
    is_some_and is_ok is_err iter iter_mut into_iter collect filter filter_map find any all len is_empty push push_str pop insert remove get get_mut contains extend
    extend_from_slice to_vec join split trim chars bytes format write writeln with_capacity default new drop lock first last next rev enumerate zip sum min max`),
  jvm: words(`equals hashCode toString getClass valueOf of get set add put remove size isEmpty contains containsKey stream map filter collect forEach toList asList
    length charAt substring append build builder orElse orElseThrow isPresent format trim split join println printf requireNonNull`),
  csharp: words(`ToString Equals GetHashCode GetType Add Remove Contains ContainsKey TryGetValue Count Any All Select Where ToList ToArray ToDictionary First
    FirstOrDefault Single SingleOrDefault OrderBy OrderByDescending Format Concat Join Split Trim ConfigureAwait Dispose WriteLine nameof`),
  native: words(`size empty begin end cbegin cend push_back emplace_back pop_back insert erase find at c_str data move forward make_unique make_shared reset get
    printf fprintf snprintf malloc calloc realloc free memcpy memset strlen strcmp assert`)
};
const LANGUAGE_BY_EXTENSION: Record<string, string> = { js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "javascript", tsx: "javascript", mts: "javascript", cts: "javascript",
  py: "python", go: "go", rs: "rust", java: "jvm", kt: "jvm", scala: "jvm", cs: "csharp", c: "native", h: "native", cc: "native", cpp: "native", cxx: "native", hpp: "native", hh: "native" };
const coreOperations = (file: string) => CORE_OPERATIONS[LANGUAGE_BY_EXTENSION[file.split(".").pop()!.toLowerCase()]];

// A member call such as fs.lstat or self._persist depends on the operation, not on the receiver name.
// A path constructor such as Registry::new keeps its type, because "new" alone names no operation.
const CONSTRUCTORS = new Set(["new", "default", "with_capacity", "from"]);
const operation = (name: string) => {
  const clean = name.replace(/\(\)/g, ""), parts = clean.split(/::|[.#:]/).filter(Boolean), last = parts.pop() || name;
  const type = clean.match(/(\w+)::\w+$/)?.[1];
  return CONSTRUCTORS.has(last) && type && /^[A-Z]/.test(type) ? `${type}::${last}` : last;
};

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
  for (const reference of index.unresolvedReferences || []) {
    const name = operation(reference.name), core = coreOperations(byId.get(reference.source)?.file || "");
    if (!core?.has(name)) add(reference.source, name);
  }
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
