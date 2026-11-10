import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// macOS and Windows file systems ignore letter case by default, which a Linux host stands in for with a preload that finds every name below one folder in any letter case.
const PRELOAD = new URL("./fixtures/case-insensitive-store.mjs", import.meta.url).href;
const SYNC = new URL("../../dist/server/workflow/record-store-sync.mjs", import.meta.url).href;
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-case-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment,
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
test.after(() => rm(environment, { recursive: true, force: true }));

const git = (cwd, args, input) => execFileSync("git", ["-C", cwd, ...args], { input, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const exists = (target) => access(target).then(() => true, () => false);

async function stores(context, files) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-case-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  git(parent, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  git(parent, ["clone", "-q", "remote.git", "a"]);
  const storeA = path.join(parent, "a");
  git(storeA, ["checkout", "-q", "-b", "main"]);
  for (const [file, contents] of Object.entries({ "artifacts/plans/slice.md": "# Slice\n", "roadmap.json": "{}\n", ...files })) {
    await mkdir(path.dirname(path.join(storeA, file)), { recursive: true });
    await writeFile(path.join(storeA, file), contents);
  }
  git(storeA, ["add", "."]);
  git(storeA, ["commit", "-q", "-m", "init"]);
  git(storeA, ["push", "-q", "-u", "origin", "main"]);
  git(parent, ["clone", "-q", "remote.git", "b"]);
  return { remote: path.join(parent, "remote.git"), storeA, storeB: path.join(parent, "b") };
}

// Sync a store in a process whose file calls below the store ignore letter case, and return its status.
function syncIgnoringCase(store) {
  const marker = path.join(path.dirname(store), "case-insensitive.loaded");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const sync = await import(${JSON.stringify(SYNC)}); sync.configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 }); process.stdout.write(JSON.stringify(await sync.syncRecordStoreNow(${JSON.stringify(store)})));`], {
    env: { ...process.env, NODE_OPTIONS: `--import=${PRELOAD}`, PRISM_TEST_CASE_INSENSITIVE: store, PRISM_TEST_CASE_INSENSITIVE_MARKER: marker },
    encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

const listing = (folder) => readdir(folder, { recursive: true }).then((names) => names.sort());

for (const [label, local, upstream, kept] of [
  ["record", { "initiatives/Reports/state.json": "{\"v\":\"b\"}\n" }, { "initiatives/reports/state.json": "{\"v\":\"a\"}\n" }, ["reports", "reports/state.json"]]
]) {
  test(`on a file system that ignores letter case, a ${label} that both machines wrote in two letter cases keeps the upstream's and saves the local one`, async (context) => {
    const { remote, storeA, storeB } = await stores(context);
    for (const [file, contents] of Object.entries(local)) {
      await mkdir(path.dirname(path.join(storeB, file)), { recursive: true });
      await writeFile(path.join(storeB, file), contents);
    }
    for (const [file, contents] of Object.entries(upstream)) {
      await mkdir(path.dirname(path.join(storeA, file)), { recursive: true });
      await writeFile(path.join(storeA, file), contents);
    }
    git(storeA, ["add", "."]);
    git(storeA, ["commit", "-q", "-m", "a's file"]);
    git(storeA, ["push", "-q", "origin", "main"]);
    const status = syncIgnoringCase(storeB);
    assert.ok(await exists(path.join(path.dirname(storeB), "case-insensitive.loaded")), "the sync ran with letter case ignored");
    assert.equal(status.state, "conflicts", JSON.stringify(status));
    const [file, contents] = Object.entries(local)[0];
    assert.deepEqual(status.conflicts.map((conflict) => conflict.path), [file]);
    assert.equal(await readFile(path.join(storeB, status.conflicts[0].savedAs), "utf8"), contents, "the local file is saved");
    assert.deepEqual(await listing(path.join(storeB, "initiatives")), kept, "the store holds the upstream's spelling only");
    assert.equal(git(storeB, ["rev-list", "--left-right", "--count", "HEAD...origin/main"]), "0\t0");
    assert.equal(syncIgnoringCase(storeB).state, "ok");
    assert.equal(git(remote, ["ls-tree", "-r", "--name-only", "main"]), git(storeA, ["ls-tree", "-r", "--name-only", "HEAD"]), "nothing of the local spelling reaches the remote");
  });
}

for (const [label, from, to] of [["folder", "initiatives/Reports", "initiatives/reports"]]) {
  test(`on a file system that ignores letter case, a sync takes another machine's change of a ${label}'s letter case and keeps that spelling`, async (context) => {
    const files = { [`${from}/state.json`]: "{\"v\":1}\n", [`${from}/initiative.json`]: "{}\n" };
    const { storeA, storeB } = await stores(context, files);
    // On a file system that ignores letter case, git mv can refuse a move to another spelling of the same name, as macOS does for a folder, so the change goes through a temporary name.
    git(storeA, ["mv", from, `${to}.renaming`]);
    git(storeA, ["mv", `${to}.renaming`, to]);
    git(storeA, ["commit", "-q", "-m", "rename"]);
    git(storeA, ["push", "-q", "origin", "main"]);
    // A file the store does not share keeps the old folder alive, so the sync gives the folder its new spelling instead of writing into the old one.
    await writeFile(path.join(storeB, from, ".keep"), "");
    await writeFile(path.join(storeB, "roadmap.json"), "{\"b\":true}\n");
    const status = syncIgnoringCase(storeB);
    assert.equal(status.state, "ok", JSON.stringify(status));
    const names = await readdir(path.join(storeB, "initiatives"));
    assert.ok(names.includes(path.basename(to)) && !names.includes(path.basename(from)), names.join(", "));
    assert.deepEqual(await listing(path.join(storeB, to)), [".keep", "initiative.json", "state.json"], "the folder kept its other file");
    assert.equal(git(storeB, ["rev-list", "--left-right", "--count", "HEAD...origin/main"]), "0\t0");
    assert.equal(git(storeB, ["show", "origin/main:roadmap.json"]), "{\"b\":true}", "the machine's own change is pushed");
    assert.equal(syncIgnoringCase(storeB).state, "ok");
    assert.equal(git(storeB, ["rev-list", "--count", "HEAD"]), git(storeB, ["rev-list", "--count", "origin/main"]), "a later sync commits no change of spelling back");
    assert.equal(git(storeB, ["ls-tree", "-r", "--name-only", "HEAD", "--", from]), "", "the old spelling stays gone");
  });
}

// The slice's sync suites run again with letter case ignored below the folder that holds every store they make, so each of their merges also holds on macOS and Windows.
const SUITES = [
  "record-store-sync.test.mjs",
  "record-store-sync-paths.test.mjs",
  "record-store-sync-raw-files.test.mjs",
  "record-store-sync-crash.test.mjs"
];

// The emulation hooks POSIX folders below TMPDIR; NTFS ignores letter case itself, so on Windows the suites already run that way directly.
const NATIVE = process.platform === "win32" && "Windows file systems ignore letter case themselves, and the store sync suites run on them directly";
test("the store sync suites pass on a file system that ignores letter case", { timeout: 900000, skip: NATIVE }, async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-case-suites-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "case-insensitive.loaded");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const { NODE_TEST_CONTEXT: _, ...inherited } = process.env;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...SUITES.map((suite) => path.join(here, suite))], {
      env: { ...inherited, TMPDIR: root, NODE_OPTIONS: `--import=${PRELOAD}`, PRISM_TEST_CASE_INSENSITIVE: root, PRISM_TEST_CASE_INSENSITIVE_MARKER: marker },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { text += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, text }));
  });
  assert.ok(await exists(marker), "the suites ran with letter case ignored");
  const failed = output.text.split("\n").filter((line) => /^\s*not ok /.test(line));
  assert.equal(output.code, 0, failed.join("\n") || output.text.slice(-4000));
});
