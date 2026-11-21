import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLAUDE_CLIENT, CLAUDE_SESSION, CLOUD_SESSION, CODEX_CLIENT, CODEX_SESSION, INITIATIVE, MACHINE, actionOf, apply, askGate, askerFixture, askerServer, answer, card, listing } from "./fixtures/gate-askers.mjs";
import { pause, settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/late-gate-answers.md §9, §12, §13, §14, §23.
// Contract: docs/plans/late-gate-answers/slice.md clauses 19 to 21, 25, and 26.
// On the machine where the asker ran, an answered gate whose asker is not running offers to resume that very session, which
// starts only after a confirmation outside the page, runs headless in its own checkout, and shows and stops as a launched session.

const posixOnly = process.platform === "win32" ? "the stub hosts and dialogs are POSIX scripts" : false;
const target = (id) => `gate:${INITIATIVE}/${id}`;
const continueAction = async (review, id) => actionOf(await listing(review.base, target(id), review.headers), "gate.continue");
const resumeOption = async (review, id) => (await continueAction(review, id)).fields[0].options.find((item) => item.value === "resume");
const pick = async (review, id, continuation = "resume") => apply(review.base, { action: "gate.continue", target: target(id), input: { continuation }, revision: (await continueAction(review, id)).revision }, review.headers);
const prompt = (id) => `Prism: the person answered your question ${id} of the initiative ${INITIATIVE} in the review app. Read the answer from Prism's records and continue.`;

async function answered(t, { client = CLAUDE_CLIENT, env = { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION }, meta, app, plans = {}, state = "not-running", dialog = { code: 0 } } = {}) {
  const s = await askerFixture(t, { dialog, plans });
  const server = await askerServer(t, s, { client, env, meta, ...(app ? { app } : {}) });
  const id = await askGate(server);
  const review = await s.page();
  await settled(async () => (await card(review, id))?.asker?.state, state);
  assert.equal((await answer(review, id)).status, 200);
  return { s, id, review };
}

test("clause 19: a Claude Code asker that ran here and is not running offers a resume", { skip: posixOnly }, async (t) => {
  const { id, review } = await answered(t);
  const option = await resumeOption(review, id);
  assert.deepEqual([option.label, option.reason ?? null], ["Resume the session that asked", null]);
});

test("clause 19: a resume names why it does not apply to an asker on another machine, in the cloud, of another harness, or of unknown state", { skip: posixOnly }, async (t) => {
  const elsewhere = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-other-machine-")));
  const other = await answered(t, { app: elsewhere, state: "unknown" });
  assert.equal((await resumeOption(other.review, other.id)).reason, `The session ran on ${MACHINE}; resume it there.`);
  const cloud = await answered(t, { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION, CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: CLOUD_SESSION }, state: "unknown" });
  assert.equal((await resumeOption(cloud.review, cloud.id)).reason, "This is a cloud session; wake it instead.");
  const gemini = await answered(t, { client: { name: "gemini-cli", title: "Gemini CLI", version: "1.0.0" }, env: {}, state: "unknown" });
  assert.equal((await resumeOption(gemini.review, gemini.id)).reason, "Gemini CLI does not let Prism resume a session by its id.");
});

test("clause 19: a resume does not apply while Prism cannot tell whether a Claude Code asker is open", { skip: posixOnly }, async (t) => {
  const s = await askerFixture(t, { dialog: { code: 0 } });
  await s.setAgents({ code: 3, stderr: "agents: not signed in" });
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  const id = await askGate(server);
  const review = await s.page();
  await settled(async () => (await card(review, id))?.asker?.state, "unknown");
  assert.equal((await answer(review, id)).status, 200);
  assert.equal((await resumeOption(review, id)).reason, "Prism cannot tell whether the session is open: claude agents --json failed: agents: not signed in");
});

test("clauses 20, 21: a confirmed resume continues the Claude Code session under its id in its checkout and lists it as a launched session", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t, { plans: { claude: [{ hold: "forever" }] } });
  const started = await pick(review, id);
  assert.equal(started.status, 200, started.text);
  const [dialog] = s.dialogs();
  assert.equal(dialog.text, `Resume the Claude Code session that asked question ${id} of the initiative ${INITIATIVE} in ${s.root}? Further launches in the next 30 minutes will start without asking.`);
  const [run] = await settled(() => s.runs("claude"), (runs) => runs.length === 1);
  assert.equal(run.cwd, s.root);
  assert.equal(run.argv[run.argv.indexOf("--resume") + 1], CLAUDE_SESSION, "the run resumes the asker under its own id");
  assert.equal(run.argv.includes("--session-id"), false);
  const message = await settled(() => s.inputs(run.pid).find((item) => item.type === "user"), Boolean);
  assert.equal(message.message.content, prompt(id));
  const launches = (await (await fetch(`${review.base}/api/launches`)).json()).launches;
  const view = launches.find((item) => item.id === started.json.launch.id);
  assert.deepEqual([view.initiative, view.host, view.state], [INITIATIVE, "claude-code", "running"]);
  const stop = actionOf(await listing(review.base, `launch:${view.id}`, review.headers), "launch.stop");
  assert.equal(stop.available, true, "the resumed session stops as a launched session");
  const stopped = await apply(review.base, { action: "launch.stop", target: `launch:${view.id}`, input: {}, revision: stop.revision }, review.headers);
  assert.equal(stopped.status, 200, stopped.text);
});

test("clause 20: a confirmed resume continues a Codex thread under its id", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t, { client: CODEX_CLIENT, env: {}, meta: { sessionId: CODEX_SESSION } });
  assert.equal((await pick(review, id)).status, 200);
  const [run] = await settled(() => s.runs("codex"), (runs) => runs.length === 1);
  const resume = await settled(() => s.inputs(run.pid).find((item) => item.method === "thread/resume"), Boolean);
  assert.deepEqual([resume.params.threadId, resume.params.cwd], [CODEX_SESSION, s.root]);
  const turn = await settled(() => s.inputs(run.pid).find((item) => item.method === "turn/start"), Boolean);
  assert.deepEqual(turn.params.input, [{ type: "text", text: prompt(id) }]);
});

test("clause 25: a resume asks outside the page, and a declined one starts nothing", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t, { dialog: { code: 1 } });
  const refused = await pick(review, id);
  assert.notEqual(refused.status, 200);
  await pause(500, "a declined resume must start no host, which no event signals");
  assert.deepEqual(s.runs(), []);
});

test("clause 19: a resume does not apply while a launched session of the initiative runs on this machine", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t, { plans: { claude: [{ hold: "forever" }] } });
  const launch = actionOf(await listing(review.base, `initiative:${INITIATIVE}`, review.headers), "launch.run");
  assert.equal((await apply(review.base, { action: "launch.run", target: `initiative:${INITIATIVE}`, input: {}, revision: launch.revision }, review.headers)).status, 200);
  await settled(() => s.runs("claude"), (runs) => runs.length === 1);
  assert.equal((await resumeOption(review, id)).reason, `A launched session of ${INITIATIVE} is running on this machine.`);
});
