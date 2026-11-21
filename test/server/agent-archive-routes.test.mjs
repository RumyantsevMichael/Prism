import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveProject, ENDED_STATES, entryOf, INITIATIVE, NOT_ENDED, post, READ_ONLY } from "./fixtures/archived-launches.mjs";

// The archive routes of the review page: archiving one ended launched session or every ended one, unarchiving one, and what they refuse.
// The archive mark is kept beside the launch record on this machine only.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-archive-routes-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

test("§1 Archive archives one finished, failed, stopped, or blocked session, and archiving it again changes nothing", async (t) => {
  const s = await archiveProject(t);
  for (const state of ENDED_STATES) {
    const id = await s.launch(state);
    const answer = await s.archive({ launch: id });
    assert.equal(answer.status, 200, `${state}: ${answer.text}`);
    assert.deepEqual(answer.json, { archived: [id] }, state);
    assert.equal(entryOf(await s.agents(), id).group, "archived", `${state} is archived`);
    const mark = await s.archiveMark(id);
    const again = await s.archive({ launch: id });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.json, { archived: [] }, `${state}: an archived session is not archived again`);
    assert.deepEqual((await s.archiveMark(id)).value, mark.value, `${state}: its mark stays as it was`);
  }
});

test("§2 Archive all ended archives every ended session the page lists and leaves running and waiting ones", async (t) => {
  const s = await archiveProject(t);
  const ended = [];
  for (const state of ENDED_STATES) ended.push(await s.launch(state));
  const running = await s.launch("running");
  const waiting = await s.launch("waiting");
  const already = await s.launch("finished");
  assert.equal((await s.archive({ launch: already })).status, 200);
  await s.beat(running);
  const order = (await s.agents()).agents.filter((agent) => ended.includes(agent.launch?.id)).map((agent) => agent.launch.id);
  const answer = await s.archive({ ended: true });
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual(answer.json, { archived: order }, "every ended session that was not archived, in the order api/agents lists them");
  const body = await s.agents();
  for (const id of [...ended, already]) assert.equal(entryOf(body, id).group, "archived", id);
  assert.equal(entryOf(body, running).group, "launched", "a running session stays");
  assert.equal(entryOf(body, waiting).group, "needs-you", "a waiting session stays");
  assert.equal(await s.archiveMark(running), null);
  assert.equal(await s.archiveMark(waiting), null);
  const none = await s.archive({ ended: true });
  assert.deepEqual([none.status, none.json], [200, { archived: [] }], "with nothing left to archive it archives nothing");
});

test("§3 a running or waiting session is refused and nothing is written", async (t) => {
  const s = await archiveProject(t);
  const running = await s.launch("running");
  const waiting = await s.launch("waiting");
  await s.beat(running);
  for (const id of [running, waiting]) {
    const answer = await s.archive({ launch: id });
    assert.equal(answer.status, 409, answer.text);
    assert.deepEqual(answer.json, { code: "launch_not_ended", message: NOT_ENDED });
    assert.equal(await s.archiveMark(id), null);
    assert.notEqual(entryOf(await s.agents(), id).group, "archived");
  }
});

test("§4 Unarchive brings an archived session back, and answers an empty list for one that is not archived", async (t) => {
  const s = await archiveProject(t);
  const failed = await s.launch("failed");
  const finished = await s.launch("finished");
  assert.equal((await s.archive({ launch: failed })).status, 200);
  const answer = await s.unarchive({ launch: failed });
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual(answer.json, { unarchived: [failed] });
  assert.equal(entryOf(await s.agents(), failed).group, "needs-you", "a failed session needs the person again");
  assert.equal(await s.archiveMark(failed), null, "unarchiving removes the mark");
  const plain = await s.unarchive({ launch: finished });
  assert.deepEqual([plain.status, plain.json], [200, { unarchived: [] }]);
});

test("§5 an unknown launch is refused with 404 and a malformed request with 400", async (t) => {
  const s = await archiveProject(t);
  const id = await s.launch("finished");
  const elsewhere = await s.launch("finished");
  // A launch whose record names another record store is not listed for this checkout, so it is unknown here.
  await s.rewrite(elsewhere, (record) => ({ ...record, store: `${record.store}-elsewhere` }));
  for (const unknown of ["launch-0000000000000000", elsewhere]) {
    for (const route of [s.archive, s.unarchive]) {
      const answer = await route({ launch: unknown });
      assert.equal(answer.status, 404, answer.text);
      assert.deepEqual(answer.json, { code: "unknown_launch", message: `No launched session ${unknown} exists on this machine.` });
    }
  }
  const archiveMessage = "The request must be a JSON object that names a launch, or sets ended to true.";
  const unarchiveMessage = "The request must be a JSON object that names a launch.";
  for (const body of [[], "null", { launch: 5 }, { ended: false }, { launch: id, ended: true }, { launch: id, extra: 1 }, {}]) {
    const answer = await s.archive(body);
    assert.equal(answer.status, 400, `${JSON.stringify(body)}: ${answer.text}`);
    assert.deepEqual(answer.json, { code: "invalid_request", message: archiveMessage }, JSON.stringify(body));
  }
  for (const body of [[], { ended: true }, { launch: 5 }, {}]) {
    const answer = await s.unarchive(body);
    assert.equal(answer.status, 400, `${JSON.stringify(body)}: ${answer.text}`);
    assert.deepEqual(answer.json, { code: "invalid_request", message: unarchiveMessage }, JSON.stringify(body));
  }
  assert.equal(await s.archiveMark(id), null);
});

test("§6 archiving needs the page's write session and a JSON request from the page, while reading needs neither", async (t) => {
  const s = await archiveProject(t);
  const id = await s.launch("finished");
  for (const route of ["api/agents/archive", "api/agents/unarchive"]) {
    const unsigned = await post(s.base, route, { launch: id });
    assert.equal(unsigned.status, 403, unsigned.text);
    assert.deepEqual(unsigned.json, { code: "write_forbidden", message: READ_ONLY });
    const forged = await post(s.base, route, { launch: id }, { "X-Prism-Write": "not-a-session" });
    assert.equal(forged.status, 403);
    assert.equal(forged.json.code, "write_forbidden");
    const foreign = await post(s.base, route, { launch: id }, { ...s.headers, Origin: "https://example.invalid" });
    assert.deepEqual([foreign.status, foreign.json], [403, { code: "origin_refused", message: "A change must come from the review page as JSON." }]);
    const text = await fetch(`${s.base}/${route}`, { method: "POST", headers: { "Content-Type": "text/plain", ...s.headers }, body: JSON.stringify({ launch: id }) });
    assert.equal(text.status, 403);
    assert.equal((await text.json()).code, "origin_refused");
  }
  assert.equal(await s.archiveMark(id), null, "a refused request writes nothing");
  const read = await fetch(`${s.base}/api/agents`);
  assert.equal(read.status, 200, "reading the list needs no write session");
});

test("§7 the mark lives beside the launch record only, and archiving changes no record, checkout file, store file, or history", async (t) => {
  const s = await archiveProject(t);
  const id = await s.launch("blocked");
  const folder = s.folderOf(id);
  const before = await readFile(path.join(folder, "launch.json"));
  const git = () => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: s.root, encoding: "utf8" });
  const tree = async (root) => {
    const files = [];
    const walk = async (folder) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(file);
        else files.push([path.relative(root, file), (await readFile(file)).toString("base64")]);
      }
    };
    await walk(root);
    return files.sort();
  };
  const statusBefore = git();
  const checkoutBefore = await tree(s.root);
  const started = Date.now();
  assert.equal((await s.archive({ launch: id })).status, 200);
  const mark = await s.archiveMark(id);
  assert.ok(mark, "archive.json exists in the launch folder");
  assert.deepEqual(Object.keys(mark.value).sort(), ["archivedAt", "runs"]);
  assert.match(mark.value.archivedAt, ISO);
  assert.ok(Date.parse(mark.value.archivedAt) >= started - 1000, "archivedAt is the time of the archive");
  assert.equal(mark.value.runs, 1, "runs is the record's run count when it was archived");
  if (process.platform !== "win32") assert.equal(mark.info.mode & 0o777, 0o600, "the mark is private to the user");
  assert.deepEqual(await readFile(path.join(folder, "launch.json")), before, "the launch record is unchanged");
  assert.deepEqual((await readdir(folder)).sort(), ["archive.json", "launch.json"], "nothing else is written to the launch folder");
  assert.equal(git(), statusBefore, "the checkout's Git status is unchanged");
  assert.deepEqual(await tree(s.root), checkoutBefore, "no file of the checkout or its records changed, so no history entry was written");
  assert.equal((await s.unarchive({ launch: id })).status, 200);
  assert.deepEqual((await readdir(folder)).sort(), ["launch.json"], "unarchiving removes only the mark");
  assert.deepEqual(await readFile(path.join(folder, "launch.json")), before);
  assert.deepEqual(await tree(s.root), checkoutBefore);
});

test("§9 an archived session keeps its record and terminal command until the 14-day removal, which removes it as any other", async (t) => {
  const s = await archiveProject(t);
  const archived = await s.launch("finished");
  const plain = await s.launch("finished");
  assert.equal((await s.archive({ launch: archived })).status, 200);
  // Thirteen days after its run ended an archived session is still listed with its terminal command.
  const age = (days) => (record) => ({ ...record, runs: record.runs.map((run) => ({ ...run, startedAt: new Date(Date.now() - days * 86400000 - 60000).toISOString(), heartbeatAt: new Date(Date.now() - days * 86400000).toISOString(), endedAt: new Date(Date.now() - days * 86400000).toISOString() })) });
  await s.rewrite(archived, age(13));
  await s.rewrite(plain, age(13));
  const kept = entryOf(await s.agents(), archived);
  assert.equal(kept.group, "archived");
  assert.ok(kept.launch.resumeCommand?.command, "the terminal command stays");
  await s.rewrite(archived, age(15));
  await s.rewrite(plain, age(15));
  const body = await s.agents();
  assert.equal(entryOf(body, archived), undefined, "the archived session is removed after 14 days");
  assert.equal(entryOf(body, plain), undefined, "as a session that is not archived is");
  await assert.rejects(stat(s.folderOf(archived)), { code: "ENOENT" }, "its folder, mark and all, is gone");
  assert.equal(body.agents.some((agent) => agent.initiative?.id === INITIATIVE && agent.kind === "launch"), false);
});
