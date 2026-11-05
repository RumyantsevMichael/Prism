import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { keepOrchestratorRole } from "../../dist/hooks/keep-orchestrator-role.mjs";

async function dataDirectory(context) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "prism-role-hook-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

function run(environment, payload) {
  return keepOrchestratorRole({ input: Readable.from([JSON.stringify({ session_id: "session-1", ...payload })]), environment });
}

const skillCall = (skill, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill }, ...extra });

test("refuses a child skill in the execution that loaded orchestrate and allows it in a child agent", async (context) => {
  const environment = { CLAUDE_PLUGIN_DATA: await dataDirectory(context) };
  assert.equal(await run(environment, skillCall("prism:design")), null);
  assert.equal(await run(environment, skillCall("prism:orchestrate")), null);
  for (const skill of ["design", "implement", "review", "triage", "ideate"]) {
    const output = await run(environment, skillCall(`prism:${skill}`));
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny", skill);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, new RegExp(`child agent whose prompt asks it to use the prism:${skill} skill`));
  }
  assert.equal(await run(environment, skillCall("prism:design", { agent_id: "a1b2c3" })), null);
  assert.equal(await run(environment, skillCall("prism:write-adr")), null);
  assert.equal(await run(environment, skillCall("design")), null);
  assert.equal(await run(environment, { ...skillCall("prism:design"), session_id: "session-2" }), null);
});

test("tracks a slash invocation, a role switch by the person, and a cleared conversation", async (context) => {
  const environment = { CLAUDE_PLUGIN_DATA: await dataDirectory(context) };
  await run(environment, { hook_event_name: "UserPromptSubmit", prompt: "/prism:orchestrate reports" });
  assert.equal((await run(environment, skillCall("prism:implement"))).hookSpecificOutput.permissionDecision, "deny");
  await run(environment, { hook_event_name: "SessionStart", source: "resume" });
  assert.equal((await run(environment, skillCall("prism:implement"))).hookSpecificOutput.permissionDecision, "deny");
  await run(environment, { hook_event_name: "UserPromptSubmit", prompt: "/prism:design reports" });
  assert.equal(await run(environment, skillCall("prism:implement")), null);
  await run(environment, skillCall("prism:orchestrate"));
  await run(environment, { hook_event_name: "SessionStart", source: "clear" });
  assert.equal(await run(environment, skillCall("prism:implement")), null);
});

test("does nothing without a plugin data directory or a session", async (context) => {
  assert.equal(await run({}, skillCall("prism:orchestrate")), null);
  const environment = { CLAUDE_PLUGIN_DATA: await dataDirectory(context) };
  assert.equal(await keepOrchestratorRole({ input: Readable.from([JSON.stringify(skillCall("prism:orchestrate"))]), environment }), null);
});
