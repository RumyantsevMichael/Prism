import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Contract clause 45 of the workspace-artifacts design: the workflow skills tell agents how store artifacts are read, written, approved, and shipped.
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
