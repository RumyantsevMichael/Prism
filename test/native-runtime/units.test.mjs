import test from "node:test";
import assert from "node:assert/strict";
import { extractTextUnits, resolveTextLinks, domainFor } from "../../dist/native-runtime/units.mjs";
import { fragmentUnit } from "../../dist/native-runtime/fragments.mjs";

const parse = (file, content) => extractTextUnits({ file, content, hash: "verified-source" });
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
test("explicit anchors name the heading that follows them, and an unresolved link names its target", () => {
  const group = parse("requirements.md", '# Store\n\n<a id="1"></a>\n## 1. Share one unit\n\nRelated: [§2](#2).\n\n<a id="2"></a>\n## 2. Keep behavior\n\nRelated: [§1](#1), [§3](#3).\n');
  resolveTextLinks([group]);
  const headings = Object.fromEntries(group.units.filter(unit => unit.kind === "heading").map(unit => [unit.selector, unit.id]));
  assert.equal(group.anchors["1"], "#1-share-one-unit");
  assert.ok(group.edges.some(edge => edge.kind === "references" && edge.target === headings["#2-keep-behavior"]));
  assert.ok(group.edges.some(edge => edge.kind === "references" && edge.target === headings["#1-share-one-unit"]));
  assert.deepEqual(group.diagnostics.map(item => item.message), ["The local reference #3 does not resolve to a file, heading, explicit anchor, or configuration key."]);
  assert.equal(group.units.filter(unit => unit.kind === "paragraph" && unit.name.includes("<a")).length, 0);
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
  const unit = extractTextUnits(file).units[0];
  const count = text => [...text].length + 2;
  const fragments = fragmentUnit(unit, file, count, 128);
  assert.ok(fragments.length > 10);
  assert.ok(fragments.every(fragment => count(fragment.text) <= 128 && fragment.parentId === unit.id));
  assert.ok(fragments.every(fragment => count(fragment.embeddingText) <= 128));
  assert.equal(fragments[0].sourceStart, 0);
  assert.equal(fragments.at(-1).sourceEnd, file.content.length);
  for (let i = 1; i < fragments.length; i++) assert.equal(fragments[i].sourceStart, fragments[i - 1].sourceEnd);
  const recovered = fragments.map(fragment => file.content.slice(fragment.sourceStart, fragment.sourceEnd)).join("");
  assert.equal(recovered, file.content);
});

test("file fragments share model inputs and keep the module name in the lexical context", () => {
  const fragments = ["src/example.mts", "generated/example.mjs"].map(file => {
    const input = { file, content: "const local = 1;\n", hash: "verified" };
    return fragmentUnit(extractTextUnits(input).units[0], input, text => text.length)[0];
  });
  assert.equal(fragments[0].embeddingText, fragments[1].embeddingText);
  for (const fragment of fragments) {
    assert.equal(fragment.role, "whole");
    assert.equal(fragment.context, "example");
    assert.equal(fragment.text.slice(fragment.prefixLength), "const local = 1;\n");
    assert.equal(fragment.embeddingText, "file\nconst local = 1;\n");
  }
});

test("minified configuration fragments contain only their exact key source", () => {
  const content = JSON.stringify(Object.fromEntries(Array.from({ length: 2200 }, (_, i) => [`option${i}`, `independent value ${i}`])));
  const file = { file: "settings.json", content, hash: "verified-source" };
  const keys = extractTextUnits(file).units.filter(unit => unit.kind === "configuration-key");
  assert.equal(keys.length, 2200);
  const fragments = keys.flatMap(unit => {
    const pieces = fragmentUnit(unit, file, text => text.length, 512, source => Array.from({ length: source.length + 1 }, (_, i) => i));
    assert.equal(pieces.length, 1, unit.selector);
    assert.equal(pieces[0].sourceStart, unit.span.start);
    assert.equal(pieces[0].sourceEnd, unit.span.end);
    assert.equal(pieces[0].text.slice(pieces[0].prefixLength), content.slice(unit.span.start, unit.span.end));
    return pieces;
  });
  assert.equal(fragments.length, 2200);
});

test("split fragments preserve absolute offsets within a nonzero Unicode span", () => {
  const prefix = 'outside 🙂\n';
  const body = '🙂 paragraph words '.repeat(60);
  const file = { file: 'notes.md', content: prefix + body + '\nunrelated sibling', hash: 'verified-source' };
  const unit = { id: 'body', file: file.file, kind: 'paragraph', name: 'body', range: { startLine: 2, endLine: 2 }, span: { start: prefix.length, end: prefix.length + body.length } };
  const pieces = fragmentUnit(unit, file, text => [...text].length, 128);
  assert.ok(pieces.length > 1);
  assert.equal(pieces[0].sourceStart, unit.span.start);
  assert.equal(pieces.at(-1).sourceEnd, unit.span.end);
  assert.equal(pieces.map(piece => file.content.slice(piece.sourceStart, piece.sourceEnd)).join(''), body);
  for (const piece of pieces) {
    assert.equal(piece.text.slice(piece.prefixLength), file.content.slice(piece.sourceStart, piece.sourceEnd));
    assert.deepEqual(piece.range, { startLine: 2, endLine: 2 });
  }
});
test("lockfiles, generated output, and minified bundles supply no search candidates", async () => {
  const { searchExclusion } = await import("../../dist/native-runtime/domains.mjs");
  assert.equal(searchExclusion("src/native-runtime/package-lock.json", "{}"), "lockfile");
  assert.equal(searchExclusion("dist/server/mcp.mjs", "export {};\n"), "generated");
  assert.equal(searchExclusion("assets/c4.min.js", "x"), "minified");
  assert.equal(searchExclusion("assets/bundle.js", "x".repeat(30000)), "minified");
  assert.equal(searchExclusion("src/server/mcp.mjs", "export {};\n".repeat(3000)), null);
  assert.equal(searchExclusion("docs/dist.md", "# Dist\n"), null);
});
