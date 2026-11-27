import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// Ideation shapes an item through rounds, sourced findings, and Draft ADRs within 425 words, and design decides the Draft ADRs.

const skill = (name) => readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
// Words as wc counts them: runs of characters between whitespace, over the whole file.
const words = (text) => text.split(/\s+/).filter(Boolean).length;
const body = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, "");

test("§52: the ideation skill is at most 425 words and links no reference file of its own", async () => {
  const ideate = await skill("ideate");
  assert.ok(words(ideate) <= 425, `ideate holds ${words(ideate)} words`);
  const own = await readdir(new URL("../../skills/ideate/", import.meta.url));
  assert.deepEqual(own.filter((name) => name !== "SKILL.md" && name !== "agents"), [], "ideate has no references folder");
  assert.doesNotMatch(ideate, /\]\((?!\.\.\/)[^)#]+\.md/, "every link leaves the ideate folder");
});

test("§52: ideation starts with a roadmap entry and a question round before any requirement, and waits inside an orchestration", async () => {
  const ideate = body(await skill("ideate"));
  for (const tool of ["`update_roadmap`", "`get_work_item`", "`update_work_item`"]) assert.ok(ideate.includes(tool), tool);
  assert.match(ideate, /`ask_round`/);
  assert.match(ideate, /five questions/i);
  const round = ideate.search(/`ask_round`/);
  const requirements = ideate.search(/`write-requirements`/);
  assert.ok(round >= 0 && requirements > round, "the round comes before the requirements are written");
  assert.match(ideate, /orchestrat[^\n]*(BLOCKED|blocker)|(BLOCKED|blocker)[^\n]*orchestrat/i, "inside an orchestration an unanswered round returns as a blocker");
  assert.match(ideate, /`request_ready`/);
});

test("§52: ideation records inputs, sourced findings, research gaps, and architecture choices as Draft ADRs with a person's preference as an option", async () => {
  const ideate = body(await skill("ideate"));
  for (const operation of ["`add_input`", "`add_finding`", "`add_research_gap`", "`cite`"]) assert.ok(ideate.includes(operation), operation);
  assert.match(ideate, /source/i);
  assert.match(ideate, /Draft ADR/);
  assert.match(ideate, /two options/i);
  assert.match(ideate, /prefer/i);
  assert.match(ideate, /`write-adr`/);
});

test("§52: ideation merges, splits, and kills only through Prism's proposals, and starts no agent to check its work", async () => {
  const ideate = body(await skill("ideate"));
  for (const operation of ["`propose_merge`", "`propose_split`", "`propose_kill`"]) assert.ok(ideate.includes(operation), operation);
  assert.doesNotMatch(ideate, /delegation\.md|subagent|child agent|reviewer/i, "no extra agent checks the shaping");
  assert.doesNotMatch(ideate, /\.prism\/initiatives|shaping\.json|record store|\bconcept/i, "the skill names tools, never how Prism stores state");
});

test("§53: write-adr describes Draft ADRs, design decides them, and orchestration waits on a shaping round", async () => {
  const adr = await skill("write-adr");
  assert.match(adr, /Draft/);
  assert.match(adr, /`decide`/);
  assert.ok(adr.includes("(references/adr-format.md)"));
  const format = await readFile(new URL("../../skills/write-adr/references/adr-format.md", import.meta.url), "utf8");
  assert.match(format, /^Format version: 2$/m);
  assert.match(format, /## Options/);
  assert.match(format, /Preferred by:/);
  const design = await skill("design");
  assert.match(design, /Draft ADR/);
  assert.match(design, /`decide`/);
  assert.match(design, /`get_work_item`/);
  const orchestrate = await skill("orchestrate");
  assert.match(orchestrate, /ideat[^\n]*round|round[^\n]*ideat/i);
});

test("§53: the common terms define emerging and ready work items, the shaping record, question rounds, and Draft ADRs without the word concept", async () => {
  const workflow = await skill("workflow");
  const terms = workflow.split(/^## Common terms$/m)[1].split(/^## /m)[0];
  for (const term of ["Work item", "Emerging work item", "Shaping record", "Question round", "Draft ADR"]) {
    const row = terms.split("\n").find((line) => line.startsWith(`| ${term} |`));
    assert.ok(row, term);
    assert.doesNotMatch(row, /\bconcept/i, term);
  }
  assert.match(terms, /\| Initiative lifecycle \|[^\n]*emerging/);
});
