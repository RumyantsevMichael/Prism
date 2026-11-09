import assert from "node:assert/strict";
import test from "node:test";
import { demoProject, serveProject, useAppDirectory } from "./fixtures/kit-browser.mjs";
import { prepareTouched, TOUCHED_SLICE } from "./fixtures/places-touched.mjs";

// Touched by my work for Retry timed-out requests until a total deadline, read from the review server over the changed demo.
// The slice cites section 1 of the retry requirements, links a decision and a diagram, names two glossary terms in its clauses, and plans changes to the decision and the glossary.

async function server(context) {
  await useAppDirectory(context);
  const root = await demoProject(context);
  await prepareTouched(root);
  const { base } = await serveProject(context, root);
  return { base, fetchJson: async (route) => { const response = await fetch(`${base}${route}`); return { status: response.status, body: await response.json() }; } };
}

const byTitle = (records, title) => records.find((record) => record.title === title);

test("clauses 56, 58, 60: The contract cites lists the cited requirements by section, the linked decision and diagram, and the terms its clauses name", { timeout: 60000 }, async (context) => {
  const { fetchJson } = await server(context);
  const { status, body } = await fetchJson(`/api/touched?slice=${encodeURIComponent(TOUCHED_SLICE)}`);
  assert.equal(status, 200);
  assert.deepEqual(body.initiative, { id: "retry-hardening", title: "Harden request retries" });
  assert.deepEqual(body.slice, { slug: "timeout-retries", title: "Retry timed-out requests until a total deadline" });
  assert.deepEqual(body.groups.map((group) => group.reason), ["cites", "changes"]);
  const cites = body.groups[0].records;
  assert.deepEqual(byTitle(cites, "Retry requirements"), { kind: "requirement", title: "Retry requirements", status: "Approved", ref: "docs/requirements/retries.md", why: ["Section 1"] });
  assert.deepEqual(byTitle(cites, "Bound retries by a total deadline"), { kind: "decision", title: "Bound retries by a total deadline", status: "Proposed", ref: "docs/ADRs/retries/total-retry-deadline.md", why: ["Linked from the design"] });
  assert.deepEqual(byTitle(cites, "timeout-retries"), { kind: "diagram", title: "timeout-retries", status: null, ref: "docs/plans/retry-hardening/timeout-retries/timeout-retries.puml", why: ["Linked from the design"] });
  assert.deepEqual(byTitle(cites, "Retry deadline"), { kind: "glossary-term", title: "Retry deadline", status: "Defined", ref: "glossary", why: ["Clause 1"] });
  assert.deepEqual(byTitle(cites, "Attempt timeout"), { kind: "glossary-term", title: "Attempt timeout", status: "Defined", ref: "glossary", why: ["Clause 2"] });
  assert.equal(byTitle(cites, "Signed report"), undefined, "a term no clause names is not cited");
  assert.equal(cites.length, 5);
});

test("clauses 57, 58, 60: This work changes lists the records that a Changes line names and no code file", { timeout: 60000 }, async (context) => {
  const { fetchJson } = await server(context);
  const { body } = await fetchJson(`/api/touched?slice=${encodeURIComponent(TOUCHED_SLICE)}`);
  const changes = body.groups.find((group) => group.reason === "changes").records;
  const decision = byTitle(changes, "Bound retries by a total deadline");
  assert.equal(decision.kind, "decision");
  assert.equal(decision.why[0], "Planned by the design");
  const glossary = byTitle(changes, "Glossary");
  assert.deepEqual({ ...glossary, why: glossary.why.slice(0, 1) }, { kind: "glossary", title: "Glossary", status: null, ref: "docs/Glossary.md", why: ["Planned by the design"] });
  assert.equal(changes.some((record) => record.ref === "src/retry.mjs"), false, "a code file is not a record");
});

test("clause 60: an unknown slice answers 404 and a request without one answers 400", { timeout: 60000 }, async (context) => {
  const { fetchJson } = await server(context);
  const unknown = await fetchJson("/api/touched?slice=retry-hardening/no-such-slice");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "unknown_slice");
  const missing = await fetchJson("/api/touched");
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "invalid_slice");
});
