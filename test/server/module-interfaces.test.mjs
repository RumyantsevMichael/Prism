import test from "node:test";
import assert from "node:assert/strict";
import { moduleInterfaceReport, delegatingClasses } from "../../dist/server/repository-intelligence/module-interfaces.mjs";

// Build index units from source text: each listed declaration becomes a unit at the line that declares it.
function project(files, declarations) {
  const contents = new Map(Object.entries(files)), units = [];
  for (const [file, content] of contents) units.push({ id: `${file}#file`, file, kind: "file", name: file, range: { startLine: 1, endLine: content.split("\n").length } });
  for (const { file, name, kind = "function", exported = true, container, signature } of declarations) {
    const content = contents.get(file), start = content.indexOf(name), line = content.slice(0, start).split("\n").length;
    const python = file.endsWith(".py"), next = content.indexOf("\n    def ", start);
    const end = python && kind !== "file" ? (kind === "method" && next >= 0 ? next : content.length)
      : kind === "method" || kind === "class" ? content.indexOf(kind === "class" ? "\n}" : "}", start) + 1 : start + name.length;
    units.push({ id: `${file}#${name}`, file, kind, name, range: { startLine: line, endLine: content.slice(0, end).split("\n").length }, span: { start: content.lastIndexOf("\n", start) + 1, end },
      isExported: exported, containerId: container ? `${file}#${container}` : `${file}#file`, signature });
  }
  return { units, contents };
}

const byFile = (report, file) => report.modules.find(module => module.file === file);

test("imports resolve through relative paths, mjs specifiers of mts sources, dynamic imports, require, and re-exports", () => {
  const { units, contents } = project({
    "src/store.mts": "export function put() {}\nexport function link() {}\nexport function unused() {}\nexport function tested() {}\nexport default function main() {}\n",
    "src/index.mjs": "export { link } from './store.mjs';\n",
    "src/app.mjs": "import { put } from './store.mjs';\nimport run from './store.mjs';\nconst lazy = await import('./lazy.mjs');\nconst old = require('./old.js');\n",
    "src/lazy.mts": "export function later() {}\n",
    "src/old.js": "export function legacy() {}\n",
    "test/store.test.mjs": "import { tested } from '../dist/store.mjs';\n"
  }, [
    { file: "src/store.mts", name: "put" }, { file: "src/store.mts", name: "link" }, { file: "src/store.mts", name: "unused" }, { file: "src/store.mts", name: "tested" }, { file: "src/store.mts", name: "main" },
    { file: "src/lazy.mts", name: "later" }, { file: "src/old.js", name: "legacy" }
  ]);
  const report = moduleInterfaceReport({ units }, contents, { allModules: true });
  const store = byFile(report, "src/store.mts");
  assert.deepEqual(store.unusedExports, ["unused"]);
  // The test imports the built file dist/store.mjs, which mirrors src/store.mts.
  assert.deepEqual(store.testOnlyExports, ["tested"]);
  assert.deepEqual(Object.fromEntries(store.exports.map(item => [item.name, item.importers])), { put: 1, link: 1, unused: 0, tested: 0, main: 1 });
  assert.deepEqual(byFile(report, "src/lazy.mts").unusedExports, []);
  assert.deepEqual(byFile(report, "src/old.js").unusedExports, []);
  assert.equal(report.coverage.unresolvedLocalImports, 0);
});

test("workspace packages resolve through their exports map, and path aliases through tsconfig", () => {
  const { units, contents } = project({
    "packages/protocol/package.json": JSON.stringify({ name: "protocol", exports: { ".": "./index.ts", "./wire/*": { import: "./src/wire/*.ts" } } }),
    "packages/protocol/index.ts": "export const VERSION = 1;\nexport const SPARE = 2;\n",
    "packages/protocol/src/wire/frame.ts": "export function encode() {}\n",
    "apps/web/tsconfig.json": "{ // comment\n \"compilerOptions\": { \"baseUrl\": \".\", \"paths\": { \"@/*\": [\"src/*\"] }, }\n}",
    "apps/web/src/util.ts": "export function format() {}\n",
    "apps/web/src/main.ts": "import { VERSION } from 'protocol';\nimport { encode } from 'protocol/wire/frame';\nimport { format } from '@/util';\nimport { missing } from '@/gone';\nimport React from 'react';\nimport { spare } from './nowhere';\n"
  }, [
    { file: "packages/protocol/index.ts", name: "VERSION", kind: "constant" }, { file: "packages/protocol/index.ts", name: "SPARE", kind: "constant" },
    { file: "packages/protocol/src/wire/frame.ts", name: "encode" }, { file: "apps/web/src/util.ts", name: "format" }
  ]);
  const report = moduleInterfaceReport({ units }, contents, { allModules: true });
  assert.deepEqual(byFile(report, "packages/protocol/index.ts").unusedExports, ["SPARE"]);
  assert.deepEqual(byFile(report, "packages/protocol/src/wire/frame.ts").unusedExports, []);
  assert.deepEqual(byFile(report, "apps/web/src/util.ts").unusedExports, []);
  // An alias or relative path that does not resolve is disclosed, and an npm package is not.
  assert.equal(report.coverage.unresolvedLocalImports, 2);
  assert.ok(report.coverage.unresolvedSamples.some(item => item.endsWith("@/gone")));
});

test("only top-level declarations with the export keyword in runtime source count as module exports", () => {
  const { units, contents } = project({
    "src/server.mjs": "export function start() {\n  function closure() {}\n  const local = 1;\n}\nfunction hidden() {}\n",
    "docs/plans/contracts.ts": "export const SHAPE = {};\n",
    "src/types.d.ts": "export declare function typed(): void;\n",
    "dist/server.mjs": "export function built() {}\n",
    "src/user.mjs": "import { start } from './server.mjs';\n"
  }, [
    { file: "src/server.mjs", name: "start" }, { file: "src/server.mjs", name: "closure", container: "start" }, { file: "src/server.mjs", name: "local", kind: "variable" },
    { file: "src/server.mjs", name: "hidden" }, { file: "docs/plans/contracts.ts", name: "SHAPE", kind: "constant" }, { file: "src/types.d.ts", name: "typed" }, { file: "dist/server.mjs", name: "built" }
  ]);
  const report = moduleInterfaceReport({ units }, contents, { allModules: true });
  assert.deepEqual(report.modules.map(module => module.file), ["src/server.mjs"]);
  assert.deepEqual(report.modules[0].exports.map(item => item.name), ["start"]);
  assert.equal(report.coverage.exportingModules, 1);
});

test("modules without findings appear only on request, and the path filter limits reported modules", () => {
  const { units, contents } = project({
    "src/a.mjs": "export function used() {}\n", "src/b.mjs": "export function spare() {}\n", "src/c.mjs": "import { used } from './a.mjs';\n"
  }, [{ file: "src/a.mjs", name: "used" }, { file: "src/b.mjs", name: "spare" }]);
  assert.deepEqual(moduleInterfaceReport({ units }, contents).modules.map(module => module.file), ["src/b.mjs"]);
  assert.deepEqual(moduleInterfaceReport({ units }, contents, { allModules: true, include: file => file === "src/a.mjs" }).modules.map(module => module.file), ["src/a.mjs"]);
});

test("classes that forward most public methods to one field are reported with unchanged names", () => {
  const facade = "class Facade {\n  start(name) { return this.registry.start(name); }\n  stop(name) { return this.registry.stop(name); }\n  status() { return this.registry.state(); }\n  extra(value) { return value + 1; }\n}\n";
  const adapter = "class Adapter:\n    def send(self, data):\n        return self._socket.write(data)\n    def close(self):\n        self._socket.close()\n    def ping(self):\n        return self._socket.ping()\n";
  const mixed = "class Mixed {\n  read(id) { return this.store.read(id); }\n  write(id, value) { this.check(value); return this.store.write(id, value); }\n  list() { return [...this.items]; }\n}\n";
  const { units, contents } = project({ "src/facade.mjs": facade, "src/adapter.py": adapter, "src/mixed.mjs": mixed }, [
    { file: "src/facade.mjs", name: "Facade", kind: "class" }, ...["start", "stop", "status", "extra"].map(name => ({ file: "src/facade.mjs", name, kind: "method", container: "Facade", signature: name === "status" ? "()" : "(name)" })),
    { file: "src/adapter.py", name: "Adapter", kind: "class" }, ...["send", "close", "ping"].map(name => ({ file: "src/adapter.py", name, kind: "method", container: "Adapter", signature: name === "send" ? "(self, data)" : "(self)" })),
    { file: "src/mixed.mjs", name: "Mixed", kind: "class" }, ...["read", "write", "list"].map(name => ({ file: "src/mixed.mjs", name, kind: "method", container: "Mixed", signature: name === "read" ? "(id)" : name === "write" ? "(id, value)" : "()" }))
  ]);
  const found = delegatingClasses({ units }, contents);
  assert.deepEqual(found.map(item => [item.selector, item.forwarding, item.publicMethods, item.delegate, item.unchangedNames]), [["Adapter", 3, 3, "_socket", 2], ["Facade", 3, 4, "registry", 2]]);
});
