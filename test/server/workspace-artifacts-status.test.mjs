import assert from "node:assert/strict";
import os from "node:os";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { adrFile, browserRequest, checkout, git, isolateGit, ok, refused, requirementFile, reviewBrowser, server, text, today, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

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
const answer = (review, body) => browserRequest(review, "/api/gates/answer", { method: "POST", body });

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

test("clause 36: an answer is refused when the artifact changed since the gate was asked, or when Git names no user", async (context) => {
  const { api, prism } = await project(context);
  const created = await writeArtifact(prism, FILE, requirementFile("Billing"));
  const asked = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Billing." }] }));
  ok(await prism.call("update_artifact", { operations: [{ op: "edit", path: FILE, expectedVersion: created.version, edits: [{ oldText: "Something is missing.", newText: "Something else is missing." }] }] }));
  const review = await reviewBrowser(context, api);
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
