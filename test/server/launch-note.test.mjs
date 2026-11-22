import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";
import { apply } from "./fixtures/acp-agents.mjs";
import { geminiWithReplies } from "./fixtures/acp-replies.mjs";

// headless-run-questions §1 and §2: every launched run, its launch and each resume, is told at its start that no person reads its
// messages: Claude Code and Codex through their own instruction channel while their prompt stays the orchestrate prompt, and an ACP
// agent, which has no such channel, through one more text block of the prompt that Prism composes for it.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-note-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

const hosts = () => import("../../dist/server/session/launch-hosts.mjs");
const sessions = () => import("../../dist/server/session/launched-sessions.mjs");
const CLAUDE_FLAGS = ["--input-format", "stream-json", "--output-format", "stream-json", "--permission-mode", "auto", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"];
const SESSION = "0b9c7d4e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
const valueAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];
// The note every check compares with, which must exist, so no check passes on two missing values.
async function note() {
  const { LAUNCH_NOTE } = await hosts();
  assert.equal(typeof LAUNCH_NOTE, "string", "launch-hosts exports LAUNCH_NOTE");
  return LAUNCH_NOTE;
}

test("§1 the start note says that no person reads the run's messages and that it asks only through a gate or decides by itself", async () => {
  const { LAUNCH_NOTE } = await hosts();
  assert.equal(typeof LAUNCH_NOTE, "string");
  assert.ok(LAUNCH_NOTE.trim().length > 0);
  for (const phrase of ["no person reads", "gate", "update_coordination_state", "wait_for_user_gate", "decide"]) {
    assert.ok(LAUNCH_NOTE.includes(phrase), `the note names ${phrase}`);
  }
  assert.match(LAUNCH_NOTE, /never end (?:a|your) turn with a question/i);
});

test("§2 Claude Code gets the note through --append-system-prompt directly after the fixed flags, in the launch and the resume form", async () => {
  const LAUNCH_NOTE = await note();
  const { hostArguments, claudePrompt } = await hosts();
  for (const [resume, flag] of [[false, "--session-id"], [true, "--resume"]]) {
    const argv = hostArguments({ host: "claude-code", hostSessionId: SESSION, resume });
    assert.deepEqual(argv.slice(0, 4 + CLAUDE_FLAGS.length), ["-p", "--verbose", flag, SESSION, ...CLAUDE_FLAGS]);
    assert.deepEqual(argv.slice(4 + CLAUDE_FLAGS.length, 6 + CLAUDE_FLAGS.length), ["--append-system-prompt", LAUNCH_NOTE]);
    assert.equal(argv.filter((value) => value === "--append-system-prompt").length, 1);
  }
  assert.deepEqual(claudePrompt(INITIATIVE), { type: "user", message: { role: "user", content: `/prism:orchestrate ${INITIATIVE}` } }, "the prompt stays as it is");
});

test("§2 Codex gets the note as developerInstructions of thread/start and thread/resume, and its turn keeps the orchestrate prompt", async () => {
  const LAUNCH_NOTE = await note();
  const { codexThreadRequest, codexTurnRequest } = await hosts();
  const start = codexThreadRequest({ checkout: "/work/reports", hostSessionId: null, resume: false });
  assert.equal(start.method, "thread/start");
  assert.equal(start.params.developerInstructions, LAUNCH_NOTE);
  const resume = codexThreadRequest({ checkout: "/work/reports", hostSessionId: "01a1c2bc-3a0f-7690-9e2f-4d3f9be316a4", resume: true });
  assert.equal(resume.method, "thread/resume");
  assert.equal(resume.params.developerInstructions, LAUNCH_NOTE);
  const turn = codexTurnRequest({ threadId: "thread-1", initiative: INITIATIVE });
  assert.deepEqual(turn.params.input, [{ type: "text", text: `$prism:orchestrate ${INITIATIVE}` }]);
  assert.equal(JSON.stringify(turn).includes(LAUNCH_NOTE), false, "the note is not part of the prompt");
});

test("§2 a launched Claude Code run and its resume both start with the note", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { gates: true, plans: { claude: [{ hold: 50 }, { hold: 50 }] } });
  const LAUNCH_NOTE = await note();
  const { startLaunch, resumeLaunch, listLaunches } = await sessions();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env });
  const ended = () => waitFor(async () => {
    const view = (await listLaunches({ projectRoot: fixture.root, env: fixture.env })).launches.find((item) => item.id === launch.id);
    return view && view.state !== "running" ? view : null;
  }, { what: "the run to end" });
  await ended();
  await resumeLaunch({ id: launch.id, env: fixture.env });
  await waitFor(() => fixture.runs("claude").length === 2, { what: "the resumed run" });
  for (const run of fixture.runs("claude")) assert.equal(valueAfter(run.argv, "--append-system-prompt"), LAUNCH_NOTE);
});

test("§2 a launched Codex run starts its thread with the note", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { gates: true, plans: { codex: [{ hold: 50 }] } });
  const LAUNCH_NOTE = await note();
  const { startLaunch } = await sessions();
  await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "codex", env: fixture.env });
  const [run] = await waitFor(() => fixture.runs("codex").length ? fixture.runs("codex") : null, { what: "the stub to start" });
  const start = await waitFor(() => fixture.inputs(run.pid).find((message) => message.method === "thread/start"), { what: "thread/start" });
  assert.equal(start.params.developerInstructions, LAUNCH_NOTE);
});

test("§2 a launched ACP agent's prompt ends with the note as a text block, in the launch and in the resume", { skip: posixOnly }, async (t) => {
  const s = await geminiWithReplies(t);
  const LAUNCH_NOTE = await note();
  const id = await s.launch();
  await s.ended(id);
  const resumed = await apply(s.base, { action: "launch.resume", target: `launch:${id}`, input: {}, revision: null }, s.headers);
  assert.equal(resumed.status, 200, resumed.text);
  await s.ended(id, 2);
  const prompts = s.sent("session/prompt");
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    const blocks = prompt.params.prompt;
    assert.equal(blocks.length, 3, "the skill, the launch instruction, and the note");
    assert.equal(blocks[0].type, "resource");
    assert.match(blocks[1].text, /^Run the Prism skill orchestrate in the attached resource/);
    assert.deepEqual(blocks[2], { type: "text", text: LAUNCH_NOTE });
  }
});
