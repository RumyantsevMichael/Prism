import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { labelOf, storeProject, storeRead } from "./fixtures/artifact-formats-store.mjs";
import { answerGate, reviewBrowser } from "./fixtures/workspace-artifacts.mjs";

// The write check holds wherever an update leaves a file, and its refusal names the artifacts with their findings wherever it reaches the person.

const version = (text) => `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
const BROKEN = REQUIREMENT.replace('<a id="1"></a>\n', "");
const RATIONALE = "Rationale: A request that retries forever holds a connection that other requests need.";

test("a write that a move_scope of the same update follows is checked where the update leaves it, and changes nothing", async (context) => {
  const { call } = await storeProject(context);
  const before = await storeRead(call, PATHS.requirements);
  const refused = await call("update_artifact", { operations: [
    { op: "write", path: PATHS.requirements, content: BROKEN, expectedVersion: before.version },
    { op: "move_scope", path: PATHS.requirements, expectedVersion: version(BROKEN), scope: "workspace" }
  ] });
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  assert.deepEqual(refused.value.artifacts.map((artifact) => [artifact.path, labelOf(artifact)]), [[PATHS.requirements, "workspace"]]);
  assert.ok(refused.value.artifacts[0].findings.some((finding) => finding.rule === "requirements.numbering"));
  const after = await storeRead(call, PATHS.requirements);
  assert.deepEqual([after.version, labelOf(after)], [before.version, "api"]);
});

test("an edit to unknown in an Approved file that a move_scope follows is checked with the status that moves with it", async (context) => {
  const { call } = await storeProject(context);
  const before = await storeRead(call, PATHS.requirements);
  const edited = before.content.replace(RATIONALE, "Rationale: unknown");
  const refused = await call("update_artifact", { operations: [
    { op: "edit", path: PATHS.requirements, expectedVersion: before.version, edits: [{ oldText: RATIONALE, newText: "Rationale: unknown" }] },
    { op: "move_scope", path: PATHS.requirements, expectedVersion: version(edited), scope: "workspace" }
  ] });
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  assert.ok(refused.value.artifacts[0].findings.some((finding) => finding.rule === "requirements.unknown"));
  assert.equal((await storeRead(call, PATHS.requirements)).version, before.version);
});

test("a conforming write that a move_scope follows applies, and the file conforms in its new scope", async (context) => {
  const { call } = await storeProject(context);
  const before = await storeRead(call, PATHS.requirements);
  const changed = REQUIREMENT.replace("Clients give up on the first dropped connection.", "Clients give up at the first dropped connection.");
  const applied = await call("update_artifact", { operations: [
    { op: "write", path: PATHS.requirements, content: changed, expectedVersion: before.version },
    { op: "move_scope", path: PATHS.requirements, expectedVersion: version(changed), scope: "workspace" }
  ] });
  assert.equal(applied.value?.code ?? null, null, applied.text);
  const after = await storeRead(call, PATHS.requirements);
  assert.deepEqual([after.content, labelOf(after)], [changed, "workspace"]);
});

test("the review browser's refusal of an approval that would break the format names each artifact with its findings", async (context) => {
  const { root, call } = await storeProject(context);
  execFileSync("git", ["config", "user.name", "Ada Reviewer"], { cwd: root, stdio: "pipe" });
  const file = "docs/requirements/exports.md";
  const text = REQUIREMENT.replace("# Request retries", "# Exports").replace("Status: Approved", "Status: Draft").replace("Approved: 2026-09-04", "Approved: n/a").replace(RATIONALE, "Rationale: unknown");
  const written = await call("update_artifact", { operations: [{ op: "write", path: file, content: text, expectedVersion: null, scope: "repository" }] });
  assert.equal(written.value?.code ?? null, null, written.text);
  const asked = await call("update_artifact", { operations: [{ op: "ask_approval", path: file, context: "Exports for the finance team." }] });
  const review = await reviewBrowser(context, root);
  const answered = await answerGate(review, { id: asked.value.artifacts[0].gate, choice: "approve" });
  assert.equal(answered.status, 409, JSON.stringify(answered.body));
  assert.equal(answered.body?.code, "artifact_nonconforming");
  assert.deepEqual(answered.body.artifacts.map((artifact) => [artifact.path, labelOf(artifact), artifact.type, artifact.findings.map((finding) => finding.rule)]), [[file, "api", "requirements", ["requirements.unknown"]]]);
  assert.equal((await storeRead(call, file)).status, "Draft", "the gate stays pending and the file stays a Draft");
});
