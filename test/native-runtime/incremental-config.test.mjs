import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
Object.assign(process.env, { PRISM_WORKER_LIBRARY: "1", PRISM_EMBEDDED: "1", CODEGRAPH_NO_STORE_WORKER: "1", CODEGRAPH_NO_PARALLEL_RESOLVE: "1", CODEGRAPH_NO_WAL_DEFER: "1", CODEGRAPH_NO_FAST_INIT: "1", CODEGRAPH_KERNEL: "0", NODE_DISABLE_COMPILE_CACHE: "1" });
const { structure } = await import("../../dist/native-runtime/worker.mjs");

// Runs after `npm run stage:native`, against the pinned code graph: a change to a file that the graph reads as project configuration, or one that
// changes which frameworks it detects, changes how unchanged files are indexed, so the incremental build still returns a full build's index.
const sha = (value) => createHash("sha256").update(value).digest("hex");
const words = (text) => text.split(/\s+/).filter(Boolean).length;
const tools = { countTokens: words, fileTokens: words };
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

async function incrementalEqualsFull(t, before, after) {
  const kept = path.join(await folder(t, "prism-config-kept-"), "mirror");
  await place(kept, before);
  await structure(args(kept, before), () => {}, tools);
  for (const file of Object.keys(before)) if (!(file in after)) await rm(path.join(kept, file));
  const changedFiles = Object.keys(after).filter(file => before[file] !== after[file]).sort();
  const removedFiles = Object.keys(before).filter(file => !(file in after)).sort();
  await place(kept, Object.fromEntries(changedFiles.map(file => [file, after[file]])));
  const incremental = comparable(await structure(args(kept, after, { changedFiles, removedFiles }), () => {}, tools));
  const fresh = path.join(await folder(t, "prism-config-full-"), "mirror");
  await place(fresh, after);
  const full = comparable(await structure(args(fresh, after), () => {}, tools));
  assert.deepEqual(Object.keys(incremental).sort(), Object.keys(full).sort());
  for (const key of Object.keys(full)) assert.deepEqual(incremental[key], full[key], `field ${key} differs`);
  return full;
}

const GENERATED = "export function gen() {\n  return 1;\n}\n";
const MAIN = "export function main() {\n  return 2;\n}\n";
const APP = "import express from 'express';\nconst app = express();\napp.get('/users', function listUsers(req, res) {\n  res.send('ok');\n});\nexport default app;\n";
const routeOf = (index) => index.units.some(unit => unit.kind === "route" && unit.file === "src/app.js");

test("an ignore entry added for an unchanged file removes it from the incremental index", async t => {
  const full = await incrementalEqualsFull(t, { ".gitignore": "# none\n", "gen/x.ts": GENERATED, "src/m.ts": MAIN }, { ".gitignore": "gen/\n", "gen/x.ts": GENERATED, "src/m.ts": MAIN });
  assert.equal(full.units.some(unit => unit.name === "gen"), false);
});

test("an ignore entry dropped for an unchanged file adds it to the incremental index", async t => {
  const full = await incrementalEqualsFull(t, { ".gitignore": "gen/\n", "gen/x.ts": GENERATED, "src/m.ts": MAIN }, { ".gitignore": "# none\n", "gen/x.ts": GENERATED, "src/m.ts": MAIN });
  assert.equal(full.units.some(unit => unit.name === "gen"), true);
});

test("a code graph configuration that excludes an unchanged file removes it from the incremental index", async t => {
  const full = await incrementalEqualsFull(t, { "gen/x.ts": GENERATED, "src/m.ts": MAIN }, { "codegraph.json": JSON.stringify({ exclude: ["gen/**"] }), "gen/x.ts": GENERATED, "src/m.ts": MAIN });
  assert.equal(full.units.some(unit => unit.name === "gen"), false);
});

test("a manifest that adds a framework gives an unchanged file its framework units", async t => {
  const full = await incrementalEqualsFull(t, { "package.json": "{}\n", "src/app.js": APP }, { "package.json": JSON.stringify({ dependencies: { express: "4.0.0" } }) + "\n", "src/app.js": APP });
  assert.equal(routeOf(full), true);
});

test("a code file that makes the graph detect a framework gives an unchanged file its framework units", async t => {
  const full = await incrementalEqualsFull(t, { "src/app.js": APP }, { "src/app.js": APP, "src/routes/users.js": "// express routes\nexport const users = [];\n" });
  assert.equal(routeOf(full), true);
});
