import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFORMING, GLOSSARY, PATHS } from "./fixtures/artifact-formats.mjs";
import { labelOf, storeProject, storeRead, storeWrite } from "./fixtures/artifact-formats-store.mjs";
import { browserRequest, exists, reviewBrowser } from "./fixtures/workspace-artifacts.mjs";

// Format migrations of store artifacts: named by path and scope, checked against recorded statuses, and applied through Prism's store writes.

const AUDIT = "docs/requirements/audit.md";
const AUDIT_SOURCE = "# Audit log\n\nStatus: Approved\nCreated: 2026-08-01\nApproved: 2026-08-02\n\n## 1\n\nThe system shall record every administrative action.\n";
const auditContent = (status = "Approved", approved = "2026-08-02") => `# Audit log

Status: ${status}
Created: 2026-08-01
Approved: ${approved}

## Problem

unknown

## Goals

unknown

## Non-goals

unknown

## Design questions

unknown

<a id="1"></a>
## 1. Record administrative actions

Pattern: unknown

Disposition: Active

Requirement: The system shall record every administrative action.

Rationale: unknown

Related: n/a
`;
const auditProposal = (content = auditContent(), source = AUDIT) => ({ type: "requirements", source, target: source, content, summary: "Adds the format's sections and fields around the one obligation and marks the values the file never gave as unknown.", leftovers: [] });
const TERMS = "docs/notes/terms.md";
const TERMS_TEXT = "# Payment terms\n\nTerms used by the payments team.\n\n| Term | Definition |\n| --- | --- |\n| Backoff | The wait between two attempts. |\n";
const BACKOFF = `<a id="backoff"></a>\n## Backoff\n\nThe wait between two attempts.\n\nSource: migration\n`;

async function project(context) {
  const { place, root, call } = await storeProject(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE, [TERMS]: TERMS_TEXT });
  await storeRead(call, AUDIT);
  const review = await reviewBrowser(context, root);
  const answer = async (id, input) => {
    const listed = await browserRequest(review, `/api/actions?target=${encodeURIComponent(`migration:${id}`)}`);
    const action = listed.body.actions?.find((entry) => entry.id === "migration.answer");
    assert.ok(action, `the migration lists its answer action: ${JSON.stringify(listed.body)}`);
    const applied = await browserRequest(review, "/api/actions/apply", { method: "POST", body: { action: "migration.answer", target: `migration:${id}`, input, revision: action.revision, confirmed: true } });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
  };
  return { place, root, call, answer };
}

test("clauses 48, 57, 58, 59: an in-place migration of a store requirement names it by path and scope and applies through the store, keeping its recorded status and accepted version", async (context) => {
  const { root, call, answer } = await project(context);
  const before = await storeRead(call, AUDIT);
  const proposed = await call("propose_migration", auditProposal());
  const migration = proposed.value?.migration;
  assert.ok(migration, proposed.text);
  assert.deepEqual([migration.source.path, labelOf(migration.source), migration.target.path, labelOf(migration.target)], [AUDIT, "api", AUDIT, "api"]);
  await answer(migration.id, { decision: "accept" });
  const applied = await call("apply_migration", { id: migration.id });
  assert.equal(applied.value?.code ?? null, null, applied.text);
  assert.deepEqual(applied.value.written.map((entry) => [entry.path, labelOf(entry)]), [[AUDIT, "api"]]);
  const after = await storeRead(call, AUDIT);
  assert.equal(after.content, auditContent());
  assert.equal(after.status, "Approved", "the recorded status stays");
  assert.equal(after.acceptedVersion, before.acceptedVersion, "a migration changes no accepted version");
  assert.equal(await exists(path.join(root, AUDIT)), false, "nothing is written into the checkout");
});

test("clause 59: content whose Status: line differs from the recorded status is refused as a changed decision", async (context) => {
  const { call } = await project(context);
  // Written Approved through update_artifact, the new file is recorded Draft until a person approves it at its gate.
  await storeWrite(call, "docs/requirements/unapproved.md", AUDIT_SOURCE);
  const refused = await call("propose_migration", auditProposal(auditContent(), "docs/requirements/unapproved.md"));
  assert.equal(refused.value?.code, "migration_changes_decision", refused.text);
  assert.deepEqual(refused.value.changed.find((change) => change.field === "Status"), { field: "Status", before: "Draft", after: "Approved" });
  const kept = await call("propose_migration", auditProposal(auditContent("Draft", "n/a"), "docs/requirements/unapproved.md"));
  assert.equal(kept.value?.migration?.status, "pending", kept.text);
});

test("clause 58: a store artifact changed through update_artifact since the proposal makes the migration stale", async (context) => {
  const { call, answer } = await project(context);
  const { migration } = (await call("propose_migration", auditProposal())).value;
  await answer(migration.id, { decision: "accept" });
  const current = await storeRead(call, AUDIT);
  await storeWrite(call, AUDIT, `${current.content}\nA later line.\n`, { expectedVersion: current.version });
  const stale = await call("apply_migration", { id: migration.id });
  assert.equal(stale.value?.code, "migration_stale", stale.text);
  assert.match(stale.text, /docs\/requirements\/audit\.md/);
  assert.equal((await storeRead(call, AUDIT)).content, `${current.content}\nA later line.\n`, "nothing is written");
});

test("clauses 57, 58, 60: a checkout source migrates into a store glossary, its accepted removal removes the checkout file, and the record lives apart from the move's folders", async (context) => {
  const { place, root, call, answer } = await project(context);
  const proposed = await call("propose_migration", { type: "glossary", source: TERMS, target: PATHS.glossary, content: `${GLOSSARY}\n${BACKOFF}`, summary: "Moves the payments team's one term into the glossary.", leftovers: [{ statement: "Terms used by the payments team.", home: "Dropped: the glossary keeps its own purpose." }] });
  const migration = proposed.value?.migration;
  assert.ok(migration, proposed.text);
  assert.deepEqual([migration.source, labelOf(migration.target)], [{ path: TERMS, scope: null }, "api"]);
  const stored = await readdir(path.join(place.store, "format-migrations"));
  assert.ok(stored.some((name) => name.startsWith(migration.id)), `the record is under format-migrations/: ${stored}`);
  for (const folder of ["migrations", "artifact-migrations"]) {
    const names = await readdir(path.join(place.store, folder)).catch(() => []);
    for (const name of names) assert.doesNotMatch(await readFile(path.join(place.store, folder, name), "utf8"), new RegExp(migration.id), `${folder}/${name}`);
  }
  await answer(migration.id, { decision: "accept", removeSource: "on" });
  const applied = await call("apply_migration", { id: migration.id });
  assert.equal(applied.value?.code ?? null, null, applied.text);
  assert.deepEqual(applied.value.written.map((entry) => [entry.path, labelOf(entry)]), [[PATHS.glossary, "api"]]);
  assert.deepEqual(applied.value.removed, [{ path: TERMS, scope: null }]);
  assert.equal(await exists(path.join(root, TERMS)), false);
  assert.match((await storeRead(call, PATHS.glossary)).content, new RegExp(`^Source: migration ${migration.id}$`, "m"));
  const [entry] = (await call("check_artifacts", { paths: [PATHS.glossary] })).value.artifacts;
  assert.deepEqual(entry.findings, [], "an applied migration is a decided source");
});
