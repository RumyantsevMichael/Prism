import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import { CLAUDE_CLIENT, CLAUDE_SESSION, CLOUD_SESSION, CODEX_CLIENT, CODEX_SESSION, INITIATIVE, MACHINE, askGate, askerFixture, askerServer, answer, card, filesBelow, get, result } from "./fixtures/gate-askers.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/late-gate-answers.md §1, §2, §3, §4, §5, §6, §9.
// Contract: docs/plans/late-gate-answers/slice.md clauses 1 to 9.
// Prism records with each gate the session that asked it, keeps that session's id on its machine only, and shows on the gate's
// card who asked and whether that session waits, is open, is not running, or is in a state Prism cannot tell.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const CHECKOUT = (root) => `${path.basename(root)}/main`;
const OLD_GATE_KEYS = new Set(["id", "kind", "slice", "question", "context", "artifacts", "options", "recommended", "askedAt", "standing", "answer"]);
const askerOf = (review, id, accept = (asker) => asker !== undefined) => settled(async () => (await card(review, id))?.asker, accept);

async function claudeAsked(t, options = {}) {
  const s = await askerFixture(t, options);
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  const id = await askGate(server);
  return { s, server, id, review: await s.page() };
}

test("clauses 1, 2, 6: a gate that a Claude Code session asks names its harness, machine, and checkout on its card", { skip: posixOnly }, async (t) => {
  const { s, server, id, review } = await claudeAsked(t);
  const asker = await askerOf(review, id);
  assert.deepEqual({ ...asker, state: undefined, reason: undefined, reach: undefined, wake: undefined }, {
    known: true, harness: "Claude Code", machine: MACHINE, checkout: CHECKOUT(s.root), cloud: false, launched: false, thisMachine: true,
    state: undefined, reason: undefined, reach: undefined, wake: undefined
  });
  const state = result(await server.call("get_coordination_state", { initiative: INITIATIVE }));
  const gate = state.state.pending.find((item) => item.id === id);
  assert.deepEqual(Object.keys(gate).filter((key) => !OLD_GATE_KEYS.has(key)), [], "the gate record keeps only the fields that earlier releases know");
});

test("clause 2: a gate that a Codex session asks names Codex, and one asked by another harness names that harness", { skip: posixOnly }, async (t) => {
  const s = await askerFixture(t);
  const codex = await askerServer(t, s, { client: CODEX_CLIENT, meta: { sessionId: CODEX_SESSION } });
  const other = await askerServer(t, s, { client: { name: "gemini-cli", title: "Gemini CLI", version: "1.0.0" } });
  const codexGate = await askGate(codex, { question: "Which retention window?" });
  const otherGate = await askGate(other, { question: "Sign the exports?" });
  const review = await s.page();
  assert.equal((await askerOf(review, codexGate)).harness, "Codex");
  const asker = await askerOf(review, otherGate);
  assert.deepEqual([asker.harness, asker.state, asker.reason], ["Gemini CLI", "unknown", "Prism cannot tell whether a Gemini CLI session is open."]);
});

test("clauses 2, 7: a gate that a cloud session asks is marked as a cloud session whose state Prism cannot tell", { skip: posixOnly }, async (t) => {
  const s = await askerFixture(t);
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION, CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: CLOUD_SESSION } });
  const id = await askGate(server);
  const asker = await askerOf(await s.page(), id);
  assert.deepEqual([asker.cloud, asker.state, asker.reason], [true, "unknown", "Prism cannot tell whether a cloud session is open."]);
});

test("clause 3: the session id stays in this machine's review app folder and out of every shared record and tool result", { skip: posixOnly }, async (t) => {
  const { s, server, id, review } = await claudeAsked(t);
  await askerOf(review, id);
  const codex = await askerServer(t, s, { client: CODEX_CLIENT, meta: { sessionId: CODEX_SESSION } });
  await askGate(codex, { question: "Which retention window?" });
  for (const secret of [CLAUDE_SESSION, CODEX_SESSION]) {
    const shared = filesBelow(s.root).filter((entry) => entry.text.includes(secret)).map((entry) => path.relative(s.root, entry.file));
    assert.deepEqual(shared, [], `no file of the checkout or its shared records holds ${secret}`);
    assert.ok(filesBelow(s.app).some((entry) => entry.text.includes(secret)), "the review app folder keeps the id for a resume");
  }
  for (const message of [...server.messages]) assert.ok(!JSON.stringify(message).includes(CLAUDE_SESSION), "no tool result names the session id");
  const attention = JSON.stringify(await card(review, id));
  assert.ok(!attention.includes(CLAUDE_SESSION), "the Attention item names no session id");
});

test("clauses 4, 6, 7: a gate with no recorded asker shows an unknown asker", { skip: posixOnly }, async (t) => {
  const s = await askerFixture(t);
  const { updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const created = await updateCoordinationState({ projectRoot: s.root, initiative: INITIATIVE, expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "assistance", question: "Install the signing key.", context: "Signing needs a key that only you can add.", artifacts: [] }] } });
  const asker = await askerOf(await s.page(), created.openedGates[0].id);
  assert.deepEqual(asker, { known: false, harness: null, machine: null, checkout: null, cloud: false, launched: false, thisMachine: false, state: "unknown", reason: "Prism has no record of the session that asked this question.", reach: null, wake: null });
});

test("clauses 6, 7: a gate asked on another machine shows that Prism can tell its state only there", { skip: posixOnly }, async (t) => {
  const s = await askerFixture(t);
  const elsewhere = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-other-machine-")));
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION }, app: elsewhere });
  const id = await askGate(server);
  const asker = await askerOf(await s.page(), id);
  assert.deepEqual([asker.thisMachine, asker.state, asker.reason], [false, "unknown", `It ran on ${MACHINE}; Prism can tell whether it is open only there.`]);
});

test("clause 7: a Claude Code asker is open while claude agents --json lists its id, and not running otherwise", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await claudeAsked(t);
  await s.setAgentsOpen([CLAUDE_SESSION]);
  let asker = await askerOf(review, id, (value) => value?.state === "open");
  assert.deepEqual([asker.state, asker.reason], ["open", null]);
  assert.ok(s.stubEntries().some((entry) => entry.kind === "agents" && entry.argv.join(" ") === "agents --json" && entry.cwd === s.root), "Prism asked claude agents --json in the asker's checkout");
  await s.setAgentsOpen(["0d4e0a4c-0000-4000-8000-000000000000"]);
  asker = await askerOf(review, id, (value) => value?.state === "not-running");
  assert.deepEqual([asker.state, asker.reason, asker.reach], ["not-running", null, null]);
});

test("clause 7: a failing or missing claude leaves the state unknown with the reason", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await claudeAsked(t);
  await s.setAgents({ code: 3, stderr: "agents: not signed in" });
  const asker = await askerOf(review, id, (value) => value?.state === "unknown");
  assert.deepEqual([asker.state, asker.reason], ["unknown", "claude agents --json failed: agents: not signed in"]);
  const missing = await askerFixture(t, { hosts: ["codex"] });
  const server = await askerServer(t, missing, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  const gate = await askGate(server);
  const shown = await askerOf(await missing.page(), gate);
  assert.deepEqual([shown.state, shown.reason], ["unknown", "Claude Code was not found: no claude executable on PATH."]);
});

test("clause 7: a Codex asker is open while its thread writer lock exists", { skip: posixOnly }, async (t) => {
  const s = await askerFixture(t);
  const server = await askerServer(t, s, { client: CODEX_CLIENT, meta: { sessionId: CODEX_SESSION } });
  const id = await askGate(server);
  const review = await s.page();
  await s.openCodexThread();
  assert.equal((await askerOf(review, id, (value) => value?.state === "open")).state, "open");
  await s.closeCodexThread();
  assert.equal((await askerOf(review, id, (value) => value?.state === "not-running")).state, "not-running");
});

test("clauses 5, 7: a gate reads waiting while a wait holds it, and the hold ends with the wait", { skip: posixOnly }, async (t) => {
  const { s, server, id, review } = await claudeAsked(t);
  await s.setAgentsOpen([CLAUDE_SESSION]);
  const wait = server.start("wait_for_user_gate", { initiative: INITIATIVE, gateId: id, maxWaitMinutes: 5 });
  const waiting = await askerOf(review, id, (value) => value?.state === "waiting");
  assert.deepEqual([waiting.state, waiting.reason, waiting.reach], ["waiting", null, null]);
  wait.cancel();
  assert.equal((await askerOf(review, id, (value) => value?.state === "open")).state, "open", "the session is open but no longer waits");
});

test("clauses 5, 7: a hold whose wait stopped renewing lapses after its lease", { skip: posixOnly }, async (t) => {
  const s = await askerFixture(t);
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION, PRISM_GATE_HOLD_MS: "3000" } });
  const id = await askGate(server);
  const review = await s.page();
  server.start("wait_for_user_gate", { initiative: INITIATIVE, gateId: id, maxWaitMinutes: 5 });
  await askerOf(review, id, (value) => value?.state === "waiting");
  // A server that is killed cannot end its wait, so only the lease of 3 seconds ends the hold.
  await server.kill();
  const lapsed = await askerOf(review, id, (value) => value?.state !== "waiting");
  assert.equal(lapsed.state, "not-running");
});

test("clause 8: an open asker that no wait holds tells the person how to reach it", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await claudeAsked(t);
  await s.setAgentsOpen([CLAUDE_SESSION]);
  const asker = await askerOf(review, id, (value) => value?.state === "open");
  assert.equal(asker.reach, "Prism cannot reach this session, because no wait holds the question. Send any message in that Claude Code session, and it reads the answer.");
});

test("clause 6: an answered gate keeps its asker on its card in Answered", { skip: posixOnly }, async (t) => {
  const { id, review } = await claudeAsked(t);
  const answered = await answer(review, id);
  assert.equal(answered.status, 200, answered.text);
  const data = (await get(review.base, "api/entity?ref=attention", review.headers)).json.data;
  const item = data.answered.find((entry) => entry.id === id);
  assert.equal(item.asker.harness, "Claude Code");
});
