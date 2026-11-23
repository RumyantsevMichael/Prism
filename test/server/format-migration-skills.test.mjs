import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// The migrate-artifact skill is the procedure that a run Prism launched follows, the workflow skill has skills report a break the check missed,
// and no skill offers a person a format migration.

const skillsFolder = new URL("../../skills/", import.meta.url);
const skill = (name) => readFile(new URL(`${name}/SKILL.md`, skillsFolder), "utf8");
const frontmatter = (text) => text.split(/^---$/m)[1] ?? "";
const body = (text) => text.split(/^---$/m).slice(2).join("---");

test("clause 10: migrate-artifact carries out one run that Prism started, through the run's tools", async () => {
  const migrate = await skill("migrate-artifact");
  const head = frontmatter(migrate);
  assert.match(head, /^name: migrate-artifact$/m);
  const description = head.match(/^description: "(.*)"$/m)?.[1] ?? "";
  assert.match(description, /format migration run/i, "it says what it does");
  assert.match(description, /Prism start/i, "the run is one that Prism started");
  assert.match(description, /Use (only )?when a prompt names/i, "it says when to use it");
  assert.match(head, /^argument-hint: '\[run id\]'$/m);
  for (const tool of ["`get_migration_run`", "`get_artifact`", "`propose_migration`", "`finish_migration_run`", "`fail_migration_run`"]) assert.ok(migrate.includes(tool), tool);
  for (const reference of ["../write-requirements/references/requirement-format.md", "../write-adr/references/adr-format.md", "../write-feature/references/feature-format.md", "../workflow/references/glossary-format.md"]) assert.ok(migrate.includes(`(${reference})`), reference);
  assert.match(migrate, /Git history/i);
  assert.match(migrate, /`unknown`/);
  assert.match(migrate, /settled/i);
  assert.match(migrate, /asked/i);
  assert.match(migrate, /recommendation/i);
  assert.match(migrate, /answer/i, "it applies the person's answers when the run holds them");
  for (const removed of ["`apply_migration`", "`get_migration`"]) assert.equal(migrate.includes(removed), false, `${removed} is gone`);
  assert.doesNotMatch(body(migrate), /`git |\bgit log\b|\bBash\b/i, "the run reads Git history from get_migration_run and runs no shell or Git command");
  assert.match(migrate, /`get_migration_run`[^\n]*(Git history|history)|(Git history|history)[^\n]*`get_migration_run`/i, "the sources' Git history comes from get_migration_run");
});

test("clause 11: migrate-artifact asks the person nothing, waits for no gate, commits nothing, and names no Prism storage", async () => {
  const migrate = await skill("migrate-artifact");
  const text = body(migrate);
  assert.equal(text.includes("`wait_for_user_gate`"), false);
  assert.doesNotMatch(text, /\bask the person\b|\bagree with the person\b|\boffer\b/i);
  assert.doesNotMatch(text, /\bcommit\b/i, "Prism records the applied run, so the skill commits nothing");
  assert.doesNotMatch(migrate, /\.prism\/|initiative\.json|record store|format-findings|migration-runs|\bconcept/i, "the skill names tools, never how Prism stores state");
  assert.doesNotMatch(text, /session of its own|fresh session/i);
});

test("clause 12: workflow has a skill report a break that check_artifacts missed through report_format_finding, tell the person, and leave the artifact unchanged", async () => {
  const workflow = await skill("workflow");
  const rule = workflow.split("\n").find((line) => line.includes("`report_format_finding`"));
  assert.ok(rule, "workflow names report_format_finding");
  assert.match(rule, /`check_artifacts`/);
  assert.match(rule, /unchanged/i);
  assert.match(rule, /tell the person|tells the person/i);
  assert.doesNotMatch(rule, /offer|ask for a migration/i);
});

test("clause 13: no skill offers a person a format migration or tells a person to ask for one", async () => {
  const names = (await readdir(skillsFolder, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const name of names) {
    const text = await skill(name).catch(() => "");
    for (const line of text.split("\n")) {
      assert.doesNotMatch(line, /offer[^\n]{0,60}(format )?migration|migration[^\n]{0,30}offer/i, `${name}: ${line}`);
      assert.doesNotMatch(line, /ask(s)? for (a|its|the) (format )?migration/i, `${name}: ${line}`);
      assert.doesNotMatch(line, /accepts? (an|the) offer/i, `${name}: ${line}`);
    }
  }
});

test("clause 14: workflow's Common terms drop Legacy mark and define format finding, format migration, and leftover list without the word concept", async () => {
  const workflow = await skill("workflow");
  const terms = workflow.split(/^## Common terms\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  assert.ok(terms, "workflow has Common terms");
  const definition = (term) => terms.split("\n").find((line) => line.toLowerCase().startsWith(`| ${term.toLowerCase()} |`)) ?? "";
  assert.equal(definition("Legacy mark"), "", "Legacy mark is no term");
  const finding = definition("Format finding");
  assert.match(finding, /`check_artifacts`/);
  assert.match(finding, /`report_format_finding`/);
  const migration = definition("Format migration");
  assert.match(migration, /run/i);
  assert.match(migration, /lost|invented/i);
  assert.match(migration, /asks the person once|ask(s)? once/i);
  assert.match(migration, /not the move|apart from the move/i);
  assert.ok(definition("Leftover list"), "Leftover list is defined");
  assert.doesNotMatch(terms, /\bconcept/i);
});

test("clause 15: migrate-artifact recommends an unknown point's value itself, and a separate source's removal once every statement has a home", async () => {
  const migrate = body(await skill("migrate-artifact"));
  const sentences = migrate.split(/\n/);
  assert.ok(sentences.some((line) => /unknown/i.test(line) && /recommendation/i.test(line) && /value itself/i.test(line)), "an unknown point's recommendation is the value itself");
  assert.ok(sentences.some((line) => /separate source/i.test(line) && /remov/i.test(line) && /every (source )?statement/i.test(line) && /home/i.test(line)), "the separate source is removed once every statement has a home");
});
