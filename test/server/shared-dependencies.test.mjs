import test from "node:test";
import assert from "node:assert/strict";
import { dependencyProfiles, sharedDependencyGroups, isTestFile, isTestUnit } from "../../dist/server/repository-intelligence/shared-dependencies.mjs";

const unit = (file, name, kind = "function") => ({ id: `${file}#${name}`, file, kind, name, range: { startLine: 1, endLine: 2 }, rangeComplete: true });
const calls = (source, ...names) => names.map(name => ({ source: source.id, name, kind: "calls" }));

function repository() {
  const units = [
    unit("src/a.mjs", "checkDirectory"), unit("src/b.mjs", "inspectLock"), unit("src/c.mjs", "assertStore"), unit("src/c.mjs", "sameFileCopy"),
    unit("src/d.mjs", "sortNames"), unit("src/e.mjs", "joinNames"), unit("src/f.mjs", "isObject"), unit("src/g.mjs", "isObject"),
    unit("test/a.test.mjs", "fixtureDirectory"), unit("src/types.mts", "Shape", "interface"),
    ...Array.from({ length: 30 }, (_, i) => unit(`src/filler-${i}.mjs`, `filler${i}`))
  ];
  const [check, lock, store, copy, sortNames, joinNames, objectA, objectB, fixture, shape] = units;
  const unresolvedReferences = [
    ...calls(check, "fs.lstat", "stats.isSymbolicLink", "fs.realpath", "path.dirname"), ...calls(lock, "fs.lstat", "info.isSymbolicLink", "fs.realpath"),
    ...calls(store, "lstat", "isSymbolicLink", "realpath"), ...calls(copy, "lstat", "isSymbolicLink", "realpath"),
    ...calls(fixture, "lstat", "isSymbolicLink", "realpath"),
    // Core operations never form a group, even when they are rare in this repository.
    ...calls(sortNames, "names.filter", "names.sort", "names.join", "value.trim"), ...calls(joinNames, "items.filter", "items.sort", "items.join", "line.trim"),
    ...units.slice(10).flatMap(filler => calls(filler, "console.log"))
  ];
  const helper = unit("src/f.mjs", "readConfig"), other = unit("src/g.mjs", "readSettings");
  units.push(helper, other);
  const edges = [
    // Each module has its own isObject copy, so the callers share the name, not the target unit.
    { source: helper.id, target: objectA.id, kind: "calls" }, { source: other.id, target: objectB.id, kind: "calls" },
    { source: helper.id, target: shape.id, kind: "references" }, { source: other.id, target: shape.id, kind: "references" }
  ];
  unresolvedReferences.push(...calls(helper, "JSON.parse", "fs.readFileSync"), ...calls(other, "JSON.parse", "fs.readFileSync"));
  return { units, edges, unresolvedReferences };
}

test("profiles name operations without receivers, ignore type references, and skip core operations", () => {
  const index = repository();
  const profiles = dependencyProfiles(index);
  assert.deepEqual([...profiles.get("src/a.mjs#checkDirectory")].sort(), ["dirname", "isSymbolicLink", "lstat", "realpath"]);
  assert.deepEqual([...profiles.get("src/f.mjs#readConfig")].sort(), ["isObject", "parse", "readFileSync"]);
  assert.equal(profiles.has("src/d.mjs#sortNames"), false);
});

test("groups span files, keep every member that shares the set, and leave out tests by request", () => {
  const index = repository();
  const { groups, coverage } = sharedDependencyGroups(index, { include: unit => !isTestFile(unit.file) });
  const check = groups.find(group => group.dependencies.some(item => item.name === "lstat"));
  assert.deepEqual(check.dependencies.map(item => item.name).sort(), ["isSymbolicLink", "lstat", "realpath"]);
  assert.deepEqual(check.members.map(member => member.selector).sort(), ["assertStore", "checkDirectory", "inspectLock", "sameFileCopy"]);
  assert.equal(check.members.find(member => member.selector === "checkDirectory").share < 1, true);
  assert.equal(check.members.find(member => member.selector === "inspectLock").share, 1);
  const copies = groups.find(group => group.dependencies.some(item => item.name === "isObject"));
  assert.deepEqual(copies.members.map(member => member.selector).sort(), ["readConfig", "readSettings"]);
  assert.ok(groups.every(group => !group.dependencies.some(item => ["filter", "sort", "join", "trim", "Shape"].includes(item.name))));
  assert.ok(groups.every(group => group.members.every(member => !isTestFile(member.file))));
  assert.equal(coverage.unresolvedNames, true);
  const withTests = sharedDependencyGroups(index).groups.find(group => group.dependencies.some(item => item.name === "lstat"));
  assert.ok(withTests.members.some(member => member.selector === "fixtureDirectory"));
});

test("units in one file alone do not form a group, and a missing name list is disclosed", () => {
  const units = [unit("src/a.mjs", "first"), unit("src/a.mjs", "second"), ...Array.from({ length: 20 }, (_, i) => unit(`src/f${i}.mjs`, `f${i}`))];
  const unresolvedReferences = [...calls(units[0], "lstat", "realpath", "chmod"), ...calls(units[1], "lstat", "realpath", "chmod")];
  assert.deepEqual(sharedDependencyGroups({ units, edges: [], unresolvedReferences }).groups, []);
  assert.equal(sharedDependencyGroups({ units, edges: [] }).coverage.unresolvedNames, false);
});

test("test file detection covers common layouts", () => {
  for (const file of ["test/a.mjs", "src/tests/a.py", "src/a.test.ts", "src/a.spec.js", "pkg/test_a.py", "pkg/a_test.go", "src/__tests__/a.js",
    "src/test/java/StoreTest.java", "app/StoreTests.cs", "App.Tests/Store.cs", "lib/store_unittest.cc", "lib/test_store.c"]) assert.equal(isTestFile(file), true, file);
  for (const file of ["src/testing.mjs", "src/contest.py", "src/attest.ts", "src/Contest.java", "src/latest.cs"]) assert.equal(isTestFile(file), false, file);
});

test("Rust test modules and test functions inside a source file count as test code", () => {
  const content = "pub fn serve() { run(); }\n#[cfg(test)]\nmod tests {\n    fn helper() { setup(); }\n    #[test]\n    fn works() { helper(); }\n}\n#[tokio::test]\nasync fn async_case() { { nested(); } }\npub fn after() {}\n";
  const unit = name => { const start = content.indexOf(`fn ${name}`); return { id: name, file: "src/lib.rs", kind: "function", name, range: { startLine: 1, endLine: 1 }, span: { start, end: content.indexOf("}", start) + 1 } }; };
  assert.deepEqual(["serve", "helper", "works", "async_case", "after"].map(name => isTestUnit(unit(name), content)), [false, true, true, true, false]);
});

test("each language ignores its own core operations, and path constructors keep their type", () => {
  const units = [unit("src/a.rs", "first"), unit("src/b.rs", "second"), unit("src/c.ts", "third"), unit("src/d.ts", "fourth")];
  const unresolvedReferences = [
    // The graph reports a chained call as the whole chain and as its first call.
    ...calls(units[0], "x.unwrap", "fs::canonicalize().unwrap", "fs::canonicalize", "Registry::new", "Vec::new", "map_err"),
    ...calls(units[2], "Array.from", "items.map", "unwrap", "Buffer.from")
  ];
  const profiles = dependencyProfiles({ units, edges: [], unresolvedReferences });
  assert.deepEqual([...profiles.get("src/a.rs#first")].sort(), ["Registry::new", "Vec::new", "canonicalize"]);
  // A Rust core name is not a JavaScript core name, and a JavaScript member call never becomes a path constructor.
  assert.deepEqual([...profiles.get("src/c.ts#third")].sort(), ["unwrap"]);
});
