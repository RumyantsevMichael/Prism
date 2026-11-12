import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { deliverGateAnswers } from "../../dist/hooks/deliver-gate-answers.mjs";
import { answerUserGate, readCoordinationState, updateCoordinationState } from "../../dist/server/workflow/state.mjs";
import { NOTICE_FOLDER, rememberAskedGates } from "../../dist/server/workflow/change-notices.mjs";
import { sessionHolder } from "../../dist/server/workflow/slice-claims.mjs";

const HOOK = fileURLToPath(new URL("../../dist/hooks/deliver-gate-answers.mjs", import.meta.url));

// The session that asks the gates, as the hooks' input and the server's tool calls name it.
const SESSION = "asking-session";
const OTHER = "other-session";

async function project(context, initiative = "reports") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-gate-hook-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".app", NOTICE_FOLDER);
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans (scratch): docs/plans/\n");
  await mkdir(path.join(root, "docs/plans", initiative), { recursive: true });
  const created = await updateCoordinationState({ projectRoot: root, initiative, expectedRevision: null, changes: { gateOperations: [
    { op: "ask", kind: "decision", slice: "authorize", question: "Fresh login or active session?", context: "The run reached a choice that needs the person, for example which behavior to keep.", artifacts: [], options: [{ id: "fresh-login", label: "Require a fresh login", consequence: "The run continues with this choice." }, { id: "session", label: "Accept the active session", consequence: "The run continues with this choice." }], recommended: { option: "fresh-login", reason: "It keeps the current behavior." } },
    { op: "ask", kind: "visual-review", question: "Review the design.", artifacts: [] }
  ] } });
  const gates = created.openedGates.map((gate) => gate.id);
  await rememberAskedGates({ projectRoot: root, initiative, gateIds: gates, session: sessionHolder({ CLAUDE_CODE_SESSION_ID: SESSION }), directory });
  return { root, initiative, gates, directory };
}

function runHook(payload, directory) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK], { env: { ...process.env, PRISM_REVIEW_APP_DIR: path.dirname(directory) } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(JSON.stringify(payload));
  });
}

const prompt = (cwd, session = SESSION) => Readable.from([JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, cwd, prompt: "go" })]);

test("delivers browser answers with the next prompt until the agent resolves them", async (context) => {
  const { root, initiative, gates, directory } = await project(context);
  assert.equal(await deliverGateAnswers({ input: prompt(root), environment: {}, directory }), null);
  await answerUserGate({ projectRoot: root, initiative, id: gates[0], choice: "fresh-login", note: "Downloads are sensitive." });
  const output = await deliverGateAnswers({ input: prompt(root), environment: {}, directory });
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const text = output.hookSpecificOutput.additionalContext;
  assert.match(text, /answered these Prism user gates in the review browser/);
  assert.match(text, new RegExp(`Gate ${gates[0]} \\(decision, initiative reports, slice authorize\\): "Fresh login or active session\\?" Answer: Require a fresh login\\. Note: Downloads are sensitive\\.`));
  assert.doesNotMatch(text, new RegExp(gates[1]));
  assert.match(await runHook({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: root }, directory), /"additionalContext":"The user answered/);
  const { revision } = await readCoordinationState({ projectRoot: root, initiative });
  const current = await updateCoordinationState({ projectRoot: root, initiative, expectedRevision: revision, changes: { gateOperations: [{ op: "resolve", id: gates[0] }] } });
  assert.equal(current.state.pending.length, 1);
  assert.equal(await deliverGateAnswers({ input: prompt(root), environment: {}, directory }), null);
  assert.equal(await runHook({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: root }, directory), "");
});

const start = (cwd, source, session = SESSION) => Readable.from([JSON.stringify({ hook_event_name: "SessionStart", source, session_id: session, cwd })]);

test("a resumed session learns its open gates, waits on the unanswered ones, and acts on the answered ones", async (context) => {
  const { root, initiative, gates, directory } = await project(context);
  assert.equal(await deliverGateAnswers({ input: start(root, "startup"), environment: {}, directory }), null, "a new session did not open the project's gates");
  assert.equal(await deliverGateAnswers({ input: start(root, "compact"), environment: {}, directory }), null, "compaction keeps a running wait");
  await answerUserGate({ projectRoot: root, initiative, id: gates[0], choice: "session" });
  const output = await deliverGateAnswers({ input: start(root, "resume"), environment: {}, directory });
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  const text = output.hookSpecificOutput.additionalContext;
  assert.match(text, /call wait_for_user_gate with their ids/);
  assert.match(text, new RegExp(`Gate ${gates[1]} \\(visual-review, initiative reports\\): "Review the design\\."\n`));
  assert.match(text, new RegExp(`Gate ${gates[0]} .*Answer: Accept the active session\\.`));
  assert.ok(text.indexOf(gates[1]) < text.indexOf("already answered"), "waiting gates and answered gates are listed apart");
  assert.match(await runHook({ hook_event_name: "SessionStart", source: "resume", session_id: SESSION, cwd: root }, directory), /"hookEventName":"SessionStart"/);
  const { revision } = await readCoordinationState({ projectRoot: root, initiative });
  await updateCoordinationState({ projectRoot: root, initiative, expectedRevision: revision, changes: { gateOperations: gates.map((id) => ({ op: "resolve", id, reason: "Handled." })) } });
  assert.equal(await deliverGateAnswers({ input: start(root, "resume"), environment: {}, directory }), null, "no open gate, no context");
});

test("stays silent outside a Prism project", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-gate-hook-empty-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await deliverGateAnswers({ input: prompt(root), environment: {}, directory: path.join(root, ".app") }), null);
});

test("delivers a gate's answer and resume reminder only to the session that asked it", async (context) => {
  const { root, initiative, gates, directory } = await project(context);
  // Another session works on another initiative of the same project and asks its own gate.
  await mkdir(path.join(root, "docs/plans/search"), { recursive: true });
  const other = await updateCoordinationState({ projectRoot: root, initiative: "search", expectedRevision: null, changes: { gateOperations: [{ op: "ask", kind: "visual-review", question: "Review the search design.", artifacts: [] }] } });
  const otherGate = other.openedGates[0].id;
  await rememberAskedGates({ projectRoot: root, initiative: "search", gateIds: [otherGate], session: sessionHolder({ CLAUDE_CODE_SESSION_ID: OTHER }), directory });
  await answerUserGate({ projectRoot: root, initiative, id: gates[0], choice: "fresh-login" });
  await answerUserGate({ projectRoot: root, initiative: "search", id: otherGate, choice: "approve" });
  const mine = (await deliverGateAnswers({ input: prompt(root), environment: {}, directory })).hookSpecificOutput.additionalContext;
  assert.match(mine, new RegExp(gates[0]));
  assert.doesNotMatch(mine, new RegExp(otherGate), "the other session's answer stays with it");
  const theirs = (await deliverGateAnswers({ input: prompt(root, OTHER), environment: {}, directory })).hookSpecificOutput.additionalContext;
  assert.match(theirs, new RegExp(otherGate));
  assert.doesNotMatch(theirs, new RegExp(gates[0]), "an answer to this session's gate never reaches the other session");
  const resumed = (await deliverGateAnswers({ input: start(root, "resume", OTHER), environment: {}, directory })).hookSpecificOutput.additionalContext;
  assert.match(resumed, new RegExp(otherGate));
  assert.doesNotMatch(resumed, new RegExp(`${gates[0]}|${gates[1]}`), "a resumed session is reminded only of the gates it asked");
  assert.equal(await deliverGateAnswers({ input: prompt(root, "unknown-session"), environment: {}, directory }), null, "a session that asked nothing gets nothing");
  assert.equal(await deliverGateAnswers({ input: Readable.from([JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "go" })]), environment: {}, directory }), null, "input without a session gets nothing");
});
