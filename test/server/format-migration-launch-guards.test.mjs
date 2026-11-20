import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT, write } from "./fixtures/artifact-formats.mjs";
import { readRun, runCheckout, runFor, waitFor } from "./fixtures/format-migration-runs.mjs";

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

test("a run's Claude Code session has only the reading tools, git log, and Prism's tools, and denies the rest", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await runCheckout(context, BROKEN);
  await running(call, await runFor(call, PATHS.requirements));
  const [started] = await waitFor(() => hosts.runs("claude").length ? hosts.runs("claude") : null, { what: "the Claude Code stub" });
  const after = (flag) => started.argv[started.argv.indexOf(flag) + 1];
  assert.equal(after("--permission-mode"), "dontAsk");
  assert.equal(after("--tools"), "Read,Grep,Glob,Bash");
  assert.equal(after("--allowedTools"), "Read,Grep,Glob,Bash(git log:*),mcp__plugin_prism_prism-review__*");
  assert.equal(started.argv.includes("auto"), false);
});

test("a run's Codex thread runs in the read-only sandbox", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await runCheckout(context, BROKEN, { hosts: ["codex"] });
  await running(call, await runFor(call, PATHS.requirements));
  const [started] = await waitFor(() => hosts.runs("codex").length ? hosts.runs("codex") : null, { what: "the Codex stub" });
  const thread = await waitFor(() => hosts.inputs(started.pid).find((message) => message.method === "thread/start") ?? null, { what: "the thread start" });
  assert.equal(thread.params.sandbox, "read-only");
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
