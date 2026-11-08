import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, actionProject } from "./fixtures/review-actions.mjs";

const { applyAction, listActions } = await import("../../dist/server/workflow/actions.mjs");
const { NOTICE_FOLDER, noticeValue, personChangesText, takePersonChanges, takeWaitChanges } = await import("../../dist/server/workflow/change-notices.mjs");
const { waitForUserGates } = await import("../../dist/server/workflow/gate-wait.mjs");
const { readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
const { recordCallAgent } = await import("../../dist/server/workflow/call-agent.mjs");
const { prepareDirectory } = await import("../../dist/server/review/review-app-discovery.mjs");
const { readRecord, writeRecord } = await import("../../dist/server/workflow/record-store.mjs");

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function changeContinuation(root, value) {
  const listed = await listActions({ projectRoot: root, target: `initiative:${INITIATIVE}` });
  const action = listed.actions.find((item) => item.id === "initiative.continuation");
  await applyAction({ projectRoot: root, target: action.target, action: action.id, input: { value }, revision: action.revision, via: "review-app" });
}

// Breaks the stored coordination state so that it reads invalid, and returns a function that restores it.
async function breakState(root) {
  const key = { kind: "state", initiative: INITIATIVE };
  const good = (await readRecord(root, key)).bytes.toString("utf8");
  const value = JSON.parse(good);
  await writeRecord(root, key, JSON.stringify({ ...value, settings: { ...value.settings, autonomy: "bogus" } }, null, 2));
  return () => writeRecord(root, key, good);
}

test("an invalid read of the coordination state shows nothing and keeps what the session was shown", async (context) => {
  const { root } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const take = () => takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  assert.deepEqual(await take(), []);
  await changeContinuation(root, "stepwise");
  assert.equal((await take()).length, 1);
  const restore = await breakState(root);
  assert.deepEqual(await take(), []);
  await restore();
  assert.deepEqual(await take(), [], "an entry shown before the invalid read is never shown again");
});

test("a first call while the coordination state reads invalid sets no starting point", async (context) => {
  const { root } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const take = () => takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  await changeContinuation(root, "stepwise");
  const restore = await breakState(root);
  assert.deepEqual(await take(), []);
  await restore();
  assert.deepEqual(await take(), [], "the first valid read is the session's starting point");
  await changeContinuation(root, "auto");
  assert.equal((await take()).length, 1);
});

test("the notice and call agent records create the app directory private to this user", { skip: process.platform === "win32" }, async (context) => {
  const { root } = await actionProject(context);
  const app = path.join(await temporaryDirectory(context, "prism-app-"), "app");
  const previous = process.umask(0o022);
  try {
    await takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory: path.join(app, NOTICE_FOLDER) });
    await recordCallAgent({ session: "s1", toolUseId: "tool-1", agentId: "agent-1", directory: path.join(app, "call-agents") });
  } finally {
    process.umask(previous);
  }
  const mode = async (file) => (await stat(file)).mode & 0o777;
  assert.equal(await mode(app), 0o700);
  for (const folder of [NOTICE_FOLDER, "call-agents"]) {
    const directory = path.join(app, folder);
    assert.equal(await mode(directory), 0o700, folder);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1, folder);
    assert.equal(await mode(path.join(directory, files[0])), 0o600, folder);
  }
  await prepareDirectory(app);
});

test("a coordinator's wait ends on a change that first appears while the coordination state reads invalid", async (context) => {
  const { root } = await actionProject(context);
  const directory = await temporaryDirectory(context, "prism-notices-");
  const gate = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((item) => !item.answer);
  assert.ok(gate, "the fixture holds an unanswered gate");
  await takePersonChanges({ projectRoot: root, initiative: INITIATIVE, session: "s1", directory });
  const wait = waitForUserGates({
    projectRoot: root, initiative: INITIATIVE, gateIds: [gate.id], maxWaitMinutes: 0.1, pollMs: 50, settleMs: 0,
    takeChanges: (entries) => takeWaitChanges({ projectRoot: root, initiative: INITIATIVE, entries, session: "s1", directory })
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await changeContinuation(root, "stepwise");
  const restore = await breakState(root);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await restore();
  const result = await wait;
  assert.equal(result.status, "changed");
  assert.deepEqual(result.changes.map((entry) => entry.action), ["initiative.continuation"]);
});

test("a wait goes on, rather than ending as resolved, while the coordination state reads invalid", async (context) => {
  const { root } = await actionProject(context);
  const gate = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state.pending.find((item) => !item.answer);
  const restore = await breakState(root);
  const result = await waitForUserGates({ projectRoot: root, initiative: INITIATIVE, gateIds: [gate.id], maxWaitMinutes: 0.005, pollMs: 50, settleMs: 0 });
  await restore();
  assert.equal(result.status, "timeout");
});

test("a non-string value escapes C1 controls and line separators, so each entry is one line", () => {
  const value = { implement: "m\u0085- forged line", r: "\u007f\u009b\u2028\u2029" };
  assert.equal(noticeValue(value), '{"implement":"m\\u0085- forged line","r":"\\u007f\\u009b\\u2028\\u2029"}');
  const entry = { id: "a".repeat(32), action: "initiative.models", target: "initiative:x", before: "defaults", after: value, at: new Date().toISOString(), by: { name: "M", email: null, checkout: "c" }, via: "browser" };
  const text = personChangesText([entry]);
  assert.doesNotMatch(text, /[\u007f-\u009f\u2028\u2029]/);
  assert.equal(text.split("\n").length, 2);
});
