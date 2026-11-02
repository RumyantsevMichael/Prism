import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-store-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const {
  appendRecord, ensureRecords, forgetMigrations, keyOfPath, listInitiatives, listRecordEntries, locateRecord, readRecord, removeInitiativeRecords, sameRecord, writeRecord
} = await import("../../dist/server/workflow/record-store.mjs");
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const STORE_CONFIG = "## Paths\n- Plans (scratch): docs/plans/\n- Roadmap: docs/roadmap.md\n\n## Workspace\n- Store: ../store\n";
const exists = (target) => access(target).then(() => true, () => false);

// A parent folder holding a project and, beside it, the store its config names.
async function workspace(context, { config = STORE_CONFIG, store = true } = {}) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-store-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "project");
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), config);
  if (store) await mkdir(path.join(parent, "store"));
  forgetMigrations();
  return { parent, root, store: path.join(parent, "store") };
}

// Two Git worktrees of one repository whose committed config names the same store.
async function worktrees(context, committed = {}) {
  const { parent, root, store } = await workspace(context);
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Prism", "-c", "user.email=prism@example.invalid", ...args], { cwd, stdio: "pipe" });
  for (const [relative, contents] of Object.entries(committed)) await put(root, relative, contents);
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  const other = path.join(parent, "other");
  git(root, "worktree", "add", "-q", other);
  return { a: root, b: other, store };
}

async function put(root, relative, contents) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), contents);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }).once("error", reject);
  });
}

test("shares initiatives between two worktrees that name the same store", async (context) => {
  const { a, b } = await worktrees(context);
  const created = await updateInitiative({ projectRoot: a, initiative: "reports", expectedRevision: null, operations: [{ op: "create", slug: "reports", title: "Reports", requirements: ["r.md#1"] }] });
  assert.deepEqual(await listInitiatives(b), ["reports"]);
  const seen = await getInitiative({ projectRoot: b, initiative: "reports" });
  assert.equal(seen.revision, created.revision);
  const updated = await updateInitiative({ projectRoot: b, initiative: "reports", expectedRevision: created.revision, operations: [{ op: "update_slice", slug: "reports", title: "Signed reports" }] });
  assert.equal((await getInitiative({ projectRoot: a, initiative: "reports" })).revision, updated.revision);
  await assert.rejects(updateInitiative({ projectRoot: a, initiative: "reports", expectedRevision: created.revision, operations: [{ op: "update_slice", slug: "reports", title: "Stale" }] }), { code: "revision_conflict" });
});

test("writes records into the store and nothing new under the project's .prism", async (context) => {
  const { root, store } = await workspace(context);
  await updateInitiative({ projectRoot: root, initiative: "reports", expectedRevision: null, operations: [{ op: "create", slug: "reports", title: "Reports", requirements: ["r.md#1"] }] });
  await writeRecord(root, { kind: "state", initiative: "reports" }, "{}\n");
  await appendRecord(root, { kind: "runs", initiative: "reports", slice: "reports" }, "run-1", { order: 1 });
  assert.deepEqual(await readdir(path.join(root, ".prism")), ["workflow.md"]);
  assert.equal(await exists(path.join(store, "initiatives/reports/initiative.json")), true);
  assert.equal(await exists(path.join(store, "initiatives/reports/state.json")), true);
  assert.equal(await exists(path.join(store, "initiatives/reports/slices/reports/runs/run-1.json")), true);
  assert.match(await readFile(path.join(store, ".gitattributes"), "utf8"), /^\/initiatives\/\*\* linguist-generated=true gitlab-generated$/m);
});

test("keeps .prism logical paths and the same path answers with and without a store", async (context) => {
  const withStore = await workspace(context);
  const inRepo = await workspace(context, { config: "## Paths\n- Plans (scratch): docs/plans/\n- Roadmap: docs/roadmap.md\n", store: false });
  const initiative = JSON.stringify({ slices: { export: { parent: null } } });
  await writeRecord(withStore.root, { kind: "initiative", initiative: "reports" }, initiative);
  await writeRecord(inRepo.root, { kind: "initiative", initiative: "reports" }, initiative);
  for (const root of [withStore.root, inRepo.root]) {
    const located = await locateRecord(root, { kind: "review", initiative: "reports", slice: "export" });
    assert.equal(located.path, ".prism/initiatives/reports/slices/export/review.json");
    assert.deepEqual(await keyOfPath(root, "docs/plans/reports/review.json"), { kind: "review", initiative: "reports", slice: "export" });
    assert.deepEqual(await keyOfPath(root, ".prism/roadmap.json"), { kind: "roadmap" });
    assert.equal(await sameRecord(root, "docs/plans/reports/download/change-map.json", ".prism/initiatives/reports/slices/download/change-map.json"), true);
    assert.equal(await sameRecord(root, "docs/plans/reports/download/change-map.json", ".prism/initiatives/reports/slices/export/change-map.json"), false);
  }
  assert.equal((await locateRecord(withStore.root, { kind: "roadmap" })).target, path.join(withStore.store, "roadmap.json"));
});

test("fails every record operation on a missing store and creates nothing", async (context) => {
  const { parent, root, store } = await workspace(context, { store: false });
  await assert.rejects(readRecord(root, { kind: "state", initiative: "reports" }), (error) => error.code === "store_unavailable" && error.message.includes("../store") && error.message.includes(store));
  await assert.rejects(writeRecord(root, { kind: "state", initiative: "reports" }, "{}\n"), { code: "store_unavailable" });
  await assert.rejects(listInitiatives(root), { code: "store_unavailable" });
  assert.equal(await exists(store), false);
  assert.deepEqual(await readdir(parent), ["project"]);
  assert.deepEqual(await readdir(path.join(root, ".prism")), ["workflow.md"]);
});

test("refuses a store inside the project root", async (context) => {
  const { root } = await workspace(context, { config: "## Workspace\n- Store: records\n", store: false });
  await mkdir(path.join(root, "records"));
  await assert.rejects(readRecord(root, { kind: "roadmap" }), { code: "store_unavailable" });
  await assert.rejects(writeRecord(root, { kind: "roadmap" }, "{}\n"), { code: "store_unavailable" });
  assert.deepEqual(await readdir(path.join(root, "records")), []);
});

test("refuses a store that contains the project root", async (context) => {
  const { root } = await workspace(context, { config: "## Workspace\n- Store: ..\n", store: false });
  await assert.rejects(readRecord(root, { kind: "roadmap" }), (error) => error.code === "store_unavailable" && error.message.includes("contains the project root"));
  await assert.rejects(writeRecord(root, { kind: "roadmap" }, "{}\n"), { code: "store_unavailable" });
});

test("moves in-repo and legacy records into the store and reports a differing target", async (context) => {
  const { root, store } = await workspace(context);
  const initiative = JSON.stringify({ slices: { export: { parent: null } } });
  await put(root, ".prism/roadmap.json", "roadmap bytes");
  await put(root, ".prism/initiatives/reports/initiative.json", initiative);
  await put(root, ".prism/initiatives/reports/slices/export/runs/run-1.json", "{\"order\":1}\n");
  await put(root, ".prism/initiatives/same/state.json", "same");
  await put(store, "initiatives/same/state.json", "same");
  await put(root, ".prism/initiatives/other/state.json", "project state");
  await put(store, "initiatives/other/state.json", "store state");
  await put(root, "docs/plans/legacy/state.json", "legacy state");
  const report = await ensureRecords(root);
  assert.deepEqual(report.conflicts.map((move) => move.from), [".prism/initiatives/other/state.json"]);
  assert.equal(await readFile(path.join(store, "roadmap.json"), "utf8"), "roadmap bytes");
  assert.equal(await readFile(path.join(store, "initiatives/reports/initiative.json"), "utf8"), initiative);
  assert.equal(await readFile(path.join(store, "initiatives/reports/slices/export/runs/run-1.json"), "utf8"), "{\"order\":1}\n");
  assert.equal(await readFile(path.join(store, "initiatives/legacy/state.json"), "utf8"), "legacy state");
  assert.equal(await exists(path.join(root, "docs/plans/legacy/state.json")), false);
  assert.equal(await exists(path.join(root, ".prism/initiatives/same/state.json")), false);
  assert.equal(await readFile(path.join(root, ".prism/initiatives/other/state.json"), "utf8"), "project state");
  assert.equal(await readFile(path.join(store, "initiatives/other/state.json"), "utf8"), "store state");
  assert.equal(await exists(path.join(root, ".prism/roadmap.json")), false);
  assert.equal(await readFile(path.join(root, ".prism/workflow.md"), "utf8"), STORE_CONFIG);
});

test("lists and serves store records through their .prism artifact paths", async (context) => {
  const { root } = await workspace(context);
  await writeRecord(root, { kind: "state", initiative: "reports" }, "{\"note\":\"from the store\"}\n");
  const review = await startReviewServer({ projectRoot: root });
  try {
    const index = JSON.parse((await fetchJson(`${review.baseUrl}/api/index`)).body);
    assert.equal(index.artifacts.includes(".prism/initiatives/reports/state.json"), true);
    const served = await fetchJson(`${review.baseUrl}/api/artifact?path=${encodeURIComponent(".prism/initiatives/reports/state.json")}`);
    assert.equal(served.status, 200);
    assert.match(JSON.parse(served.body).content, /from the store/);
  } finally {
    await review.close();
  }
});

test("refuses a symlink inside the store that points outside it", async (context) => {
  const { parent, root, store } = await workspace(context);
  await mkdir(path.join(parent, "outside/reports"), { recursive: true });
  await writeFile(path.join(parent, "outside/reports/state.json"), "{}\n");
  await symlink(path.join(parent, "outside"), path.join(store, "initiatives"));
  await assert.rejects(readRecord(root, { kind: "state", initiative: "reports" }), { code: "invalid_path" });
  await assert.rejects(writeRecord(root, { kind: "state", initiative: "reports" }, "{}\n"), { code: "invalid_path" });
  const review = await startReviewServer({ projectRoot: root });
  try {
    const served = await fetchJson(`${review.baseUrl}/api/artifact?path=${encodeURIComponent(".prism/initiatives/reports/state.json")}`);
    assert.equal(served.status, 400);
  } finally {
    await review.close();
  }
});

test("appends run entries into the store and lists entries appended from either worktree", async (context) => {
  const { a, b, store } = await worktrees(context);
  const key = { kind: "runs", initiative: "reports", slice: "download" };
  await appendRecord(a, key, "run-1", { from: "a" });
  await appendRecord(b, key, "run-2", { from: "b" });
  await assert.rejects(appendRecord(b, key, "run-1", { from: "b" }), { code: "entry_exists" });
  assert.deepEqual((await readdir(path.join(store, "initiatives/reports/slices/download/runs"))).filter((name) => name.endsWith(".json")).sort(), ["run-1.json", "run-2.json"]);
  for (const root of [a, b]) assert.deepEqual((await listRecordEntries(root, key)).map((item) => [item.id, item.entry.from]), [["run-1", "a"], ["run-2", "b"]]);
});

test("migrates a repository's committed records once, so a record removed later stays removed", async (context) => {
  const { a, b, store } = await worktrees(context, { ".prism/initiatives/x/state.json": "{}\n", ".prism/initiatives/y/state.json": "{}\n" });
  assert.deepEqual(await listInitiatives(a), ["x", "y"]);
  await removeInitiativeRecords(a, "x");
  forgetMigrations();
  assert.equal(await exists(path.join(b, ".prism/initiatives/x/state.json")), true);
  assert.deepEqual(await listInitiatives(b), ["y"]);
  assert.equal(await exists(path.join(store, "initiatives/x")), false);
  const markers = await readdir(path.join(store, "migrations"));
  assert.equal(markers.length, 1);
  const marker = JSON.parse(await readFile(path.join(store, "migrations", markers[0]), "utf8"));
  assert.match(marker.repository, /^[0-9a-f]{40,64}$/);
  assert.equal(marker.moved, 2);
});

test("records a migration conflict in the store's migration record and keeps both files", async (context) => {
  const { root, store } = await workspace(context);
  await put(root, ".prism/initiatives/other/state.json", "project state");
  await put(store, "initiatives/other/state.json", "store state");
  await ensureRecords(root);
  const [name] = await readdir(path.join(store, "migrations"));
  const marker = JSON.parse(await readFile(path.join(store, "migrations", name), "utf8"));
  assert.equal(marker.repository, root);
  assert.deepEqual(marker.conflicts, [{ from: ".prism/initiatives/other/state.json", to: ".prism/initiatives/other/state.json" }]);
  assert.equal(await readFile(path.join(root, ".prism/initiatives/other/state.json"), "utf8"), "project state");
  assert.equal(await readFile(path.join(store, "initiatives/other/state.json"), "utf8"), "store state");
});

test("still lists human documents in the review browser when the store is missing", async (context) => {
  const { root } = await workspace(context, { store: false });
  await put(root, "docs/plans/reports/slice.md", "# Reports\n");
  const review = await startReviewServer({ projectRoot: root });
  try {
    const index = JSON.parse((await fetchJson(`${review.baseUrl}/api/index`)).body);
    assert.equal(index.artifacts.includes("docs/plans/reports/slice.md"), true);
  } finally {
    await review.close();
  }
  await assert.rejects(readRecord(root, { kind: "state", initiative: "reports" }), { code: "store_unavailable" });
});
