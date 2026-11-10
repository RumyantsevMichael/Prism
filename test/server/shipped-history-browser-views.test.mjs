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
  const shipped = attention.shippedGates;
  assert.equal(shipped.length, 4);
  for (const gate of shipped) assert.deepEqual([gate.initiative.id, gate.unavailable], [INITIATIVE, REASON], gate.id);
  const gates = attention.needsYou.filter((item) => item.type === "gate");
  assert.deepEqual(gates.map((item) => [item.initiative.id, item.unavailable]), [["search", null]], "only the unshipped initiative's question needs the person");
  assert.equal(attention.gateCount, 1);
  const navigation = (await get(base, "api/index")).json.navigation;
  assert.equal(navigation.attention.gates, 1);
  assert.equal(navigation.attention.needsYou, attention.needsYou.length, "the badge leaves out the questions that cannot be answered");

  const { gateDetail } = await import("../../dist/server/review/public/views/attention.js");
  const ctx = { renderMarkdown: null, hasArtifact: () => true };
  const card = gateDetail(shipped.find((item) => item.id === gateIds.decision), ctx, { choice: null, note: "" });
  assert.ok(card.includes(REASON));
  assert.doesNotMatch(card, /data-submit|data-choice|gate-answer/, "a shipped question offers no answer form");
  const open = gateDetail(gates.find((item) => item.initiative.id === "search"), ctx, { choice: null, note: "" });
  assert.match(open, /data-submit/);
  assert.doesNotMatch(open, /gate-unavailable/);
});

test("Attention lists a shipped initiative's questions under their own group and shows Needs you empty when nothing else waits", async (context) => {
  const { base } = await shippedProject(context);
  const attention = (await get(base, `api/entity?ref=attention`)).json.data;
  // Only the shipped questions remain: the unshipped initiative's question is left out to show the empty state.
  const data = { ...attention, needsYou: attention.needsYou.filter((item) => item.type !== "gate") };
  const previous = globalThis.document;
  globalThis.document = { addEventListener: () => {} };
  context.after(() => {
    globalThis.document = previous;
  });
  const { render } = await import("../../dist/server/review/public/views/attention.js");
  // The page head takes the summary figures beside the title.
  const head = { html: "", querySelector: () => null, insertAdjacentHTML(_, html) { this.html += html; } };
  const container = { innerHTML: "", isConnected: true, addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, parentElement: { querySelector: () => head } };
  render(container, { data }, { state: {}, hasArtifact: () => true, renderMarkdown: null });
  const html = container.innerHTML;
  const list = html.slice(html.indexOf('<div class="attention-list"'), html.indexOf('<div class="attention-detail">'));
  const start = list.indexOf('id="attention-group-shipped"');
  const group = list.slice(start, list.indexOf("</section>", start));
  assert.ok(list.indexOf('id="attention-group-shipped"') >= 0, "the shipped questions have their own group");
  assert.doesNotMatch(list, /attention-group-needs/, "Needs you lists nothing");
  assert.match(list.slice(0, list.indexOf('id="attention-group-shipped"')), /Nothing is waiting on you/, "Needs you shows its empty state before the shipped group");
  assert.match(group, /<span>Shipped history<\/span>/);
  assert.match(group, /left open when their initiative shipped, so they can no longer be answered/);
  assert.equal(group.split("<prism-inbox-item").length - 1, 4);
  // Each shipped question's detail names the shipped reason in place of the answer form.
  const details = html.slice(html.indexOf('<div class="attention-detail">'));
  assert.equal(details.split(REASON).length - 1, 4);
  assert.doesNotMatch(details, /gate-answer/);
  assert.match(head.html, /label="questions wait on you" value="0"/);
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
