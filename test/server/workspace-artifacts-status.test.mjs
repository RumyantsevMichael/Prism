import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { deliverGateAnswers } from "../../dist/hooks/deliver-gate-answers.mjs";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { adrFile, answerGate, artifactConfig, browserRequest, checkout, cloneOf, commitFiles, eventually, git, isolateGit, notes, ok, READ_ONLY, refused, remoteFile, requirementFile, reviewBrowser, server, syncedWorkspace, text, today, version, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";
import { launch, openPage, skip as noBrowser } from "./fixtures/kit-browser.mjs";

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
  assert.deepEqual([listed.status, listed.recorded], ["Approved", "Draft"], "the item holds the status that approving writes and the recorded one");

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

// Every store file below the store's folder, by path, with its bytes, leaving out the store's own Git folder.
async function storeFiles(store) {
  const files = {};
  const walk = async (folder) => {
    for (const entry of await readdir(path.join(store, folder), { withFileTypes: true })) {
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (relative === ".git") continue;
      if (entry.isDirectory()) await walk(relative);
      else files[relative] = await readFile(path.join(store, relative), "utf8");
    }
  };
  await walk("");
  return files;
}

// Copies the store files derived from one location, each under its own top folder as clause 3 derives it, to another location, as a damaged sync or a move_scope stopped between its writes and its removals leaves them.
// derivedOnly leaves the artifact itself under artifacts/ as it is and copies only what Prism keeps about it.
async function copyLocation(store, from, to, { derivedOnly = false } = {}) {
  for (const [file, bytes] of Object.entries(await storeFiles(store))) {
    const [top, ...rest] = file.split("/");
    const below = rest.join("/");
    if (derivedOnly && top === "artifacts") continue;
    if (below !== from && !below.startsWith(`${from}/`)) continue;
    const copy = path.join(store, top, `${to}${below.slice(from.length)}`);
    await mkdir(path.dirname(copy), { recursive: true });
    await writeFile(copy, bytes);
  }
}

test("clause 34: an approval id that the pending gates of two artifacts share names no single gate, so answering it is refused and changes no file of the store", async (context) => {
  const { place, api, prism } = await project(context);
  const other = "docs/requirements/alpha.md";
  await writeArtifact(prism, other, requirementFile("Alpha"));
  const written = await writeArtifact(prism, FILE, requirementFile("Billing"));
  const gate = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, question: "Approve billing?", context: "Billing." }] })).artifacts[0].gate;
  // A damaged sync gives alpha.md the status record of billing.md, pending gate and all.
  await copyLocation(place.store, "requirements/billing.md", "requirements/alpha.md", { derivedOnly: true });
  const before = await storeFiles(place.store);
  const review = await reviewBrowser(context, api);
  const cards = (await pendingApprovals(review)).filter((item) => item.id === gate);
  assert.deepEqual(cards.map((item) => item.artifact.path).sort(), [other, FILE], "Attention lists each gate that holds the id");

  const listed = await approvalActions(review, gate);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const [action] = listed.body.actions;
  assert.deepEqual([listed.body.actions.length, action.id, action.available, action.revision], [1, "gate.answer", false, null], "the listing shows the answer unavailable, with no revision to answer against");
  assert.match(action.reason, /alpha\.md/);
  assert.match(action.reason, /billing\.md/);
  for (const revision of [written.version, null, version("any bytes")]) {
    const applied = await apply(review, { action: "gate.answer", target: `approval:${gate}`, input: { choice: "approve" }, revision });
    assert.deepEqual([applied.status, applied.body.code], [409, "approval_ambiguous"], JSON.stringify(applied.body));
    assert.match(applied.body.message, /alpha\.md[\s\S]*billing\.md|billing\.md[\s\S]*alpha\.md/, "the refusal names both artifacts");
  }
  assert.deepEqual(await storeFiles(place.store), before, "a refused answer changes no file of the store");
  assert.equal(ok(await prism.call("get_artifact", { path: FILE })).status, "Draft");
  assert.equal(ok(await prism.call("get_artifact", { path: other })).status, "Draft");
});

test("clause 34: an approval id that the pending gates of one path in two scopes share is refused, and neither copy is approved", async (context) => {
  const { place, api, prism } = await project(context);
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  const gate = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, question: "Approve billing?", context: "Billing." }] })).artifacts[0].gate;
  // A move_scope into the repository scope that stopped after its writes leaves the artifact and its status record in both scopes.
  await copyLocation(place.store, "requirements/billing.md", "repositories/api/requirements/billing.md");
  const before = await storeFiles(place.store);
  const review = await reviewBrowser(context, api);
  const cards = (await pendingApprovals(review)).filter((item) => item.id === gate);
  assert.deepEqual(cards.map((item) => item.artifact.scope.label).sort(), ["api", "workspace"], "Attention lists the gate in each scope");
  const [action] = (await approvalActions(review, gate)).body.actions;
  assert.deepEqual([action.available, action.revision], [false, null]);
  assert.match(action.reason, /\bapi\b/);
  assert.match(action.reason, /workspace/);
  const repositoryCopy = ok(await prism.call("get_artifact", { path: FILE, scope: "repository" }));
  const applied = await apply(review, { action: "gate.answer", target: `approval:${gate}`, input: { choice: "approve" }, revision: repositoryCopy.version });
  assert.deepEqual([applied.status, applied.body.code], [409, "approval_ambiguous"], JSON.stringify(applied.body));
  assert.deepEqual(await storeFiles(place.store), before, "a refused answer changes no file of the store");
  assert.deepEqual([ok(await prism.call("get_artifact", { path: FILE, scope: "repository" })).status, ok(await prism.call("get_artifact", { path: FILE, scope: "workspace" })).status], ["Draft", "Draft"]);
  assert.equal((await pendingApprovals(review)).filter((item) => item.id === gate).length, 2, "both gates stay pending");
});

test("clause 34: while the store is unavailable or the repository name is refused, the actions routes answer an approval target with 503 and the refusal of an artifact read", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { store: "../missing-store", paths: ["- Requirements: docs/requirements"] });
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api);
  const read = refused(await prism.call("get_artifact", { path: FILE }), "store_unavailable");
  const review = await reviewBrowser(context, api);
  const target = "approval:approval-0123456789ab";
  const body = { action: "gate.answer", target, input: { choice: "approve" }, revision: version("any bytes") };
  const listed = await approvalActions(review, "approval-0123456789ab");
  assert.deepEqual([listed.status, listed.body.code], [503, "store_unavailable"], JSON.stringify(listed.body));
  assert.match(listed.body.message, /\.\.\/missing-store/, "the answer names the store as configured");
  const applied = await apply(review, body);
  assert.deepEqual([applied.status, applied.body.code], [503, "store_unavailable"], JSON.stringify(applied.body));
  assert.equal(applied.body.message, read.message, "the message is the refusal of an artifact read");
  assert.match(applied.body.message, /\.\.\/missing-store/);
  assert.deepEqual([(await apply(review, body, { Origin: "http://evil.example" })).status, (await apply(review, body, READ_ONLY)).status], [403, 403], "the page checks come first");
  assert.equal(await text(path.join(api, "docs/requirements/billing.md")), null, "nothing was written into the checkout");

  const web = await checkout(place, "web");
  await commitFiles(web, { ".prism/workflow.md": "## Paths\n- Requirements: docs/requirements\n\n## Workspace\n- Store: ../store\n" }, "name no repository");
  const webPrism = await server(context, place, web);
  const unnamed = await webPrism.call("get_artifact", { path: FILE });
  const code = unnamed.error?.data?.code;
  assert.equal(typeof code, "string", "get_artifact refuses in a checkout without a repository name");
  const webReview = await reviewBrowser(context, web);
  const webListed = await approvalActions(webReview, "approval-0123456789ab");
  assert.deepEqual([webListed.status, webListed.body.code], [503, code], JSON.stringify(webListed.body));
  const webApplied = await apply(webReview, body);
  assert.deepEqual([webApplied.status, webApplied.body.code], [503, code], JSON.stringify(webApplied.body));
});

// Reads named events from a viewer stream, as a connected tab receives them, until it has seen count of them.
function viewerEvents(context, url, name, count) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const request = http.get(url, (response) => {
      context.after(() => response.destroy());
      let buffer = "";
      response.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event === name) {
            seen.push(JSON.parse(data));
            if (seen.length === count) resolve(seen);
          }
        }
      });
    });
    request.once("error", reject);
    setTimeout(() => reject(new Error(`Saw ${seen.length} ${name} events.`)), 8000).unref();
  });
}

const recentChanges = async (review) => (await browserRequest(review, "/api/entity?ref=attention")).body.data.recentChanges;

test("clause 34: every applied approval shows in Attention's recent changes of each checkout that sees the artifact, and reaches every connected tab as it is applied", async (context) => {
  const { place, api, prism } = await project(context);
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  await writeArtifact(prism, "docs/requirements/other.md", requirementFile("Other"));
  const first = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Billing." }] })).artifacts[0].gate;
  const second = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: "docs/requirements/other.md", context: "Other." }] })).artifacts[0].gate;
  const review = await reviewBrowser(context, api);
  const scope = (await pendingApprovals(review)).find((item) => item.id === first).artifact.scope;
  const tabs = [viewerEvents(context, `${review.baseUrl}/api/events`, "action", 2), viewerEvents(context, `${review.baseUrl}/api/events`, "action", 2)];
  await new Promise((resolve) => setTimeout(resolve, 200));

  const approved = await answer(review, { id: first, choice: "approve", note: null });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  await new Promise((resolve) => setTimeout(resolve, 15));
  const changes = await answer(review, { id: second, choice: "request-changes", note: "Name the currency." });
  assert.equal(changes.status, 200, JSON.stringify(changes.body));
  const expected = [
    { ...changes.body.applied, initiative: null, artifact: { path: "docs/requirements/other.md", scope } },
    { ...approved.body.applied, initiative: null, artifact: { path: FILE, scope } }
  ];

  assert.deepEqual(await pendingApprovals(review), [], "both gates have left Needs you");
  const listed = await recentChanges(review);
  assert.deepEqual(listed.filter((entry) => entry.action === "gate.answer"), expected, "the asking checkout lists both answers, newest first, read from the status records");
  for (const events of await Promise.all(tabs)) assert.deepEqual(events, [expected[1], expected[0]], "each connected tab receives each answer as it is applied");

  // Another checkout of the workspace sees the workspace artifacts, so its Attention lists the answers too.
  const web = await checkout(place, "web");
  const webReview = await reviewBrowser(context, web);
  assert.deepEqual((await recentChanges(webReview)).filter((entry) => entry.action === "gate.answer"), expected);
});

// Every text of a status that approving writes, up to the 200 characters that ask_approval accepts.
const LONG_STATUSES = [
  "Approved for the EU pilot only, pending legal review of data retention",
  "Approved for the EU pilot only, pending legal review of data retention in Germany and France, and the billing team's sign-off",
  `Approved for the EU pilot only, pending legal review of data retention in Germany and France, the billing team's sign-off, and a second reading by the security group before any ${"x".repeat(200)}`.slice(0, 200)
];

// A tab on a review browser's page for the view that ref names, which reads what that browser serves and receives its events.
const pageUrl = (review, ref) => `${review.baseUrl.replace(/\/$/, "")}/review?artifact=${encodeURIComponent(ref)}`;

// Whether a text shows whole on the page: some text node of the card that names the file is exactly it, visible, and inside every box above it that clips its content.
const shownWhole = (page, filePath, wanted) => page.evaluate(({ filePath, wanted }) => {
  const parentOf = (node) => node.assignedSlot ?? node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
  const texts = function* (root) {
    const nodes = [root];
    while (nodes.length) {
      const node = nodes.shift();
      if (node.nodeType === Node.TEXT_NODE) yield node;
      if (node.shadowRoot) nodes.push(...node.shadowRoot.childNodes);
      nodes.push(...node.childNodes);
    }
  };
  const cards = [...document.querySelectorAll("article")].filter((card) => card.textContent.includes(filePath));
  for (const card of cards) {
    for (const node of texts(card)) {
      if (node.data.trim() !== wanted) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      let whole = true;
      for (let element = parentOf(node); element && whole; element = parentOf(element)) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || element.classList?.contains("sr-only")) whole = false;
        const clips = [style.overflowX, style.overflowY].some((value) => value !== "visible");
        if (whole && clips) {
          const edge = element.getBoundingClientRect();
          // A glyph's box reaches a little above and below a tight line box, while a clipped line or word is a whole line or more.
          whole = box.left >= edge.left - 1 && box.right <= edge.right + 1 && box.top >= edge.top - 6 && box.bottom <= edge.bottom + 6;
        }
        if (element === card) break;
      }
      if (whole) return true;
    }
  }
  return false;
}, { filePath, wanted });

test("clause 34: the approval card shows the whole status that approving writes at every window width", { skip: noBrowser }, async (context) => {
  const { api, prism } = await project(context);
  const files = [];
  for (const [index, status] of LONG_STATUSES.entries()) {
    const file = `docs/requirements/long-${index}.md`;
    files.push(file);
    await writeArtifact(prism, file, requirementFile(`Long ${index}`));
    ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: file, status, question: "Approve this file?", context: "A long status." }] }));
  }
  const review = await reviewBrowser(context, api);
  const browser = await launch(context);
  const cut = [];
  for (const width of [390, 1440]) {
    const page = await openPage(browser, pageUrl(review, "attention"), { viewport: { width, height: 900 } });
    await page.waitForFunction((file) => document.body.textContent.includes(file) || [...document.querySelectorAll("*")].some((node) => node.shadowRoot?.textContent.includes(file)), files[0], { timeout: 10000 }).catch(() => {});
    for (const [index, status] of LONG_STATUSES.entries()) {
      if (!(await shownWhole(page, files[index], status))) cut.push(`${width}px: the ${status.length}-character status of ${files[index]}`);
      if (!(await shownWhole(page, files[index], "Draft"))) cut.push(`${width}px: the recorded status of ${files[index]}`);
    }
    await page.close();
  }
  assert.deepEqual(cut, [], "no status is cut off or hidden");
});

test("clause 34: a tab that watches Attention keeps an approval under Recent changes after its gate leaves Needs you", { skip: noBrowser }, async (context) => {
  const { api, prism } = await project(context);
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  const gate = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, question: "Approve billing?", context: "Billing." }] })).artifacts[0].gate;
  const review = await reviewBrowser(context, api);
  const browser = await launch(context);
  const watcher = await openPage(browser, pageUrl(review, "attention"), { viewport: { width: 1440, height: 900 } });
  await watcher.waitForFunction((file) => document.body.textContent.includes(file) || [...document.querySelectorAll("*")].some((node) => node.shadowRoot?.textContent.includes(file)), FILE, { timeout: 10000 }).catch(() => {});
  const recent = () => watcher.evaluate(() => document.querySelector("[data-recent-changes]")?.textContent ?? "");
  // Another tab of the same page answers the gate, as the person does on the card.
  assert.equal((await answer(review, { id: gate, choice: "approve", note: null })).status, 200);
  const samples = [];
  await watcher.waitForFunction((file) => document.querySelector("[data-recent-changes]")?.textContent.includes(file), FILE, { timeout: 10000 }).catch(() => {});
  for (let sample = 0; sample < 6; sample += 1) {
    samples.push((await recent()).includes(FILE));
    await watcher.waitForTimeout(500);
  }
  await watcher.reload();
  await watcher.waitForFunction((file) => document.querySelector("[data-recent-changes]")?.textContent.includes(file), FILE, { timeout: 10000 }).catch(() => {});
  samples.push((await recent()).includes(FILE));
  assert.deepEqual(samples, samples.map(() => true), "Recent changes names the approved file at every sample and after a reload");
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

// Two machines whose stores share one remote, each with a checkout of repository api: machine a writes the requirement, asks its approval, and opens the review page, and machine b reads it with its pending gate once its store pulled them.
// Machine a then reads the requirement once more, so its store does not pull again before machine b's change reaches the remote and the person on machine a answers.
async function twoMachines(context) {
  const machines = await syncedWorkspace(context);
  const apiA = await checkout(machines.a, "api");
  git(apiA, "config", "user.name", "Ada Reviewer");
  const onA = await server(context, machines.a, apiA);
  const created = await writeArtifact(onA, FILE, requirementFile("Billing"));
  const gate = ok(await onA.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "They define how invoices are totalled." }] })).artifacts[0].gate;
  const reviewA = await reviewBrowser(context, apiA);
  await eventually(() => (remoteFile(machines.remote, "artifact-status/requirements/billing.md/status.json") ?? "").includes(gate), 40000, "the requirement and its gate reaching the remote");
  const apiB = await cloneOf(apiA, machines.parent, "api-b", { remote: "https://github.com/acme/api.git" });
  await commitFiles(apiB, { ".prism/workflow.md": artifactConfig({ repository: "api", sync: "on", store: "../store-b" }) });
  git(apiB, "config", "user.name", "Bob Mover");
  const onB = await server(context, machines.b, apiB);
  await eventually(async () => {
    const response = await onB.call("get_artifact", { path: FILE });
    return !response.error && response.result.structuredContent?.version === created.version;
  }, 40000, "machine b pulling the requirement");
  ok(await onA.call("get_artifact", { path: FILE }));
  return { machines, onA, onB, reviewA, created, gate };
}

// The store paths on the remote's main branch.
const remoteTree = (remote) => git(remote, "ls-tree", "-r", "--name-only", "main").split("\n").filter(Boolean);

// Every file a sync saved under a store's sync folder, as absolute paths.
async function savedCopies(store) {
  const folder = path.join(store, ".prism-sync", "conflicts");
  const found = [];
  const visit = async (relative) => {
    let entries = [];
    try { entries = await readdir(path.join(folder, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(child);
      else found.push(path.join(folder, child));
    }
  };
  await visit("");
  return found;
}

// The identity file of a store location, artifact-identity/<location>, as JSON, or null when the store holds none.
const identityAt = async (store, location) => {
  const bytes = await readFile(path.join(store, "artifact-identity", ...location.split("/")), "utf8").catch(() => null);
  return bytes === null ? null : JSON.parse(bytes);
};
const IDENTITY = /^[0-9a-f]{32}$/;

test("clauses 25 and 31: an approval answered on one machine while another moves the requirement lands on the moved requirement and its status record on both machines", { timeout: 240000 }, async (context) => {
  const { machines, onA, onB, reviewA, created, gate } = await twoMachines(context);
  const before = await identityAt(machines.storeB, "requirements/billing.md");
  assert.match(before?.id ?? "", IDENTITY, "creating the requirement wrote its identity, which machine b pulled");
  const moved = ok(await onB.call("update_artifact", { operations: [{ op: "move_scope", path: FILE, expectedVersion: created.version, scope: "repository" }] })).artifacts[0];
  assert.equal(moved.scope.label, "api");
  assert.deepEqual(await identityAt(machines.storeB, "repositories/api/requirements/billing.md"), before, "the move takes the identity to the new location");
  assert.equal(await identityAt(machines.storeB, "requirements/billing.md"), null, "and leaves none at the old location");
  assert.deepEqual(await readdir(path.join(machines.storeB, "artifact-comments", "requirements", "billing.md")).catch(() => []), [], "the move leaves no forward or other file at the old location");
  await eventually(() => remoteFile(machines.remote, "artifact-status/repositories/api/requirements/billing.md/status.json") !== null, 40000, "the move reaching the remote");

  // The person on machine a approves on the page they have open, whose store still holds the requirement and its gate in the workspace scope.
  const answered = await answerGate(reviewA, { id: gate, choice: "approve" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const approvedText = requirementFile("Billing", "Approved", today());
  const landed = (read) => read.scope.label === "api" && read.status === "Approved" && read.content === approvedText ? read : null;
  for (const [machine, prism] of [["a", onA], ["b", onB]]) {
    const read = await eventually(async () => landed(ok(await prism.call("get_artifact", { path: FILE }))), 90000, `machine ${machine} showing the approval on the moved requirement`);
    assert.equal(read.statusMismatch, undefined, "the written and the recorded status agree");
    assert.equal(read.approval.gate, gate);
    assert.equal(read.approval.by.name, "Ada Reviewer");
    assert.equal(read.latestAnswer.entry, answered.body.applied.id);
    assert.equal(read.acceptedVersion, version(approvedText));
    assert.equal(read.changedSinceAccepted, false);
  }
  await eventually(() => remoteFile(machines.remote, "artifacts/repositories/api/requirements/billing.md") === approvedText.trimEnd(), 40000, "the approved requirement reaching the remote");
  const tree = remoteTree(machines.remote);
  assert.equal(tree.includes("artifacts/requirements/billing.md"), false, "the requirement stays moved");
  assert.equal(tree.includes("artifact-status/requirements/billing.md/status.json"), false, "no status record stays at the old location");
  assert.deepEqual(await savedCopies(machines.storeA), [], "nothing was saved aside on machine a");
  assert.deepEqual(await savedCopies(machines.storeB), [], "nothing was saved aside on machine b");
  const recent = (await recentChanges(reviewA)).filter((entry) => entry.id === answered.body.applied.id);
  assert.deepEqual(recent.map((entry) => [entry.artifact.path, entry.artifact.scope.label]), [[FILE, "api"]], "recent changes name the scope that holds the requirement");
  assert.deepEqual(await pendingApprovals(reviewA), [], "the answered gate has left Needs you");
});

test("clauses 25 and 31: when the moved requirement's status record also changed, the upstream record stays, the approval's record is saved and named, and neither is lost", { timeout: 240000 }, async (context) => {
  const { machines, onA, onB, reviewA, created, gate } = await twoMachines(context);
  ok(await onB.call("update_artifact", { operations: [{ op: "move_scope", path: FILE, expectedVersion: created.version, scope: "repository" }] }));
  const second = ok(await onB.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, context: "Asked again after the move." }] })).artifacts[0].gate;
  await eventually(() => (remoteFile(machines.remote, "artifact-status/repositories/api/requirements/billing.md/status.json") ?? "").includes(second), 40000, "the move and the new gate reaching the remote");

  const answered = await answerGate(reviewA, { id: gate, choice: "approve" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const [saved] = await eventually(async () => {
    const copies = (await savedCopies(machines.storeA)).filter((file) => file.includes("artifact-status"));
    return copies.length ? copies : null;
  }, 90000, "machine a's sync saving its status record aside");
  const local = JSON.parse(await readFile(saved, "utf8"));
  assert.equal(local.status, "Approved", "the saved copy holds machine a's answered record");
  assert.equal(local.closed.find((item) => item.id === gate)?.answer?.entry, answered.body.applied.id);

  // Every result of machine a's server after the save is kept, since the first of them is the next result, which names the saved copy once.
  const resultsOfA = [];
  const approvedText = requirementFile("Billing", "Approved", today());
  for (const [machine, prism] of [["a", onA], ["b", onB]]) {
    const read = await eventually(async () => {
      const response = await prism.call("get_artifact", { path: FILE });
      if (prism === onA) resultsOfA.push(response);
      const value = ok(response);
      return value.scope.label === "api" && value.content === approvedText ? value : null;
    }, 90000, `machine ${machine} showing the merged requirement`);
    assert.equal(read.status, "Draft", "the upstream status record stays");
    assert.deepEqual([read.statusMismatch?.written, read.statusMismatch?.recorded], ["Approved", "Draft"], "the approval's status lines merged into the file and are reported against the kept record");
  }
  const tree = remoteTree(machines.remote);
  assert.equal(tree.includes("artifact-status/requirements/billing.md/status.json"), false, "no status record stays at the old location");
  assert.ok((remoteFile(machines.remote, "artifact-status/repositories/api/requirements/billing.md/status.json") ?? "").includes(second), "the moved requirement keeps its new gate");

  // The first result of machine a's server after the save names the record's file, its scope, and the saved copy, and no later result names it again.
  const later = await onA.call("get_artifact", {});
  ok(later);
  resultsOfA.push(later);
  const naming = resultsOfA.filter((response) => notes(response).includes(saved));
  assert.equal(naming.length, 1, "exactly one result names the saved copy");
  assert.equal(naming[0], resultsOfA[0], "the first result after the save names it");
  const reported = notes(naming[0]);
  assert.ok(reported.includes(FILE), "the next result names the requirement's path");
  assert.match(reported, /workspace|api/, "the next result names the scope");
});

// The text that machine b writes at the path of the requirement it removed: the same template with other requirement text, which nobody reviewed.
const LATER = requirementFile("Billing").replace("The system shall do the thing.", "The system shall do something else that nobody reviewed.");

for (const [moving, how] of [[false, "at its own path"], [true, "after moving it to another scope"]]) {
  test(`clauses 25 and 31: an approval answered on one machine on a requirement that another machine removed and then wrote again ${how} reaches no later file, and is saved and named`, { timeout: 240000 }, async (context) => {
    const { machines, onA, onB, reviewA, created, gate } = await twoMachines(context);
    const location = moving ? "repositories/api/requirements/billing.md" : "requirements/billing.md";
    const removedIdentity = await identityAt(machines.storeB, "requirements/billing.md");
    let current = created.version;
    if (moving) current = ok(await onB.call("update_artifact", { operations: [{ op: "move_scope", path: FILE, expectedVersion: current, scope: "repository" }] })).artifacts[0].version;
    ok(await onB.call("update_artifact", { operations: [{ op: "remove", path: FILE, expectedVersion: current }] }));
    assert.equal(await identityAt(machines.storeB, location), null, "the removal removes the identity");
    const later = ok(await onB.call("update_artifact", { operations: [{ op: "write", path: FILE, content: LATER, expectedVersion: null, ...(moving ? { scope: "repository" } : {}) }] })).artifacts[0];
    const laterIdentity = await identityAt(machines.storeB, location);
    assert.match(laterIdentity?.id ?? "", IDENTITY, "the later file has an identity of its own");
    assert.notEqual(laterIdentity.id, removedIdentity.id, "which is not the removed file's");
    await eventually(() => (remoteFile(machines.remote, `artifacts/${location}`) ?? "").includes("nobody reviewed"), 40000, "the later file reaching the remote");

    // The person on machine a approves on the page they have open, whose store still holds the removed requirement and its gate.
    const answered = await answerGate(reviewA, { id: gate, choice: "approve" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    const resultsOfA = [];
    const read = await eventually(async () => {
      const response = await onA.call("get_artifact", { path: FILE });
      resultsOfA.push(response);
      const value = ok(response);
      return value.scope.label === (moving ? "api" : "workspace") && value.content.includes("nobody reviewed") && (await savedCopies(machines.storeA)).some((file) => file.includes("artifact-status")) ? value : null;
    }, 90000, "machine a's sync bringing the later file and saving its answered record aside");
    assert.equal(read.content, LATER, "the later file keeps its own text, without the approval's status lines");
    assert.equal(read.version, later.version);
    assert.equal(read.status, "Draft", "the later file keeps its own recorded status");
    assert.equal(read.statusMismatch, undefined);
    assert.equal(read.approval ?? null, null, "the later file shows no approval");
    assert.equal(read.latestAnswer ?? null, null, "the later file shows no answer");
    assert.equal(read.acceptedVersion ?? null, null, "nothing accepted the later file");

    const copies = await savedCopies(machines.storeA);
    const record = copies.find((file) => file.endsWith(path.join("artifact-status", "requirements", "billing.md", "status.json")));
    assert.ok(record, "machine a saved its answered status record");
    assert.equal(JSON.parse(await readFile(record, "utf8")).closed.find((item) => item.id === gate)?.answer?.entry, answered.body.applied.id, "the saved record holds the answer");
    const approved = copies.find((file) => file.endsWith(path.join("artifacts", "requirements", "billing.md")));
    assert.ok(approved, "machine a saved the approved text of the removed requirement");
    assert.equal(await readFile(approved, "utf8"), requirementFile("Billing", "Approved", today()));
    ok(await onA.call("get_artifact", {}).then((response) => { resultsOfA.push(response); return response; }));
    assert.equal(resultsOfA.filter((response) => notes(response).includes(record)).length, 1, "exactly one result names the saved status record");
    assert.ok(notes(resultsOfA.find((response) => notes(response).includes(record))).includes(FILE), "the result names the requirement's path");
    assert.ok(resultsOfA.some((response) => notes(response).includes(approved)), "a result names the saved text");

    await eventually(() => git(machines.remote, "log", "--format=%s", "main").includes("prism: merge records"), 40000, "machine a's merge reaching the remote");
    assert.equal((remoteFile(machines.remote, `artifacts/${location}`) ?? "").includes("Status: Approved"), false, "the remote's later file holds no approved status line");
    assert.equal((remoteFile(machines.remote, `artifact-status/${location}/status.json`) ?? "").includes(answered.body.applied.id), false, "the remote's later status record holds no answer");
    if (moving) assert.equal(remoteTree(machines.remote).some((file) => file.endsWith("requirements/billing.md") && !file.includes("repositories/api/")), false, "nothing of the removed requirement stays at its first location");
    const onBRead = await eventually(async () => {
      const value = ok(await onB.call("get_artifact", { path: FILE }));
      return git(machines.storeB, "log", "--format=%s", "HEAD").includes("prism: merge records") ? value : null;
    }, 90000, "machine b pulling machine a's merge");
    assert.deepEqual([onBRead.content, onBRead.status, onBRead.approval ?? null], [LATER, "Draft", null], "machine b shows the later file as it wrote it");
  });
}

// Two clones a and b of one bare store remote whose first commit holds files, each synced on demand by the test with no Prism server, as a store sync runs.
async function rawStores(context, files) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-identities-")));
  context.after(() => rm(parent, { recursive: true, force: true }));
  git(parent, "init", "-q", "--bare", "-b", "main", "remote.git");
  const remote = path.join(parent, "remote.git");
  git(parent, "clone", "-q", remote, "a");
  const a = path.join(parent, "a");
  git(a, "checkout", "-q", "-b", "main");
  await put(a, { "README.md": "Prism store\n", ...files });
  push(a, "init", true);
  git(parent, "clone", "-q", remote, "b");
  return { remote, a, b: path.join(parent, "b") };
}
async function put(root, files) {
  for (const [file, contents] of Object.entries(files)) {
    if (contents === null) { await rm(path.join(root, file), { force: true }); continue; }
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
}
function push(root, message, first = false) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  git(root, "push", "-q", ...(first ? ["-u"] : []), "origin", "main");
}
const identityFile = (id) => `${JSON.stringify({ id })}\n`;
const record = (value) => `${JSON.stringify(value)}\n`;
const atHead = (store, file) => { try { return git(store, "show", `HEAD:${file}`); } catch { return null; } };
const headTree = (store) => git(store, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
// The text of each file a sync saved in a store, by its path below the saved stamp.
async function savedBelow(store) {
  const found = {};
  for (const file of await savedCopies(store)) found[path.relative(path.join(store, ".prism-sync", "conflicts"), file).split(path.sep).slice(1).join("/")] = await readFile(file, "utf8");
  return found;
}
const { syncRecordStoreNow, unsafeStoreEntry } = await import("../../dist/server/workflow/record-store-sync.mjs");
const OLD_ID = "0123456789abcdef0123456789abcdef";
const LATER_ID = "fedcba9876543210fedcba9876543210";

test("clause 25: where one machine removed a file and wrote another at its path while the upstream changed the first, the location keeps the upstream's file whole and saves the later one", async (context) => {
  const approvedText = requirementFile("Billing", "Approved", "2026-11-09");
  const { remote, a, b } = await rawStores(context, {
    "artifacts/requirements/billing.md": requirementFile("Billing"),
    "artifact-identity/requirements/billing.md": identityFile(OLD_ID),
    "artifact-status/requirements/billing.md/status.json": record({ status: "Draft", by: "base" })
  });
  // The upstream approves the file; this machine removed it and wrote other text at its path, with an identity of its own.
  await put(a, { "artifacts/requirements/billing.md": approvedText, "artifact-status/requirements/billing.md/status.json": record({ status: "Approved", by: "a" }) });
  push(a, "approve");
  await put(b, { "artifacts/requirements/billing.md": LATER, "artifact-identity/requirements/billing.md": identityFile(LATER_ID), "artifact-status/requirements/billing.md/status.json": record({ status: "Draft", by: "b" }) });
  const synced = await syncRecordStoreNow(b);
  assert.equal(synced.state, "conflicts", synced.message);
  assert.equal(atHead(b, "artifacts/requirements/billing.md"), approvedText.trimEnd(), "the upstream's file keeps the location, with no line of the later file merged in");
  assert.deepEqual(JSON.parse(atHead(b, "artifact-status/requirements/billing.md/status.json")), { status: "Approved", by: "a" }, "with its status record");
  assert.deepEqual(JSON.parse(atHead(b, "artifact-identity/requirements/billing.md")), { id: OLD_ID }, "and its identity");
  const saved = await savedBelow(b);
  assert.equal(saved["artifacts/requirements/billing.md"], LATER, "the later file's text is saved");
  assert.deepEqual(JSON.parse(saved["artifact-status/requirements/billing.md/status.json"]), { status: "Draft", by: "b" }, "and its status record");
  assert.ok(JSON.stringify(synced.conflicts).includes("artifacts/requirements/billing.md"), "the sync names the saved file");
  assert.equal(git(remote, "show", "main:artifacts/requirements/billing.md"), approvedText.trimEnd(), "the remote keeps the approved file");
});

test("clause 25: an artifact stored without an identity file has the identity its location gives, so a move of it is followed and a later file at its path is not", async (context) => {
  const given = (location) => createHash("sha256").update(location, "utf8").digest("hex").slice(0, 32);
  const { a, b } = await rawStores(context, {
    "artifacts/requirements/billing.md": requirementFile("Billing"),
    "artifacts/requirements/tax.md": requirementFile("Tax")
  });
  // The upstream moves billing.md to the repository scope, writing the identity its old location gave it, and removes tax.md and writes another file there, with a new identity.
  await put(a, {
    "artifacts/requirements/billing.md": null,
    "artifacts/repositories/api/requirements/billing.md": requirementFile("Billing"),
    "artifact-identity/repositories/api/requirements/billing.md": identityFile(given("requirements/billing.md")),
    "artifacts/requirements/tax.md": requirementFile("Tax").replace("do the thing", "do another thing"),
    "artifact-identity/requirements/tax.md": identityFile(LATER_ID)
  });
  push(a, "move billing, write tax again");
  // This machine recorded an approval of each file at its old location.
  await put(b, {
    "artifact-status/requirements/billing.md/status.json": record({ status: "Approved", of: "billing" }),
    "artifact-status/requirements/tax.md/status.json": record({ status: "Approved", of: "tax" })
  });
  const synced = await syncRecordStoreNow(b);
  assert.notEqual(synced.state, "merge_failed", synced.message);
  assert.deepEqual(JSON.parse(atHead(b, "artifact-status/repositories/api/requirements/billing.md/status.json") ?? "null"), { status: "Approved", of: "billing" }, "the record follows the moved file");
  assert.equal(atHead(b, "artifact-status/requirements/billing.md/status.json"), null, "and stays nowhere else");
  assert.equal(atHead(b, "artifact-status/requirements/tax.md/status.json"), null, "the later tax file takes no record of the removed one");
  const saved = await savedBelow(b);
  assert.deepEqual(Object.keys(saved), ["artifact-status/requirements/tax.md/status.json"], "only the removed file's record is saved");
  assert.ok(JSON.stringify(synced.conflicts).includes("artifact-status/requirements/tax.md/status.json"), "and named");
});

test("clause 25: a status record whose placement at a moved artifact's location would exceed the store's path bounds is saved and named, and every other one is placed", async (context) => {
  const name = (letter) => letter.repeat(150);
  // A location of 490 characters: its artifact and identity paths fit 512 bytes, and its status record's path does not.
  const deep = `requirements/${name("a")}/${name("b")}/${name("c")}/`;
  const LONG = `${deep}${"x".repeat(490 - deep.length - 3)}.md`;
  assert.equal(LONG.length, 490);
  const { remote, a, b } = await rawStores(context, {
    "artifacts/requirements/billing.md": requirementFile("Billing"),
    "artifact-identity/requirements/billing.md": identityFile(OLD_ID),
    "artifacts/requirements/tax.md": requirementFile("Tax"),
    "artifact-identity/requirements/tax.md": identityFile(LATER_ID)
  });
  await put(a, {
    "artifacts/requirements/billing.md": null, "artifact-identity/requirements/billing.md": null,
    [`artifacts/${LONG}`]: requirementFile("Billing"), [`artifact-identity/${LONG}`]: identityFile(OLD_ID),
    "artifacts/requirements/tax.md": null, "artifact-identity/requirements/tax.md": null,
    "artifacts/repositories/api/requirements/tax.md": requirementFile("Tax"), "artifact-identity/repositories/api/requirements/tax.md": identityFile(LATER_ID)
  });
  push(a, "move both");
  assert.equal(await unsafeStoreEntry(a, "HEAD"), null, "the upstream holds only paths that every store shares");
  await put(b, {
    "artifact-status/requirements/billing.md/status.json": record({ status: "Approved", of: "billing" }),
    "artifact-status/requirements/tax.md/status.json": record({ status: "Approved", of: "tax" })
  });
  const first = await syncRecordStoreNow(b);
  assert.notEqual(first.state, "merge_failed", first.message);
  assert.equal(await unsafeStoreEntry(b, "HEAD"), null, "the merge holds no path that a store cannot share");
  assert.equal(headTree(b).some((file) => file.startsWith(`artifact-status/${LONG.slice(0, 40)}`)), false, "the long record is not placed");
  assert.deepEqual(JSON.parse(atHead(b, "artifact-status/repositories/api/requirements/tax.md/status.json") ?? "null"), { status: "Approved", of: "tax" }, "the record of the file moved to a short location is placed");
  const saved = await savedBelow(b);
  assert.deepEqual(JSON.parse(saved["artifact-status/requirements/billing.md/status.json"] ?? "null"), { status: "Approved", of: "billing" }, "the record that cannot be placed is saved");
  assert.ok(JSON.stringify(first.conflicts).includes("artifact-status/requirements/billing.md/status.json"), "and named");
  const second = await syncRecordStoreNow(b);
  assert.equal(second.state, "ok", second.message);
  assert.equal(git(remote, "ls-tree", "-r", "--name-only", "main").split("\n").some((file) => Buffer.byteLength(file) > 512), false, "the remote holds no path beyond the bounds");
});

const given = (location) => createHash("sha256").update(location, "utf8").digest("hex").slice(0, 32);

test("clause 25: no two artifacts of a tree share an identity, also where crafted identity files name other locations' identities, so a merge removes none and keeps this machine's edit", async (context) => {
  // b.md's identity file holds the identity that a.md's location gives, and c.md's the identity that b.md's location gives.
  const [A, B, C] = ["requirements/a.md", "requirements/b.md", "requirements/c.md"];
  const status = (location) => `artifact-status/${location}/status.json`;
  const { remote, a, b } = await rawStores(context, {
    [`artifacts/${A}`]: requirementFile("A"), [`artifacts/${B}`]: requirementFile("B"), [`artifacts/${C}`]: requirementFile("C"),
    [`artifact-identity/${B}`]: identityFile(given(A)), [`artifact-identity/${C}`]: identityFile(given(B)),
    [status(B)]: record({ status: "Draft", of: "B" }), [status(C)]: record({ status: "Draft", of: "C" })
  });
  // This machine edits b.md; the upstream adds an unrelated file, so the sync merges.
  const edited = requirementFile("B").replace("do the thing", "do the thing that b asked");
  await put(b, { [`artifacts/${B}`]: edited });
  await put(a, { "artifacts/requirements/z.md": requirementFile("Z") });
  push(a, "unrelated");
  const synced = await syncRecordStoreNow(b);
  assert.notEqual(synced.state, "merge_failed", synced.message);
  for (const [location, text, of] of [[A, requirementFile("A"), null], [B, edited, "B"], [C, requirementFile("C"), "C"]]) {
    assert.equal(atHead(b, `artifacts/${location}`), text.trimEnd(), `${location} keeps its own bytes`);
    assert.equal(git(remote, "show", `main:artifacts/${location}`), text.trimEnd(), `and the remote holds them`);
    if (of) assert.equal(JSON.parse(atHead(b, status(location)) ?? "null")?.of, of, `${location} keeps its own status record`);
  }
  assert.deepEqual(await savedBelow(b), {}, "nothing needed saving");
});

test("clause 25: a sync refuses an upstream file where Prism keeps folders of identity files, as it refuses one where it keeps folders of status records", async (context) => {
  const { a, b } = await rawStores(context, { "artifacts/plans/foo/slice.md": "# Foo\n", "artifact-identity/plans/foo/slice.md": identityFile(OLD_ID) });
  // The upstream drops the identity folder of plans and writes a file in its place, which a fast-forward would write to every machine's disk.
  await rm(path.join(a, "artifact-identity", "plans"), { recursive: true, force: true });
  await put(a, { "artifact-identity/plans": identityFile(LATER_ID) });
  push(a, "a file where identity folders are");
  assert.equal((await unsafeStoreEntry(a, "HEAD"))?.path, "artifact-identity/plans", "the upstream holds an entry no store may hold");
  const synced = await syncRecordStoreNow(b);
  assert.equal(synced.state, "merge_failed", synced.message);
  assert.equal((await lstat(path.join(b, "artifact-identity", "plans")).catch(() => null))?.isFile() ?? false, false, "the file never reaches this machine");
  for (const [file, removed] of [["artifact-identity/repositories/api", "artifact-identity/plans"], ["artifact-identity/requirements", "artifact-identity/repositories/api"]]) {
    await put(a, { [removed]: null, [file]: identityFile(LATER_ID) });
    git(a, "add", "-A");
    git(a, "commit", "-q", "-m", `a file at ${file}`);
    assert.equal((await unsafeStoreEntry(a, "HEAD"))?.path, file, `${file} is no artifact location`);
  }
});

test("clause 25: an entry at an artifact's identity path that is no identity file, such as a folder a sync brought, never makes a create, move, or removal fail or half apply", async (context) => {
  const place = await workspace(context);
  const prism = await server(context, place, await checkout(place, "api"));
  const identityPath = (location) => path.join(place.store, "artifact-identity", ...location.split("/"));
  const strayFolder = async (location) => {
    await rm(identityPath(location), { recursive: true, force: true });
    await mkdir(identityPath(location), { recursive: true });
    await writeFile(path.join(identityPath(location), "x"), identityFile(LATER_ID));
  };
  const isIdentityFile = async (location) => (await lstat(identityPath(location)).catch(() => null))?.isFile() && IDENTITY.test(JSON.parse(await readFile(identityPath(location), "utf8")).id);

  // A removal over a folder at the identity path removes the artifact and leaves nothing at that path.
  const plan = "docs/plans/foo/slice.md";
  const written = await writeArtifact(prism, plan, "# Foo\n");
  await strayFolder("plans/foo/slice.md");
  ok(await prism.call("update_artifact", { operations: [{ op: "remove", path: plan, expectedVersion: written.version }] }));
  assert.equal(await lstat(identityPath("plans/foo/slice.md")).catch(() => null), null, "the removal leaves no entry at the identity path");
  refused(await prism.call("get_artifact", { path: plan }), "artifact_not_found");

  // A create over such a folder succeeds and writes an identity file there.
  await strayFolder("plans/foo/slice.md");
  await writeArtifact(prism, plan, "# Foo again\n");
  assert.ok(await isIdentityFile("plans/foo/slice.md"), "the create writes an identity file in place of the folder");

  // A create below a file that stands where an identity folder belongs succeeds too.
  await rm(identityPath("plans"), { recursive: true, force: true });
  await writeFile(identityPath("plans"), identityFile(OLD_ID));
  await writeArtifact(prism, "docs/plans/bar/slice.md", "# Bar\n");
  assert.ok(await isIdentityFile("plans/bar/slice.md"), "the create writes its identity below the stray file's path");

  // A move to another scope over a folder at the identity path carries a new identity and leaves nothing at the old path.
  const requirement = await writeArtifact(prism, FILE, requirementFile("Billing"));
  await strayFolder("requirements/billing.md");
  const moved = ok(await prism.call("update_artifact", { operations: [{ op: "move_scope", path: FILE, expectedVersion: requirement.version, scope: "repository" }] })).artifacts[0];
  assert.equal(moved.scope.label, "api");
  assert.equal(await lstat(identityPath("requirements/billing.md")).catch(() => null), null, "the move leaves no entry at the old identity path");
  assert.ok(await isIdentityFile("repositories/api/requirements/billing.md"), "and an identity file at the new one");
  assert.equal(ok(await prism.call("get_artifact", { path: FILE })).scope.label, "api");
});

test("clause 25: where the upstream removed one artifact and moved another onto its path, this machine's change to the moved one lands on it there", async (context) => {
  const [from, onto] = ["repositories/api/requirements/billing.md", "requirements/billing.md"];
  const status = (location) => `artifact-status/${location}/status.json`;
  const { remote, a, b } = await rawStores(context, {
    [`artifacts/${from}`]: requirementFile("Moved"), [`artifact-identity/${from}`]: identityFile(OLD_ID), [status(from)]: record({ status: "Draft", of: "moved" }),
    [`artifacts/${onto}`]: requirementFile("Removed"), [`artifact-identity/${onto}`]: identityFile(LATER_ID), [status(onto)]: record({ status: "Draft", of: "removed" })
  });
  // The upstream removes the workspace artifact and moves the repository's one onto its path with its identity and status record.
  await put(a, {
    [`artifacts/${from}`]: null, [`artifact-identity/${from}`]: null, [status(from)]: null,
    [`artifacts/${onto}`]: requirementFile("Moved"), [`artifact-identity/${onto}`]: identityFile(OLD_ID), [status(onto)]: record({ status: "Draft", of: "moved" })
  });
  push(a, "remove one, move the other onto its path");
  // This machine answers the moved artifact's approval at its old location.
  await put(b, { [status(from)]: record({ status: "Approved", of: "moved" }) });
  const synced = await syncRecordStoreNow(b);
  assert.notEqual(synced.state, "merge_failed", synced.message);
  assert.equal(atHead(b, `artifacts/${onto}`), requirementFile("Moved").trimEnd(), "the moved artifact holds the path");
  assert.deepEqual(JSON.parse(atHead(b, status(onto)) ?? "null"), { status: "Approved", of: "moved" }, "with this machine's change to its status record");
  assert.deepEqual(JSON.parse(atHead(b, `artifact-identity/${onto}`) ?? "null"), { id: OLD_ID }, "and its identity");
  assert.equal(headTree(b).some((file) => file.includes(from)), false, "nothing stays at its old location");
  assert.deepEqual(JSON.parse(git(remote, "show", `main:${status(onto)}`)), { status: "Approved", of: "moved" }, "the remote holds the change");
});

test("clause 25: where this machine removed a file and wrote another at its path while the upstream only asked the first one's approval, the location keeps the upstream's file with its pending gate and saves the later one", async (context) => {
  const original = requirementFile("Billing");
  const { remote, a, b } = await rawStores(context, {
    "artifacts/requirements/billing.md": original,
    "artifact-identity/requirements/billing.md": identityFile(OLD_ID),
    "artifact-status/requirements/billing.md/status.json": record({ status: "Draft", by: "base" })
  });
  // The upstream asks the file's approval, which changes only its status record; this machine removed it and wrote other text at its path, with an identity and record of its own.
  const asked = { status: "Draft", by: "base", gates: [{ id: "a1b2c3d4e5f6", state: "pending" }] };
  await put(a, { "artifact-status/requirements/billing.md/status.json": record(asked) });
  push(a, "ask approval");
  await put(b, { "artifacts/requirements/billing.md": LATER, "artifact-identity/requirements/billing.md": identityFile(LATER_ID), "artifact-status/requirements/billing.md/status.json": record({ status: "Draft", by: "b" }) });
  const synced = await syncRecordStoreNow(b);
  assert.equal(synced.state, "conflicts", synced.message);
  assert.equal(atHead(b, "artifacts/requirements/billing.md"), original.trimEnd(), "the upstream's file keeps the location");
  assert.deepEqual(JSON.parse(atHead(b, "artifact-status/requirements/billing.md/status.json") ?? "null"), asked, "with its pending gate");
  assert.deepEqual(JSON.parse(atHead(b, "artifact-identity/requirements/billing.md") ?? "null"), { id: OLD_ID }, "and its identity");
  const saved = await savedBelow(b);
  assert.equal(saved["artifacts/requirements/billing.md"], LATER, "the later file's text is saved");
  assert.deepEqual(JSON.parse(saved["artifact-status/requirements/billing.md/status.json"] ?? "null"), { status: "Draft", by: "b" }, "and its status record");
  assert.equal(synced.conflicts.filter((item) => JSON.stringify(item).includes("artifacts/requirements/billing.md")).length, 1, "the later file is named once");
  assert.equal(git(remote, "show", "main:artifacts/requirements/billing.md"), original.trimEnd(), "the remote keeps the upstream's file");
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
