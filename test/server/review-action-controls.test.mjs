import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, actionOf, actionProject, apply, authorOf, get, listing, pageSession, startActionReview, writeHeaders } from "./fixtures/review-actions.mjs";
import { repository, storeFolder } from "./fixtures/repository-checkouts.mjs";

// Git runs with a private home and configuration, so the checkouts of a workspace test have their own identity.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-controls-data-")));
await writeFile(path.join(privateData, "gitconfig"), "[user]\n\tname = Grace Workspace\n\temail = grace@example.invalid\n");
Object.assign(process.env, {
  HOME: privateData, GIT_CONFIG_GLOBAL: path.join(privateData, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PLUGIN_DATA: privateData, PRISM_REVIEW_APP_DIR: path.join(privateData, "app"),
  GIT_AUTHOR_NAME: "Prism Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Prism Test", GIT_COMMITTER_EMAIL: "test@example.invalid"
});
delete process.env.CLAUDE_PLUGIN_DATA;
const { actionFormState } = await import("../../dist/server/review/public/views/actions.js");
const { startStandaloneReview } = await import("../../dist/server/review/review-server-pool.mjs");
const { updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
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
  const locked = { ...push, available: false, reason: "An index build is already running.", confirm: null };
  assert.deepEqual(actionFormState(locked, { values: { value: "on" } }), { input: { value: "on" }, ready: false, confirm: null, hint: "An index build is already running." }, "an unavailable action is never ready and its reason is the hint");
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

test("Attention lists the newest applied actions across initiatives and the checkout's index, with their authors", async (context) => {
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
    await send("index:root/root", "index.rebuild", {})
  ];
  const attention = (await get(base, "api/entity?ref=attention")).json.data;
  assert.ok(Array.isArray(attention.recentChanges));
  assert.deepEqual(attention.recentChanges.map((entry) => [entry.action, entry.initiative]), [["index.rebuild", null], ["gate.answer", INITIATIVE], ["initiative.continuation", INITIATIVE]]);
  assert.deepEqual(attention.recentChanges[1], { ...entries.find((entry) => entry.action === "gate.answer"), initiative: INITIATIVE });
  for (const entry of attention.recentChanges) assert.deepEqual(entry.by, authorOf(root), "each change names who made it and from which checkout");
  assert.ok(attention.recentChanges.length <= 20);
});

// The shared app's project base, the prefix of one checkout's routes.
const projectBase = (url) => /^(.*\/p\/[0-9a-f]{16})/.exec(new URL(url).href)[1];

test("an applied action reaches the tabs of every checkout of the workspace, and an index rebuild only its own checkout's", async (context) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-controls-workspace-")));
  const directory = path.join(parent, "app");
  context.after(async () => {
    const discovery = await readFile(path.join(directory, "review-app.json"), "utf8").then(JSON.parse, () => null);
    if (discovery?.pid && discovery.pid !== process.pid) try { process.kill(discovery.pid); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(parent, { recursive: true, force: true });
  });
  await storeFolder(parent);
  const billing = await repository(parent, "billing", { repository: "billing" });
  const portal = await repository(parent, "portal", { repository: "portal" });
  await updateInitiative({ projectRoot: billing, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Export reports", requirements: ["docs/requirements/reports.md#1"] }] });
  const opened = [];
  const env = { ...process.env, PRISM_REVIEW_APP_DIR: directory };
  const openBrowser = (url) => { opened.push(url); return true; };
  const first = await startStandaloneReview({ projectRoot: billing, env, openBrowser });
  const billingBase = projectBase(first.url);
  const headers = await writeHeaders(billingBase, opened.at(-1));
  const second = await startStandaloneReview({ projectRoot: portal, env, openBrowser });
  const portalBase = projectBase(second.url);
  assert.notEqual(portalBase, billingBase);
  const portalTargets = (await get(portalBase, "api/actions/targets?kind=index")).json.targets;
  assert.deepEqual(portalTargets, ["index:portal/portal"], "a checkout's page lists only its own index");
  assert.equal((await listing(portalBase, "index:billing/billing")).status, 404, "another checkout's index is not a target of this page");
  assert.equal((await listing(portalBase, target)).status, 200, "every checkout of the workspace lists the shared initiative's actions");
  const onPortal = events(context, `${portalBase}/api/events`, "action", 1);
  const onBilling = events(context, `${billingBase}/api/events`, "action", 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const rebuild = actionOf(await listing(billingBase, "index:billing/billing", headers), "index.rebuild");
  const indexed = await apply(billingBase, { action: rebuild.id, target: rebuild.target, input: {}, revision: null }, headers);
  assert.equal(indexed.status, 200, indexed.text);
  const action = actionOf(await listing(billingBase, target, headers), "initiative.continuation");
  const applied = await apply(billingBase, { action: action.id, target, input: { value: "stepwise" }, revision: action.revision }, headers);
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.json.applied.by.checkout.startsWith("billing/main on "), true, "the author's checkout is the one whose page applied it");
  const [portalEvents, billingEvents] = await Promise.all([onPortal, onBilling]);
  assert.deepEqual(portalEvents, [{ ...applied.json.applied, initiative: INITIATIVE }], "the other checkout's tab receives the shared change but not the index rebuild");
  assert.deepEqual(billingEvents.map((event) => event.action), ["index.rebuild", "initiative.continuation"]);
  const attention = (await get(portalBase, "api/entity?ref=attention")).json.data;
  assert.deepEqual(attention.recentChanges.map((entry) => entry.action), ["initiative.continuation"], "Attention of the other checkout shows the shared history and only its own index history");
});

test("the page loads the generic action view", async (context) => {
  const { root } = await actionProject(context);
  const { base } = await startActionReview(context, root);
  const view = await get(base, "views/actions.js");
  assert.equal(view.status, 200);
});
