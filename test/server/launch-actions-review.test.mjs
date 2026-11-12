import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
