import test from "node:test";
import assert from "node:assert/strict";
import { extractTextConcepts, resolveTextLinks, fragmentConcept, domainFor } from "../concepts.mjs";

const parse = (file, content) => extractTextConcepts({ file, content, hash: "verified-source" });
test("Markdown units preserve headings, list items, links, and exact final line ranges", () => {
  const first = parse("skills/retry/SKILL.md", "# Retry\n\n- Retry transient failures.\n- Follow [limits](../../limits.md#deadline).\n");
  const second = parse("limits.md", "# Deadline\n\nUse one total deadline.\n");
  resolveTextLinks([first, second]);
  assert.equal(first.units[0].range.endLine, 4);
  assert.equal(first.units.filter(unit => unit.kind === "list-item").length, 2);
  assert.equal(first.units.filter(unit => unit.kind === "rule").length, 0);
  assert.ok(first.units.every(unit => unit.domain === "instruction"));
  assert.ok(first.edges.some(edge => edge.kind === "references" && second.units.some(unit => unit.id === edge.target)));
  assert.deepEqual(first.diagnostics, []);
});
test("JSON pointers and YAML aliases are configuration relationships", () => {
  const first = parse("schema.json", '{"deadline":{"type":"number"},"retry":{"$ref":"#/deadline"}}');
  const second = parse("config.yaml", "defaults: &defaults\n  timeout: 3\nretry: *defaults\n");
  resolveTextLinks([first, second]);
  assert.ok(first.units.some(unit => unit.selector === "/retry/$ref"));
  assert.ok(first.edges.some(edge => edge.kind === "references"));
  assert.ok(second.edges.some(edge => edge.kind === "aliases"));
  assert.ok([...first.edges, ...second.edges].every(edge => !["calls", "caller", "callee"].includes(edge.kind)));
  assert.equal(domainFor("instructions.md"), "instruction");
});
test("malformed and unresolved non-code structure is never complete", () => {
  for (const [file, source] of [["bad.json", '{"x":'], ["bad.yaml", "a: [\n"], ["readme.md", "[escape](../outside.md)"]]) {
    const group = parse(file, source); resolveTextLinks([group]);
    assert.ok(group.diagnostics.some(item => item.code === "incomplete_structure"));
  }
});
test("fragments cover all Unicode text and respect model token budgets including metadata", () => {
  const file = { file: "doc.md", hash: "hash", content: "# Notes\n" + "🙂 large-word ".repeat(500) + "\n" };
  const concept = extractTextConcepts(file).units[0];
  const count = text => [...text].length + 2;
  const fragments = fragmentConcept(concept, file, count, 128);
  assert.ok(fragments.length > 10);
  assert.ok(fragments.every(fragment => count(fragment.text) <= 128 && fragment.parentId === concept.id));
  assert.equal(fragments[0].sourceStart, 0);
  assert.equal(fragments.at(-1).sourceEnd, file.content.length);
  for (let i = 1; i < fragments.length; i++) assert.equal(fragments[i].sourceStart, fragments[i - 1].sourceEnd);
  const recovered = fragments.map(fragment => file.content.slice(fragment.sourceStart, fragment.sourceEnd)).join("");
  assert.equal(recovered, file.content);
});

test("minified configuration fragments contain only their exact key source", () => {
  const content = JSON.stringify(Object.fromEntries(Array.from({ length: 2200 }, (_, i) => [`option${i}`, `independent value ${i}`])));
  const file = { file: "settings.json", content, hash: "verified-source" };
  const keys = extractTextConcepts(file).units.filter(unit => unit.kind === "configuration-key");
  assert.equal(keys.length, 2200);
  const fragments = keys.flatMap(concept => {
    const pieces = fragmentConcept(concept, file, text => text.length, 512, source => Array.from({ length: source.length + 1 }, (_, i) => i));
    assert.equal(pieces.length, 1, concept.selector);
    assert.equal(pieces[0].sourceStart, concept.span.start);
    assert.equal(pieces[0].sourceEnd, concept.span.end);
    assert.equal(pieces[0].text.slice(pieces[0].prefixLength), content.slice(concept.span.start, concept.span.end));
    return pieces;
  });
  assert.equal(fragments.length, 2200);
});

test("split fragments preserve absolute offsets within a nonzero Unicode span", () => {
  const prefix = 'outside 🙂\n';
  const body = '🙂 paragraph words '.repeat(60);
  const file = { file: 'notes.md', content: prefix + body + '\nunrelated sibling', hash: 'verified-source' };
  const concept = { id: 'body', file: file.file, kind: 'paragraph', name: 'body', range: { startLine: 2, endLine: 2 }, span: { start: prefix.length, end: prefix.length + body.length } };
  const pieces = fragmentConcept(concept, file, text => [...text].length, 128);
  assert.ok(pieces.length > 1);
  assert.equal(pieces[0].sourceStart, concept.span.start);
  assert.equal(pieces.at(-1).sourceEnd, concept.span.end);
  assert.equal(pieces.map(piece => file.content.slice(piece.sourceStart, piece.sourceEnd)).join(''), body);
  for (const piece of pieces) {
    assert.equal(piece.text.slice(piece.prefixLength), file.content.slice(piece.sourceStart, piece.sourceEnd));
    assert.deepEqual(piece.range, { startLine: 2, endLine: 2 });
  }
});
