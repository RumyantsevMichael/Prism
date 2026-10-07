import test from "node:test";
import assert from "node:assert/strict";
import { extractTextConcepts } from "../../dist/native-runtime/concepts.mjs";
import { assignContainers, planFragments, fragmentConcept } from "../../dist/native-runtime/fragments.mjs";

const count = text => text.length;
const plan = (units, files, limit = 512, isStructured = () => true) => planFragments(units, new Map(files.map(file => [file.file, file])), { countTokens: count, limit, isCandidate: () => true, isStructured });
const code = (file, content, symbols) => {
  const units = [{ id: `${file}#file`, file, kind: "file", name: file, range: { startLine: 1, endLine: content.split("\n").length }, span: { start: 0, end: content.length } }];
  for (const [kind, name, text] of symbols) {
    const start = content.indexOf(text), lines = content.slice(0, start).split("\n").length;
    units.push({ id: `${file}#${name}`, file, kind, name, range: { startLine: lines, endLine: lines + text.split("\n").length - 1 }, span: { start, end: start + text.length } });
  }
  return units;
};

const store = `export class Store {
  put(record) {
    return write(record);
  }
  link(id) {
    return pointer(id);
  }
}
`;

test("containers come from the smallest containing concept in the same file", () => {
  const file = { file: "src/store.mjs", content: store, hash: "h" };
  const units = code(file.file, store, [["class", "Store", store.slice(7, -1)], ["method", "put", "put(record) {\n    return write(record);\n  }"], ["method", "link", "link(id) {\n    return pointer(id);\n  }"]]);
  // The worker links every symbol to its file. Span containment still finds the class.
  assignContainers(units, units.slice(1).map(unit => ({ source: units[0].id, target: unit.id, kind: "contains" })), new Map([[file.file, file]]));
  assert.equal(units[1].containerId, units[0].id);
  assert.equal(units[2].containerId, units[1].id);
  assert.equal(units[3].containerId, units[1].id);
  const markdown = { file: "guide.md", content: "# Guide\n\n## Search\n\nUse the index.\n", hash: "h" };
  const group = extractTextConcepts(markdown);
  assignContainers(group.units, group.edges, new Map([[markdown.file, markdown]]));
  const [root, guide, search, paragraph] = group.units;
  assert.deepEqual([guide.containerId, search.containerId, paragraph.containerId], [root.id, guide.id, search.id]);
});

test("a container is one outline, and its members name their nearest container", () => {
  const file = { file: "src/store.mjs", content: store, hash: "h" };
  const units = code(file.file, store, [["class", "Store", store.slice(7, -1)], ["method", "put", "put(record) {\n    return write(record);\n  }"], ["method", "link", "link(id) {\n    return pointer(id);\n  }"]]);
  assignContainers(units, [], new Map([[file.file, file]]));
  const fragments = plan(units, [file]);
  const byConcept = id => fragments.filter(fragment => fragment.parentId === id);
  const [outline] = byConcept(units[1].id);
  assert.equal(outline.role, "outline");
  assert.equal(outline.embeddingText, "class: Store\nclass Store {\n  put(record) {\n  link(id) {\n");
  assert.equal(outline.excerpt, file.content.slice(units[1].span.start, units[1].span.end));
  const [put] = byConcept(units[2].id);
  assert.equal(put.role, "whole");
  assert.equal(put.embeddingText, "method: Store.put\nput(record) {\n    return write(record);\n  }");
  assert.equal(put.context, "Store store");
  // No source fragment repeats the source of a smaller concept.
  const sources = fragments.filter(fragment => fragment.role !== "outline");
  for (const fragment of sources) for (const other of sources) if (other !== fragment)
    assert.ok(other.sourceEnd <= fragment.sourceStart || other.sourceStart >= fragment.sourceEnd, `${fragment.id} overlaps ${other.id}`);
});

test("a file without complete structure keeps its full text", () => {
  const file = { file: "src/store.mjs", content: store, hash: "h" };
  const units = code(file.file, store, [["class", "Store", store.slice(7, -1)]]);
  assignContainers(units, [], new Map([[file.file, file]]));
  const fragments = plan(units, [file], 512, () => false);
  assert.equal(fragments.find(fragment => fragment.parentId === units[0].id).role, "whole");
});

test("tiny data leaves appear only in their parent outline, unless the outline omits them", () => {
  const content = JSON.stringify({ server: { port: 8080, host: "localhost" } }, null, 2);
  const file = { file: "config.json", content, hash: "h" };
  const group = extractTextConcepts(file);
  assignContainers(group.units, group.edges, new Map([[file.file, file]]));
  const fragments = plan(group.units, [file]);
  // The file has one child, so the child outline represents the file.
  assert.deepEqual(fragments.map(fragment => fragment.name), ["server"]);
  assert.match(fragments.find(fragment => fragment.name === "server").embeddingText, /"port": 8080/);
  const wide = { file: "wide.json", content: JSON.stringify(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])), null, 2), hash: "h" };
  const keys = extractTextConcepts(wide);
  assignContainers(keys.units, keys.edges, new Map([[wide.file, wide]]));
  const limited = plan(keys.units, [wide], 120);
  const outline = limited.find(fragment => fragment.kind === "file");
  assert.match(outline.embeddingText, /… and \d+ more/);
  const shown = (outline.embeddingText.match(/"k\d+"/g) || []).length;
  assert.equal(limited.filter(fragment => fragment.kind === "configuration-key").length, 40 - shown);
});

test("long code splits at statement boundaries into parts of similar size, with an outline", () => {
  const statements = Array.from({ length: 24 }, (_, i) => `  const value${i} = compute(${i});\n  if (value${i}) record(value${i});\n\n`).join("");
  const content = `function long(input) {\n${statements}  return input;\n}\n`;
  const file = { file: "src/long.mjs", content, hash: "h" };
  const [root, long] = code(file.file, content, [["function", "long", content.trimEnd()]]);
  assignContainers([root, long], [], new Map([[file.file, file]]));
  const fragments = plan([root, long], [file], 300).filter(fragment => fragment.parentId === long.id);
  const parts = fragments.filter(fragment => fragment.role === "part"), [outline] = fragments.filter(fragment => fragment.role === "outline");
  assert.ok(parts.length >= 3);
  assert.equal(parts.map(part => content.slice(part.sourceStart, part.sourceEnd)).join(""), content.trimEnd());
  for (const part of parts) assert.ok(part.text.length <= 300);
  for (const part of parts.slice(0, -1)) assert.equal(content.slice(part.sourceEnd - 2, part.sourceEnd), "\n\n");
  const sizes = parts.map(part => part.sourceEnd - part.sourceStart);
  // Boundaries are coarse, so sizes vary, but no part is a small remainder.
  assert.ok(Math.min(...sizes) > Math.max(...sizes) / 2.5, JSON.stringify(sizes));
  assert.match(parts[1].text, /^function: long \(part 2 of \d+\)\nfunction long\(input\) \{\n  const value/);
  assert.match(outline.text, /^function: long\nfunction long\(input\) \{\n  const value0 = compute\(0\);\n  if \(value0\)/);
  assert.ok(fragments.every(fragment => fragment.tokens === content.trimEnd().length && fragment.parts === parts.length));
});

test("a part line longer than the budget still splits at tokenizer boundaries", () => {
  const content = "x ".repeat(400);
  const file = { file: "notes.md", content, hash: "h" };
  const concept = { id: "p", file: file.file, kind: "paragraph", name: "p", range: { startLine: 1, endLine: 1 }, span: { start: 0, end: content.length } };
  const parts = fragmentConcept(concept, file, count, 128);
  assert.equal(parts.map(part => content.slice(part.sourceStart, part.sourceEnd)).join(""), content);
  assert.ok(parts.every(part => part.text.length <= 128));
});
