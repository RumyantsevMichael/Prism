import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const productiveSkills = [
  "design", "ideate", "implement", "orchestrate", "refactor", "review", "triage",
  "setup", "workflow", "write-adr", "write-contracts", "write-feature",
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
  assert.ok(lines < 512, `the core skills and their references have ${lines} lines`);
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

test("design freezes one probed contract with failing tests and a slice plan, and splits without tests", async () => {
  const design = await skill("design");
  assert.match(design, /Probe it with a small experiment against the real system/);
  assert.match(design, /produces a clear error or a documented observable fallback, never a silent wrong result/);
  assert.match(design, /confirm they build and fail because the behavior is absent/);
  assert.match(design, /Recommend review `required` for a slice when an independent implementation review pays off/);
  assert.match(design, /Give each slice its own new test files, so that each file belongs to exactly one slice/);
  assert.match(design, /## Slices/);
  assert.match(design, /Write contracts or tests for the parts; each part is designed when it is next/);
  assert.match(design, /Return `SPLIT` only with \[split evidence\]/);
  assert.match(design, /`contract_size` with the files that Prism measured/);
  assert.match(design, /call `update_initiative` with one `propose_design` operation for the scope/);
  assert.match(design, /When Prism refuses the proposal, fix the design and propose again/);
  assert.match(design, /A frozen test changes only through a revised design/);
  assert.match(design, /Write PlantUML source only/);
  assert.match(design, /Render a diagram or look at a rendered image/);
});

test("design lists its expected changes, and a gated design gets examples from a small-model writer", async () => {
  assert.match(await skill("design"), /In \*\*Changes\*\*, list each file you expect to add, change, or remove/);
  const orchestrate = await skill("orchestrate");
  assert.match(orchestrate, /write the design view through the \[example writer\]\(references\/example-writer\.md\)/);
  const writer = await reference("orchestrate", "example-writer.md");
  assert.match(writer, /Call `update_design_view` once for the scope with every example/);
  assert.match(writer, /Write anything a test does not assert/);
});

test("implementation works from files against frozen tests and verifies its own slice", async () => {
  const implement = await skill("implement");
  assert.match(implement, /its only Prism calls are `verify_slice` and `wait_for_user_gate`/);
  assert.match(implement, /Modify, rename, or delete a frozen test/);
  assert.match(implement, /call `verify_slice` with `contractDefects`/);
  assert.match(implement, /call `wait_for_user_gate` with its gate id, then call `verify_slice` again with `approvalGate`/);
  assert.match(implement, /When it returns `running`, call it again/);
  assert.match(implement, /A passing run of a slice whose review mark is `none` marks it done/);
  assert.doesNotMatch(implement, /update_|get_initiative|get_review/);
});

test("orchestration designs one contract per scope, starts each slice, and completes on verification", async () => {
  const orchestrate = await skill("orchestrate");
  for (const value of ["conservative", "broad", "full", "on", "off", "auto", "stepwise", "host defaults"]) {
    assert.match(orchestrate, new RegExp(`\\\`${value}\\\``), value);
  }
  assert.match(orchestrate, /\| `commit` \| `on`, `off` \| `on` under `full`, otherwise `off` \|/);
  assert.match(orchestrate, /\| `push` \| `on`, `off` \| `off` \|/);
  assert.match(orchestrate, /next leaf that is `not-started`, has an accepted design, and whose effective dependencies are done/);
  assert.match(orchestrate, /one `accept_proposal` operation for the scope, the slugs whose review mark is `required`/);
  assert.match(orchestrate, /`set_status` `in-progress`, which puts its frozen tests in place/);
  assert.match(orchestrate, /`restore_tests` for the scope/);
  assert.match(orchestrate, /Run git, hash files, or read code while slices run/);
  assert.match(orchestrate, /\| `review` \| `marked`, `recommended`, `all` \| `marked` \|/);
  assert.match(orchestrate, /it verifies the slice through `verify_slice` itself/);
  assert.match(orchestrate, /when its review mark is `required`, review it/);
  assert.match(orchestrate, /When the slice is `blocked` with contract defects/);
  assert.match(orchestrate, /`start_wave` operation in `implementation-review` mode/);
  assert.match(orchestrate, /Record every question to the user before asking it/);
  assert.match(orchestrate, /call `checkpoint_pause` with the initiative, the current revision, the active slice/);
  assert.match(orchestrate, /Keep the slice folders and the initiative's records/);
  assert.doesNotMatch(orchestrate, /remove_records/);
  assert.match(orchestrate, /`update_roadmap` with a `ship` operation/);
  assert.match(orchestrate, /1\. Call `update_initiative` with a `claim` operation for the scope, so no other agent starts it/);
  assert.match(await skill("workflow"), /\| Claim \| .*`slice_claimed`.*`release_claim`/);
});

test("review is one independent mode that records findings through MCP", async () => {
  const review = await skill("review");
  assert.match(review, /fresh session without the implementers' conversation/);
  assert.match(review, /`open_finding` operation/);
  assert.match(review, /`submit_lane`: `CLEAN` when no finding remains open/);
  assert.match(review, /[Cc]hange production code, frozen tests, or existing tests/);
});

test("ideation adds the roadmap entry that the removed roadmap skill used to add", async () => {
  const ideate = await skill("ideate");
  assert.match(ideate, /Call `update_roadmap` with an `add_initiative` operation that cites each Approved requirement section as `<file>.md§<number>`/);
  assert.match(await skill("setup"), /Call `update_roadmap` with `expectedRevision: null`, the accepted operations, and `replace_hand_written_projection`/);
  assert.doesNotMatch(await skill("write-requirements"), /`roadmap`/);
});

test("keeps common terms aligned with the workflow", async () => {
  const workflow = await skill("workflow");
  for (const term of ["Contract", "Assumption probe", "Frozen tests", "Staged tests", "Contract scope", "Slice plan", "Split evidence", "Design proposal", "Design diagrams", "Review mark", "Child status", "Design gate", "Accepted design", "Verification run", "Implementation review", "Review probe", "Feature file", "Step definition", "Executable contract", "`recovery.md`", "Pause checkpoint"]) {
    assert.ok(workflow.includes(`| ${term} |`), term);
  }
  for (const retired of ["Design audit", "Change map", "Context plan", "Red checkpoint", "Atomic slice", "Resolution exchange", "Review base", "Implementation step"]) {
    assert.ok(!workflow.includes(`| ${retired} |`), retired);
  }
});

test("authors Gherkin during design and binds steps during implementation", async () => {
  assert.match(await skill("design"), /use `write-feature` for the scenarios and list them as frozen tests/);
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

test("writes review browser configuration with an adaptive default", async () => {
  const workflowInit = await skill("setup");

  assert.match(workflowInit, /- Review browser: auto/);
  assert.match(workflowInit, /`Review browser` defaults to `auto`/);
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

test("setup interviews the person, owns the configuration, and loads when Prism or the person needs it", async () => {
  const setup = await skill("setup");
  assert.doesNotMatch(setup, /disable-model-invocation/);
  assert.doesNotMatch(await reference("setup", "../agents/openai.yaml"), /allow_implicit_invocation: false/);
  for (const entry of ["**Onboard**", "**Migrate**", "**Amend**"]) assert.ok(setup.includes(entry), entry);
  assert.match(setup, /Ask one topic per round, with each discovered value filled in and a recommended answer/);
  assert.match(setup, /return `BLOCKED` with each open topic as a \[blocker\]/);
  assert.match(setup, /uses `none yet` as its test command, never a no-op command/);
  assert.match(setup, /`set_workspace_name` operation/);
  assert.match(setup, /Repository/);
  const orchestrate = await skill("orchestrate");
  assert.match(orchestrate, /run `setup` in a fresh child agent while no slice is `in-progress`, asking its blockers as gates/);
  assert.match(await skill("design"), /when the test command is `none yet`, put the test runner and the real `Test command` line in the first slice's \*\*Changes\*\*/);
});
