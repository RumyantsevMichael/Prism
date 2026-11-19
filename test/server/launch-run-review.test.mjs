import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, launchFixture, waitFor } from "./fixtures/launched-sessions.mjs";

// Review checks of the coordinator's choice beyond the frozen tests: the host commands refuse a choice that breaks the name rules
// whoever passes it, a launch record without a choice resumes with host defaults, and a record whose choice was changed to one that
// breaks the rules resumes nothing.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-launch-run-review-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const hosts = () => import("../../dist/server/session/launch-hosts.mjs");
const sessions = () => import("../../dist/server/session/launched-sessions.mjs");
const SESSION = "0b6f2a52-6c1b-4d5e-9f3a-2b7c8d9e0f11";

test("the host commands take only a coordinator choice that keeps the name rules, and leave out each host default", async () => {
  const { codexThreadRequest, codexTurnRequest, hostArguments } = await hosts();
  const claude = (coordinator) => hostArguments({ host: "claude-code", hostSessionId: SESSION, resume: false, coordinator });
  assert.deepEqual(claude(null).slice(4).filter((item) => item === "--model" || item === "--effort"), []);
  assert.deepEqual(claude({ provider: null, model: "opus", effort: null, typed: false }).slice(-2), ["--model", "opus"]);
  for (const coordinator of [{ model: "-p" }, { model: "a b" }, { effort: "High" }, { provider: "-x" }, { model: 7 }, { typed: "yes" }, { prompt: "rm -rf ~" }, ["opus"]]) {
    assert.throws(() => claude(coordinator), /not one Prism can pass to a host/, JSON.stringify(coordinator));
    assert.throws(() => codexThreadRequest({ checkout: "/tmp", hostSessionId: null, resume: false, coordinator }), /not one Prism can pass to a host/);
    assert.throws(() => codexTurnRequest({ threadId: "t", initiative: INITIATIVE, coordinator }), /not one Prism can pass to a host/);
  }
  const plain = codexThreadRequest({ checkout: "/tmp", hostSessionId: null, resume: false, coordinator: null }).params;
  assert.deepEqual([Object.hasOwn(plain, "model"), Object.hasOwn(plain, "modelProvider")], [false, false]);
  assert.equal(Object.hasOwn(codexTurnRequest({ threadId: "t", initiative: INITIATIVE }).params, "effort"), false);
});

test("a launch record without a coordinator choice resumes with host defaults, and one whose choice breaks the rules resumes nothing", { skip: posixOnly }, async (t) => {
  const fixture = await launchFixture(t);
  const { listLaunches, resumeLaunch, resumeRefusal, startLaunch } = await sessions();
  const { launch } = await startLaunch({ projectRoot: fixture.root, initiative: INITIATIVE, host: "claude-code", coordinator: { provider: null, model: "opus", effort: "high", typed: false }, env: fixture.env });
  const file = path.join(fixture.app, "launches", launch.id, "launch.json");
  const ended = () => waitFor(async () => {
    const view = (await listLaunches({ projectRoot: fixture.root, env: fixture.env })).launches.find((item) => item.id === launch.id);
    return view && view.state !== "running" ? view : null;
  }, { what: "the run to end" });
  await ended();
  const record = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(record.coordinator, { provider: null, model: "opus", effort: "high", typed: false });
  assert.equal(Object.hasOwn(record, "model"), false, "the record names no model of its own beside the coordinator's choice");
  delete record.coordinator;
  await writeFile(file, JSON.stringify(record));
  await resumeLaunch({ id: launch.id, env: fixture.env });
  await waitFor(() => (fixture.runs("claude").length === 2 ? true : null), { what: "the resume to start" });
  const resumed = fixture.runs("claude")[1].argv;
  assert.equal(resumed[2], "--resume");
  assert.deepEqual([resumed.includes("--model"), resumed.includes("--effort")], [false, false], "an earlier record resumes with host defaults");
  await ended();
  const current = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...current, coordinator: { provider: null, model: "--dangerously-skip-permissions", effort: null, typed: false } }));
  assert.equal(await resumeRefusal({ id: launch.id, env: fixture.env }), "The session's recorded model choice is not one Prism can pass to a host, so it cannot be resumed.");
  await assert.rejects(resumeLaunch({ id: launch.id, env: fixture.env }), (error) => error.code === "invalid_choice");
  assert.equal(fixture.runs("claude").length, 2, "nothing started");
});
