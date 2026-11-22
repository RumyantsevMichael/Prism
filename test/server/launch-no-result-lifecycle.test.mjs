import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";
import { apply, get, pageSession, startActionReview } from "./fixtures/review-actions.mjs";
import { chunk, geminiWithReplies } from "./fixtures/acp-replies.mjs";

// headless-run-questions §8, §9, and §10: the no-result gate's answer resumes the session, archiving the session closes the gate and
// starts nothing, and a session that runs again, from the page or in a terminal, closes its unanswered gate.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-no-result-life-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts and dialogs are POSIX scripts" : false;

const sessions = () => import("../../dist/server/session/launched-sessions.mjs");
const stateModule = () => import("../../dist/server/workflow/state.mjs");
const ARCHIVED = "The person archived the launched session.";
const RUNS_AGAIN = "The launched session runs again.";
const ANSWER_WAITS = "An answer given on another machine waits; resume this session here to continue.";

async function setup(t, plans) {
  const fixture = await launchFixture(t, { dialog: { code: 0 }, plans });
  fixture.useAsProcessEnv();
  const { review, base, opened } = await startActionReview(t, fixture.root);
  const headers = await pageSession(review, opened);
  const view = async (id) => (await get(base, "api/launches")).json.launches.find((launch) => launch.id === id) ?? null;
  const settled = (id, states, runs = 1) => waitFor(async () => {
    const current = await view(id);
    return current && current.runs === runs && states.includes(current.state) ? current : null;
  }, { what: `launch ${id} to reach ${states.join(" or ")} after run ${runs}` });
  return { ...fixture, review, base, headers, view, settled };
}
async function state(root) {
  const { readCoordinationState } = await stateModule();
  return (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state;
}
async function launchEnded(s) {
  const { startLaunch } = await sessions();
  const id = (await startLaunch({ projectRoot: s.root, initiative: INITIATIVE, host: "claude-code", env: s.env })).launch.id;
  const view = await s.settled(id, ["ended-without-result"]);
  assert.ok(view.questionGate, "the session has a no-result gate");
  return { id, gate: view.questionGate };
}
const closedGate = async (root, gate) => (await state(root)).closed?.find((entry) => entry.id === gate) ?? null;

test("§8 answering the no-result gate on this machine resumes the session, and the resumed host session receives the answer", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { claude: [{ hold: 50 }, { hold: 1500 }] });
  const { id, gate } = await launchEnded(s);
  const { readCoordinationState } = await stateModule();
  const read = await readCoordinationState({ projectRoot: s.root, initiative: INITIATIVE });
  const answered = await apply(s.base, { action: "gate.answer", target: `gate:${INITIATIVE}/${gate}`, input: { choice: "done", note: "Park the entry and go on." }, revision: read.revision }, s.headers);
  assert.equal(answered.status, 200, answered.text);
  assert.deepEqual(answered.json.launch, { id, resumed: true, reason: null });
  await waitFor(() => s.runs("claude").length === 2, { what: "the resumed run" });
  const [first, second] = s.runs("claude");
  assert.deepEqual(second.argv.slice(0, 4), ["-p", "--verbose", "--resume", first.argv[3]]);
  const { deliverGateAnswers } = await import("../../dist/hooks/deliver-gate-answers.mjs");
  const output = await deliverGateAnswers({ input: Readable.from([JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: first.argv[3], cwd: s.root })]), environment: s.env });
  assert.ok(output && JSON.stringify(output).includes("Park the entry and go on."), "the prompt hook of the resumed session delivers the answer");
});

test("§8 an answer that reaches this machine from another one leaves the session ended without a result, with the waiting answer as its reason", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { claude: [{ hold: 50 }] });
  const { id, gate } = await launchEnded(s);
  const { answerUserGate } = await stateModule();
  // Written straight to the state, as a store sync brings another machine's answer: no history entry of this machine names it.
  await answerUserGate({ projectRoot: s.root, initiative: INITIATIVE, id: gate, choice: "done", note: "Supersede it." });
  const view = await s.view(id);
  assert.equal(view.state, "ended-without-result");
  assert.equal(view.reason, ANSWER_WAITS);
  assert.equal(s.runs("claude").length, 1, "no run starts");
});

test("§9 archiving a session that ended without a result closes its gate and starts no run, and unarchiving does not open it again", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { claude: [{ hold: 50 }] });
  const { id, gate } = await launchEnded(s);
  const { archiveLaunch, unarchiveLaunch } = await sessions();
  assert.deepEqual(await archiveLaunch({ projectRoot: s.root, id, env: s.env }), { archived: [id] });
  assert.equal((await closedGate(s.root, gate))?.reason, ARCHIVED);
  assert.equal((await state(s.root)).pending.some((entry) => entry?.id === gate), false);
  assert.equal(s.runs("claude").length, 1, "no run starts");
  assert.equal((await s.view(id)).questionGate, null);
  await unarchiveLaunch({ projectRoot: s.root, id, env: s.env });
  assert.equal((await state(s.root)).pending.some((entry) => entry?.id === gate), false, "the gate stays closed");
});

test("§10 a new run of the session closes its unanswered no-result gate when it starts", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { claude: [{ hold: 50 }, { hold: "forever" }] });
  const { id, gate } = await launchEnded(s);
  const { resumeLaunch } = await sessions();
  await resumeLaunch({ id, env: s.env });
  await s.settled(id, ["running"], 2);
  const closed = await waitFor(() => closedGate(s.root, gate), { what: "the gate to close" });
  assert.equal(closed.reason, RUNS_AGAIN);
  assert.equal((await s.view(id)).questionGate, null);
});

test("§10 the launch's host session starting again in a terminal closes its unanswered gate, and an answered gate or another session is left alone", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { claude: [{ hold: 50 }] });
  const { gate } = await launchEnded(s);
  const [run] = s.runs("claude");
  const { withdrawLaunchQuestions } = await import("../../dist/hooks/withdraw-launch-questions.mjs");
  const hook = (sessionId) => withdrawLaunchQuestions({ input: Readable.from([JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: sessionId, cwd: s.root })]), environment: { ...s.env, PRISM_LAUNCH: undefined } });
  await hook("11111111-2222-4333-8444-555555555555");
  assert.equal(await closedGate(s.root, gate), null, "another session closes nothing");
  await hook(run.argv[3]);
  assert.equal((await closedGate(s.root, gate))?.reason, RUNS_AGAIN);

  const answeredCase = await setup(t, { claude: [{ hold: 50 }] });
  const ended = await launchEnded(answeredCase);
  const { answerUserGate } = await stateModule();
  await answerUserGate({ projectRoot: answeredCase.root, initiative: INITIATIVE, id: ended.gate, choice: "done", note: "Go on." });
  const [other] = answeredCase.runs("claude");
  await withdrawLaunchQuestions({ input: Readable.from([JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: other.argv[3], cwd: answeredCase.root })]), environment: answeredCase.env });
  assert.ok((await state(answeredCase.root)).pending.some((entry) => entry?.id === ended.gate), "an answered gate stays for the run to act on");
});

test("§8 answering an ACP run's no-result gate resumes its session, whose new prompt starts orchestrate again to read the answer", { skip: posixOnly }, async (t) => {
  const s = await geminiWithReplies(t, { updates: [chunk("Should I park the entry?")] });
  const id = await s.launch();
  const ended = await s.ended(id);
  assert.equal(ended.state, "ended-without-result");
  const { readCoordinationState } = await stateModule();
  const read = await readCoordinationState({ projectRoot: s.root, initiative: INITIATIVE });
  const answered = await apply(s.base, { action: "gate.answer", target: `gate:${INITIATIVE}/${ended.questionGate}`, input: { choice: "done", note: "Park it." }, revision: read.revision }, s.headers);
  assert.equal(answered.status, 200, answered.text);
  assert.deepEqual(answered.json.launch, { id, resumed: true, reason: null });
  await waitFor(() => s.sent("session/prompt").length === 2, { what: "the resumed prompt" });
  assert.equal(s.sent("session/resume").length, 1, "the recorded session is reopened");
  const [first, second] = s.sent("session/prompt");
  assert.deepEqual(second.params.prompt, first.params.prompt, "the prompt stays the launch's prompt");
  const gate = (await state(s.root)).pending.find((entry) => entry?.id === ended.questionGate);
  assert.equal(gate?.answer?.note, "Park it.", "the answer waits in the coordination state for orchestrate's first step");
});
