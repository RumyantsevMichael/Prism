import test from "node:test";
import assert from "node:assert/strict";
import { sameNameGroups } from "../../dist/server/repository-intelligence/same-name-units.mjs";

// Each function becomes a unit that spans its source text, and calls inside it become unresolved references.
function project(files) {
  const contents = new Map(), units = [], unresolvedReferences = [];
  for (const [file, functions] of Object.entries(files)) {
    let text = "";
    for (const { name, body, kind = "function", calls = [] } of functions) {
      const start = text.length, line = text.split("\n").length;
      text += `${body}\n`;
      units.push({ id: `${file}#${name}#${start}`, file, kind, name, range: { startLine: line, endLine: line + body.split("\n").length - 1 }, span: { start, end: start + body.length } });
      for (const call of calls) unresolvedReferences.push({ source: `${file}#${name}#${start}`, name: call, kind: "calls" });
    }
    contents.set(file, text);
  }
  return { index: { units, edges: [], unresolvedReferences }, contents };
}

const strict = "function normalizedIdentifier(value, name) {\n  if (typeof value !== 'string') throw new Error(name);\n  const trimmed = value.trim();\n  if (Buffer.byteLength(trimmed) > MAX) throw new Error(name);\n  return trimmed;\n}";
const lenient = "export function normalizedIdentifier(value) {\n  if (typeof value !== 'string') return null;\n  const trimmed = value.trim();\n  return trimmed || null;\n}";
const isObject = "function isObject(value) {\n  return value !== null && typeof value === 'object';\n}";

test("identical copies and diverged variants of one name are grouped, and variants that differ in throwing come first", () => {
  const { index, contents } = project({
    "src/trace.mjs": [{ name: "normalizedIdentifier", body: strict, calls: ["byteLength", "Error"] }, { name: "isObject", body: isObject }],
    "src/facts.mjs": [{ name: "normalizedIdentifier", body: lenient }, { name: "isObject", body: `export ${isObject}` }],
    "src/state.mjs": [{ name: "isObject", body: isObject.replace("\n  return", "\n\n  return") }]
  });
  const { groups, coverage } = sameNameGroups(index, contents);
  assert.deepEqual(coverage, { functions: 5, names: 2 });
  assert.deepEqual(groups.map(group => [group.name, group.kind, group.files]), [["normalizedIdentifier", "diverged", 2], ["isObject", "identical", 3]]);
  const [strictVariant, lenientVariant] = [...groups[0].variants].sort((a, b) => b.throws - a.throws);
  assert.deepEqual([strictVariant.throws, lenientVariant.throws], [2, 0]);
  assert.deepEqual([strictVariant.onlyHere, lenientVariant.onlyHere], [["Error", "byteLength"], []]);
  // Whitespace and the export keyword do not make a separate variant.
  assert.equal(groups[1].variants.length, 1);
  assert.equal(groups[1].variants[0].members.length, 3);
});

test("homonyms, methods, short bodies, one-file names, and excluded units are not grouped", () => {
  const main = (work) => `function main() {\n  const options = parseArguments();\n  ${work}\n}`;
  const { index, contents } = project({
    "scripts/build.mjs": [{ name: "main", body: main("compileSources(options.target);") }, { name: "search", kind: "method", body: "search(query) {\n  return this.index.find(query);\n  // one\n}" }, { name: "tiny", body: "function tiny() { return 1; }" }, { name: "local", body: "function local() {\n  return 1;\n}" }],
    "scripts/release.mjs": [{ name: "main", body: "function main() {\n  publishPackages(readManifest(), uploadArchives());\n  notifyChannels();\n}" }, { name: "search", kind: "method", body: "search(query) {\n  return this.client.call(query);\n  // two\n}" }, { name: "tiny", body: "function tiny() { return 2; }" }]
  });
  assert.deepEqual(sameNameGroups(index, contents).groups, []);
  // Short wrappers that forward to different calls are not variants of one contract.
  const wrappers = project({ "src/lib.rs": [{ name: "restart_daemon", body: "fn restart_daemon() {\n    Daemon::new()\n}" }], "src/commands.rs": [{ name: "restart_daemon", body: "fn restart_daemon(state: State) {\n    state.restart()\n}" }] });
  assert.deepEqual(sameNameGroups(wrappers.index, wrappers.contents).groups, []);
  const copies = project({ "a.mjs": [{ name: "isObject", body: isObject }], "b.mjs": [{ name: "isObject", body: isObject }] });
  assert.deepEqual(sameNameGroups(copies.index, copies.contents, { include: unit => unit.file === "a.mjs" }).groups, []);
});
