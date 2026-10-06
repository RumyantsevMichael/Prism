import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const productiveSkills = [
  "design", "ideate", "implement", "orchestrate", "refactor", "review", "roadmap", "write-map",
  "workflow-init", "workflow", "write-adr", "write-contracts", "write-feature",
  "write-requirements", "write-step-definitions", "write-user-docs"
];

async function skill(name) {
  return readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
}

async function reference(skillName, name) {
  return readFile(new URL(`../../skills/${skillName}/references/${name}`, import.meta.url), "utf8");
}

test("declares the productive skill SDM version", async () => {
  for (const name of productiveSkills) {
    assert.match(await skill(name), /^---\n[\s\S]*?^sdm: "0\.3"$[\s\S]*?^---$/m, name);
  }
});

test("uses code as the implementation specification", async () => {
  const workflow = await skill("workflow");
  const artifacts = await reference("workflow", "artifact-rules.md");
  assert.match(workflow, /Code establishes implemented behavior/);
  assert.match(artifacts, /Review evidence belongs in MCP-managed records/);
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
    "| Agent flow |",
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

test("defines compact autonomy and agent-flow settings", async () => {
  const settings = await reference("orchestrate", "run-settings.md");
  const orchestrate = await skill("orchestrate");

  for (const value of ["conservative", "broad", "full", "mono", "multi", "on", "off", "auto", "stepwise", "defaults", "host defaults"]) {
    assert.match(settings, new RegExp(`\\\`${value}\\\``), value);
  }
  for (const setting of ["autonomy", "agentFlow", "commit", "push", "continuation", "models"]) {
    assert.ok(settings.includes("| `" + setting + "` |"), setting);
  }
  assert.match(settings, /\| `commit` \| `on`, `off` \| `on` under `full`, otherwise `off` \|/);
  assert.match(settings, /\| `push` \|[\s\S]*\| `off` \|/);
  assert.match(settings, /\| `continuation` \|[\s\S]*\| `auto` \|/);
  assert.match(settings, /Explicit `commit`, `continuation`, and `push` values override autonomy defaults/);
  assert.match(settings, /`full` never turns push on by itself/);
  assert.match(settings, /A persisted value remains authoritative/);
  assert.match(settings, /`agentFlow` is fixed after the first active phase or worker starts/);
  assert.match(settings, /Both flows run `ideate` and `roadmap` inline from a raw idea/);
  assert.match(settings, /Both flows use fresh independent `Review <slice>` workers for design and implementation review/);
  assert.match(settings, /`multi` delegates slice delivery.*uses fresh `Review <slice>` workers/);
  assert.match(settings, /write `changes.settings` with `update_coordination_state` and the current revision before active work/);
  assert.match(orchestrate, /Settings resolution supplies `changes.settings`/);
  assert.doesNotMatch(orchestrate, /Decision autonomy: `conservative/);
  assert.doesNotMatch(orchestrate, /Missing `commit` defaults/);
  const phaseFlow = orchestrate.match(/```plantuml\n([\s\S]*?)\n```/)[1];
  assert.match(phaseFlow, /Run ideate and roadmap skills under the autonomy gate/);
  assert.match(phaseFlow, /Design returned SPLIT\?/);
  assert.match(phaseFlow, /Run or resume implement skill in the selected agent flow/);
  assert.match(orchestrate, /configured `agentFlow` controls design and implementation routing/);
  assert.match(settings, /`mono` runs planning, design, implementation, corrections/);
  assert.match(settings, /`multi` delegates slice delivery/);
  assert.match(orchestrate, /The agent flow is immutable after active work starts/);
  assert.match(settings, /If fresh review capability is unavailable, block and ask the user to run a separate review task/);
  assert.match(orchestrate, /Mono delivery records `orchestrator` as the active worker/);
});

test("forms bounded slice architecture before fit and authors artifacts only after fit", async () => {
  const design = await skill("design");
  const form = design.indexOf("## 3. Form the technical design");
  const fit = design.indexOf("## 4. Check whether the scope is atomic");
  const author = design.indexOf("- If the scope is atomic:");
  assert.ok(form >= 0 && form < fit && fit < author);
  assert.match(design, /Check every assigned requirement against planned behavior and observable verification/);
  assert.match(design, /Tests, contracts, scaffolds, and feature files require atomic fit/);
  assert.match(design, /Design does not add production behavior or step definitions, change requirements, or mark findings `VERIFIED`/);
  assert.match(design, /settled architectural decisions as Proposed ADRs, including shared decisions before atomic fit/);
  assert.match(design, /confirming failure at the starting surface because required behavior is absent, not from setup defects/);
  assert.match(design, /red checkpoint's exact command, exit status, and expected failure reason, or the exemption reason/);
  for (const status of ["FIT", "SPLIT", "BLOCKED"]) assert.ok(design.includes("`" + status + "`:"));
  assert.match(design, /When orchestration returns findings, start at section 7 instead of section 1/);
  assert.match(design, /follow section 5's non-atomic branch before returning `SPLIT`/);
  assert.match(design, /slice `review.json` and design-audit lane through MCP/);
});

test("keeps one delivery task through tests and code", async () => {
  const implement = await skill("implement");
  const red = implement.indexOf("## 2. Establish executable acceptance");
  const code = implement.indexOf("## 3. Implement the outcome");
  const verify = implement.indexOf("## 4. Verify and update artifacts");
  assert.ok(red >= 0 && red < code && code < verify);
  assert.match(implement, /owns design, implementation, and corrections unless orchestration replaces it/);
  assert.match(implement, /Reuse the design-created tests and feature files/);
  assert.match(implement, /Weakening or replacing design acceptance requires renewed design and its gates/);
  assert.match(implement, /Replace all shape-only scaffolds with complete behavior before verification/);
  assert.match(implement, /If a review probe exists, run it before correction and preserve its asserted behavior/);
  assert.match(implement, /READY FOR REVIEW.*READY FOR RE-REVIEW.*only when required verification passes/);
  assert.match(implement, /If an unrelated production defect prevents the checkpoint, return the blocker/);
  const capture = implement.indexOf("then capture F and compare B→F through MCP");
  for (const update of ["Remove task-generated temporary files", "Use `write-user-docs`", "Update slice-folder diagram source"]) assert.ok(implement.indexOf(update) >= 0 && implement.indexOf(update) < capture, update);
  assert.ok(capture < implement.indexOf("## 5. Return review evidence"));
  assert.match(implement, /If any target changes afterward, recapture F, compare B→F, and refresh assessments before returning review evidence/);
});

test("authors Gherkin during design and binds steps during implementation", async () => {
  assert.match(await skill("design"), /Use `write-feature` to create or update requirement-linked acceptance scenarios/);
  const feature = await skill("write-feature");
  assert.match(feature, /Design authors it after atomic fit, including when corrections return from implementation or review/);
  assert.match(feature, /This skill creates neither step definitions nor BDD dependencies/);
  assert.match(await skill("implement"), /When features are not specification-only, use `write-step-definitions`/);
  assert.match(await skill("write-step-definitions"), /If features are specification-only, preserve them as acceptance specifications without adding a BDD harness/);
});

test("uses concrete task and exploration terms", async () => {
  assert.match(await skill("design"), /Locate the starting surface where the required behavior enters the system/);
  assert.match(await skill("workflow"), /The command, route, public function, event, job, or user action where a slice enters the system/);
});

test("creates code diagrams during design and verifies structure after code", async () => {
  const design = await skill("design");
  const artifacts = await reference("workflow", "artifact-rules.md");
  assert.match(design, /Read \[C4 code diagrams\]\(references\/c4-code-diagrams\.md\) before writing diagram source/);
  assert.match(design, /Create or update PlantUML source in the current slice folder/);
  assert.match(artifacts, /Keep ADR state and sequence diagrams beside their decision record/);
  assert.match(await skill("implement"), /Update slice-folder diagram source against verified code/);
  assert.match(await reference("design", "c4-code-diagrams.md"), /Each fitted slice requires a C4 code diagram, even when it needs no new ADR/);
});

test("requires prior-art search and a compact worker lifetime reference", async () => {
  const design = await skill("design");
  const implement = await skill("implement");
  const review = await skill("review");
  const orchestrate = await skill("orchestrate");
  const lifetime = await reference("orchestrate", "worker-lifetime.md");
  const refactor = await skill("refactor");

  for (const source of [design, implement]) {
    assert.match(source, /[Uu]se `refactor`.*analysis/);
  }
  assert.match(refactor, /Prism repository intelligence for semantic discovery/);
  assert.match(refactor, /Record relevant matches and the reason to reuse or reject them/);
  assert.match(refactor, /semantic indexing is unavailable or incomplete.*available structural and text evidence/);
  assert.match(design, /semantic reuse procedure.*before accepting an `ADD` transition/);
  assert.match(review, /new component, dependency, or design approach has a recorded search for existing solutions/);
  assert.match(orchestrate, /worker-lifetime\.md/);
  assert.match(lifetime, /worker wait timeout or missing completion event as non-terminal/);
  assert.match(lifetime, /preserving partial evidence/);
  assert.match(lifetime, /resume the same worker before replacement/);
  assert.match(lifetime, /replace it only after explicit completion, failure, blocker, or confirmed host termination/);
  assert.match(orchestrate, /Don't\n  - Create user-owned tasks as child-agent substitutes/);
  assert.match(review, /Don't\n        - Change existing tests, fixtures, helpers, dependencies, or harness configuration/);
});

test("uses repository context consumption for fit and implementation discovery", async () => {
  const design = await skill("design");
  const implement = await skill("implement");
  const workflow = await skill("workflow");
  const planning = await reference("design", "context-planning.md");

  assert.match(design, /Read \[repository context planning\]\(references\/context-planning\.md\)/);
  assert.match(design, /generate a context plan from the outcome and discovered hints before the fit decision/);
  assert.match(design, /Apply the context-plan budget policy when session-capacity resolution is supported and every target-session cost is known/);
  assert.match(implement, /refresh the context plan at the current commit and read its `mustRead` items before the first production edit/);
  assert.match(workflow, /\| Context plan \|/);
  assert.match(workflow, /\| Repository read budget \|/);
  assert.match(planning, /compactionThreshold/);
  assert.match(planning, /if upper <= repositoryReadBudget/);
  assert.match(planning, /else if lower > repositoryReadBudget/);
  assert.match(planning, /`UNCERTAIN` requires more evidence or a safer split/);
  assert.match(planning, /Use `evaluate_repository_fit`/);
  assert.match(planning, /For a fresh worker, it includes the worker's startup context/);
  assert.match(planning, /For a resumed worker, it includes the context retained at the fit checkpoint/);
  assert.match(planning, /Do not use file count, changed-file count, raw bytes, or unmerged source ranges as a substitute/);
});

test("keeps workflow persistence minimal and stages runbook drafts in slices", async () => {
  const artifacts = await reference("workflow", "artifact-rules.md");
  const design = await skill("design");
  const implement = await skill("implement");
  const docs = await skill("write-user-docs");

  assert.match(artifacts, /Workflow results stay in the agent response unless a later context needs them/);
  assert.match(artifacts, /Use `state\.json` for current coordination facts and evidence paths, not copied reports/);
  assert.match(artifacts, /Existing artifacts replace standalone exploration or verification reports when they preserve the required facts/);
  assert.match(artifacts, /store `runbook-draft\.md` in the slice folder/);
  assert.match(artifacts, /Move verified necessary content to the configured user-guide directory through `write-user-docs`/);
  assert.match(design, /create or update `<configured plans>\/<initiative>\/<slice>\/runbook-draft\.md`/);
  assert.match(design, /Don't\n  - Create a separate exploration or verification report when existing artifacts preserve the required facts/);
  assert.match(implement, /move verified necessary content from the slice's `runbook-draft\.md`/);
  assert.match(implement, /Don't\n  - Create a separate verification report when existing tests, probes, findings, runbooks, and result evidence preserve the required facts/);
  assert.match(docs, /Use the slice's `runbook-draft\.md` as draft input when it exists and move only its verified necessary content/);
});

test("uses executable contracts only", async () => {
  const contract = await skill("write-contracts");
  const review = await skill("review");
  for (const source of [contract, review].map(text => text.replace(/^ +/gm, ""))) {
    assert.match(source, /Contract: <canonical path>\nConsumers: <[^>]+>\nVerification: <exact command>/);
    assert.match(source, /Contract: NO CONTRACT NEEDED\nReason: <specific reason>/);
  }
  assert.match(contract, /Final contracts do not belong in slice folders/);
  assert.match(contract, /Production behavior must not be added merely to create a contract/);
  assert.match(contract, /contract must have an executable consumer/);
  assert.match(await skill("design"), /reusing governing types or schemas before invoking `write-contracts`/);
  assert.match(await skill("implement"), /Follow each design contract decision, binding canonical contracts to their consumers/);
});

test("uses one review skill for both review modes", async () => {
  const review = await skill("review");
  for (const mode of ["design-audit", "implementation-review"]) assert.ok(review.includes("- For `" + mode + "`:"));
  assert.match(review, /Each reviewer changes only its assigned lanes through `update_review`, except permitted implementation review probes/);
  assert.match(review, /Add one minimal regression probe in the canonical test location through a public or system surface/);
  assert.match(review, /Don't\n\s+- Change existing tests, fixtures, helpers, dependencies, or harness configuration/);
  assert.match(review, /Only `VERIFIED` findings are resolved/);
  assert.match(review, /retain `FIXED` and report the missing evidence/);
  assert.match(review, /Implementation review does not rerun the full suite or configured verification commands/);
  await assert.rejects(skill("validate-artifacts"), /ENOENT/);
});

test("keeps findings authoritative per review lane", async () => {
  const format = await reference("review", "review-format.md");
  assert.match(format, /One slice `review.json` is authoritative for all its lanes and waves/);
  assert.doesNotMatch(format, /Canonical findings/);
  const reviewRules = await reference("orchestrate", "review-rules.md");
  assert.match(reviewRules, /pinned required lane set/);
  assert.match(reviewRules, /Every assigned lane needs a current result/);
  assert.match(reviewRules, /original `Develop <slice>` and `Review <slice>` workers stay available/);
  assert.match(reviewRules, /direct correction exchange/);
  assert.match(reviewRules, /Each worker receives the other worker ID/);
  assert.match(reviewRules, /retain its reporting lane and route correction without transferring its identity or evidence/);
  assert.match(await skill("workflow"), /\| `review.json` \| The authoritative MCP-managed slice review/);
});

test("detects delegation from a callable child-start capability", async () => {
  const delegation = await reference("workflow", "delegation.md");

  assert.match(delegation, /Child-agent capability exists only when a child-start action is callable/);
  assert.match(delegation, /A wait or status action alone is not child-agent capability/);
  assert.match(delegation, /return a broker request to the nearest parent with child-agent capability/);
  assert.match(delegation, /use the host child-agent message action for live questions and candidate resolutions/);
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

  assert.match(workflowInit, /- Review browser: auto/);
  assert.match(workflowInit, /`Review browser` defaults to `auto`/);
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


test("keeps coordination state concise without an inline schema example", async () => {
  const orchestrate = await skill("orchestrate");
  assert.doesNotMatch(orchestrate, /```json/);
  assert.match(orchestrate, /The `get_coordination_state` input includes the initiative path/);
  await assert.rejects(reference("orchestrate", "state-schema.md"), /ENOENT/);
  for (const name of ["orchestrate", "design", "implement", "review", "write-map"]) {
    assert.doesNotMatch(await skill(name), /worker-protocol\.md|baseRevision|preconditions|correction digest/);
  }
});

test("places process order in diagrams and pause inputs in prose", async () => {
  const orchestrate = await skill("orchestrate");
  const phaseFlow = orchestrate.match(/```plantuml\n([\s\S]*?)\n```/)[1];
  const pauseFlow = await reference("orchestrate", "pause-flow.puml");

  assert.match(phaseFlow, /Call get_coordination_state tool/);
  assert.match(orchestrate, /The `update_coordination_state` input includes the current revision/);
  assert.match(phaseFlow, /Leaf done and continuation is stepwise\?/);
  assert.match(pauseFlow, /Slice absent from active state\?/);
  assert.match(pauseFlow, /Other coordination-state tools available\?/);
  assert.match(orchestrate, /The `checkpoint_pause` input includes the current revision/);
  assert.doesNotMatch(orchestrate, /## Continuity and pause[\s\S]*\n1\./);
});

test("uses the validated coordination state tools", async () => {
  const workflow = await skill("workflow");
  const artifacts = await reference("workflow", "artifact-rules.md");
  const orchestrate = await skill("orchestrate");
  assert.doesNotMatch(workflow, /\| Coordination-state capability \|/);
  assert.match(artifacts, /Call `get_coordination_state` to read `state\.json` and its revision/);
  assert.match(artifacts, /Call `update_coordination_state` with that revision/);
  assert.match(orchestrate, /The `get_coordination_state` input includes the initiative path/);
  assert.match(orchestrate, /Typed `activeOperations` use `start`, `update`, `finish`, and `release`/);
  assert.match(orchestrate, /only `finish` claims completion after the server checks current review evidence/);
  assert.doesNotMatch(orchestrate, /Direct file editing is an emergency recovery action/);
});

test("preserves recursive design ownership and delivery gates", async () => {
  const orchestrate = await skill("orchestrate");
  const phaseFlow = orchestrate.match(/```plantuml\n([\s\S]*?)\n```/)[1];
  const deliveryRules = await reference("orchestrate", "delivery-rules.md");
  const completionRules = await reference("orchestrate", "completion-rules.md");
  const design = await skill("design");
  const settings = await reference("orchestrate", "run-settings.md");
  assert.match(phaseFlow, /while \(An unfinished leaf can progress\?\)/);
  assert.match(design, /child requirement references collectively equal the parent assignment, allowing shared references/);
  assert.match(design, /orchestrator manages parent relationships and dependencies/);
  const shape = design.match(/```markdown\n([\s\S]*?)\n\s*```/)[1];
  assert.deepEqual([...shape.matchAll(/^\s*## (.+)$/gm)].map(m => m[1]), ["Outcome", "Requirements"]);
  assert.match(orchestrate, /The design worker receives ancestor diagram and ADR paths, including inherited paths/);
  assert.match(deliveryRules, /Effective dependencies include inherited prerequisites/);
  assert.match(settings, /After required verification and fresh review, `conservative` asks for correctness confirmation/);
  assert.match(phaseFlow, /Fit or design changed\?/);
  assert.match(phaseFlow, /Run independent design audit and corrections[\s\S]*All design audit lanes CLEAN\?[\s\S]*Apply the implementation gate[\s\S]*Run or resume implement skill/);
  assert.match(completionRules, /without reactivating the parent/);
  assert.ok(completionRules.indexOf("Aggregate completion remains blocked") < completionRules.indexOf("correctness confirmation"));
});

test("keeps review independent and preserves corrections through integration", async () => {
  const orchestrate = await skill("orchestrate");
  const reviewRules = await reference("orchestrate", "review-rules.md");
  const deliveryRules = await reference("orchestrate", "delivery-rules.md");
  const completionRules = await reference("orchestrate", "completion-rules.md");
  const review = await skill("review");
  assert.match(orchestrate, /\[review and correction rules\]\(references\/review-rules\.md\)/);
  assert.match(reviewRules, /The delivery conversation is excluded from reviewer inputs/);
  assert.match(review, /In `multi` flow, the `Review <slice>` worker remains available after returning findings and enters a \[resolution exchange\]/);
  assert.match(review, /Use the host child-agent message action/);
  assert.match(await reference("orchestrate", "worker-lifetime.md"), /A phase result such as `FIT` or `FINDINGS` is a handoff, not a close condition/);
  assert.match(await reference("orchestrate", "worker-lifetime.md"), /resume both as live workers before messaging/);
  assert.match(deliveryRules, /Every implementation correction review compares B→F/);
  assert.match(review, /Route implementation-only gaps to delivery without opening design findings/);
  assert.match(completionRules, /Changed reviewed behavior or uncertain equivalence requires affected review before confirmation/);
  assert.match(completionRules, /If confirmed behavior changes, repeat affected verification, review, and confirmation/);
  assert.match(completionRules, /Coordination cleanup follows durable graduation and the `shipped` transition/);
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
