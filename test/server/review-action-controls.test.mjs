import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, actionOf, actionProject, apply, get, listing, pageSession, startActionReview } from "./fixtures/review-actions.mjs";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-controls-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { actionFormState } = await import("../../dist/server/review/public/views/actions.js");
test.after(() => rm(privateData, { recursive: true, force: true }));

const target = `initiative:${INITIATIVE}`;
const choice = (name, values, extra = {}) => ({ name, kind: "choice", label: name === "value" ? "Value" : name, options: values.map((value) => ({ value, label: value })), required: true, requiredWhen: null, maxLength: null, multiline: null, ...extra });
const text = (name, label, extra = {}) => ({ name, kind: "text", label, options: null, required: false, requiredWhen: null, maxLength: 200, multiline: false, ...extra });
const push = { id: "initiative.push", label: "Push", group: "Initiative settings", target, value: "off", fields: [{ ...choice("value", ["off", "on"]), kind: "toggle" }], effect: "Applies to child sessions started after the change.", available: true, reason: null, confirm: { field: "value", values: ["on"], message: "Agents will push finished slices beyond this machine." }, revision: "r1" };
const models = { id: "initiative.models", label: "Models", group: "Initiative settings", target, value: "host defaults", fields: [choice("mode", ["host defaults", "custom"]), text("delivery", "Delivery", { requiredWhen: { field: "mode", values: ["custom"] } }), text("review", "Review", { requiredWhen: { field: "mode", values: ["custom"] } }), text("securityReview", "Security review", { requiredWhen: { field: "mode", values: ["custom"] } }), text("examples", "Examples")], effect: "Applies to child sessions started after the change.", available: true, reason: null, confirm: null, revision: "r1" };

test("a control is ready only for a changed, complete input of an available action, and names its confirmation", () => {
  assert.deepEqual(actionFormState(push, { values: {} }), { input: { value: "off" }, ready: false, confirm: null, hint: "" }, "the current value is not a change");
  assert.deepEqual(actionFormState(push, { values: { value: "on" } }), { input: { value: "on" }, ready: true, confirm: "Agents will push finished slices beyond this machine.", hint: "" });
  assert.deepEqual(actionFormState({ ...push, value: "on" }, { values: { value: "off" } }), { input: { value: "off" }, ready: true, confirm: null, hint: "" });
  const locked = { ...push, id: "initiative.agentFlow", available: false, reason: "Agent flow is fixed once work on the initiative starts.", confirm: null };
  assert.deepEqual(actionFormState(locked, { values: { value: "on" } }), { input: { value: "on" }, ready: false, confirm: null, hint: "Agent flow is fixed once work on the initiative starts." });
});

test("a required field follows the field it depends on, and the hint names the first empty one", () => {
  const custom = actionFormState(models, { values: { mode: "custom", review: "sonnet" } });
  assert.equal(custom.ready, false);
  assert.equal(custom.hint, "Fill in Delivery.");
  assert.equal(custom.input.mode, "custom");
  const complete = actionFormState(models, { values: { mode: "custom", delivery: "opus", review: "sonnet", securityReview: "opus" } });
  assert.deepEqual([complete.ready, complete.hint, complete.confirm], [true, "", null]);
  const answer = { id: "gate.answer", label: "Answer", group: "Gate", target: "gate:reports/gate-00000001", value: null, fields: [choice("choice", ["approve", "request-changes"]), text("note", "Note", { maxLength: 4000, multiline: true, requiredWhen: { field: "choice", values: ["request-changes"] } })], effect: "Reaches the agent that asked.", available: true, reason: null, confirm: null, revision: "r1" };
  assert.deepEqual([actionFormState(answer, { values: { choice: "request-changes" } }).ready, actionFormState(answer, { values: { choice: "request-changes" } }).hint], [false, "Fill in Note."]);
  assert.equal(actionFormState(answer, { values: { choice: "approve" } }).ready, true);
  const free = { ...answer, fields: [choice("choice", ["keep"], { required: false }), text("note", "Note", { requiredWhen: { field: "choice", values: [null] } })] };
  assert.deepEqual([actionFormState(free, { values: {} }).ready, actionFormState(free, { values: {} }).hint], [false, "Fill in Note."]);
  assert.equal(actionFormState(free, { values: { note: "Keep it." } }).ready, true);
  assert.equal(actionFormState(free, { values: { note: "   " } }).ready, false, "whitespace is not a value");
});

// Reads named events from a viewer stream until it has seen the wanted count of one event.
function events(context, url, name, count) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const request = http.get(url, (response) => {
      context.after(() => response.destroy());
      let buffer = "";
      response.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event === name) {
            seen.push(JSON.parse(data));
            if (seen.length === count) resolve(seen);
          }
        }
      });
    });
    request.once("error", reject);
    setTimeout(() => reject(new Error(`Saw ${seen.length} ${name} events.`)), 8000).unref();
  });
}

test("every connected tab of the project receives an applied action as it happens", async (context) => {
  const { root } = await actionProject(context);
  const { review, base, opened } = await startActionReview(context, root);
  const headers = await pageSession(review, opened);
  const first = events(context, `${base}/api/events`, "action", 1);
  const second = events(context, `${base}/api/events?write=${encodeURIComponent(headers["X-Prism-Write"] ?? "")}`, "action", 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const action = actionOf(await listing(base, target, headers), "initiative.continuation");
  const applied = await apply(base, { action: action.id, target, input: { value: "stepwise" }, revision: action.revision }, headers);
  assert.equal(applied.status, 200, applied.text);
  for (const [event] of await Promise.all([first, second])) assert.deepEqual(event, { ...applied.json.applied, initiative: INITIATIVE });
});

test("Attention lists the newest applied actions across initiatives and the project", async (context) => {
  const { root, gateIds } = await actionProject(context);
  const calls = [];
  const { review, base, opened } = await startActionReview(context, root, { rebuildIndex: async (projectRoot) => { calls.push(projectRoot); } });
  const headers = await pageSession(review, opened);
  const send = async (actionTarget, id, input) => {
    const action = actionOf(await listing(base, actionTarget, headers), id);
    const result = await apply(base, { action: id, target: action.target, input, revision: action.revision }, headers);
    assert.equal(result.status, 200, result.text);
    await new Promise((resolve) => setTimeout(resolve, 15));
    return result.json.applied;
  };
  const entries = [
    await send(target, "initiative.continuation", { value: "stepwise" }),
    await send(`gate:${INITIATIVE}/${gateIds.assistance}`, "gate.answer", { choice: "done" }),
    await send("index", "index.rebuild", {})
  ];
  const attention = (await get(base, "api/entity?ref=attention")).json.data;
  assert.ok(Array.isArray(attention.recentChanges));
  assert.deepEqual(attention.recentChanges.map((entry) => [entry.action, entry.initiative]), [["index.rebuild", null], ["gate.answer", INITIATIVE], ["initiative.continuation", INITIATIVE]]);
  assert.deepEqual(attention.recentChanges[1], { ...entries.find((entry) => entry.action === "gate.answer"), initiative: INITIATIVE });
  assert.ok(attention.recentChanges.length <= 20);
});

test("the page loads the generic action view", async (context) => {
  const { root } = await actionProject(context);
  const { base } = await startActionReview(context, root);
  const view = await get(base, "views/actions.js");
  assert.equal(view.status, 200);
});
