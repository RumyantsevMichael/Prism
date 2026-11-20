import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONFORMING, PATHS, REQUIREMENT, WORKFLOW, write } from "./fixtures/artifact-formats.mjs";
import { COMPONENTS, STORE_PATHS } from "./fixtures/artifact-formats-store.mjs";
import { listedTools, readRun, runCheckout, runFor, serve, stubHosts, waitFor } from "./fixtures/format-migration-runs.mjs";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
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
  assert.equal(after("--allowedTools"), RUN_TOOLS.map((tool) => `mcp__prism-run__${tool}`).join(","));
  // The session loads Prism's scoped server alone: no MCP server of the person's own configuration, no other plugin's, and no claude.ai connector.
  assert.ok(started.argv.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(after("--settings")), { disableClaudeAiConnectors: true });
  assert.equal(started.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  const mcp = JSON.parse(await readFile(after("--mcp-config"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["prism-run"]);
  assert.equal(mcp.mcpServers["prism-run"].args[0], path.join(PRISM_ROOT, "dist/server/mcp.mjs"));
  assert.deepEqual({ run: mcp.mcpServers["prism-run"].env.PRISM_MIGRATION_RUN, project: mcp.mcpServers["prism-run"].env.PRISM_MIGRATION_PROJECT }, { run, project: await realpath(root) });
  // Deny rules win over every allow rule and added folder, also those of the person's own settings, so no setting reads the checkout again.
  const real = await realpath(root);
  assert.equal(after("--disallowedTools"), `Read(/${real}),Read(/${real}/**)`);
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
  // The thread's configuration names Prism's scoped server as its only MCP server.
  assert.deepEqual(Object.keys(thread.params.config.mcp_servers), ["prism-run"]);
  assert.equal(thread.params.config.mcp_servers["prism-run"].env.PRISM_MIGRATION_RUN, run);
  assert.equal(thread.params.config.mcp_servers["prism-run"].env.PRISM_MIGRATION_PROJECT, await realpath(root));
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

/** A Prism server started in an empty folder outside the checkout, as a run's session starts it, scoped to the run and its project: its get_artifact. */
async function scopedRead(context, root, run) {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-folder-")));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const env = isolatedEnv({
    PRISM_REVIEW_APP: "off",
    PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)),
    CLAUDE_PROJECT_DIR: folder, PRISM_MIGRATION_RUN: run, PRISM_MIGRATION_PROJECT: root
  });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url))], { cwd: folder, env, stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const answers = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) answers.set(message.id, message);
  });
  let next = 1;
  const request = (method, params) => {
    const id = next++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return waitFor(() => answers.get(id) ?? null, { what: method });
  };
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "run-scope-test", version: "1" } });
  return async (file) => {
    const message = await request("tools/call", { name: "get_artifact", arguments: { path: file } });
    return { code: message.result?.structuredContent?.code ?? message.error?.data?.code ?? null, text: JSON.stringify(message) };
  };
}

test("the run's server serves only files of the set's type under its folder, never a dot-file, a dot-folder, or a link to one, also with a configured path of .", { skip: posixOnly }, async (context) => {
  const { root, call } = await runCheckout(context, BROKEN, { hosts: [] });
  const run = await runFor(call, PATHS.requirements);
  const secrets = { ".env": "TOKEN=env-secret\n", ".npmrc": "//registry.npmjs.org/:_authToken=npm-secret\n" };
  for (const [file, text] of Object.entries(secrets)) await writeFile(path.join(root, file), text);
  await mkdir(path.join(root, "docs/requirements/sub"), { recursive: true });
  await symlink("../../../.env", path.join(root, "docs/requirements/sub/link.md"));
  await writeFile(path.join(root, "docs/requirements/notes.txt"), "PLAIN=not-a-requirement\n");
  const read = await scopedRead(context, root, run);
  const refusedAll = async (files) => {
    for (const file of files) {
      const answer = await read(file);
      assert.equal(answer.code, "migration_scope", `${file}: ${answer.text}`);
      assert.doesNotMatch(answer.text, /secret|not-a-requirement/, file);
    }
  };
  await refusedAll(["docs/requirements/notes.txt", "docs/requirements/sub/link.md", "docs/requirements/../../.env", "./.env", ".prism/workflow.md"]);
  assert.equal((await read(PATHS.requirements)).code, null, "the run's own source is served");
  // With the requirements at the project root, only requirement files there are the type's; every dot-file, dot-folder, and other file stays refused.
  const config = path.join(root, ".prism/workflow.md");
  await writeFile(config, (await readFile(config, "utf8")).replace("- Requirements: docs/requirements/", "- Requirements: ."));
  await refusedAll([".env", ".npmrc", ".prism/workflow.md", ".git/config", "docs/requirements/sub/link.md", "docs/requirements/notes.txt", "package.json"]);
  assert.equal((await read(PATHS.requirements)).code, null, "the run's own source is still served");
});

test("a Windows checkout's deny rules name it as Claude Code matches Windows paths, and a path no rule can hold starts no session", async () => {
  const { deniedReads, hostArguments } = await import("../../dist/server/session/launch-hosts.mjs");
  assert.deepEqual(deniedReads("C:\\Users\\me\\api"), ["Read(//c/Users/me/api)", "Read(//c/Users/me/api/**)"]);
  assert.deepEqual(deniedReads("D:/work/api/"), ["Read(//d/work/api)", "Read(//d/work/api/**)"]);
  assert.deepEqual(deniedReads("/home/me/api"), ["Read(//home/me/api)", "Read(//home/me/api/**)"]);
  for (const folder of ["/home/me/a,b", "/home/me/[api]", "C:\\Users\\me\\a*b", "relative/api"]) assert.throws(() => deniedReads(folder), /cannot deny the reads/, folder);
  assert.throws(() => hostArguments({ host: "claude-code", hostSessionId: "s1", access: "read-only", deniedRoots: ["/home/me/api"] }), /no MCP configuration of its own/);
});

test("a run of artifacts under a configured dot-folder reads its own source, and still no dot-file or Git folder beside or below it", { skip: posixOnly }, async (context) => {
  const source = ".reqs/retries.md";
  const files = { ".prism/workflow.md": WORKFLOW.replace("- Requirements: docs/requirements/", "- Requirements: .reqs/"), [source]: UNANCHORED };
  const { root, call } = await runCheckout(context, files, { hosts: [] });
  const run = await runFor(call, source);
  await mkdir(path.join(root, ".reqs/.hidden"), { recursive: true });
  await writeFile(path.join(root, ".reqs/.env"), "TOKEN=env-secret\n");
  await writeFile(path.join(root, ".reqs/.hidden/note.md"), "# hidden secret\n");
  const read = await scopedRead(context, root, run);
  assert.equal((await read(source)).code, null, "the run's own source under .reqs/ is served");
  for (const file of [".reqs/.env", ".reqs/.hidden/note.md", ".git/config", ".prism/workflow.md", ".reqs/../.prism/workflow.md"]) {
    const answer = await read(file);
    assert.equal(answer.code, "migration_scope", `${file}: ${answer.text}`);
    assert.doesNotMatch(answer.text, /secret/, file);
  }
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
