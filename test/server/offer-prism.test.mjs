import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { offerPrism } from "../../dist/hooks/offer-prism.mjs";
import { updateCoordinationState } from "../../dist/server/workflow/state.mjs";

async function folder(context, config = null) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-offer-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  if (config !== null) {
    await mkdir(path.join(root, ".prism"), { recursive: true });
    await writeFile(path.join(root, ".prism/workflow.md"), config);
  }
  return root;
}

const start = (cwd, extra = {}, environment = {}) => offerPrism({ input: Readable.from([JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd, ...extra })]), environment });
const CONFIG = "## Paths\n- Plans: docs/plans/\n\n## Interaction\n- Interaction style: structured\n";

test("a new conversation in a configured project learns to offer orchestration for work that changes documented intent", async (context) => {
  const root = await folder(context, CONFIG);
  const text = (await start(root)).hookSpecificOutput.additionalContext;
  assert.match(text, /Prism is set up in this project/);
  assert.match(text, /requirements, ADRs, or feature files/);
  assert.match(text, /load the prism:orchestrate skill/);
  assert.match(text, /question about the code, a change no requirement or ADR covers/);
  assert.equal((await start(root, { source: "clear" })).hookSpecificOutput.hookEventName, "SessionStart");
});

test("an unconfigured project is offered setup", async (context) => {
  const root = await folder(context);
  assert.match((await start(root)).hookSpecificOutput.additionalContext, /not set up in this project.*load the prism:setup skill/s);
});

test("a resumed conversation, a child agent, an opt-out, and Session offer off get no offer", async (context) => {
  const root = await folder(context, CONFIG);
  for (const source of ["resume", "compact"]) assert.equal(await start(root, { source }), null, source);
  assert.equal(await start(root, { agent_id: "a1" }), null);
  assert.equal(await start(root, { subagent: { depth: 1 } }), null);
  assert.equal(await start(root, {}, { PRISM_SESSION_OFFER: "off" }), null);
  const quiet = await folder(context, `${CONFIG}- Session offer: off\n`);
  assert.equal(await start(quiet), null);
});

test("open questions turn the offer into resuming their initiative", async (context) => {
  const root = await folder(context, CONFIG);
  await mkdir(path.join(root, "docs/plans/reports"), { recursive: true });
  await updateCoordinationState({ projectRoot: root, initiative: "reports", expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "visual-review", question: "Review the design.", artifacts: [] }] } });
  assert.match((await start(root)).hookSpecificOutput.additionalContext, /Questions wait on the person in the Prism initiative reports;.*resume it through prism:orchestrate/s);
});
