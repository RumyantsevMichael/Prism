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
  const contracts = await skill("write-contracts");

  assert.match(contracts, /Create a contract only when code or verification consumes it/);
  assert.match(contracts, /OpenAPI|JSON Schema/);
  assert.match(contracts, /importable interface/);
  assert.match(contracts, /compatibility test/);
  assert.match(contracts, /Do not create a prose contract/);
  assert.doesNotMatch(contracts, /plans directory/);
});

test("removes handoff and build-plan production skills", async () => {
  await assert.rejects(skill("write-handoff"), /ENOENT/);
  await assert.rejects(skill("write-build-plan"), /ENOENT/);
  await assert.rejects(skill("validate-artifacts"), /ENOENT/);
});

test("reviews completed code in a fresh context", async () => {
  const review = await skill("review");
  const orchestrate = await skill("orchestrate");

  assert.match(review, /Read the completed diff, requirements, tests, feature files, and relevant ADRs/);
  assert.match(review, /Do not inherit the authoring task's conversation/);
  assert.match(review, /Report only actionable findings/);
  assert.match(orchestrate, /Start one child agent named `Develop <slice>`/);
  assert.match(orchestrate, /resume the same `Develop <slice>` agent/);
  assert.match(orchestrate, /Start a fresh `Review <slice>` agent/);
  assert.match(orchestrate, /resume `Develop <slice>` with the complete finding list/);
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
  assert.match(benchHarness, /if args\.delivery_context == "continuous"/);
  assert.doesNotMatch(benchHarness, /Produce the full spec: ADR, contracts, a dependency-ordered implementation-task graph/);
});

test("keeps visual review selection and procedure in workflow", async () => {
  const workflow = await skill("workflow");
  const phaseSkills = await Promise.all(["plan", "design", "roadmap"].map(skill));

  assert.match(workflow, /Missing `Review browser` defaults to `internal`/);
  assert.match(workflow, /For `internal`, request the review URL and open it through the host internal browser/);
  assert.match(workflow, /For `external`, use `present_review` to open the system browser/);
  assert.match(workflow, /If the host lacks an internal browser, present the URL and source artifacts/);
  assert.doesNotMatch(phaseSkills.join("\n"), /present_review/);
});

test("writes review browser configuration with an internal default", async () => {
  const workflowInit = await skill("workflow-init");
  const benchHarness = await readFile(new URL("../../bench/harness/bench.py", import.meta.url), "utf8");

  assert.match(workflowInit, /- Review browser: internal \| external/);
  assert.match(workflowInit, /`internal` \(the default\)/);
  assert.match(benchHarness, /- Review browser: internal/);
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
