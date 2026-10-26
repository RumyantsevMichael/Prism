import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const productiveSkills = [
  "design", "ideate", "implement", "orchestrate", "refactor", "review",
  "workflow-init", "workflow", "write-adr", "write-contracts", "write-feature",
  "write-requirements", "write-step-definitions", "write-user-docs"
];
const coreSkills = ["design", "implement", "orchestrate", "review", "workflow"];

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

test("keeps the core skills lean", async () => {
  let lines = 0;
  for (const name of coreSkills) lines += (await skill(name)).split("\n").length;
  for (const name of ["delegation.md", "visual-review.md"]) lines += (await reference("workflow", name)).split("\n").length;
  lines += (await reference("orchestrate", "example-writer.md")).split("\n").length;
  assert.ok(lines < 500, `the core skills and their references have ${lines} lines`);
});

test("keeps records, snapshots, change maps, and context plans out of the skills", async () => {
  for (const name of productiveSkills) {
    const source = await skill(name);
    for (const retired of [/design-audit/, /change.map/i, /plan_repository_context/, /capture_repository_snapshot/, /compare_change_map/, /Develop <slice>/, /\.prism\/initiatives/, /\.json\b/]) {
      assert.doesNotMatch(source, retired, `${name} mentions ${retired}`);
    }
  }
  await assert.rejects(skill("roadmap"), /ENOENT/);
});

test("design freezes a probed contract and failing acceptance tests, and splits without tests", async () => {
  const design = await skill("design");
  assert.match(design, /Probe it with a small experiment against the real system/);
  assert.match(design, /produces a clear error or a documented observable fallback, never a silent wrong result/);
  assert.match(design, /confirm they build and fail because the behavior is absent/);
  assert.match(design, /recommend `required` when an independent implementation review pays off/);
  assert.match(design, /Write contracts or tests for the children; each child is designed when it is next/);
  assert.match(design, /A frozen test changes only through a revised design/);
  assert.match(design, /## Frozen tests/);
});

test("design lists its expected changes, and a gated design gets examples from a small-model writer", async () => {
  assert.match(await skill("design"), /In \*\*Changes\*\*, list each file you expect to add, change, or remove/);
  const orchestrate = await skill("orchestrate");
  assert.match(orchestrate, /write the design view through the \[example writer\]\(references\/example-writer\.md\)/);
  const writer = await reference("orchestrate", "example-writer.md");
  assert.match(writer, /Call `update_design_view` once with every example/);
  assert.match(writer, /Write anything a test does not assert/);
});

test("implementation works from files against frozen tests and makes no record calls", async () => {
  const implement = await skill("implement");
  assert.match(implement, /makes no Prism record calls/);
  assert.match(implement, /Modify, rename, or delete a frozen test/);
  assert.match(implement, /A contract defect goes back to design/);
  assert.doesNotMatch(implement, /update_|get_initiative|get_review/);
});

test("orchestration designs just in time, gates the design, and completes on verification", async () => {
  const orchestrate = await skill("orchestrate");
  for (const value of ["conservative", "broad", "full", "mono", "multi", "on", "off", "auto", "stepwise", "host defaults"]) {
    assert.match(orchestrate, new RegExp(`\\\`${value}\\\``), value);
  }
  assert.match(orchestrate, /\| `commit` \| `on`, `off` \| `on` under `full`, otherwise `off` \|/);
  assert.match(orchestrate, /\| `push` \| `on`, `off` \| `off` \|/);
  assert.match(orchestrate, /next leaf that is `not-started` and whose effective dependencies are done/);
  assert.match(orchestrate, /`accept_design`, the frozen test paths, and the review mark/);
  assert.match(orchestrate, /call `wait_for_user_gate` with its gate id, then call `verify_slice` again with `approvalGate`/);
  assert.match(orchestrate, /When it returns `running`, call it again/);
  assert.match(orchestrate, /When the design's review mark is `required`, review the slice/);
  assert.match(orchestrate, /`start_wave` operation in `implementation-review` mode/);
  assert.match(orchestrate, /Record every question to the user before asking it/);
  assert.match(orchestrate, /call `checkpoint_pause` with the initiative, the current revision, the active slice/);
  assert.match(orchestrate, /a single `remove_records` operation/);
  assert.match(orchestrate, /`update_roadmap` with a `ship` operation/);
});

test("review is one independent mode that records findings through MCP", async () => {
  const review = await skill("review");
  assert.match(review, /fresh session without the implementers' conversation/);
  assert.match(review, /`open_finding` operation/);
  assert.match(review, /`submit_lane`: `CLEAN` when no finding remains open/);
  assert.match(review, /Change production code, frozen tests, or existing tests/);
});

test("ideation adds the roadmap entry that the removed roadmap skill used to add", async () => {
  const ideate = await skill("ideate");
  assert.match(ideate, /Call `update_roadmap` with an `add_initiative` operation that links the Approved requirements/);
  assert.match(await skill("workflow-init"), /Call `update_roadmap` with `expectedRevision: null`, the accepted operations, and `replace_hand_written_projection`/);
  assert.doesNotMatch(await skill("write-requirements"), /`roadmap`/);
});

test("keeps common terms aligned with the workflow", async () => {
  const workflow = await skill("workflow");
  for (const term of ["Contract", "Assumption probe", "Frozen tests", "Implementation step", "Design gate", "Accepted design", "Verification run", "Implementation review", "Review probe", "Feature file", "Step definition", "Executable contract", "`recovery.md`", "Pause checkpoint"]) {
    assert.ok(workflow.includes(`| ${term} |`), term);
  }
  for (const retired of ["Design audit", "Change map", "Context plan", "Red checkpoint", "Atomic slice", "Resolution exchange", "Review base"]) {
    assert.ok(!workflow.includes(`| ${retired} |`), retired);
  }
});

test("authors Gherkin during design and binds steps during implementation", async () => {
  assert.match(await skill("design"), /use `write-feature` for the slice's scenarios and list them as frozen tests/);
  assert.match(await skill("write-feature"), /Design authors it for a fitted slice/);
  assert.match(await skill("implement"), /use `write-step-definitions` to bind their steps/);
});

test("uses executable contracts only", async () => {
  const contract = (await skill("write-contracts")).replace(/^ +/gm, "");
  assert.match(contract, /Contract: <canonical path>\nConsumers: <[^>]+>\nVerification: <exact command>/);
  assert.match(contract, /contract must have an executable consumer/);
  assert.match(await skill("design"), /use `write-contracts` after reusing governing types or schemas/);
});

test("detects delegation from a callable child-start capability", async () => {
  const delegation = await reference("workflow", "delegation.md");
  assert.match(delegation, /Child-agent capability exists only when a child-start action is callable/);
  assert.match(delegation, /A host action that creates a user-owned task, thread, or chat is not a child agent/);
});

test("keeps visual review selection and procedure in its reference", async () => {
  const visualReview = await reference("workflow", "visual-review.md");
  assert.match(visualReview, /`auto` uses the internal browser on desktop and the system browser in CLI sessions/);
  assert.match(visualReview, /Record the user gate with its artifacts before opening the browser/);
  assert.match(await skill("workflow"), /\[visual-review\.md\]\(references\/visual-review\.md\)/);
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
