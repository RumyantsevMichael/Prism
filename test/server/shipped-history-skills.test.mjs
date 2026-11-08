import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Workflow sessions route defects to the initiative that owns the broken work, treat shipped material as history, and run fixes as new work.
const skill = (name) => readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");

test("§31 triage adds a defect in unshipped done work to its initiative and a defect in shipped work to a new initiative that corrects it", async () => {
  const triage = await skill("triage");
  assert.match(triage, /`report_defect`/);
  assert.match(triage, /`corrects`/);
  assert.match(triage, /not shipped|unshipped|has not shipped/);
  assert.match(triage, /defect id/i);
  assert.match(triage, /^description: ".*Use when an issue or the user reports that existing behavior is wrong\."$/m, "the trigger keeps when to use it");
});

test("§32 triage, design, implement, and review cite shipped material only as history", async () => {
  for (const name of ["triage", "design", "implement", "review"]) {
    const source = await skill(name);
    assert.match(source, /shipped/i, name);
    assert.match(source, /only as history/, name);
  }
  assert.match(await skill("workflow"), /Approved requirements, Accepted ADRs, the glossary, and feature files/);
});

test("§33 orchestration designs fixes, handles the ship refusals, and commits the history marks", async () => {
  const orchestrate = await skill("orchestrate");
  assert.match(orchestrate, /fix scope/i);
  assert.match(orchestrate, /`open_work`/);
  assert.match(orchestrate, /`fixes_unfinished`/);
  assert.match(orchestrate, /`historyMarks`/);
});

test("§34 design writes one fix slice for a done scope, and implementation changes another slice's frozen test only for the slice it fixes", async () => {
  const design = await skill("design");
  assert.match(design, /`add_fix`/);
  assert.match(design, /done scope/i);
  const implement = await skill("implement");
  assert.match(implement, /fix/i);
  assert.match(implement, /\*\*Changes\*\* names/);
  assert.doesNotMatch(implement, /update_|get_initiative|get_review/, "implementation still calls only verify_slice and wait_for_user_gate");
});

test("§35 the common terms define shipped history, fix slices, and defects in done or shipped work", async () => {
  const workflow = await skill("workflow");
  assert.match(workflow, /^\| Shipped history \| .+ \|$/m);
  assert.match(workflow, /^\| Fix slice \| .*`report_defect`|^\| Fix slice \| .*`add_fix`/m);
  assert.match(workflow, /^\| Defect \| .*done slice.*\|$/m);
  assert.match(workflow, /^\| Defect \| .*later initiative.*\|$/m);
  assert.match(workflow, /^\| Initiative lifecycle \| .*history.*\|$/m);
});
