import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function skill(name) {
  return readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
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
  assert.doesNotMatch(design, /focused validation waves/i);
  assert.doesNotMatch(design, /write-handoff/);
});

test("keeps one delivery task through tests and code", async () => {
  const implement = await skill("implement");

  const red = implement.indexOf("## 2. Prove the red checkpoint");
  const code = implement.indexOf("## 3. Implement the slice");
  const durable = implement.indexOf("## 5. Update durable artifacts");
  assert.ok(red >= 0 && red < code && code < durable);
  assert.match(implement, /Do not delegate implementation to a fresh worker/);
  assert.match(implement, /Record only the command, exit status, and expected failure reason/);
  assert.match(implement, /Update feature files from verified behavior after implementation/);
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
  assert.match(workflow, /`orchestrate` marks a slice `in-progress`/);
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
  const audit = await skill("design-audit");
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
  assert.match(audit, /every declared contract has a real consumer/);
  assert.match(review, /canonical path and consumer/);
  assert.match(audit, /canonical path and consumer/);
  assert.match(await skill("workflow"), /not in slice directories/);
});

test("uses the design audit skill instead of the old artifact validator", async () => {
  const audit = await skill("design-audit");

  assert.match(audit, /Do not edit requirements, ADRs, design artifacts, code, or tests/);
  assert.match(audit, /Artifacts: <recorded design artifact and diagram paths>/);
  assert.match(audit, /Return `CLEAN` only when the audit finds no actionable finding/);
  await assert.rejects(skill("write-handoff"), /ENOENT/);
  await assert.rejects(skill("write-build-plan"), /ENOENT/);
  await assert.rejects(skill("validate-artifacts"), /ENOENT/);
});

test("orders design audit before implementation", async () => {
  const orchestrate = await skill("orchestrate");

  const audit = orchestrate.indexOf("### Design audit");
  const implement = orchestrate.indexOf("### Implement");
  assert.ok(audit >= 0 && audit < implement);
  assert.match(orchestrate, /Start a fresh `Audit <slice>` agent with `design-audit`/);
  assert.match(orchestrate, /On `CLEAN`, open one Prism artifact viewer session for all recorded design artifacts/);
  assert.match(orchestrate, /continue to implementation/);
  assert.match(orchestrate, /resume `Develop <slice>` with the complete finding list/);
  assert.match(orchestrate, /After each design correction batch, start one fresh scoped design audit/);
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

  assert.match(review, /Read the completed diff, requirements, tests, feature files, and relevant ADRs/);
  assert.match(review, /Do not inherit the authoring task's conversation/);
  assert.match(review, /Review every applicable requirement, lifecycle path, boundary, and security condition/);
  assert.match(review, /Continue the review until you have exhausted actionable findings/);
  assert.match(review, /Report only actionable findings/);
  assert.match(orchestrate, /Start one child agent named `Develop <slice>`/);
  assert.match(orchestrate, /resume the same `Develop <slice>` agent/);
  assert.match(orchestrate, /Start a fresh `Review <slice>` agent/);
  assert.match(orchestrate, /resume `Develop <slice>` with the complete finding list/);
  assert.match(orchestrate, /After every implementation correction, start a fresh review/);
  assert.match(orchestrate, /Continue the review loop until `CLEAN`, a user stop, or a real blocker/);
  assert.match(orchestrate, /Consolidate all lane findings before sending one correction batch/);
  assert.match(orchestrate, /Do not stop after one re-review while findings remain/);
  assert.match(orchestrate, /one active review wave/);
  assert.match(orchestrate, /Pass the implementer's verification status and test paths to reviewers/);
  assert.match(orchestrate, /Do not assign the full test suite or configured verification commands to reviewers/);
  assert.match(orchestrate, /focused probe that can confirm or reject a suspected defect/);
});

test("defines focused review lanes and compact review output", async () => {
  const review = await skill("review");
  const orchestrate = await skill("orchestrate");
  const workflow = await skill("workflow");
  const output = await readFile(new URL("../../skills/review/references/review-output.md", import.meta.url), "utf8");

  assert.match(orchestrate, /Define a review matrix before spawning high-risk lanes/);
  assert.match(orchestrate, /Lane: security/);
  assert.match(orchestrate, /Lane: lifecycle/);
  assert.match(orchestrate, /Lane: integration/);
  assert.match(orchestrate, /Do not send identical review instructions to all lanes/);
  assert.match(orchestrate, /Consolidate duplicate findings and check uncovered coverage/);
  assert.match(workflow, /Focus: <specific risks>/);
  assert.doesNotMatch(workflow, /Review focus: <specific review lens>/);
  assert.doesNotMatch(workflow, /Coverage: <paths or checks>/);
  assert.match(review, /references\/review-output\.md/);
  assert.match(review, /review the supplied focus exhaustively/);
  assert.match(review, /Inspect the implementer's verification status, test paths, and exact commands/);
  assert.match(review, /Do not rerun the full test suite or configured verification commands/);
  assert.match(review, /Run a focused probe only when it can confirm or reject a suspected defect/);
  assert.match(output, /Lane: lifecycle/);
  assert.match(review, /Use `blocker`, `high`, `medium`, or `low` for severity/);
  assert.match(output, /Severity: high/);
  assert.match(output, /Status: CLEAN/);
});

test("declares model policy and child model roles", async () => {
  const orchestrate = await skill("orchestrate");
  const workflow = await skill("workflow");

  assert.match(orchestrate, /\*\*Model policy:\*\* default \(recommended\) or manual/);
  assert.match(orchestrate, /choose whether to apply the default judgement or set models manually before spawning any child/);
  assert.match(orchestrate, /\*\*Planning model:\*\* host default/);
  assert.match(orchestrate, /\*\*Delivery model:\*\* host default/);
  assert.match(orchestrate, /\*\*Design audit model:\*\* host reviewer model when available/);
  assert.match(orchestrate, /\*\*High-risk review model:\*\* host security model when available/);
  assert.match(orchestrate, /ask for model assignments for planning, delivery, design audit, review, and high-risk review/);
  assert.match(orchestrate, /Model role: `planning`/);
  assert.match(orchestrate, /Model role: `delivery`/);
  assert.match(orchestrate, /Model role: `design-audit`/);
  assert.match(orchestrate, /Model role: `security-review`/);
  assert.match(orchestrate, /Record the selected model role and resolved model/);
  assert.match(orchestrate, /same model role and resolved model/);
  assert.match(orchestrate, /Give it only the request scope, paths, scratch destination, profile, model role, and resolved model/);
  assert.match(workflow, /Model role: <role>/);
  assert.match(workflow, /Model: <resolved model or host default>/);
  assert.match(workflow, /Pass the model role and resolved model through every child start and broker request/);
  assert.match(workflow, /planning \| delivery \| design-audit \| review \| security-review/);
  assert.doesNotMatch(workflow, /run-level model policy|host reviewer model|host security model/);
});

test("detects delegation from a callable child-start capability", async () => {
  const workflow = await skill("workflow");

  assert.match(workflow, /Child-agent capability exists only when a child-start action is callable/);
  assert.match(workflow, /A wait or status action alone is not child-agent capability/);
  assert.match(workflow, /Never wait without at least one active child identifier/);
  assert.match(workflow, /An empty receiver set or empty agent state is a positive routing failure/);
  assert.match(workflow, /return a broker request to the nearest parent with child-agent capability/);
  assert.match(workflow, /Kind: explore \| task \| review/);
  assert.match(workflow, /Do not invoke a Codex, Claude, or other agent CLI to create a child agent/);
});

test("supervises only active child agents", async () => {
  const workflow = await skill("workflow");

  assert.match(workflow, /A wait timeout means only that no final result arrived/);
  assert.match(workflow, /Interrupt only after a positive failure signal, a user request, or an explicit agent blocker/);
  assert.match(workflow, /Do not narrate unchanged waits/);
  assert.match(workflow, /Resume the same agent when possible/);
  assert.match(workflow, /Start a replacement only from recorded recovery state/);
});

test("supports a continuous delivery benchmark phase", async () => {
  const benchHarness = await readFile(new URL("../../bench/harness/bench.py", import.meta.url), "utf8");

  assert.match(benchHarness, /--delivery-context/);
  assert.match(benchHarness, /choices=\["separate", "continuous"\]/);
  assert.match(benchHarness, /CONTINUOUS_DELIVERY_PROMPT/);
  assert.match(benchHarness, /run a fresh `design-audit` pass before implementation/);
  assert.match(benchHarness, /complete findings to the same delivery context/);
  assert.match(benchHarness, /if args\.delivery_context == "continuous"/);
  assert.doesNotMatch(benchHarness, /Produce the full spec: ADR, contracts, a dependency-ordered implementation-task graph/);
});

test("keeps visual review selection and procedure in workflow", async () => {
  const workflow = await skill("workflow");
  const phaseSkills = await Promise.all(["plan", "design", "roadmap"].map(skill));

  assert.match(workflow, /Missing `Review browser` defaults to `auto`/);
  assert.match(workflow, /For `auto`, use the internal browser in desktop sessions and the system browser in CLI sessions/);
  assert.match(workflow, /For `internal`, use the internal browser/);
  assert.match(workflow, /For `external`, use the system browser/);
  assert.match(workflow, /Explicit `internal` and `external` values override `auto`/);
  assert.match(workflow, /Open one Prism artifact viewer session for all recorded design artifacts and diagrams after a clean design audit/);
  assert.match(workflow, /Use the viewer's complete artifact tree instead of opening one viewer session per artifact/);
  assert.match(workflow, /Open one Prism artifact viewer session for all changed artifacts and diagrams before the final correctness gate/);
  assert.match(workflow, /present the URL and source artifacts/);
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
