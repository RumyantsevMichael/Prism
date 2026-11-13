import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FILES, entry, fakeRuntime, manifestPath, project, settled, workflow } from "./fixtures/component-indexes.mjs";

// Review findings of the component-index-preparation slice: searches beside a long build, a component that another session prepares,
// superseded jobs, the scan without Git, the declaration check of retained baselines, and background preparation with components.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-index-review-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { NativeSemanticRuntime, nativeSemanticRuntime } = await import("../../dist/server/repository-intelligence/native-semantic-runtime.mjs");
const provider = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { componentSources, indexComponents } = await import("../../dist/server/repository-intelligence/component-indexes.mjs");
const { resetBackgroundPreparation, startBackgroundPreparation, startIndexRebuild } = await import("../../dist/server/repository-intelligence/background-preparation.mjs");
const { conservationStore } = await import("../../dist/server/conservation/conservation-store.mjs");

const search = (root, runtime, input = {}, waitMs = 2000) => provider.searchRepositoryConcepts({ projectRoot: root, query: "retry the request", ...input }, { runtime, waitMs });
const NET = { name: "net", identity: "root/net", folder: "packages/net" };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const within = (promise, ms, what) => Promise.race([promise, delay(ms).then(() => { throw new Error(`${what} did not answer within ${ms} ms.`); })]);

// A helper worker that, like the native worker, answers one request at a time: a build of packages/app never ends, and a search takes one second.
const WORKER = `
import readline from "node:readline";
import { readFile } from "node:fs/promises";
import path from "node:path";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const build = async (args) => {
  if (args.files.some((file) => file.file.startsWith("packages/app/"))) await new Promise(() => {});
  const units = [], chunks = [], fileCoverage = {};
  for (const { file, hash } of args.files) {
    const content = await readFile(path.join(args.mirror, file), "utf8"), lines = content.split("\\n").length - 1, name = /export function (\\w+)/.exec(content)?.[1] ?? file;
    fileCoverage[file] = true;
    units.push({ id: "file:" + file, file, kind: "file", name: file, domain: "code", range: { startLine: 1, endLine: Math.max(1, lines) }, sourceHash: hash, rangeComplete: true });
    units.push({ id: "function:" + file, file, kind: "function", name, qualifiedName: name, selector: name, domain: "code", range: { startLine: 1, endLine: Math.max(1, lines) }, sourceHash: hash, rangeComplete: true });
  }
  return { schemaVersion: 1, chunkerVersion: "fake-chunker", modelIdentity: "fake-model", snapshot: args.snapshot, units, edges: [], unresolvedReferences: [], chunks, fileCoverage,
    syntaxCoverage: fileCoverage, diagnostics: [], counts: { files: args.files.length, units: units.length, fragments: 0, reusedEmbeddings: 0, newEmbeddings: 0 }, structureComplete: true, resources: {} };
};
const search = async (args) => {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const index = JSON.parse(await readFile(args.indexPath, "utf8"));
  return index.units.filter((unit) => unit.kind === "function").map((unit, position) => ({ ...unit, cosineSimilarity: 0.5, lexicalScore: 0, fusedScore: 0, fusedRank: position + 1, excerpt: "" }));
};
let pending = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  pending = pending.then(async () => {
    const request = JSON.parse(line);
    try { send({ id: request.id, result: request.method === "build" ? await build(request.args) : await search(request.args) }); }
    catch (error) { send({ id: request.id, error: { code: error.code || "preparation_failed", message: error.message } }); }
  });
});
`;

// A runtime whose helpers are real child processes running the serial worker above.
async function serialRuntime(t, directory, storage, options = {}) {
  const runtimeDirectory = path.join(directory, "helper-runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(path.join(runtimeDirectory, "worker.mjs"), WORKER);
  await symlink(process.execPath, path.join(runtimeDirectory, process.platform === "win32" ? "node.exe" : "node")).catch(() => {});
  const runtime = new NativeSemanticRuntime({ directory: storage, manifestPath, ...options });
  runtime.assets = async () => ({ runtime: runtimeDirectory, modelDirectory: "fake-model", modelIdentity: "fake-model", assetIdentity: "fake-assets" });
  t.after(() => runtime.close());
  return runtime;
}

test("CC-1: a search of a ready component answers while another component's build holds the build helper", { skip: process.platform === "win32" }, async (t) => {
  const { directory, root, storage } = await project(t);
  const runtime = await serialRuntime(t, directory, storage);
  assert.equal((await search(root, runtime, { filters: { paths: ["packages/net"] } }, 10000)).status, "ready");
  assert.equal(entry(await search(root, runtime, { filters: { paths: ["packages/app"] } }, 0), "root/app").status, "preparing");
  const started = Date.now();
  const found = await within(search(root, runtime, { filters: { paths: ["packages/net"] } }), 8000, "The search of packages/net");
  assert.equal(found.status, "ready");
  assert.deepEqual(found.results.map((result) => result.file).sort(), ["packages/net/retry.ts", "packages/net/timeout.ts"]);
  assert.ok(Date.now() - started < 8000);
  assert.equal(entry(await runtime.status(root), "root/app").status, "preparing");
});

test("CC-1: a build that stalls does not fail a concurrent search of another component", { skip: process.platform === "win32" }, async (t) => {
  const { directory, root, storage } = await project(t);
  const runtime = await serialRuntime(t, directory, storage, { stallMs: 2500 });
  assert.equal((await search(root, runtime, { filters: { paths: ["packages/net"] } }, 10000)).status, "ready");
  await search(root, runtime, { filters: { paths: ["packages/app"] } }, 0);
  // The search is still answering when the build of packages/app, which reports no progress, reaches its stall period.
  await delay(2000);
  const found = await search(root, runtime, { filters: { paths: ["packages/net"] } });
  assert.equal(found.status, "ready");
  assert.equal(found.results.length, 2);
  const status = await settled(runtime, root);
  assert.deepEqual([entry(status, "root/app").status, entry(status, "root/app").failure?.code, entry(status, "root/app").failure?.phase], ["degraded", "stalled", "snapshot-copy"]);
});

test("CC-3: a component that another session holds is reported preparing and does not hold the other components", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  const { directory } = await runtime.location(root, NET);
  await mkdir(path.dirname(directory), { recursive: true });
  // The parent process stands for a live session that holds the component's storage lock.
  await writeFile(`${directory}.lock`, JSON.stringify({ pid: process.ppid, token: "other-session", renewable: true, at: new Date().toISOString() }));
  const started = Date.now();
  const found = await search(root, runtime, {}, 3000);
  assert.ok(Date.now() - started < 10000);
  assert.equal(found.status, "partial");
  assert.deepEqual(found.components.map((item) => [item.component, item.status, item.failure]), [["root/root", "included", null], ["root/net", "preparing", null], ["root/app", "included", null]]);
  assert.deepEqual(control.builds.map((build) => build.files[0]), ["packages/app/client.ts", ".prism/workflow.md"]);
  assert.equal(entry(await runtime.status(root), "root/net").status, "preparing");
  // Once the other session releases the lock, the component is prepared here.
  await rm(`${directory}.lock`);
  await settled(runtime, root);
  assert.equal((await search(root, runtime)).status, "ready");
});

test("a waiting job for content that changed is dropped and writes no failure after the newer index", async (t) => {
  // app is declared first, so its held build keeps net waiting behind it.
  const { root, storage, write } = await project(t, { components: ["## Components", "- app: packages/app", "- net: packages/net", ""].join("\n") });
  const { runtime, control } = await fakeRuntime(storage);
  control.hold("packages/app/client.ts");
  await search(root, runtime, {}, 0);
  await write("packages/net/retry.ts", `${FILES["packages/net/retry.ts"]}// changed\n`);
  const newer = await search(root, runtime, { filters: { paths: ["packages/net"] } }, 0);
  control.release("packages/app/client.ts");
  await settled(runtime, root);
  // net has no index at all, so the newer call pauses the app build it does not need, and net waits or already prepares.
  assert.ok(["waiting", "preparing"].includes(entry(newer, "root/net").status));
  assert.deepEqual(control.builds.map((build) => build.files[0]), ["packages/app/client.ts", "packages/net/retry.ts", ".prism/workflow.md"]);
  const { directory } = await runtime.location(root, NET);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("progress-")), []);
  assert.equal(entry(await runtime.status(root), "root/net").status, "ready");
  assert.equal((await search(root, runtime, { filters: { paths: ["packages/net"] } })).status, "ready");
});

test("CC-4: a component whose lock is held and renewed is tried again without checking its assets again", async (t) => {
  const { root, storage } = await project(t);
  const { runtime } = await fakeRuntime(storage);
  const { directory } = await runtime.location(root, NET);
  await mkdir(path.dirname(directory), { recursive: true });
  await writeFile(`${directory}.lock`, JSON.stringify({ pid: process.ppid, token: "other-session", renewable: true, at: new Date().toISOString() }));
  const checks = [], attempts = [], assets = runtime.assets.bind(runtime), build = runtime.build.bind(runtime);
  let retried;
  const retry = new Promise((resolve) => { retried = resolve; });
  runtime.assets = (...args) => { checks.push(1); return assets(...args); };
  runtime.build = (source, snapshot, location, job) => {
    if (location.directory === directory && attempts.push(job.id) === 2) retried();
    return build(source, snapshot, location, job);
  };
  await search(root, runtime, { filters: { paths: ["packages/net"] } }, 0);
  // The retry waits for the first attempt's progress record, whose writes a loaded machine can slow, so the test waits for the attempt itself.
  await within(retry, 30000, "The second attempt of the held component");
  assert.equal(new Set(attempts).size, 1);
  assert.equal(checks.length, 1);
  assert.equal(entry(await runtime.status(root), "root/net").status, "preparing");
  await rm(`${directory}.lock`);
  await settled(runtime, root);
  assert.equal(entry(await runtime.status(root), "root/net").status, "ready");
});

test("CC-4: a component whose lock names a live process but is no longer renewed fails with a lock diagnostic", async (t) => {
  const { root, storage } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  const { directory } = await runtime.location(root, NET);
  await mkdir(path.dirname(directory), { recursive: true });
  // This process's own id stands for a process id reused after a restart; the lock has not been renewed for ten minutes.
  await writeFile(`${directory}.lock`, JSON.stringify({ pid: process.pid, token: "crashed", renewable: true, at: new Date(Date.now() - 600000).toISOString() }));
  const old = new Date(Date.now() - 600000);
  await utimes(`${directory}.lock`, old, old);
  const found = await search(root, runtime, {}, 3000);
  assert.equal(found.status, "partial");
  assert.deepEqual(found.components.map((item) => [item.component, item.status, item.failure?.code ?? null]), [["root/root", "included", null], ["root/net", "failed", "lock_timeout"], ["root/app", "included", null]]);
  assert.deepEqual(control.builds.map((build) => build.files[0]), ["packages/app/client.ts", ".prism/workflow.md"]);
  const status = await runtime.status(root);
  assert.equal(status.status, "degraded");
  assert.equal(entry(status, "root/net").status, "degraded");
  const [diagnostic] = status.diagnostics.filter((item) => item.component === "root/net");
  assert.equal(diagnostic.code, "lock_timeout");
  assert.match(diagnostic.message, /not been renewed/);
  assert.ok(diagnostic.recovery.includes(`${directory}.lock`));
  // The lock is reported, never removed, because the process it names is running.
  await access(`${directory}.lock`);
});

test("CC-5: a running job that a newer read replaced is dropped when it finds the lock held, and leaves no failure after the newer index", async (t) => {
  const { root, storage, write } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  const { directory } = await runtime.location(root, NET);
  await mkdir(path.dirname(directory), { recursive: true });
  await writeFile(`${directory}.lock`, JSON.stringify({ pid: process.ppid, token: "other-session", renewable: true, at: new Date().toISOString() }));
  let first, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const build = runtime.build.bind(runtime);
  // The first job waits, as for its asset check, until a newer read replaces it; the other session releases the lock as the newer job starts.
  runtime.build = async (source, snapshot, location, job) => {
    first ??= job;
    if (job === first) await gate; else await rm(`${directory}.lock`, { force: true });
    return build(source, snapshot, location, job);
  };
  const paths = { filters: { paths: ["packages/net"] } };
  await search(root, runtime, paths, 0);
  assert.equal(runtime.running, first);
  await write("packages/net/retry.ts", `${FILES["packages/net/retry.ts"]}// changed\n`);
  await search(root, runtime, paths, 0);
  release();
  await settled(runtime, root);
  assert.equal(first.status, "degraded");
  assert.equal(first.failure.code, "stale_snapshot");
  assert.equal(control.builds.length, 1);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("progress-")), []);
  assert.equal(entry(await runtime.status(root), "root/net").status, "ready");
  assert.equal((await search(root, runtime, paths)).status, "ready");
});

test("a running job that a newer read replaced with a stored index leaves no failure when its build ends on the changed source", async (t) => {
  const { root, storage, write } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  const paths = { filters: { paths: ["packages/net"] } };
  assert.equal((await search(root, runtime, paths)).status, "ready");
  // The source changes, and changes back while the build of the changed content runs, so the newer read reuses the stored index.
  control.hold("packages/net/retry.ts");
  await write("packages/net/retry.ts", `${FILES["packages/net/retry.ts"]}// changed\n`);
  await search(root, runtime, paths, 0);
  await control.reached("packages/net/retry.ts");
  const replaced = runtime.running;
  await write("packages/net/retry.ts", FILES["packages/net/retry.ts"]);
  assert.equal((await search(root, runtime, paths, 0)).status, "ready");
  control.release("packages/net/retry.ts");
  await replaced.promise;
  await settled(runtime, root);
  assert.equal(replaced.failure.code, "stale_snapshot");
  const { directory } = await runtime.location(root, NET);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("progress-")), []);
  assert.equal(entry(await runtime.status(root), "root/net").status, "ready");
});

// A project without Git, so its files come from the bounded filesystem scan.
async function filesystemProject(t, rootFiles) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-component-nogit-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "packages", "net"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), workflow({ components: ["## Components", "- net: packages/net", ""].join("\n") }));
  await writeFile(path.join(root, "packages", "net", "retry.ts"), FILES["packages/net/retry.ts"]);
  for (let start = 0; start < rootFiles; start += 500) {
    await Promise.all(Array.from({ length: Math.min(500, rootFiles - start) }, (_, index) => writeFile(path.join(root, "docs", `note-${String(start + index).padStart(5, "0")}.md`), "# Note\n")));
  }
  return root;
}

test("C1: without Git, the file limit counts only a component's own files", async (t) => {
  const root = await filesystemProject(t, 20000);
  const storage = await mkdtemp(path.join(os.tmpdir(), "prism-component-nogit-storage-"));
  t.after(() => rm(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const { runtime, control } = await fakeRuntime(storage);
  const found = await search(root, runtime, { filters: { paths: ["packages/net"] } });
  assert.deepEqual(found.components.map((item) => [item.component, item.status]), [["root/net", "included"]]);
  assert.deepEqual(control.builds.map((build) => build.files), [["packages/net/retry.ts"]]);
});

test("C1: without Git, a root component file never changes another component's content", async (t) => {
  const root = await filesystemProject(t, 3);
  const fingerprints = async () => Promise.all(componentSources(root, await indexComponents(root), { maxFiles: 3 }).map(async (item) => {
    const snapshot = await item.source.snapshot();
    return { component: item.component, fingerprint: snapshot.sourceFingerprint, files: snapshot.files.map((file) => file.file), complete: snapshot.complete };
  }));
  const before = await fingerprints();
  await writeFile(path.join(root, "docs", "added.md"), "# Added\n");
  const after = await fingerprints();
  assert.deepEqual(after[1], before[1]);
  assert.deepEqual(after[1].files, ["packages/net/retry.ts"]);
  assert.equal(after[1].complete, true);
  // The root component holds the workflow and the notes, so its limit of three files truncates only its own scan.
  assert.equal(after[0].files.length, 3);
  assert.equal(after[0].complete, false);
});

test("C2: the structural reports refuse an invalid declaration for a retained baseline before any build", async (t) => {
  const { root, storage, configure } = await project(t);
  const { runtime, control } = await fakeRuntime(storage);
  const { snapshotId } = await conservationStore.capture(root);
  await configure({ components: ["## Components", "- net: packages/net", "- net: packages/app", ""].join("\n") });
  for (const report of ["findSharedDependencies", "reportModuleInterfaces", "findSharedLiterals", "reportCohesionClusters", "findSameNameUnits", "reportComplexUnits"]) {
    await assert.rejects(provider[report]({ projectRoot: root, snapshotId }, { runtime }), { code: "component_invalid" }, report);
  }
  await assert.rejects(search(root, runtime, { snapshotId }), { code: "component_invalid" });
  assert.deepEqual(control.builds, []);
});

test("CC-2: background preparation and rebuild queue no whole-repository build in a repository with components", async (t) => {
  const available = async () => true;
  const { root } = await project(t);
  resetBackgroundPreparation();
  await startBackgroundPreparation(root, { available });
  await startIndexRebuild(root, { available });
  const whole = (await nativeSemanticRuntime.location(root)).directory;
  assert.equal(nativeSemanticRuntime.jobs.has(whole), false);
  assert.equal(nativeSemanticRuntime.queue.length, 0);
  // A repository without components still prepares its one index in the background.
  const plain = await project(t, { components: null });
  resetBackgroundPreparation();
  await startBackgroundPreparation(plain.root, { available });
  assert.equal(nativeSemanticRuntime.jobs.has((await nativeSemanticRuntime.location(plain.root)).directory), true);
  resetBackgroundPreparation();
});
