import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function skill(name) {
  return readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
}

test("design and review skills record diagram readability and review outcomes", async () => {
  const design = await skill("design");
  const review = await skill("review");
  assert.match(design, /readability at normal review width/);
  assert.match(design, /If the diagram is unreadable, assess a split/);
  assert.match(design, /decision capability/);
  assert.match(review, /unreadable diagram lacks a split assessment/);
  assert.match(review, /submit review phase, status/);
});

test("orchestration requires the pause checkpoint before state changes", async () => {
  const orchestrate = await skill("orchestrate");
  const pauseFlow = await readFile(new URL("../../skills/orchestrate/references/pause-flow.puml", import.meta.url), "utf8");
  assert.match(pauseFlow, /Call get_coordination_state tool[\s\S]*Call checkpoint_pause tool/);
  assert.match(pauseFlow, /Write recovery before calling update_coordination_state/);
  assert.match(pauseFlow, /Recovery and state update succeeded\?/);
  assert.match(orchestrate, /The `checkpoint_pause` input includes the current revision/);
  assert.match(orchestrate, /inactive parent slice is historical evidence/);
});
