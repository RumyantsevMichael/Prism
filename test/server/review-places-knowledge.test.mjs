import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, serveProject, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { writeText } from "./fixtures/places-browser.mjs";

// The Knowledge place's diagrams page and its records search, read from the review server over the demo with three diagrams added:
// one named in a decision's folder beside that decision, one unnamed in an initiative's folder, and the demo's own unnamed one in a slice's folder.

async function server(context) {
  await useAppDirectory(context);
  const root = await demoProject(context);
  await writeText(root, "docs/ADRs/retries/total-retry-deadline.puml", "@startuml Deadline flow\nTotal -> Deadline\n@enduml\n");
  await writeText(root, "docs/plans/retry-hardening/overview.puml", "@startuml\nclass Retries\n@enduml\n");
  const { base } = await serveProject(context, root);
  return { base, get: async (route) => (await fetch(`${base}${route}`)).json() };
}

test("clause 51: knowledge:diagrams lists every diagram by its name with its owner, ordered by owner and then name", { timeout: 60000 }, async (context) => {
  const { get } = await server(context);
  const page = await get(`/api/entity?ref=${encodeURIComponent("knowledge:diagrams")}`);
  assert.equal(page.ref, "knowledge:diagrams");
  assert.equal(page.kind, "diagrams");
  assert.deepEqual(page.data.diagrams, [
    { path: "docs/ADRs/retries/total-retry-deadline.puml", name: "Deadline flow", owner: { kind: "decision", title: "Bound retries by a total deadline" } },
    { path: "docs/plans/retry-hardening/overview.puml", name: "overview", owner: { kind: "initiative", title: "Harden request retries" } },
    { path: "docs/plans/retry-hardening/timeout-retries/timeout-retries.puml", name: "timeout-retries", owner: { kind: "slice", title: "Harden request retries · Retry timed-out requests until a total deadline" } }
  ]);
});

test("clause 53: the records search groups matches by kind, titles that contain the text first, and every word must occur", { timeout: 60000 }, async (context) => {
  const { get } = await server(context);
  const result = await get(`/api/records/search?q=${encodeURIComponent("total deadline")}`);
  assert.equal(result.query, "total deadline");
  assert.deepEqual(result.groups.map((group) => group.kind), ["requirement", "decision", "glossary-term", "diagram"]);
  const titles = Object.fromEntries(result.groups.map((group) => [group.kind, group.results.map((entry) => entry.title)]));
  assert.deepEqual(titles.requirement, ["Retry requirements"], "a requirements file whose text holds both words");
  assert.deepEqual(titles.decision, ["Bound retries by a total deadline"]);
  assert.deepEqual(titles["glossary-term"], ["Retry deadline"], "one word in the term, the other in its definition");
  assert.deepEqual(titles.diagram, ["Deadline flow"]);
  assert.equal(result.groups[0].results[0].ref, "docs/requirements/retries.md");
  assert.equal(result.groups[2].results[0].ref, "glossary");
  assert.equal(result.groups[3].results[0].ref, "docs/ADRs/retries/total-retry-deadline.puml");

  const deadline = await get("/api/records/search?q=DEADLINE");
  const decisions = deadline.groups.find((group) => group.kind === "decision").results.map((entry) => entry.title);
  assert.equal(decisions[0], "Bound retries by a total deadline", "case is ignored and a title holding the text comes first");
  const terms = deadline.groups.find((group) => group.kind === "glossary-term").results.map((entry) => entry.title);
  assert.deepEqual(terms, ["Retry deadline"]);

  const signed = await get("/api/records/search?q=signed");
  assert.deepEqual(signed.groups.map((group) => group.kind), ["requirement", "glossary-term"], "empty groups are left out");

  assert.deepEqual((await get("/api/records/search?q=d")).groups, [], "one character finds nothing");
  assert.deepEqual((await get("/api/records/search?q=zzzz")).groups, []);
});
