import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { fragmentConcept } from "../../dist/native-runtime/concepts.mjs";
Object.assign(process.env, { PRISM_EMBEDDED: "1", CODEGRAPH_NO_STORE_WORKER: "1", CODEGRAPH_NO_PARALLEL_RESOLVE: "1", CODEGRAPH_NO_WAL_DEFER: "1", CODEGRAPH_NO_FAST_INIT: "1", CODEGRAPH_KERNEL: "0", NODE_DISABLE_COMPILE_CACHE: "1" });
const { extractGraph } = await import("../../dist/native-runtime/graph.mjs");
const runtime = fileURLToPath(new URL("../../dist/native-runtime/", import.meta.url));
for (const extension of ["js", "ts"]) test(`SDK keeps private nested ${extension} declarations out of module exports`, async t => {
  const content = `export function factory() {
    function privateHelper() { return 1; }
    const privateArrow = () => 2;
    return { privateHelper, privateArrow };
  }
  export const directArrow = () => { function innerArrow() { return 3; } return innerArrow(); };
  export const parenthesizedArrow = (() => 4);
  export class PublicClass {
    method() { function innerMethod() { return 5; } return innerMethod(); }
    #secret() { function innerSecret() { return 6; } return innerSecret(); }
    ${extension === "ts" ? "private hidden() { return 7; } protected guarded() { return 8; }" : ""}
  }
  export const publicObject = { objectMethod() { function innerObject() { return 9; } return innerObject(); } };
  export default function defaultFactory() { function innerDefault() { return 6; } return innerDefault(); }
  function unexported() { return 7; }
  export const publicValue = 8;
`;
  const { root, files } = await fixture(t, { [`exports.${extension}`]: content });
  const graph = await extractGraph(root, files, runtime);
  for (const name of ["factory", "directArrow", "parenthesizedArrow", "PublicClass", "method", "objectMethod", "defaultFactory", "publicValue"]) {
    const declarations = graph.nodes.filter(node => node.name === name);
    assert.ok(declarations.length, name);
    assert.ok(declarations.every(node => node.isExported === true), JSON.stringify(declarations));
  }
  for (const name of ["privateHelper", "innerArrow", "innerMethod", "innerSecret", "innerObject", "innerDefault", "unexported", ...(extension === "ts" ? ["hidden", "guarded"] : [])]) {
    const declarations = graph.nodes.filter(node => node.name === name);
    assert.ok(declarations.length, name);
    assert.ok(declarations.every(node => node.isExported === false), JSON.stringify(declarations));
  }
  const secret = graph.nodes.find(node => node.name.includes("secret"));
  assert.equal(secret?.isExported, false);
});
const fixtures = {
  javascript: { "a.js": "export function base() { return 1; }", "b.js": "import { base } from './a.js'; export function caller() { return base(); }" },
  typescript: { "a.ts": "export function base(): number { return 1; }", "b.ts": "import { base } from './a'; export function caller() { return base(); }" },
  python: { "a.py": "def base():\n    return 1\n", "b.py": "from a import base\ndef caller():\n    return base()\n" },
  go: { "go.mod": "module example.org/demo\n\ngo 1.22\n", "a.go": "package demo\nfunc base() int { return 1 }", "b.go": "package demo\nfunc caller() int { return base() }" },
  rust: { "a.rs": "pub fn base() -> i32 { 1 }", "lib.rs": "mod a; pub fn caller() -> i32 { a::base() }" },
  java: { "Base.java": "public class Base { public static int base() { return 1; } }", "Caller.java": "public class Caller { public int caller() { return Base.base(); } }" },
  csharp: { "Base.cs": "public class Base { public static int Value() { return 1; } }", "Caller.cs": "public class Caller { public int Call() { return Base.Value(); } }" },
  c: { "a.h": "int base(void);", "a.c": '#include "a.h"\nint base(void) { return 1; }', "b.c": '#include "a.h"\nint caller(void) { return base(); }' },
  cpp: { "a.hpp": "int base();", "a.cpp": '#include "a.hpp"\nint base() { return 1; }', "b.cpp": '#include "a.hpp"\nint caller() { return base(); }' }
};
async function fixture(t, sources) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-graph-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [file, content] of Object.entries(sources)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); files.push({ file, content, hash: "verified" }); }
  return { root, files };
}
for (const [language, sources] of Object.entries(fixtures)) test(`SDK extracts ${language} and discloses unresolved cross-file relationships`, async t => {
  const { root, files } = await fixture(t, sources);
  const graph = await extractGraph(root, files, runtime);
  assert.ok(graph.nodes.length >= 2, JSON.stringify(graph));
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const crossFile = graph.edges.filter(edge => byId.get(edge.source).file !== byId.get(edge.target).file);
  assert.ok(crossFile.length || graph.diagnostics.length, "Cross-file resolution must produce edges or disclose its limitation.");
  assert.ok(graph.nodes.every(node => files.some(file => file.file === node.file)));
});
test("denied tsconfig reads survive SDK error suppression", async t => {
  const { root, files } = await fixture(t, { "tsconfig.json": '{"extends":"../../outside-tsconfig.json"}', "a.ts": "import { value } from '@outside/base'; export function caller() { return value(); }" });
  const graph = await extractGraph(root, files, runtime);
  assert.ok(graph.diagnostics.some(item => item.code === "incomplete_structure" && /outside/.test(item.message)), JSON.stringify(graph));
});
test("recoverable parser errors and stricter SDK size limits remain incomplete", async t => {
  const { root, files } = await fixture(t, { "broken.ts": "export function broken() { return 1;", "large.ts": "// " + "x".repeat(1024 * 1024) });
  const graph = await extractGraph(root, files, runtime);
  for (const file of files) assert.ok(graph.diagnostics.some(item => item.file === file.file), JSON.stringify(graph));
});
test("dynamic calls and missing dependencies cannot claim complete structure", async t => {
  const { root, files } = await fixture(t, {
    "dynamic.ts": "export function invoke(target: any, key: string) { return target[key](); }\n",
    "missing.ts": "import { absent } from './absent'; export function invokeMissing() { return absent(); }\n"
  });
  const graph = await extractGraph(root, files, runtime);
  for (const file of files) assert.ok(graph.diagnostics.some(item => item.code === "incomplete_structure" && item.file === file.file), JSON.stringify(graph));
});
test('same-line Unicode declarations retain exact source spans and public provenance',async t=>{
  const content='const emoji = "🙂"; export function first() { return emoji; } export function second() { return 2; }\n';
  const {root,files}=await fixture(t,{'same.ts':content});
  const graph=await extractGraph(root,files,runtime);
  const first=graph.nodes.find(node=>node.name==='first'),second=graph.nodes.find(node=>node.name==='second');
  assert.ok(first?.span&&second?.span,JSON.stringify(graph));
  assert.match(content.slice(first.span.start,first.span.end),/^function first\(\) \{ return emoji; \}$/);
  assert.match(content.slice(second.span.start,second.span.end),/^function second\(\) \{ return 2; \}$/);
  assert.equal(first.isExported,true);assert.equal(second.isExported,true);
  for (const concept of [first, second]) {
    const pieces = fragmentConcept(concept, files[0], text => text.length);
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0].sourceStart, concept.span.start);
    assert.equal(pieces[0].sourceEnd, concept.span.end);
    assert.equal(pieces[0].text.slice(pieces[0].prefixLength), content.slice(concept.span.start, concept.span.end));
  }
});
