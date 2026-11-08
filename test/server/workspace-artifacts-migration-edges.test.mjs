import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, commitFiles, eventually, exists, git, isolateGit, notes, ok, remoteFile, server, syncedWorkspace, text, workspace } from "./fixtures/workspace-artifacts.mjs";

// The move of a checkout's existing artifacts keeps every byte it moves, leaves the files it must not take, and reports once per server process.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const scoped = (store, location) => path.join(store, "artifacts", "repositories", "api", location);
const ledgerNames = async (store) => (await readdir(path.join(store, "artifact-migrations")).catch(() => [])).sort();

test("a binary plan file, a legacy record, and a frozen test of an accepted design stay in the checkout, while a text plan file moves with its exact bytes", async (context) => {
  const place = await workspace(context);
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
  // The store already holds another version of the legacy record, so the record move keeps the checkout's copy, which the artifact move must not take.
  await mkdir(path.join(place.store, "initiatives", "reports"), { recursive: true });
  const storedRecord = { schemaVersion: 1, slices: { reports: { parent: null, design: { frozenTests: [{ path: "docs/plans/reports/frozen.test.mjs" }] } } } };
  await writeFile(path.join(place.store, "initiatives", "reports", "initiative.json"), JSON.stringify(storedRecord));
  const legacy = "{\"schemaVersion\":1,\"slices\":{}}\n";
  const api = await checkout(place, "api", { files: {
    "docs/plans/reports/slice.md": "# Reports\r\n\uFEFFwith a byte order mark inside\n",
    "docs/plans/reports/diagram.png": "placeholder\n",
    "docs/plans/reports/initiative.json": legacy,
    "docs/plans/reports/frozen.test.mjs": "// frozen\n"
  } });
  await writeFile(path.join(api, "docs/plans/reports/diagram.png"), image);

  const access = await (await server(context, place, api)).call("get_artifact", {});
  assert.deepEqual(ok(access).artifacts.map((entry) => entry.path), ["docs/plans/reports/slice.md"]);
  assert.equal(await readFile(scoped(place.store, "plans/reports/slice.md"), "utf8"), "# Reports\r\n\uFEFFwith a byte order mark inside\n", "the moved file keeps its exact bytes");
  assert.deepEqual(await readFile(path.join(api, "docs/plans/reports/diagram.png")), image, "a file that is not UTF-8 text stays with its bytes");
  assert.equal(await exists(scoped(place.store, "plans/reports/diagram.png")), false);
  assert.match(notes(access), /diagram\.png \(not_text\)/);
  assert.equal(await readFile(path.join(api, "docs/plans/reports/initiative.json"), "utf8"), legacy, "the record move decides a legacy record");
  assert.equal(await readFile(path.join(api, "docs/plans/reports/frozen.test.mjs"), "utf8"), "// frozen\n", "a frozen test stays with the code");
  assert.equal(await exists(scoped(place.store, "plans/reports/initiative.json")), false);
  assert.equal(await exists(scoped(place.store, "plans/reports/frozen.test.mjs")), false);
  assert.doesNotMatch(notes(access), /frozen\.test\.mjs/);
});

test("the move reports once per server process, and a later process that keeps the same files writes no further ledger", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: { "docs/plans/reports/slice.md": "# Reports\n", "docs/plans/reports/my notes.md": "# Notes\n" } });
  const first = await server(context, place, api);
  const access = await first.call("get_artifact", {});
  assert.match(notes(access), /docs\/plans\/reports\/slice\.md -> artifacts\/repositories\/api\/plans\/reports\/slice\.md/);
  assert.match(notes(access), /my notes\.md \(name_invalid\)/);
  assert.equal((await ledgerNames(place.store)).length, 1);

  const again = await first.call("get_artifact", {});
  assert.equal(notes(again), "", "a later access in the same process reports nothing");
  await first.close();

  const later = await (await server(context, place, api)).call("get_artifact", {});
  assert.match(notes(later), /my notes\.md \(name_invalid\)/, "a new process reports the kept file again");
  assert.equal((await ledgerNames(place.store)).length, 1, "the kept file is already in a ledger");
  assert.equal(await readFile(path.join(api, "docs/plans/reports/my notes.md"), "utf8"), "# Notes\n");
});

test("with store sync on, the moved files and their ledger reach the remote in one commit", async (context) => {
  const place = await syncedWorkspace(context);
  const api = await checkout(place.a, "api", { files: { "docs/plans/reports/slice.md": "# Reports\n", "docs/requirements/billing.md": "# Billing\n\nStatus: Draft\n" } });
  ok(await (await server(context, place.a, api)).call("get_artifact", {}));
  const commit = await eventually(() => {
    const files = git(place.remote, "show", "--name-only", "--format=", "main").split("\n");
    return files.some((file) => file.startsWith("artifact-migrations/")) ? files : null;
  }, 30000, "the move's commit on the remote");
  assert.ok(commit.includes("artifacts/repositories/api/plans/reports/slice.md"), "the moved plan file is in the ledger's commit");
  assert.ok(commit.includes("artifacts/repositories/api/requirements/billing.md"), "the moved requirement is in the ledger's commit");
  assert.ok(commit.some((file) => file.startsWith("artifact-status/repositories/api/requirements/billing.md/")), "its status record is in the same commit");
});

test("one write that the store refuses keeps only its file, and the rest of a long move goes on without listing the store again for each file", async (context) => {
  const place = await workspace(context);
  const files = { "docs/plans/odd/a.md": "# Odd\n" };
  for (let index = 0; index < 1000; index += 1) files[`docs/plans/p${index % 50}/s${index}.md`] = `# S${index}\n`;
  const api = await checkout(place, "api", { files });
  // A folder of another letter case that holds no artifact refuses the batch that would write below it.
  await mkdir(path.join(place.store, "artifacts", "repositories", "api", "plans", "ODD"), { recursive: true });
  const started = Date.now();
  const access = await (await server(context, place, api)).call("get_artifact", { path: "docs/plans/p0/s0.md" });
  assert.equal(ok(access).content, "# S0\n");
  assert.ok(Date.now() - started < 30000, `the move took ${Date.now() - started} ms`);
  assert.match(notes(access), /docs\/plans\/odd\/a\.md \(name_conflict\)/);
  assert.equal(await readFile(path.join(api, "docs/plans/odd/a.md"), "utf8"), "# Odd\n", "the refused file stays in the checkout");
  assert.equal(await exists(path.join(api, "docs/plans/p49/s999.md")), false, "every other file moved");
  assert.equal(await readFile(scoped(place.store, "plans/p49/s999.md"), "utf8"), "# S999\n");
});

// A remote that the network black-holes: every SSH fetch hangs for this long before it fails.
const HANG_SECONDS = 15;
const hangingRemote = { env: { GIT_SSH_COMMAND: `sh -c 'sleep ${HANG_SECONDS}' x` } };
const hangingUrl = "ssh://git@store.example.invalid/store.git";
// A first access in a process runs the move again only after the record migration's five-second cache has expired.
const pastMigrationCache = () => new Promise((resolve) => setTimeout(resolve, 5500));
const timed = async (call) => { const started = Date.now(); const result = await call(); return { result, took: Date.now() - started }; };

test("with store sync on and a hanging remote, a checkout whose remaining tracked files the move keeps whatever the store holds waits for no pull", async (context) => {
  const place = await syncedWorkspace(context);
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
  const api = await checkout(place.a, "api", { files: { "docs/plans/reports/slice.md": "# Reports\n", "docs/plans/reports/diagram.png": image, "docs/plans/reports/my notes.md": "# Notes\n" } });
  const first = await server(context, place.a, api);
  const moved = await first.call("get_artifact", {});
  assert.match(notes(moved), /docs\/plans\/reports\/slice\.md -> /);
  assert.equal(await exists(path.join(api, "docs/plans/reports/slice.md")), false);
  await first.close();

  // The moved file's removal is not committed, so Git still tracks it, and the image and the misnamed file stay for good.
  git(place.storeA, "remote", "set-url", "origin", hangingUrl);
  const prism = await server(context, place.a, api, hangingRemote);
  for (const access of [1, 2]) {
    const { result, took } = await timed(() => prism.call("get_artifact", {}));
    ok(result);
    assert.ok(took < 5000, `access ${access} returns without waiting for the remote, took ${took} ms`);
    assert.doesNotMatch(notes(result), /wait for a pull/, `access ${access} carries no deferred note`);
    if (access === 1) assert.match(notes(result), /diagram\.png \(not_text\)/, "the new process reports the kept files again");
    await pastMigrationCache();
  }
  assert.deepEqual(await readFile(path.join(api, "docs/plans/reports/diagram.png")), image);
  assert.equal(await readFile(path.join(api, "docs/plans/reports/my notes.md"), "utf8"), "# Notes\n");
});

test("with store sync on, after a deferred move each later access waits for no fetch of its own while the remote hangs, and the move runs once a pull completes", async (context) => {
  const place = await syncedWorkspace(context);
  const file = "docs/plans/reports/slice.md";
  const api = await checkout(place.a, "api");
  const first = await server(context, place.a, api);
  ok(await first.call("get_artifact", {}));
  await first.close();
  await eventually(() => remoteFile(place.remote, "repositories/api.json"), 30000, "the registration on the remote");
  await commitFiles(api, { [file]: "# Reports\n" });

  // The remote cannot be reached, so the first access defers the move; then the network starts to black-hole it.
  git(place.storeA, "remote", "set-url", "origin", path.join(place.parent, "unreachable.git"));
  const prism = await server(context, place.a, api, hangingRemote);
  assert.match(notes(await prism.call("get_artifact", {})), /wait for a pull[^\n]*fetch_failed/);
  git(place.storeA, "remote", "set-url", "origin", hangingUrl);
  for (const access of [2, 3]) {
    await pastMigrationCache();
    const { result, took } = await timed(() => prism.call("get_artifact", {}));
    assert.ok(took < 5000, `access ${access} returns while the retry's fetch hangs, took ${took} ms`);
    assert.match(notes(result), /wait for a pull/, `access ${access} still defers the move`);
    assert.equal(await text(path.join(api, file)), "# Reports\n", "the file stays in the checkout");
  }

  git(place.storeA, "remote", "set-url", "origin", place.remote);
  await eventually(async () => {
    const later = await prism.call("get_artifact", {});
    return ok(later).artifacts.some((entry) => entry.path === file) && !(await exists(path.join(api, file)));
  }, 60000, "the move after a completed pull");
  assert.equal(await text(scoped(place.storeA, "plans/reports/slice.md")), "# Reports\n");
});
