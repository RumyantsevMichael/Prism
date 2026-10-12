// Generated from src/server/repository-intelligence/shared-dependencies.mts by scripts/native-build/compile.mjs.
const CODE_KINDS = /* @__PURE__ */ new Set(["function", "method"]);
const DEPENDENCY_KINDS = /* @__PURE__ */ new Set(["calls", "instantiates", "references"]);
const TARGET_KINDS = /* @__PURE__ */ new Set(["function", "method", "class", "constant", "variable"]);
const MIN_SHARED = 3, MAX_MEMBERS = 50;
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.(py|c|cc|cpp)$|_(test|unittest)\.(py|go|c|cc|cpp)$/i;
const TEST_CLASS_FILE = /\wTests?\.(java|kt|cs)$|\.Tests?\//;
const isTestFile = (file) => TEST_FILE.test(file) || TEST_CLASS_FILE.test(file);
function rustTestSpans(content) {
  const spans = [];
  for (const match of content.matchAll(/#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{|#\[(?:\w+::)*test\][^\n]*\n(?:\s*#\[[^\n]*\n)*\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+[^{]*\{/g)) {
    let depth = 0, index = match.index + match[0].length - 1;
    for (; index < content.length; index++) {
      if (content[index] === "{") depth++;
      else if (content[index] === "}" && --depth === 0) break;
    }
    spans.push({ start: match.index, end: index });
  }
  return spans;
}
let lastSpans;
function isTestUnit(unit, content = "") {
  if (isTestFile(unit.file)) return true;
  if (!unit.file.endsWith(".rs") || !unit.span || !content.includes("test")) return false;
  if (lastSpans?.content !== content) lastSpans = { content, spans: rustTestSpans(content) };
  return lastSpans.spans.some((span) => span.start <= unit.span.start && unit.span.end <= span.end + 1);
}
const words = (text) => new Set(text.split(/\s+/).filter(Boolean));
const CORE_OPERATIONS = {
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
const LANGUAGE_BY_EXTENSION = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "javascript",
  tsx: "javascript",
  mts: "javascript",
  cts: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "jvm",
  kt: "jvm",
  scala: "jvm",
  cs: "csharp",
  c: "native",
  h: "native",
  cc: "native",
  cpp: "native",
  cxx: "native",
  hpp: "native",
  hh: "native"
};
const coreOperations = (file) => CORE_OPERATIONS[LANGUAGE_BY_EXTENSION[file.split(".").pop().toLowerCase()]];
const CONSTRUCTORS = /* @__PURE__ */ new Set(["new", "default", "with_capacity", "from"]);
const operation = (name) => {
  const clean = name.replace(/\(\)/g, ""), parts = clean.split(/::|[.#:]/).filter(Boolean), last = parts.pop() || name;
  const type = clean.match(/(\w+)::\w+$/)?.[1];
  return CONSTRUCTORS.has(last) && type && /^[A-Z]/.test(type) ? `${type}::${last}` : last;
};
function dependencyProfiles(index, include = () => true) {
  const byId = new Map(index.units.map((unit) => [unit.id, unit]));
  const profiles = /* @__PURE__ */ new Map();
  const add = (source, name) => {
    const unit = byId.get(source);
    if (!unit || !CODE_KINDS.has(unit.kind) || !include(unit) || name === unit.name) return;
    (profiles.get(source) || profiles.set(source, /* @__PURE__ */ new Set()).get(source)).add(name);
  };
  for (const edge of index.edges) if (DEPENDENCY_KINDS.has(edge.kind) && edge.source !== edge.target && TARGET_KINDS.has(byId.get(edge.target)?.kind || "")) add(edge.source, operation(byId.get(edge.target).name));
  for (const reference of index.unresolvedReferences || []) {
    const name = operation(reference.name), core = coreOperations(byId.get(reference.source)?.file || "");
    if (!core?.has(name)) add(reference.source, name);
  }
  return profiles;
}
function sharedDependencyGroups(index, options = {}) {
  const profiles = dependencyProfiles(index, options.include);
  const total = index.units.filter((unit) => CODE_KINDS.has(unit.kind) && (options.include || (() => true))(unit)).length;
  const groups = sharedNameGroups(index.units, profiles, options.limit).map(({ names, weight, members }) => ({ dependencies: names, weight, members }));
  return { groups, coverage: { units: total, profiledUnits: profiles.size, unresolvedNames: Boolean(index.unresolvedReferences) } };
}
function sharedNameGroups(units, profiles, limit = 20) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
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
    if (accepted.length >= limit) break;
  }
  const profileWeight = (id) => [...profiles.get(id)].reduce((sum, name) => sum + (users.get(name).length >= 2 ? weight(name) : Math.log(count)), 0);
  return accepted.map((group) => ({
    names: [...group.names].sort((a, b) => weight(b) - weight(a)).map((name) => ({ name, users: users.get(name).length })),
    weight: Number(group.weight.toFixed(2)),
    members: group.members.slice(0, MAX_MEMBERS).map((id) => {
      const unit = byId.get(id);
      const total = profileWeight(id), share = total > 0 ? group.weight / total : group.names.length / profiles.get(id).size;
      return { file: unit.file, selector: unit.selector || unit.qualifiedName || unit.name, kind: unit.kind, range: unit.range, share: Number(share.toFixed(2)) };
    })
  }));
}
export {
  dependencyProfiles,
  isTestFile,
  isTestUnit,
  sharedDependencyGroups,
  sharedNameGroups
};
