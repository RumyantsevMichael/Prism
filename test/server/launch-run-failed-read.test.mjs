import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CATALOG, INITIATIVE, apply, runOptionsReview } from "./fixtures/run-options-hosts.mjs";
import { settled } from "./fixtures/wait.mjs";

// Requirements: docs/requirements/launch-run-configuration.md §12.
// A launch whose saved choice needs a host read that fails is refused with that read's reason, not as a choice the host does not
// offer, so the person is not told to replace a model the host may still offer.

const posixOnly = process.platform === "win32" ? "the stub hosts and dialogs are POSIX scripts" : false;
const TARGET = `initiative:${INITIATIVE}`;

const settings = async (root, value) => {
  const { readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  const read = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: read.exists ? read.revision : null, changes: { settings: value } });
};
const launch = (s) => apply(s.base, { action: "launch.run", target: TARGET, input: {}, revision: null }, s.headers);
const failing = (host) => ({ catalog: { ...DEFAULT_CATALOG, [host]: { ...DEFAULT_CATALOG[host], fail: "service down" } } });

test("a Claude Code read that fails refuses a saved model with the read's reason and asks nothing", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, failing("claude"));
  await settings(s.root, { host: "claude-code", models: { "claude-code": { coordinator: { model: "opus", effort: "high" } } } });
  const refused = await launch(s);
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  assert.equal(refused.json.code, "choice_not_offered");
  assert.match(refused.json.message, /^Coordinator: Claude Code did not report its run options: .*service down/);
  assert.deepEqual(s.dialogs(), [], "no confirmation was asked");
  assert.deepEqual(s.launchRuns(), [], "nothing started");
});

test("a Codex read that fails refuses a saved provider with the read's reason and asks nothing", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, failing("codex"));
  await settings(s.root, { host: "codex", models: { codex: { provider: "openai" } } });
  const refused = await launch(s);
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  assert.equal(refused.json.code, "choice_not_offered");
  assert.match(refused.json.message, /^Provider: Codex did not report its run options: .*service down/);
  assert.deepEqual(s.dialogs(), [], "no confirmation was asked");
  assert.deepEqual(s.launchRuns(), [], "nothing started");
});

test("a launch whose choices are all host defaults starts without reading a host whose read would fail", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, failing("claude"));
  await settings(s.root, { host: "claude-code" });
  const started = await launch(s);
  assert.equal(started.status, 200, JSON.stringify(started.json));
  await settled(() => s.launchRuns("claude").length, 1);
  assert.deepEqual(s.optionReads(), [], "no host read was needed");
});
