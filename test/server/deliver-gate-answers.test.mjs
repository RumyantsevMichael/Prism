import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { deliverGateAnswers } from "../../dist/hooks/deliver-gate-answers.mjs";
import { answerUserGate, readCoordinationState, updateCoordinationState } from "../../dist/server/workflow/state.mjs";

const HOOK = new URL("../../dist/hooks/deliver-gate-answers.mjs", import.meta.url).pathname;

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-gate-hook-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans (scratch): docs/plans/\n");
  await mkdir(path.join(root, "docs/plans/reports"), { recursive: true });
  const initiative = "reports";
  const created = await updateCoordinationState({ projectRoot: root, initiative, expectedRevision: null, changes: { gateOperations: [
    { op: "ask", kind: "decision", slice: "authorize", question: "Fresh login or active session?", context: "The run reached a choice that needs the person, for example which behavior to keep.", artifacts: [], options: [{ id: "fresh-login", label: "Require a fresh login", consequence: "The run continues with this choice." }, { id: "session", label: "Accept the active session", consequence: "The run continues with this choice." }], recommended: { option: "fresh-login", reason: "It keeps the current behavior." } },
    { op: "ask", kind: "visual-review", question: "Review the design.", artifacts: [] }
  ] } });
  return { root, initiative, gates: created.openedGates.map((gate) => gate.id) };
}

function runHook(payload) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK], (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(JSON.stringify(payload));
  });
}

const prompt = (cwd) => Readable.from([JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd, prompt: "go" })]);

test("delivers browser answers with the next prompt until the agent resolves them", async (context) => {
  const { root, initiative, gates } = await project(context);
  assert.equal(await deliverGateAnswers({ input: prompt(root), environment: {} }), null);
  await answerUserGate({ projectRoot: root, initiative, id: gates[0], choice: "fresh-login", note: "Downloads are sensitive." });
  const output = await deliverGateAnswers({ input: prompt(root), environment: {} });
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const text = output.hookSpecificOutput.additionalContext;
  assert.match(text, /answered these Prism user gates in the review browser/);
  assert.match(text, new RegExp(`Gate ${gates[0]} \\(decision, initiative reports, slice authorize\\): "Fresh login or active session\\?" Answer: Require a fresh login\\. Note: Downloads are sensitive\\.`));
  assert.doesNotMatch(text, new RegExp(gates[1]));
  assert.match(await runHook({ hook_event_name: "UserPromptSubmit", cwd: root }), /"additionalContext":"The user answered/);
  const { revision } = await readCoordinationState({ projectRoot: root, initiative });
  const current = await updateCoordinationState({ projectRoot: root, initiative, expectedRevision: revision, changes: { gateOperations: [{ op: "resolve", id: gates[0] }] } });
  assert.equal(current.state.pending.length, 1);
  assert.equal(await deliverGateAnswers({ input: prompt(root), environment: {} }), null);
  assert.equal(await runHook({ hook_event_name: "UserPromptSubmit", cwd: root }), "");
});

const start = (cwd, source) => Readable.from([JSON.stringify({ hook_event_name: "SessionStart", source, cwd })]);

test("a resumed session learns its open gates, waits on the unanswered ones, and acts on the answered ones", async (context) => {
  const { root, initiative, gates } = await project(context);
  assert.equal(await deliverGateAnswers({ input: start(root, "startup"), environment: {} }), null, "a new session did not open the project's gates");
  assert.equal(await deliverGateAnswers({ input: start(root, "compact"), environment: {} }), null, "compaction keeps a running wait");
  await answerUserGate({ projectRoot: root, initiative, id: gates[0], choice: "session" });
  const output = await deliverGateAnswers({ input: start(root, "resume"), environment: {} });
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  const text = output.hookSpecificOutput.additionalContext;
  assert.match(text, /call wait_for_user_gate with its id/);
  assert.match(text, new RegExp(`Gate ${gates[1]} \\(visual-review, initiative reports\\): "Review the design\\."\n`));
  assert.match(text, new RegExp(`Gate ${gates[0]} .*Answer: Accept the active session\\.`));
  assert.ok(text.indexOf(gates[1]) < text.indexOf("already answered"), "waiting gates and answered gates are listed apart");
  assert.match(await runHook({ hook_event_name: "SessionStart", source: "resume", cwd: root }), /"hookEventName":"SessionStart"/);
  const { revision } = await readCoordinationState({ projectRoot: root, initiative });
  await updateCoordinationState({ projectRoot: root, initiative, expectedRevision: revision, changes: { gateOperations: gates.map((id) => ({ op: "resolve", id, reason: "Handled." })) } });
  assert.equal(await deliverGateAnswers({ input: start(root, "resume"), environment: {} }), null, "no open gate, no context");
});

test("stays silent outside a Prism project", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-gate-hook-empty-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await deliverGateAnswers({ input: prompt(root), environment: {} }), null);
});
