import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentsProject, askAsLaunch, CODEX_THREAD, holderOf, INITIATIVE, waitFor } from "./fixtures/agents.mjs";

// A launched session keeps the model its host reports for each run, and /api/launches names that model, the claim holder its
// session takes claims as, the question it waits on, and when its last run ended, without ever naming its host session id outside
// the terminal command that continues it.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-facts-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

test("§8 §9 a Claude Code run keeps the model of its init event, and a resumed run's model replaces it", { skip: posixOnly, timeout: 60000 }, async (t) => {
  const s = await agentsProject(t, { plans: { claude: [{ model: "claude-opus-5-5", hold: 50 }, { model: "claude-sonnet-5-5", hold: 50 }] } });
  const id = await s.start(INITIATIVE, "claude-code");
  const first = await s.settledLaunch(id, (view) => view.state === "finished");
  assert.equal(first.model, "claude-opus-5-5");
  const { resumeLaunch } = await import("../../dist/server/session/launched-sessions.mjs");
  await resumeLaunch({ id, env: s.env });
  const second = await s.settledLaunch(id, (view) => view.runs === 2 && view.state === "finished");
  assert.equal(second.model, "claude-sonnet-5-5", "the launch names its last run's model");
});

test("§8 §9 a Codex run keeps the model of its thread start while it runs", { skip: posixOnly, timeout: 60000 }, async (t) => {
  const s = await agentsProject(t, { plans: { codex: [{ model: "gpt-5.5-codex", hold: "forever" }] } });
  const id = await s.start(INITIATIVE, "codex");
  const running = await s.settledLaunch(id, (view) => view.state === "running" && view.model !== null);
  assert.equal(running.model, "gpt-5.5-codex");
  assert.equal(running.endedAt, null, "a running launch has not ended");
});

test("§8 a run whose host names no model, or a malformed one, keeps none", { skip: posixOnly, timeout: 60000 }, async (t) => {
  const s = await agentsProject(t, { plans: { claude: [{ hold: 50 }], codex: [{ model: `m${"x".repeat(200)}`, hold: 50 }] } });
  const claude = await s.start(INITIATIVE, "claude-code");
  const codex = await s.start("search", "codex");
  const unnamed = await s.settledLaunch(claude, (view) => view.state === "finished");
  const malformed = await s.settledLaunch(codex, (view) => view.state === "finished");
  assert.equal(unnamed.model, null);
  assert.equal(malformed.model, null);
});

test("§9 a launch names the claim holder of its session and never its host session id outside the terminal command", { skip: posixOnly, timeout: 60000 }, async (t) => {
  const s = await agentsProject(t, { plans: { claude: [{ model: "claude-opus-5-5", hold: 50 }], codex: [{ model: "gpt-5.5", hold: 50 }] } });
  const claude = await s.start(INITIATIVE, "claude-code");
  const codex = await s.start("search", "codex");
  const claudeView = await s.settledLaunch(claude, (view) => view.state === "finished");
  const codexView = await s.settledLaunch(codex, (view) => view.state === "finished");
  const claudeSession = s.sessionOf("claude-code");
  assert.equal(claudeView.holder, holderOf(claudeSession));
  assert.equal(codexView.holder, holderOf(CODEX_THREAD));
  for (const [view, session] of [[claudeView, claudeSession], [codexView, CODEX_THREAD]]) {
    const { resumeCommand, ...rest } = view;
    assert.ok(resumeCommand.command.includes(session), "the terminal command still continues the session");
    assert.equal(JSON.stringify(rest).includes(session), false, "nothing else in the launch names the host session id");
    assert.match(view.endedAt, /^\d{4}-\d\d-\d\dT/, "an ended launch says when its last run ended");
  }
});

test("§9 a waiting launch names the question it waits on, and names none once the question is answered", { skip: posixOnly, timeout: 60000 }, async (t) => {
  const s = await agentsProject(t, { plans: { claude: [{ model: "claude-opus-5-5", hold: "forever" }] } });
  const id = await s.start(INITIATIVE, "claude-code");
  await s.settledLaunch(id, (view) => view.state === "running");
  assert.equal((await s.launchView(id)).waitingGate, null, "a running launch waits on nothing");
  const first = await askAsLaunch(s.root, id, "Which retention window?");
  await askAsLaunch(s.root, id, "Which signing key?");
  const waiting = await s.settledLaunch(id, (view) => view.state === "waiting");
  assert.equal(waiting.waitingGate, first, "the earliest question the session asked that waits on an answer");
  const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const { apply } = await import("./fixtures/review-actions.mjs");
  const read = await readCoordinationState({ projectRoot: s.root, initiative: INITIATIVE });
  const answered = await apply(s.base, { action: "gate.answer", target: `gate:${INITIATIVE}/${first}`, input: { note: "Thirty days." }, revision: read.revision }, s.headers);
  assert.equal(answered.status, 200, answered.text);
  const next = await waitFor(async () => {
    const view = await s.launchView(id);
    return view?.waitingGate && view.waitingGate !== first ? view : null;
  }, { what: "the launch to wait on its next question" });
  assert.notEqual(next.waitingGate, first);
});
