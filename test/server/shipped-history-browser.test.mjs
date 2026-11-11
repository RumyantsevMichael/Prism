import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, actionOf, actionProject, apply, get, listing, pageSession, startActionReview } from "./fixtures/review-actions.mjs";

// The review browser labels a shipped initiative, its slices, and its slice documents as history and offers no action on them.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-shipped-browser-data-")));
Object.assign(process.env, { PLUGIN_DATA: privateData, PRISM_REVIEW_APP_DIR: path.join(privateData, "app") });
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const SHIPPED_AT = "2026-11-03T23:35:20.345Z";
const LABEL = `Shipped history: ${INITIATIVE} shipped on 2026-11-03; this page records finished work.`;
const REASON = "The initiative shipped on 2026-11-03, so its state is history.";

// The action fixture's initiative, with its pending gates, recorded as shipped the way an initiative shipped before shipped history was.
async function shippedActionProject(context) {
  const project = await actionProject(context);
  const file = path.join(project.root, ".prism/roadmap.json");
  const roadmap = JSON.parse(await readFile(file, "utf8"));
  roadmap.initiatives.find((item) => item.id === INITIATIVE).decision = { kind: "shipped", at: SHIPPED_AT, actor: "orchestrator" };
  await writeFile(file, `${JSON.stringify(roadmap, null, 2)}\n`);
  const { review, base, opened } = await startActionReview(context, project.root, { indexer: { status: async () => ({ state: "ready" }), rebuild: async () => {} } });
  return { ...project, review, base, opened };
}

test("§16 the initiative and slice pages carry the shipped history label", async (context) => {
  const { base } = await shippedActionProject(context);
  const initiative = await get(base, `api/entity?ref=${encodeURIComponent(`initiative:${INITIATIVE}`)}`);
  assert.equal(initiative.status, 200);
  assert.equal(initiative.json.data.shippedHistory.label, LABEL);
  assert.equal(initiative.json.data.shippedHistory.shippedAt, SHIPPED_AT);
  assert.ok(Array.isArray(initiative.json.data.shippedHistory.documents));
  const slice = await get(base, `api/entity?ref=${encodeURIComponent(`slice:${INITIATIVE}/${INITIATIVE}`)}`);
  assert.equal(slice.json.data.shippedHistory.label, LABEL);
  const other = await get(base, `api/entity?ref=${encodeURIComponent("initiative:search")}`);
  assert.equal(other.json.data.shippedHistory ?? null, null, "an initiative that has not shipped carries no label");
});

test("§17 a slice document's context carries the label and says whether it changed after ship", async (context) => {
  const { root, base } = await shippedActionProject(context);
  const ref = `docs/plans/${INITIATIVE}/slice.md`;
  // The first read records the document's content at that time as the shipped content.
  const first = await get(base, `api/context?ref=${encodeURIComponent(ref)}`);
  assert.equal(first.json.shippedHistory.label, LABEL);
  assert.equal(first.json.shippedHistory.changedAfterShip, false);
  await writeFile(path.join(root, ref), `${await readFile(path.join(root, ref), "utf8")}\nA later edit.\n`);
  const changed = await get(base, `api/context?ref=${encodeURIComponent(ref)}`);
  assert.equal(changed.json.shippedHistory.changedAfterShip, true);
  const unrelated = await get(base, `api/context?ref=${encodeURIComponent(".prism/workflow.md")}`);
  assert.equal(unrelated.json.shippedHistory ?? null, null);
});

test("§18 the page renders the label above its content and names a document changed after ship", async () => {
  const { shippedHistoryHtml } = await import("../../dist/server/review/public/views/shipped-history.js");
  assert.equal(shippedHistoryHtml(null), "");
  assert.equal(shippedHistoryHtml(undefined), "");
  const plain = shippedHistoryHtml({ label: "Shipped history: <reports> shipped on 2026-11-03; this page records finished work.", changedAfterShip: false });
  assert.match(plain, /Shipped history: &lt;reports&gt; shipped on 2026-11-03; this page records finished work\./);
  assert.doesNotMatch(plain, /changed after the initiative shipped/);
  assert.match(shippedHistoryHtml({ label: LABEL, changedAfterShip: true }), /This document changed after the initiative shipped\./);
});

test("§19 every action on a shipped initiative, its slices, and its gates is unavailable and refused", async (context) => {
  const { root, base, review, opened, gateIds } = await shippedActionProject(context);
  const headers = await pageSession(review, opened);
  for (const target of [`initiative:${INITIATIVE}`, `slice:${INITIATIVE}/${INITIATIVE}`, `gate:${INITIATIVE}/${gateIds.decision}`]) {
    const list = await listing(base, target, headers);
    assert.equal(list.status, 200, target);
    assert.ok(list.json.actions.length > 0, target);
    for (const action of list.json.actions) assert.deepEqual([action.available, action.reason], [false, REASON], `${target} ${action.id}`);
  }
  const state = path.join(root, ".prism/initiatives", INITIATIVE, "state.json");
  const before = await readFile(state, "utf8");
  const push = actionOf(await listing(base, `initiative:${INITIATIVE}`, headers), "initiative.push");
  const refused = await apply(base, { target: `initiative:${INITIATIVE}`, action: "initiative.push", input: { value: "on" }, revision: push.revision, confirmed: true }, headers);
  assert.deepEqual([refused.status, refused.json.code, refused.json.reason], [409, "action_unavailable", REASON]);
  const gate = actionOf(await listing(base, `gate:${INITIATIVE}/${gateIds.decision}`, headers), "gate.answer");
  const answered = await apply(base, { target: `gate:${INITIATIVE}/${gateIds.decision}`, action: "gate.answer", input: { choice: "keep" }, revision: gate.revision }, headers);
  assert.deepEqual([answered.status, answered.json.code], [409, "action_unavailable"]);
  assert.equal(await readFile(state, "utf8"), before, "the coordination state did not change");
  const targets = await get(base, "api/actions/targets?kind=index", headers);
  const index = await listing(base, targets.json.targets[0], headers);
  assert.ok(index.json.actions.every((action) => action.reason !== REASON), "index targets are not history");
});
