import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Requirements: docs/requirements/review-loop-decisions.md §1, §5, §7.
// Orchestration follows the review loop decision that Prism records, files a follow-up per deferred finding, and the terms and guide say so.

const read = (relative) => readFile(new URL(`../../${relative}`, import.meta.url), "utf8");
const skill = (name) => read(`skills/${name}/SKILL.md`);
const section = (source, heading) => {
  const start = source.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `section ${heading}`);
  const next = source.indexOf("\n## ", start + 3);
  return source.slice(start, next === -1 ? undefined : next);
};

test("clause 30: orchestration waits for Prism's review loop gate and acts on each option it offers", async () => {
  const review = section(await skill("orchestrate"), "5. Review");
  assert.doesNotMatch(review, /narrow/i, "narrowing the slice is not an option");
  assert.doesNotMatch(review, /ask a `decision` gate whether to continue/, "orchestration asks no review loop question of its own");
  for (const option of ["continue-review", "return-to-design", "accept-deferred"]) assert.ok(review.includes(`\`${option}\``), option);
  assert.match(review, /`afterGate`/);
  assert.match(review, /`return_to_design`/);
  assert.match(review, /`deferrals`/);
  assert.match(review, /`review_loop_limit`/);
});

test("clause 30: orchestration files one follow-up per deferred finding in the configured tracker, or a roadmap open question", async () => {
  const review = section(await skill("orchestrate"), "5. Review");
  assert.match(review, /tracker/i);
  assert.match(review, /`\.prism\/workflow\.md`/);
  assert.match(review, /open question/i);
  assert.ok(review.includes("`roadmap: <question>`"));
});

test("clause 1: orchestration records an answer given in conversation with its choice", async () => {
  const gates = section(await skill("orchestrate"), "6. User gates");
  assert.match(gates, /`resolve`/);
  assert.match(gates, /`choice`/);
});

test("clause 31: the common terms define the review loop decision and a deferred finding", async () => {
  const workflow = await skill("workflow");
  const terms = section(workflow, "Common terms");
  assert.match(terms, /^\| Review loop decision \| .+ \|$/m);
  assert.match(terms, /^\| Deferred finding \| .*`DEFERRED`.* \|$/m);
  assert.match(terms, /^\| Deferred finding \| .*low.* \|$/m);
  const wave = terms.match(/^\| Review wave \| (.+) \|$/m)?.[1] ?? "";
  assert.match(wave, /review loop decision/i);
  const defect = terms.match(/^\| Contract defect \| (.+) \|$/m)?.[1] ?? "";
  assert.match(defect, /return(s|ed)? .*to design|return_to_design/i);
});

test("clause 31: the review skill leaves a deferred finding unchanged", async () => {
  const review = await skill("review");
  assert.ok(review.includes("`DEFERRED`"));
});

test("clause 32: the user guide describes the review loop decision, its recommendation, and deferred findings", async () => {
  const workflow = await read("docs/user-guide/workflow.md");
  assert.doesNotMatch(workflow, /or narrow it/);
  assert.match(workflow, /Continue the review/);
  assert.match(workflow, /Return the slice to design/);
  assert.match(workflow, /Accept with deferred low findings/);
  assert.match(workflow, /recommend/i);
  assert.match(workflow, /deferred/i);
  const browser = await read("docs/user-guide/review-browser.md");
  assert.match(browser, /DEFERRED|deferred finding/i);
});
