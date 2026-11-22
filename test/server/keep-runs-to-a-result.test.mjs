import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";

// headless-run-questions §11 and §12: Claude Code's Stop hook keeps a launched run's turn from ending without a result once,
// and lets every other stop end.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOOK = path.join(ROOT, "dist/hooks/keep-runs-to-a-result.mjs");
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-turn-check-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

const hookModule = () => import("../../dist/hooks/keep-runs-to-a-result.mjs");
const stateModule = () => import("../../dist/server/workflow/state.mjs");

// A launched run that holds its turn, so its launch record stays running while the hook is called as Claude Code would call it.
async function running(t, host = "claude-code") {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: "forever" }], codex: [{ hold: "forever" }] } });
  const { startLaunch } = await import("../../dist/server/session/launched-sessions.mjs");
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host, env: fixture.env });
  const [run] = await waitFor(() => fixture.runs(host === "codex" ? "codex" : "claude").length ? fixture.runs(host === "codex" ? "codex" : "claude") : null, { what: "the stub to start" });
  const sessionId = host === "codex" ? "01a1c2bc-3a0f-7690-9e2f-4d3f9be316a4" : run.argv[3];
  return { fixture, id: launch.id, sessionId };
}
const stop = (sessionId, root, extra = {}) => ({ hook_event_name: "Stop", session_id: sessionId, cwd: root, stop_hook_active: false, last_assistant_message: "Should I park the roadmap entry or supersede it?", background_tasks: [], ...extra });
async function decide(environment, input) {
  const { keepRunsToAResult } = await hookModule();
  return keepRunsToAResult({ input: Readable.from([JSON.stringify(input)]), environment });
}

test("§11 a launched Claude Code run that ends its turn without a result is kept going once with the turn check's reason", { skip: posixOnly }, async (t) => {
  const { fixture, id, sessionId } = await running(t);
  const { TURN_CHECK_REASON } = await hookModule();
  for (const phrase of ["no person reads", "update_coordination_state", "wait_for_user_gate", "checkpoint_pause", "continue"]) assert.ok(TURN_CHECK_REASON.includes(phrase), `the reason names ${phrase}`);
  const output = await decide({ ...fixture.env, PRISM_LAUNCH: id }, stop(sessionId, fixture.root));
  assert.deepEqual(output, { decision: "block", reason: TURN_CHECK_REASON });
});

test("§11 the turn ends while the run has a result: an open gate of the initiative or a pause the run recorded", { skip: posixOnly }, async (t) => {
  const { fixture, id, sessionId } = await running(t);
  // The pause is written as the run's own server writes it, with this fixture's machine folders as its environment.
  fixture.useAsProcessEnv();
  const { readCoordinationState, updateCoordinationState, checkpointPause } = await stateModule();
  await updateCoordinationState({ projectRoot: fixture.root, initiative: INITIATIVE, expectedRevision: null, changes: { activeOperations: [{ op: "start", entry: { slice: INITIATIVE, activity: "design", workers: ["designer-1"], workspace: fixture.root } }] } });
  const read = await readCoordinationState({ projectRoot: fixture.root, initiative: INITIATIVE });
  process.env.PRISM_LAUNCH = id;
  try {
    await checkpointPause({ projectRoot: fixture.root, initiative: INITIATIVE, expectedRevision: read.revision, activeSlice: INITIATIVE, recoveryContent: "Next: run implement again.", changes: { next: ["Run implement again."] } });
  } finally {
    delete process.env.PRISM_LAUNCH;
  }
  assert.equal(await decide({ ...fixture.env, PRISM_LAUNCH: id }, stop(sessionId, fixture.root)), null, "a pause recorded in the run is a result");

  const gated = await running(t);
  await updateCoordinationState({ projectRoot: gated.fixture.root, initiative: INITIATIVE, expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "assistance", question: "Install the signing key.", context: "The export signs files with a key that only you can install.", artifacts: [] }] } });
  assert.equal(await decide({ ...gated.fixture.env, PRISM_LAUNCH: gated.id }, stop(gated.sessionId, gated.fixture.root)), null, "an open gate is a result");
});

test("§12 a stop directly after a block, a stop while a background task runs, and a stop of a session that is not this launch's all end", { skip: posixOnly }, async (t) => {
  const { fixture, id, sessionId } = await running(t);
  const env = { ...fixture.env, PRISM_LAUNCH: id };
  assert.equal(await decide(env, stop(sessionId, fixture.root, { stop_hook_active: true })), null, "one reminder only");
  assert.equal(await decide(env, stop(sessionId, fixture.root, { background_tasks: [{ id: "t1", type: "mcp_task", status: "running", description: "wait_for_user_gate" }] })), null, "the run goes on when the task ends");
  assert.equal(await decide(env, stop("11111111-2222-4333-8444-555555555555", fixture.root)), null, "another session, such as a child agent's");
  assert.equal(await decide({ ...fixture.env }, stop(sessionId, fixture.root)), null, "a session that Prism did not launch");
  assert.equal(await decide({ ...fixture.env, PRISM_LAUNCH: "launch-0000000000000000" }, stop(sessionId, fixture.root)), null, "a launch that does not exist here");
  assert.deepEqual(Object.keys(await decide(env, stop(sessionId, fixture.root, { background_tasks: [{ id: "t1", type: "local_bash", status: "completed" }] })) ?? {}), ["decision", "reason"], "an ended task does not count");
});

test("§12 a launched Codex session is never kept going", { skip: posixOnly }, async (t) => {
  const { fixture, id, sessionId } = await running(t, "codex");
  assert.equal(await decide({ ...fixture.env, PRISM_LAUNCH: id }, stop(sessionId, fixture.root)), null);
});

test("§11 §12 the hook is registered for Stop in the plugin's hooks, writes the block as JSON, and writes nothing for bad input", { skip: posixOnly }, async (t) => {
  const hooks = JSON.parse(await readFile(path.join(ROOT, "hooks/hooks.json"), "utf8"));
  const commands = hooks.hooks.Stop.flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(commands.some((command) => command.includes("dist/hooks/keep-runs-to-a-result.mjs")));
  const { fixture, id, sessionId } = await running(t);
  const run = (input, env) => new Promise((resolve) => {
    const child = execFile(process.execPath, [HOOK], { env, cwd: fixture.root }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout }));
    child.stdin.end(input);
  });
  const blocked = await run(JSON.stringify(stop(sessionId, fixture.root)), { ...fixture.env, PRISM_LAUNCH: id });
  assert.equal(blocked.code, 0);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  const broken = await run("{ not json", { ...fixture.env, PRISM_LAUNCH: id });
  assert.deepEqual(broken, { code: 0, stdout: "" });
});
