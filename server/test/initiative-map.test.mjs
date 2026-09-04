import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillNames = [
  "design", "ideate", "implement", "orchestrate", "plan", "review", "roadmap",
  "workflow-init", "workflow", "write-adr", "write-contracts", "write-feature",
  "write-requirements", "write-step-definitions", "write-user-docs"
];

async function skill(name) {
  return readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
}

test("uses map.puml for newly created initiative maps", async () => {
  const plan = await skill("plan");
  const design = await skill("design");
  const workflow = await skill("workflow");

  assert.match(plan, /Link `map\.puml` from the plan/);
  assert.match(design, /Edit the accepted plan, `state\.json`, or `map\.puml`/);
  assert.match(workflow, /\| `map\.puml` \|/);
});

test("migrates a legacy initiative map only when a current map is absent", async () => {
  const orchestrate = await skill("orchestrate");

  assert.match(orchestrate, /When `map\.puml` is absent and legacy `slices\.puml` exists, move its unchanged content to `map\.puml`, update plan links, and record the migration in the state audit trail/);
});

test("does not direct active skills to create slices.puml", async () => {
  const documents = await Promise.all(skillNames.map(skill));
  const legacyReferences = documents
    .flatMap((document, index) => [...document.matchAll(/slices\.puml/g)].map(() => skillNames[index]));

  assert.deepEqual(legacyReferences, ["orchestrate"]);
});
