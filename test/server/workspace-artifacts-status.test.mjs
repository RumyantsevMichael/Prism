import assert from "node:assert/strict";
import os from "node:os";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { deliverGateAnswers } from "../../dist/hooks/deliver-gate-answers.mjs";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { adrFile, answerGate, browserRequest, checkout, git, isolateGit, ok, READ_ONLY, refused, requirementFile, reviewBrowser, server, text, today, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// Contract clauses 30-38 of the workspace-artifacts design: requirement and ADR status changes only at gates answered in the browser.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const FILE = "docs/requirements/billing.md";

// A Claude Code host that moves long tool calls to the background, with none of the settings that stop it, so a gate wait waits.
const BACKGROUND_HOST = { client: { name: "claude-code", version: "2.1.296" }, env: { MCP_TOOL_TIMEOUT: undefined, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: undefined, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: undefined } };

async function project(context, { named = true, host = {} } = {}) {
  const place = await workspace(context);
  const api = await checkout(place, "api");
  if (named) git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api, host);
  return { place, api, prism };
}

const pendingApprovals = async (review) => (await browserRequest(review, "/api/entity?ref=attention")).body.data.needsYou.filter((item) => item.type === "gate" && item.kind === "approval");
// An approval gate is answered through the review app's gate.answer action of the target approval:<id>, as every other gate is.
const answer = (review, body) => answerGate(review, body);
const approvalActions = (review, id, headers = {}) => browserRequest(review, `/api/actions?target=${encodeURIComponent(`approval:${id}`)}`, { headers });
const apply = (review, body, headers = {}) => browserRequest(review, "/api/actions/apply", { method: "POST", body, headers });

test("clauses 30, 31, and 32: a written status that no gate recorded is reported, the recorded one counts, and the browser shows it", async (context) => {
  const { api, prism } = await project(context);
  const written = ok(await prism.call("update_artifact", { operations: [{ op: "write", path: FILE, content: requirementFile("Billing", "Approved", "2026-11-07"), expectedVersion: null }] }));
  assert.equal(written.artifacts[0].statusMismatch.written, "Approved", "the write reports the mismatch and is not refused");
  assert.equal(written.artifacts[0].statusMismatch.recorded, "Draft");
  const read = ok(await prism.call("get_artifact", { path: FILE }));
  assert.equal(read.status, "Draft", "a new requirement's recorded status is Draft");
  assert.equal(read.statusMismatch.written, "Approved");
  assert.equal(read.statusMismatch.recorded, "Draft");
  assert.match(read.statusMismatch.message, /approval/i, "the message names the approval gate");

  await writeArtifact(prism, "docs/ADRs/billing/ledger.md", adrFile("Ledger", "Accepted"));
  const adrRead = ok(await prism.call("get_artifact", { path: "docs/ADRs/billing/ledger.md" }));
  assert.equal(adrRead.status, "Proposed", "a new ADR's recorded status is Proposed");
  assert.match(adrRead.statusMismatch.message, /ship/i, "an ADR becomes Accepted when its initiative ships");

  await writeArtifact(prism, "docs/requirements/draft.md", requirementFile("Draft one"));
  const draft = ok(await prism.call("get_artifact", { path: "docs/requirements/draft.md" }));
  assert.equal(draft.status, "Draft");
  assert.equal(draft.statusMismatch, undefined, "a matching status reports nothing");
  // A Status line below the first level-two heading is not the file's status.
  await writeArtifact(prism, "docs/requirements/late.md", "# Late\n\n## Section\n\nStatus: Approved\n");
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/requirements/late.md" })).statusMismatch.written, null);

  const listed = ok(await prism.call("get_artifact", { path: "docs/requirements" })).artifacts;
  assert.equal(listed.find((entry) => entry.path === FILE).status, "Draft");
  await writeArtifact(prism, "docs/plans/reports/slice.md", "# Reports\n\nStatus: Approved\n");
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/plans/reports/slice.md" })).status, undefined, "a plan has no status");

  const review = await reviewBrowser(context, api);
  const library = await browserRequest(review, "/api/entity?ref=requirements");
  assert.equal(library.body.data.entries.find((entry) => entry.path === FILE).status, "Draft", "the browser shows the recorded status");
});

test("clauses 33, 34, and 35: approving a requirement at its gate rewrites its status lines and records who approved it", async (context) => {
  const { api, prism } = await project(context);
  const created = await writeArtifact(prism, FILE, requirementFile("Billing"));
  const asked = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, question: "Approve the billing requirements?", context: "They define how invoices are totalled." }] }));
  const gate = asked.artifacts[0].gate;
  assert.equal(typeof gate, "string");
  const review = await reviewBrowser(context, api);
  const [listed] = await pendingApprovals(review);
  assert.equal(listed.id, gate);
  assert.equal(listed.artifact.path, FILE);
  assert.equal(listed.artifact.scope.label, "workspace");

  const answered = await answer(review, { artifact: FILE, scope: "workspace", id: gate, choice: "approve", note: null });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const approvedText = requirementFile("Billing", "Approved", today());
  const read = ok(await prism.call("get_artifact", { path: FILE }));
  assert.equal(read.content, approvedText, "the Status and Approved lines are rewritten");
  assert.equal(read.status, "Approved");
  assert.equal(read.statusMismatch, undefined);
  assert.equal(read.approval.gate, gate);
  assert.deepEqual(read.approval.by, { name: "Ada Reviewer", host: os.hostname() });
  assert.ok(Date.parse(read.approval.at) > Date.now() - 600000);
  assert.equal(read.acceptedVersion, version(approvedText));
  assert.equal(read.changedSinceAccepted, false);
  assert.notEqual(read.version, created.version);
  assert.deepEqual(await pendingApprovals(review), []);

  // A file without an Approved line gains one after its Status line.
  await writeArtifact(prism, "docs/requirements/short.md", "# Short\n\nStatus: Draft\n\n## 1. One\n");
  const short = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: "docs/requirements/short.md", context: "A short file." }] }));
  assert.equal((await answer(review, { artifact: "docs/requirements/short.md", scope: "workspace", id: short.artifacts[0].gate, choice: "approve", note: null })).status, 200);
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/requirements/short.md" })).content, `# Short\n\nStatus: Approved\nApproved: ${today()}\n\n## 1. One\n`);

  // A request for changes keeps the recorded status.
  await writeArtifact(prism, "docs/requirements/other.md", requirementFile("Other"));
  const other = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: "docs/requirements/other.md", context: "Another file." }] }));
  assert.equal((await answer(review, { artifact: "docs/requirements/other.md", scope: "workspace", id: other.artifacts[0].gate, choice: "request-changes", note: "Name the currency." })).status, 200);
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/requirements/other.md" })).status, "Draft");
  assert.equal(await text(path.join(api, FILE)), null, "nothing was written into the checkout");
});

test("clause 34: an approval is the gate.answer action of its approval target, under the page's origin and write session checks, and the old answer route is gone", async (context) => {
  const { api, prism } = await project(context);
  const created = await writeArtifact(prism, FILE, requirementFile("Billing"));
  const gate = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Billing." }] })).artifacts[0].gate;
  const review = await reviewBrowser(context, api);
  const target = `approval:${gate}`;

  const listed = await approvalActions(review, gate);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.target, target);
  assert.equal(listed.body.writable, true);
  const [action] = listed.body.actions;
  assert.deepEqual([listed.body.actions.length, action.id, action.target, action.available, action.reason, action.revision], [1, "gate.answer", target, true, null, created.version], "the revision is the artifact's current version");
  const [choice, note] = action.fields;
  assert.deepEqual([choice.name, choice.options.map((option) => option.value), choice.required], ["choice", ["approve", "request-changes"], true]);
  assert.deepEqual([note.name, note.requiredWhen], ["note", { field: "choice", values: ["request-changes"] }]);
  assert.equal((await approvalActions(review, gate, READ_ONLY)).body.writable, false, "a tab without a write session reads the action and cannot apply it");

  const body = { action: "gate.answer", target, input: { choice: "approve" }, revision: created.version };
  const readOnly = await apply(review, body, READ_ONLY);
  assert.deepEqual([readOnly.status, readOnly.body.code], [403, "write_forbidden"]);
  const foreign = await apply(review, body, { Origin: "http://evil.example" });
  assert.deepEqual([foreign.status, foreign.body.code], [403, "origin_refused"]);
  const plain = await apply(review, JSON.stringify(body), { "Content-Type": "text/plain" });
  assert.deepEqual([plain.status, plain.body.code], [403, "origin_refused"]);
  const unknown = await apply(review, { ...body, target: "approval:approval-000000000000" });
  assert.deepEqual([unknown.status, unknown.body.code], [404, "unknown_target"]);
  const stale = await apply(review, { ...body, revision: version("older bytes") });
  assert.deepEqual([stale.status, stale.body.code], [409, "stale_revision"]);
  const noReason = await apply(review, { ...body, input: { choice: "request-changes" } });
  assert.deepEqual([noReason.status, noReason.body.code, noReason.body.field], [400, "invalid_input", "note"]);
  const unknownChoice = await apply(review, { ...body, input: { choice: "accept" } });
  assert.deepEqual([unknownChoice.status, unknownChoice.body.code], [400, "invalid_input"]);
  for (const old of [{ artifact: FILE, scope: "workspace", id: gate, choice: "approve", note: null }, { initiative: "reports", id: "gate-0123456789", choice: "done" }, {}, "not json"]) {
    const gone = await browserRequest(review, "/api/gates/answer", { method: "POST", body: old });
    assert.equal(gone.status, 404, `/api/gates/answer is gone for ${JSON.stringify(old)}`);
  }
  assert.equal(ok(await prism.call("get_artifact", { path: FILE })).status, "Draft", "no refused or removed request changed the status");

  const answered = await apply(review, body);
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const entry = answered.body.applied;
  assert.deepEqual([entry.action, entry.target, entry.before, entry.after, entry.via], ["gate.answer", target, null, { choice: "approve", note: null }, "review-app"]);
  assert.equal(entry.by.name, "Ada Reviewer");
  assert.match(entry.id, /^[0-9a-f]{32}$/);
  const read = ok(await prism.call("get_artifact", { path: FILE }));
  assert.equal(read.status, "Approved");
  assert.equal(read.latestAnswer.entry, entry.id, "the artifact's status record holds the applied entry");
  const again = await apply(review, { ...body, revision: read.version });
  assert.deepEqual([again.status, again.body.code], [404, "unknown_target"], "an answered gate is no longer a target");
});

test("clause 33: an approval gate is refused for a plan, for an ADR's acceptance, and when nothing changed since the last approval", async (context) => {
  const { api, prism } = await project(context);
  await writeArtifact(prism, "docs/plans/reports/slice.md", "# Reports\n");
  refused(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: "docs/plans/reports/slice.md", context: "A plan." }] }), "not_a_status_artifact");
  await writeArtifact(prism, "docs/ADRs/billing/ledger.md", adrFile("Ledger"));
  refused(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: "docs/ADRs/billing/ledger.md", status: "Accepted", context: "An ADR." }] }), "status_by_ship");
  const superseded = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: "docs/ADRs/billing/ledger.md", status: "Superseded by [other](other.md)", context: "Replaced." }] }));
  assert.ok(superseded.artifacts[0].gate, "another ADR status goes through an approval gate");

  await writeArtifact(prism, FILE, requirementFile("Billing"));
  const asked = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Billing." }] }));
  const review = await reviewBrowser(context, api);
  assert.equal((await answer(review, { artifact: FILE, scope: "workspace", id: asked.artifacts[0].gate, choice: "approve", note: null })).status, 200);
  refused(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Again." }] }), "nothing_to_approve");
  // An amendment of an Approved file is approved at a gate of its own.
  const current = ok(await prism.call("get_artifact", { path: FILE }));
  ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: current.version, edits: [{ oldText: "do the thing.", newText: "do the thing twice." }] }] }));
  const amendment = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Amended." }] }));
  assert.ok(amendment.artifacts[0].gate);
});

test("clause 36: an answer action is refused when the artifact changed since the gate was asked, or when Git names no user", async (context) => {
  const { api, prism } = await project(context);
  const created = await writeArtifact(prism, FILE, requirementFile("Billing"));
  const asked = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Billing." }] }));
  ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: created.version, edits: [{ oldText: "Something is missing.", newText: "Something else is missing." }] }] }));
  const review = await reviewBrowser(context, api);
  const [listedChanged] = (await approvalActions(review, asked.artifacts[0].gate)).body.actions;
  assert.equal(listedChanged.available, false, "the listing shows that the artifact changed since the gate was asked");
  assert.match(listedChanged.reason, /changed/i);
  const changed = await answer(review, { artifact: FILE, scope: "workspace", id: asked.artifacts[0].gate, choice: "approve", note: null });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, "artifact_changed");
  assert.equal(ok(await prism.call("get_artifact", { path: FILE })).status, "Draft");

  const anonymous = await project(context, { named: false });
  await writeArtifact(anonymous.prism, FILE, requirementFile("Billing"));
  const unnamed = ok(await anonymous.prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Billing." }] }));
  const anonymousReview = await reviewBrowser(context, anonymous.api);
  const refusedAnswer = await answer(anonymousReview, { artifact: FILE, scope: "workspace", id: unnamed.artifacts[0].gate, choice: "approve", note: null });
  assert.equal(refusedAnswer.status, 409);
  assert.equal(refusedAnswer.body.code, "author_unknown");
  assert.equal(ok(await anonymous.prism.call("get_artifact", { path: FILE })).status, "Draft");
});

test("clause 37: waiting on an artifact's approval gate returns the person's answer", async (context) => {
  const { api, prism } = await project(context, { host: BACKGROUND_HOST });
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  const asked = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Billing." }] }));
  const gate = asked.artifacts[0].gate;
  const review = await reviewBrowser(context, api);
  const waiting = prism.call("wait_for_user_gate", { artifact: FILE, gateIds: [gate], maxWaitMinutes: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal((await answer(review, { artifact: FILE, scope: "workspace", id: gate, choice: "approve", note: "Looks right." })).status, 200);
  const result = ok(await waiting);
  assert.match(JSON.stringify(result), /answered/);
  assert.match(JSON.stringify(result), /Looks right\./);
});

// The prompt and session start hooks as a host runs them in a checkout, with app as the machine's Prism application folder.
const hook = (event, cwd, app) => deliverGateAnswers({ input: Readable.from([JSON.stringify({ hook_event_name: event, cwd, ...(event === "SessionStart" ? { source: "resume" } : {}) })]), environment: { PRISM_REVIEW_APP_DIR: app } });
const hookText = async (event, cwd, app) => (await hook(event, cwd, app))?.hookSpecificOutput?.additionalContext ?? null;

test("clause 37: an approval answer reaches the checkout that asked it once, however old, and no other checkout or machine", async (context) => {
  const { place, api, prism } = await project(context);
  const web = await checkout(place, "web");
  const webPrism = await server(context, place, web);
  const otherMachine = path.join(place.parent, "other-app");
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  const ask = async () => ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Billing." }] })).artifacts[0].gate;
  const first = await ask();
  assert.equal(ok(await webPrism.call("get_artifact", { path: FILE })).path, FILE, "the other checkout sees the workspace artifact");

  assert.match(await hookText("SessionStart", api, place.app) ?? "", new RegExp(`${first}[\\s\\S]*${FILE}`), "a resumed session of the asking checkout is told its unanswered gate");
  assert.equal(await hookText("SessionStart", web, place.app), null, "another checkout did not ask the gate");
  assert.equal(await hookText("UserPromptSubmit", api, place.app), null, "an unanswered gate is no answer");

  const review = await reviewBrowser(context, api);
  assert.equal((await answer(review, { artifact: FILE, scope: "workspace", id: first, choice: "request-changes", note: "Name the currency." })).status, 200);
  assert.equal(await hookText("UserPromptSubmit", web, place.app), null, "another checkout on the asking machine is not handed the answer");
  assert.equal(await hookText("UserPromptSubmit", web, otherMachine), null, "another machine is not handed the answer");
  assert.equal(ok(await webPrism.call("get_artifact", { path: FILE })).latestAnswer.gate, first, "another checkout reads the latest answer");
  const delivered = await hookText("UserPromptSubmit", api, place.app);
  assert.match(delivered ?? "", new RegExp(first));
  assert.match(delivered, /request changes/i);
  assert.match(delivered, /Name the currency\./);
  assert.equal(await hookText("UserPromptSubmit", api, place.app), null, "an answer is delivered once");
  assert.equal(await hookText("SessionStart", api, place.app), null, "a resumed session is not told a received answer again");

  const second = await ask();
  assert.equal((await answer(review, { artifact: FILE, scope: "workspace", id: second, choice: "request-changes", note: "Round totals." })).status, 200);
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() + 30 * 86400000 });
  try {
    assert.match(await hookText("UserPromptSubmit", api, place.app) ?? "", new RegExp(`${second}[\\s\\S]*Round totals\\.`), "an answer that waited 30 days still reaches the asking checkout");
  } finally {
    context.mock.timers.reset();
  }

  const third = await ask();
  assert.equal((await answer(review, { artifact: FILE, scope: "workspace", id: third, choice: "approve", note: null })).status, 200);
  assert.equal(ok(await prism.call("get_artifact", { path: FILE })).latestAnswer.gate, third);
  assert.equal(await hookText("UserPromptSubmit", api, place.app), null, "a read that returned the answer as latestAnswer received it");
});

test("clause 38: the accepted version is kept at approval and at design acceptance, and can be read", async (context) => {
  const { api, prism } = await project(context);
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  const asked = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Billing." }] }));
  const review = await reviewBrowser(context, api);
  assert.equal((await answer(review, { artifact: FILE, scope: "workspace", id: asked.artifacts[0].gate, choice: "approve", note: null })).status, 200);
  const approved = ok(await prism.call("get_artifact", { path: FILE }));
  ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: approved.version, edits: [{ oldText: "do the thing.", newText: "do the thing well." }] }] }));
  const changed = ok(await prism.call("get_artifact", { path: FILE }));
  assert.equal(changed.changedSinceAccepted, true);
  assert.equal(changed.acceptedVersion, approved.version);
  const accepted = ok(await prism.call("get_artifact", { path: FILE, accepted: true }));
  assert.equal(accepted.content, approved.content);
  assert.equal(accepted.version, approved.version);

  ok(await createInitiative(prism, "reports"));
  const design = "# Reports\n\n## Contract\n1. `check.mjs` exits 0.\n\n## Changes\n- change `check.mjs`: exits 0 (§1).\n";
  const slice = await writeArtifact(prism, "docs/plans/reports/slice.md", design);
  const revision = async () => ok(await prism.call("get_initiative", { initiative: "reports" })).revision;
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(), operations: [{ op: "propose_design", slug: "reports", operations: [{ op: "accept_design", slug: "reports", frozenTests: ["test/acceptance.test.mjs"], review: "none" }] }] }));
  assert.equal(ok(await prism.call("get_artifact", { path: "docs/plans/reports/slice.md" })).acceptedVersion ?? null, null, "a pending proposal accepts nothing");
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(), operations: [{ op: "accept_proposal", slug: "reports", reviewRequired: [] }] }));
  const plan = ok(await prism.call("get_artifact", { path: "docs/plans/reports/slice.md" }));
  assert.equal(plan.acceptedVersion, slice.version);
  assert.equal(plan.changedSinceAccepted, false);
});
