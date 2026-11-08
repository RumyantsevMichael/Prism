import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkout, eventually, exists, git, isolateGit, notes, ok, server, syncedWorkspace, workspace } from "./fixtures/workspace-artifacts.mjs";

// The move of a checkout's existing artifacts keeps every byte it moves, leaves the files it must not take, and reports once per server process.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const scoped = (store, location) => path.join(store, "artifacts", "repositories", "api", location);
const ledgerNames = async (store) => (await readdir(path.join(store, "artifact-migrations")).catch(() => [])).sort();

test("a binary plan file moves with its exact bytes, while a legacy record and a frozen test of an accepted design stay in the checkout", async (context) => {
  const place = await workspace(context);
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
  // The store already holds another version of the legacy record, so the record move keeps the checkout's copy, which the artifact move must not take.
  await mkdir(path.join(place.store, "initiatives", "reports"), { recursive: true });
  const storedRecord = { schemaVersion: 1, slices: { reports: { parent: null, design: { frozenTests: [{ path: "docs/plans/reports/frozen.test.mjs" }] } } } };
  await writeFile(path.join(place.store, "initiatives", "reports", "initiative.json"), JSON.stringify(storedRecord));
  const legacy = "{\"schemaVersion\":1,\"slices\":{}}\n";
  const api = await checkout(place, "api", { files: {
    "docs/plans/reports/slice.md": "# Reports\n",
    "docs/plans/reports/diagram.png": "placeholder\n",
    "docs/plans/reports/initiative.json": legacy,
    "docs/plans/reports/frozen.test.mjs": "// frozen\n"
  } });
  await writeFile(path.join(api, "docs/plans/reports/diagram.png"), image);

  const access = await (await server(context, place, api)).call("get_artifact", {});
  assert.deepEqual(ok(access).artifacts.map((entry) => entry.path), ["docs/plans/reports/diagram.png", "docs/plans/reports/slice.md"]);
  assert.deepEqual(await readFile(scoped(place.store, "plans/reports/diagram.png")), image, "the moved file keeps its exact bytes");
  assert.equal(await exists(path.join(api, "docs/plans/reports/diagram.png")), false);
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
