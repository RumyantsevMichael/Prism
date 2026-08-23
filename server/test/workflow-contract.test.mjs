import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function skill(name) {
  return readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
}

async function reference(skillName, name) {
  return readFile(new URL(`../../skills/${skillName}/references/${name}`, import.meta.url), "utf8");
}

test("uses code as the implementation specification", async () => {
  const workflow = await skill("workflow");

  assert.match(workflow, /Artifacts preserve information that code cannot preserve/);
  assert.match(workflow, /Requirements preserve intent/);
  assert.match(workflow, /ADRs preserve consequential decisions/);
  assert.match(workflow, /Tests and feature files preserve behavior/);
  assert.match(workflow, /Diagrams explain the implemented structure/);
  assert.match(workflow, /Code explains implementation/);
  assert.doesNotMatch(workflow, /layered specification/);
});

test("plans dependency-ordered vertical outcome slices", async () => {
  const plan = await skill("plan");

  for (const field of ["Outcome", "Requirement links", "Starting surface", "Dependencies", "Done signal"]) {
    assert.match(plan, new RegExp(`\\*\\*${field}:\\*\\*`));
  }
  assert.match(plan, /one observable outcome/);
  assert.match(plan, /one connected set of changes from an initiating input to that outcome/);
  assert.match(plan, /identifiable boundaries and compatibility effects/);
  assert.match(plan, /at most one unresolved consequential architectural decision/);
  assert.match(plan, /one end-to-end verification path/);
  assert.match(plan, /largest coherent outcome that one `Develop <slice>` task can complete safely/);
  assert.match(plan, /creates `state\.md` after plan acceptance/);
  assert.match(plan, /one `findings\.md` file under each slice/);
  assert.doesNotMatch(plan, /implementation-task graph/);
});

test("forms bounded slice architecture before the fit decision", async () => {
  const design = await skill("design");

  const explore = design.indexOf("## 1. Explore the slice");
  const fit = design.indexOf("## 2. Run the fit checkpoint");
  const decisions = design.indexOf("## 3. Settle consequential decisions");
  assert.ok(explore >= 0 && explore < fit && fit < decisions);
  assert.match(design, /Find where the required behavior enters the system/);
  assert.match(design, /Map each applicable Approved requirement statement to the code or boundary that will satisfy it/);
  assert.match(design, /Choose where the behavior starts, which component owns it, how data moves, and how state changes/);
  assert.match(design, /Define failure, recovery, compatibility, migration, security, and operational behavior/);
  assert.match(design, /Do not scan the repository or read complete directories for general understanding/);
  assert.match(design, /Stop exploration after you can name the changed components, affected boundaries, test location, and end-to-end verification command/);
  assert.match(design, /Do not edit the accepted plan or `slices\.puml`/);
  assert.match(design, /The orchestrator owns plan changes, lifecycle changes, and the transition to implementation/);
  assert.match(design, /Do not edit a requirement or invoke `write-requirements` without explicit user approval/);
  assert.match(design, /implementation skill updates feature files and implemented-structure diagrams after the code passes verification/);
  assert.match(design, /Run the author preflight/);
  assert.match(design, /trace every Approved requirement to a planned behavior/);
  assert.match(design, /Findings: <slice findings path>/);
  assert.doesNotMatch(design, /focused validation waves/i);
  assert.doesNotMatch(design, /write-handoff/);
});

test("keeps one delivery task through tests and code", async () => {
  const implement = await skill("implement");

  const red = implement.indexOf("## 2. Prove the red checkpoint");
  const code = implement.indexOf("## 3. Implement the slice");
  const durable = implement.indexOf("## 6. Update durable artifacts");
  assert.ok(red >= 0 && red < code && code < durable);
  assert.match(implement, /Do not delegate implementation to a fresh worker/);
  assert.match(implement, /Record only the command, exit status, and expected failure reason/);
  assert.match(implement, /Update feature files from verified behavior after implementation/);
  assert.match(implement, /Run the author preflight/);
  assert.match(implement, /Read every `OPEN`, `IN PROGRESS`, and `REOPENED` finding/);
  assert.match(implement, /\[the review format\]\(\.\.\/review\/references\/review-format\.md\)/);
  assert.match(implement, /Return `READY FOR REVIEW` with changed artifact and diagram paths, the findings path/);
  assert.match(implement, /Follow the contract decision recorded by `design`/);
  assert.doesNotMatch(implement, /Use `write-contracts`/);
  assert.doesNotMatch(implement, /Dispatch task workers/);
  assert.doesNotMatch(implement, /execution-ledger\.md/);
});

test("keeps lifecycle changes in orchestration", async () => {
  const design = await skill("design");
  const implement = await skill("implement");
  const orchestrate = await skill("orchestrate");
  const workflow = await skill("workflow");

  assert.match(design, /orchestrator owns plan changes, lifecycle changes, and the transition to implementation/i);
  assert.match(implement, /Do not change slice status, roadmap status, ADR status, or plan lifecycle/);
  assert.match(orchestrate, /mark the slice `in-progress`/);
  assert.match(orchestrate, /Mark the slice `done`/);
  assert.match(orchestrate, /Accept implemented Proposed ADRs/);
  assert.match(orchestrate, /set the roadmap initiative to `shipped`, and delete its scratch plan/);
  assert.match(workflow, /The orchestrator owns routing, coordination state, and user gates/);
});

test("persists orchestration state across sequential sessions", async () => {
  const workflow = await skill("workflow");
  const orchestrate = await skill("orchestrate");
  const operations = await reference("orchestrate", "operations-format.md");

  for (const field of ["Status", "Active slice", "Phase", "Gate", "Next action", "Child", "Wait", "Findings", "Handoff", "Recovery", "Updated"]) {
    assert.match(orchestrate, new RegExp(`${field}:`));
  }
  assert.match(workflow, /The orchestrator owns routing, coordination state, and user gates/);
  assert.match(orchestrate, /\[operations-format\.md\]\(references\/operations-format\.md\)/);
  assert.match(operations, /## Operations: <slice>/);
  assert.match(operations, /Context lineage: D1 -> D2/);
  assert.match(operations, /Review waves: 2/);
  assert.match(operations, /Count a fresh review context as a review wave, not as a child restart/);
  assert.match(orchestrate, /After context compaction, treat the context as fresh/);
  assert.match(orchestrate, /Allow a new orchestrator to take over only after a phase boundary or an explicit interruption/);
  assert.match(orchestrate, /Count a fresh review context as a review wave, not as a child restart/);
  assert.match(orchestrate, /Update the operations block at child and phase transitions, not after every wait/);
  assert.match(orchestrate, /Link to `findings\.md` for detailed review evidence instead of duplicating it in the operations block/);
  assert.match(orchestrate, /Create `state\.md` after the initiative plan receives acceptance/);
  assert.match(orchestrate, /Update `state\.md` before and after every child transition/);
  assert.match(orchestrate, /Set the handoff status to `ready`/);
  assert.match(orchestrate, /open one Prism artifact viewer session for the plan and slice graph before presenting them for acceptance/);
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

  assert.match(design, /Add a decision diagram with an ADR when relationships, lifecycle, or call order are part of the decision/);
  assert.match(implement, /Update feature files from verified behavior after implementation/);
  assert.match(implement, /Create or update a diagram only after code establishes the structure/);
  assert.match(adr, /Create a PlantUML decision diagram when relationships, lifecycle, or call order are material to the ADR/);
});

test("uses executable contracts only", async () => {
  const design = await skill("design");
  const implement = await skill("implement");
  const review = await skill("review");
  const contracts = await skill("write-contracts");

  assert.match(contracts, /Create a contract only when code or verification consumes it/);
  assert.match(contracts, /OpenAPI|JSON Schema/);
  assert.match(contracts, /importable interface/);
  assert.match(contracts, /compatibility test/);
  assert.match(contracts, /Do not create a prose contract/);
  assert.match(contracts, /Contract: NO CONTRACT NEEDED/);
  assert.match(contracts, /Reason: <specific reason>/);
  assert.doesNotMatch(contracts, /plans directory/);
  assert.match(design, /Contract: <canonical path>/);
  assert.match(design, /Contract: NO CONTRACT NEEDED/);
  assert.match(design, /recorded design artifact and diagram paths/);
  assert.match(implement, /Consumers: <production code or verification>/);
  assert.match(implement, /Verification: <exact command>/);
  assert.match(review, /every declared contract has a real consumer/);
  assert.match(review, /canonical path and consumer/);
  assert.match(review, /Do not store a final contract in a slice directory/);
});

test("uses one review skill for both review modes", async () => {
  const review = await skill("review");

  assert.match(review, /Use the mode supplied by orchestration/);
  assert.match(review, /`design-audit` before implementation/);
  assert.match(review, /`implementation-review` after verification/);
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

  const audit = orchestrate.indexOf("### Design audit");
  const implement = orchestrate.indexOf("### Implement");
  assert.ok(audit >= 0 && audit < implement);
  assert.match(orchestrate, /Start a fresh `Review <slice>` agent with `review` in `design-audit` mode/);
  assert.match(orchestrate, /On `CLEAN`, open one Prism artifact viewer session for all recorded design artifacts/);
  assert.match(orchestrate, /continue to implementation/);
  assert.match(orchestrate, /resume `Develop <slice>` with its path and all unresolved finding IDs/);
  assert.match(orchestrate, /Use `findings\.md` as the source of truth/);
  assert.match(orchestrate, /After each design correction batch, start one fresh scoped `review` in `design-audit` mode/);
  assert.doesNotMatch(orchestrate, /review-design/);
});

test("scopes autonomy and slice continuation at the design handoff", async () => {
  const orchestrate = await skill("orchestrate");

  assert.match(orchestrate, /Conservative autonomy requires a user approval after a clean design audit and visual review/);
  assert.match(orchestrate, /Broad autonomy may continue automatically after a clean design audit and visual review/);
  assert.match(orchestrate, /Slice continuation controls only the transition after a confirmed slice/);
  assert.match(orchestrate, /does not skip design, design audit, visual review, review, or correctness gates/);
  assert.match(orchestrate, /Design: <one-sentence outcome>/);
});

test("reviews completed code in a fresh context", async () => {
  const review = await skill("review");
  const orchestrate = await skill("orchestrate");

  assert.match(review, /Read the requirements, relevant ADRs, tests, feature files, diagrams, declared contracts, and mode-specific paths/);
  assert.match(review, /fresh context that does not inherit the authoring context/);
  assert.match(review, /Check every applicable item/);
  assert.match(review, /Use the findings file as the source of truth/);
  assert.match(review, /Assign a stable ID to each new root defect/);
  assert.match(review, /Mark an implementer's `FIXED` finding `VERIFIED`/);
  assert.match(review, /`REOPENED` when it fails/);
  assert.match(orchestrate, /Start one child agent named `Develop <slice>`/);
  assert.match(orchestrate, /resume the same `Develop <slice>` agent/);
  assert.match(orchestrate, /Start a fresh `Review <slice>` agent/);
  assert.match(orchestrate, /Use `findings\.md` as the source of truth instead of passing a transient finding list/);
  assert.match(orchestrate, /When a finding has status `REOPENED` after a correction batch/);
  assert.match(orchestrate, /When the same finding reopens after that replacement/);
  assert.match(orchestrate, /Run lanes sequentially when they share one findings file/);
  assert.match(orchestrate, /After every implementation correction, start a fresh review/);
  assert.match(orchestrate, /Continue the review loop until `CLEAN`, a user stop, or a real blocker/);
  assert.match(orchestrate, /Consolidate all lane findings before sending one correction batch/);
  assert.match(orchestrate, /Do not stop after one re-review while findings remain/);
  assert.match(orchestrate, /one active review wave/);
  assert.match(orchestrate, /Pass the implementer's verification status and test paths to reviewers/);
  assert.match(orchestrate, /Do not assign the full test suite or configured verification commands to reviewers/);
  assert.match(orchestrate, /focused probe that can confirm or reject a suspected defect/);
});

test("defines focused review lanes and one review format", async () => {
  const review = await skill("review");
  const orchestrate = await skill("orchestrate");
  const workflow = await skill("workflow");
  const delegation = await reference("workflow", "delegation.md");
  const format = await readFile(new URL("../../skills/review/references/review-format.md", import.meta.url), "utf8");

  assert.match(orchestrate, /Define a review matrix before spawning high-risk lanes/);
  assert.match(orchestrate, /Lane: security/);
  assert.match(orchestrate, /Lane: lifecycle/);
  assert.match(orchestrate, /Lane: integration/);
  assert.match(orchestrate, /Do not send identical review instructions to all lanes/);
  assert.match(orchestrate, /Consolidate duplicate findings and check uncovered coverage/);
  assert.match(delegation, /Focus: <specific risks>/);
  assert.doesNotMatch(workflow, /Review focus: <specific review lens>/);
  assert.doesNotMatch(workflow, /Coverage: <paths or checks>/);
  assert.match(review, /references\/review-format\.md/);
  assert.match(orchestrate, /\[review-format\.md\]\(\.\.\/review\/references\/review-format\.md\) reference/);
  assert.match(review, /When a lane focus is supplied, review it exhaustively/);
  assert.match(review, /Read the completed diff, verification status, test paths, and exact commands/);
  assert.match(review, /Do not rerun the full test suite or configured verification commands/);
  assert.match(review, /Run a focused probe only when it can confirm or reject a suspected defect/);
  assert.match(format, /# Slice review/);
  assert.match(format, /## Findings/);
  assert.match(format, /## Result/);
  assert.match(format, /### F-001: <short finding title>/);
  assert.match(format, /Mode: design-audit \| implementation-review/);
  assert.match(format, /Finding IDs: F-001, F-002/);
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

  assert.match(orchestrate, /\*\*Model policy:\*\* default \(recommended\) or manual/);
  assert.match(orchestrate, /choose whether to apply the default judgement or set models manually before spawning any child/);
  assert.match(orchestrate, /\*\*Planning model:\*\* host default/);
  assert.match(orchestrate, /\*\*Delivery model:\*\* host default/);
  assert.match(orchestrate, /\*\*High-risk review model:\*\* host security model when available/);
  assert.match(orchestrate, /ask for model assignments for planning, delivery, review, and high-risk review/);
  assert.match(orchestrate, /Model role: `planning`/);
  assert.match(orchestrate, /Model role: `delivery`/);
  assert.match(orchestrate, /Model role: `security-review`/);
  assert.match(orchestrate, /Record the selected model role and resolved model/);
  assert.match(orchestrate, /same model role and resolved model/);
  assert.match(orchestrate, /Give it only the request scope, paths, scratch destination, profile, model role, and resolved model/);
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
  assert.match(orchestrate, /Set an observation interval for each child before its first wait/);
  assert.match(orchestrate, /15 minutes as the starting interval for planning, design, and review children/);
  assert.match(orchestrate, /30 minutes as the starting interval for implementation children/);
  assert.match(orchestrate, /Treat the interval as a check-in schedule, not a deadline or execution limit/);
  assert.match(orchestrate, /A wait timeout means only that no final result arrived/);
  assert.match(orchestrate, /up to three 5-minute follow-up intervals/);
  assert.match(orchestrate, /record `unresponsive`, preserve its workspace, and request a user or parent recovery decision/);
  assert.match(orchestrate, /not evidence that the child is stuck/);
  assert.match(orchestrate, /Interrupt only after a positive failure signal, a user request, or an explicit agent blocker/);
  assert.match(orchestrate, /Do not narrate unchanged waits/);
  assert.match(orchestrate, /Resume the same child when possible/);
  assert.match(orchestrate, /start a replacement in the same workspace from current code and recorded recovery state/);
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
  assert.match(visualReview, /Open one Prism artifact viewer session for all recorded design artifacts and diagrams after a clean design audit/);
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
  assert.match(workflowInit, /`auto` \(the default\)/);
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
