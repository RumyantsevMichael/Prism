import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Git runs with a private home and configuration, a fixed identity, local repositories only, and no proxy; the app folder and plugin data directory are private too.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-remote-env-")));
const data = path.join(environment, "data");
const appFolder = path.join(environment, "app");
const gitconfig = path.join(environment, "gitconfig");
await mkdir(data);
await writeFile(gitconfig, "");
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "CLAUDE_PLUGIN_DATA"]) delete process.env[name];
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: data, PRISM_REVIEW_APP_DIR: appFolder,
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
const RECORD_STORE = new URL("../../dist/server/workflow/record-store.mjs", import.meta.url).href;
const { cancelRecordSyncs, configureRecordSync, readSyncStatus, syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");
const { forgetMigrations, listInitiatives, readRecord, recordStoreOf, recordSyncStatus, writeRecord } = await import(RECORD_STORE);
const { parseWorkflowConfig } = await import("../../dist/server/workflow/workflow-config.mjs");
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
const { startReviewApp } = await import("../../dist/server/review/review-app-server.mjs");
const { createReviewAppClient } = await import("../../dist/server/review/review-app-client.mjs");
// Syncs run only when a test calls them, so each test controls its own ordering.
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const exists = (target) => access(target).then(() => true, () => false);
const remoteConfig = (store, sync) => `## Paths\n- Plans (scratch): docs/plans/\n\n## Workspace\n- Store: ${store}\n${sync === undefined ? "" : `- Store sync: ${sync}\n`}`;
const create = (projectRoot, slug = "reports") => updateInitiative({ projectRoot, initiative: slug, expectedRevision: null, operations: [{ op: "create", slug, title: "Reports", requirements: ["r.md#1"] }] });
// The clone path the contract defines, computed independently of Prism: SHA-256 of the normalized remote, first 16 hex characters, under the app folder.
const cloneId = (normalized) => createHash("sha256").update(normalized).digest("hex").slice(0, 16);
const clonePath = (normalized) => path.join(appFolder, "stores", cloneId(normalized));
const leftovers = async (target) => (await readdir(path.dirname(target)).catch(() => [])).filter((name) => name.startsWith(`.${path.basename(target)}.`));

async function folder(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-remote-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  forgetMigrations();
  return parent;
}

async function project(parent, name, config) {
  const root = path.join(parent, name);
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), config);
  return root;
}

// A bare remote reached through a file:// URL, seeded with one commit on main unless it should stay empty.
function bareRemote(parent, name = "remote.git", { empty = false } = {}) {
  git(parent, "init", "-q", "--bare", "-b", "main", name);
  const remote = path.join(parent, name);
  if (!empty) {
    const seed = path.join(parent, `${name}-seed`);
    git(parent, "clone", "-q", remote, seed);
    git(seed, "checkout", "-q", "-b", "main");
    execFileSync("sh", ["-c", "printf 'Prism records\\n' > README.md"], { cwd: seed });
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "init");
    git(seed, "push", "-q", "-u", "origin", "main");
  }
  const url = pathToFileURL(remote).href;
  return { remote, url, clone: clonePath(url.replace(/\.git$/, "")) };
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }).once("error", reject);
  });
}

function childListing(root) {
  const script = `const { listInitiatives } = await import(${JSON.stringify(RECORD_STORE)}); process.stdout.write(JSON.stringify(await listInitiatives(${JSON.stringify(root)})));`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], { env: process.env }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout)));
  });
}

test("two project roots that name the same remote share one managed clone", async (context) => {
  const parent = await folder(context);
  const { url, clone } = bareRemote(parent);
  const a = await project(parent, "project-a", remoteConfig(url));
  const b = await project(parent, "project-b", remoteConfig(url));
  const created = await create(a);
  assert.deepEqual(await listInitiatives(b), ["reports"]);
  assert.equal((await getInitiative({ projectRoot: b, initiative: "reports" })).revision, created.revision);
  assert.equal((await recordStoreOf(a)).base, clone);
  assert.equal((await recordStoreOf(b)).base, clone);
  assert.equal(await exists(path.join(clone, "initiatives/reports/initiative.json")), true);
  assert.deepEqual(await readdir(path.join(a, ".prism")), ["workflow.md"]);
});

test("the first access clones the remote and a second process reuses the clone without cloning again", async (context) => {
  const parent = await folder(context);
  const { remote, url, clone } = bareRemote(parent);
  const a = await project(parent, "project-a", remoteConfig(url, "off"));
  const b = await project(parent, "project-b", remoteConfig(url, "off"));
  assert.equal(await exists(clone), false);
  await create(a);
  assert.equal(git(clone, "config", "--get", "remote.origin.url"), url);
  assert.equal(await exists(path.join(clone, "README.md")), true, "the clone holds the remote's files");
  // With the remote gone, only a reused clone can answer.
  await rename(remote, `${remote}.away`);
  assert.deepEqual(await childListing(b), ["reports"]);
  assert.deepEqual(await leftovers(clone), []);
});

test("spellings of one remote resolve to the same clone", async (context) => {
  const parent = await folder(context);
  const { url, clone } = bareRemote(parent);
  const roots = [];
  for (const [index, spelling] of [url, `${url}/`, url.replace(/\.git$/, ""), url.replace(/\.git$/, "/")].entries()) roots.push(await project(parent, `project-${index}`, remoteConfig(spelling)));
  for (const root of roots) assert.equal((await recordStoreOf(root)).base, clone);
});

test("a remote store needs no plugin data directory, so a host that gives none still clones it", async (context) => {
  const parent = await folder(context);
  const { url, clone } = bareRemote(parent);
  const root = await project(parent, "project", remoteConfig(url));
  const before = await readdir(data);
  delete process.env.PLUGIN_DATA;
  try {
    assert.deepEqual(await listInitiatives(root), []);
  } finally {
    process.env.PLUGIN_DATA = data;
  }
  assert.equal(await exists(path.join(clone, "README.md")), true);
  assert.deepEqual(await readdir(data), before);
});

test("a clone Prism 0.16 kept under plugin data moves to the app folder with its unpushed commit", async (context) => {
  const parent = await folder(context);
  const { url, clone } = bareRemote(parent);
  const legacy = path.join(data, "stores", path.basename(clone));
  await mkdir(path.dirname(legacy), { recursive: true });
  git(parent, "clone", "-q", url, legacy);
  await writeFile(path.join(legacy, "local.txt"), "not pushed\n");
  git(legacy, "add", ".");
  git(legacy, "commit", "-q", "-m", "local");
  const head = git(legacy, "rev-parse", "HEAD");
  const root = await project(parent, "project", remoteConfig(url));
  assert.deepEqual(await listInitiatives(root), []);
  assert.equal(await exists(legacy), false);
  assert.equal(git(clone, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(path.join(clone, "local.txt"), "utf8"), "not pushed\n");
});

test("a folder under plugin data with another origin is not moved", async (context) => {
  const parent = await folder(context);
  const { url, clone } = bareRemote(parent);
  const legacy = path.join(data, "stores", path.basename(clone));
  await mkdir(legacy, { recursive: true });
  git(legacy, "init", "-q");
  git(legacy, "remote", "add", "origin", pathToFileURL(path.join(parent, "other.git")).href);
  context.after(() => rm(legacy, { recursive: true, force: true }));
  const root = await project(parent, "project", remoteConfig(url));
  assert.deepEqual(await listInitiatives(root), []);
  assert.equal(await exists(path.join(legacy, ".git")), true);
  assert.equal(await exists(path.join(clone, "README.md")), true);
});

test("a managed clone keeps long paths usable on Windows", async (context) => {
  const parent = await folder(context);
  const { url, clone } = bareRemote(parent);
  const root = await project(parent, "project", remoteConfig(url));
  await listInitiatives(root);
  assert.equal(git(clone, "config", "--local", "--get", "core.longpaths"), "true");
});

test("an unreachable remote is unavailable, leaves no folder, and a later access succeeds once the remote exists", async (context) => {
  const parent = await folder(context);
  const url = pathToFileURL(path.join(parent, "late.git")).href;
  const clone = clonePath(url.replace(/\.git$/, ""));
  const root = await project(parent, "project", remoteConfig(url));
  await assert.rejects(listInitiatives(root), (error) => error.code === "store_unavailable" && error.message.includes(url) && /Git could not clone it/.test(error.message));
  assert.equal(await exists(clone), false);
  assert.deepEqual(await leftovers(clone), []);
  bareRemote(parent, "late.git");
  assert.deepEqual(await listInitiatives(root), []);
  assert.equal(await exists(path.join(clone, "README.md")), true);
});

test("a folder at the clone path with another origin is unavailable and left untouched", async (context) => {
  const parent = await folder(context);
  const { url, clone } = bareRemote(parent);
  await mkdir(clone, { recursive: true });
  git(clone, "init", "-q");
  git(clone, "remote", "add", "origin", pathToFileURL(path.join(parent, "other.git")).href);
  await writeFile(path.join(clone, "keep.txt"), "mine\n");
  const config = await readFile(path.join(clone, ".git/config"), "utf8");
  const root = await project(parent, "project", remoteConfig(url));
  await assert.rejects(create(root), (error) => error.code === "store_unavailable" && /other\.git/.test(error.message) && /never changes or deletes/.test(error.message));
  assert.deepEqual((await readdir(clone)).sort(), [".git", "keep.txt"]);
  assert.equal(await readFile(path.join(clone, ".git/config"), "utf8"), config);
  assert.equal(await readFile(path.join(clone, "keep.txt"), "utf8"), "mine\n");
  await rm(clone, { recursive: true, force: true });
});

test("an empty remote clones to an empty store whose first write and sync push the branch", async (context) => {
  const parent = await folder(context);
  const { remote, url, clone } = bareRemote(parent, "empty.git", { empty: true });
  const root = await project(parent, "project", remoteConfig(url));
  assert.deepEqual(await listInitiatives(root), []);
  await create(root);
  const first = await syncRecordStore(clone);
  assert.equal(first.state, "ok", first.message);
  assert.equal((await readSyncStatus(clone)).state, "ok");
  const branch = git(clone, "symbolic-ref", "--short", "HEAD");
  assert.equal(git(clone, "rev-parse", "--abbrev-ref", "@{upstream}"), `origin/${branch}`);
  assert.equal(git(remote, "rev-parse", branch), git(clone, "rev-parse", "HEAD"));
  assert.match(git(remote, "ls-tree", "-r", "--name-only", branch), /initiatives\/reports\/initiative\.json/);
  await writeRecord(root, { kind: "state", initiative: "reports" }, "{}\n");
  assert.equal((await syncRecordStore(clone)).state, "ok", "a later sync uses the upstream the first one set");
  assert.equal(git(remote, "rev-parse", branch), git(clone, "rev-parse", "HEAD"));
  // An older Git clones an empty remote without tracking configuration, so the first sync pushes the branch with its upstream set.
  const older = bareRemote(parent, "older.git", { empty: true });
  const other = await project(parent, "project-older", remoteConfig(older.url));
  assert.deepEqual(await listInitiatives(other), []);
  const olderBranch = git(older.clone, "symbolic-ref", "--short", "HEAD");
  git(older.clone, "config", "--unset", `branch.${olderBranch}.remote`);
  git(older.clone, "config", "--unset", `branch.${olderBranch}.merge`);
  await create(other);
  const published = await syncRecordStore(older.clone);
  assert.equal(published.state, "ok", published.message);
  assert.equal(git(older.clone, "rev-parse", "--abbrev-ref", "@{upstream}"), `origin/${olderBranch}`);
  assert.equal(git(older.remote, "rev-parse", olderBranch), git(older.clone, "rev-parse", "HEAD"));
});

test("a path store without an upstream still reports no_upstream", async (context) => {
  const parent = await folder(context);
  const store = path.join(parent, "store");
  await mkdir(store);
  git(store, "init", "-q", "-b", "main");
  const root = await project(parent, "project", "## Paths\n- Plans (scratch): docs/plans/\n\n## Workspace\n- Store: ../store\n- Store sync: on\n");
  await create(root);
  assert.equal((await syncRecordStore(store)).state, "no_upstream");
});

test("a remote store syncs by default and Store sync off never commits", async (context) => {
  for (const value of [undefined, "", "n/a", "on", "yes"]) assert.equal(parseWorkflowConfig(remoteConfig("git@example.invalid:team/store.git", value)).workspace.sync, true, `Store sync ${value}`);
  assert.equal(parseWorkflowConfig(remoteConfig("git@example.invalid:team/store.git", "off")).workspace.sync, false);
  assert.equal(parseWorkflowConfig(remoteConfig("../store")).workspace.sync, false, "a path store still syncs only when on");
  const parent = await folder(context);
  const synced = bareRemote(parent, "synced.git");
  const on = await project(parent, "project-on", remoteConfig(synced.url));
  assert.equal((await recordStoreOf(on)).sync, true);
  await create(on);
  assert.equal((await syncRecordStore(synced.clone)).state, "ok");
  assert.match(git(synced.remote, "ls-tree", "-r", "--name-only", "main"), /initiatives\/reports\/initiative\.json/);
  const quiet = bareRemote(parent, "quiet.git");
  const off = await project(parent, "project-off", remoteConfig(quiet.url, "off"));
  assert.equal((await recordStoreOf(off)).sync, false);
  const head = git(quiet.clone, "rev-parse", "HEAD");
  await create(off);
  await writeRecord(off, { kind: "state", initiative: "reports" }, "{}\n");
  assert.equal(git(quiet.clone, "rev-parse", "HEAD"), head);
  assert.equal(await recordSyncStatus(off), null);
  assert.equal(await exists(path.join(quiet.clone, ".prism-sync")), false);
  assert.equal(git(quiet.remote, "rev-parse", "main"), head);
});

test("a remote with user information never puts it in a message, status, or record", async (context) => {
  const parent = await folder(context);
  const unreachable = "http://user:token@127.0.0.1:9/team/store.git";
  const failing = await project(parent, "project-failing", remoteConfig(unreachable));
  await assert.rejects(listInitiatives(failing), (error) => {
    assert.equal(error.code, "store_unavailable");
    assert.doesNotMatch(`${error.message}\n${JSON.stringify(error)}`, /user:token|token@/);
    assert.match(error.message, /http:\/\/127\.0\.0\.1:9\/team\/store\.git/);
    return true;
  });
  // Git rewrites the credential-bearing URL to a local remote, so clone, fetch, and push succeed while the configured remote carries user:token.
  const { remote } = bareRemote(parent, "secret.git");
  const secret = "https://user:token@example.invalid/team/store.git";
  await writeFile(gitconfig, `[url "${pathToFileURL(remote).href}"]\n\tinsteadOf = ${secret}\n`);
  context.after(() => writeFile(gitconfig, ""));
  const root = await project(parent, "project", remoteConfig(secret));
  const clone = clonePath("https://example.invalid/team/store");
  const created = await create(root);
  assert.equal((await recordStoreOf(root)).base, clone);
  assert.equal((await syncRecordStore(clone)).state, "ok");
  await rename(remote, `${remote}.away`);
  const failed = await syncRecordStore(clone);
  assert.notEqual(failed.state, "ok");
  const seen = [JSON.stringify(created), JSON.stringify(failed), await readFile(path.join(clone, ".prism-sync/status.json"), "utf8"), (await readRecord(root, { kind: "initiative", initiative: "reports" })).bytes.toString("utf8")];
  for (const text of seen) assert.doesNotMatch(text, /user:token/);
});

test("the review server and the review app list and serve records of a remote store", async (context) => {
  const parent = await folder(context);
  const { remote, url, clone } = bareRemote(parent);
  const root = await realpath(await project(parent, "project", remoteConfig(url)));
  await create(root);
  await writeRecord(root, { kind: "state", initiative: "reports" }, "{\"note\":\"from the remote store\"}\n");
  const served = async (base) => {
    const index = JSON.parse((await fetchText(new URL("api/index", base))).body);
    assert.equal(index.artifacts.includes(".prism/initiatives/reports/state.json"), true);
    const artifact = await fetchText(new URL(`api/artifact?path=${encodeURIComponent(".prism/initiatives/reports/state.json")}`, base));
    assert.equal(artifact.status, 200);
    assert.match(JSON.parse(artifact.body).content, /from the remote store/);
  };
  const review = await startReviewServer({ projectRoot: root, openBrowser: () => true });
  try {
    await served(`${review.baseUrl}/`);
  } finally {
    await review.close();
  }
  // The app was started by another host, so its own plugin data directory holds no clone and the remote is gone; only the reported clone folder can answer.
  await rename(remote, `${remote}.away`);
  const directory = path.join(parent, "app-state", "prism");
  process.env.PLUGIN_DATA = path.join(parent, "other-host");
  let app = null;
  try {
    const client = createReviewAppClient({ directory, recordStoreDirectory: path.dirname(clone), launch: () => { startReviewApp({ directory }).then((started) => { app = started; }); return null; } });
    try {
      const { url: page } = await client.register(root);
      await served(page);
    } finally {
      await client.close();
    }
  } finally {
    process.env.PLUGIN_DATA = data;
    await app?.close();
  }
  assert.equal(await exists(path.join(parent, "other-host")), false);
});
