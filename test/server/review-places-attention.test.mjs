import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, serveProject, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { prepareAttention } from "./fixtures/places-attention.mjs";

// Attention's counts by kind and by initiative, its failed verifications, and its answered questions, read from the review server over the changed demo.
// Questions: the decision on Harden request retries and the one on Export activity reports, since the review gate was answered.
// Blocked work: Retry dropped connections and the blocked part of each of three initiatives off the roadmap, which are also problems with the roadmap's two open questions.

async function server(context) {
  await useAppDirectory(context);
  const root = await demoProject(context);
  await prepareAttention(root);
  const { base } = await serveProject(context, root);
  return { root, base, get: async (route) => (await fetch(`${base}${route}`)).json() };
}

test("clauses 36, 37, 42: the navigation counts every kind, everything as their sum, and the questions that wait for an answer", { timeout: 60000 }, async (context) => {
  const { get } = await server(context);
  const attention = (await get("/api/index")).navigation.places.attention;
  assert.deepEqual(attention.kinds, { questions: 2, findings: 1, failed: 1, blocked: 4, ready: 0, problems: 5 });
  assert.equal(attention.everything, 13);
  assert.equal(attention.questions, 2, "the rail's count is the questions that wait for an answer");
  assert.equal(attention.answered, 3, "three questions were answered or closed in the last 7 days");
});

test("clauses 38, 42: by work counts each initiative's items, most first and ties by title", { timeout: 60000 }, async (context) => {
  const { get } = await server(context);
  const work = (await get("/api/index")).navigation.places.attention.work;
  assert.deepEqual(work.map((entry) => [entry.id, entry.title, entry.count]), [
    ["retry-hardening", "Harden request retries", 4],
    ["alpha-search", "Alpha search", 2],
    ["beta-billing", "Beta billing", 2],
    ["gamma-gateway", "Gamma gateway", 2],
    ["activity-reports", "Export activity reports", 1]
  ]);
});

test("clauses 41, 43: the latest failed run of a slice that is not done is a failed verification until a later run passes", { timeout: 60000 }, async (context) => {
  const { get } = await server(context);
  const watch = (await get("/api/entity?ref=attention")).data.watch.filter((entry) => entry.type === "failed-verification");
  assert.equal(watch.length, 1, "a fixed run and a done slice are not listed");
  const [failed] = watch;
  assert.deepEqual(failed.initiative, { id: "retry-hardening", title: "Harden request retries" });
  assert.deepEqual(failed.slice, { slug: "connection-retries", title: "Retry dropped connections" });
  assert.equal(failed.reason, "command_failed");
  assert.equal(failed.failingCount, 2);
  assert.ok(Date.now() - Date.parse(failed.finishedAt) < 60 * 60 * 1000, "the time the run finished");
});

test("clauses 40, 43: answered lists the questions answered or closed in the last 7 days, newest first, with the answer or the reason", { timeout: 60000 }, async (context) => {
  const { get } = await server(context);
  const page = await get(`/api/entity?ref=${encodeURIComponent("attention:answered")}`);
  assert.equal(page.ref, "attention:answered");
  assert.equal(page.kind, "attention");
  const answered = page.data.answered;
  assert.deepEqual(answered.map((entry) => entry.question), [
    "Review the change map and the total-deadline ADR before implementation starts.",
    "Keep the old socket wrapper?",
    "Review the first draft of the change map."
  ], "newest first, the one closed 10 days ago left out");
  assert.equal(answered[0].answer.choice, "approve");
  assert.equal(answered[1].answer.note, "Keep it until connection retries land.");
  assert.equal(answered[2].answer, null);
  assert.equal(answered[2].reason, "The design changed, so the agent withdrew it.");
  assert.deepEqual(answered[0].initiative, { id: "retry-hardening", title: "Harden request retries" });
  assert.deepEqual(answered[0].slice, { slug: "timeout-retries", title: "Retry timed-out requests until a total deadline" });
  for (const entry of answered) assert.ok(Number.isFinite(Date.parse(entry.at)));
});
