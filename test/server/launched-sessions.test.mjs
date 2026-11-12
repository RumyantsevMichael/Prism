import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CODEX_THREAD, FOREIGN_SESSION, INITIATIVE, LAUNCH_ID, STRIPPED, UUID_V4, launchFixture, processesNaming, stubBin, waitFor } from "./fixtures/launched-sessions.mjs";
import { actionProject } from "./fixtures/review-actions.mjs";

// The launched-session module: finding the hosts, starting a supervised headless session, reading its state from the host's
// stream and exit, resuming it, and keeping it on this machine only. Stub executables stand in for claude and codex.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "process supervision is checked on POSIX here" : false;

const module = () => import("../../dist/server/session/launched-sessions.mjs");
const CLAUDE_FLAGS = ["--input-format", "stream-json", "--output-format", "stream-json", "--permission-mode", "auto", "--permission-prompts", "none"];
const claudeArgs = (flag, id) => ["-p", "--verbose", flag, id, ...CLAUDE_FLAGS];
const prompt = (initiative) => ({ type: "user", message: { role: "user", content: `/prism:orchestrate ${initiative}` } });
const CODEX_POLICY = { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" };
const methods = (messages) => messages.filter((message) => message.method).map((message) => message.method);
const request = (messages, method) => messages.find((message) => message.method === method) ?? null;

async function viewOf(fixture, id, now = undefined) {
  const { listLaunches } = await module();
  const { launches } = await listLaunches({ projectRoot: fixture.root, env: fixture.env, ...(now === undefined ? {} : { now }) });
  return launches.find((launch) => launch.id === id) ?? null;
}

const settledIn = (fixture, id, states) => waitFor(async () => {
  const view = await viewOf(fixture, id);
  return view && states.includes(view.state) ? view : null;
}, { what: `launch ${id} to reach ${states.join(" or ")}` });

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}

test("each host is unavailable with its reason while its executable is not on PATH, and available with its path when it is", async (t) => {
  const { hostAvailability } = await module();
  const empty = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-empty-")));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.deepEqual(await hostAvailability({ env: { PATH: empty } }), [
    { host: "claude-code", label: "Claude Code", available: false, executable: null, reason: "Claude Code was not found: no claude executable on PATH." },
    { host: "codex", label: "Codex", available: false, executable: null, reason: "Codex was not found: no codex executable on PATH." }
  ]);
  // Windows finds an executable by its extension, so there the host is codex.exe.
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const bin = await stubBin(t, [name]);
  const listed = await hostAvailability({ env: { PATH: `${empty}${path.delimiter}${bin}` } });
  assert.equal(listed[0].available, false);
  assert.deepEqual(listed[1], { host: "codex", label: "Codex", available: true, executable: path.join(bin, name), reason: null });
});

test("a Claude Code launch sends the orchestrate prompt as a stream-json message, with a session id Prism chose, the fixed flags, the checkout as folder, and no foreign session variables", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 1500 }] } });
  const { startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  assert.match(launch.id, LAUNCH_ID);
  assert.equal(launch.initiative, INITIATIVE);
  assert.equal(launch.host, "claude-code");
  assert.equal(launch.hostLabel, "Claude Code");
  assert.equal(launch.checkout, fixture.root);
  assert.equal(launch.state, "running");
  assert.equal(launch.runs, 1);
  assert.equal(launch.resumeCommand, null);
  assert.ok(Math.abs(Date.parse(launch.launchedAt) - Date.now()) < 10000);
  const [run] = await waitFor(() => fixture.runs("claude").length ? fixture.runs("claude") : null, { what: "the stub to start" });
  assert.match(run.argv[3], UUID_V4);
  assert.deepEqual(run.argv, claudeArgs("--session-id", run.argv[3]));
  assert.equal(run.cwd, fixture.root);
  assert.equal(run.env.PRISM_LAUNCH, launch.id);
  assert.equal(run.env.PRISM_STUB_MARKER, "kept");
  for (const name of STRIPPED) assert.equal(run.env[name], null, `${name} must not reach the launched host`);
  const finished = await settledIn(fixture, launch.id, ["finished"]);
  assert.deepEqual(fixture.inputs(run.pid), [prompt(INITIATIVE)], "the prompt is the only message, and no interrupt was sent");
  assert.deepEqual(fixture.closed(run.pid), { results: 1, interrupted: false }, "the input closed once the turn ended");
  assert.deepEqual(finished.resumeCommand, { command: `claude --resume ${run.argv[3]}`, cwd: fixture.root });
  assert.deepEqual(finished.exit, { code: 0, signal: null });
  assert.equal(finished.reason, null);
  assert.ok(finished.runningMs >= 1000, `runningMs ${finished.runningMs} covers the run`);
});

test("a Codex launch runs app-server, starts a thread with the automatic review policy and one orchestrate turn, and keeps the thread id it answers", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { codex: [{ hold: 200 }] } });
  const { startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "codex", env: fixture.env });
  const finished = await settledIn(fixture, launch.id, ["finished"]);
  const [run] = fixture.runs("codex");
  assert.deepEqual(run.argv, ["app-server"]);
  const messages = fixture.inputs(run.pid);
  assert.deepEqual(methods(messages), ["initialize", "initialized", "thread/start", "turn/start"]);
  for (const message of messages) assert.equal(message.jsonrpc, "2.0");
  const ids = messages.filter((message) => message.id !== undefined).map((message) => message.id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, "each request has its own id");
  assert.equal(request(messages, "initialized").id, undefined, "initialized is a notification");
  assert.deepEqual(request(messages, "initialize").params, { clientInfo: { name: "prism-launch", version: "1" }, capabilities: { experimentalApi: true } });
  assert.deepEqual(request(messages, "thread/start").params, { cwd: fixture.root, ...CODEX_POLICY });
  assert.deepEqual(request(messages, "turn/start").params, { threadId: CODEX_THREAD, input: [{ type: "text", text: `$prism:orchestrate ${INITIATIVE}` }] });
  assert.deepEqual(fixture.closed(run.pid), { results: 1, interrupted: false }, "the input closed once the turn completed");
  assert.deepEqual(finished.exit, { code: 0, signal: null });
  assert.equal(run.cwd, fixture.root);
  assert.equal(run.env.PRISM_LAUNCH, launch.id);
  for (const name of STRIPPED) assert.equal(run.env[name], null, `${name} must not reach the launched host`);
  assert.equal(finished.hostLabel, "Codex");
  assert.deepEqual(finished.resumeCommand, { command: `codex resume ${CODEX_THREAD}`, cwd: fixture.root });
});

test("a second launch of an initiative is refused while one runs on this machine, and another initiative still launches", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: "forever" }], codex: [{ hold: "forever" }] } });
  const { startLaunch } = await module();
  await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  for (const host of ["claude-code", "codex"]) {
    const refused = await rejection(startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host, env: fixture.env }));
    assert.equal(refused.code, "launch_running");
    assert.equal(refused.message, `A launched session of ${INITIATIVE} is running on this machine.`);
  }
  assert.equal(fixture.runs().length, 1);
  // The fixture's roadmap also lists the initiative search.
  const other = await startLaunch({ projectRoot: fixture.root, initiative: "search", host: "codex", env: fixture.env });
  assert.equal(other.launch.state, "running");
});

test("a launch names an unknown host, an unknown initiative, or a missing host with its own refusal and starts nothing", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { hosts: ["codex"] });
  const { startLaunch } = await module();
  assert.equal((await rejection(startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "gemini", env: fixture.env }))).code, "unknown_host");
  assert.equal((await rejection(startLaunch({ projectRoot: fixture.root, initiative: "no-such-initiative", host: "codex", env: fixture.env }))).code, "unknown_initiative");
  assert.equal((await rejection(startLaunch({ projectRoot: fixture.root, initiative: "../escape", host: "codex", env: fixture.env }))).code, "unknown_initiative");
  const missing = await rejection(startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env }));
  assert.equal(missing.code, "host_unavailable");
  assert.equal(missing.message, "Claude Code was not found: no claude executable on PATH.");
  assert.equal(fixture.runs().length, 0);
  const { listLaunches } = await module();
  assert.deepEqual((await listLaunches({ projectRoot: fixture.root, env: fixture.env })).launches, []);
});

test("a run that the host refused an action in ends blocked with the host's reason", { skip: posixOnly }, async (t) => {
  const reason = "Auto mode could not evaluate this action and is blocking it for safety.";
  const fixture = await launchFixture(t, { plans: { claude: [{ denials: [{ tool: "Bash", reason }, { tool: "Write", reason: "Denied." }] }], codex: [{ declined: ["/bin/bash -lc 'touch /etc/hosts'"] }] } });
  const { startLaunch } = await module();
  const claude = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const blocked = await settledIn(fixture, claude.launch.id, ["blocked"]);
  assert.equal(blocked.reason, `Claude Code refused Bash: ${reason} (and 1 more)`);
  assert.deepEqual(blocked.exit, { code: 0, signal: null });
  assert.ok(blocked.resumeCommand);
  const codex = await startLaunch({ projectRoot: fixture.root, initiative: "search", host: "codex", env: fixture.env });
  const declined = await settledIn(fixture, codex.launch.id, ["blocked"]);
  assert.equal(declined.reason, "Codex refused commandExecution: Codex declined: /bin/bash -lc 'touch /etc/hosts'");
});

test("a host that exits with an error or reports one ends failed with its exit status and last error line", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ exit: 3, stderr: "first line\nError: Session ID is already in use." }], codex: [{ failed: true }] } });
  const { startLaunch } = await module();
  const crashed = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const failed = await settledIn(fixture, crashed.launch.id, ["failed"]);
  assert.equal(failed.reason, "Claude Code ended with exit code 3. Error: Session ID is already in use.");
  assert.deepEqual(failed.exit, { code: 3, signal: null });
  const reported = await startLaunch({ projectRoot: fixture.root, initiative: "search", host: "codex", env: fixture.env });
  const failedTurn = await settledIn(fixture, reported.launch.id, ["failed"]);
  assert.equal(failedTurn.reason, "Codex reported an error: The model stream ended.");
  assert.deepEqual(failedTurn.exit, { code: 0, signal: null });
});

test("a reported host error is the failure's reason whatever the process's exit code", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ isError: true }, { isError: true, exit: 1 }] } });
  const { resumeLaunch, startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const failed = await settledIn(fixture, launch.id, ["failed"]);
  assert.equal(failed.reason, "Claude Code reported an error: The API returned an error.");
  await resumeLaunch({ id: launch.id, env: fixture.env, cause: "person" });
  const again = await waitFor(async () => {
    const view = await viewOf(fixture, launch.id);
    return view?.runs === 2 && view.state === "failed" ? view : null;
  }, { what: "the second run to fail" });
  assert.deepEqual(again.exit, { code: 1, signal: null });
  assert.equal(again.reason, "Claude Code reported an error: The API returned an error.");
});

test("a Claude Code run keeps its input open while a background task it reported runs, and closes it after the turn that follows", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 100, background: 1200 }] } });
  const { startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const [run] = await waitFor(() => fixture.runs("claude").length ? fixture.runs("claude") : null, { what: "the stub to start" });
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(fixture.closed(run.pid), null, "the input stays open while the background task runs");
  assert.equal((await viewOf(fixture, launch.id)).state, "running");
  const finished = await settledIn(fixture, launch.id, ["finished"]);
  assert.deepEqual(fixture.closed(run.pid), { results: 2, interrupted: false });
  assert.deepEqual(finished.exit, { code: 0, signal: null });
});

test("a Codex run answers every request the host sends it with an error, so Prism grants nothing", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { codex: [{ hold: 400, askApproval: true }] } });
  const { startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "codex", env: fixture.env });
  await settledIn(fixture, launch.id, ["finished"]);
  const [run] = fixture.runs("codex");
  const answers = fixture.inputs(run.pid).filter((message) => message.id === "approval-1");
  assert.deepEqual(answers, [{ jsonrpc: "2.0", id: "approval-1", error: { code: -32601, message: "Prism answers no host requests." } }]);
});

test("a session whose supervisor disappears shows failed instead of running", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: "forever" }] } });
  const { startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const supervisors = processesNaming(path.join(fixture.app, "launches", launch.id));
  assert.equal(supervisors.length, 1, "one supervisor names the launch folder on its command line");
  process.kill(supervisors[0], "SIGKILL");
  const lost = await settledIn(fixture, launch.id, ["failed"]);
  assert.equal(lost.reason, "Prism stopped supervising this session; its host process may still run.");
  assert.equal(lost.exit, null);
});

test("a launched session keeps running and is listed after the process that started it exits", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 3000 }] } });
  const script = `const { startLaunch } = await import(${JSON.stringify(new URL("../../dist/server/session/launched-sessions.mjs", import.meta.url).href)});
const { launch } = await startLaunch({ projectRoot: ${JSON.stringify(fixture.root)}, initiative: ${JSON.stringify(INITIATIVE)}, host: "claude-code", env: JSON.parse(process.env.LAUNCH_ENV) });
process.stdout.write(launch.id); process.exit(0);`;
  const id = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...fixture.env, LAUNCH_ENV: JSON.stringify(fixture.env) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("exit", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`the starter exited with ${code}: ${err}`)));
  });
  assert.match(id, LAUNCH_ID);
  const running = await viewOf(fixture, id);
  assert.equal(running.state, "running");
  const finished = await settledIn(fixture, id, ["finished"]);
  assert.deepEqual(finished.exit, { code: 0, signal: null });
});

test("a resume runs the same host session again with the resume form of the same flags, and counts every run's time", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 300 }, { hold: 300 }], codex: [{ hold: 100 }, { hold: 100 }] } });
  const { resumeLaunch, startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const first = await settledIn(fixture, launch.id, ["finished"]);
  const resumed = await resumeLaunch({ id: launch.id, env: fixture.env, cause: "person" });
  assert.equal(resumed.state, "running");
  assert.equal(resumed.runs, 2);
  assert.equal(resumed.launchedAt, first.launchedAt);
  const again = await settledIn(fixture, launch.id, ["finished"]);
  assert.ok(again.runningMs >= first.runningMs + 250);
  const [original, second] = fixture.runs("claude");
  assert.deepEqual(second.argv, claudeArgs("--resume", original.argv[3]));
  assert.deepEqual(fixture.inputs(second.pid), [prompt(INITIATIVE)]);
  assert.equal(second.env.PRISM_LAUNCH, launch.id);
  const codex = await startLaunch({ projectRoot: fixture.root, initiative: "search", host: "codex", env: fixture.env });
  await settledIn(fixture, codex.launch.id, ["finished"]);
  await resumeLaunch({ id: codex.launch.id, env: fixture.env, cause: "person" });
  await settledIn(fixture, codex.launch.id, ["finished"]);
  const resumedCodex = fixture.runs("codex")[1];
  assert.deepEqual(resumedCodex.argv, ["app-server"]);
  const messages = fixture.inputs(resumedCodex.pid);
  assert.deepEqual(methods(messages), ["initialize", "initialized", "thread/resume", "turn/start"]);
  assert.deepEqual(request(messages, "thread/resume").params, { threadId: CODEX_THREAD, cwd: fixture.root, ...CODEX_POLICY });
  assert.deepEqual(request(messages, "turn/start").params, { threadId: CODEX_THREAD, input: [{ type: "text", text: "$prism:orchestrate search" }] });
});

test("a resume is refused while the session runs, for an unknown launch, and for a Codex session whose thread never started", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: "forever" }], codex: [{ threadId: null, exit: 1 }] } });
  const { resumeLaunch, startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  assert.equal((await rejection(resumeLaunch({ id: launch.id, env: fixture.env, cause: "person" }))).code, "launch_running");
  assert.equal((await rejection(resumeLaunch({ id: "launch-0000000000000000", env: fixture.env, cause: "person" }))).code, "unknown_launch");
  const codex = await startLaunch({ projectRoot: fixture.root, initiative: "search", host: "codex", env: fixture.env });
  const failed = await settledIn(fixture, codex.launch.id, ["failed"]);
  assert.equal(failed.reason, "Codex reported an error: The thread could not start.");
  assert.deepEqual(failed.exit, { code: 1, signal: null });
  assert.equal(failed.resumeCommand, null);
  assert.equal((await rejection(resumeLaunch({ id: codex.launch.id, env: fixture.env, cause: "person" }))).code, "no_host_session");
  assert.equal(fixture.runs("codex").length, 1);
});

test("the host session id stays in the private launch folder and never in the project's records", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 100 }] } });
  const { startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  await settledIn(fixture, launch.id, ["finished"]);
  const sessionId = fixture.runs("claude")[0].argv[3];
  const folder = path.join(fixture.app, "launches", launch.id);
  assert.equal((await stat(folder)).mode & 0o077, 0, "the launch folder is private to the user");
  assert.equal((await stat(path.join(fixture.app, "launches"))).mode & 0o077, 0);
  const records = path.join(fixture.root, ".prism");
  const files = (await readdir(records, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  for (const entry of files) {
    const text = await readFile(path.join(entry.parentPath ?? entry.path, entry.name), "utf8");
    assert.ok(!text.includes(sessionId), `${entry.name} holds the host session id`);
  }
});

test("only launches whose checkout shares the page's record store are listed, and ended ones are removed after 14 days", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 50 }] } });
  const { listLaunches, startLaunch } = await module();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  await settledIn(fixture, launch.id, ["finished"]);
  const { root: other } = await actionProject(t, { gates: false });
  assert.deepEqual((await listLaunches({ projectRoot: other, env: fixture.env })).launches, []);
  assert.equal((await listLaunches({ projectRoot: fixture.root, env: fixture.env, now: Date.now() + 13 * 86400000 })).launches.length, 1);
  assert.equal((await listLaunches({ projectRoot: fixture.root, env: fixture.env, now: Date.now() + 15 * 86400000 })).launches.length, 0);
  assert.equal((await listLaunches({ projectRoot: fixture.root, env: fixture.env })).launches.length, 0, "the removed launch stays removed");
});

test("the foreign session variables of the fixture are the ones the contract strips", () => {
  assert.deepEqual(STRIPPED, Object.keys(FOREIGN_SESSION));
  assert.deepEqual(STRIPPED, ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CODEX_THREAD_ID"]);
});
