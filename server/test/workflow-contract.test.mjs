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

test("declares the productive skill SDM version", async () => {
  for (const name of productiveSkills) {
    assert.match(await skill(name), /^---\n[\s\S]*?^sdm: "0\.3"$[\s\S]*?^---$/m, name);
  }
});

test("uses code as the implementation specification", async () => {
  const workflow = await skill("workflow");
  const artifacts = await reference("workflow", "artifact-rules.md");
  assert.match(workflow, /Code establishes implemented behavior/);
  assert.match(artifacts, /no implementation handoff, mandatory build plan, or execution ledger/);
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
  assert.match(design, /design-audit\/findings\.md/);
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

test("requires prior-art search and non-terminal worker timeouts", async () => {
  const design = await skill("design");
  const implement = await skill("implement");
  const review = await skill("review");
  const orchestrate = await skill("orchestrate");

  for (const source of [design, implement]) {
    assert.match(source, /Search the repository, active artifacts, approved dependencies, and available semantic exploration tools/);
    assert.match(source, /record relevant matches and the reason to reuse or reject them/);
    assert.match(source, /use it before text search for relevant symbols and call paths/);
  }
  assert.match(review, /new component, dependency, or design approach has a recorded search for existing solutions/);
  assert.match(orchestrate, /first timeout from an explore or review worker as non-terminal/);
  assert.match(orchestrate, /resume that worker with a larger allowance before creating a replacement/);
  assert.match(orchestrate, /Replace a worker only after explicit completion, failure, blocker, or confirmed host termination/);
  assert.match(orchestrate, /Don't\n  - Create user-owned tasks as child-agent substitutes/);
  assert.match(review, /Don't\n        - Change existing tests, fixtures, helpers, dependencies, or harness configuration/);
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
  assert.match(review, /Each review writes only its assigned lane findings file, except permitted implementation review probes/);
  assert.match(review, /Add one minimal regression probe in the canonical test location through a public or system surface/);
  assert.match(review, /Don't\n\s+- Change existing tests, fixtures, helpers, dependencies, or harness configuration/);
  assert.match(review, /Only `VERIFIED` findings are resolved/);
  assert.match(review, /retain `FIXED` and report the missing evidence/);
  assert.match(review, /Implementation review does not rerun the full suite or configured verification commands/);
  await assert.rejects(skill("validate-artifacts"), /ENOENT/);
});

test("keeps findings authoritative per review lane", async () => {
  const format = await reference("review", "review-format.md");
  assert.match(format, /Findings: docs\/plans\/\<initiative>\/\<slice>\/\<lane>\/findings\.md/);
  assert.doesNotMatch(format, /Canonical findings/);
  const orchestrate = await skill("orchestrate");
  assert.match(orchestrate, /one writer per findings file/);
  assert.match(orchestrate, /Wait for every assigned lane to return its current result/);
  assert.match(orchestrate, /retain its reporting lane and route correction without transferring its identity or evidence/);
  assert.match(await skill("workflow"), /\| `findings\.md` \| The authoritative review record for one reporting slice and review lane/);
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

test("orders continuity actions as a process", async () => {
  const orchestrate = await skill("orchestrate");
  const continuity = orchestrate.slice(orchestrate.indexOf("## 6. Preserve continuity"));

  assert.match(continuity, /\n1\. After meaningful results or before a pause/);
  assert.match(continuity, /\n12\. If fresh review is unavailable/);
  assert.doesNotMatch(continuity, /\n- After meaningful results or before a pause/);
});

test("preserves recursive design ownership and delivery gates", async () => {
  const orchestrate = await skill("orchestrate");
  const design = await skill("design");
  assert.match(orchestrate, /Repeat this section for the new leaves/);
  assert.match(design, /child requirement references collectively equal the parent assignment, allowing shared references/);
  assert.match(design, /orchestrator manages parent relationships and dependencies/);
  const shape = design.match(/```markdown\n([\s\S]*?)\n\s*```/)[1];
  assert.deepEqual([...shape.matchAll(/^\s*## (.+)$/gm)].map(m => m[1]), ["Outcome", "Requirements"]);
  assert.match(orchestrate, /Collect all ancestor diagram and ADR paths.*including inherited paths/);
  assert.match(orchestrate, /Wait for effective dependencies to complete, including inherited prerequisites/);
  assert.match(orchestrate, /Both autonomy modes require user correctness confirmation/);
  assert.match(orchestrate, /If fit or design changed, return to section 2 before implementation/);
  assert.match(orchestrate, /without reactivating the parent/);
  assert.ok(orchestrate.indexOf("Keep aggregate completion blocked") < orchestrate.indexOf("Present verification, review results"));
});

test("keeps review independent and preserves corrections through integration", async () => {
  const orchestrate = await skill("orchestrate");
  const review = await skill("review");
  assert.match(orchestrate, /Exclude the delivery conversation from reviewer inputs/);
  assert.match(orchestrate, /Every implementation correction review uses that same base/);
  assert.match(review, /Route implementation-only gaps to delivery without opening design findings/);
  assert.match(orchestrate, /If integration changes reviewed behavior or leaves uncertain equivalence, repeat affected review before confirmation/);
  assert.match(orchestrate, /If confirmed behavior changes, repeat affected verification, review, and confirmation/);
  assert.match(orchestrate, /Coordination cleanup follows durable graduation and the `shipped` transition/);
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
