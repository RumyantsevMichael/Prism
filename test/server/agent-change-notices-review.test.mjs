import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, actionProject } from "./fixtures/review-actions.mjs";

const { applyAction, listActions } = await import("../../dist/server/workflow/actions.mjs");
const { NOTICE_FOLDER, takePersonChanges } = await import("../../dist/server/workflow/change-notices.mjs");
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
