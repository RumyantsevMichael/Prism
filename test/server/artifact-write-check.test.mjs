import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { CONFORMING, GLOSSARY, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { labelOf, storeProject, storeRead, storeWrite } from "./fixtures/artifact-formats-store.mjs";
import { answerGate, reviewBrowser } from "./fixtures/workspace-artifacts.mjs";

// Prism refuses a write of a requirement file, ADR, or glossary that would leave content breaking the current format, and changes nothing then,
// while removing, moving between scopes, and the move of a checkout's files into the store keep bytes as they are.

const NEW = "docs/requirements/exports.md";
const DRAFT = REQUIREMENT.replace("# Request retries", "# Exports").replace("Status: Approved", "Status: Draft").replace("Approved: 2026-09-04", "Approved: n/a");
const BROKEN = DRAFT.replace("## Goals\n\n- Recover from short network drops.\n\n", "");
const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");

const update = (call, operations) => call("update_artifact", { operations });

test("clauses 7, 8: a write that breaks the format is refused with its rules, and nothing of the update changes", async (context) => {
  const { call } = await storeProject(context);
  const plan = "docs/plans/exports/slice.md";
  const refused = await update(call, [
    { op: "write", path: plan, content: "# Exports\n", expectedVersion: null },
    { op: "write", path: NEW, content: BROKEN, expectedVersion: null, scope: "repository" }
  ]);
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  assert.deepEqual(refused.value.artifacts.map((artifact) => [artifact.path, labelOf(artifact), artifact.type]), [[NEW, "api", "requirements"]]);
  assert.ok(refused.value.artifacts[0].findings.some((finding) => finding.rule === "requirements.sections"));
  assert.match(refused.text, new RegExp(`${NEW} in scope api`));
  assert.match(refused.text, /requirements\.sections/);
  for (const file of [NEW, plan]) assert.equal((await call("get_artifact", { path: file })).value?.code, "artifact_not_found", `${file} was not written`);
});

test("clause 7: an edit that would break an existing requirement file is refused and keeps its version", async (context) => {
  const { call } = await storeProject(context);
  const before = await storeRead(call, PATHS.requirements);
  const refused = await update(call, [{ op: "edit", path: PATHS.requirements, expectedVersion: before.version, edits: [{ oldText: '<a id="1"></a>\n', newText: "" }] }]);
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  assert.ok(refused.value.artifacts[0].findings.some((finding) => finding.rule === "requirements.numbering"));
  assert.equal((await storeRead(call, PATHS.requirements)).version, before.version);
  const fine = await update(call, [{ op: "edit", path: PATHS.requirements, expectedVersion: before.version, edits: [{ oldText: "Clients give up on the first dropped connection.", newText: "Clients give up at the first dropped connection." }] }]);
  assert.equal(fine.value?.code ?? null, null, fine.text);
});

test("clauses 7, 8: a glossary write whose term names a Draft requirement as its source is refused", async (context) => {
  const { call } = await storeProject(context);
  await storeWrite(call, NEW, DRAFT);
  const glossary = await storeRead(call, PATHS.glossary);
  const term = `\n<a id="export"></a>\n## Export\n\nA file the client writes for another system.\n\nSource: [exports.md§1](requirements/exports.md#1)\n`;
  const refused = await update(call, [{ op: "write", path: PATHS.glossary, content: `${GLOSSARY}${term}`, expectedVersion: glossary.version }]);
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  assert.ok(refused.value.artifacts[0].findings.some((finding) => finding.rule === "glossary.source-decided"));
});

test("clause 9: a new requirement is a Draft whose unknown values pass, while approving it with an unknown value is refused and its gate stays pending", async (context) => {
  const { root, call } = await storeProject(context);
  execFileSync("git", ["config", "user.name", "Ada Reviewer"], { cwd: root, stdio: "pipe" });
  const withUnknown = DRAFT.replace("Rationale: A request that retries forever holds a connection that other requests need.", "Rationale: unknown");
  const written = await storeWrite(call, NEW, withUnknown);
  assert.ok(written.version);
  const asked = await update(call, [{ op: "ask_approval", path: NEW, context: "Exports for the finance team." }]);
  assert.equal(asked.value?.code ?? null, null, asked.text);
  const gate = asked.value.artifacts[0].gate;
  const review = await reviewBrowser(context, root);
  const answered = await answerGate(review, { id: gate, choice: "approve" });
  assert.notEqual(answered.status, 200, "the approval is refused");
  assert.equal(answered.body?.code ?? answered.body?.error?.code, "artifact_nonconforming", JSON.stringify(answered.body));
  const after = await storeRead(call, NEW);
  assert.equal(after.status, "Draft");
  assert.equal(after.content, withUnknown, "the file keeps its text");
});

test("clause 10: the move into the store, a scope move, and a removal keep a nonconforming artifact's bytes and pass unchecked", async (context) => {
  const { call } = await storeProject(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED });
  const moved = await storeRead(call, PATHS.requirements);
  assert.equal(moved.content, UNANCHORED, "the move into the store keeps the bytes");
  const listed = await call("check_artifacts", { paths: [PATHS.requirements] });
  assert.equal(listed.value.artifacts[0].conforms, false);
  assert.equal(labelOf(listed.value.artifacts[0]), "api");
  const scoped = await update(call, [{ op: "move_scope", path: PATHS.requirements, expectedVersion: moved.version, scope: "workspace" }]);
  assert.equal(scoped.value?.code ?? null, null, scoped.text);
  assert.equal((await storeRead(call, PATHS.requirements, { scope: "workspace" })).content, UNANCHORED);
  const removed = await update(call, [{ op: "remove", path: PATHS.requirements, expectedVersion: moved.version, scope: "workspace" }]);
  assert.equal(removed.value?.code ?? null, null, removed.text);
});

test("clause 11: plan files are not checked by a write", async (context) => {
  const { call } = await storeProject(context);
  const written = await update(call, [{ op: "write", path: "docs/plans/exports/slice.md", content: "anything at all\n", expectedVersion: null }]);
  assert.equal(written.value?.code ?? null, null, written.text);
});
