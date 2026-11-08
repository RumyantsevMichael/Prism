import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { deliverGateAnswers } from "../../dist/hooks/deliver-gate-answers.mjs";
import { answerApproval, parseRecord, rewriteStatusLines, writtenStatus } from "../../dist/server/workflow/artifact-status.mjs";
import { adrFile, browserRequest, checkout, eventually, git, isolateGit, ok, remoteFile, requirementFile, reviewBrowser, server, syncedWorkspace, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Status records of store artifacts: how status lines are read and rewritten, and that a record syncs with its artifact.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

test("the written status is the first Status line before the first level-two heading", () => {
  assert.equal(writtenStatus("# T\r\n\r\nStatus: Approved\r\nStatus: Draft\r\n"), "Approved");
  assert.equal(writtenStatus("# T\n\n## Part\n\nStatus: Approved\n"), null);
  assert.equal(writtenStatus("Status:   Superseded by [x](x.md)  \n"), "Superseded by [x](x.md)");
});

test("approving rewrites the status lines and keeps the file's line endings", () => {
  assert.equal(rewriteStatusLines("# T\r\n\r\nStatus: Draft\r\nApproved: n/a\r\n\r\n## A\r\nApproved: keep\r\n", "Approved", "2026-11-08"), "# T\r\n\r\nStatus: Approved\r\nApproved: 2026-11-08\r\n\r\n## A\r\nApproved: keep\r\n");
  assert.equal(rewriteStatusLines("# T\n\nStatus: Proposed\n", "Superseded", "2026-11-08"), "# T\n\nStatus: Superseded\n");
  assert.equal(rewriteStatusLines("# T\n\n## A\n", "Approved", "2026-11-08"), "# T\n\nStatus: Approved\nApproved: 2026-11-08\n\n## A\n");
  assert.equal(rewriteStatusLines("# T\n\nStatus: Draft", "Approved", "2026-11-08"), "# T\n\nStatus: Approved\nApproved: 2026-11-08");
});

test("a status record syncs beside its artifact, and moves and goes with it", async (context) => {
  const machines = await syncedWorkspace(context);
  const api = await checkout(machines.a, "api");
  const prism = await server(context, machines.a, api);
  const file = "docs/requirements/billing.md";
  const record = "artifact-status/requirements/billing.md/status.json";
  await writeArtifact(prism, file, requirementFile("Billing"));
  const gate = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: file, context: "Billing." }] })).artifacts[0].gate;
  await eventually(() => remoteFile(machines.remote, record)?.includes(gate), 30000, "the status record with its gate reaching the remote");
  assert.ok(remoteFile(machines.remote, "artifacts/requirements/billing.md"));

  const current = ok(await prism.call("get_artifact", { path: file }));
  ok(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: file, expectedVersion: current.version, scope: "repository" }] }));
  const moved = "artifact-status/repositories/api/requirements/billing.md/status.json";
  await eventually(() => remoteFile(machines.remote, moved)?.includes(gate) && remoteFile(machines.remote, record) === null, 30000, "the status record moving with its artifact");
  assert.equal(ok(await prism.call("get_artifact", { path: file })).status, "Draft");

  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: file, expectedVersion: current.version }] }));
  await eventually(() => remoteFile(machines.remote, moved) === null, 30000, "the status record going with its artifact");
});

test("front matter stays the first lines of a file, and a comment inside it is no title", () => {
  assert.equal(rewriteStatusLines("---\nowner: ada\n---\n\nIntro.\n\n## 1. A\n", "Approved", "2026-11-08"), "---\nowner: ada\n---\nStatus: Approved\nApproved: 2026-11-08\n\nIntro.\n\n## 1. A\n");
  assert.equal(rewriteStatusLines("---\n# owner\nowner: ada\n---\n# T\n\n## 1. A\n", "Approved", "2026-11-08"), "---\n# owner\nowner: ada\n---\n# T\n\nStatus: Approved\nApproved: 2026-11-08\n\n## 1. A\n");
  assert.equal(rewriteStatusLines("---\r\nApproved: x\r\n---\r\n# T\r\n\r\nStatus: Draft\r\n", "Approved", "2026-11-08"), "---\r\nApproved: x\r\n---\r\n# T\r\n\r\nStatus: Approved\r\nApproved: 2026-11-08\r\n");
  assert.equal(rewriteStatusLines("---\nowner: ada\n---", "Superseded", "2026-11-08"), "---\nowner: ada\n---\nStatus: Superseded");
});

const BYTES = "# T\n\nStatus: Draft\n\n## 1. A\n";
const gateOf = (fields) => ({ id: "approval-feedfacecafe", status: "Approved", version: version(BYTES), question: "Approve?", context: null, askedAt: "2026-11-08T00:00:00.000Z", ...fields });
const recordOf = (gates, closed = []) => JSON.stringify({ status: "Draft", acceptedVersion: null, approval: null, pending: gates, closed, history: [] });

test("a stored gate that no ask_approval could record is dropped, and answering one changes nothing", () => {
  for (const [kind, fields] of [
    ["requirements", { status: "Approved\n\n## 9. Injected" }],
    ["requirements", { status: { toString: "Approved" } }],
    ["requirements", { status: "" }],
    ["requirements", { status: "x".repeat(201) }],
    ["requirements", { status: " Approved" }],
    ["adrs", { status: "accepted" }],
    ["requirements", { version: "sha256:abc" }],
    ["requirements", { version: null }]
  ]) {
    assert.deepEqual(parseRecord(kind, recordOf([gateOf(fields)])).pending, [], JSON.stringify(fields));
  }
  assert.equal(parseRecord("adrs", recordOf([gateOf({ status: "Superseded" })])).pending.length, 1);
  assert.deepEqual(parseRecord("requirements", recordOf([], [gateOf({ answer: { choice: "approve-all", note: null } })])).closed, []);
  assert.equal(parseRecord("requirements", JSON.stringify({ status: "Approved\nInjected" })).status, "Draft");

  const record = { status: "Proposed", acceptedVersion: null, approval: null, pending: [gateOf({ status: "Accepted" })], closed: [], history: [] };
  assert.throws(() => answerApproval("adrs", "docs/ADRs/x.md", record, { id: "approval-feedfacecafe", choice: "approve", by: { name: "Ada", host: "h" }, version: version(BYTES), text: BYTES }), { code: "gate_invalid" });
});

test("a synced gate whose status no ask_approval allows is not offered, and an answer to it leaves the artifact and its record as they were", async (context) => {
  const { place, api, prism } = await project(context);
  const file = "docs/ADRs/billing/ledger.md";
  const written = await writeArtifact(prism, file, adrFile("Ledger"));
  const target = path.join(place.store, "artifact-status/adrs/billing/ledger.md/status.json");
  await mkdir(path.dirname(target), { recursive: true });
  const planted = `${JSON.stringify({ status: "Proposed", acceptedVersion: null, approval: null, pending: [{ id: "approval-feedfacecafe", status: "Accepted", version: written.version, question: "Approve?", context: "Synced.", askedAt: new Date().toISOString() }], closed: [], history: [] })}\n`;
  await writeFile(target, planted);
  const review = await reviewBrowser(context, api);
  assert.deepEqual(await pendingApprovals(review), []);
  const answered = await answer(review, { artifact: file, scope: "workspace", id: "approval-feedfacecafe", choice: "approve", note: null });
  assert.equal(answered.status, 409);
  const read = ok(await prism.call("get_artifact", { path: file }));
  assert.equal(read.status, "Proposed");
  assert.equal(read.version, written.version);
  assert.equal(await readFile(target, "utf8"), planted);
});

// A Claude Code host that moves long tool calls to the background, so a gate wait waits.
const BACKGROUND_HOST = { client: { name: "claude-code", version: "2.1.296" }, env: { MCP_TOOL_TIMEOUT: undefined, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: undefined, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: undefined } };
const FILE = "docs/requirements/billing.md";

async function project(context, host = {}) {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api, host);
  return { place, api, prism };
}

const pendingApprovals = async (review) => (await browserRequest(review, "/api/entity?ref=attention")).body.data.needsYou.filter((item) => item.type === "gate" && item.kind === "approval");
const answer = (review, body) => browserRequest(review, "/api/gates/answer", { method: "POST", body });
const askApproval = async (prism, file = FILE) => ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: file, context: "Billing." }] })).artifacts[0].gate;

test("a wait on an artifact's approval gate ends as resolved when the artifact is removed", async (context) => {
  const { prism } = await project(context, BACKGROUND_HOST);
  const created = await writeArtifact(prism, FILE, requirementFile("Billing"));
  const gate = await askApproval(prism);
  const started = Date.now();
  const waiting = prism.call("wait_for_user_gate", { artifact: FILE, gateIds: [gate], maxWaitMinutes: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: FILE, expectedVersion: created.version }] }));
  const result = ok(await waiting);
  assert.equal(result.status, "resolved");
  assert.ok(Date.now() - started < 20000, "the wait ended at its timeout instead of when the gate went away");
});

const hook = (event, cwd, app, source) => deliverGateAnswers({ input: Readable.from([JSON.stringify({ hook_event_name: event, cwd, ...(source ? { source } : {}) })]), environment: { PRISM_REVIEW_APP_DIR: app } });

test("an approval answer reaches the agent with the next message once, and get_artifact returns it", async (context) => {
  const { place, api, prism } = await project(context);
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  const gate = await askApproval(prism);
  const resumed = (await hook("SessionStart", api, place.app, "resume")).hookSpecificOutput.additionalContext;
  assert.match(resumed, new RegExp(`call wait_for_user_gate with its id and the artifact's path as artifact[\\s\\S]*Approval gate ${gate} \\(${FILE}, scope workspace, status Approved\\)`));
  assert.equal(await hook("UserPromptSubmit", api, place.app), null, "an unanswered gate is no answer");

  const review = await reviewBrowser(context, api);
  assert.equal((await answer(review, { artifact: FILE, scope: "workspace", id: gate, choice: "request-changes", note: "Name the currency." })).status, 200);
  const delivered = (await hook("UserPromptSubmit", api, place.app)).hookSpecificOutput.additionalContext;
  assert.match(delivered, new RegExp(`Approval gate ${gate} \\(${FILE}, scope workspace, status Approved\\): "Approve ${FILE} as Approved\\?" Answer: Request changes\\. Note: Name the currency\\. Its recorded status stays as it was\\.`));
  assert.match(delivered, /an approval gate needs no resolve/);
  assert.equal(await hook("UserPromptSubmit", api, place.app), null, "an answer is delivered once");
  assert.equal(await hook("SessionStart", api, place.app, "resume"), null, "a resumed session is not told a delivered answer again");

  const read = ok(await prism.call("get_artifact", { path: FILE }));
  assert.equal(read.status, "Draft");
  assert.deepEqual({ ...read.latestAnswer, answeredAt: typeof read.latestAnswer.answeredAt }, { gate, status: "Approved", choice: "request-changes", note: "Name the currency.", answeredAt: "string", by: read.latestAnswer.by });
  assert.equal(read.latestAnswer.by.name, "Ada Reviewer");

  const again = await askApproval(prism);
  assert.equal(ok(await prism.call("get_artifact", { path: FILE })).latestAnswer.gate, gate, "the latest answer stays readable while a new question waits");
  assert.equal((await answer(review, { artifact: FILE, scope: "workspace", id: again, choice: "approve", note: null })).status, 200);
  assert.match((await hook("UserPromptSubmit", api, place.app)).hookSpecificOutput.additionalContext, new RegExp(`Approval gate ${again} .* Answer: Approve\\. Prism recorded Approved`));
  assert.equal(ok(await prism.call("get_artifact", { path: FILE })).latestAnswer.choice, "approve");
});

test("an approval answer that a wait returned is not delivered again with the next message", async (context) => {
  const { place, api, prism } = await project(context, BACKGROUND_HOST);
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  const gate = await askApproval(prism);
  const review = await reviewBrowser(context, api);
  const waiting = prism.call("wait_for_user_gate", { artifact: FILE, gateIds: [gate], maxWaitMinutes: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal((await answer(review, { artifact: FILE, scope: "workspace", id: gate, choice: "request-changes", note: "Name the currency." })).status, 200);
  assert.equal(ok(await waiting).status, "answered");
  assert.equal(await hook("UserPromptSubmit", api, place.app), null);
});
