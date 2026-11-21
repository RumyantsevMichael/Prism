import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentsProject, askAsLaunch, CODEX_THREAD, holderOf, INITIATIVE, plannedSlices, waitFor, writeClaim } from "./fixtures/agents.mjs";
import { get } from "./fixtures/review-actions.mjs";

// /api/agents: one entry per launched session of this computer and per claim that no launched session holds, grouped by what needs
// the person, with the counts the top bar and the Agents page show.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-agents-list-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const FIELDS = ["id", "kind", "group", "name", "harness", "model", "session", "initiative", "slice", "activity", "state", "reason", "expiresAt", "launch", "action"];
const LAUNCH_FIELDS = ["id", "launchedAt", "runningMs", "runs", "endedAt", "exit", "resumeCommand", "waitingGate"];

// A failed launch, a waiting one that holds a claim, a running one, and claims of other sessions: two live, one without a harness, and one expired.
async function busyProject(t) {
  const s = await agentsProject(t, {
    plans: { claude: [{ model: "claude-opus-5-5", isError: true, hold: 50 }, { model: "claude-sonnet-5-5", hold: "forever" }], codex: [{ model: "gpt-5.5-codex", hold: "forever" }] },
    before: (fixture) => plannedSlices(fixture.root, [["download", "Signed download link"], ["audit", "Audit event schema"], ["naming", "Export file naming"], ["retention", "Retention policy"]])
  });
  const failed = await s.start(INITIATIVE, "claude-code");
  await s.settledLaunch(failed, (view) => view.state === "failed");
  const running = await s.start("search", "codex");
  await s.settledLaunch(running, (view) => view.state === "running");
  const waiting = await s.start(INITIATIVE, "claude-code");
  await s.settledLaunch(waiting, (view) => view.state === "running");
  const waitingSession = s.runs("claude")[1].argv[3];
  const gate = await askAsLaunch(s.root, waiting, "Which retention window?");
  await s.settledLaunch(waiting, (view) => view.state === "waiting");
  // The waiting launch's own session holds a design claim on retention; the other claims belong to sessions elsewhere.
  await writeClaim(s.root, INITIATIVE, "retention", { label: "Prism Test on vm", host: "Claude Code", model: "claude-sonnet-5-5", holder: holderOf(waitingSession), activity: "design", minutesLeft: 28 });
  await writeClaim(s.root, INITIATIVE, "download", { label: "Dana on studio-mac", host: "Codex", model: "gpt-5.5", activity: "design", minutesLeft: 22 });
  await writeClaim(s.root, INITIATIVE, "audit", { label: "Claude on vm", minutesLeft: 9 });
  await writeClaim(s.root, INITIATIVE, "naming", { label: "Michael on work-mac", host: "Claude Code", model: "Opus 5", activity: "design", minutesLeft: -120 });
  return { ...s, failed, running, waiting, waitingSession, gate };
}

const listed = async (s) => {
  const answer = await s.agents();
  assert.equal(answer.status, 200, answer.text);
  return answer.json;
};

test("§10 §11 §12 each agent is one entry, in groups by what needs the person, and a launch shows once with the claim it holds", { skip: posixOnly, timeout: 90000 }, async (t) => {
  const s = await busyProject(t);
  const { agents } = await waitFor(async () => {
    const body = await listed(s);
    return body.agents.length === 6 ? body : null;
  }, { what: "six agents" });
  assert.deepEqual(agents.map((agent) => [agent.group, agent.id]), [
    ["needs-you", `launch:${s.failed}`],
    ["needs-you", `launch:${s.waiting}`],
    ["launched", `launch:${s.running}`],
    ["other", `claim:${INITIATIVE}/audit`],
    ["other", `claim:${INITIATIVE}/download`],
    ["expired", `claim:${INITIATIVE}/naming`]
  ], "failed before waiting, then launches, then live claims by the one that lapses first, then expired claims; the held claim on retention shows no row of its own");
  for (const agent of agents) assert.deepEqual(Object.keys(agent).sort(), [...FIELDS].sort(), `${agent.id} carries every field`);
  const byId = Object.fromEntries(agents.map((agent) => [agent.id, agent]));
  const waiting = byId[`launch:${s.waiting}`];
  assert.deepEqual({ kind: waiting.kind, name: waiting.name, harness: waiting.harness, model: waiting.model, initiative: waiting.initiative, slice: waiting.slice, activity: waiting.activity, state: waiting.state, action: waiting.action, expiresAt: waiting.expiresAt },
    { kind: "launch", name: "Export reports", harness: "Claude Code", model: "claude-sonnet-5-5", initiative: { id: INITIATIVE, title: "Export reports" }, slice: { ref: `slice:${INITIATIVE}/retention`, title: "Retention policy" }, activity: "design", state: "waiting", action: "answer", expiresAt: null });
  assert.deepEqual(Object.keys(waiting.launch).sort(), [...LAUNCH_FIELDS].sort());
  assert.equal(waiting.launch.id, s.waiting);
  assert.equal(waiting.launch.waitingGate, s.gate);
  assert.equal(waiting.launch.resumeCommand, null, "a running session has no terminal command");
  const failed = byId[`launch:${s.failed}`];
  assert.deepEqual([failed.state, failed.action, failed.model, failed.slice, failed.activity], ["failed", "open", "claude-opus-5-5", null, null]);
  assert.match(failed.reason, /Claude Code reported an error/);
  assert.match(failed.launch.endedAt, /^\d{4}-/);
  assert.ok(failed.launch.resumeCommand.command.includes(s.runs("claude")[0].argv[3]));
  const running = byId[`launch:${s.running}`];
  assert.deepEqual([running.name, running.harness, running.model, running.state, running.action], ["Search", "Codex", "gpt-5.5-codex", "running", "stop"]);
  const dana = byId[`claim:${INITIATIVE}/download`];
  assert.deepEqual({ kind: dana.kind, name: dana.name, harness: dana.harness, model: dana.model, slice: dana.slice, activity: dana.activity, state: dana.state, action: dana.action, launch: dana.launch, reason: dana.reason },
    { kind: "claim", name: "Dana on studio-mac", harness: "Codex", model: "gpt-5.5", slice: { ref: `slice:${INITIATIVE}/download`, title: "Signed download link" }, activity: "design", state: "working", action: null, launch: null, reason: null });
  assert.match(dana.expiresAt, /^\d{4}-/);
  const bare = byId[`claim:${INITIATIVE}/audit`];
  assert.deepEqual([bare.harness, bare.model, bare.state], [null, null, "working"], "a claim that records no harness or model names none");
  const expired = byId[`claim:${INITIATIVE}/naming`];
  assert.deepEqual([expired.state, expired.model, expired.action], ["expired", "Opus 5", null]);
  const text = JSON.stringify(agents);
  assert.equal(text.includes(holderOf(s.waitingSession)), false, "no entry names a claim holder");
  assert.equal(text.replace(failed.launch.resumeCommand.command, "").includes(s.runs("claude")[0].argv[3]), false, "no host session id outside a terminal command");
  assert.equal(text.includes(CODEX_THREAD), false, "a running Codex session shows no thread id");
});

test("§13 the counts sum each group, count a launch once with its claim, and count working agents", { skip: posixOnly, timeout: 90000 }, async (t) => {
  const s = await busyProject(t);
  const { counts } = await waitFor(async () => {
    const body = await listed(s);
    return body.agents.length === 6 ? body : null;
  }, { what: "six agents" });
  assert.deepEqual(counts, { all: 6, needsYou: 2, failed: 1, waiting: 1, thisComputer: 3, other: 2, expired: 1, working: 4 },
    "working: the waiting and the running launch, and the two live claims no launch holds");
});

test("§10 §13 with nothing launched and no claims the list is empty, and it needs no write session", { skip: posixOnly, timeout: 60000 }, async (t) => {
  const s = await agentsProject(t, {});
  const answer = await get(s.base, "api/agents");
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual(answer.json, { agents: [], counts: { all: 0, needsYou: 0, failed: 0, waiting: 0, thisComputer: 0, other: 0, expired: 0, working: 0 } });
});
