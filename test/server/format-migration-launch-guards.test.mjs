import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONFORMING, PATHS, REQUIREMENT, write } from "./fixtures/artifact-formats.mjs";
import { COMPONENTS, STORE_PATHS } from "./fixtures/artifact-formats-store.mjs";
import { listedTools, readRun, runCheckout, runFor, serve, stubHosts, waitFor } from "./fixtures/format-migration-runs.mjs";
import { checkout, isolateGit, syncedWorkspace } from "./fixtures/workspace-artifacts.mjs";

// A run's session reads only, an artifact has at most one open run, and a run whose owner is gone fails so that it can run again.
// Every host here is a stub on a PATH that holds no real Claude Code or Codex.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const BROKEN = { ...CONFORMING, [PATHS.requirements]: UNANCHORED };
const running = (call, run) => waitFor(async () => {
  const record = await readRun(call, run);
  return record.status === "running" ? record : null;
}, { what: `the run ${run} to run` });
const launchRecord = async (hosts, id) => JSON.parse(await readFile(path.join(hosts.app, "launches", id, "launch.json"), "utf8"));
const PRISM_ROOT = await realpath(fileURLToPath(new URL("../..", import.meta.url)));
const RUN_TOOLS = ["get_migration_run", "get_artifact", "propose_migration", "finish_migration_run", "fail_migration_run"];

test("a run's Claude Code session works in its own folder with only the reading tools and the run's Prism tools, reads only in its folders, and denies the rest", { skip: posixOnly }, async (context) => {
  const { root, call, hosts } = await runCheckout(context, BROKEN);
  const run = await runFor(call, PATHS.requirements);
  await running(call, run);
  const [started] = await waitFor(() => hosts.runs("claude").length ? hosts.runs("claude") : null, { what: "the Claude Code stub" });
  const after = (flag) => started.argv[started.argv.indexOf(flag) + 1];
  assert.equal(after("--permission-mode"), "dontAsk");
  assert.equal(after("--tools"), "Read,Grep,Glob");
  // No bare Read, Grep, or Glob is allowed, so a read outside the working folder and the added folders asks, and nothing asks.
  assert.equal(after("--allowedTools"), RUN_TOOLS.map((tool) => `mcp__plugin_prism_prism-review__${tool}`).join(","));
  const added = started.argv.slice(started.argv.indexOf("--add-dir") + 1, started.argv.indexOf("--permission-mode"));
  assert.ok(added.includes(PRISM_ROOT), "Prism's own folder, which holds the format references, is readable");
  assert.ok(added.every((folder) => path.isAbsolute(folder) && folder !== os.homedir()), `only fixed folders are added: ${added}`);
  const checkout = await realpath(root);
  const launch = await launchRecord(hosts, (await readRun(call, run)).launch.id);
  assert.equal(started.cwd, launch.workdir, "the session works in its launch's own folder");
  assert.equal(launch.checkout, checkout, "the launch still names the checkout");
  assert.equal(path.basename(started.cwd), launch.id, "the folder is named by the launch alone");
  assert.equal(started.argv.includes("auto"), false);
  assert.equal(started.env.PRISM_MIGRATION_RUN, run, "the session's Prism server serves the run only");
  assert.equal(started.env.PRISM_MIGRATION_PROJECT, checkout, "and takes its project from the launch");
});

test("a run's Codex thread runs in the read-only sandbox, readable only in its folders, and never asks to leave it", { skip: posixOnly }, async (context) => {
  const { root, call, hosts } = await runCheckout(context, BROKEN, { hosts: ["codex"] });
  const run = await runFor(call, PATHS.requirements);
  await running(call, run);
  const [started] = await waitFor(() => hosts.runs("codex").length ? hosts.runs("codex") : null, { what: "the Codex stub" });
  const thread = await waitFor(() => hosts.inputs(started.pid).find((message) => message.method === "thread/start") ?? null, { what: "the thread start" });
  assert.equal(thread.params.sandbox, "read-only");
  assert.equal(thread.params.approvalPolicy, "never");
  assert.equal("approvalsReviewer" in thread.params, false, "no automatic reviewer lets a command out of the sandbox");
  const turn = await waitFor(() => hosts.inputs(started.pid).find((message) => message.method === "turn/start") ?? null, { what: "the turn start" });
  const { type, access } = turn.params.sandboxPolicy;
  assert.equal(type, "readOnly");
  assert.equal(access.type, "restricted");
  const launch = await launchRecord(hosts, (await readRun(call, run)).launch.id);
  assert.equal(thread.params.cwd, launch.workdir);
  assert.equal(access.readableRoots[0], launch.workdir);
  assert.ok(access.readableRoots.includes(PRISM_ROOT));
  assert.equal(access.readableRoots.includes(await realpath(root)), false);
  assert.equal(started.env.PRISM_MIGRATION_RUN, run);
  assert.equal(started.env.PRISM_MIGRATION_PROJECT, await realpath(root));
});

test("a Prism server that a run's session starts lists and takes only the run's tools, for that run and its artifacts", { skip: posixOnly }, async (context) => {
  const { root, call, hosts } = await runCheckout(context, BROKEN, { hosts: [] });
  const run = await runFor(call, PATHS.requirements);
  const listed = Object.keys(await listedTools(context, root, { PRISM_MIGRATION_RUN: run }));
  assert.deepEqual(listed.sort(), [...RUN_TOOLS].sort());
  assert.ok(Object.keys(await listedTools(context, root)).includes("update_artifact"), "an unscoped server lists every tool");
  const scoped = await serve(context, root, { ...hosts, env: { ...hosts.env, PRISM_MIGRATION_RUN: run } });
  assert.equal((await scoped("get_migration_run", { run })).value.run.id, run);
  for (const [name, args] of [
    ["update_artifact", { operations: [{ op: "write", path: PATHS.requirements, content: "x", expectedVersion: null }] }],
    ["update_roadmap", { operations: [] }],
    ["check_artifacts", {}],
    ["get_migration_run", { run: "run-0000000000000000" }],
    ["fail_migration_run", { run: "run-0000000000000000", reason: "other run" }],
    ["get_artifact", { path: "docs/plans/artifact-formats/slice.md" }],
    ["get_artifact", { path: `${path.posix.dirname(PATHS.requirements)}/../../outside.md` }]
  ]) {
    const answer = await scoped(name, args);
    assert.equal(answer.refused, true, `${name} ${JSON.stringify(args)} is refused`);
    assert.equal(answer.value.code, "migration_scope", `${name} ${JSON.stringify(args)}: ${answer.text}`);
  }
  // A read of the run's own artifact passes the scope, and the checkout's own answer follows.
  assert.notEqual((await scoped("get_artifact", { path: PATHS.requirements })).value?.code, "migration_scope");
  assert.equal((await readRun(call, run)).status, "waiting-for-host", "nothing the scope refused changed the run");
});

test("a newer nonconforming version of an artifact ends its open run and stops its session, so one run and one session hold it", { skip: posixOnly }, async (context) => {
  const { root, call, hosts } = await runCheckout(context, BROKEN, { plans: { claude: [{ hold: "forever" }] } });
  const first = await runFor(call, PATHS.requirements);
  const before = await running(call, first);
  await write(root, PATHS.requirements, `${UNANCHORED}\nOne more sentence.\n`);
  const second = await waitFor(async () => {
    const entry = (await call("check_artifacts", {})).value.artifacts.find((artifact) => artifact.path === PATHS.requirements);
    return entry?.migration && entry.migration.run !== first ? entry.migration.run : null;
  }, { what: "the run of the new version" });
  const ended = await readRun(call, first);
  assert.equal(ended.status, "failed");
  assert.match(ended.failure.reason, /changed into a newer version that breaks its format/);
  await running(call, second);
  await waitFor(async () => (await launchRecord(hosts, before.launch.id)).runs.at(-1).endedAt ? true : null, { what: "the first run's session to stop", ms: 20000 });
  await call("check_artifacts", {});
  assert.equal(hosts.runs("claude").length, 2, "no third session starts");
});

test("a run whose session's supervisor is gone fails at the next check, so it can run again", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await runCheckout(context, BROKEN, { plans: { claude: [{ hold: "forever" }] } });
  const run = await runFor(call, PATHS.requirements);
  const record = await running(call, run);
  const launch = await launchRecord(hosts, record.launch.id);
  for (const pid of [launch.runs.at(-1).supervisorPid, launch.runs.at(-1).hostPid]) try { process.kill(pid, "SIGKILL"); } catch {}
  await waitFor(async () => {
    await call("check_artifacts", {});
    return (await readRun(call, run)).status === "failed" || null;
  }, { what: "the orphaned run to fail" });
  assert.equal((await readRun(call, run)).failure.reason, "The run's session ended before the run finished: Prism stopped supervising this session; its host process may still run.");
});

test("a run left starting without a launch past its lease fails at the next check, so it can run again", { skip: posixOnly }, async (context) => {
  const { root, call } = await runCheckout(context, BROKEN);
  const run = await runFor(call, PATHS.requirements);
  await running(call, run);
  // The starter's process ended before it launched the session: the record says starting, with no launch, since ten minutes.
  const { readRun: storedRun, writeRun } = await import("../../dist/server/workflow/migration-runs.mjs");
  const { launch, ...record } = await storedRun(root, run);
  await writeRun(root, { ...record, status: "starting", startedAt: new Date(Date.now() - 10 * 60000).toISOString() });
  await call("check_artifacts", {});
  const failed = await readRun(call, run);
  assert.equal(failed.status, "failed");
  assert.match(failed.failure.reason, /^The run's session never started: /);
});

test("two machines that see one waiting run in a synced store launch it once", { skip: posixOnly, timeout: 240000 }, async (context) => {
  await isolateGit();
  const place = await syncedWorkspace(context);
  const options = { paths: [...STORE_PATHS], components: [...COMPONENTS] };
  const rootA = await checkout(place.a, "api", { ...options, files: { ...CONFORMING, [PATHS.requirements]: UNANCHORED } });
  const callA = await serve(context, rootA, await stubHosts(context, { hosts: [] }));
  const run = await runFor(callA, PATHS.requirements);
  await waitFor(async () => (await readRun(callA, run)).status === "waiting-for-host" || null, { what: "the run to wait for a host" });
  const elsewhere = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-machine-b-")));
  context.after(() => rm(elsewhere, { recursive: true, force: true }));
  const rootB = await checkout({ ...place.b, parent: elsewhere, storeSetting: place.storeB }, "api", options);
  const [hostsA, hostsB] = [await stubHosts(context), await stubHosts(context)];
  // Two machines with a host each, the first a second checkout of the first store clone, check at the same moment.
  const [callA2, callB] = [await serve(context, rootA, hostsA), await serve(context, rootB, hostsB)];
  await Promise.all([callA2("check_artifacts", {}), callB("check_artifacts", {})]);
  await waitFor(async () => (await readRun(callA2, run)).status === "running" || null, { what: "the run to launch", ms: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(hostsA.runs("claude").length + hostsB.runs("claude").length, 1, "one session of the run starts");
});
