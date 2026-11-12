import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, readdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { INITIATIVE, LAUNCH_ID, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";
import { actionOf, apply, get, listing, pageSession, startActionReview } from "./fixtures/review-actions.mjs";

// Launch, stop, and resume as review app actions: listed on the initiative and on each launched session, confirmed outside
// the page, recorded in the initiative's history, and a gate answer given on this machine resuming the session that asked.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-actions-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts and dialogs are POSIX scripts" : false;
const SETTINGS = ["initiative.autonomy", "initiative.commit", "initiative.push", "initiative.continuation", "initiative.review", "initiative.models"];
const effect = (label) => `Starts a headless ${label} session on this computer that runs the orchestrate skill for this initiative; you confirm it outside the browser unless you confirmed in the last 30 minutes.`;

async function setup(t, options = {}) {
  const fixture = await launchFixture(t, { dialog: { code: 0 }, ...options });
  fixture.useAsProcessEnv();
  const { review, base, opened } = await startActionReview(t, fixture.root);
  const headers = await pageSession(review, opened);
  const launches = async () => (await get(base, "api/launches")).json.launches;
  const launchView = async (id) => (await launches()).find((launch) => launch.id === id) ?? null;
  const settled = (id, states) => waitFor(async () => {
    const view = await launchView(id);
    return view && states.includes(view.state) ? view : null;
  }, { what: `launch ${id} to reach ${states.join(" or ")}` });
  return { ...fixture, review, base, headers, launches, launchView, settled };
}

const launch = (s, host = "claude-code", initiative = INITIATIVE) => apply(s.base, { action: `launch.${host}`, target: `initiative:${initiative}`, input: {}, revision: null }, s.headers);
const history = async (root, initiative = INITIATIVE) => {
  const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  return (await readCoordinationState({ projectRoot: root, initiative })).state?.history ?? [];
};

// Asks a gate as the launched session's own Prism server would: its environment names the launch.
async function askAsLaunch(root, launchId, question = "Which retention window?") {
  const { updateCoordinationState, readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const read = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  process.env.PRISM_LAUNCH = launchId;
  try {
    const written = await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: read.exists ? read.revision : null, changes: { gateOperations: [{ op: "ask", kind: "decision", question, context: "Signed exports stay on disk for a while.", artifacts: [], recommended: { reason: "A month covers an audit." } }] } });
    return written.openedGates[0].id;
  } finally {
    delete process.env.PRISM_LAUNCH;
  }
}

const answer = async (s, gateId, note = "Thirty days.") => {
  const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const read = await readCoordinationState({ projectRoot: s.root, initiative: INITIATIVE });
  return apply(s.base, { action: "gate.answer", target: `gate:${INITIATIVE}/${gateId}`, input: { note }, revision: read.revision }, s.headers);
};

test("an initiative lists one launch action per host after its settings, and a slice lists none", { skip: posixOnly }, async (t) => {
  const s = await setup(t);
  const listed = await listing(s.base, `initiative:${INITIATIVE}`, s.headers);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.actions.map((action) => action.id), [...SETTINGS, "launch.claude-code", "launch.codex"]);
  for (const [id, label] of [["launch.claude-code", "Claude Code"], ["launch.codex", "Codex"]]) {
    assert.deepEqual(actionOf(listed, id), { id, label: `Launch with ${label}`, group: "Launched session", target: `initiative:${INITIATIVE}`, value: null, fields: [], effect: effect(label), context: null, recommended: null, available: true, reason: null, confirm: null, revision: null });
  }
  const slice = await listing(s.base, `slice:${INITIATIVE}/${INITIATIVE}`, s.headers);
  assert.deepEqual(slice.json.actions.map((action) => action.id), SETTINGS);
});

test("a launch action is unavailable with the reason while its host is missing", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { hosts: ["codex"] });
  const listed = await listing(s.base, `initiative:${INITIATIVE}`, s.headers);
  assert.equal(actionOf(listed, "launch.claude-code").available, false);
  assert.equal(actionOf(listed, "launch.claude-code").reason, "Claude Code was not found: no claude executable on PATH.");
  assert.equal(actionOf(listed, "launch.codex").available, true);
  const refused = await launch(s, "claude-code");
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, "action_unavailable");
  assert.equal(s.dialogs().length, 0, "an unavailable launch asks nothing");
});

test("a confirmed launch starts the session, records it in the initiative's history, and a launch in the window asks nothing", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: "forever" }], codex: [{ hold: "forever" }] } });
  const result = await launch(s);
  assert.equal(result.status, 200, result.text);
  assert.match(result.json.launch.id, LAUNCH_ID);
  assert.equal(result.json.launch.state, "running");
  assert.equal(result.json.applied.action, "launch.claude-code");
  assert.equal(result.json.applied.target, `initiative:${INITIATIVE}`);
  assert.equal(result.json.applied.before, null);
  assert.deepEqual(result.json.applied.after, { launch: result.json.launch.id, host: "claude-code" });
  assert.equal(result.json.applied.via, "review-app");
  assert.equal(s.dialogs().length, 1, "the first launch asks outside the page");
  assert.ok(s.dialogs()[0].argv.includes("--default-cancel"));
  const entries = await history(s.root);
  assert.deepEqual(entries.map((entry) => entry.id), [result.json.applied.id]);
  const [run] = await waitFor(() => s.runs("claude").length ? s.runs("claude") : null, { what: "the host to start" });
  assert.equal(run.env.PRISM_LAUNCH, result.json.launch.id);
  const second = await launch(s, "codex", "search");
  assert.equal(second.status, 200, second.text);
  assert.equal(s.dialogs().length, 1, "a launch inside the window shows no dialog");
  assert.deepEqual((await s.launches()).map((item) => item.initiative).sort(), [INITIATIVE, "search"]);
});

test("a launch takes no input, and a declined confirmation starts nothing and records nothing", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { dialog: { code: 1 } });
  const withText = await apply(s.base, { action: "launch.claude-code", target: `initiative:${INITIATIVE}`, input: { prompt: "rm -rf ~" }, revision: null }, s.headers);
  assert.equal(withText.status, 400);
  assert.equal(withText.json.code, "invalid_input");
  assert.equal(s.dialogs().length, 0);
  const declined = await launch(s);
  assert.equal(declined.status, 409);
  assert.equal(declined.json.code, "confirmation_declined");
  assert.equal(declined.json.message, "You declined the launch.");
  assert.equal(s.runs().length, 0);
  assert.deepEqual(await history(s.root), []);
  assert.deepEqual(await s.launches(), []);
});

test("a tab without a write session cannot launch, and asks nothing", { skip: posixOnly }, async (t) => {
  const s = await setup(t);
  const refused = await apply(s.base, { action: "launch.claude-code", target: `initiative:${INITIATIVE}`, input: {}, revision: null });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "write_forbidden");
  assert.equal(s.dialogs().length, 0);
  assert.equal(s.runs().length, 0);
});

test("while an initiative's session runs, both launch actions are unavailable with the reason", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: "forever" }] } });
  assert.equal((await launch(s)).status, 200);
  const listed = await listing(s.base, `initiative:${INITIATIVE}`, s.headers);
  for (const id of ["launch.claude-code", "launch.codex"]) {
    assert.equal(actionOf(listed, id).available, false);
    assert.equal(actionOf(listed, id).reason, `A launched session of ${INITIATIVE} is running on this machine.`);
  }
  const again = await launch(s, "codex");
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "action_unavailable");
});

test("a launched session's page lists stop and resume, and a stop is recorded and ends the session", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: "forever" }] } });
  const id = (await launch(s)).json.launch.id;
  const listed = await listing(s.base, `launch:${id}`, s.headers);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.actions.map((action) => action.id), ["launch.stop", "launch.resume"]);
  assert.deepEqual(actionOf(listed, "launch.stop"), { id: "launch.stop", label: "Stop", group: "Launched session", target: `launch:${id}`, value: null, fields: [], effect: "Interrupts the host's turn as the host's own Stop button does, and ends the host process if it still runs after the grace period.", context: null, recommended: null, available: true, reason: null, confirm: null, revision: null });
  assert.equal(actionOf(listed, "launch.resume").available, false);
  assert.equal(actionOf(listed, "launch.resume").reason, "The session is running.");
  const stopped = await apply(s.base, { action: "launch.stop", target: `launch:${id}`, input: {}, revision: null }, s.headers);
  assert.equal(stopped.status, 200, stopped.text);
  assert.equal(stopped.json.launch.state, "stopped");
  assert.equal(stopped.json.applied.target, `launch:${id}`);
  assert.equal(stopped.json.applied.after, "stopped");
  assert.deepEqual((await history(s.root)).map((entry) => entry.action), ["launch.claude-code", "launch.stop"]);
  const after = await listing(s.base, `launch:${id}`, s.headers);
  assert.equal(actionOf(after, "launch.stop").available, false);
  assert.equal(actionOf(after, "launch.stop").reason, "The session is not running.");
  assert.equal(actionOf(after, "launch.resume").available, true);
  assert.equal((await listing(s.base, "launch:launch-0000000000000000", s.headers)).status, 404);
});

test("a session whose initiative shipped while it runs stays stoppable, records no stop, and cannot resume", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: "forever" }] } });
  const id = (await launch(s)).json.launch.id;
  // The orchestrate run ships its own initiative while its host still runs.
  const { readRecord, writeRecord } = await import("../../dist/server/workflow/record-store.mjs");
  const roadmap = JSON.parse((await readRecord(s.root, { kind: "roadmap" })).bytes.toString("utf8"));
  const at = new Date().toISOString();
  for (const entry of roadmap.initiatives) if (entry.id === INITIATIVE) entry.decision = { kind: "shipped", at };
  await writeRecord(s.root, { kind: "roadmap" }, `${JSON.stringify(roadmap, null, 2)}\n`);
  const listed = await listing(s.base, `launch:${id}`, s.headers);
  assert.deepEqual([actionOf(listed, "launch.stop").available, actionOf(listed, "launch.stop").reason], [true, null]);
  assert.equal(actionOf(listed, "launch.resume").reason, "The session is running.");
  const stopped = await apply(s.base, { action: "launch.stop", target: `launch:${id}`, input: {}, revision: null }, s.headers);
  assert.equal(stopped.status, 200, stopped.text);
  assert.equal(stopped.json.launch.state, "stopped");
  assert.ok(stopped.json.applied && Array.isArray(stopped.json.actions));
  assert.deepEqual((await history(s.root)).map((entry) => entry.action), ["launch.claude-code"]);
  const after = await listing(s.base, `launch:${id}`, s.headers);
  assert.equal(actionOf(after, "launch.resume").available, false);
  assert.equal(actionOf(after, "launch.resume").reason, `The initiative shipped on ${at.slice(0, 10)}, so its state is history.`);
});

test("the person's resume runs the session again, confirming outside the page once the window ended", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: 50 }, { hold: 50 }, { hold: 50 }] } });
  const id = (await launch(s)).json.launch.id;
  await s.settled(id, ["finished"]);
  const resumed = await apply(s.base, { action: "launch.resume", target: `launch:${id}`, input: {}, revision: null }, s.headers);
  assert.equal(resumed.status, 200, resumed.text);
  assert.deepEqual(resumed.json.applied.after, { launch: id, run: 2 });
  assert.equal(s.dialogs().length, 1, "the resume inside the window asks nothing");
  await waitFor(() => s.runs("claude").length === 2, { what: "the resumed run" });
  assert.equal(s.runs("claude")[1].argv[2], "--resume");
  // The window lives in the review app folder; ending it there makes the next resume ask again.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(s.app, "launches", "window.json"), JSON.stringify({ confirmedAt: new Date(Date.now() - 40 * 60000).toISOString(), endsAt: new Date(Date.now() - 10 * 60000).toISOString() }));
  await s.settled(id, ["finished"]);
  await s.setDialog({ code: 1 });
  const declined = await apply(s.base, { action: "launch.resume", target: `launch:${id}`, input: {}, revision: null }, s.headers);
  assert.equal(declined.status, 409);
  assert.equal(declined.json.code, "confirmation_declined");
  assert.equal(s.dialogs().length, 2);
  assert.equal(s.runs("claude").length, 2);
});

test("a gate that the launched session asks shows the session waiting, while it runs and after it ends", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: 1500 }] } });
  const id = (await launch(s)).json.launch.id;
  await askAsLaunch(s.root, id);
  assert.equal((await s.launchView(id)).state, "waiting");
  const ended = await waitFor(async () => {
    const view = await s.launchView(id);
    return view?.resumeCommand ? view : null;
  }, { what: "the run to end" });
  assert.equal(ended.state, "waiting");
});

test("an answer given here to the ended session's gate resumes it headless without asking", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: 50 }, { hold: 50 }] } });
  const id = (await launch(s)).json.launch.id;
  const gateId = await askAsLaunch(s.root, id);
  await waitFor(async () => (await s.launchView(id))?.resumeCommand, { what: "the run to end" });
  await s.setDialog({ code: 1 });
  const answered = await answer(s, gateId);
  assert.equal(answered.status, 200, answered.text);
  assert.deepEqual(answered.json.launch, { id, resumed: true, reason: null });
  await waitFor(() => s.runs("claude").length === 2, { what: "the resumed run" });
  const [first, second] = s.runs("claude");
  assert.deepEqual(second.argv.slice(0, 4), ["-p", "--verbose", "--resume", first.argv[3]]);
  assert.deepEqual(s.inputs(second.pid)[0], { type: "user", message: { role: "user", content: `/prism:orchestrate ${INITIATIVE}` } });
  assert.equal(s.dialogs().length, 1, "the gate answer resumes without a confirmation");
});

test("an answer given while the session runs reaches it there, and resumes it once if the run then ends with the gate open", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: 1200 }, { hold: 50 }, { hold: 50 }] } });
  const id = (await launch(s)).json.launch.id;
  const gateId = await askAsLaunch(s.root, id);
  const answered = await answer(s, gateId);
  assert.deepEqual(answered.json.launch, { id, resumed: false, reason: "The session is running and receives the answer there." });
  await waitFor(() => s.runs("claude").length === 2, { what: "the one resume after the run ended" });
  await s.settled(id, ["finished"]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(s.runs("claude").length, 2, "one answer causes at most one resume");
});

test("an answer that another launched session of the initiative would contend with starts nothing", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: 50 }], codex: [{ hold: "forever" }] } });
  const id = (await launch(s)).json.launch.id;
  const gateId = await askAsLaunch(s.root, id);
  await waitFor(async () => (await s.launchView(id))?.resumeCommand, { what: "the run to end" });
  assert.equal((await launch(s, "codex")).status, 200);
  const answered = await answer(s, gateId);
  assert.deepEqual(answered.json.launch, { id, resumed: false, reason: `Another launched session of ${INITIATIVE} is running on this machine.` });
  assert.equal(s.runs("claude").length, 1);
});

test("an answer that arrives from another machine through the store waits for a resume here", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: 50 }] } });
  const id = (await launch(s)).json.launch.id;
  const gateId = await askAsLaunch(s.root, id);
  await waitFor(async () => (await s.launchView(id))?.resumeCommand, { what: "the run to end" });
  // A store sync brings the answer: it lands in the coordination state without passing through this machine's actions.
  const { recordPersonAction } = await import("../../dist/server/workflow/state.mjs");
  const at = new Date().toISOString();
  const entry = { id: randomBytes(16).toString("hex"), action: "gate.answer", target: `gate:${INITIATIVE}/${gateId}`, before: null, after: { choice: null, note: "Ninety days." }, at, by: { name: "Grace", email: "grace@example.invalid", checkout: "reports/main on build-2" }, via: "review-app" };
  await recordPersonAction({ projectRoot: s.root, initiative: INITIATIVE, prepare: async () => ({ entry, answer: { id: gateId, choice: null, note: "Ninety days." } }) });
  const view = await s.launchView(id);
  assert.equal(view.answerWaits, true);
  assert.equal(view.state, "finished");
  assert.equal(view.reason, "An answer given on another machine waits; resume this session here to continue.");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(s.runs("claude").length, 1, "nothing resumes on an answer from another machine");
});

test("no record that can reach the shared store holds the host session id", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: 50 }, { hold: 50 }] } });
  const id = (await launch(s)).json.launch.id;
  const gateId = await askAsLaunch(s.root, id);
  await waitFor(async () => (await s.launchView(id))?.resumeCommand, { what: "the run to end" });
  await answer(s, gateId);
  await waitFor(() => s.runs("claude").length === 2, { what: "the resumed run" });
  const sessionId = s.runs("claude")[0].argv[3];
  const files = (await readdir(path.join(s.root, ".prism"), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  for (const file of files) assert.ok(!(await readFile(path.join(file.parentPath ?? file.path, file.name), "utf8")).includes(sessionId), `${file.name} holds the host session id`);
  for (const entry of await history(s.root)) assert.ok(!JSON.stringify(entry).includes(sessionId));
});

test("the launch list is readable without a write session", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: "forever" }] } });
  const id = (await launch(s)).json.launch.id;
  const read = await get(s.base, "api/launches");
  assert.equal(read.status, 200);
  const [view] = read.json.launches;
  assert.equal(view.id, id);
  assert.deepEqual(Object.keys(view).sort(), ["answerWaits", "checkout", "exit", "host", "hostLabel", "id", "initiative", "launchedAt", "reason", "resumeCommand", "runningMs", "runs", "state"]);
});

test("no Prism tool lets an agent launch, resume, or stop a session", async (t) => {
  const child = spawn(process.execPath, [path.join(ROOT, "dist/server/mcp.mjs")], { cwd: ROOT, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PRISM_REVIEW_APP: "off", PRISM_REVIEW_BROWSER_ON_START: "off" } });
  t.after(() => child.kill());
  let buffer = "";
  const answers = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) answers.push(JSON.parse(line));
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  await waitFor(() => answers.find((item) => item.id === 1), { what: "initialize" });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  const listed = await waitFor(() => answers.find((item) => item.id === 2), { what: "tools/list" });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.length > 10);
  assert.deepEqual(names.filter((name) => /launch|resume|stop_session|start_session/i.test(name)), []);
});

test("Codex forwards the launch variable to Prism's server", async () => {
  const definition = JSON.parse(await readFile(path.join(ROOT, ".codex-mcp.json"), "utf8"));
  assert.ok(definition.mcpServers["prism-review"].env_vars.includes("PRISM_LAUNCH"));
});
