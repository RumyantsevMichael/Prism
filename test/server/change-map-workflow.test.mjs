import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { UPDATE_CHANGE_MAP_SCHEMA } from "../../dist/server/conservation/change-map.mjs";
import { assertInput } from "../../dist/server/workflow/artifact-schema.mjs";
const source = (name) => readFile(new URL(`../../skills/${name}`, import.meta.url), "utf8");

test("design authors planned changes through MCP and returns a ready revision", async () => {
  const design = await source("design/SKILL.md");
  const procedure = await source("design/references/change-map.md");
  assert.match(design, /change-map MCP capability/);
  assert.match(design, /Before `FIT`, validate the complete change map at one revision/);
  assert.match(design, /ready change map path and exact revision/);
  assert.match(procedure, /Agents never edit managed JSON/);
  assert.match(procedure, /MCP or required semantic preparation is unavailable, return `BLOCKED`/);
  assert.match(procedure, /parent change map does not authorize child implementation/);
  assert.match(procedure, /tests, contracts, documentation, and configuration/);
});
test("implementation and review preserve the audited revision and detect deviations", async () => {
  const implement = await source("implement/SKILL.md");
  const review = await source("review/SKILL.md");
  const delivery = await source("orchestrate/references/delivery-rules.md");
  const reviewRules = await source("orchestrate/references/review-rules.md");
  const format = await source("review/references/review-format.md");
  assert.match(implement, /through MCP at its audited revision/);
  assert.match(implement, /material deviation from it requires design revision and a new design audit/);
  assert.match(implement, /never rewrites the accepted change map/);
  assert.match(review, /scope, coverage of planned changes, and reuse evidence/);
  assert.match(review, /immutable B→F comparison/);
  assert.match(delivery, /accepted design revision and current A snapshot/);
  assert.match(reviewRules, /change map path and submitted or audited revision/);
  assert.match(format, /Change map revision: <SHA-256>/);
});
test("the shared change map procedure has resolvable links and tested operation examples", async () => {
  const reference = await source("design/references/change-map.md");
  const blocks = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  assert.ok(blocks.length > 0, "The change map procedure must contain operation examples.");
  for (const operation of blocks) assertInput(UPDATE_CHANGE_MAP_SCHEMA.properties.operations.items, operation);
  for (const match of reference.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    await readFile(new URL(`../../skills/design/references/${match[1]}`, import.meta.url));
  }
  assert.match(await source("workflow/SKILL.md"), /\| Change map \|/);
  assert.match(await source("workflow/references/artifact-rules.md"), /Manage slice `change-map.json`/);
});
