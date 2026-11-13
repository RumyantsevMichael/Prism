import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FILES, manifestPath, project } from "./fixtures/component-indexes.mjs";
import { sha256, stagedRuntime, until } from "./fixtures/staged-runtime.mjs";

// Acceptance tests of index-preparation.md §8 for the index-preparation contract, clauses 6, 22, and 23.
// The staged runtime reads every file of a build from its mirror and fails with stale_snapshot when one differs, so each passing build proves its mirror.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-index-incremental-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { openNativeRepositoryIntelligence } = await import("../../dist/server/repository-intelligence/native-repository-intelligence.mjs");

const ALL = [".prism/workflow.md", "README.md", "packages/app/client.ts", "packages/net/retry.ts", "packages/net/timeout.ts"];
const build = async (runtime, root, count, control) => {
  await runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 0);
  await until(async () => control.builds.length >= count && ["ready", "degraded"].includes((await runtime.status(root)).status), `Build ${count} did not end.`);
  return runtime.status(root);
};
const hashes = async (root, files) => Object.fromEntries(await Promise.all(files.map(async (file) => [file, sha256(await readFile(path.join(root, file), "utf8"))])));

test("clauses 22 and 23: a first build copies every file into the kept mirror and passes no change lists", async (t) => {
  const { root, storage } = await project(t, { components: null });
  const { runtime, control } = await stagedRuntime(storage);
  assert.equal((await build(runtime, root, 1, control)).status, "ready");
  const directory = (await runtime.location(root)).directory;
  const [first] = control.builds;
  assert.equal(first.mirror, path.join(directory, "mirror"));
  assert.deepEqual([first.changedFiles, first.removedFiles], [undefined, undefined]);
  assert.deepEqual(first.files, ALL);
  const manifest = JSON.parse(await readFile(path.join(directory, "mirror.json"), "utf8"));
  const expected = await hashes(root, ALL);
  assert.deepEqual(manifest, { schemaVersion: 1, mirror: expected, indexed: expected });
  for (const file of ALL) assert.equal(await readFile(path.join(directory, "mirror", file), "utf8"), await readFile(path.join(root, file), "utf8"));
});

test("clauses 6 and 23: a rebuild copies only changed files, removes deleted ones, and names both to the runtime", async (t) => {
  const { root, storage, write } = await project(t, { components: null });
  const { runtime, control } = await stagedRuntime(storage);
  await build(runtime, root, 1, control);
  const mirror = path.join((await runtime.location(root)).directory, "mirror");
  const untouched = (await stat(path.join(mirror, "packages/app/client.ts"))).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await write("README.md", `${FILES["README.md"]}Changed.\n`);
  await write("packages/app/added.ts", "export function added(value) {\n  return value;\n}\n");
  await rm(path.join(root, "packages/net/timeout.ts"));
  assert.equal((await build(runtime, root, 2, control)).status, "ready");
  const second = control.builds[1];
  assert.deepEqual(second.changedFiles, ["README.md", "packages/app/added.ts"]);
  assert.deepEqual(second.removedFiles, ["packages/net/timeout.ts"]);
  assert.deepEqual(second.files, [".prism/workflow.md", "README.md", "packages/app/added.ts", "packages/app/client.ts", "packages/net/retry.ts"], "the request still lists every file");
  assert.equal((await stat(path.join(mirror, "packages/app/client.ts"))).mtimeMs, untouched, "an unchanged file is not copied again");
  await assert.rejects(stat(path.join(mirror, "packages/net/timeout.ts")), { code: "ENOENT" });
  // A rebuild of unchanged content needs no build at all.
  await runtime.prepare(await openNativeRepositoryIntelligence(root), undefined, 0);
  assert.equal(control.builds.length, 2);
});

test("clause 23: a change that a stopped build copied but never indexed is still named to the next build", async (t) => {
  const { root, storage, write } = await project(t, { components: null });
  const first = await stagedRuntime(storage, { stallMs: 250 });
  await build(first.runtime, root, 1, first.control);
  await write("README.md", `${FILES["README.md"]}Changed.\n`);
  first.control.hold("README.md", "structure");
  assert.equal((await build(first.runtime, root, 2, first.control)).status, "degraded", "the build stalls before its runtime reports structure");
  first.control.release("README.md");
  const later = await stagedRuntime(storage);
  assert.equal((await build(later.runtime, root, 1, later.control)).status, "ready");
  assert.deepEqual(later.control.builds[0].changedFiles, ["README.md"]);
  assert.deepEqual(later.control.builds[0].removedFiles, []);
});

test("clause 23: an unreadable manifest makes a full build that empties the mirror and the runtime's state", async (t) => {
  const { root, storage, write } = await project(t, { components: null });
  const { runtime, control } = await stagedRuntime(storage);
  await build(runtime, root, 1, control);
  const directory = (await runtime.location(root)).directory;
  await mkdir(path.join(directory, "runtime-state"), { recursive: true });
  await writeFile(path.join(directory, "runtime-state", "kept.json"), "{}");
  await writeFile(path.join(directory, "mirror", "stray.txt"), "left behind");
  await writeFile(path.join(directory, "mirror.json"), "not json");
  await write("README.md", `${FILES["README.md"]}Changed.\n`);
  assert.equal((await build(runtime, root, 2, control)).status, "ready");
  assert.deepEqual([control.builds[1].changedFiles, control.builds[1].removedFiles], [undefined, undefined]);
  await assert.rejects(stat(path.join(directory, "runtime-state", "kept.json")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(directory, "mirror", "stray.txt")), { code: "ENOENT" });
});

test("clause 23: a manifest that names a file the mirror lacks makes a full build", async (t) => {
  const { root, storage, write } = await project(t, { components: null });
  const { runtime, control } = await stagedRuntime(storage);
  await build(runtime, root, 1, control);
  const directory = (await runtime.location(root)).directory;
  await rm(path.join(directory, "mirror", "packages/net/retry.ts"), { force: true });
  await write("README.md", `${FILES["README.md"]}Changed.\n`);
  assert.equal((await build(runtime, root, 2, control)).status, "ready");
  assert.deepEqual([control.builds[1].changedFiles, control.builds[1].removedFiles], [undefined, undefined]);
  assert.equal(await readFile(path.join(directory, "mirror", "packages/net/retry.ts"), "utf8"), FILES["packages/net/retry.ts"]);
});

test("clause 22: each component keeps its own mirror of its own files", async (t) => {
  const { root, storage, write } = await project(t);
  const { runtime, control } = await stagedRuntime(storage);
  const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
  assert.equal((await searchRepositoryConcepts({ projectRoot: root, query: "retry" }, { runtime, waitMs: 2000 })).status, "ready");
  await write("packages/net/retry.ts", `${FILES["packages/net/retry.ts"]}// changed\n`);
  assert.equal((await searchRepositoryConcepts({ projectRoot: root, query: "retry" }, { runtime, waitMs: 2000 })).status, "ready");
  const last = control.builds.at(-1);
  assert.deepEqual([last.files, last.changedFiles, last.removedFiles], [["packages/net/retry.ts", "packages/net/timeout.ts"], ["packages/net/retry.ts"], []]);
  const net = (await runtime.location(root, { name: "net", identity: "root/net", folder: "packages/net" })).directory;
  assert.equal(last.mirror, path.join(net, "mirror"));
});
