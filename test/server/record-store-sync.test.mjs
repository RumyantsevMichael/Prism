import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Git runs with a private home and configuration, a fixed identity, and only local repositories.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment,
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
delete process.env.CLAUDE_PLUGIN_DATA;
const { cancelRecordSyncs, configureRecordSync, readSyncStatus, syncRecordStore } = await import("../../dist/server/workflow/record-store-sync.mjs");
const { forgetMigrations, listInitiatives, readRecord, writeRecord } = await import("../../dist/server/workflow/record-store.mjs");
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
// Syncs run only when a test calls them, so each test controls its own ordering.
configureRecordSync({ debounceMs: 3600000, pullIntervalMs: 1e15 });
test.after(async () => { cancelRecordSyncs(); await rm(environment, { recursive: true, force: true }); });

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const exists = (target) => access(target).then(() => true, () => false);
const syncConfig = (store, sync = "on") => `## Paths\n- Plans (scratch): docs/plans/\n\n## Workspace\n- Store: ../${store}\n- Store sync: ${sync}\n`;

async function folder(context) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-")));
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

// Two machines: each has a project whose synced store is a clone of one bare remote.
async function machines(context) {
  const parent = await folder(context);
  git(parent, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(parent, "clone", "-q", "remote.git", "store-a");
  const storeA = path.join(parent, "store-a");
  git(storeA, "checkout", "-q", "-b", "main");
  await writeFile(path.join(storeA, "README.md"), "Prism records\n");
  git(storeA, "add", ".");
  git(storeA, "commit", "-q", "-m", "init");
  git(storeA, "push", "-q", "-u", "origin", "main");
  git(parent, "clone", "-q", "remote.git", "store-b");
  return {
    parent, storeA, storeB: path.join(parent, "store-b"), remote: path.join(parent, "remote.git"),
    a: await project(parent, "project-a", syncConfig("store-a")), b: await project(parent, "project-b", syncConfig("store-b"))
  };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    }).once("error", reject);
  });
}

const STATE = { kind: "state", initiative: "reports" };

test("shares an initiative created on one machine with another through the remote", async (context) => {
  const { a, b, storeA, storeB } = await machines(context);
  const created = await updateInitiative({ projectRoot: a, initiative: "reports", expectedRevision: null, operations: [{ op: "create", slug: "reports", title: "Reports", requirements: ["r.md#1"] }] });
  assert.equal((await syncRecordStore(storeA)).state, "ok");
  assert.equal((await syncRecordStore(storeB)).state, "ok");
  assert.deepEqual(await listInitiatives(b), ["reports"]);
  assert.equal((await getInitiative({ projectRoot: b, initiative: "reports" })).revision, created.revision);
  assert.match(git(storeA, "log", "-1", "--format=%B", "HEAD~0"), /prism: update records/);
});

test("creates no commits when store sync is off", async (context) => {
  const { storeA, parent } = await machines(context);
  const root = await project(parent, "project-off", syncConfig("store-a", "off"));
  await writeRecord(root, STATE, "{}\n");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(git(storeA, "rev-list", "--count", "HEAD"), "1");
  assert.equal(await exists(path.join(storeA, ".prism-sync")), false);
  assert.match(git(storeA, "status", "--porcelain"), /initiatives\//);
});

test("keeps the first pushed version of a concurrently edited record and saves the local one", async (context) => {
  const { a, b, storeA, storeB, remote } = await machines(context);
  await writeRecord(a, STATE, "{\"v\":0}\n");
  await syncRecordStore(storeA);
  await syncRecordStore(storeB);
  await writeRecord(a, STATE, "{\"v\":\"a\"}\n");
  await writeRecord(b, STATE, "{\"v\":\"b\"}\n");
  assert.equal((await syncRecordStore(storeB)).state, "ok");
  const status = await syncRecordStore(storeA);
  assert.equal(status.state, "conflicts");
  assert.equal(status.conflicts.length, 1);
  assert.equal(status.conflicts[0].path, "initiatives/reports/state.json");
  assert.equal(await readFile(path.join(storeA, "initiatives/reports/state.json"), "utf8"), "{\"v\":\"b\"}\n");
  assert.equal(await readFile(path.join(storeA, status.conflicts[0].savedAs), "utf8"), "{\"v\":\"a\"}\n");
  assert.deepEqual((await readSyncStatus(storeA)).conflicts, status.conflicts);
  assert.equal(git(remote, "rev-parse", "main"), git(storeA, "rev-parse", "HEAD"));
  assert.equal(git(storeA, "status", "--porcelain"), "");
});

test("retries a push that another machine beat and ends in sync", async (context) => {
  const { a, b, storeA, storeB, remote } = await machines(context);
  await writeRecord(a, { kind: "state", initiative: "first" }, "{}\n");
  await writeRecord(b, { kind: "state", initiative: "second" }, "{}\n");
  let raced = false;
  const status = await syncRecordStore(storeA, { beforePush: async () => {
    if (raced) return;
    raced = true;
    assert.equal((await syncRecordStore(storeB)).state, "ok");
  } });
  assert.equal(status.state, "ok");
  assert.equal(git(remote, "rev-parse", "main"), git(storeA, "rev-parse", "HEAD"));
  assert.deepEqual(await listInitiatives(a), ["first", "second"]);
});

test("keeps records working in a store that is not a Git repository", async (context) => {
  const parent = await folder(context);
  await mkdir(path.join(parent, "store"));
  const root = await project(parent, "project", syncConfig("store"));
  await writeRecord(root, STATE, "{}\n");
  assert.equal((await readRecord(root, STATE)).bytes.toString(), "{}\n");
  assert.equal((await syncRecordStore(path.join(parent, "store"))).state, "not_a_repository");
  assert.equal((await readSyncStatus(path.join(parent, "store"))).state, "not_a_repository");
});

test("commits locally when the store's branch has no upstream", async (context) => {
  const parent = await folder(context);
  git(parent, "init", "-q", "-b", "main", "store");
  const store = path.join(parent, "store");
  const root = await project(parent, "project", syncConfig("store"));
  await writeRecord(root, STATE, "{}\n");
  assert.equal((await syncRecordStore(store)).state, "no_upstream");
  assert.match(git(store, "ls-files"), /initiatives\/reports\/state\.json/);
  assert.equal(git(store, "status", "--porcelain"), "");
});

test("makes a record read wait while the merge step replaces record files", async (context) => {
  const { a, b, storeA, storeB } = await machines(context);
  await writeRecord(a, STATE, "{\"v\":1}\n");
  await syncRecordStore(storeA);
  await syncRecordStore(storeB);
  const complete = `${JSON.stringify({ v: 2, padding: "x".repeat(200000) })}\n`;
  await writeRecord(b, STATE, complete);
  await syncRecordStore(storeB);
  let read;
  await syncRecordStore(storeA, { beforeApply: async () => {
    let settled = false;
    read = readRecord(a, STATE).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(settled, false, "the read waits for the merge step");
  } });
  assert.equal((await read).bytes.toString(), complete);
});

test("includes the store's sync status in the review index", async (context) => {
  const { a, storeA } = await machines(context);
  await writeRecord(a, STATE, "{}\n");
  await syncRecordStore(storeA);
  const review = await startReviewServer({ projectRoot: a });
  try {
    const index = await fetchJson(`${review.baseUrl}/api/index`);
    assert.equal(index.storeSync.state, "ok");
    assert.equal(index.storeSync.ahead, 0);
  } finally {
    await review.close();
  }
});
