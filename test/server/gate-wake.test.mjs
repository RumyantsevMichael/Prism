import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_CLIENT, CLAUDE_SESSION, CLOUD_SESSION, INITIATIVE, actionOf, apply, askGate, askerFixture, askerServer, answer, card, listing } from "./fixtures/gate-askers.mjs";
import { pause, settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/late-gate-answers.md §9, §14, §15, §16, §17, §18.
// Contract: docs/plans/late-gate-answers/slice.md clauses 22 to 25.
// An answered gate of a cloud session offers, on the person's own computer, to wake that session with a pointer to the answer,
// confirmed outside the page; the card shows whether the harness delivered it, and a review app in a cloud session offers no wake.

const posixOnly = process.platform === "win32" ? "the stub hosts and dialogs are POSIX scripts" : false;
const target = (id) => `gate:${INITIATIVE}/${id}`;
const continueAction = async (review, id) => actionOf(await listing(review.base, target(id), review.headers), "gate.continue");
const wakeOption = async (review, id) => (await continueAction(review, id)).fields[0].options.find((item) => item.value === "wake");
const wake = async (review, id) => apply(review.base, { action: "gate.continue", target: target(id), input: { continuation: "wake" }, revision: (await continueAction(review, id)).revision }, review.headers);
const pointer = (id) => `Prism: question ${id} of the initiative ${INITIATIVE} has an answer in the review app. Read it from Prism's records before you continue.`;
const CLOUD_ENV = { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION, CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: CLOUD_SESSION };

async function answered(t, { env = CLOUD_ENV, dialog = { code: 0 }, hosts, pageEnv = {} } = {}) {
  const s = await askerFixture(t, { dialog, ...(hosts ? { hosts } : {}) });
  Object.assign(s.env, pageEnv);
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env });
  const id = await askGate(server, { question: "Keep the old export layout? Choose keep to approve." });
  const review = await s.page();
  await settled(async () => (await card(review, id))?.asker, Boolean);
  assert.equal((await answer(review, id, "drop")).status, 200);
  return { s, id, review };
}

test("clause 22: a cloud asker offers a wake on a computer that is not a cloud session", { skip: posixOnly }, async (t) => {
  const { id, review } = await answered(t);
  const option = await wakeOption(review, id);
  assert.deepEqual([option.label, option.reason ?? null], ["Wake the cloud session that asked", null]);
});

test("clause 22: a wake names why it does not apply to a session outside the cloud, from a cloud session, or without claude", { skip: posixOnly }, async (t) => {
  const local = await answered(t, { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  assert.equal((await wakeOption(local.review, local.id)).reason, "The session that asked is not a cloud session.");
  const inCloud = await answered(t, { pageEnv: { CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01TheReviewAppsOwnCloud" } });
  assert.equal((await wakeOption(inCloud.review, inCloud.id)).reason, "A wake must be sent from your own computer, not from a cloud session.");
  const noClaude = await answered(t, { hosts: ["codex"] });
  assert.equal((await wakeOption(noClaude.review, noClaude.id)).reason, "Claude Code was not found: no claude executable on PATH.");
});

test("clauses 23, 25: a confirmed wake sends only the pointer to the cloud session from this checkout", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t);
  const sent = await wake(review, id);
  assert.equal(sent.status, 200, sent.text);
  const [dialog] = s.dialogs();
  assert.ok(dialog.text.includes(`https://claude.ai/code/session_${CLOUD_SESSION.slice(4)}`) && dialog.text.includes(id), dialog.text);
  const [entry] = await settled(() => s.wakes(), (list) => list.length === 1);
  assert.deepEqual(entry.argv, ["-p", pointer(id), "--cloud", CLOUD_SESSION]);
  assert.equal(entry.cwd, s.root);
  assert.deepEqual(entry.env, { CLAUDE_CODE_SESSION_ID: null, CLAUDE_CODE_REMOTE_SESSION_ID: null, PRISM_LAUNCH: null });
  const text = entry.argv[1];
  for (const leaked of ["drop", "Drop", "keep", "approve", "Choose"]) assert.ok(!text.includes(leaked), `the pointer carries no answer, choice, or approval: ${leaked}`);
});

test("clause 24: the card shows that the wake was delivered", { skip: posixOnly }, async (t) => {
  const { id, review } = await answered(t);
  const sent = await wake(review, id);
  assert.deepEqual([sent.json.wake.delivered, sent.json.wake.reason], [true, null]);
  const shown = await settled(async () => (await card(review, id))?.asker?.wake, Boolean);
  assert.deepEqual([shown.delivered, shown.reason, typeof shown.at], [true, null, "string"]);
});

test("clause 24: a wake the harness refuses shows as not delivered with the harness's reason", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t);
  await s.setWake({ code: 1, stderr: "Error: session cse_01LateGateCloudSession7 belongs to another account" });
  const sent = await wake(review, id);
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual([sent.json.wake.delivered, sent.json.wake.reason], [false, "Error: session cse_01LateGateCloudSession7 belongs to another account"]);
  const shown = await settled(async () => (await card(review, id))?.asker?.wake, Boolean);
  assert.equal(shown.delivered, false);
  await s.setWake({ code: 7 });
  assert.equal((await wake(review, id)).json.wake.reason, "The wake exited with code 7.");
});

test("clause 25: a declined wake sends nothing", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t, { dialog: { code: 1 } });
  const refused = await wake(review, id);
  assert.notEqual(refused.status, 200);
  await pause(500, "a declined wake must run no claude, which no event signals");
  assert.deepEqual(s.wakes(), []);
});
