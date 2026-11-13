import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";
import { apply, get, pageSession, startActionReview } from "./fixtures/review-actions.mjs";

// Review checks of the launch actions beyond the frozen tests: which asks mark a gate, what a stop leaves for a later answer, and the bounds of the gate record.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-actions-review-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts and dialogs are POSIX scripts" : false;

async function setup(t, options = {}) {
  const fixture = await launchFixture(t, { dialog: { code: 0 }, ...options });
  fixture.useAsProcessEnv();
  const { review, base, opened } = await startActionReview(t, fixture.root);
  const headers = await pageSession(review, opened);
  const launchView = async (id) => (await get(base, "api/launches")).json.launches.find((launch) => launch.id === id) ?? null;
  return { ...fixture, review, base, headers, launchView };
}

async function ask(root, launchId, initiative = INITIATIVE) {
  const { updateCoordinationState, readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const read = await readCoordinationState({ projectRoot: root, initiative });
  process.env.PRISM_LAUNCH = launchId;
  try {
    const written = await updateCoordinationState({ projectRoot: root, initiative, expectedRevision: read.exists ? read.revision : null, changes: { gateOperations: [{ op: "ask", kind: "decision", question: "Which window?", context: "Exports stay on disk.", artifacts: [], recommended: { reason: "A month covers an audit." } }] } });
    return written.openedGates[0].id;
  } finally {
    delete process.env.PRISM_LAUNCH;
  }
}

const historyOf = async (root) => {
  const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  return (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state?.history ?? [];
};

const gatesFile = (s, id) => path.join(s.app, "launches", id, "gates.json");

test("an ask marks a gate only for a launch of this machine of the same initiative", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: "forever" }] } });
  const id = (await apply(s.base, { action: "launch.claude-code", target: `initiative:${INITIATIVE}`, input: {}, revision: null }, s.headers)).json.launch.id;
  await ask(s.root, id, "search");
  await ask(s.root, "launch-0000000000000000");
  await assert.rejects(readFile(gatesFile(s, id), "utf8"), (error) => error.code === "ENOENT", "an ask of another initiative marks nothing");
  assert.equal((await s.launchView(id)).state, "running");
  await ask(s.root, id);
  assert.equal(JSON.parse(await readFile(gatesFile(s, id), "utf8")).marks.length, 1);
  assert.equal((await s.launchView(id)).state, "waiting");
});

test("an answer kept for a run that the person then stops causes no resume, even when the host exits 0", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { codex: [{ hold: "forever" }, { hold: 50 }] } });
  const id = (await apply(s.base, { action: "launch.codex", target: `initiative:${INITIATIVE}`, input: {}, revision: null }, s.headers)).json.launch.id;
  const gateId = await ask(s.root, id);
  const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const read = await readCoordinationState({ projectRoot: s.root, initiative: INITIATIVE });
  const answered = await apply(s.base, { action: "gate.answer", target: `gate:${INITIATIVE}/${gateId}`, input: { note: "Thirty days." }, revision: read.revision }, s.headers);
  assert.equal(answered.json.launch.resumed, false);
  const stopped = await apply(s.base, { action: "launch.stop", target: `launch:${id}`, input: {}, revision: null }, s.headers);
  assert.equal(stopped.status, 200, stopped.text);
  assert.equal(stopped.json.launch.state, "stopped");
  assert.deepEqual(stopped.json.launch.exit, { code: 0, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(s.runs("codex").length, 1, "a stop is never followed by a resume for an answer");
});

test("the gate record keeps its newest marks and answers and drops malformed entries", async (t) => {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-gates-")));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const { readGateRecord, writeGateRecord, GATES_KEPT } = await import("../../dist/server/session/launch-records.mjs");
  const marks = Array.from({ length: GATES_KEPT + 20 }, (_, index) => ({ gate: `gate-${index.toString(16).padStart(8, "0")}`, at: new Date(0).toISOString() }));
  await writeGateRecord(folder, { marks, answers: [] });
  const kept = await readGateRecord(folder);
  assert.equal(kept.marks.length, GATES_KEPT);
  assert.equal(kept.marks[0].gate, marks[20].gate);
  await writeFile(path.join(folder, "gates.json"), JSON.stringify({
    marks: [{ gate: "gate-zz", at: "x" }, { gate: "gate-0000000a", at: new Date(0).toISOString(), extra: "dropped" }],
    answers: [{ entry: "a".repeat(32), gate: "gate-0000000a", run: "../../etc", resumed: false }, { entry: "b".repeat(32), gate: "gate-0000000a", run: null, resumed: "yes" }]
  }));
  assert.deepEqual(await readGateRecord(folder), {
    marks: [{ gate: "gate-0000000a", at: new Date(0).toISOString() }],
    answers: [{ entry: "b".repeat(32), gate: "gate-0000000a", run: null, resumed: false }]
  });
});

test("a stop request written for a run that already exited 0 keeps its supervisor from resuming for an answer", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: 50 }, { hold: 50 }] } });
  const id = (await apply(s.base, { action: "launch.claude-code", target: `initiative:${INITIATIVE}`, input: {}, revision: null }, s.headers)).json.launch.id;
  const gateId = await ask(s.root, id);
  await waitFor(async () => (await s.launchView(id))?.resumeCommand, { what: "the run to end" });
  // The answer as it is kept for a run that was running when the person answered, and the stop the person pressed while the run's end was recorded.
  // The stop is written first: the supervisor resumes for an answer once after the run's end is recorded, so an answer that it read before the stop would resume the session.
  const folder = path.join(s.app, "launches", id);
  const { token } = JSON.parse(await readFile(path.join(folder, "launch.json"), "utf8")).runs[0];
  await writeFile(path.join(folder, "stop.json"), JSON.stringify({ token, requestedAt: new Date().toISOString() }));
  const gates = JSON.parse(await readFile(gatesFile(s, id), "utf8"));
  await writeFile(gatesFile(s, id), JSON.stringify({ ...gates, answers: [{ entry: "c".repeat(32), gate: gateId, run: token, resumed: false }] }));
  const { resumeForAnswers } = await import("../../dist/server/session/launched-sessions.mjs");
  assert.equal(await resumeForAnswers({ id, token, env: s.env }), false);
  assert.equal(s.runs("claude").length, 1);
  await rm(path.join(folder, "stop.json"));
  assert.equal(await resumeForAnswers({ id, token, env: s.env }), true, "without the stop request the answer resumes the session");
  await waitFor(() => s.runs("claude").length === 2, { what: "the resumed run" });
});

test("a resume whose initiative shipped while the confirmation was open starts nothing and records nothing", { skip: posixOnly }, async (t) => {
  const s = await setup(t, { plans: { claude: [{ hold: 50 }, { hold: "forever" }] } });
  const id = (await apply(s.base, { action: "launch.claude-code", target: `initiative:${INITIATIVE}`, input: {}, revision: null }, s.headers)).json.launch.id;
  await waitFor(async () => (await s.launchView(id))?.state === "finished", { what: "the run to finish" });
  await writeFile(path.join(s.app, "launches", "window.json"), JSON.stringify({ confirmedAt: new Date(Date.now() - 40 * 60000).toISOString(), endsAt: new Date(Date.now() - 10 * 60000).toISOString() }));
  // The dialog ships the initiative before it confirms, as an orchestrate run elsewhere might while the person reads it.
  const { readRecord } = await import("../../dist/server/workflow/record-store.mjs");
  const roadmap = JSON.parse((await readRecord(s.root, { kind: "roadmap" })).bytes.toString("utf8"));
  for (const entry of roadmap.initiatives) if (entry.id === INITIATIVE) entry.decision = { kind: "shipped", at: new Date().toISOString() };
  const shipped = path.join(s.bin, "shipped-roadmap.json");
  await writeFile(shipped, `${JSON.stringify(roadmap, null, 2)}\n`);
  const zenity = path.join(s.bin, "zenity");
  await writeFile(zenity, `#!${process.execPath}
const { pathToFileURL } = require("node:url");
import(pathToFileURL(${JSON.stringify(path.resolve("dist/server/workflow/record-store.mjs"))}).href)
  .then(({ writeRecord }) => writeRecord(${JSON.stringify(s.root)}, { kind: "roadmap" }, require("node:fs").readFileSync(${JSON.stringify(shipped)}, "utf8")))
  .then(() => process.exit(0), () => process.exit(1));
`);
  await chmod(zenity, 0o755);
  const before = await historyOf(s.root);
  const resumed = await apply(s.base, { action: "launch.resume", target: `launch:${id}`, input: {}, revision: null }, s.headers);
  assert.equal(resumed.status, 409, resumed.text);
  assert.equal(resumed.json.code, "action_unavailable");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(s.runs("claude").length, 1);
  assert.deepEqual(await historyOf(s.root), before);
});
