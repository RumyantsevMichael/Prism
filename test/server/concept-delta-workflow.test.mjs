import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { UPDATE_CONCEPT_DELTA_SCHEMA } from "../../dist/server/concept-delta.mjs";
import { assertInput } from "../../dist/server/artifact-schema.mjs";
const source = (name) => readFile(new URL(`../../skills/${name}`, import.meta.url), "utf8");

test("design authors concept transitions through MCP and returns a ready revision", async () => {
  const design = await source("design/SKILL.md");
  const procedure = await source("design/references/concept-delta.md");
  assert.match(design, /concept-delta MCP capability/);
  assert.match(design, /Before `FIT`, validate the complete delta at one revision/);
  assert.match(design, /ready concept delta path and exact revision/);
  assert.match(procedure, /Agents never edit managed JSON/);
  assert.match(procedure, /MCP or required semantic preparation is unavailable, return `BLOCKED`/);
  assert.match(procedure, /parent delta does not authorize child implementation/);
  assert.match(procedure, /tests, contracts, documentation, and configuration/);
});
test("implementation and review preserve the audited revision and detect deviations", async () => {
  const implement = await source("implement/SKILL.md");
  const review = await source("review/SKILL.md");
  const delivery = await source("orchestrate/references/delivery-rules.md");
  const reviewRules = await source("orchestrate/references/review-rules.md");
  const format = await source("review/references/review-format.md");
  assert.match(implement, /through MCP at its audited revision/);
  assert.match(implement, /material concept deviation requires design revision and a new design audit/);
  assert.match(implement, /never rewrites the accepted delta/);
  assert.match(review, /scope, concept coverage, and reuse evidence/);
  assert.match(review, /immutable B→F comparison/);
  assert.match(delivery, /accepted design revision and current A snapshot/);
  assert.match(reviewRules, /concept delta path and submitted or audited revision/);
  assert.match(format, /Concept delta revision: <SHA-256>/);
});
test("the shared concept procedure has resolvable links and tested operation examples", async () => {
  const reference = await source("design/references/concept-delta.md");
  const blocks = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  assert.ok(blocks.length > 0, "The concept procedure must contain operation examples.");
  for (const operation of blocks) assertInput(UPDATE_CONCEPT_DELTA_SCHEMA.properties.operations.items, operation);
  for (const match of reference.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    await readFile(new URL(`../../skills/design/references/${match[1]}`, import.meta.url));
  }
  assert.match(await source("workflow/SKILL.md"), /\| Concept delta \|/);
  assert.match(await source("workflow/references/artifact-rules.md"), /Manage slice `concept-delta.json`/);
});
