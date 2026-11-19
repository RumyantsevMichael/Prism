import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveProject, entryOf, get, INITIATIVE } from "./fixtures/archived-launches.mjs";
import { plannedSlices } from "./fixtures/agents.mjs";
import { writeClaim } from "./fixtures/kit-browser.mjs";

// /api/agents with archived launched sessions and old expired claims: where an archived session is listed, when it leaves the archive
// by itself, and what the counts of the top bar and the Agents page leave out.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-archive-list-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const FIELDS = ["id", "kind", "group", "name", "harness", "model", "initiative", "slice", "activity", "state", "reason", "expiresAt", "launch", "action"];
const LAUNCH_FIELDS = ["id", "launchedAt", "runningMs", "runs", "endedAt", "exit", "resumeCommand", "waitingGate"];
const VIEW_FIELDS = ["answerWaits", "checkout", "endedAt", "exit", "holder", "host", "hostLabel", "id", "initiative", "launchedAt", "model", "reason", "resumeCommand", "runningMs", "runs", "state", "waitingGate"];

test("§8 a session that runs again leaves the archive, its mark is removed, and it stays unarchived once it ends again", async (t) => {
  const s = await archiveProject(t);
  const id = await s.launch("finished");
  assert.equal((await s.archive({ launch: id })).status, 200);
  await s.addRun(id, "running");
  await s.beat(id);
  const running = entryOf(await s.agents(), id);
  assert.deepEqual([running.group, running.state], ["launched", "running"], "a resumed session is not archived");
  assert.equal(await s.archiveMark(id), null, "the read that saw it run removed its mark");
  await s.rewrite(id, (record) => ({ ...record, runs: record.runs.map((run) => (run.endedAt ? run : { ...run, endedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), exit: { code: 0, signal: null } })) }));
  const ended = entryOf(await s.agents(), id);
  assert.deepEqual([ended.group, ended.state], ["launched", "finished"], "it ended again and is still not archived");
});

test("§8 a run that started and ended between two reads also unarchives the session", async (t) => {
  const s = await archiveProject(t);
  const id = await s.launch("failed");
  assert.equal((await s.archive({ launch: id })).status, 200);
  await s.addRun(id, "finished");
  const entry = entryOf(await s.agents(), id);
  assert.deepEqual([entry.group, entry.state, entry.launch.runs], ["launched", "finished", 2], "the mark names one run and the record holds two");
  assert.equal(await s.archiveMark(id), null);
});

test("§8 a session that waits for the person again leaves the archive", async (t) => {
  const s = await archiveProject(t);
  const id = await s.launch("finished");
  assert.equal((await s.archive({ launch: id })).status, 200);
  await s.markGate(id);
  const entry = entryOf(await s.agents(), id);
  assert.deepEqual([entry.group, entry.state, entry.action], ["needs-you", "waiting", "answer"]);
  assert.equal(await s.archiveMark(id), null);
});

test("§10 an archived session is listed in group archived with every field, after the expired claims, the latest launched first", async (t) => {
  const s = await archiveProject(t);
  const older = await s.launch("failed", { endedMinutesAgo: 90 });
  const newer = await s.launch("stopped", { endedMinutesAgo: 10 });
  const plain = await s.launch("finished");
  await writeClaim(s.root, INITIATIVE, INITIATIVE, { label: "Michael on work-mac", host: "Claude Code", minutesLeft: -60 });
  for (const id of [older, newer]) assert.equal((await s.archive({ launch: id })).status, 200);
  const body = await s.agents();
  assert.deepEqual(body.agents.map((agent) => [agent.group, agent.id]), [
    ["launched", `launch:${plain}`],
    ["expired", `claim:${INITIATIVE}/${INITIATIVE}`],
    ["archived", `launch:${newer}`],
    ["archived", `launch:${older}`]
  ]);
  for (const agent of body.agents) assert.deepEqual(Object.keys(agent).sort(), [...FIELDS].sort(), `${agent.id} carries every field`);
  const failed = entryOf(body, older);
  assert.deepEqual([failed.kind, failed.state, failed.action], ["launch", "failed", "open"], "an archived session keeps its state and offers its details");
  assert.deepEqual(Object.keys(failed.launch).sort(), [...LAUNCH_FIELDS].sort());
  assert.ok(failed.launch.resumeCommand.command.length > 0, "an archived session keeps its terminal command");
  assert.match(failed.reason, /reported an error/);
  const launches = (await get(s.base, "api/launches")).json.launches;
  assert.equal(launches.length, 3, "api/launches lists archived sessions too");
  for (const view of launches) assert.deepEqual(Object.keys(view).sort(), VIEW_FIELDS, "a launch view carries no archive field");
});

test("§11 the counts leave archived sessions and claims that expired a day ago out, with the same keys", async (t) => {
  const s = await archiveProject(t);
  const failed = await s.launch("failed");
  const archivedFailed = await s.launch("failed");
  const archivedFinished = await s.launch("finished");
  const running = await s.launch("running");
  await plannedSlices(s.root, [["live", "Signed download link"], ["recent", "Audit event schema"], ["old", "Export file naming"]]);
  await s.beat(running);
  await writeClaim(s.root, INITIATIVE, "live", { label: "Dana on studio-mac", host: "Codex", model: "gpt-5.5", minutesLeft: 20 });
  await writeClaim(s.root, INITIATIVE, "recent", { label: "Sam on ci-runner-02", host: "OpenCode", minutesLeft: -(23 * 60) });
  await writeClaim(s.root, INITIATIVE, "old", { label: "Michael on work-mac", host: "Claude Code", minutesLeft: -(25 * 60), minutesClaimed: 26 * 60 });
  for (const id of [archivedFailed, archivedFinished]) assert.equal((await s.archive({ launch: id })).status, 200);
  await s.beat(running);
  const { counts, agents } = await s.agents();
  assert.equal(agents.length, 7, "every agent is listed, archived and old expired ones too");
  assert.deepEqual(counts, { all: 5, needsYou: 1, failed: 1, waiting: 0, thisComputer: 2, other: 1, expired: 1, working: 2 },
    "all: the failed and the running launch, the live claim, the claim that expired 23 hours ago, and nothing archived or expired a day ago");
  assert.equal(entryOf({ agents }, failed).group, "needs-you");
});

test("§12 every expired claim is listed, however long ago it expired", async (t) => {
  const s = await archiveProject(t);
  await plannedSlices(s.root, [["recent", "Audit event schema"], ["week", "Export file naming"]]);
  await writeClaim(s.root, INITIATIVE, "recent", { label: "Sam on ci-runner-02", minutesLeft: -30 });
  await writeClaim(s.root, INITIATIVE, "week", { label: "Michael on work-mac", minutesLeft: -(7 * 24 * 60), minutesClaimed: 7 * 24 * 60 + 60 });
  const { agents } = await s.agents();
  assert.deepEqual(agents.map((agent) => [agent.group, agent.id]), [["expired", `claim:${INITIATIVE}/recent`], ["expired", `claim:${INITIATIVE}/week`]]);
});
