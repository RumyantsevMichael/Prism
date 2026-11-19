import assert from "node:assert/strict";
import test from "node:test";

// An action whose value is kept per option of a choice, such as the models kept per host, fills its other fields from the picked
// option's entry, so applying from the page sends the stored entry for every field the page does not draw.

const { actionFormState, requestInput } = await import("../../dist/server/review/public/views/actions.js");

const choice = { model: "opus", effort: "high", typed: false };
const empty = { model: null, effort: null, typed: false };
const models = {
  id: "initiative.models", label: "Models", group: "Initiative settings", target: "initiative:x", revision: "r1", available: true, reason: null, confirm: null,
  effect: "Applies to agents started after the change.",
  fields: [
    { name: "host", kind: "choice", label: "Host", options: [{ value: "claude-code", label: "Claude Code" }, { value: "codex", label: "Codex" }], required: true, requiredWhen: null },
    { name: "provider", kind: "run-option", label: "Provider", options: null, required: false, requiredWhen: null },
    { name: "coordinator", kind: "run-choice", label: "Coordinator", options: null, required: false, requiredWhen: null }
  ],
  value: { "claude-code": { provider: null, coordinator: choice }, codex: { provider: "local", coordinator: empty } }
};

test("picking a host shows its stored entry and is no change, so the page cannot reset that host's choices", () => {
  for (const host of ["claude-code", "codex"]) {
    const state = actionFormState(models, { values: { host } });
    assert.deepEqual(state.input, { host, ...models.value[host] });
    assert.equal(state.ready, false, `picking ${host} alone changes nothing`);
    assert.deepEqual(requestInput(models, state.input), { host, ...models.value[host] }, "the request carries the stored entry");
  }
});

test("a change to a field keeps the stored entry in every other field", () => {
  const state = actionFormState(models, { values: { host: "claude-code", provider: "other" } });
  assert.equal(state.ready, true);
  assert.deepEqual(requestInput(models, state.input), { host: "claude-code", provider: "other", coordinator: choice });
});

test("a value that is not keyed by a choice's options fills its fields as before", () => {
  const push = { ...models, id: "initiative.push", fields: [{ name: "value", kind: "toggle", label: "Value", options: [{ value: "off" }, { value: "on" }], required: true, requiredWhen: null }], value: "off" };
  assert.deepEqual(actionFormState(push, { values: { value: "on" } }).input, { value: "on" });
  const assigned = { ...models, value: { host: "codex", provider: null, coordinator: null } };
  assert.equal(actionFormState(assigned, {}).input.host, "codex", "an object holding the field names fills them");
});
