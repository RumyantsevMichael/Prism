import test from "node:test";
import assert from "node:assert/strict";
import { INITIATIVE } from "./fixtures/review-actions.mjs";
import { runOptionsFixture } from "./fixtures/run-options-hosts.mjs";

const indexer = { status: async () => ({ state: "ready" }), rebuild: async () => {} };
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

test("applying the stored models assignment records nothing whatever key order the state holds it in", { skip: posixOnly }, async (t) => {
  const { root, env } = await runOptionsFixture(t);
  const { updateCoordinationState, readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const { listActions, applyAction } = await import("../../dist/server/workflow/actions.mjs");
  await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, changes: { settings: { models: { codex: { gateSummary: { typed: true, model: "s" } }, "claude-code": { codeReview: { effort: "high", model: "opus" }, coordinator: { typed: true, model: "r" } } } } } });
  const target = `initiative:${INITIATIVE}`;
  const models = (await listActions({ projectRoot: root, target, indexer, env })).actions.find((action) => action.id === "initiative.models");
  const input = { host: "claude-code", provider: null, coordinator: { typed: true, effort: null, model: "r" }, designImplementation: null, codeReview: { effort: "high", model: "opus", typed: false }, securityReview: null, gateSummary: null };
  const result = await applyAction({ projectRoot: root, target, action: "initiative.models", input, revision: models.revision, indexer, env });
  assert.equal(result.applied, null);
  const state = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state;
  assert.equal(state.history, undefined);
  assert.equal(state.personSettings, undefined);
});
