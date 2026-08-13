import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function skill(name) {
  return readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
}

test("uses three decomposition levels", async () => {
  const workflow = await skill("workflow");
  const ideate = await skill("ideate");
  const plan = await skill("plan");
  const design = await skill("design");

  assert.match(workflow, /## Three decomposition levels/);
  assert.match(ideate, /capabilities can change, ship, or be superseded independently/);
  assert.match(plan, /each track is one coherent technical design unit/);
  assert.match(plan, /Do not split a track only because implementation will need several tasks/);
  assert.match(design, /dependency-ordered implementation tasks/);
});

test("removes implementation-session track sizing", async () => {
  const names = ["workflow", "plan", "design", "implement", "orchestrate"];
  const combined = (await Promise.all(names.map(skill))).join("\n");

  assert.doesNotMatch(combined, /each track is one `design` and `implement` unit/);
  assert.doesNotMatch(combined, /fits one fresh implementation session/);
  assert.doesNotMatch(combined, /re-scope it into a follow-up track/);
  assert.match(combined, /Implementation size alone never creates a new track/);
  assert.match(combined, /Do not create an initiative track only because an implementation task was too large/);
});

test("requires complete implementation task contracts", async () => {
  const buildPlan = await skill("write-build-plan");

  for (const field of [
    "Deliverable",
    "Depends on",
    "Consumes",
    "Produces",
    "Write surface",
    "Tests",
    "Verification",
    "Completion"
  ]) {
    assert.match(buildPlan, new RegExp(`\\*\\*${field}\\*\\*`));
  }
  assert.match(buildPlan, /independently testable task/);
  assert.match(buildPlan, /eligible parallel frontiers/);
});

test("uses capped focused validation waves", async () => {
  const design = await skill("design");
  const validator = await skill("validate-artifacts");

  for (const lane of [
    "Obligations and contracts",
    "Architecture and cutover",
    "Security and containment",
    "Delivery feasibility"
  ]) {
    assert.match(design, new RegExp(lane));
    assert.match(validator, new RegExp(lane));
  }
  assert.match(design, /Run at most three waves/);
  assert.match(design, /Any actionable finding after wave three blocks the design gate/);
  assert.match(design, /A structural finding stops the current wave loop/);
  assert.match(design, /Route an independent design capability or incompatible boundary to `plan`/);
  assert.match(design, /Route a missing prerequisite to `plan` when it changes the track DAG/);
  assert.match(design, /implementation-size problem to the build plan/);
  assert.doesNotMatch(design, /five rounds/);
});

test("controls implementation through a recoverable task ledger", async () => {
  const implement = await skill("implement");
  const handoff = await skill("write-handoff");

  assert.match(implement, /execution-ledger\.md/);
  assert.match(implement, /not part of the validated specification/);
  assert.match(implement, /without editing the validated build plan/);
  assert.match(implement, /Never dispatch a task that the ledger already marks `done`/);
  assert.match(implement, /Map each workstream to one ledger task/);
  assert.match(implement, /Task workers do not commit or push/);
  assert.match(implement, /must also delete the execution ledger/);
  assert.match(handoff, /implementation controller/);
});

test("runs safe task frontiers concurrently", async () => {
  const implement = await skill("implement");

  assert.match(implement, /The host provides isolated workspaces/);
  assert.match(implement, /declared write surfaces do not overlap/);
  assert.match(implement, /produced interfaces do not overlap/);
  assert.match(implement, /Shared-workspace execution is always sequential/);
  assert.match(implement, /Integrate accepted workspaces in topological task order/);
  assert.match(implement, /Use build-plan document order to break ties within one frontier/);
  assert.match(implement, /Rerun that task sequentially from the integrated base/);
});

test("caps task correction and final review loops", async () => {
  const implement = await skill("implement");

  assert.match(implement, /initial attempt and at most two scoped correction rounds/);
  assert.match(implement, /After three failed attempts, classify the cause/);
  assert.match(implement, /one combined fix dispatch/);
  assert.match(implement, /one scoped independent re-review/);
  assert.match(implement, /Stop before the correctness gate when actionable findings remain/);
});

test("keeps task execution inside the three initiative gates", async () => {
  const orchestrate = await skill("orchestrate");
  const implement = await skill("implement");

  assert.match(orchestrate, /`plan` acceptance, `design`'s coherence check, and `implement`'s track correctness confirmation/);
  assert.match(orchestrate, /never adds per-task user gates/);
  assert.match(implement, /Do not ask for correctness confirmation per task/);
  assert.match(implement, /Ask for one correctness confirmation for the complete track/);
});
