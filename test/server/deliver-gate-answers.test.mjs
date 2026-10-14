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
  const statePath = "docs/plans/reports/state.json";
  const created = await updateCoordinationState({ projectRoot: root, statePath, expectedRevision: null, changes: { gateOperations: [
    { op: "ask", kind: "decision", slice: "authorize", question: "Fresh login or active session?", artifacts: [], options: [{ id: "fresh-login", label: "Require a fresh login" }, { id: "session", label: "Accept the active session" }] },
    { op: "ask", kind: "visual-review", question: "Review the design.", artifacts: [] }
  ] } });
  return { root, statePath, gates: created.openedGates.map((gate) => gate.id) };
}

function runHook(payload) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK], (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(JSON.stringify(payload));
  });
}

const prompt = (cwd) => Readable.from([JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd, prompt: "go" })]);

test("delivers browser answers with the next prompt until the agent resolves them", async (context) => {
  const { root, statePath, gates } = await project(context);
  assert.equal(await deliverGateAnswers({ input: prompt(root), environment: {} }), null);
  await answerUserGate({ projectRoot: root, statePath, id: gates[0], choice: "fresh-login", note: "Downloads are sensitive." });
  const output = await deliverGateAnswers({ input: prompt(root), environment: {} });
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const text = output.hookSpecificOutput.additionalContext;
  assert.match(text, /answered these Prism user gates in the review browser/);
  assert.match(text, new RegExp(`Gate ${gates[0]} \\(decision, initiative reports, slice authorize, docs/plans/reports/state\\.json\\): "Fresh login or active session\\?" Answer: Require a fresh login\\. Note: Downloads are sensitive\\.`));
  assert.doesNotMatch(text, new RegExp(gates[1]));
  assert.match(await runHook({ hook_event_name: "UserPromptSubmit", cwd: root }), /"additionalContext":"The user answered/);
  const { revision } = await readCoordinationState({ projectRoot: root, statePath });
  const current = await updateCoordinationState({ projectRoot: root, statePath, expectedRevision: revision, changes: { gateOperations: [{ op: "resolve", id: gates[0] }] } });
  assert.equal(current.state.pending.length, 1);
  assert.equal(await deliverGateAnswers({ input: prompt(root), environment: {} }), null);
  assert.equal(await runHook({ hook_event_name: "UserPromptSubmit", cwd: root }), "");
});

test("stays silent outside a Prism project", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-gate-hook-empty-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await deliverGateAnswers({ input: prompt(root), environment: {} }), null);
});
