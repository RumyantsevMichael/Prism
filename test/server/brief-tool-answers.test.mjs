import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { checkout, isolateGit, ok, refused, server, workspace } from "./fixtures/workspace-artifacts.mjs";

// The coordinator's write tools answer with what it needs next, and a roadmap read can name one initiative, so a long run does not fill the session with whole records.

const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const add = (id) => ({ op: "add_initiative", id, title: `Initiative ${id}`, intent: `${id} ships.`, band: "Now" });

test("update_roadmap answers with the entries it touched, and get_roadmap reads one initiative", async (context) => {
  const place = await workspace(context);
  const prism = await server(context, place, await checkout(place, "api"));
  const created = ok(await prism.call("update_roadmap", { expectedRevision: null, operations: [add("reports"), add("billing"), add("search")] }));
  assert.deepEqual(created.touched, ["reports", "billing", "search"]);
  const updated = ok(await prism.call("update_roadmap", { expectedRevision: created.revision, operations: [{ op: "place", id: "billing", band: "Later" }] }));
  assert.deepEqual(updated.touched, ["billing"]);
  assert.deepEqual(updated.record.initiatives.map((item) => item.id), ["billing"], "the answer holds only the touched entry");
  assert.deepEqual(updated.derived.map((item) => item.id), ["billing"]);
  assert.equal(updated.derived[0].band, "Later");
  assert.equal(updated.record.history, undefined);
  const whole = ok(await prism.call("get_roadmap", {}));
  assert.equal(whole.revision, updated.revision);
  assert.deepEqual(whole.record.initiatives.map((item) => item.id), ["reports", "search", "billing"], "a read without a filter keeps the whole roadmap");
  assert.ok(whole.record.history.length > 0);
  const one = ok(await prism.call("get_roadmap", { initiative: "search" }));
  assert.deepEqual(one.record.initiatives.map((item) => item.id), ["search"]);
  assert.deepEqual(one.initiatives.map((item) => item.id), ["search"]);
  assert.deepEqual(one.derived.map((item) => item.id), ["search"]);
  assert.equal(one.record.history, undefined);
  assert.equal(one.revision, whole.revision);
  refused(await prism.call("get_roadmap", { initiative: "serach" }), "unknown_initiative");
});

test("update_coordination_state leaves gate contexts and the person's history out of its answer", async (context) => {
  const place = await workspace(context);
  const prism = await server(context, place, await checkout(place, "api"));
  const context8k = "Findings summary. ".repeat(400);
  const asked = ok(await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "decision", question: "Continue?", context: context8k, artifacts: [],
    options: [{ id: "yes", label: "Yes", consequence: "It continues." }, { id: "no", label: "No", consequence: "It stops." }], recommended: { option: "yes", reason: "It converges." } }] } }));
  assert.equal(asked.openedGates.length, 1);
  const [gate] = asked.state.pending;
  assert.equal(gate.id, asked.openedGates[0].id);
  assert.equal(gate.question, "Continue?");
  assert.deepEqual(gate.options.map((option) => option.id), ["yes", "no"]);
  assert.equal(gate.context, undefined, "the caller wrote the context, so the answer does not repeat it");
  assert.ok(JSON.stringify(asked).length < context8k.length);
  const read = ok(await prism.call("get_coordination_state", { initiative: "reports" }));
  assert.equal(read.revision, asked.revision);
  assert.equal(read.state.pending[0].context, context8k, "a read still returns the whole gate");
});
