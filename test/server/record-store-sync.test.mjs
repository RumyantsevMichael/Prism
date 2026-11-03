import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { splitEvidence } from "./fixtures/split-evidence.mjs";

// Git runs with a private home and configuration, a fixed identity, and only local repositories.
const environment = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-sync-env-")));
await writeFile(path.join(environment, "gitconfig"), "");
Object.assign(process.env, {
  HOME: environment, GIT_CONFIG_GLOBAL: path.join(environment, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: environment,
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
delete process.env.CLAUDE_PLUGIN_DATA;
const { cancelRecordSyncs, configureRecordSync, listSavedConflicts, readSavedConflict, readSyncStatus, syncRecordStore, takeSavedConflicts } = await import("../../dist/server/workflow/record-store-sync.mjs");
const { forgetMigrations, listInitiatives, readRecord, writeRecord } = await import("../../dist/server/workflow/record-store.mjs");
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { getRoadmap, updateRoadmap } = await import("../../dist/server/workflow/roadmap.mjs");
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
const { withFileLock } = await import("../../dist/server/workflow/artifact-store.mjs");
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
  const saved = (await takeSavedConflicts()).filter((item) => item.savedAs.startsWith(storeA));
  assert.deepEqual(saved.map((item) => [item.record, item.savedAs]), [[".prism/initiatives/reports/state.json", path.join(storeA, status.conflicts[0].savedAs)]]);
  assert.deepEqual((await takeSavedConflicts()).filter((item) => item.savedAs.startsWith(storeA)), []);
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

test("lists saved conflicts and serves each saved copy beside its current record, and nothing else", async (context) => {
  const { a, b, storeA, storeB } = await machines(context);
  await writeRecord(a, STATE, "{\"v\":0}\n");
  await syncRecordStore(storeA);
  await syncRecordStore(storeB);
  await writeRecord(a, STATE, "{\"v\":\"a\"}\n");
  await writeRecord(b, STATE, "{\"v\":\"b\"}\n");
  await syncRecordStore(storeB);
  const status = await syncRecordStore(storeA);
  const listed = await listSavedConflicts(storeA);
  assert.deepEqual(listed.map((item) => [item.path, item.savedAs]), [["initiatives/reports/state.json", status.conflicts[0].savedAs]]);
  assert.deepEqual(await readSavedConflict(storeA, listed[0].savedAs), { path: "initiatives/reports/state.json", saved: "{\"v\":\"a\"}\n", current: "{\"v\":\"b\"}\n" });
  const stamp = listed[0].savedAs.split("/")[2];
  for (const name of [".prism-sync/status.json", `.prism-sync/conflicts/${stamp}/../../status.json`, `.prism-sync/conflicts/${stamp}/README.md`, "initiatives/reports/state.json", `.prism-sync/conflicts/not-a-stamp/initiatives/reports/state.json`, null]) {
    assert.equal(await readSavedConflict(storeA, name), null, String(name));
  }
  const review = await startReviewServer({ projectRoot: a });
  try {
    const index = await fetchJson(`${review.baseUrl}/api/index`);
    assert.deepEqual(index.recordStore, { kind: "folder", label: "../store-a", location: storeA, sync: true });
    assert.deepEqual((await fetchJson(`${review.baseUrl}/api/store/conflicts`)).conflicts, listed);
    assert.equal((await fetchJson(`${review.baseUrl}/api/store/conflict?savedAs=${encodeURIComponent(listed[0].savedAs)}`)).saved, "{\"v\":\"a\"}\n");
  } finally {
    await review.close();
  }
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

const STATE_FILE = "initiatives/reports/state.json";
const remoteFile = (remote, file) => git(remote, "show", `main:${file}`);

// Both machines hold the same state record, and B has pushed its own change to it.
async function upstreamChange(context) {
  const machinesValue = await machines(context);
  const { a, b, storeA, storeB } = machinesValue;
  await writeRecord(a, STATE, "{\"v\":0}\n");
  await syncRecordStore(storeA);
  await syncRecordStore(storeB);
  await writeRecord(b, STATE, "{\"v\":\"b\"}\n");
  assert.equal((await syncRecordStore(storeB)).state, "ok");
  return machinesValue;
}

test("keeps the branch and the upstream change when a record stays locked during the merge", async (context) => {
  const { storeA, remote } = await upstreamChange(context);
  const head = git(storeA, "rev-parse", "HEAD");
  configureRecordSync({ applyLockMs: 100 });
  let status;
  try {
    await withFileLock(path.join(storeA, STATE_FILE), async () => { status = await syncRecordStore(storeA); });
  } finally {
    configureRecordSync({ applyLockMs: 2000 });
  }
  assert.equal(status.state, "merge_failed");
  assert.equal(git(storeA, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(path.join(storeA, STATE_FILE), "utf8"), "{\"v\":0}\n");
  assert.equal((await syncRecordStore(storeA)).state, "ok");
  assert.equal(await readFile(path.join(storeA, STATE_FILE), "utf8"), "{\"v\":\"b\"}\n");
  assert.equal(remoteFile(remote, STATE_FILE), "{\"v\":\"b\"}");
});

test("turns a local write that lands before the merge step into a saved conflict", async (context) => {
  const { storeA, remote } = await upstreamChange(context);
  let injected = false;
  const status = await syncRecordStore(storeA, { beforeApply: async () => {
    if (injected) return;
    injected = true;
    await writeFile(path.join(storeA, STATE_FILE), "{\"v\":\"a\"}\n");
  } });
  assert.equal(status.state, "conflicts");
  assert.deepEqual(status.conflicts.map((item) => item.path), [STATE_FILE]);
  assert.equal(await readFile(path.join(storeA, status.conflicts[0].savedAs), "utf8"), "{\"v\":\"a\"}\n");
  assert.equal(await readFile(path.join(storeA, STATE_FILE), "utf8"), "{\"v\":\"b\"}\n");
  assert.equal(remoteFile(remote, STATE_FILE), "{\"v\":\"b\"}");
  assert.equal(git(storeA, "status", "--porcelain"), "");
});

test("syncs again when a write is scheduled while a sync is running", async (context) => {
  const { a, storeA, remote } = await machines(context);
  await writeRecord(a, STATE, "{}\n");
  configureRecordSync({ debounceMs: 20 });
  try {
    await syncRecordStore(storeA, { beforePush: async () => {
      await writeRecord(a, { kind: "state", initiative: "later" }, "{}\n");
      await new Promise((resolve) => setTimeout(resolve, 150));
    } });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !git(remote, "ls-tree", "-r", "--name-only", "main").includes("initiatives/later/state.json")) await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    configureRecordSync({ debounceMs: 3600000 });
  }
  // The follow-up sync may still be writing its status, so it finishes before the folder goes.
  await syncRecordStore(storeA);
  assert.match(git(remote, "ls-tree", "-r", "--name-only", "main"), /initiatives\/later\/state\.json/);
});

// Structural merges of roadmap and initiative records that changed on both machines.
const ROADMAP_FILE = "roadmap.json";
const INITIATIVE_FILE = "initiatives/reports/initiative.json";
const add = (id, band, extra = {}) => ({ op: "add_initiative", id, title: `Title ${id}`, intent: `Intent ${id}.`, band, ...extra });
const roadmapOf = (root) => getRoadmap({ projectRoot: root });
const roadmapWrite = async (root, operations) => updateRoadmap({ projectRoot: root, expectedRevision: (await roadmapOf(root)).revision, actor: path.basename(root), operations });
const initiativeOf = (root) => getInitiative({ projectRoot: root, initiative: "reports" });
const initiativeWrite = async (root, operations) => updateInitiative({ projectRoot: root, initiative: "reports", expectedRevision: (await initiativeOf(root)).revision, actor: path.basename(root), operations });
const savedConflicts = (store) => exists(path.join(store, ".prism-sync", "conflicts"));

// Both machines hold one shared base written on A, with a roadmap projection path configured.
async function sharedBase(context, write) {
  const value = await machines(context);
  for (const [root, store] of [[value.a, "store-a"], [value.b, "store-b"]]) await writeFile(path.join(root, ".prism/workflow.md"), `## Paths\n- Roadmap: product/roadmap.md\n- Plans (scratch): docs/plans/\n\n## Workspace\n- Store: ../${store}\n- Store sync: on\n`);
  await write(value.a);
  assert.equal((await syncRecordStore(value.storeA)).state, "ok");
  assert.equal((await syncRecordStore(value.storeB)).state, "ok");
  return value;
}

const roadmapBase = (context, extra = []) => sharedBase(context, (root) => updateRoadmap({ projectRoot: root, expectedRevision: null, operations: [add("alpha", "Now"), add("beta", "Now"), add("gamma", "Next"), ...extra] }));
const initiativeBase = (context) => sharedBase(context, async (root) => updateInitiative({ projectRoot: root, initiative: "reports", expectedRevision: null, operations: [
  { op: "create", slug: "reports", title: "Reports", requirements: ["r.md#R1", "r.md#R2"] },
  { op: "split", parent: "reports", children: [{ slug: "s1", title: "First", requirements: ["r.md#R1"] }, { slug: "s2", title: "Second", requirements: ["r.md#R2"] }], evidence: await splitEvidence(root, "docs/plans/reports", "s1") }
] }));

// A pushes first, B merges A's push into its own change, and A then takes B's merge.
async function syncBoth({ storeA, storeB }) {
  assert.equal((await syncRecordStore(storeA)).state, "ok");
  const status = await syncRecordStore(storeB);
  assert.equal((await syncRecordStore(storeA)).state, "ok");
  return status;
}

async function assertMerged(value, status, file, read) {
  assert.equal(status.state, "ok");
  assert.deepEqual(status.conflicts, []);
  assert.equal(await savedConflicts(value.storeB), false);
  const [onA, onB] = [await read(value.a), await read(value.b)];
  assert.equal(onA.valid, true);
  assert.equal(onA.revision, onB.revision);
  assert.equal(git(value.remote, "show", `main:${file}`), (await readFile(path.join(value.storeB, file), "utf8")).trimEnd());
  assert.equal(git(value.storeB, "status", "--porcelain"), "");
  return onB.record;
}

async function assertFellBack(value, status, file, upstreamBytes, localBytes) {
  assert.equal(status.state, "conflicts");
  assert.deepEqual(status.conflicts.map((item) => item.path), [file]);
  assert.equal(await readFile(path.join(value.storeB, file), "utf8"), upstreamBytes);
  assert.equal(await readFile(path.join(value.storeB, status.conflicts[0].savedAs), "utf8"), localBytes);
  const saved = (await takeSavedConflicts()).filter((item) => item.savedAs.startsWith(value.storeB));
  assert.deepEqual(saved.map((item) => item.record), [`.prism/${file}`]);
}

const storeBytes = (store, file) => readFile(path.join(store, file), "utf8");
const historyHas = (record, actor, operation, id) => record.history.some((entry) => entry.actor === actor && entry.operation === operation && (entry.id ?? entry.slug) === id);

test("merges concurrent changes to different roadmap initiatives and keeps both history entries", async (context) => {
  const value = await roadmapBase(context);
  const baseHistory = (await roadmapOf(value.a)).record.history.length;
  await roadmapWrite(value.a, [{ op: "update_initiative", id: "alpha", title: "Alpha from A" }]);
  await roadmapWrite(value.b, [{ op: "update_initiative", id: "beta", title: "Beta from B" }]);
  const status = await syncBoth(value);
  const record = await assertMerged(value, status, ROADMAP_FILE, roadmapOf);
  assert.deepEqual(record.initiatives.map((item) => [item.id, item.title]), [["alpha", "Alpha from A"], ["beta", "Beta from B"], ["gamma", "Title gamma"]]);
  assert.equal(record.history.length, baseHistory + 2);
  assert.ok(historyHas(record, "project-a", "update_initiative", "alpha"));
  assert.ok(historyHas(record, "project-b", "update_initiative", "beta"));
  const bytes = await storeBytes(value.storeB, ROADMAP_FILE);
  assert.equal(`${JSON.stringify(JSON.parse(bytes), null, 2)}\n`, bytes, "the merged roadmap is written as the roadmap tools write it");
});

test("keeps the upstream roadmap when both machines change the same initiative differently", async (context) => {
  const value = await roadmapBase(context);
  await roadmapWrite(value.a, [{ op: "update_initiative", id: "alpha", title: "Alpha from A" }]);
  await roadmapWrite(value.b, [{ op: "update_initiative", id: "alpha", title: "Alpha from B" }]);
  const [upstream, local] = [await storeBytes(value.storeA, ROADMAP_FILE), await storeBytes(value.storeB, ROADMAP_FILE)];
  await assertFellBack(value, await syncBoth(value), ROADMAP_FILE, upstream, local);
});

test("merges concurrent changes to different slices of one initiative", async (context) => {
  const value = await initiativeBase(context);
  await initiativeWrite(value.a, [{ op: "update_slice", slug: "s1", title: "First from A" }]);
  await initiativeWrite(value.b, [{ op: "update_slice", slug: "s2", title: "Second from B" }]);
  const record = await assertMerged(value, await syncBoth(value), INITIATIVE_FILE, initiativeOf);
  assert.deepEqual([record.slices.s1.title, record.slices.s2.title], ["First from A", "Second from B"]);
  assert.ok(historyHas(record, "project-a", "update_slice", "s1"));
  assert.ok(historyHas(record, "project-b", "update_slice", "s2"));
});

test("keeps the upstream initiative when both machines change the same slice differently", async (context) => {
  const value = await initiativeBase(context);
  await initiativeWrite(value.a, [{ op: "update_slice", slug: "s1", title: "First from A" }]);
  await initiativeWrite(value.b, [{ op: "update_slice", slug: "s1", title: "First from B" }]);
  const [upstream, local] = [await storeBytes(value.storeA, INITIATIVE_FILE), await storeBytes(value.storeB, INITIATIVE_FILE)];
  await assertFellBack(value, await syncBoth(value), INITIATIVE_FILE, upstream, local);
});

test("keeps one machine's reordering and places the other machine's new initiative after its predecessor", async (context) => {
  const value = await roadmapBase(context);
  const reordered = await roadmapWrite(value.a, [{ op: "place", id: "gamma", band: "Now", position: 0 }]);
  assert.deepEqual(reordered.record.initiatives.map((item) => item.id), ["gamma", "alpha", "beta"]);
  const added = await roadmapWrite(value.b, [add("delta", "Now", { position: 1 })]);
  assert.deepEqual(added.record.initiatives.map((item) => item.id), ["alpha", "delta", "beta", "gamma"]);
  const record = await assertMerged(value, await syncBoth(value), ROADMAP_FILE, roadmapOf);
  assert.deepEqual(record.initiatives.map((item) => [item.id, item.band]), [["gamma", "Now"], ["alpha", "Now"], ["delta", "Now"], ["beta", "Now"]]);
});

test("keeps the upstream roadmap when both machines reorder it differently", async (context) => {
  const value = await roadmapBase(context);
  await roadmapWrite(value.a, [{ op: "place", id: "beta", band: "Now", position: 0 }]);
  await roadmapWrite(value.b, [{ op: "place", id: "gamma", band: "Now", position: 0 }]);
  const [upstream, local] = [await storeBytes(value.storeA, ROADMAP_FILE), await storeBytes(value.storeB, ROADMAP_FILE)];
  await assertFellBack(value, await syncBoth(value), ROADMAP_FILE, upstream, local);
});

test("keeps the upstream initiative when two valid dependency changes merge into a cycle", async (context) => {
  const value = await initiativeBase(context);
  assert.equal((await initiativeWrite(value.a, [{ op: "set_dependencies", slug: "s1", dependencies: ["s2"] }])).valid, true);
  assert.equal((await initiativeWrite(value.b, [{ op: "set_dependencies", slug: "s2", dependencies: ["s1"] }])).valid, true);
  const [upstream, local] = [await storeBytes(value.storeA, INITIATIVE_FILE), await storeBytes(value.storeB, INITIATIVE_FILE)];
  await assertFellBack(value, await syncBoth(value), INITIATIVE_FILE, upstream, local);
  assert.equal((await initiativeOf(value.b)).valid, true);
});

test("caps a merged roadmap history at 500 entries and keeps both new entries", async (context) => {
  const questions = (count) => Array.from({ length: count }, (_, index) => ({ op: "set_open_questions", questions: [`Question ${index}?`] }));
  const value = await sharedBase(context, async (root) => {
    await updateRoadmap({ projectRoot: root, expectedRevision: null, operations: [add("alpha", "Now"), add("beta", "Now"), ...questions(98)] });
    for (let round = 0; round < 4; round++) await roadmapWrite(root, questions(100));
  });
  assert.equal((await roadmapOf(value.a)).record.history.length, 500);
  await roadmapWrite(value.a, [{ op: "update_initiative", id: "alpha", title: "Alpha from A" }]);
  await roadmapWrite(value.b, [{ op: "update_initiative", id: "beta", title: "Beta from B" }]);
  const record = await assertMerged(value, await syncBoth(value), ROADMAP_FILE, roadmapOf);
  assert.equal(record.history.length, 500);
  assert.ok(historyHas(record, "project-a", "update_initiative", "alpha"));
  assert.ok(historyHas(record, "project-b", "update_initiative", "beta"));
});

test("keeps Git's line merge for a record kind without a structural merge", async (context) => {
  const value = await machines(context);
  const lines = (first, last) => `{\n"first": ${first},\n"second": 0,\n"third": 0,\n"fourth": 0,\n"last": ${last}\n}\n`;
  await writeRecord(value.a, STATE, lines(0, 0));
  await syncRecordStore(value.storeA);
  await syncRecordStore(value.storeB);
  await writeRecord(value.a, STATE, lines(1, 0));
  await writeRecord(value.b, STATE, lines(0, 2));
  const status = await syncBoth(value);
  assert.equal(status.state, "ok");
  assert.equal(await storeBytes(value.storeB, STATE_FILE), lines(1, 2));
  assert.equal(await savedConflicts(value.storeB), false);
});

test("keeps the upstream roadmap when both machines add the same initiative differently", async (context) => {
  const value = await roadmapBase(context);
  await roadmapWrite(value.a, [add("delta", "Later", { title: "Delta from A" })]);
  await roadmapWrite(value.b, [add("delta", "Later", { title: "Delta from B" })]);
  const [upstream, local] = [await storeBytes(value.storeA, ROADMAP_FILE), await storeBytes(value.storeB, ROADMAP_FILE)];
  await assertFellBack(value, await syncBoth(value), ROADMAP_FILE, upstream, local);
});

test("keeps the upstream registration whole when both machines change it, even where the lines merge, and reports it nowhere", async (context) => {
  const value = await machines(context);
  const file = "repositories/api.json";
  const registration = (remotes, root) => `${JSON.stringify({ schemaVersion: 1, name: "api", remotes, root, registeredAt: "2026-11-03T00:00:00.000Z" }, null, 2)}\n`;
  const write = (store, bytes) => mkdir(path.join(store, "repositories"), { recursive: true }).then(() => writeFile(path.join(store, file), bytes));
  await write(value.storeA, registration(["https://github.com/acme/api.git"], null));
  await syncRecordStore(value.storeA);
  await syncRecordStore(value.storeB);
  // One machine fills the root, the other adds a remote: separate lines that Git alone would merge into a registration neither machine wrote.
  const upstream = registration(["https://github.com/acme/api.git"], "abc123");
  const local = registration(["https://github.com/acme/api.git", "https://github.com/acme/platform-api.git"], null);
  await write(value.storeA, upstream);
  await write(value.storeB, local);
  const status = await syncBoth(value);
  assert.equal(status.state, "ok");
  assert.deepEqual(status.conflicts, []);
  assert.deepEqual((await readSyncStatus(value.storeB)).conflicts, []);
  assert.equal(await storeBytes(value.storeB, file), upstream);
  const [stamp] = await readdir(path.join(value.storeB, ".prism-sync", "conflicts"));
  assert.equal(await readFile(path.join(value.storeB, ".prism-sync", "conflicts", stamp, file), "utf8"), local);
  assert.deepEqual(await listSavedConflicts(value.storeB), []);
  assert.deepEqual((await takeSavedConflicts()).filter((item) => item.savedAs.startsWith(value.storeB)), []);
});

test("merges a registration added on both machines into the upstream one instead of failing the merge", async (context) => {
  const value = await machines(context);
  const file = "repositories/api.json";
  const registration = (remote) => `${JSON.stringify({ schemaVersion: 1, name: "api", remotes: [remote], root: null, registeredAt: new Date().toISOString() }, null, 2)}\n`;
  for (const [store, remote] of [[value.storeA, "https://github.com/acme/api.git"], [value.storeB, "https://github.com/beta/api.git"]]) {
    await mkdir(path.join(store, "repositories"), { recursive: true });
    await writeFile(path.join(store, file), registration(remote));
  }
  const status = await syncBoth(value);
  assert.equal(status.state, "ok");
  assert.deepEqual(JSON.parse(await storeBytes(value.storeB, file)).remotes, ["https://github.com/acme/api.git"]);
});
