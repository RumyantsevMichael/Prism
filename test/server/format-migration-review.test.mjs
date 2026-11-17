import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, formatServer, read, write } from "./fixtures/artifact-formats.mjs";
import { labelOf, otherCheckout, storeProject, storeRead, storeWrite } from "./fixtures/artifact-formats-store.mjs";
import { defer } from "./fixtures/teardown.mjs";

// Format migrations stay inside the project, invent no decision or wording, keep a pending migration's wait open on a failed read, keep a named target scope, and complete a retried apply.

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
