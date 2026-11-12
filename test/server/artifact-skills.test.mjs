import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Skills write to the artifact formats, add glossary terms when their decisions are made, report what the check missed, and migrate in a session of their own.

const skill = (name) => readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
const exists = (name) => readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8").then(() => true, () => false);

test("clause 42: the migrate skill converts one artifact per session through Prism's migration tools and commits it on its own", async () => {
  assert.equal(await exists("migrate"), true, "skills/migrate/SKILL.md exists");
  const migrate = await skill("migrate");
  assert.match(migrate, /^name: migrate$/m);
  assert.match(migrate, /^description: ".*Use when a person asks for an artifact's migration or accepts an offer of it.*"$/m, "the trigger says when to use it");
  for (const tool of ["`check_artifacts`", "`propose_migration`", "`wait_for_user_gate`", "`apply_migration`"]) assert.ok(migrate.includes(tool), tool);
  assert.match(migrate, /`unknown`/);
  assert.match(migrate, /Git history/i);
  assert.match(migrate, /leftover/i);
  assert.match(migrate, /one artifact/i);
  assert.match(migrate, /commit of its own|its own commit/i);
  for (const reference of ["../write-requirements/references/requirement-format.md", "../write-adr/references/adr-format.md", "../write-feature/references/feature-format.md", "../workflow/references/glossary-format.md"]) assert.ok(migrate.includes(`(${reference})`), reference);
  assert.doesNotMatch(migrate, /\.prism\/|initiative\.json|record store|\bconcept/i, "the skill names tools, never how Prism stores state");
});

test("clause 43: the authoring skills link their format reference in place of an inline template, and setup creates a glossary in its format", async () => {
  const links = { "write-requirements": "references/requirement-format.md", "write-adr": "references/adr-format.md", "write-feature": "references/feature-format.md", workflow: "references/glossary-format.md" };
  for (const [name, link] of Object.entries(links)) assert.ok((await skill(name)).includes(`(${link})`), `${name} links ${link}`);
  assert.doesNotMatch(await skill("write-requirements"), /^Pattern: <Ubiquitous/m, "the requirement template moved into the format reference");
  assert.doesNotMatch(await skill("write-adr"), /^## Decision Log\n\n<Dated/m, "the ADR template moved into the format reference");
  const setup = await skill("setup");
  assert.ok(setup.includes("(../workflow/references/glossary-format.md)"), "setup links the glossary format");
});

test("clause 44: approving requirements adds their new terms to the glossary in the same change, and ideation waits for the approval", async () => {
  const requirements = await skill("write-requirements");
  assert.match(requirements, /glossary/i);
  assert.match(requirements, /same change/i);
  assert.match(requirements, /source/i);
  const ideate = await skill("ideate");
  assert.doesNotMatch(ideate, /If a necessary new product term appears, update the glossary\./);
});

test("clause 45: accepting a Proposed ADR adds its new terms to the glossary in the same change", async () => {
  const orchestrate = await skill("orchestrate");
  assert.match(orchestrate, /Accept the slice's Proposed ADRs[^\n]*glossary/i);
});

test("clause 46: a skill that finds nonconformance the check did not report reports it with an offer of migration and leaves the artifact unchanged", async () => {
  const workflow = await skill("workflow");
  assert.match(workflow, /`check_artifacts`/);
  assert.match(workflow, /offer[^\n]*migration/i);
  assert.match(workflow, /unchanged/i);
});

test("clause 47: the common terms define the artifact format words without the word concept", async () => {
  const workflow = await skill("workflow");
  const terms = workflow.split("## Common terms")[1] ?? "";
  for (const term of ["Artifact format", "Format finding", "Legacy mark", "Migration", "Leftover list"]) assert.match(terms, new RegExp(`^\\| ${term} \\|`, "m"), term);
  const added = terms.split("\n").filter((line) => /^\| (Artifact format|Format finding|Legacy mark|Migration|Leftover list) \|/.test(line)).join("\n");
  assert.doesNotMatch(added, /concept/i);
});
