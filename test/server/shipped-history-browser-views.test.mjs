import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIATIVE, actionProject, get, startActionReview } from "./fixtures/review-actions.mjs";

// The Attention page and link previews treat a shipped initiative as history: its questions cannot be answered and its slice documents preview with the label.
const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-shipped-views-data-")));
Object.assign(process.env, { PLUGIN_DATA: privateData, PRISM_REVIEW_APP_DIR: path.join(privateData, "app") });
delete process.env.CLAUDE_PLUGIN_DATA;
test.after(() => rm(privateData, { recursive: true, force: true }));

const SHIPPED_AT = "2026-11-03T23:35:20.345Z";
const LABEL = `Shipped history: ${INITIATIVE} shipped on 2026-11-03; this page records finished work.`;
const REASON = "The initiative shipped on 2026-11-03, so its state is history.";

// The action fixture's initiative recorded as shipped with its four open questions, beside an unshipped initiative with one open question.
async function shippedProject(context) {
  const project = await actionProject(context);
  const { updateCoordinationState } = await import("../../dist/server/workflow/state.mjs");
  await updateCoordinationState({ projectRoot: project.root, initiative: "search", expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "decision", question: "Index archived activity?", context: "Archived activity is not searchable today, and indexing it doubles the index size.", recommended: { reason: "Most searches look at recent activity." }, artifacts: [] }] } });
  const file = path.join(project.root, ".prism/roadmap.json");
  const roadmap = JSON.parse(await readFile(file, "utf8"));
  roadmap.initiatives.find((item) => item.id === INITIATIVE).decision = { kind: "shipped", at: SHIPPED_AT, actor: "orchestrator" };
  await writeFile(file, `${JSON.stringify(roadmap, null, 2)}\n`);
  const { base } = await startActionReview(context, project.root, { indexer: { status: async () => ({ state: "ready" }), rebuild: async () => {} } });
  return { ...project, base };
}

test("a shipped initiative's open question shows as unavailable with the shipped reason and raises no count", async (context) => {
  const { base, gateIds } = await shippedProject(context);
  const attention = (await get(base, `api/entity?ref=attention`)).json.data;
  const gates = attention.needsYou.filter((item) => item.type === "gate");
  const shipped = gates.filter((item) => item.initiative.id === INITIATIVE);
  assert.equal(shipped.length, 4);
  for (const gate of shipped) assert.equal(gate.unavailable, REASON, gate.id);
  assert.deepEqual(gates.filter((item) => item.initiative.id === "search").map((item) => item.unavailable), [null]);
  assert.equal(attention.gateCount, 1, "only the unshipped initiative's question waits on the person");
  const navigation = (await get(base, "api/index")).json.navigation;
  assert.equal(navigation.attention.gates, 1);
  assert.equal(navigation.attention.needsYou, attention.needsYou.length - 4, "the badge leaves out the questions that cannot be answered");

  const { gateCard } = await import("../../dist/server/review/public/views/attention.js");
  const ctx = { renderMarkdown: null, hasArtifact: () => true };
  const card = gateCard(shipped.find((item) => item.id === gateIds.decision), ctx, { choice: null, note: "" });
  assert.ok(card.includes(REASON));
  assert.doesNotMatch(card, /data-submit|data-choice|<textarea/, "a shipped question offers no answer form");
  const open = gateCard(gates.find((item) => item.initiative.id === "search"), ctx, { choice: null, note: "" });
  assert.match(open, /data-submit/);
  assert.doesNotMatch(open, /gate-unavailable/);
});

test("a refused answer shows the server's reason instead of saying the question has an answer", async () => {
  const { answerError } = await import("../../dist/server/review/public/views/attention.js");
  assert.deepEqual(answerError(Object.assign(new Error(REASON), { code: "action_unavailable" })), { message: REASON, rerender: true });
  assert.deepEqual(answerError(Object.assign(new Error("The question already has an answer."), { code: "action_unavailable" })), { message: "The question already has an answer.", rerender: true });
  assert.deepEqual(answerError(Object.assign(new Error("gone"), { code: "unknown_gate" })), { message: "The agent already resolved or withdrew this question.", rerender: true });
  assert.deepEqual(answerError(new Error("The review app did not answer.")), { message: "The review app did not answer.", rerender: false });
});

test("a link preview of a shipped initiative's slice document carries the label and names a change after ship", async (context) => {
  const { root, base } = await shippedProject(context);
  // The preview renders Markdown into a scratch element; an element without children previews as an empty document.
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ innerHTML: "", firstElementChild: null, querySelector: () => null }) };
  context.after(() => {
    globalThis.document = previous;
  });
  const { previewHtml } = await import("../../dist/server/review/public/views/preview.js");
  const fetchJson = async (route) => {
    const response = await fetch(`${base.replace(/\/$/, "")}/${route.replace(/^\.\//, "")}`);
    if (!response.ok) throw new Error(`${route} answered ${response.status}`);
    return response.json();
  };
  const options = { fetchJson, renderMarkdown: () => "", kindLabel: (kind) => kind };
  const ref = `docs/plans/${INITIATIVE}/slice.md`;
  const plain = await previewHtml({ ref }, options);
  assert.ok(plain.includes(LABEL), "the preview carries the shipped history label");
  assert.doesNotMatch(plain, /changed after the initiative shipped/);
  await writeFile(path.join(root, ref), `${await readFile(path.join(root, ref), "utf8")}\nA later edit.\n`);
  assert.match(await previewHtml({ ref }, options), /This document changed after the initiative shipped\./);
  assert.doesNotMatch(await previewHtml({ ref: ".prism/workflow.md" }, options), /shipped-history/, "a file that is not a shipped slice document carries no label");
});
