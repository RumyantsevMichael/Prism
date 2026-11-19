import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFORMING, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { labelOf, storeRead, storeWrite } from "./fixtures/artifact-formats-store.mjs";
import { runStore, waitFor } from "./fixtures/format-migration-runs.mjs";
import { exists } from "./fixtures/workspace-artifacts.mjs";

// Format migrations of store artifacts: named by path and scope, checked against recorded statuses, and applied through Prism's store writes when their run finishes.

const AUDIT = "docs/requirements/audit.md";

// A nonconforming store file arrives as another machine's sync would bring it, since every write of a requirement through Prism is checked against its format.
async function storeFile(place, location, text) {
  await mkdir(path.dirname(path.join(place.store, location)), { recursive: true });
  await writeFile(path.join(place.store, location), text);
}
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
const auditProposal = (run, content = auditContent(), source = AUDIT) => ({ run, type: "requirements", source, target: source, content, summary: "Adds the format's sections and fields around the one obligation and marks the values the file never gave as unknown.", leftovers: [] });

async function project(context) {
  // Prism launches each run's session, so these projects see stub hosts that hold their turn while the test calls the run's tools as that session would.
  const { place, root, call } = await runStore(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE });
  await storeRead(call, AUDIT);
  return { place, root, call };
}

// The run that Prism started for a store artifact, once check_artifacts names it.
const runOf = async (call, file) => (await waitFor(async () => (await call("check_artifacts", {})).value.artifacts.find((artifact) => artifact.path === file)?.migration ?? null, { what: `a run of ${file}` })).run;

// A proposal with each of its unknown points asked.
async function propose(call, args) {
  const bare = await call("propose_migration", args);
  if (bare.value?.code !== "migration_unsettled") return bare;
  return call("propose_migration", { ...args, asked: bare.value.points.map((point) => ({ point, recommendation: "Ask the owner." })) });
}

// The person's answers to a run's question, as the review app records them in the store, with the run continuing.
async function answer(place, run, answers) {
  const file = path.join(place.store, "format-migrations", `${run}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  const at = new Date().toISOString();
  record.answers = Object.fromEntries(Object.entries(answers).map(([point, value]) => [point, { ...value, by: { name: "Ada Reviewer" }, at }]));
  record.status = "continuing";
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

test("clauses 48, 57, 58, 60: an in-place migration of a store requirement names it by path and scope, lives under the store's format-migrations/, and applies through the store with the person's values", async (context) => {
  const { place, root, call } = await project(context);
  const run = await runOf(call, AUDIT);
  const proposed = await propose(call, auditProposal(run));
  const migration = proposed.value?.migration;
  assert.ok(migration, proposed.text);
  assert.deepEqual([migration.source.path, labelOf(migration.source), migration.target.path, labelOf(migration.target)], [AUDIT, "api", AUDIT, "api"]);
  assert.ok((await readdir(path.join(place.store, "format-migrations"))).includes(`${run}.json`), "the run lives under the store's format-migrations/");
  assert.equal((await call("finish_migration_run", { run })).value.run.status, "asking");
  await answer(place, run, Object.fromEntries(migration.points.map((point) => [point.id, { choice: "value", value: point.field === "Pattern" ? "Ubiquitous" : "Settled by the team." }])));
  const finished = (await call("finish_migration_run", { run })).value.run;
  assert.equal(finished.status, "applied", JSON.stringify(finished.failure));
  const after = await storeRead(call, AUDIT);
  assert.match(after.content, /^Pattern: Ubiquitous$/m);
  assert.doesNotMatch(after.content, /unknown/);
  assert.equal(after.status, "Approved", "the recorded status stays");
  assert.deepEqual([after.acceptedVersion, after.acceptedFrom?.migration], [after.version, run], "the migrated text is the accepted version, attributed to the run");
  assert.equal(await exists(path.join(root, AUDIT)), false, "nothing is written into the checkout");
});

test("clause 59: content whose Status: line differs from the recorded status is refused as a changed decision", async (context) => {
  const { place, call } = await project(context);
  // Brought into the workspace scope's files with no status record, the file is recorded Draft until a person approves it at its gate, whatever its Status: line says.
  await storeFile(place, "artifacts/requirements/unapproved.md", AUDIT_SOURCE);
  const file = "docs/requirements/unapproved.md";
  const run = await runOf(call, file);
  const refused = await call("propose_migration", auditProposal(run, auditContent(), file));
  assert.equal(refused.value?.code, "migration_changes_decision", refused.text);
  assert.deepEqual(refused.value.changed.find((change) => change.field === "Status"), { field: "Status", before: "Draft", after: "Approved" });
  const kept = await propose(call, auditProposal(run, auditContent("Draft", "n/a"), file));
  assert.equal(kept.value?.migration?.status, "proposed", kept.text);
  assert.ok(kept.value.migration.points.every((point) => point.allowsUnknown === true), "a Draft target may keep unknown values");
});

test("clauses 18, 58: a store artifact changed through update_artifact since the proposal fails the run and changes nothing", async (context) => {
  const { place, call } = await project(context);
  const run = await runOf(call, AUDIT);
  const { migration } = (await propose(call, auditProposal(run))).value;
  assert.equal((await call("finish_migration_run", { run })).value.run.status, "asking");
  await answer(place, run, Object.fromEntries(migration.points.map((point) => [point.id, { choice: "value", value: point.field === "Pattern" ? "Ubiquitous" : "Settled by the team." }])));
  const current = await storeRead(call, AUDIT);
  // The change writes content that conforms to the format, which every write through update_artifact is checked against.
  await storeWrite(call, AUDIT, REQUIREMENT, { expectedVersion: current.version });
  const finished = (await call("finish_migration_run", { run })).value.run;
  assert.equal(finished.status, "failed");
  assert.match(finished.failure.reason, /docs\/requirements\/audit\.md/);
  assert.equal((await storeRead(call, AUDIT)).content, REQUIREMENT, "nothing is written");
});
