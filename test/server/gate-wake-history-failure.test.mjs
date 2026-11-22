import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CLAUDE_CLIENT, CLAUDE_SESSION, CLOUD_SESSION, INITIATIVE, actionOf, apply, askGate, askerFixture, askerServer, answer, card, listing } from "./fixtures/gate-askers.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/late-gate-answers.md §17.
// Contract: docs/plans/late-gate-answers/slice.md clause 24.
// A wake that was sent cannot be taken back, so its apply answers with its result even when its history entry cannot be recorded.

const posixOnly = process.platform === "win32" ? "the stub hosts and dialogs are POSIX scripts" : false;
const target = (id) => `gate:${INITIATIVE}/${id}`;
const continueAction = async (review, id) => actionOf(await listing(review.base, target(id), review.headers), "gate.continue");
const wake = async (review, id) => apply(review.base, { action: "gate.continue", target: target(id), input: { continuation: "wake" }, revision: (await continueAction(review, id)).revision }, review.headers);
const CLOUD_ENV = { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION, CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_REMOTE_SESSION_ID: CLOUD_SESSION };

async function answered(t) {
  const s = await askerFixture(t, { dialog: { code: 0 } });
  const server = await askerServer(t, s, { client: CLAUDE_CLIENT, env: CLOUD_ENV });
  const id = await askGate(server, { question: "Keep the old export layout?" });
  const review = await s.page();
  await settled(async () => (await card(review, id))?.asker, Boolean);
  assert.equal((await answer(review, id, "keep")).status, 200);
  return { s, id, review };
}

async function findFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name && full.includes(INITIATIVE)) return full;
    if (entry.isDirectory() && entry.name !== "node_modules") {
      const found = await findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

test("clause 24: a sent wake whose history entry cannot be recorded still answers 200 with its result", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t);
  const stateFile = await findFile(s.root, "state.json");
  assert.ok(stateFile, "the initiative's state file exists after the answer");
  const original = await readFile(stateFile, "utf8");
  await s.setWake({ code: 0, hold: 1500 });
  const pending = wake(review, id);
  // The wake is running, so the history write that follows it finds the initiative's state damaged and is refused.
  await settled(() => s.wakes(), (list) => list.length === 1);
  await writeFile(stateFile, "{ not json");
  const sent = await pending;
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual([sent.json.wake.delivered, sent.json.wake.reason], [true, null]);
  assert.ok(Array.isArray(sent.json.warnings) && sent.json.warnings.some((text) => text.startsWith("The wake was sent")), sent.text);
  await writeFile(stateFile, original);
  const shown = await settled(async () => (await card(review, id))?.asker?.wake, Boolean);
  assert.equal(shown.delivered, true);
});

test("clause 24: a sent wake answers with no history entry when none was recorded", { skip: posixOnly }, async (t) => {
  const { s, id, review } = await answered(t);
  const stateFile = await findFile(s.root, "state.json");
  const original = await readFile(stateFile, "utf8");
  await s.setWake({ code: 0, hold: 1500 });
  const pending = wake(review, id);
  await settled(() => s.wakes(), (list) => list.length === 1);
  await writeFile(stateFile, "{ not json");
  const sent = await pending;
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.applied, null, sent.text);
  await writeFile(stateFile, original);
});

test("clause 24: a sent wake's history warning names no credential from the store's error", async () => {
  const { wakeHistoryWarning } = await import("../../dist/server/workflow/actions.mjs");
  const warning = wakeHistoryWarning(new Error("Git could not push to https://user:token@host/repo.git: rejected."));
  assert.ok(warning.startsWith("The wake was sent"), warning);
  assert.match(warning, /https:\/\/host\/repo\.git/);
  assert.doesNotMatch(warning, /user|token/);
});
