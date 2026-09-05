import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const productiveSkills = [
  "design", "ideate", "implement", "orchestrate", "review", "roadmap", "write-map",
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
  assert.match(design, /Before the fit checkpoint, new slice-scoped artifacts remain in the working design and are not written/);
  assert.match(design, /These artifacts include ADRs, feature files, executable tests, contracts, diagrams, and scaffolds/);
  assert.match(design, /Return `SPLIT` or `BLOCKED` without authoring slice-scoped artifacts/);
  assert.match(design, /Confirm that every consequential decision is settled/);
  assert.match(design, /No consequential architectural decision remains unresolved/);
  assert.match(design, /For each boundary needing a new executable contract, use `write-contracts`/);
  assert.match(design, /Create or update the smallest executable slice test through the selected starting surface/);
  assert.match(design, /Create or update the slice Gherkin feature file through `write-feature`/);
  assert.match(design, /Run each design-created executable slice test before implementation/);
  assert.match(design, /Record the exact command and expected failure reason for each red checkpoint/);
  assert.match(design, /When the selected starting surface does not exist, create only a shape-only scaffold/);
  assertProhibited(design, "Add production behavior during design.");
  assertProhibited(design, "Add a concrete stub that makes the design test pass.");
  assertProhibited(design, "Create step definitions during design.");
  assertProhibited(design, "Create a prose design summary, slice-named design file, task graph, or handoff.");
  assertProhibited(design, "Scan the repository or read complete directories for general understanding.");
  assert.match(design, /Stop after identifying the changed components, affected boundaries, test location, and end-to-end verification command/);
  assertProhibited(design, "Edit `state.json` or `map.puml`.");
  assert.match(design, /The design context owns the fit judgment and child proposal/);
  assert.match(design, /The orchestrator owns acceptance, lifecycle changes, and the transition to implementation/);
  assertProhibited(design, "Edit a requirement or invoke `write-requirements` without explicit user approval.");
  assert.match(design, /Feature files: <canonical feature paths or NONE>/);
  assert.match(design, /Run the author preflight/);
  assert.match(design, /Trace every Approved requirement to a planned behavior, affected boundary, feature scenario, executable test, and verification command/);
  assert.match(design, /Findings: <slice findings path>/);
  assert.match(design, /After context compaction or replacement, re-read the requirements, ADRs, executable tests, contracts, and findings/);
  assert.ok(design.indexOf("Create or update the smallest executable slice test through the selected starting surface") > author);
  assert.ok(design.indexOf("Create or update the slice Gherkin feature file through `write-feature`") > author);
  assert.ok(design.indexOf("When the selected starting surface does not exist, create only a shape-only scaffold") > author);
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

test("uses concrete task and exploration terms", async () => {
  const names = ["workflow", "write-map", "design", "implement", "review", "write-feature"];
  const combined = (await Promise.all(names.map(skill))).join("\n");

  assert.doesNotMatch(combined, /capability agent|delivery agent|Host capabilities/);
  assert.doesNotMatch(combined, /dominant execution path|coherent contract surface|Approved obligation/);
  assert.match(await skill("write-map"), /Preserve the exact accepted topology, title, requirement assignment, and structural status/);
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

test("detects delegation from a callable child-start capability", async () => {
  const delegation = await reference("workflow", "delegation.md");

  assert.match(delegation, /Child-agent capability exists only when a child-start action is callable/);
  assert.match(delegation, /A wait or status action alone is not child-agent capability/);
  assert.match(delegation, /return a broker request to the nearest parent with child-agent capability/);
  assert.match(delegation, /Kind: explore \| task \| review/);
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
  const phaseSkills = await Promise.all(["write-map", "design", "roadmap"].map(skill));

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


test("keeps the resume note readable without a separate state protocol", async () => {
  const orchestrate = await skill("orchestrate");
  const note = JSON.parse(orchestrate.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.deepEqual(Object.keys(note), ["settings", "active", "pending", "next", "evidence"]);
  assert.equal(note.active[0].slice, "download");
  for (const key of ["pending", "next", "evidence"]) assert.ok(note[key].every((value) => typeof value === "string"));
  await assert.rejects(reference("orchestrate", "state-schema.md"), /ENOENT/);
  for (const name of ["orchestrate", "design", "implement", "review", "write-map"]) {
    assert.doesNotMatch(await skill(name), /worker-protocol\.md|baseRevision|preconditions|correction digest/);
  }
});

test("preserves recursive design ownership and delivery gates", async () => {
  const orchestrate = await skill("orchestrate");
  const design = await skill("design");
  assert.match(orchestrate, /Repeat design for each new child until the leaves fit/);
  assert.match(design, /Assign every parent requirement to at least one child without adding requirements outside the parent assignment/);
  assert.match(orchestrate, /dependencies, including inherited dependencies, to complete before implementation/);
  assert.match(orchestrate, /If design changes, repeat its audit and implementation gate/);
  assert.match(orchestrate, /Both modes require user correctness confirmation/);
  assert.match(orchestrate, /assign existing code, artifacts, and unresolved findings to children/);
});

test("keeps review independent and preserves corrections through integration", async () => {
  const orchestrate = await skill("orchestrate");
  const review = await skill("review");
  assert.match(orchestrate, /Keep reviewers independent of the delivery conversation/);
  assert.match(orchestrate, /one writer per lane file/);
  assert.match(orchestrate, /Preserve finding identities, correction evidence, and history/);
  assert.match(review, /Read canonical correction evidence before checking earlier findings/);
  assert.match(orchestrate, /If integration changes reviewed behavior or leaves uncertainty, repeat affected design or implementation review/);
  assert.match(orchestrate, /If the result changes after confirmation, repeat affected verification, review, and confirmation/);
});

test("all local skill and README links resolve", async () => {
  const { readdir, stat } = await import("node:fs/promises");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  async function markdown(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const groups = await Promise.all(entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? markdown(path) : entry.name.endsWith(".md") ? [path] : [];
    }));
    return groups.flat();
  }
  for (const path of [resolve(root, "README.md"), ...await markdown(resolve(root, "skills"))]) {
    const source = (await readFile(path, "utf8")).replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok((await stat(resolve(dirname(path), target))).isFile(), path + ": " + target);
    }
  }
});
