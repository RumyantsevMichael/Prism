import test from "node:test";
import assert from "node:assert/strict";
import { actionProject, INITIATIVE } from "./fixtures/review-actions.mjs";

const indexer = { status: async () => ({ state: "ready" }), rebuild: async () => {} };

test("applying the stored models assignment records nothing whatever key order the state holds it in", async (t) => {
  const { root } = await actionProject(t, { gates: false });
  const { updateCoordinationState, readCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const { listActions, applyAction } = await import("../../dist/server/workflow/actions.mjs");
  await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, changes: { settings: { models: { review: "r", delivery: "d", securityReview: "s" } } } });
  const target = `initiative:${INITIATIVE}`;
  const models = (await listActions({ projectRoot: root, target, indexer })).actions.find((action) => action.id === "initiative.models");
  const result = await applyAction({ projectRoot: root, target, action: "initiative.models", input: { mode: "custom", delivery: "d", review: "r", securityReview: "s" }, revision: models.revision, indexer });
  assert.equal(result.applied, null);
  const state = (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state;
  assert.equal(state.history, undefined);
  assert.equal(state.personSettings, undefined);
});
