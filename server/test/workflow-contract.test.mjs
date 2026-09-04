import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const productiveSkills = [
  "design", "ideate", "implement", "orchestrate", "plan", "review", "roadmap",
  "workflow-init", "workflow", "write-adr", "write-contracts", "write-feature",
  "write-requirements", "write-step-definitions", "write-user-docs"
];

async function skill(name) {
  return readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
}

async function reference(skillName, name) {
  return readFile(new URL(`../../skills/${skillName}/references/${name}`, import.meta.url), "utf8");
}

function assertProhibited(document, statement) {
  const prohibitions = [...document.matchAll(/^- Don't\n((?:  - .+\n?)+)/gm)].map((match) => match[1]);
  assert.ok(prohibitions.some((block) => block.includes(statement)), `prohibited: ${statement}`);
}

test("declares the productive skill SDM version", async () => {
  for (const name of productiveSkills) {
    assert.match(await skill(name), /^---\n[\s\S]*?^sdm: "0\.3"$[\s\S]*?^---$/m, name);
  }
});

test("uses code as the implementation specification", async () => {
  const workflow = await skill("workflow");

  assert.match(workflow, /Durable sources preserve intent, architectural decisions, boundary behavior, acceptance examples, and implemented structure across the workflow/);
  assert.match(workflow, /Code remains the implementation source/);
  assert.doesNotMatch(workflow, /layered specification/);
});

test("keeps common workflow terms aligned with the artifact model", async () => {
  const workflow = await skill("workflow");

  for (const term of [
    "| Starting surface |",
    "| Acceptance suite |",
    "| Fit checkpoint |",
    "| Executable slice test |",
    "| Executable contract |",
    "| Feature file |",
    "| Step definition |",
    "| Shape-only scaffold |",
    "| Red checkpoint |",
    "| Security surface |",
    "| Review wave |",
    "| Review probe |",
    "| Design checkpoint |",
    "| Decision autonomy |",
    "| Slice continuation |",
    "| `recovery.md` |"
  ]) {
    assert.ok(workflow.includes(term), term);
  }
  assert.match(workflow, /\| Feature file \|.*authored during design after the fit checkpoint passes and bound to assertions during implementation/);
  assert.match(workflow, /\| Executable slice test \|.*authored after the fit checkpoint/);
  assert.match(workflow, /\| Shape-only scaffold \|.*authored after the fit checkpoint/);
  assert.match(workflow, /\| Review probe \|.*minimal failing regression test/);
  assert.match(workflow, /\| Design checkpoint \|.*commit after a clean design audit and visual review/);
  assert.match(workflow, /\| Step definition \|.*implementation-owned binding/);
  assert.match(workflow, /\| Red checkpoint \|.*expected failure recorded before production behavior changes/);
});

test("plans dependency-ordered vertical outcome slices", async () => {
  const plan = await skill("plan");

  for (const field of ["Outcome", "Requirement links", "Starting surface", "Dependencies", "Done signal"]) {
    assert.match(plan, new RegExp(`\\*\\*${field}:\\*\\*`));
  }
  assert.match(plan, /one observable outcome/);
  assert.match(plan, /one connected path from an initiating input to that outcome/);
  assert.match(plan, /boundaries and compatibility effects are identifiable/i);
  assert.match(plan, /At most one consequential architectural decision remains unresolved/);
  assert.match(plan, /one end-to-end verification path/);
  assert.match(plan, /largest coherent outcome that one `Develop <slice>` task can complete safely/);
  assert.match(plan, /creates validated `state\.json` after plan acceptance/);
  assert.match(plan, /Link `map\.puml` from the plan/);
  assert.doesNotMatch(plan, /slices\.puml/);
  assert.match(plan, /one `findings\.md` file under each slice/);
  assert.doesNotMatch(plan, /implementation-task graph/);
});

test("forms bounded slice architecture before fit and authors artifacts only after fit", async () => {
  const design = await skill("design");

  const explore = design.indexOf("## 2. Explore the slice");
  const fit = design.indexOf("## 3. Run the fit checkpoint");
  const form = design.indexOf("### 3.1. Form the slice architecture");
  const preflight = design.indexOf("### 3.2. Run the author preflight");
  const confirm = design.indexOf("### 3.3. Confirm fit");
  const decisions = design.indexOf("### 4.1. Record settled decisions");
  const author = design.indexOf("### 4.2. Author the fitted artifacts");
  assert.ok(explore >= 0 && explore < fit && form < preflight && preflight < confirm && confirm < decisions && decisions < author);
  assert.match(design, /Find the command, route, public function, event handler, scheduled job, or user action where the required behavior starts/);
  assert.match(design, /Map each applicable Approved requirement statement to the code or boundary that will satisfy it/);
  assert.match(design, /Choose the starting surface, owning component, data flow, and state changes/);
  assert.match(design, /Define applicable failure, recovery, compatibility, migration, security, and operational behavior/);
  assert.match(design, /Identify the smallest executable slice test through the starting surface and the result or failure it must observe/);
  assert.match(design, /Identify the Gherkin feature path through `write-feature`/);
  assert.match(design, /Before the fit checkpoint, slice-scoped artifacts remain in the working design and are not written/);
  assert.match(design, /These artifacts include ADRs, feature files, executable tests, contracts, diagrams, and scaffolds/);
  assert.match(design, /Return `SPLIT` or `BLOCKED` without authoring slice-scoped artifacts/);
  assert.match(design, /Confirm that every consequential decision is settled/);
  assert.match(design, /No consequential architectural decision remains unresolved/);
  assert.match(design, /For each boundary needing a new executable contract, use `write-contracts`/);
  assert.match(design, /Create or update the smallest executable slice test through the selected starting surface/);
  assert.match(design, /Create or update the slice Gherkin feature file through `write-feature`/);
  assert.match(design, /Run each design-created executable slice test before implementation/);
  assert.match(design, /Record the exact command and expected failure reason for each red checkpoint/);
  assert.match(design, /When the selected starting surface does not exist:/);
  assertProhibited(design, "Add production behavior during design.");
  assertProhibited(design, "Add a concrete stub that makes the design test pass.");
  assertProhibited(design, "Create step definitions during design.");
  assertProhibited(design, "Create a prose design summary, slice-named design file, task graph, or handoff.");
  assertProhibited(design, "Scan the repository or read complete directories for general understanding.");
  assert.match(design, /Stop after identifying the changed components, affected boundaries, test location, and end-to-end verification command/);
  assertProhibited(design, "Edit the accepted plan, `state.json`, or `map.puml`.");
  assert.match(design, /The orchestrator owns plan changes, lifecycle changes, and the transition to implementation/);
  assertProhibited(design, "Edit a requirement or invoke `write-requirements` without explicit user approval.");
  assert.match(design, /Feature files: <canonical feature paths or NONE>/);
  assert.match(design, /Run the author preflight/);
  assert.match(design, /Trace every Approved requirement to a planned behavior, affected boundary, feature scenario, executable test, and verification command/);
  assert.match(design, /Findings: <slice findings path>/);
  assert.match(design, /After context compaction or replacement, re-read the requirements, ADRs, executable tests, contracts, and findings/);
  assert.ok(design.indexOf("Create or update the smallest executable slice test through the selected starting surface") > author);
  assert.ok(design.indexOf("Create or update the slice Gherkin feature file through `write-feature`") > author);
  assert.ok(design.indexOf("When the selected starting surface does not exist:") > author);
  assert.ok(design.indexOf("When the fit checkpoint passes:") > decisions);
  assert.doesNotMatch(design, /Implementation binds the design-created feature file/);
  assert.doesNotMatch(design, /Do not edit feature scenarios to fit implementation/);
  assert.doesNotMatch(design, /focused validation waves/i);
  assert.doesNotMatch(design, /write-handoff/);
});

test("keeps one delivery task through tests and code", async () => {
  const implement = await skill("implement");

  const red = implement.indexOf("## 2. Prove the red checkpoint");
  const code = implement.indexOf("## 3. Implement the slice");
  const durable = implement.indexOf("## 6. Update durable artifacts");
  assert.ok(red >= 0 && red < code && code < durable);
  assert.match(implement, /delivery context owns implementation and does not delegate it to a fresh worker/i);
  assert.match(implement, /Record only the command, exit status, and expected failure reason/);
  assert.match(implement, /Use the feature file created during design when one exists/);
  assertProhibited(implement, "Create a replacement feature file from verified code.");
  assert.match(implement, /When a BDD harness exists, bind the design-created feature steps through `write-step-definitions`/);
  assert.match(implement, /Preserve the design-created feature files as the acceptance specification/);
  assertProhibited(implement, "Rewrite feature scenarios to match implementation.");
  assert.match(implement, /Run the author preflight/);
  assert.match(implement, /Read every `OPEN`, `IN PROGRESS`, and `REOPENED` finding/);
  assert.match(implement, /\[the review format\]\(\.\.\/review\/references\/review-format\.md\)/);
  assert.match(implement, /Return `READY FOR REVIEW` with changed artifact paths, diagram paths, the findings path/);
  assert.match(implement, /Follow the contract decision recorded by `design`/);
  assert.match(implement, /Use the executable slice test selected during design when one exists/);
  assert.match(implement, /run the design-created test or bound feature before production behavior changes/i);
  assert.match(implement, /Before correcting an unresolved finding with a review probe, run that probe/);
  assertProhibited(implement, "Weaken or replace a design-created test without returning to the `design` fit checkpoint.");
  assert.match(implement, /Before verification, replace every shape-only scaffold with complete behavior/);
  assert.match(implement, /Preserve the asserted behavior of its review probe/);
  assert.doesNotMatch(implement, /Use `write-contracts`/);
  assert.doesNotMatch(implement, /Dispatch task workers/);
  assert.doesNotMatch(implement, /execution-ledger\.md/);
});

test("authors Gherkin during design and binds steps during implementation", async () => {
  const design = await skill("design");
  const feature = await skill("write-feature");
  const implement = await skill("implement");
  const steps = await skill("write-step-definitions");

  assert.match(design, /Create or update the slice Gherkin feature file through `write-feature`/);
  assert.match(feature, /fit checkpoint.*must pass before this skill creates or updates a feature file/);
  assert.match(feature, /slice architecture must be settled before this skill creates or updates a feature file/);
  assert.match(feature, /Implementation must not have started before this skill creates or updates a feature file/);
  assert.match(feature, /must not be a prose design summary or implementation handoff/);
  assert.match(feature, /Create step definitions with this skill/);
  assert.match(steps, /This skill applies during implementation after a design-authored feature file exists/);
  assert.match(implement, /When a BDD harness exists, bind the design-created feature steps through `write-step-definitions`/);
  assert.doesNotMatch(design, /Do not create .*feature file during design/);
  assert.doesNotMatch(feature, /after implementation verification passes/);
});

test("keeps lifecycle changes in orchestration", async () => {
  const design = await skill("design");
  const implement = await skill("implement");
  const orchestrate = await skill("orchestrate");
  const workflow = await skill("workflow");

  assert.match(design, /orchestrator owns plan changes, lifecycle changes, and the transition to implementation/i);
  assertProhibited(implement, "Change slice status, roadmap status, ADR status, or plan lifecycle.");
  assert.match(orchestrate, /marks the leaf slice `in-progress`/);
  assert.match(orchestrate, /Mark the slice `done`/);
  assert.match(orchestrate, /Accept implemented Proposed ADRs/);
  assert.match(orchestrate, /Slice-scoped artifact paths are valid only with `FIT`/);
  assert.match(orchestrate, /A `SPLIT` or `BLOCKED` result must not leave slice-scoped artifacts attached to the rejected slice/);
  assert.match(orchestrate, /Set the roadmap initiative to `shipped`/);
  assert.match(orchestrate, /Delete its scratch plan/);
  assert.match(workflow, /The orchestrator owns routing, coordination state, and user gates/);
});

test("persists orchestration state across sequential sessions", async () => {
  const workflow = await skill("workflow");
  const orchestrate = await skill("orchestrate");
  const operations = await reference("orchestrate", "operations-format.md");
  const schema = await reference("orchestrate", "state-schema.md");

  assert.match(workflow, /The orchestrator owns routing, coordination state, and user gates/);
  assert.match(orchestrate, /\[operations-format\.md\]\(references\/operations-format\.md\)/);
  assert.match(orchestrate, /\[state-schema\.md\]\(references\/state-schema\.md\)/);
  assert.match(schema, /The initiative `state\.json` file is the runtime source of truth/);
  assert.match(schema, /"schemaVersion": 1/);
  assert.match(schema, /"reviewLanes"/);
  assert.match(schema, /dependency cycle/);
  assert.match(schema, /running parent slice/);
  assert.match(schema, /findings path outside the reporting slice directory/);
  assert.match(schema, /Do not reconstruct current state from task transcripts, `map\.puml`, or a worker report/);
  assert.match(operations, /Use `state\.json` as the current initiative state and audit record/);
  assert.match(operations, /"fallbackMinutes": 5/);
  assert.match(operations, /"kind": "patch-accepted"/);
  assert.match(orchestrate, /After context compaction, the context is fresh/);
  assert.match(orchestrate, /Allow a new orchestrator to take over only after a phase boundary or explicit interruption/);
  assert.match(orchestrate, /records a fresh review context as a review wave, not a child restart/);
  assert.match(orchestrate, /After the initiative plan receives acceptance, create and validate its `state\.json`/);
  assert.match(orchestrate, /Regenerate `map\.puml` after each accepted state patch/);
  assert.match(orchestrate, /rejects an invalid patch without changing unrelated state/i);
  assert.match(orchestrate, /Set the handoff status to `ready`/);
  assert.match(orchestrate, /Open one Prism artifact viewer session before presenting the plan for acceptance/);
  assert.match(orchestrate, /Include the plan and slice graph in that session/);
});

test("uses concrete task and exploration terms", async () => {
  const names = ["workflow", "plan", "design", "implement", "review", "write-feature"];
  const combined = (await Promise.all(names.map(skill))).join("\n");

  assert.doesNotMatch(combined, /capability agent|delivery agent|Host capabilities/);
  assert.doesNotMatch(combined, /dominant execution path|coherent contract surface|Approved obligation/);
  assert.match(await skill("plan"), /\*\*Starting surface:\*\*/);
  assert.match(await skill("design"), /command, route, public function, event handler, scheduled job, or user action/);
});

test("creates decision diagrams with ADRs and structure diagrams after code", async () => {
  const design = await skill("design");
  const implement = await skill("implement");
  const adr = await skill("write-adr");

  assert.match(design, /When relationships, lifecycle, or call order are part of the decision, add an ADR decision diagram/);
  assert.match(implement, /Preserve the design-created feature files as the acceptance specification/);
  assert.match(await skill("write-step-definitions"), /This skill applies during implementation after a design-authored feature file exists/);
  assert.match(implement, /After code establishes the structure, create or update a diagram when needed/);
  assert.match(adr, /When `design` calls this skill, the .*fit checkpoint.* must have passed/);
  assert.match(adr, /When relationships, lifecycle, or call order are material, create a PlantUML decision diagram/);
});

test("uses executable contracts only", async () => {
  const design = await skill("design");
  const implement = await skill("implement");
  const review = await skill("review");
  const contracts = await skill("write-contracts");

  assert.match(contracts, /executable contract.*must have a consumer in production code, generated code, or verification/i);
  assert.match(contracts, /OpenAPI|JSON Schema/);
  assert.match(contracts, /importable interface/);
  assert.match(contracts, /compatibility test/);
  assert.match(contracts, /contract must not be prose/);
  assert.match(contracts, /Contract: NO CONTRACT NEEDED/);
  assert.match(contracts, /Reason: <specific reason>/);
  assert.match(contracts, /Return to the calling phase after the result/);
  assert.doesNotMatch(contracts, /plans directory/);
  assert.match(design, /Contract: <canonical path>/);
  assert.match(design, /Contract: NO CONTRACT NEEDED/);
  assert.match(design, /ADRs: <Proposed ADR paths or NONE>/);
  assert.match(design, /Executable tests: <canonical test paths or NONE>/);
  assert.match(design, /Feature files: <canonical feature paths or NONE>/);
  assert.match(design, /Diagrams: <ADR diagram paths or NONE>/);
  assert.match(design, /Red checkpoint: <exact command and expected failure reason or NONE>/);
  assert.match(implement, /Consumers: <production code or verification>/);
  assert.match(implement, /Verification: <exact command>/);
  assert.match(review, /every declared contract has a real consumer/);
  assert.match(review, /canonical path and consumer/);
  assertProhibited(review, "Store a final contract in a slice directory.");
  assert.match(review, /ADRs preserve architectural decisions/);
  assert.match(review, /executable tests and contracts enforce selected boundaries/);
  assert.match(review, /feature files cover planned behavior/);
  assert.match(await skill("write-adr"), /description: "Create or revise an ADR for an architectural decision or invariant\."/);
});

test("uses one review skill for both review modes", async () => {
  const review = await skill("review");

  assert.match(review, /Use the mode supplied by orchestration/);
  assert.match(review, /`design-audit` before implementation/);
  assert.match(review, /`implementation-review` after verification/);
  assert.match(review, /During `implementation-review`, add a minimal finding-scoped regression test only when a concrete finding needs executable proof/);
  assert.match(review, /During `design-audit`, edit only `findings\.md`/);
  assert.match(review, /## Design-audit mode/);
  assert.match(review, /## Implementation-review mode/);
  assert.match(review, /Read \[review-format\.md\]\(references\/review-format\.md\)/);
  assert.match(review, /Return `CLEAN` only when no actionable finding remains/);
  await assert.rejects(skill("design-audit"), /ENOENT/);
  await assert.rejects(skill("write-handoff"), /ENOENT/);
  await assert.rejects(skill("write-build-plan"), /ENOENT/);
  await assert.rejects(skill("validate-artifacts"), /ENOENT/);
});

test("orders design audit before implementation", async () => {
  const orchestrate = await skill("orchestrate");

  const audit = orchestrate.indexOf("#### 2. Audit the design");
  const implement = orchestrate.indexOf("#### 3. Implement");
  assert.ok(audit >= 0 && audit < implement);
  assert.match(orchestrate, /Start a fresh `Review <slice>` agent with `review` in `design-audit` mode/);
  assert.match(orchestrate, /On `CLEAN`, open one Prism artifact viewer session for all recorded ADRs and diagrams/);
  assert.match(orchestrate, /continue to implementation/);
  assert.match(orchestrate, /resume `Develop <slice>` with the path and all unresolved finding IDs/);
  assert.match(orchestrate, /canonical `findings\.md` as the source of truth/);
  assert.match(orchestrate, /After each design correction batch, start a fresh scoped design audit/);
  assert.doesNotMatch(orchestrate, /review-design/);
});

test("scopes autonomy and slice continuation at the design handoff", async () => {
  const orchestrate = await skill("orchestrate");

  assert.match(orchestrate, /Conservative autonomy requires user approval after a clean design audit and visual review/);
  assert.match(orchestrate, /Broad autonomy can continue after a clean design audit and visual review/);
  assert.match(orchestrate, /create exactly two checkpoint commits for each slice/);
  assert.match(orchestrate, /create the design checkpoint/);
  assert.match(orchestrate, /Include only slice-owned design and coordination changes/);
  assert.match(orchestrate, /Record its hash through a validated state patch and use it as the implementation diff base/);
  assert.match(orchestrate, /Pass the design checkpoint hash as the diff base/);
  assert.match(orchestrate, /create the final checkpoint commit from the remaining slice-owned changes/);
  assert.match(orchestrate, /Do not create intermediate workflow commits during correction waves/);
  assert.match(orchestrate, /Slice continuation controls only the transition after a confirmed slice/);
  assert.match(orchestrate, /does not skip design, design audit, visual review, review, or correctness gates/);
  assert.match(orchestrate, /Design: <one-sentence outcome>/);
});

test("reviews completed code in a fresh context", async () => {
  const review = await skill("review");
  const orchestrate = await skill("orchestrate");

  assert.match(review, /Read the requirements, relevant ADRs, executable slice tests, feature files, diagrams, declared contracts, and mode-specific paths/);
  assert.match(review, /fresh context that does not inherit the authoring context/);
  assert.match(review, /Map each requirement to one planned behavior and one observable verification path/);
  assert.match(review, /Check every requirement without accepting added product behavior/);
  assert.match(review, /findings file is the source of truth/i);
  assert.match(review, /Assign a stable ID to each new root defect/);
  assert.match(review, /Mark an implementer's `FIXED` finding `VERIFIED`/);
  assert.match(review, /`REOPENED` when its closing condition fails/);
  assert.match(orchestrate, /Start one child named `Develop <slice>`/);
  assert.match(orchestrate, /atomically mark the parent `split`, add its child slices/);
  assert.match(orchestrate, /Start a fresh `Review <slice>` agent/);
  assert.match(orchestrate, /Use canonical `findings\.md` as the source of truth instead of passing a transient finding list/);
  assert.match(orchestrate, /When a finding becomes `REOPENED` after correction/);
  assert.match(orchestrate, /When the same finding reopens after replacement/);
  assert.match(orchestrate, /Start independent lanes in parallel when isolated workspaces are available/);
  assert.match(orchestrate, /After every implementation correction, start a fresh review/);
  assert.match(orchestrate, /Continue until `CLEAN`, a user stop, or a real blocker/);
  assert.match(orchestrate, /Consolidate all lane findings into canonical `findings\.md` before sending one correction batch/);
  assert.match(orchestrate, /Do not stop after one re-review while findings remain/);
  assert.match(orchestrate, /one active review wave/);
  assert.match(orchestrate, /Pass the implementer's verification status and test paths to reviewers/);
  assert.match(orchestrate, /Do not assign the full test suite or configured verification commands to reviewers/);
  assert.match(orchestrate, /Allow reviewers to add a minimal finding-scoped regression test through a public or system surface/);
  assert.match(orchestrate, /Pass each review probe path and expected failure with its unresolved finding/);
  assert.match(orchestrate, /discard or re-evaluate unaccepted review probes/);
});

test("defines focused review lanes and one review format", async () => {
  const review = await skill("review");
  const orchestrate = await skill("orchestrate");
  const workflow = await skill("workflow");
  const delegation = await reference("workflow", "delegation.md");
  const format = await readFile(new URL("../../skills/review/references/review-format.md", import.meta.url), "utf8");

  assert.match(orchestrate, /Define a review matrix before starting high-risk review lanes/);
  assert.match(orchestrate, /Lane: security/);
  assert.match(orchestrate, /Lane: lifecycle/);
  assert.match(orchestrate, /Lane: integration/);
  assert.match(orchestrate, /Do not send identical review instructions to all lanes/);
  assert.match(orchestrate, /Deduplicate equivalent findings without deleting their reporting-lane evidence/);
  assert.match(orchestrate, /Check uncovered coverage and route each escalation target from its reporting slice/);
  assert.match(orchestrate, /exact lane findings path/);
  assert.match(review, /Write only to the exact lane findings path supplied by orchestration/);
  assert.match(delegation, /Focus: <specific risks>/);
  assert.doesNotMatch(workflow, /Review focus: <specific review lens>/);
  assert.doesNotMatch(workflow, /Coverage: <paths or checks>/);
  assert.match(review, /references\/review-format\.md/);
  assert.match(orchestrate, /\[review-format\.md\]\(\.\.\/review\/references\/review-format\.md\)/);
  assert.match(review, /When orchestration supplies a lane focus, review it exhaustively/);
  assert.match(review, /Read the completed diff, verification status, test paths, and exact commands/);
  assert.match(review, /does not rerun the full test suite or configured verification commands/);
  assert.match(review, /When a concrete finding needs executable proof:[\s\S]*Add one minimal review probe through the public or system surface/);
  assert.match(review, /Record the probe path, command, and expected failure in the finding/);
  assert.match(review, /Put the probe in the canonical test location/);
  assert.match(review, /Use existing fixtures or local setup/);
  assert.match(format, /# Slice review/);
  assert.match(format, /## Findings/);
  assert.match(format, /## Result/);
  assert.match(format, /### F-001: <short finding title>/);
  assert.match(format, /Mode: design-audit \| implementation-review/);
  assert.match(format, /Writable findings: docs\/plans\/<initiative>\/<slice>\/lanes\/<lane>\/findings\.md/);
  assert.match(format, /Escalation target:/);
  assert.match(format, /Finding IDs: F-001, F-002/);
  assert.match(format, /Red checkpoint: <exact command and expected failure reason or NONE>/);
  assert.match(format, /Feature files: <paths or NONE>/);
  assert.match(format, /Review probes: <paths or NONE>/);
  assert.match(format, /Review probe: <path, command, expected failure, or NONE>/);
  assert.match(format, /Status: CLEAN \| FINDINGS/);
  assert.doesNotMatch(format, /Use this reference|Copy this structure|Add one entry|Return one result block/);
  for (const status of ["OPEN", "IN PROGRESS", "FIXED", "VERIFIED", "REOPENED"]) {
    assert.match(format, new RegExp(status));
  }
  assert.match(format, /Status history:/);
  assert.match(format, /Review history:/);
});

test("declares model policy and child model roles", async () => {
  const orchestrate = await skill("orchestrate");
  const delegation = await reference("workflow", "delegation.md");

  assert.match(orchestrate, /\| Model policy \| `default` or `manual` \| `default` \(recommended\) \|/);
  assert.match(orchestrate, /apply the default judgment or set models manually/);
  assert.match(orchestrate, /\| Planning \| Host default \|/);
  assert.match(orchestrate, /\| Delivery \| Host default \|/);
  assert.match(orchestrate, /\| High-risk review \| Host security model when available/);
  assert.match(orchestrate, /ask for planning, delivery, review, and high-risk review assignments/);
  assert.match(orchestrate, /Assign it the `planning` model role/);
  assert.match(orchestrate, /Assign the `delivery` model role/);
  assert.match(orchestrate, /uses the `security-review` model role/);
  assert.match(orchestrate, /Record the model role and resolved model/);
  assert.match(orchestrate, /same model role and resolved model/);
  assert.match(orchestrate, /Give the child only the request scope, paths, scratch destination, profile, model role, and resolved model/);
  assert.match(delegation, /Model role: <role>/);
  assert.match(delegation, /Model: <resolved model or host default>/);
  assert.match(delegation, /Pass the model role and resolved model through every child start and broker request/);
  assert.match(delegation, /planning \| delivery \| review \| security-review/);
});

test("detects delegation from a callable child-start capability", async () => {
  const delegation = await reference("workflow", "delegation.md");

  assert.match(delegation, /Child-agent capability exists only when a child-start action is callable/);
  assert.match(delegation, /A wait or status action alone is not child-agent capability/);
  assert.match(delegation, /return a broker request to the nearest parent with child-agent capability/);
  assert.match(delegation, /Kind: explore \| task \| review/);
});

test("supervises only active child agents", async () => {
  const orchestrate = await skill("orchestrate");

  assert.match(orchestrate, /Never wait with an empty identifier set/);
  assert.match(orchestrate, /estimate its expected execution time from its phase and execution profile/);
  assert.match(orchestrate, /Wait for completion, failure, blocker, progress, or replacement events before status observation/);
  assert.match(orchestrate, /wait five minutes before the first fallback observation/);
  assert.match(orchestrate, /next fallback interval to one minute longer/);
  assert.match(orchestrate, /reset the fallback interval to five minutes/);
  assert.match(orchestrate, /fallback check-in schedule, not a deadline or execution limit/i);
  assert.match(orchestrate, /A fallback observation means only that no event arrived/);
  assert.match(orchestrate, /not evidence that the child is stuck/);
  assert.match(orchestrate, /Interrupt only after a positive failure signal, a user request, or an explicit child blocker/);
  assert.match(orchestrate, /Do not poll silently running children at ten-second intervals/);
  assert.match(orchestrate, /Do not narrate unchanged waits/);
  assert.match(orchestrate, /Resume the same child when possible/);
  assert.match(orchestrate, /start a replacement in the same workspace/);
  assert.match(orchestrate, /Give the replacement the current code and recorded recovery state/);
});

test("supports a continuous delivery benchmark phase", async () => {
  const benchHarness = await readFile(new URL("../../bench/harness/bench.py", import.meta.url), "utf8");

  assert.match(benchHarness, /--delivery-context/);
  assert.match(benchHarness, /choices=\["separate", "continuous"\]/);
  assert.match(benchHarness, /CONTINUOUS_DELIVERY_PROMPT/);
  assert.match(benchHarness, /run a fresh `review` pass in `design-audit` mode before implementation/);
  assert.match(benchHarness, /complete findings to the same delivery context/);
  assert.match(benchHarness, /if args\.delivery_context == "continuous"/);
  assert.doesNotMatch(benchHarness, /Produce the full spec: ADR, contracts, a dependency-ordered implementation-task graph/);
});

test("keeps visual review selection and procedure in its reference", async () => {
  const workflow = await skill("workflow");
  const visualReview = await reference("workflow", "visual-review.md");
  const phaseSkills = await Promise.all(["plan", "design", "roadmap"].map(skill));

  assert.match(workflow, /\[visual-review\.md\]\(references\/visual-review\.md\)/);
  assert.match(visualReview, /Missing `Review browser` defaults to `auto`/);
  assert.match(visualReview, /For `auto`, use the internal browser in desktop sessions and the system browser in CLI sessions/);
  assert.match(visualReview, /For `internal`, use the internal browser/);
  assert.match(visualReview, /For `external`, use the system browser/);
  assert.match(visualReview, /Explicit `internal` and `external` values override `auto`/);
  assert.match(visualReview, /Open one Prism artifact viewer session for all recorded ADRs and diagrams after a clean design audit/);
  assert.match(visualReview, /each session opens the complete artifact tree/);
  assert.match(visualReview, /Open one Prism artifact viewer session for all changed artifacts and diagrams before the final correctness gate/);
  assert.match(visualReview, /Use a browser-opening capability with no artifact argument/);
  assert.match(visualReview, /Treat a URL-only result or an unavailable opener as a fallback/);
  assert.match(visualReview, /present the URL and source artifacts/);
  assert.doesNotMatch(phaseSkills.join("\n"), /present_review/);
});

test("writes review browser configuration with an adaptive default", async () => {
  const workflowInit = await skill("workflow-init");
  const benchHarness = await readFile(new URL("../../bench/harness/bench.py", import.meta.url), "utf8");

  assert.match(workflowInit, /- Review browser: auto \| internal \| external/);
  assert.match(workflowInit, /The default is `auto`/);
  assert.match(benchHarness, /- Review browser: auto/);
});

test("uses the Codex benchmark model policy", async () => {
  const benchHarness = await readFile(new URL("../../bench/harness/bench.py", import.meta.url), "utf8");
  const benchReadme = await readFile(new URL("../../bench/README.md", import.meta.url), "utf8");

  assert.match(benchHarness, /args\.model = "gpt-5\.6-terra" if args\.agent == "codex"/);
  assert.match(benchHarness, /args\.po_model = "gpt-5\.6-luna"/);
  for (const model of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]) {
    assert.match(benchReadme, new RegExp(model.replaceAll(".", "\\.")));
  }
  assert.match(benchReadme, /Use Sol only when the declared security surface is non-empty/);
  assert.match(benchReadme, /use Terra for that role in both arms and disclose the substitution/i);
});
