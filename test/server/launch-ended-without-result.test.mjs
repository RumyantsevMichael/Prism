import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";
import { chunk, geminiWithReplies, toolCall } from "./fixtures/acp-replies.mjs";

// headless-run-questions §3 to §7: when a launched run ends normally without a result, on any host, Claude Code, Codex, or an ACP
// agent, the supervisor records one
// no-result gate with the run's last message, and the session shows as ended without a result instead of finished.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-no-result-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

const sessions = () => import("../../dist/server/session/launched-sessions.mjs");
const hosts = () => import("../../dist/server/session/launch-hosts.mjs");
const stateModule = () => import("../../dist/server/workflow/state.mjs");
const LEAD = "Prism launched this run headless, and it ended without a gate, a pause, or a ship, so nobody saw what it needs.";
const question = (label) => `The launched ${label} run of ${INITIATIVE} ended without a result. What should it do next?`;
const withMessage = (message) => `${LEAD}\n\nIts last message:\n\n${message}`;
const NO_MESSAGE = `${LEAD}\n\nThe run left no message.`;
const ENDED_STATES = ["finished", "ended-without-result", "failed", "stopped", "blocked", "waiting"];

async function viewOf(fixture, id) {
  const { listLaunches } = await sessions();
  return (await listLaunches({ projectRoot: fixture.root, env: fixture.env })).launches.find((launch) => launch.id === id) ?? null;
}
const settled = (fixture, id, states = ENDED_STATES) => waitFor(async () => {
  const view = await viewOf(fixture, id);
  return view && states.includes(view.state) ? view : null;
}, { what: `launch ${id} to reach ${states.join(" or ")}` });
async function pending(root) {
  const { readCoordinationState } = await stateModule();
  const read = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  return (read.state?.pending ?? []).filter((gate) => gate && typeof gate === "object");
}
async function closed(root) {
  const { readCoordinationState } = await stateModule();
  return (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state?.closed ?? [];
}
const noResultGates = async (root) => (await pending(root)).filter((gate) => gate.kind === "assistance" && gate.question.includes("ended without a result"));
// A run like the one under test but without a result, which must end without a result, so a check that a result keeps the run
// finished also shows that the run would not have finished without it.
async function control(t, host = "claude-code") {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 50 }], codex: [{ hold: 50 }] } });
  const id = await launch(fixture, host);
  assert.equal((await settled(fixture, id)).state, "ended-without-result", "the same run without a result ends without a result");
}
async function launch(fixture, host) {
  const { startLaunch } = await sessions();
  return (await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host, env: fixture.env })).launch.id;
}

test("§5 §6 §7 a Claude Code run that ends normally without a result ends without a result, with one no-result gate that holds its last message", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 50 }] } });
  const id = await launch(fixture, "claude-code");
  const view = await settled(fixture, id);
  assert.equal(view.state, "ended-without-result");
  assert.equal(view.reason, null);
  assert.deepEqual(view.exit, { code: 0, signal: null });
  assert.ok(view.resumeCommand, "an ended session shows its terminal resume command");
  const gates = await noResultGates(fixture.root);
  assert.equal(gates.length, 1);
  const [gate] = gates;
  assert.equal(view.questionGate, gate.id);
  assert.equal(gate.question, question("Claude Code"));
  assert.equal(gate.context, withMessage("done"), "the stub's last result text is the run's last message");
  assert.equal(gate.slice, undefined);
  assert.deepEqual(gate.artifacts, []);
  assert.equal(gate.answer, undefined);
});

test("§5 §7 a Codex run that ends normally without a result and leaves no message ends without a result, and its gate says that it left no message", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { codex: [{ hold: 50 }] } });
  const id = await launch(fixture, "codex");
  const view = await settled(fixture, id);
  assert.equal(view.state, "ended-without-result");
  const [gate] = await noResultGates(fixture.root);
  assert.equal(gate.question, question("Codex"));
  assert.equal(gate.context, NO_MESSAGE);
  assert.equal(view.questionGate, gate.id);
});

test("§3 an open gate of the initiative, or a pause that the run recorded, is a result, so the run finishes and no gate is added", { skip: posixOnly }, async (t) => {
  await control(t);
  const withGate = await launchFixture(t, { gates: true, plans: { claude: [{ hold: 50 }] } });
  const before = (await pending(withGate.root)).length;
  const gated = await launch(withGate, "claude-code");
  assert.equal((await settled(withGate, gated)).state, "finished", "an unanswered gate of the initiative is a result, though the run did not ask it");
  assert.equal((await pending(withGate.root)).length, before);

  const paused = await launchFixture(t, { plans: { claude: [{ hold: 2500 }] } });
  // The pause is written as the run's own server writes it, with this fixture's machine folders as its environment.
  paused.useAsProcessEnv();
  const { readCoordinationState, updateCoordinationState, checkpointPause } = await stateModule();
  const created = await updateCoordinationState({ projectRoot: paused.root, initiative: INITIATIVE, expectedRevision: null, changes: { activeOperations: [{ op: "start", entry: { slice: INITIATIVE, activity: "design", workers: ["designer-1"], workspace: paused.root } }] } });
  assert.ok(created.revision);
  const id = await launch(paused, "claude-code");
  const read = await readCoordinationState({ projectRoot: paused.root, initiative: INITIATIVE });
  // The run's own Prism server records the pause: its environment names the launch.
  process.env.PRISM_LAUNCH = id;
  try {
    await checkpointPause({ projectRoot: paused.root, initiative: INITIATIVE, expectedRevision: read.revision, activeSlice: INITIATIVE, recoveryContent: "Next: run implement for the root slice again.", changes: { next: ["Run implement for the root slice again."] } });
  } finally {
    delete process.env.PRISM_LAUNCH;
  }
  assert.equal((await settled(paused, id)).state, "finished", "a pause recorded during the run is a result");
  assert.equal((await noResultGates(paused.root)).length, 0);
});

test("§3 a shipped initiative is a result, so its run finishes and no gate is added", { skip: posixOnly }, async (t) => {
  await control(t);
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 1500 }] } });
  const id = await launch(fixture, "claude-code");
  // The roadmap records the ship while the run runs, as the run's own ship operation would.
  const file = path.join(fixture.root, ".prism/roadmap.json");
  const roadmap = JSON.parse(await readFile(file, "utf8"));
  const entry = roadmap.initiatives.find((item) => item.id === INITIATIVE);
  entry.decision = { kind: "shipped", at: new Date().toISOString(), actor: "orchestrator" };
  await writeFile(file, `${JSON.stringify(roadmap, null, 2)}\n`);
  assert.equal((await settled(fixture, id)).state, "finished");
  assert.equal((await noResultGates(fixture.root)).length, 0);
});

test("§4 a run that fails, is refused an action, or is stopped keeps its own state and adds no gate", { skip: posixOnly }, async (t) => {
  await control(t, "codex");
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 50, isError: true }], codex: [{ hold: 50, declined: ["rm -rf build"] }] } });
  const failed = await launch(fixture, "claude-code");
  assert.equal((await settled(fixture, failed)).state, "failed");
  const blocked = await launch(fixture, "codex");
  assert.equal((await settled(fixture, blocked)).state, "blocked");
  assert.equal((await noResultGates(fixture.root)).length, 0);

  const held = await launchFixture(t, { plans: { claude: [{ hold: "forever" }] } });
  const { stopLaunch } = await sessions();
  const running = await launch(held, "claude-code");
  await settled(held, running, ["running"]);
  assert.equal((await stopLaunch({ id: running, env: held.env })).state, "stopped");
  assert.equal((await noResultGates(held.root)).length, 0);
});

test("§5 the last message of each host: Claude Code's last successful result text, Codex's last agent message of the run's turn, cut and without the host session id", async () => {
  const { hostConversation } = await hosts();
  const session = "0b9c7d4e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
  const lines = (events) => Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  const claude = hostConversation("claude-code", { initiative: INITIATIVE, checkout: "/work", hostSessionId: session, send: () => {}, closeInput: () => {} });
  claude.push(lines([
    { type: "result", subtype: "success", is_error: false, result: "First turn.", permission_denials: [] },
    { type: "result", subtype: "success", is_error: false, result: `Should I park the entry? Session ${session} is waiting.`, permission_denials: [] }
  ]));
  claude.end();
  assert.equal(claude.facts.lastMessage, "Should I park the entry? Session <host session id> is waiting.");

  const long = hostConversation("claude-code", { initiative: INITIATIVE, checkout: "/work", hostSessionId: session, send: () => {}, closeInput: () => {} });
  long.push(lines([{ type: "result", subtype: "success", is_error: false, result: "x".repeat(7000), permission_denials: [] }]));
  long.end();
  assert.equal(long.facts.lastMessage, `${"x".repeat(6000)}…`);

  const blank = hostConversation("claude-code", { initiative: INITIATIVE, checkout: "/work", hostSessionId: session, send: () => {}, closeInput: () => {} });
  blank.push(lines([{ type: "result", subtype: "success", is_error: false, result: "  \n ", permission_denials: [] }]));
  blank.end();
  assert.equal(blank.facts.lastMessage, null, "blank text is no message");

  const sent = [];
  const codex = hostConversation("codex", { initiative: INITIATIVE, checkout: "/work", send: (message) => sent.push(message), closeInput: () => {} });
  codex.start();
  const answer = (method, result) => {
    const request = sent.find((message) => message.method === method);
    codex.push(lines([{ jsonrpc: "2.0", id: request.id, result }]));
  };
  answer("initialize", {});
  answer("thread/start", { thread: { id: "thread-1" } });
  answer("turn/start", { turn: { id: "turn-1" } });
  codex.push(lines([
    { jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "a", type: "agentMessage", text: "Working on it." } } },
    { jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "b", type: "agentMessage", text: "Should I delete the draft requirement?" } } },
    { jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-0", item: { id: "c", type: "agentMessage", text: "An earlier turn." } } },
    { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [], error: null } } }
  ]));
  codex.end();
  assert.equal(codex.facts.lastMessage, "Should I delete the draft requirement?");
});

test("§6 a run that ends without a result again replaces the earlier unanswered no-result gate, and the gate is one the host session asked", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 50 }, { hold: 50 }] } });
  const { resumeLaunch } = await sessions();
  const id = await launch(fixture, "claude-code");
  await settled(fixture, id);
  const [first] = await noResultGates(fixture.root);
  await resumeLaunch({ id, env: fixture.env });
  await waitFor(async () => (await viewOf(fixture, id))?.runs === 2 && (await viewOf(fixture, id)).state === "ended-without-result", { what: "the second run to end without a result" });
  const gates = await noResultGates(fixture.root);
  assert.equal(gates.length, 1, "at most one no-result gate of the launch is open");
  assert.notEqual(gates[0].id, first.id);
  assert.ok((await closed(fixture.root)).some((gate) => gate.id === first.id));
  const { askedGates } = await import("../../dist/server/workflow/change-notices.mjs");
  const { holderOf } = await import("../../dist/server/workflow/slice-claims.mjs");
  const { noticeDirectory } = await import("../../dist/server/workflow/change-notices.mjs");
  const [run] = fixture.runs("claude");
  const asked = await askedGates({ projectRoot: fixture.root, initiative: INITIATIVE, session: holderOf(run.argv[3]), directory: noticeDirectory(fixture.env) });
  assert.ok(asked.includes(gates[0].id), "the host session's gate delivery knows the gate");
});

test("§7 a no-result gate never makes the session wait, and a gate that cannot be recorded still shows the session ended without a result with the reason", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 50 }] } });
  const id = await launch(fixture, "claude-code");
  const view = await settled(fixture, id);
  assert.equal(view.state, "ended-without-result", "the launch marked its no-result gate, and the session still does not wait");
  assert.equal(view.waitingGate, null);

  const broken = await launchFixture(t, { plans: { claude: [{ hold: 600 }] } });
  const other = await launch(broken, "claude-code");
  await mkdir(path.join(broken.root, ".prism/initiatives", INITIATIVE), { recursive: true });
  await writeFile(path.join(broken.root, ".prism/initiatives", INITIATIVE, "state.json"), "{ not json");
  const failed = await settled(broken, other);
  assert.equal(failed.state, "ended-without-result");
  assert.match(failed.reason, /^Prism could not record a question for this run: /);
  assert.equal(failed.questionGate, null);
});

test("§4 §5 §6 an ACP agent's prompt that answers end_turn without a result ends without a result, and its gate holds the reply after the last tool call", { skip: posixOnly }, async (t) => {
  const s = await geminiWithReplies(t, { updates: [chunk("Reading the plan."), toolCall(), chunk("Should I park the entry", "m2"), chunk(" or supersede it?", "m2")] });
  const id = await s.launch();
  const view = await s.ended(id);
  assert.equal(view.state, "ended-without-result");
  assert.equal(view.reason, null);
  const gates = await noResultGates(s.root);
  assert.equal(gates.length, 1);
  assert.equal(view.questionGate, gates[0].id);
  assert.equal(gates[0].question, question("Gemini CLI"), "the question names the agent by its label");
  assert.equal(gates[0].context, withMessage("Should I park the entry or supersede it?"));
});

test("§5 §7 an ACP agent that sends no message chunk leaves no message, and a chunk with a new message id starts the message anew", { skip: posixOnly }, async (t) => {
  const silent = await geminiWithReplies(t, { updates: [toolCall()] });
  const quiet = await silent.launch();
  assert.equal((await silent.ended(quiet)).state, "ended-without-result");
  assert.equal((await noResultGates(silent.root))[0].context, NO_MESSAGE);

  const replaced = await geminiWithReplies(t, { updates: [chunk("First draft.", "m1"), chunk("Final question?", "m2")] });
  const other = await replaced.launch();
  await replaced.ended(other);
  assert.equal((await noResultGates(replaced.root))[0].context, withMessage("Final question?"));
});

test("§4 an ACP run that fails on its stop reason, or that a stop cancels, keeps its own state and adds no gate", { skip: posixOnly }, async (t) => {
  const control = await geminiWithReplies(t, { updates: [chunk("I cannot do that.")] });
  assert.equal((await control.ended(await control.launch())).state, "ended-without-result", "the same agent run that answers end_turn ends without a result");
  const refused = await geminiWithReplies(t, { stopReason: "refusal", updates: [chunk("I cannot do that.")] });
  const id = await refused.launch();
  const view = await refused.ended(id);
  assert.equal(view.state, "failed");
  assert.equal(view.reason, "Gemini CLI stopped: refusal.");
  assert.equal((await noResultGates(refused.root)).length, 0);

  const held = await geminiWithReplies(t, { hold: true, updates: [chunk("Working.")] });
  const running = await held.launch();
  await settled({ root: held.root, env: held.env }, running, ["running"]);
  const { stopLaunch } = await sessions();
  assert.equal((await stopLaunch({ id: running, env: held.env })).state, "stopped");
  assert.equal((await held.ended(running)).state, "stopped");
  assert.equal((await noResultGates(held.root)).length, 0);
});
