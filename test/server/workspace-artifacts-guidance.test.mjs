import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// Contract clauses 45 and 46 of the workspace-artifacts design: the workflow skills tell agents how store artifacts are read, written, approved, and shipped, and to choose portable names in every project.
const skill = (name) => readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
const terms = async () => {
  const source = await skill("workflow");
  return source.slice(source.indexOf("## Common terms"));
};

test("clause 45: the workflow skill routes descriptive artifacts of a project with a store through the artifact tools", async () => {
  const source = await skill("workflow");
  assert.match(source, /get_artifact/);
  assert.match(source, /update_artifact/);
  assert.match(source, /store/i);
  assert.match(source, /status line/i, "it leaves status lines to gates");
  for (const term of ["Store artifact", "Artifact scope", "Accepted version", "Approval gate"]) assert.match(await terms(), new RegExp(`\\| ${term} \\|`), `Common terms define ${term}`);
});

test("clause 45: design and implementation read and write their slice files through the artifact tools when a store holds them", async () => {
  assert.match(await skill("design"), /update_artifact/);
  assert.match(await skill("implement"), /get_artifact/);
});

test("clause 45: requirements are approved through an approval gate, and ADRs are accepted when the initiative ships", async () => {
  const requirements = await skill("write-requirements");
  assert.match(requirements, /ask_approval/);
  assert.match(requirements, /wait_for_user_gate/);
  const adr = await skill("write-adr");
  assert.match(adr, /ship/i);
  const orchestrate = await skill("orchestrate");
  assert.match(orchestrate, /afterGate/);
  assert.match(orchestrate, /correctness/);
});

test("clause 45: a project without a store keeps editing its artifacts in the checkout", async () => {
  assert.match(await skill("workflow"), /without a store|no store/i);
});

// The skills that choose new file, folder, or identifier names, each of which refers to the one Portable name term.
const NAMING_SKILLS = ["design", "ideate", "triage", "setup", "implement", "refactor", "write-adr", "write-requirements", "write-feature", "write-contracts", "write-step-definitions", "write-user-docs"];
const portableTerm = async () => (await terms()).split("\n").find((line) => line.startsWith("| Portable name |")) ?? "";

test("clause 46: the workflow skill defines a portable name once, for every project, with the whole rule", async () => {
  const term = await portableTerm();
  assert.ok(term, "Common terms define Portable name");
  for (const [part, label] of [
    [/ASCII letter or digit/i, "the first character"], [/`\.`, `_`, (and )?`-`/, "the allowed characters"], [/`\.lock`/, "the .lock ending"], [/end(s|ing)? in `\.`|`\.` (or `\.lock` )?ending|trailing `\.`/i, "the . ending"],
    [/device name/i, "Windows device names"], [/`con`/, "con"], [/`aux`/, "aux"], [/`nul`/, "nul"], [/`com1`|`com0`/, "com"], [/`lpt1`|`lpt0`/, "lpt"],
    [/letter case/i, "letter case differences"], [/\b100 characters\b/, "the path length"], [/\b40 characters\b/, "the identifier length"], [/with or without a store|every project/i, "every project"]
  ]) assert.match(term, part, `the Portable name term states ${label}`);
});

test("clause 46: every skill that chooses names links the Portable name term instead of restating it", async () => {
  for (const name of NAMING_SKILLS) {
    const source = await skill(name);
    assert.match(source, /\[portable names?\]\(\.\.\/workflow\/SKILL\.md#common-terms\)/i, `${name} links the Portable name term`);
    assert.doesNotMatch(source, /`lpt[0-9]`|`com[0-9]`|device name/i, `${name} does not restate the rule`);
  }
});

test("clause 46: no skill says where or how Prism stores artifacts", async () => {
  const names = (await readdir(new URL("../../skills/", import.meta.url), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const name of names) {
    assert.doesNotMatch(await skill(name), /`artifacts\/|artifacts\/repositories|repositories\/<|core\.longpaths|LOCALAPPDATA|MAX_PATH/, `${name} names no store location`);
  }
});
