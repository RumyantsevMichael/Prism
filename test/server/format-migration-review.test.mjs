import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, FEATURE, formatServer, read, write } from "./fixtures/artifact-formats.mjs";
import { labelOf, otherCheckout, storeProject, storeRead, storeWrite } from "./fixtures/artifact-formats-store.mjs";
import { defer } from "./fixtures/teardown.mjs";

// Format migrations stay inside the project, invent no decision or wording, keep a pending migration's wait open on a failed read, keep a named target scope, and complete a retried apply.
// An apply checks its record again and applies only what the person accepted, a stale migration releases its target, and one target has one pending migration.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-migration-review-data-")));
process.env.PLUGIN_DATA = privateData;
process.env.PRISM_REVIEW_APP_DIR = path.join(privateData, "app");
delete process.env.CLAUDE_PLUGIN_DATA;
const { applyAction, listActions } = await import("../../dist/server/workflow/actions.mjs");
const { waitForUserGates } = await import("../../dist/server/workflow/gate-wait.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const AUDIT = "docs/requirements/audit.md";
const DRAFT_SOURCE = "# Audit log\n\nStatus: Draft\nCreated: 2026-08-01\n\n## 1\n\nThe system shall record every administrative action.\n";
const content = ({ status = "Draft", approved = "unknown", requirement = "The system shall record every administrative action." } = {}) => `# Audit log

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

Requirement: ${requirement}

Rationale: unknown

Related: n/a
`;
const proposal = (source, target, extra = {}) => ({ type: "requirements", source, target, content: content(), summary: "Adds the format's sections and fields around the one obligation.", leftovers: [], ...extra });

async function answer(root, id, input) {
  const listed = await listActions({ projectRoot: root, target: `migration:${id}` });
  const action = listed.actions.find((entry) => entry.id === "migration.answer");
  assert.ok(action, "the migration lists its answer action");
  return applyAction({ projectRoot: root, target: `migration:${id}`, action: "migration.answer", input, revision: action.revision, confirmed: true });
}

const exists = (file) => stat(file).then(() => true, () => false);

async function outsideFolder(context) {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-migration-outside-")));
  defer(context, () => rm(folder, { recursive: true, force: true }));
  return folder;
}

test("a checkout target or source through a linked folder is refused at the proposal, and nothing outside the project is written", async (context) => {
  const { root, call } = await formatServer(context, { ...CONFORMING, "notes/audit.md": DRAFT_SOURCE });
  const outside = await outsideFolder(context);
  await symlink(outside, path.join(root, "docs/requirements/linked"));
  const target = await call("propose_migration", proposal("notes/audit.md", "docs/requirements/linked/audit.md"));
  assert.equal(target.value?.code, "artifact_outside", target.text);
  assert.equal(await exists(path.join(outside, "audit.md")), false);

  await writeFile(path.join(outside, "audit.md"), DRAFT_SOURCE);
  await symlink(outside, path.join(root, "notes/linked"));
  const source = await call("propose_migration", proposal("notes/linked/audit.md", AUDIT));
  assert.equal(source.value?.code, "artifact_outside", source.text);
  await symlink(path.join(outside, "audit.md"), path.join(root, "notes/link.md"));
  const file = await call("propose_migration", proposal("notes/link.md", AUDIT));
  assert.equal(file.value?.code, "artifact_outside", file.text);
});

test("a source folder replaced by a link after the proposal is refused at apply, so the outside file is neither removed nor the target written", async (context) => {
  const { root, call } = await formatServer(context, { ...CONFORMING, "notes/audit.md": DRAFT_SOURCE });
  const proposed = await call("propose_migration", proposal("notes/audit.md", AUDIT));
  const id = proposed.value?.migration?.id;
  assert.ok(id, proposed.text);
  await answer(root, id, { decision: "accept", removeSource: "on" });
  const outside = await outsideFolder(context);
  await rename(path.join(root, "notes/audit.md"), path.join(outside, "audit.md"));
  await rm(path.join(root, "notes"), { recursive: true });
  await symlink(outside, path.join(root, "notes"));
  const applied = await call("apply_migration", { id });
  assert.equal(applied.value?.code, "artifact_outside", applied.text);
  assert.equal(await exists(path.join(outside, "audit.md")), true, "the outside file is kept");
  assert.equal(await exists(path.join(root, AUDIT)), false, "the target is not written");
});

test("a Draft source cannot be proposed as Approved through a word or a date found elsewhere in the source", async (context) => {
  const source = "# Audit log\n\nStatus: Draft\nCreated: 2026-08-01\nApproved: n/a\n\n## 1\n\nThe system shall record every administrative action.\n";
  const { call } = await formatServer(context, { ...CONFORMING, [AUDIT]: source });
  const result = await call("propose_migration", proposal(AUDIT, AUDIT, { content: content({ status: "Approved", approved: "2026-08-01" }) }));
  assert.equal(result.value?.code, "migration_invented", result.text);
  assert.deepEqual(result.value.statements.map((statement) => statement.text).sort(), ["2026-08-01", "Approved"]);
});

test("a content statement cut from a longer source sentence is invented, even with the whole sentence listed as a leftover", async (context) => {
  const full = "The system shall record every administrative action only after a person confirms it.";
  const { call } = await formatServer(context, { ...CONFORMING, [AUDIT]: `# Audit log\n\nStatus: Draft\nCreated: 2026-08-01\n\n## 1\n\n${full}\n` });
  const cut = "The system shall record every administrative action";
  const result = await call("propose_migration", proposal(AUDIT, AUDIT, { content: content({ requirement: cut }), leftovers: [{ statement: full, home: "Dropped" }] }));
  assert.equal(result.value?.code, "migration_invented", result.text);
  assert.deepEqual(result.value.statements.map((statement) => statement.text), [cut]);
});

test("a wait on a pending migration whose record cannot be read is refused rather than ended as unknown or resolved", async (context) => {
  const { root, call } = await formatServer(context, { ...CONFORMING, [AUDIT]: DRAFT_SOURCE });
  const proposed = await call("propose_migration", proposal(AUDIT, AUDIT));
  const id = proposed.value?.migration?.id;
  assert.ok(id, proposed.text);
  const file = path.join(root, ".prism/format-migrations", `${id}.json`);
  const bytes = await readFile(file, "utf8");
  const wait = () => waitForUserGates({ projectRoot: root, migration: id, gateIds: [id], maxWaitMinutes: 0.02, pollMs: 50 });
  // A later failed read keeps the wait polling until its deadline.
  const later = wait();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await writeFile(file, bytes.slice(0, 20));
  assert.equal((await later).status, "timeout");
  // The first read refuses.
  await assert.rejects(wait());
});

test("a target at the source's path in another named scope is read as its own target, not as the source", async (context) => {
  const { place, call } = await storeProject(context, { ...CONFORMING, [AUDIT]: content({ status: "Approved", approved: "2026-08-02" }) });
  const repository = await storeRead(call, AUDIT);
  assert.equal(repository.status, "Approved", JSON.stringify(repository));
  const web = await otherCheckout(context, place);
  await storeWrite(web.call, AUDIT, DRAFT_SOURCE, { scope: "workspace" });
  const result = await call("propose_migration", proposal({ path: AUDIT, scope: "workspace" }, { path: AUDIT, scope: "repository" }, { content: content({ status: "Approved", approved: "2026-08-02" }) }));
  const migration = result.value?.migration;
  assert.ok(migration, result.text);
  assert.deepEqual([labelOf(migration.source), labelOf(migration.target), migration.separateSource], ["workspace", "api", true]);
});

test("an apply retried after an earlier one wrote the target and failed completes and records appliedAt", async (context) => {
  const { root, call } = await formatServer(context, { ...CONFORMING, "notes/audit.md": DRAFT_SOURCE });
  const proposed = await call("propose_migration", proposal("notes/audit.md", AUDIT));
  const id = proposed.value?.migration?.id;
  assert.ok(id, proposed.text);
  await answer(root, id, { decision: "accept", removeSource: "on" });
  // An earlier apply wrote the target and stopped before removing the source and recording appliedAt.
  await mkdir(path.join(root, "docs/requirements"), { recursive: true });
  await write(root, AUDIT, content());
  const applied = await call("apply_migration", { id });
  assert.deepEqual(applied.value?.written, [{ path: AUDIT, scope: null }], applied.text);
  assert.deepEqual(applied.value.removed, [{ path: "notes/audit.md", scope: null }]);
  assert.equal(await read(root, AUDIT), content());
  assert.equal(await exists(path.join(root, "notes/audit.md")), false);
  const got = await call("get_migration", { id });
  assert.equal(typeof got.value?.migration?.appliedAt, "string", got.text);
  assert.equal((await call("apply_migration", { id })).value?.code, "migration_applied");
});

const recordFile = (root, id) => path.join(root, ".prism/format-migrations", `${id}.json`);
async function editRecord(root, id, edit) {
  const record = JSON.parse(await readFile(recordFile(root, id), "utf8"));
  edit(record);
  await writeFile(recordFile(root, id), JSON.stringify(record, null, 2));
}
async function accepted(context, extra = {}) {
  const { root, call } = await formatServer(context, { ...CONFORMING, "notes/audit.md": DRAFT_SOURCE });
  const proposed = await call("propose_migration", proposal("notes/audit.md", AUDIT));
  const id = proposed.value?.migration?.id;
  assert.ok(id, proposed.text);
  await answer(root, id, { decision: "accept", removeSource: "on", ...extra });
  return { root, call, id };
}

test("a migration record whose target was changed to leave the project is refused at apply, and nothing is written outside it", async (context) => {
  const { root, call, id } = await accepted(context);
  const outside = await outsideFolder(context);
  // A record as another checkout, or a store's remote, could hold it.
  await editRecord(root, id, (record) => { record.target.path = path.relative(root, path.join(outside, "planted.sh")); });
  const applied = await call("apply_migration", { id });
  assert.equal(applied.value?.code, "invalid_input", applied.text);
  assert.equal(await exists(path.join(outside, "planted.sh")), false);
  assert.equal(await exists(path.join(root, "notes/audit.md")), true, "the source is kept");
});

test("a migration record whose source was changed to leave the project does not remove the outside file", async (context) => {
  const { root, call, id } = await accepted(context);
  const outside = await outsideFolder(context);
  await writeFile(path.join(outside, "victim.md"), DRAFT_SOURCE);
  await editRecord(root, id, (record) => { record.source.path = path.relative(root, path.join(outside, "victim.md")); });
  const applied = await call("apply_migration", { id });
  assert.equal(applied.value?.code, "invalid_input", applied.text);
  assert.equal(await exists(path.join(outside, "victim.md")), true);
  assert.equal(await exists(path.join(root, AUDIT)), false, "the target is not written");
});

test("a migration record whose content or target changed after the person accepted it does not apply", async (context) => {
  for (const edit of [
    (record) => { record.content = record.content.replace("every administrative action", "no action"); },
    (record) => { record.target.path = "docs/requirements/other.md"; }
  ]) {
    const { root, call, id } = await accepted(context);
    await editRecord(root, id, edit);
    const applied = await call("apply_migration", { id });
    assert.equal(applied.value?.code, "record_invalid", applied.text);
    assert.equal(await exists(path.join(root, AUDIT)), false);
    assert.equal(await exists(path.join(root, "docs/requirements/other.md")), false);
    assert.equal(await exists(path.join(root, "notes/audit.md")), true);
  }
});

test("an accepted migration whose source changed before apply is stale and no longer holds its target", async (context) => {
  const { root, call, id } = await accepted(context);
  await write(root, "notes/audit.md", `${DRAFT_SOURCE}\nThe system shall keep the log for a year.\n`);
  assert.equal((await call("apply_migration", { id })).value?.code, "migration_stale");
  const again = await call("propose_migration", proposal("notes/audit.md", AUDIT, { leftovers: [{ statement: "The system shall keep the log for a year.", home: "A retention requirement." }] }));
  assert.ok(again.value?.migration?.id, again.text);
});

test("an accepted migration that can still apply keeps holding its target", async (context) => {
  const { call, id } = await accepted(context);
  const again = await call("propose_migration", proposal("notes/audit.md", AUDIT));
  assert.equal(again.value?.code, "migration_pending", again.text);
  assert.equal(again.value?.id, id);
});

test("two concurrent proposals of one target record one pending migration", async (context) => {
  const { root, call } = await formatServer(context, { ...CONFORMING, "notes/audit.md": DRAFT_SOURCE });
  const results = await Promise.all([1, 2, 3].map(() => call("propose_migration", proposal("notes/audit.md", AUDIT))));
  assert.equal(results.filter((result) => result.value?.migration?.id).length, 1, results.map((result) => result.text).join("\n"));
  assert.deepEqual(results.filter((result) => !result.value?.migration).map((result) => result.value?.code), ["migration_pending", "migration_pending"]);
  const records = (await readdir(path.join(root, ".prism/format-migrations"))).filter((name) => name.endsWith(".json"));
  assert.equal(records.length, 1, records.join(", "));
});

const SCENARIOS = "docs/requirements/retry-scenarios.md";
const FEATURE_TARGET = "docs/Features/F-retry-scenarios.feature";
async function storeSourceAccepted(context, target = FEATURE_TARGET) {
  const { root, call } = await storeProject(context, { ...CONFORMING, [SCENARIOS]: FEATURE });
  const source = await storeRead(call, SCENARIOS);
  const proposed = await call("propose_migration", { type: "feature", source: SCENARIOS, target, content: FEATURE, summary: "Moves the retry scenarios into a feature file.", leftovers: [] });
  const id = proposed.value?.migration?.id;
  assert.ok(id, proposed.text);
  await answer(root, id, { decision: "accept", removeSource: "on" });
  return { root, call, id, source };
}

test("a store source of a checkout target that changed after acceptance refuses the apply before the checkout is written, and releases the target", async (context) => {
  const { root, call, id, source } = await storeSourceAccepted(context);
  await storeWrite(call, SCENARIOS, `${source.content}\n      And the client logs the failure\n`, { expectedVersion: source.version });
  const applied = await call("apply_migration", { id });
  assert.equal(applied.value?.code, "migration_stale", applied.text);
  assert.equal(await exists(path.join(root, FEATURE_TARGET)), false, "the checkout target is not written");
  const again = await call("propose_migration", { type: "feature", source: SCENARIOS, target: FEATURE_TARGET, content: FEATURE, summary: "Moves the retry scenarios into a feature file.", leftovers: [{ statement: "And the client logs the failure", home: "A logging scenario." }] });
  assert.ok(again.value?.migration?.id, again.text);
});

test("an apply that removed a store source and stopped before writing its checkout target completes on a retry", async (context) => {
  const { root, call, id, source } = await storeSourceAccepted(context);
  // The store source of a checkout target is removed before the target takes its name, so an apply that stopped between them left the source removed and the target unwritten.
  const removed = await call("update_artifact", { operations: [{ op: "remove", path: SCENARIOS, expectedVersion: source.version }] });
  assert.equal(removed.value?.code ?? null, null, removed.text);
  const applied = await call("apply_migration", { id });
  assert.deepEqual(applied.value?.written, [{ path: FEATURE_TARGET, scope: null }], applied.text);
  assert.deepEqual(applied.value.removed.map((entry) => [entry.path, labelOf(entry)]), [[SCENARIOS, "api"]]);
  assert.equal(await read(root, FEATURE_TARGET), FEATURE);
  assert.equal(typeof (await call("get_migration", { id })).value?.migration?.appliedAt, "string");
});

test("a checkout target that cannot be written keeps its store source, refuses with a migration error, and applies on a retry once it can", async (context) => {
  const target = "docs/Features/sub/F-retry-scenarios.feature";
  const { root, call, id, source } = await storeSourceAccepted(context, target);
  // A regular file where the target's folder belongs, so the checkout write fails.
  await writeFile(path.join(root, "docs/Features/sub"), "not a folder\n");
  const failed = await call("apply_migration", { id });
  assert.equal(failed.value?.code, "invalid_path", failed.text);
  assert.doesNotMatch(failed.text, /EEXIST/);
  assert.equal((await storeRead(call, SCENARIOS)).version, source.version, "the store source is kept");
  assert.deepEqual((await readdir(path.join(root, "docs/Features"))).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left");
  assert.equal((await call("get_migration", { id })).value?.migration?.appliedAt ?? null, null);
  await rm(path.join(root, "docs/Features/sub"));
  const applied = await call("apply_migration", { id });
  assert.deepEqual(applied.value?.written, [{ path: target, scope: null }], applied.text);
  assert.deepEqual(applied.value.removed.map((entry) => [entry.path, labelOf(entry)]), [[SCENARIOS, "api"]]);
  assert.equal(await read(root, target), FEATURE);
});
