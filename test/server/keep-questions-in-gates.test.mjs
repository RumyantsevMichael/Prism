import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { keepQuestionsInGates } from "../../dist/hooks/keep-questions-in-gates.mjs";
import { answerUserGate, updateCoordinationState } from "../../dist/server/workflow/state.mjs";
import { NOTICE_FOLDER, rememberAskedGates } from "../../dist/server/workflow/change-notices.mjs";
import { sessionHolder } from "../../dist/server/workflow/slice-claims.mjs";
import { answerGate, checkout, git, isolateGit, ok, requirementFile, reviewBrowser, server, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

const HOOK = fileURLToPath(new URL("../../dist/hooks/keep-questions-in-gates.mjs", import.meta.url));

// The session that asks the gates, as the hooks' input and the server's tool calls name it.
const SESSION = "asking-session";
const OTHER = "other-session";

const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-question-hook-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, ".app");
  const directory = path.join(app, NOTICE_FOLDER);
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism/workflow.md"), "## Paths\n- Plans (scratch): docs/plans/\n");
  await mkdir(path.join(root, "docs/plans/reports"), { recursive: true });
  const created = await updateCoordinationState({ projectRoot: root, initiative: "reports", expectedRevision: null, changes: { gateOperations: [
    { op: "ask", kind: "visual-review", slice: "export", question: "Review the export design.", artifacts: [] }
  ] } });
  const gate = created.openedGates[0].id;
  await rememberAskedGates({ projectRoot: root, initiative: "reports", gateIds: [gate], session: sessionHolder({ CLAUDE_CODE_SESSION_ID: SESSION }), directory });
  return { root, app, directory, gate };
}

// A host question tool call as Claude Code and Codex hand it to a PreToolUse hook.
const question = (cwd, session = SESSION, tool = "AskUserQuestion") => Readable.from([JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, cwd, tool_name: tool, tool_input: { questions: [{ question: "Does the export design look right?" }] } })]);

function runHook(payload, app) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK], { env: { ...process.env, PRISM_REVIEW_APP_DIR: app } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("refuses the host question tool while the session's gate waits in the review app, and lets it through once answered", async (context) => {
  const { root, app, directory, gate } = await project(context);
  const refused = await keepQuestionsInGates({ input: question(root), environment: { PRISM_REVIEW_APP_DIR: app }, directory });
  assert.equal(refused.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(refused.hookSpecificOutput.permissionDecision, "deny");
  const reason = refused.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, new RegExp(`Gate ${gate} \\(visual-review, initiative reports, slice export\\): "Review the export design\\."`));
  assert.match(reason, /wait_for_user_gate/);
  assert.match(reason, /plain text in your reply/);
  const codex = await keepQuestionsInGates({ input: question(root, SESSION, "request_user_input"), environment: { PRISM_REVIEW_APP_DIR: app }, directory });
  assert.equal(codex.hookSpecificOutput.permissionDecision, "deny", "the hook judges the session, not which host's tool it is");
  const printed = JSON.parse(await runHook({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: root, tool_name: "AskUserQuestion", tool_input: {} }, app));
  assert.equal(printed.hookSpecificOutput.permissionDecision, "deny", "the hook command prints the refusal");

  await answerUserGate({ projectRoot: root, initiative: "reports", id: gate, choice: "approve", note: "Looks right." });
  assert.equal(await keepQuestionsInGates({ input: question(root), environment: { PRISM_REVIEW_APP_DIR: app }, directory }), null, "an answered gate holds no question");
});

test("lets the question through for a session that has no open gate, outside a Prism project, and without a session", async (context) => {
  const { root, app, directory } = await project(context);
  assert.equal(await keepQuestionsInGates({ input: question(root, OTHER), environment: { PRISM_REVIEW_APP_DIR: app }, directory }), null, "another session's gate does not hold this session's question");
  assert.equal(await keepQuestionsInGates({ input: Readable.from([JSON.stringify({ hook_event_name: "PreToolUse", cwd: root, tool_name: "AskUserQuestion" })]), environment: { PRISM_REVIEW_APP_DIR: app }, directory }), null);
  const empty = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-question-hook-empty-")));
  context.after(() => rm(empty, { recursive: true, force: true }));
  assert.equal(await keepQuestionsInGates({ input: question(empty), environment: { PRISM_REVIEW_APP_DIR: path.join(empty, ".app") }, directory: path.join(empty, ".app", NOTICE_FOLDER) }), null);
  assert.equal(await runHook({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: path.join(empty, "missing"), tool_name: "AskUserQuestion" }, app), "", "a failure lets the question through");
});

test("refuses the host question tool while an approval gate that the session asked waits, and not in another session of the checkout", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api, { env: { CLAUDE_CODE_SESSION_ID: SESSION } });
  const file = "docs/requirements/billing.md";
  await writeArtifact(prism, file, requirementFile("Billing"));
  const gate = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: file, question: "Approve the billing requirements?", context: "Billing." }] })).artifacts[0].gate;
  const ask = (session) => keepQuestionsInGates({ input: question(api, session), environment: { PRISM_REVIEW_APP_DIR: place.app } });
  const refused = await ask(SESSION);
  assert.match(refused.hookSpecificOutput.permissionDecisionReason, new RegExp(`Approval gate ${gate} \\(${file}\\): "Approve the billing requirements\\?"`));
  assert.equal(await ask(OTHER), null, "another session in the same checkout did not ask the gate");

  const review = await reviewBrowser(context, api);
  assert.equal((await answerGate(review, { artifact: file, scope: "workspace", id: gate, choice: "request-changes", note: "Name the currency." })).status, 200);
  assert.equal(await ask(SESSION), null, "an answered approval gate holds no question");
});
