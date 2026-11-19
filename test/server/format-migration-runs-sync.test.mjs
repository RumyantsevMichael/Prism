import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { COMPONENTS, STORE_PATHS } from "./fixtures/artifact-formats-store.mjs";
import { readRun, runFor, serve, stubHosts } from "./fixtures/format-migration-runs.mjs";
import { checkout, isolateGit, syncedWorkspace } from "./fixtures/workspace-artifacts.mjs";

// Format migration runs of a store whose sync is on: a run is confirmed with the store's remote, so another machine names the same run,
// and an applied run is pushed as a commit of its own that holds only its artifact's files.

const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const remoteGit = (remote, ...args) => execFileSync("git", args, { cwd: remote, encoding: "utf8" });

test("a synced store's run is the one run of its set on both machines, and its apply is pushed as a commit of its own", { timeout: 240000 }, async (context) => {
  await isolateGit();
  const place = await syncedWorkspace(context);
  const hosts = await stubHosts(context);
  const options = { paths: [...STORE_PATHS], components: [...COMPONENTS] };
  const rootA = await checkout(place.a, "api", { ...options, files: { ...CONFORMING, [PATHS.requirements]: UNANCHORED } });
  const callA = await serve(context, rootA, hosts);
  const run = await runFor(callA, PATHS.requirements);
  // The other machine's checkout of the same repository lives in a folder of its own and names its store clone by its absolute path.
  const elsewhere = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-machine-b-")));
  context.after(() => rm(elsewhere, { recursive: true, force: true }));
  const rootB = await checkout({ ...place.b, parent: elsewhere, storeSetting: place.storeB }, "api", options);
  const callB = await serve(context, rootB, hosts);
  assert.equal(await runFor(callB, PATHS.requirements), run, "the other machine names the run that the first one recorded");
  const proposed = await callA("propose_migration", { run, type: "requirements", source: PATHS.requirements, target: PATHS.requirements, content: REQUIREMENT, summary: "Adds the anchor of section 2.", leftovers: [] });
  assert.equal(proposed.refused, false, proposed.text);
  assert.equal((await callA("finish_migration_run", { run })).refused, false);
  assert.equal((await readRun(callA, run)).status, "applied");
  const commit = remoteGit(place.remote, "log", "main", "--format=%H", "--grep", `prism: format migration ${run}`).trim().split("\n")[0];
  assert.ok(commit, "the run's commit reached the remote");
  const files = remoteGit(place.remote, "show", "--name-only", "--format=", commit).split("\n").filter(Boolean);
  assert.ok(files.length > 0 && files.every((file) => file.includes("retries")), files.join(", "));
});
