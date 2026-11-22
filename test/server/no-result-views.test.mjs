import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";

// headless-run-questions §13 to §16: the review app shows a session that ended without a result on Attention as one card with the
// run's last message, in the agents list and the top bar as needing the person, apart from failed and waiting ones, and offers Archive.
// The card names its session as the permission request card of an ACP or any other launched host does, so it reads the same on every host.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-no-result-views-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

const sessions = () => import("../../dist/server/session/launched-sessions.mjs");
const ctx = { hasArtifact: () => true, renderMarkdown: (text) => `<p>${text}</p>` };
const STATE = "ended-without-result";

async function ended(fixture, host) {
  const { startLaunch, listLaunches } = await sessions();
  const id = (await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host, env: fixture.env })).launch.id;
  return waitFor(async () => {
    const view = (await listLaunches({ projectRoot: fixture.root, env: fixture.env })).launches.find((launch) => launch.id === id);
    return view && ["ended-without-result", "failed"].includes(view.state) ? view : null;
  }, { what: `launch ${id} to end` });
}

test("§13 on this machine Attention lists the no-result gate with its launch, and its card shows the session, the last message, the answer form, and Archive session", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 50 }] } });
  fixture.useAsProcessEnv();
  const view = await ended(fixture, "claude-code");
  const { loadAttentionView } = await import("../../dist/server/review/workspace-model.mjs");
  const attention = await waitFor(async () => {
    const read = await loadAttentionView(fixture.root);
    return read.needsYou.some((item) => item.id === view.questionGate) ? read : null;
  }, { what: "the no-result gate on Attention" });
  const item = attention.needsYou.find((entry) => entry.id === view.questionGate);
  assert.equal(item.type, "gate");
  assert.equal(item.kind, "assistance");
  assert.deepEqual(item.launch, { id: view.id, host: { id: "claude-code", label: "Claude Code" }, launchedAt: view.launchedAt, endedAt: view.endedAt, state: STATE });
  const { gateDetail, answerState } = await import("../../dist/server/review/public/views/attention.js");
  const html = gateDetail(item, ctx, {});
  for (const text of ["Run ended without a result", "Last message", "done", "Claude Code", "Archive session", "Answer and resume"]) assert.ok(html.includes(text), `the card shows ${text}`);
  assert.equal(html.includes("What happened"), false, "the last message replaces the context block");
  const form = answerState(item, { note: "" });
  assert.deepEqual([form.choice, form.ready, form.noteLabel, form.notePlaceholder, form.submitLabel], ["done", true, "Your answer", "Answer the run's question, or say what it should do next", "Answer and resume"]);
});

test("§13 a card of a run that left no message says so, and a gate without its launch reads as an ordinary assistance gate", async () => {
  const { gateDetail } = await import("../../dist/server/review/public/views/attention.js");
  const base = { type: "gate", id: "gate-0123456789ab", kind: "assistance", question: `The launched Codex run of ${INITIATIVE} ended without a result. What should it do next?`, context: "Prism launched this run headless, and it ended without a gate, a pause, or a ship, so nobody saw what it needs.\n\nThe run left no message.", askedAt: "2026-11-21T10:00:00Z", answer: null, initiative: { id: INITIATIVE, title: "Export reports" }, slice: null, phase: null, claim: null, artifacts: [], unavailable: null };
  const local = gateDetail({ ...base, launch: { id: "launch-0123456789abcdef", host: { id: "codex", label: "Codex" }, launchedAt: "2026-11-21T09:00:00Z", endedAt: "2026-11-21T10:00:00Z", state: STATE } }, ctx, {});
  assert.ok(local.includes("The run left no message."));
  assert.ok(local.includes("Answer and resume"));
  const elsewhere = gateDetail(base, ctx, {});
  assert.equal(elsewhere.includes("Run ended without a result"), false);
  assert.equal(elsewhere.includes("Archive session"), false);
  assert.ok(elsewhere.includes("Mark as done"));
});

test("§14 the agents list puts a session that ended without a result in Needs you after failed ones, with Answer, and counts it apart", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { claude: [{ hold: 50, isError: true }], codex: [{ hold: 50 }] } });
  fixture.useAsProcessEnv();
  const failed = await ended(fixture, "claude-code");
  const unresolved = await ended(fixture, "codex");
  assert.deepEqual([failed.state, unresolved.state], ["failed", STATE]);
  const { listAgents } = await import("../../dist/server/review/agents.mjs");
  const { agents, counts } = await listAgents({ projectRoot: fixture.root, env: fixture.env });
  const needs = agents.filter((entry) => entry.group === "needs-you");
  assert.deepEqual(needs.map((entry) => entry.id), [`launch:${failed.id}`, `launch:${unresolved.id}`]);
  const entry = needs[1];
  assert.equal(entry.state, STATE);
  assert.equal(entry.action, "answer");
  assert.equal(entry.launch.questionGate, unresolved.questionGate);
  assert.deepEqual([counts.needsYou, counts.failed, counts.waiting, counts.endedWithoutResult], [2, 1, 0, 1]);
  const { stateOf, archivable, ENDED_STATES } = await import("../../dist/server/review/public/views/agents.js");
  assert.deepEqual(stateOf({ state: STATE }), ["Ended without a result", "info"]);
  assert.ok(ENDED_STATES.includes(STATE));
  assert.equal(archivable(entry), true, "§16 the Agents page offers Archive on it");
});

test("§14 an archived session that ended without a result leaves Needs you and every count", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t, { plans: { codex: [{ hold: 50 }] } });
  fixture.useAsProcessEnv();
  const unresolved = await ended(fixture, "codex");
  const { archiveEndedLaunches } = await sessions();
  assert.deepEqual(await archiveEndedLaunches({ projectRoot: fixture.root, env: fixture.env }), { archived: [unresolved.id] }, "§16 Archive all ended includes it");
  const { listAgents } = await import("../../dist/server/review/agents.mjs");
  const { agents, counts } = await listAgents({ projectRoot: fixture.root, env: fixture.env });
  assert.equal(agents.find((entry) => entry.id === `launch:${unresolved.id}`).group, "archived");
  assert.deepEqual([counts.needsYou, counts.endedWithoutResult], [0, 0]);
});

test("§15 the top bar button names and marks sessions that ended without a result apart from failed and waiting ones", async () => {
  const { agentSummaryName } = await import("../../dist/server/review/public/kit/elements/prism-agent-summary.js");
  assert.equal(agentSummaryName({ working: 1, failed: 1, noResult: 2, waiting: 1 }), "Agents: 1 working, 1 failed, 2 ended without a result, 1 waits");
  assert.equal(agentSummaryName({ working: 0, noResult: 1 }), "Agents: 0 working, 1 ended without a result");
  const { PrismAgentSummary } = await import("../../dist/server/review/public/kit/elements/prism-agent-summary.js");
  assert.ok(PrismAgentSummary.observedAttributes.includes("no-result"), "the button takes the count as its no-result attribute");
});

test("§13 the card names an ACP agent's session by its label in the same place line as a permission request card", async () => {
  const { gateDetail, permissionDetail } = await import("../../dist/server/review/public/views/attention.js");
  const initiative = { id: INITIATIVE, title: "Export reports" };
  const host = { id: "acp-gemini", label: "Gemini CLI" };
  const card = gateDetail({ type: "gate", id: "gate-0123456789ab", kind: "assistance", question: `The launched Gemini CLI run of ${INITIATIVE} ended without a result. What should it do next?`, context: "Prism launched this run headless, and it ended without a gate, a pause, or a ship, so nobody saw what it needs.\n\nIts last message:\n\nShould I park it?", askedAt: "2026-11-21T10:00:00Z", answer: null, initiative, slice: null, phase: null, claim: null, artifacts: [], unavailable: null, launch: { id: "launch-0123456789abcdef", host, launchedAt: "2026-11-21T09:00:00Z", endedAt: "2026-11-21T10:00:00Z", state: STATE } }, ctx, {});
  const permission = permissionDetail({ id: "perm-0123456789abcdef", launch: "launch-0123456789abcdef", initiative, host, action: "Write probe.txt", reason: "Gemini CLI asks before it runs a tool of kind edit.", askedAt: "2026-11-21T10:00:00Z" });
  const where = (html) => html.match(/<span class="attention-where">([^<]*)<\/span>/)?.[1] ?? null;
  assert.equal(where(permission), "Export reports · Gemini CLI");
  assert.equal(where(card), where(permission), "both cards name the session the same way");
  assert.ok(card.includes("Should I park it?"));
  assert.ok(card.includes("Run ended without a result"));
});
