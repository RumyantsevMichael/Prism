import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_CLIENT, CLAUDE_SESSION, INITIATIVE, actionOf, apply, askGate, askerFixture, askerServer, answer, card, listing } from "./fixtures/gate-askers.mjs";
import { pause, settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/late-gate-answers.md §4, §7, §8, §10, §11, §22.
// Contract: docs/plans/late-gate-answers/slice.md clauses 14 to 18 and 26.
// Once an answer cannot reach its asker, the card offers to continue the work, a new orchestration session by default, which
// starts only as a confirmed launch that names the answered gate; an answer alone, or one that arrives from elsewhere, starts nothing.

const posixOnly = process.platform === "win32" ? "the stub hosts and dialogs are POSIX scripts" : false;
const target = (id, initiative = INITIATIVE) => `gate:${initiative}/${id}`;
const continueAction = async (review, id, initiative) => actionOf(await listing(review.base, target(id, initiative), review.headers), "gate.continue");
const option = (action, value) => action.fields[0].options.find((item) => item.value === value);
const pick = async (review, id, continuation, initiative) => apply(review.base, { action: "gate.continue", target: target(id, initiative), input: { continuation }, revision: (await continueAction(review, id, initiative)).revision }, review.headers);

async function answered(t, options = {}) {
  const s = await askerFixture(t, { dialog: { code: 0 }, ...options });
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  const id = await askGate(server);
  const review = await s.page();
  await settled(async () => (await card(review, id))?.asker?.state, "not-running");
  assert.equal((await answer(review, id)).status, 200);
  return { s, server, id, review };
}

test("clause 14: an answered gate whose asker is not running lists Continue with a new orchestration session chosen by default", { skip: posixOnly }, async (t) => {
  const { id, review } = await answered(t);
  const action = await continueAction(review, id);
  assert.equal(action.available, true, action.reason);
  assert.deepEqual([action.label, action.group, action.effect], ["Continue", "Question", "Continues the work with your answer in the way you pick; nothing starts until you confirm outside the browser."]);
  assert.deepEqual([action.fields.length, action.fields[0].name, action.fields[0].kind, action.fields[0].required], [1, "continuation", "choice", true]);
  assert.deepEqual(action.fields[0].options.map((item) => item.value).slice(0, 1), ["new-session"]);
  assert.deepEqual([option(action, "new-session").label, option(action, "new-session").reason ?? null], ["New orchestration session", null]);
  assert.deepEqual(action.recommended, { value: "new-session", reason: "A new session reads your answer from the records and needs no live session." });
});

test("clause 15: Continue is unavailable before an answer, while a wait holds the gate, and while the asker is open", { skip: posixOnly }, async (t) => {
  const s = await askerFixture(t, { dialog: { code: 0 } });
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  const id = await askGate(server);
  const review = await s.page();
  await settled(async () => (await card(review, id))?.asker?.state, "not-running");
  assert.deepEqual([(await continueAction(review, id)).available, (await continueAction(review, id)).reason], [false, "Answer the question first."]);
  const wait = server.start("wait_for_user_gate", { initiative: INITIATIVE, gateId: id, maxWaitMinutes: 5 });
  await settled(async () => (await card(review, id))?.asker?.state, "waiting");
  assert.equal((await continueAction(review, id)).reason, "A session waits on this question, so it reads your answer.");
  wait.cancel();
  await s.setAgentsOpen([CLAUDE_SESSION]);
  await settled(async () => (await card(review, id))?.asker?.state, "open");
  assert.equal((await continueAction(review, id)).reason, "The session that asked is open, so it reads your answer when it gets a message.");
});

test("clauses 14, 16: a gate of an initiative that the roadmap does not list offers no new session", { skip: posixOnly }, async (t) => {
  const s = await askerFixture(t, { dialog: { code: 0 } });
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  const id = await askGate(server, { initiative: "drafts" });
  const review = await s.page();
  await settled(async () => (await card(review, id))?.asker?.state, "not-running");
  assert.equal((await answer(review, id, "keep", "drafts")).status, 200);
  const action = await continueAction(review, id, "drafts");
  assert.equal(option(action, "new-session").reason, "The roadmap does not list this initiative, so a new session has nothing to resume from.");
  assert.equal(action.recommended, null);
});

test("clauses 16, 17: a new session starts only after the confirmation outside the page, as a launch that names the answered gate", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t);
  const started = await pick(review, id, "new-session");
  assert.equal(started.status, 200, started.text);
  assert.equal(s.dialogs().length, 1, "Prism asked outside the page");
  const [run] = await settled(() => s.runs("claude"), (runs) => runs.length === 1);
  const prompt = await settled(() => s.inputs(run.pid).find((message) => message.type === "user"), Boolean);
  assert.equal(prompt.message.content, `/prism:orchestrate ${INITIATIVE} answered-gate ${id}`);
  const launches = (await (await fetch(`${review.base}/api/launches`)).json()).launches;
  assert.deepEqual(launches.map((item) => [item.id, item.initiative]), [[started.json.launch.id, INITIATIVE]], "the new session is a launched session of the initiative");
});

test("clause 17: a Codex new session names the answered gate in its turn", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t);
  const { updateCoordinationState, readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const read = await readCoordinationState({ projectRoot: s.root, initiative: INITIATIVE });
  await updateCoordinationState({ projectRoot: s.root, initiative: INITIATIVE, expectedRevision: read.revision, changes: { settings: { host: "codex" } } });
  assert.equal((await pick(review, id, "new-session")).status, 200);
  const [run] = await settled(() => s.runs("codex"), (runs) => runs.length === 1);
  const turn = await settled(() => s.inputs(run.pid).find((message) => message.method === "turn/start"), Boolean);
  assert.deepEqual(turn.params.input, [{ type: "text", text: `$prism:orchestrate ${INITIATIVE} answered-gate ${id}` }]);
});

test("clauses 16, 18: a declined confirmation starts nothing", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t, { dialog: { code: 1 } });
  const refused = await pick(review, id, "new-session");
  assert.notEqual(refused.status, 200);
  await pause(500, "a refused launch must start no host, which no event signals");
  assert.deepEqual(s.runs(), []);
});

test("clauses 18, 26: an answer alone, here or from another machine, starts no session and sends no wake", { skip: posixOnly }, async (t) => {
  const s = await askerFixture(t, { dialog: { code: 0 } });
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  const here = await askGate(server);
  const elsewhere = await askGate(server, { question: "Sign the exports?" });
  const review = await s.page();
  await settled(async () => (await card(review, here))?.asker?.state, "not-running");
  assert.equal((await answer(review, here)).status, 200);
  // An answer that a store sync brings is written straight into the records, as another machine's review app wrote it.
  const { answerUserGate } = await import("../../dist/server/workflow/state.mjs");
  await answerUserGate({ projectRoot: s.root, initiative: INITIATIVE, id: elsewhere, choice: "drop" });
  await settled(async () => (await card(review, elsewhere))?.answer?.choice, "drop");
  await pause(1000, "an answer must start nothing, which no event signals");
  assert.deepEqual([s.runs(), s.wakes(), s.dialogs()], [[], [], []]);
  assert.equal((await continueAction(review, elsewhere)).available, true, "the answered gate offers its continuations on the asker's machine");
});

// The roadmap records a ship or a supersession as a decision on the initiative's entry, written here as Prism writes it.
async function decide(root, decision) {
  const { readRecord, writeRecord } = await import("../../dist/server/workflow/record-store.mjs");
  const roadmap = JSON.parse((await readRecord(root, { kind: "roadmap" })).bytes.toString("utf8"));
  for (const entry of roadmap.initiatives) if (entry.id === INITIATIVE) entry.decision = decision;
  await writeRecord(root, { kind: "roadmap" }, `${JSON.stringify(roadmap, null, 2)}\n`);
}

test("clause 16: a superseded initiative offers no new session", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t);
  await decide(s.root, { kind: "superseded", at: new Date().toISOString(), by: "search", reason: "Search covers it." });
  const action = await settled(() => continueAction(review, id), (value) => option(value, "new-session")?.reason);
  assert.equal(option(action, "new-session").reason, "The initiative was superseded, so it is history.");
  assert.equal(action.recommended, null);
});

test("clauses 15, 16: a shipped initiative makes Continue unavailable with the shipped reason", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t);
  const at = new Date().toISOString();
  await decide(s.root, { kind: "shipped", at });
  const action = await settled(() => continueAction(review, id), (value) => value?.available === false);
  assert.deepEqual([action.available, action.reason], [false, `The initiative shipped on ${at.slice(0, 10)}, so its state is history.`]);
  const refused = await pick(review, id, "new-session");
  assert.equal(refused.status, 409);
  assert.deepEqual(s.runs(), []);
});

test("clause 18: the confirmation outside the page comes before the new session starts", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t);
  assert.equal((await pick(review, id, "new-session")).status, 200);
  const [start] = await settled(() => s.starts(), (list) => list.length === 1);
  assert.equal(start.dialogsBefore, 1, "the dialog was shown before claude started");
});
