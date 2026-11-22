import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";

// The result check at the end of a launched run records its no-result gate and the launch's marks of that gate as one step:
// a run that starts while the gate is recorded leaves no pending no-result gate, and no view shows the session waiting on that gate.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-result-settle-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

const sessions = () => import("../../dist/server/session/launched-sessions.mjs");
const records = () => import("../../dist/server/session/launch-records.mjs");
const stateModule = () => import("../../dist/server/workflow/state.mjs");
const { withFileLock } = await import("../../dist/server/workflow/artifact-store.mjs");
const { locateRecord } = await import("../../dist/server/workflow/record-store.mjs");

async function viewOf(fixture, id) {
  const { listLaunches } = await sessions();
  return (await listLaunches({ projectRoot: fixture.root, env: fixture.env })).launches.find((launch) => launch.id === id) ?? null;
}
const reached = (fixture, id, states) => waitFor(async () => {
  const view = await viewOf(fixture, id);
  return view && states.includes(view.state) ? view : null;
}, { what: `launch ${id} to reach ${states.join(" or ")}` });
async function coordination(root) {
  const { readCoordinationState } = await stateModule();
  return (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state ?? {};
}
const isNoResult = (gate) => gate && gate.kind === "assistance" && typeof gate.question === "string" && gate.question.includes("ended without a result");
const pendingNoResult = async (root) => ((await coordination(root)).pending ?? []).filter(isNoResult);

// A launch whose first Claude Code run ended without a result, and the token of that run.
async function endedLaunch(t, plans) {
  const fixture = await launchFixture(t, { plans: { claude: plans } });
  const { startLaunch } = await sessions();
  const id = (await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", env: fixture.env })).launch.id;
  const first = await reached(fixture, id, ["ended-without-result"]);
  assert.ok(first.questionGate, "the first run ended with its own no-result gate");
  const { launchFolder, readLaunchRecord } = await records();
  const record = await readLaunchRecord(launchFolder(fixture.env, id));
  return { fixture, id, record, token: record.runs.at(-1).token, firstGate: first.questionGate };
}

// Holds the cross-process lock of a file until the returned release is called.
async function holdLock(file) {
  let release;
  let held;
  const acquired = new Promise((resolve) => { held = resolve; });
  const done = withFileLock(file, () => new Promise((resolve) => { held(); release = resolve; }));
  await acquired;
  return async () => { release(); await done; };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a run that starts while the result check records the no-result gate leaves no pending no-result gate", { skip: posixOnly }, async (t) => {
  const { fixture, id, token } = await endedLaunch(t, [{ hold: 50 }, { hold: "forever" }]);
  const { resumeLaunch, settleRunResult } = await sessions();
  // The coordination state's lock holds the check between its first read of the launch and the write of the gate.
  const { target } = await locateRecord(fixture.root, { kind: "state", initiative: INITIATIVE });
  const release = await holdLock(target);
  let settling;
  try {
    settling = settleRunResult({ id, token, normal: true, resumed: false, lastMessage: "done", env: fixture.env });
    await pause(300);
    await resumeLaunch({ id, env: fixture.env });
  } finally {
    await release();
  }
  await settling;
  const state = await coordination(fixture.root);
  assert.deepEqual((state.pending ?? []).filter(isNoResult), [], "no no-result gate of the ended run stays pending while the next run runs");
  const resolved = (state.closed ?? []).filter((gate) => isNoResult(gate) && /started before Prism recorded this question/.test(JSON.stringify(gate)));
  assert.equal(resolved.length, 1, "the check recorded the gate after the next run started, and then resolved it");
  const { launchFolder, readGateRecord, readResultMarks } = await records();
  const folder = launchFolder(fixture.env, id);
  assert.ok(!(await readGateRecord(folder)).marks.some((mark) => mark.gate === resolved[0].id), "the launch does not mark the resolved gate");
  assert.ok(!(await readResultMarks(folder)).noResult.some((mark) => mark.gate === resolved[0].id), "no no-result mark names the resolved gate");
  assert.equal((await viewOf(fixture, id)).state, "running");
});

test("no view shows the session waiting on a no-result gate that the launch marked", { skip: posixOnly }, async (t) => {
  const { fixture, id, record, token, firstGate } = await endedLaunch(t, [{ hold: 50 }]);
  const { settleRunResult } = await sessions();
  const { noticeDirectory } = await import("../../dist/server/workflow/change-notices.mjs");
  const { holderOf } = await import("../../dist/server/workflow/slice-claims.mjs");
  // The host session's notice record lock holds the check after the launch marked the gate and before the check ends.
  const session = holderOf(record.hostSessionId);
  const notice = path.join(noticeDirectory(fixture.env), `${createHash("sha256").update(`${session}\0${path.resolve(record.checkout)}\0${INITIATIVE}`, "utf8").digest("hex").slice(0, 32)}.json`);
  const release = await holdLock(notice);
  let settling;
  try {
    settling = settleRunResult({ id, token, normal: true, resumed: false, lastMessage: "done again", env: fixture.env });
    const { launchFolder, readGateRecord } = await records();
    const folder = launchFolder(fixture.env, id);
    await waitFor(async () => (await readGateRecord(folder)).marks.some((mark) => mark.gate !== firstGate) || null, { what: "the launch to mark the new no-result gate" });
    const view = await viewOf(fixture, id);
    const [gate] = await pendingNoResult(fixture.root);
    assert.ok(gate && gate.id !== firstGate, "the check recorded a new no-result gate");
    assert.equal(view.state, "ended-without-result");
    assert.equal(view.waitingGate, null);
    assert.equal(view.questionGate, gate.id);
  } finally {
    await release();
  }
  await settling;
  assert.equal((await viewOf(fixture, id)).state, "ended-without-result");
});
