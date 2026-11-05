import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, actionOf, actionProject, apply, listing, pageSession, post, startActionReview } from "./fixtures/review-actions.mjs";

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-actions-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
const { readCoordinationState, updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const SETTINGS = ["autonomy", "agentFlow", "commit", "push", "continuation", "review", "models"];
const NEXT_CHILD = "Applies to child sessions started after the change.";

async function setup(context, options) {
  const { root, gateIds } = await actionProject(context, options);
  const { review, base, opened } = await startActionReview(context, root);
  const headers = await pageSession(review, opened);
  return { root, gateIds, review, base, headers };
}

const state = async (root) => (await readCoordinationState({ projectRoot: root, initiative: INITIATIVE })).state;

test("an initiative lists its seven settings in order with their fields, defaults, effects, and confirmations", async (context) => {
  const { base, headers } = await setup(context);
  const list = await listing(base, `initiative:${INITIATIVE}`, headers);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.target, `initiative:${INITIATIVE}`);
  assert.equal(typeof list.json.writable, "boolean");
  assert.deepEqual(list.json.actions.map((action) => action.id), SETTINGS.map((name) => `initiative.${name}`));
  for (const action of list.json.actions) {
    assert.equal(action.group, "Initiative settings");
    assert.equal(action.target, `initiative:${INITIATIVE}`);
    assert.equal(action.available, true, action.id);
    assert.equal(action.reason, null);
    assert.equal(typeof action.label, "string");
    assert.equal(typeof action.revision, "string", "the coordination state exists, so its revision is shown");
    for (const field of action.fields) for (const key of ["name", "kind", "label", "options", "required", "requiredWhen", "maxLength", "multiline"]) assert.ok(Object.hasOwn(field, key), `${action.id}.${field.name} has ${key}`);
  }
  const by = Object.fromEntries(list.json.actions.map((action) => [action.id.slice("initiative.".length), action]));
  assert.deepEqual(Object.fromEntries(SETTINGS.map((name) => [name, by[name].value])), { autonomy: "conservative", agentFlow: "multi", commit: "off", push: "off", continuation: "auto", review: "marked", models: "host defaults" });
  assert.deepEqual(by.autonomy.fields.map((field) => [field.name, field.kind, field.options.map((option) => option.value)]), [["value", "choice", ["conservative", "broad", "full"]]]);
  assert.deepEqual(by.agentFlow.fields[0].options.map((option) => option.value), ["multi", "mono"]);
  for (const name of ["commit", "push"]) assert.deepEqual(by[name].fields.map((field) => [field.kind, field.options.map((option) => option.value)]), [["toggle", ["off", "on"]]]);
  assert.deepEqual(by.continuation.fields[0].options.map((option) => option.value), ["auto", "stepwise"]);
  assert.deepEqual(by.review.fields[0].options.map((option) => option.value), ["marked", "recommended", "all"]);
  assert.deepEqual(by.models.fields.map((field) => [field.name, field.kind, field.required, field.requiredWhen, field.maxLength]), [
    ["mode", "choice", true, null, null],
    ["delivery", "text", false, { field: "mode", values: ["custom"] }, 200],
    ["review", "text", false, { field: "mode", values: ["custom"] }, 200],
    ["securityReview", "text", false, { field: "mode", values: ["custom"] }, 200],
    ["examples", "text", false, null, 200]
  ]);
  assert.deepEqual(by.models.fields[0].options.map((option) => option.value), ["host defaults", "custom"]);
  assert.deepEqual(Object.fromEntries(SETTINGS.map((name) => [name, by[name].effect])), {
    autonomy: "Decides which later gates wait for you; a gate already open keeps waiting for you.",
    agentFlow: "Applies when work on the initiative starts.",
    commit: NEXT_CHILD,
    push: NEXT_CHILD,
    continuation: "Applies when the slice in progress finishes.",
    review: "Sets the review mark of slices whose design is not yet accepted.",
    models: NEXT_CHILD
  });
  assert.deepEqual(Object.fromEntries(SETTINGS.map((name) => [name, by[name].confirm])), {
    autonomy: { field: "value", values: ["full"], message: "Agents will accept every design and resolve internal decisions without you." },
    agentFlow: null,
    commit: { field: "value", values: ["on"], message: "Agents will commit their changes to Git history." },
    push: { field: "value", values: ["on"], message: "Agents will push finished slices beyond this machine." },
    continuation: null,
    review: null,
    models: null
  });
});

test("a slice lists its initiative's settings, a roadmap-only initiative lists them without a revision, and unknown targets are refused", async (context) => {
  const { base, headers } = await setup(context);
  const slice = await listing(base, `slice:${INITIATIVE}/${INITIATIVE}`, headers);
  assert.equal(slice.status, 200, slice.text);
  assert.equal(slice.json.target, `slice:${INITIATIVE}/${INITIATIVE}`);
  assert.deepEqual(slice.json.actions.map((action) => [action.id, action.target, action.group]), SETTINGS.map((name) => [`initiative.${name}`, `initiative:${INITIATIVE}`, "Initiative settings"]));
  const envisioned = await listing(base, "initiative:search", headers);
  assert.equal(envisioned.status, 200, envisioned.text);
  assert.ok(envisioned.json.actions.every((action) => action.revision === null), "no coordination state exists yet");
  for (const target of ["initiative:missing", "slice:reports/missing", "gate:reports/gate-000000000000", "initiative:../x", "reports", "", "index:extra"]) {
    const refused = await listing(base, target, headers);
    assert.deepEqual([refused.status, refused.json?.code], [404, "unknown_target"], target);
  }
  assert.equal((await listing(base, "index", headers)).json.actions[0].id, "index.rebuild");
});

test("agent flow becomes unavailable once work starts, and applying it then is refused without a change", async (context) => {
  const { root, base, headers } = await setup(context);
  const before = actionOf(await listing(base, `initiative:${INITIATIVE}`, headers), "initiative.agentFlow");
  assert.equal(before.available, true);
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: [{ op: "claim", slug: INITIATIVE }] });
  const after = actionOf(await listing(base, `initiative:${INITIATIVE}`, headers), "initiative.agentFlow");
  assert.deepEqual([after.available, after.reason], [false, "Agent flow is fixed once work on the initiative starts."]);
  const refused = await apply(base, { action: "initiative.agentFlow", target: `initiative:${INITIATIVE}`, input: { value: "mono" }, revision: after.revision }, headers);
  assert.deepEqual([refused.status, refused.json.code, refused.json.reason], [409, "action_unavailable", "Agent flow is fixed once work on the initiative starts."]);
  assert.equal(refused.json.current.id, "initiative.agentFlow");
  assert.equal((await state(root)).settings.agentFlow, undefined);
  for (const other of SETTINGS.filter((name) => name !== "agentFlow")) assert.equal(actionOf(await listing(base, `initiative:${INITIATIVE}`, headers), `initiative.${other}`).available, true, other);
});

test("a risky setting applies only after confirmation and is recorded in the initiative's history as the person's", async (context) => {
  const { root, base, headers } = await setup(context);
  const push = actionOf(await listing(base, `initiative:${INITIATIVE}`, headers), "initiative.push");
  const body = { action: "initiative.push", target: `initiative:${INITIATIVE}`, input: { value: "on" }, revision: push.revision };
  const unconfirmed = await apply(base, body, headers);
  assert.deepEqual([unconfirmed.status, unconfirmed.json.code, unconfirmed.json.message], [409, "confirmation_required", "Agents will push finished slices beyond this machine."]);
  assert.equal((await state(root)).settings.push, undefined, "nothing changes before the person confirms");
  const applied = await apply(base, { ...body, confirmed: true }, headers);
  assert.equal(applied.status, 200, applied.text);
  const entry = applied.json.applied;
  assert.deepEqual([entry.action, entry.target, entry.before, entry.after, entry.via], ["initiative.push", `initiative:${INITIATIVE}`, "off", "on", "review-app"]);
  assert.ok(Number.isInteger(entry.seq));
  assert.ok(Date.parse(entry.at) <= Date.now());
  assert.equal(actionOf({ json: applied.json }, "initiative.push").value, "on", "the answer lists the target's actions after the change");
  const stored = await state(root);
  assert.equal(stored.settings.push, "on");
  assert.ok(Date.parse(stored.personSettings.push.at));
  assert.deepEqual(stored.history.at(-1), entry);
  assert.equal(stored.pending.length, 4, "the gates stay as they were");
  const lowered = await apply(base, { action: "initiative.push", target: `initiative:${INITIATIVE}`, input: { value: "off" }, revision: actionOf({ json: applied.json }, "initiative.push").revision }, headers);
  assert.equal(lowered.status, 200, "turning push off needs no confirmation");
  assert.equal(lowered.json.applied.seq, entry.seq + 1);
  const autonomy = actionOf({ json: lowered.json }, "initiative.autonomy");
  const full = await apply(base, { action: "initiative.autonomy", target: `initiative:${INITIATIVE}`, input: { value: "full" }, revision: autonomy.revision }, headers);
  assert.deepEqual([full.json.code, full.json.message], ["confirmation_required", "Agents will accept every design and resolve internal decisions without you."]);
  const broad = await apply(base, { action: "initiative.autonomy", target: `initiative:${INITIATIVE}`, input: { value: "broad" }, revision: autonomy.revision }, headers);
  assert.equal(broad.status, 200, broad.text);
  const commit = actionOf({ json: broad.json }, "initiative.commit");
  const commitOn = await apply(base, { action: "initiative.commit", target: `initiative:${INITIATIVE}`, input: { value: "on" }, revision: commit.revision }, headers);
  assert.deepEqual([commitOn.json.code, commitOn.json.message], ["confirmation_required", "Agents will commit their changes to Git history."]);
});

test("a change against a stale revision is refused with the current value and changes nothing", async (context) => {
  const { root, base, headers } = await setup(context);
  const seen = actionOf(await listing(base, `initiative:${INITIATIVE}`, headers), "initiative.continuation");
  const current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  await updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes: { settings: { continuation: "stepwise" } } });
  const refused = await apply(base, { action: "initiative.continuation", target: `initiative:${INITIATIVE}`, input: { value: "auto" }, revision: seen.revision }, headers);
  assert.deepEqual([refused.status, refused.json.code], [409, "stale_revision"]);
  assert.equal(refused.json.current.value, "stepwise");
  assert.notEqual(refused.json.current.revision, seen.revision);
  const after = await state(root);
  assert.equal(after.settings.continuation, "stepwise");
  assert.equal(after.history, undefined, "a refusal records nothing");
  const retried = await apply(base, { action: "initiative.continuation", target: `initiative:${INITIATIVE}`, input: { value: "auto" }, revision: refused.json.current.revision }, headers);
  assert.equal(retried.status, 200, retried.text);
  assert.deepEqual([retried.json.applied.before, retried.json.applied.after], ["stepwise", "auto"]);
});

test("an input the action does not accept is refused with the accepted values", async (context) => {
  const { root, base, headers } = await setup(context);
  const list = await listing(base, `initiative:${INITIATIVE}`, headers);
  const send = (action, input) => apply(base, { action, target: `initiative:${INITIATIVE}`, input, revision: actionOf(list, action).revision }, headers);
  const choice = await send("initiative.autonomy", { value: "reckless" });
  assert.deepEqual([choice.status, choice.json.code, choice.json.field, choice.json.accepted], [400, "invalid_input", "value", ["conservative", "broad", "full"]]);
  const toggle = await send("initiative.push", { value: true });
  assert.deepEqual([toggle.status, toggle.json.code, toggle.json.accepted], [400, "invalid_input", ["off", "on"]]);
  const unknown = await send("initiative.review", { value: "all", extra: "x" });
  assert.deepEqual([unknown.status, unknown.json.code, unknown.json.field], [400, "invalid_input", "extra"]);
  assert.equal(typeof unknown.json.accepted, "string");
  const missing = await send("initiative.models", { mode: "custom", review: "opus", securityReview: "opus" });
  assert.deepEqual([missing.status, missing.json.code, missing.json.field], [400, "invalid_input", "delivery"]);
  const long = await send("initiative.models", { mode: "custom", delivery: "x".repeat(201), review: "opus", securityReview: "opus" });
  assert.deepEqual([long.status, long.json.code, long.json.field], [400, "invalid_input", "delivery"]);
  const action = await apply(base, { action: "initiative.colour", target: `initiative:${INITIATIVE}`, input: { value: "red" }, revision: null }, headers);
  assert.deepEqual([action.status, action.json.code], [404, "unknown_action"]);
  const wrongTarget = await apply(base, { action: "gate.answer", target: `initiative:${INITIATIVE}`, input: {}, revision: null }, headers);
  assert.deepEqual([wrongTarget.status, wrongTarget.json.code], [404, "unknown_action"]);
  const target = await apply(base, { action: "initiative.push", target: "initiative:missing", input: { value: "off" }, revision: null }, headers);
  assert.deepEqual([target.status, target.json.code], [404, "unknown_target"]);
  assert.equal((await state(root)).settings.autonomy, undefined);
});

test("models store host defaults or an assignment, and an unchanged value records nothing", async (context) => {
  const { root, base, headers } = await setup(context);
  let models = actionOf(await listing(base, `initiative:${INITIATIVE}`, headers), "initiative.models");
  const custom = await apply(base, { action: "initiative.models", target: `initiative:${INITIATIVE}`, input: { mode: "custom", delivery: "opus", review: "sonnet", securityReview: "opus", examples: "  " }, revision: models.revision }, headers);
  assert.equal(custom.status, 200, custom.text);
  assert.deepEqual((await state(root)).settings.models, { delivery: "opus", review: "sonnet", securityReview: "opus" });
  models = actionOf({ json: custom.json }, "initiative.models");
  assert.deepEqual(models.value, { delivery: "opus", review: "sonnet", securityReview: "opus" });
  const reset = await apply(base, { action: "initiative.models", target: `initiative:${INITIATIVE}`, input: { mode: "host defaults", delivery: "ignored" }, revision: models.revision }, headers);
  assert.equal(reset.status, 200, reset.text);
  assert.equal((await state(root)).settings.models, "host defaults");
  const historyLength = (await state(root)).history.length;
  const continuation = actionOf({ json: reset.json }, "initiative.continuation");
  const same = await apply(base, { action: "initiative.continuation", target: `initiative:${INITIATIVE}`, input: { value: "auto" }, revision: continuation.revision }, headers);
  assert.deepEqual([same.status, same.json.applied], [200, null]);
  assert.equal((await state(root)).history.length, historyLength);
  const samePush = await apply(base, { action: "initiative.push", target: `initiative:${INITIATIVE}`, input: { value: "off" }, revision: continuation.revision }, headers);
  assert.deepEqual([samePush.status, samePush.json.applied], [200, null], "an unchanged risky value needs no confirmation");
});

test("a setting on an initiative without coordination state creates the state", async (context) => {
  const { root, base, headers } = await setup(context, { gates: false });
  const action = actionOf(await listing(base, `initiative:${INITIATIVE}`, headers), "initiative.continuation");
  assert.equal(action.revision, null);
  const applied = await apply(base, { action: "initiative.continuation", target: `initiative:${INITIATIVE}`, input: { value: "stepwise" }, revision: null }, headers);
  assert.equal(applied.status, 200, applied.text);
  const stored = await state(root);
  assert.equal(stored.settings.continuation, "stepwise");
  assert.equal(stored.history.length, 1);
  const again = await apply(base, { action: "initiative.continuation", target: `initiative:${INITIATIVE}`, input: { value: "auto" }, revision: null }, headers);
  assert.deepEqual([again.status, again.json.code], [409, "stale_revision"], "the state now exists, so a null revision is stale");
});

test("gate answers are actions whose fields follow the gate kind, and the old answer route is gone", async (context) => {
  const { root, gateIds, base, headers } = await setup(context);
  const fieldsOf = async (id) => (await listing(base, `gate:${INITIATIVE}/${id}`, headers)).json.actions;
  const [review] = await fieldsOf(gateIds.review);
  assert.deepEqual([review.id, review.target, review.available, review.value], ["gate.answer", `gate:${INITIATIVE}/${gateIds.review}`, true, null]);
  assert.deepEqual(review.fields.map((field) => [field.name, field.kind, field.options?.map((option) => option.value) ?? null, field.required, field.requiredWhen, field.maxLength, field.multiline]), [
    ["choice", "choice", ["approve", "request-changes"], true, null, null, null],
    ["note", "text", null, false, { field: "choice", values: ["request-changes"] }, 4000, true]
  ]);
  const [decision] = await fieldsOf(gateIds.decision);
  assert.deepEqual(decision.fields.map((field) => [field.name, field.options?.map((option) => option.value) ?? null, field.required, field.requiredWhen]), [["choice", ["keep", "drop"], false, null], ["note", null, false, { field: "choice", values: [null] }]]);
  const [free] = await fieldsOf(gateIds.free);
  assert.deepEqual(free.fields.map((field) => [field.name, field.required]), [["note", true]]);
  const [assistance] = await fieldsOf(gateIds.assistance);
  assert.deepEqual(assistance.fields.map((field) => [field.name, field.options?.map((option) => option.value) ?? null, field.required]), [["choice", ["done"], true], ["note", null, false]]);
  const needsNote = await apply(base, { action: "gate.answer", target: review.target, input: { choice: "request-changes" }, revision: review.revision }, headers);
  assert.deepEqual([needsNote.status, needsNote.json.code, needsNote.json.field], [400, "invalid_input", "note"]);
  const answered = await apply(base, { action: "gate.answer", target: review.target, input: { choice: "approve", note: "Looks right." }, revision: review.revision }, headers);
  assert.equal(answered.status, 200, answered.text);
  assert.deepEqual([answered.json.applied.before, answered.json.applied.after], [null, { choice: "approve", note: "Looks right." }]);
  const stored = await state(root);
  const gate = stored.pending.find((item) => item.id === gateIds.review);
  assert.deepEqual([gate.answer.choice, gate.answer.note, gate.answer.via], ["approve", "Looks right.", "browser"]);
  assert.equal(stored.history.at(-1).action, "gate.answer");
  const [after] = await fieldsOf(gateIds.review);
  assert.deepEqual([after.available, after.reason], [false, "The question already has an answer."]);
  const decided = await apply(base, { action: "gate.answer", target: decision.target, input: { note: "Keep it for a release." }, revision: after.revision }, headers);
  assert.equal(decided.status, 200, decided.text);
  const old = await post(base, "api/gates/answer", { initiative: INITIATIVE, id: gateIds.assistance, choice: "done" }, headers);
  assert.equal(old.status, 404);
  assert.equal((await state(root)).pending.find((item) => item.id === gateIds.assistance).answer, undefined);
});

test("the index rebuild is an action recorded in the project history, and the old rebuild route is gone", async (context) => {
  const { root } = await actionProject(context);
  const calls = [];
  const { review, base, opened } = await startActionReview(context, root, { rebuildIndex: async (projectRoot) => { calls.push(projectRoot); } });
  const headers = await pageSession(review, opened);
  const [rebuild] = (await listing(base, "index", headers)).json.actions;
  assert.deepEqual([rebuild.id, rebuild.target, rebuild.fields, rebuild.value, rebuild.revision, rebuild.confirm], ["index.rebuild", "index", [], null, null, null]);
  assert.equal(typeof rebuild.effect, "string");
  assert.deepEqual([rebuild.available, rebuild.reason], [true, null], "no build runs in a new project");
  const applied = await apply(base, { action: "index.rebuild", target: "index", input: {}, revision: null }, headers);
  assert.equal(applied.status, 200, applied.text);
  assert.deepEqual([applied.json.applied.action, applied.json.applied.before, applied.json.applied.after, applied.json.applied.via], ["index.rebuild", null, "started", "review-app"]);
  assert.deepEqual(calls, [root]);
  const history = JSON.parse(await readFile(path.join(root, ".prism/history.json"), "utf8"));
  assert.deepEqual(history.history.at(-1), applied.json.applied);
  assert.equal((await post(base, "api/indexing/rebuild", {}, headers)).status, 404);
});

test("a write must come from the page as JSON", async (context) => {
  const { root, base, headers } = await setup(context);
  const push = actionOf(await listing(base, `initiative:${INITIATIVE}`, headers), "initiative.continuation");
  const body = JSON.stringify({ action: "initiative.continuation", target: `initiative:${INITIATIVE}`, input: { value: "stepwise" }, revision: push.revision });
  const plain = await fetch(`${base}/api/actions/apply`, { method: "POST", headers: { "Content-Type": "text/plain", ...headers }, body });
  assert.deepEqual([plain.status, (await plain.json()).code], [403, "origin_refused"]);
  const foreign = await fetch(`${base}/api/actions/apply`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example", ...headers }, body });
  assert.deepEqual([foreign.status, (await foreign.json()).code], [403, "origin_refused"]);
  const large = await apply(base, JSON.stringify({ action: "initiative.continuation", target: `initiative:${INITIATIVE}`, input: { value: "x".repeat(70 * 1024) }, revision: push.revision }), headers);
  assert.ok(large.status >= 400 && large.status < 500);
  assert.equal((await state(root)).settings.continuation, undefined);
});

test("agents cannot write the history or the person's settings through coordination state", async (context) => {
  const { root } = await actionProject(context);
  const current = await readCoordinationState({ projectRoot: root, initiative: INITIATIVE });
  for (const changes of [{ history: [] }, { personSettings: {} }]) {
    await assert.rejects(updateCoordinationState({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, changes }), (error) => error.code === "invalid_changes", JSON.stringify(changes));
  }
});

test("the registry works without HTTP and keeps the newest 200 history entries", async (context) => {
  const { root } = await actionProject(context, { gates: false });
  const { applyAction, listActions } = await import("../../dist/server/workflow/actions.mjs");
  const listed = await listActions({ projectRoot: root, target: `initiative:${INITIATIVE}` });
  assert.deepEqual(listed.actions.map((action) => action.id), SETTINGS.map((name) => `initiative.${name}`));
  assert.equal(Object.hasOwn(listed, "writable"), false, "write access is the transport's concern");
  await assert.rejects(applyAction({ projectRoot: root, target: `initiative:${INITIATIVE}`, action: "initiative.push", input: { value: "on" }, revision: null, via: "review-app" }), (error) => error.code === "confirmation_required");
  await assert.rejects(applyAction({ projectRoot: root, target: "initiative:missing", action: "initiative.push", input: { value: "off" }, revision: null, via: "review-app" }), (error) => error.code === "unknown_target");
  let revision = null;
  for (let index = 0; index < 202; index += 1) {
    const result = await applyAction({ projectRoot: root, target: `initiative:${INITIATIVE}`, action: "initiative.continuation", input: { value: index % 2 ? "auto" : "stepwise" }, revision, via: "review-app" });
    revision = result.actions.find((action) => action.id === "initiative.continuation").revision;
  }
  const history = (await state(root)).history;
  assert.equal(history.length, 200);
  assert.deepEqual(history.map((entry) => entry.seq), Array.from({ length: 200 }, (_, index) => history[0].seq + index));
  assert.equal(history.at(-1).after, "auto");
  await assert.rejects(applyAction({ projectRoot: root, target: `initiative:${INITIATIVE}`, action: "initiative.continuation", input: { value: "stepwise" }, revision: "0".repeat(64), via: "review-app" }), (error) => error.code === "stale_revision" && error.current?.value === "auto");
});
