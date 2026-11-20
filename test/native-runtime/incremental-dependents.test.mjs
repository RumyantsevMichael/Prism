import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
Object.assign(process.env, { PRISM_WORKER_LIBRARY: "1", PRISM_EMBEDDED: "1", CODEGRAPH_NO_STORE_WORKER: "1", CODEGRAPH_NO_PARALLEL_RESOLVE: "1", CODEGRAPH_NO_WAL_DEFER: "1", CODEGRAPH_NO_FAST_INIT: "1", CODEGRAPH_KERNEL: "0", NODE_DISABLE_COMPILE_CACHE: "1" });
const { structure } = await import("../../dist/native-runtime/worker.mjs");

// Runs after `npm run stage:native`, against the pinned code graph: an unchanged file can resolve differently when a code file it reaches changes,
// through an import path that now exists, a re-exporting file that now points elsewhere, or a framework pass over several files,
// so the incremental build syncs those files too, or builds in full, and still returns a full build's index.
const sha = (value) => createHash("sha256").update(value).digest("hex");
const words = (text) => text.split(/\s+/).filter(Boolean).length;
const tools = { countTokens: words, fileTokens: words };
// A file that nothing reaches, which a sync leaves alone and a full build parses.
const SOLO = { "solo.ts": "export function standalone() {\n  return 0;\n}\n" };
async function folder(t, prefix) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function place(mirror, files) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(mirror, file)), { recursive: true });
    await rm(path.join(mirror, file), { force: true });
    await writeFile(path.join(mirror, file), content);
  }
}
const listed = (files) => Object.entries(files).map(([file, content]) => ({ file, hash: sha(content) })).sort((a, b) => a.file < b.file ? -1 : 1);
const args = (mirror, files, extra = {}) => ({ mirror, files: listed(files), snapshot: "c".repeat(64), modelDirectory: "unused", modelIdentity: "model", ...extra });
const comparable = ({ resources: _resources, ...index }) => JSON.parse(JSON.stringify(index));

// Returns the full build's index and the largest number of files the incremental build's graph parsed.
async function incrementalEqualsFull(t, before, after) {
  const kept = path.join(await folder(t, "prism-dependents-kept-"), "mirror");
  await place(kept, before);
  await structure(args(kept, before), () => {}, tools);
  for (const file of Object.keys(before)) if (!(file in after)) await rm(path.join(kept, file));
  const changedFiles = Object.keys(after).filter(file => before[file] !== after[file]).sort();
  const removedFiles = Object.keys(before).filter(file => !(file in after)).sort();
  await place(kept, Object.fromEntries(changedFiles.map(file => [file, after[file]])));
  const phases = [];
  const incremental = comparable(await structure(args(kept, after, { changedFiles, removedFiles }), value => phases.push(value), tools));
  const fresh = path.join(await folder(t, "prism-dependents-full-"), "mirror");
  await place(fresh, after);
  const full = comparable(await structure(args(fresh, after), () => {}, tools));
  assert.deepEqual(Object.keys(incremental).sort(), Object.keys(full).sort());
  for (const key of Object.keys(full)) assert.deepEqual(incremental[key], full[key], `field ${key} differs`);
  const parsed = phases.filter(value => value.phase === "graph:parsing").map(value => value.total);
  return { full, parsed: parsed.length ? Math.max(...parsed) : 0 };
}
// A sync that leaves the unrelated file alone parses fewer files than the code files of the snapshot.
const synced = (parsed, files) => assert.ok(parsed < Object.keys(files).filter(file => /\.[jt]s$/.test(file)).length, `the graph parsed ${parsed} files, as a full build does`);

const F = "export function f() {\n  return 1;\n}\n";
const IMPORT_F = (from) => `import { f } from '${from}';\nexport function g() {\n  return f();\n}\n`;
const ALIAS = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@pkg": ["src/library/index.ts"] } } });
const WORKSPACES = JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] });
const UI = JSON.stringify({ name: "@scope/ui", main: "src/index.ts" });
const NAMESPACE = "import * as m from './b';\nexport function g() {\n  return m.f();\n}\n";
const cases = {
  "a namespace import of an added file resolves in the unchanged importer": [{ "a.ts": NAMESPACE }, { "a.ts": NAMESPACE, "b.ts": F }],
  "a barrel re-export pointed at another file moves the unchanged importer's link": [
    { "a.ts": IMPORT_F("./lib"), "lib/index.ts": "export { f } from './f1';\n", "lib/f1.ts": F, "lib/f2.ts": F },
    { "a.ts": IMPORT_F("./lib"), "lib/index.ts": "export { f } from './f2';\n", "lib/f1.ts": F, "lib/f2.ts": F }],
  "a barrel that gains a star re-export resolves the unchanged importer through it": [
    { "a.ts": IMPORT_F("./lib"), "lib/index.ts": "export * from './f1';\n", "lib/f1.ts": "export const x = 1;\n", "lib/f2.ts": F },
    { "a.ts": IMPORT_F("./lib"), "lib/index.ts": "export * from './f1';\nexport * from './f2';\n", "lib/f1.ts": "export const x = 1;\n", "lib/f2.ts": F }],
  "a namespace import's changed target resolves in the unchanged importer": [
    { "a.ts": NAMESPACE, "b.ts": "export function h() {\n  return 1;\n}\n" }, { "a.ts": NAMESPACE, "b.ts": F }],
  "a default re-export two levels deep pointed at another file moves the unchanged importer's link": [
    { "a.ts": IMPORT_F("./mid"), "mid.ts": "export { f } from './lib';\n", "lib/index.ts": "export { default as f } from './f1';\n", "lib/f1.ts": "export default function f1() {\n  return 1;\n}\n", "lib/f2.ts": "export default function f2() {\n  return 2;\n}\n" },
    { "a.ts": IMPORT_F("./mid"), "mid.ts": "export { f } from './lib';\n", "lib/index.ts": "export { default as f } from './f2';\n", "lib/f1.ts": "export default function f1() {\n  return 1;\n}\n", "lib/f2.ts": "export default function f2() {\n  return 2;\n}\n" }],
  "a named re-export chain two levels deep that renames its source moves the unchanged importer's link": [
    { "a.ts": IMPORT_F("./mid"), "mid.ts": "export * from './inner';\n", "inner.ts": "export { one as f } from './one';\n", "one.ts": "export function one() {\n  return 1;\n}\n", "two.ts": "export function two() {\n  return 2;\n}\n" },
    { "a.ts": IMPORT_F("./mid"), "mid.ts": "export * from './inner';\n", "inner.ts": "export { two as f } from './two';\n", "one.ts": "export function one() {\n  return 1;\n}\n", "two.ts": "export function two() {\n  return 2;\n}\n" }],
  "a barrel two star re-exports deep that gains a star re-export resolves the unchanged importer through both": [
    { "a.ts": IMPORT_F("./mid"), "mid.ts": "export * from './lib';\nexport function own() {\n  return 0;\n}\n", "lib/index.ts": "export * from './f1';\n", "lib/f1.ts": "export const x = 1;\n", "lib/f2.ts": F },
    { "a.ts": IMPORT_F("./mid"), "mid.ts": "export * from './lib';\nexport function own() {\n  return 0;\n}\n", "lib/index.ts": "export * from './f1';\nexport * from './f2';\n", "lib/f1.ts": "export const x = 1;\n", "lib/f2.ts": F }],
  "a removed file that an unchanged file imported leaves its import unresolved": [{ "a.ts": IMPORT_F("./b"), "b.ts": F }, { "a.ts": IMPORT_F("./b") }],
  "a renamed export leaves the unchanged importer's import unresolved": [{ "a.ts": IMPORT_F("./b"), "b.ts": F }, { "a.ts": IMPORT_F("./b"), "b.ts": "export function h() {\n  return 1;\n}\n" }],
  "a default import of an added file resolves in the unchanged importer": [
    { "a.ts": "import f from './b';\nexport function g() {\n  return f();\n}\n" },
    { "a.ts": "import f from './b';\nexport function g() {\n  return f();\n}\n", "b.ts": "export default function f() {\n  return 1;\n}\n" }],
  "a barrel behind a path alias that gains a star re-export resolves the unchanged importer through it": [
    { "tsconfig.json": ALIAS, "src/a.ts": IMPORT_F("@pkg"), "src/library/index.ts": "export * from './f1';\n", "src/library/f1.ts": "export const x = 1;\n", "src/library/f2.ts": F },
    { "tsconfig.json": ALIAS, "src/a.ts": IMPORT_F("@pkg"), "src/library/index.ts": "export * from './f1';\nexport * from './f2';\n", "src/library/f1.ts": "export const x = 1;\n", "src/library/f2.ts": F }],
  "a workspace package's barrel that gains a star re-export resolves the unchanged importer through it": [
    { "package.json": WORKSPACES, "packages/ui/package.json": UI, "packages/ui/src/index.ts": "export * from './f1';\n", "packages/ui/src/f1.ts": "export const x = 1;\n", "packages/ui/src/f2.ts": F, "app/a.ts": IMPORT_F("@scope/ui") },
    { "package.json": WORKSPACES, "packages/ui/package.json": UI, "packages/ui/src/index.ts": "export * from './f1';\nexport * from './f2';\n", "packages/ui/src/f1.ts": "export const x = 1;\n", "packages/ui/src/f2.ts": F, "app/a.ts": IMPORT_F("@scope/ui") }],
};
for (const [name, [before, after]] of Object.entries(cases)) test(name, async t => {
  const { parsed } = await incrementalEqualsFull(t, { ...before, ...SOLO }, { ...after, ...SOLO });
  synced(parsed, { ...after, ...SOLO });
});

const MODULE = "import { Module } from '@nestjs/common';\nimport { UsersController } from './users.controller';\n@Module({ controllers: [UsersController] })\nexport class UsersModule {}\n";
const CONTROLLER = "import { Controller, Get } from '@nestjs/common';\n@Controller('users')\nexport class UsersController {\n  @Get()\n  list() {\n    return [];\n  }\n}\n";
const MAIN = "import { NestFactory } from '@nestjs/core';\nexport const x = NestFactory;\n";
const APP = "import { Module } from '@nestjs/common';\nimport { RouterModule } from '@nestjs/core';\nimport { UsersModule } from './users.module';\n@Module({ imports: [UsersModule, RouterModule.register([{ path: 'api', module: UsersModule }])] })\nexport class AppModule {}\n";
const routes = (index) => index.units.filter(unit => unit.kind === "route").map(unit => unit.name);

test("removing the module that prefixes a NestJS route gives the unchanged controller its unprefixed route", async t => {
  const rest = { "src/users.module.ts": MODULE, "src/users.controller.ts": CONTROLLER, "src/main.ts": MAIN };
  const { full } = await incrementalEqualsFull(t, { "src/app.module.ts": APP, ...rest }, rest);
  assert.deepEqual(routes(full), ["GET /users"]);
});

test("adding the module that prefixes a NestJS route gives the unchanged controller its prefixed route", async t => {
  const rest = { "src/users.module.ts": MODULE, "src/users.controller.ts": CONTROLLER, "src/main.ts": MAIN };
  const { full } = await incrementalEqualsFull(t, rest, { "src/app.module.ts": APP, ...rest });
  assert.deepEqual(routes(full), ["GET /api/users"]);
});
