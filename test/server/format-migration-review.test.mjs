import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFORMING, FEATURE, REQUIREMENT, checked, entryOf, read } from "./fixtures/artifact-formats.mjs";
import { labelOf, storeRead } from "./fixtures/artifact-formats-store.mjs";
import { runCheckout, runStore, waitFor } from "./fixtures/format-migration-runs.mjs";
import { defer } from "./fixtures/teardown.mjs";

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

// Prism launches each run's session, so these projects see stub hosts that hold their turn while the test calls the run's tools as that session would.
const formatServer = (context, files) => runCheckout(context, files);
const storeProject = (context, files) => runStore(context, files);

// Format migrations stay inside the project, invent no decision or wording, and keep a named target scope; a run checks its record again when it applies,
// applies nothing outside the project or beyond what its proposals passed, and keeps every source when a target cannot be written.

const AUDIT = "docs/requirements/audit.md";
// A nonconforming store file arrives as another machine's sync would bring it, since every write of a requirement through Prism is checked against its format.
async function storeFile(place, location, text) {
  await mkdir(path.dirname(path.join(place.store, location)), { recursive: true });
  await writeFile(path.join(place.store, location), text);
}

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
const proposal = (run, source, target, extra = {}) => ({ run, type: "requirements", source, target, content: content(), summary: "Adds the format's sections and fields around the one obligation.", leftovers: [], ...extra });
const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const PATH = "docs/requirements/retries.md";
const repair = (run, extra = {}) => ({ run, type: "requirements", source: PATH, target: PATH, content: REQUIREMENT, summary: "Adds the anchor of section 2.", leftovers: [], ...extra });

const exists = (file) => stat(file).then(() => true, () => false);

async function outsideFolder(context) {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-migration-outside-")));
  defer(context, () => rm(folder, { recursive: true, force: true }));
  return folder;
}

// The run that Prism started for an artifact, once check_artifacts names it.
const runOf = async (call, file, scope) => (await waitFor(async () => (await call("check_artifacts", {})).value.artifacts.find((artifact) => artifact.path === file && (scope === undefined || artifact.scope?.label === scope))?.migration ?? null, { what: `a run of ${file}` })).run;

// A proposal with every point it lists asked.
async function propose(call, args) {
  const bare = await call("propose_migration", args);
  if (bare.value?.code !== "migration_unsettled") return bare;
  return call("propose_migration", { ...args, asked: bare.value.points.map((point) => ({ point, recommendation: "Ask the owner." })) });
}

const runFile = (folder, run) => path.join(folder, "format-migrations", `${run}.json`);
async function editRun(folder, run, edit) {
  const record = JSON.parse(await readFile(runFile(folder, run), "utf8"));
  edit(record);
  await writeFile(runFile(folder, run), JSON.stringify(record, null, 2));
}

test("a checkout target through a linked folder is refused at the proposal, and nothing outside the project is written", { skip: posixOnly }, async (context) => {
  const { root, call } = await formatServer(context, { ...CONFORMING, [AUDIT]: DRAFT_SOURCE });
  const run = await runOf(call, AUDIT);
  const outside = await outsideFolder(context);
  await symlink(outside, path.join(root, "docs/requirements/linked"));
  const target = await call("propose_migration", proposal(run, AUDIT, "docs/requirements/linked/audit.md"));
  assert.equal(target.value?.code, "artifact_outside", target.text);
  assert.equal(await exists(path.join(outside, "audit.md")), false);
});

test("a source folder replaced by a link after the proposal fails the run, so the outside file is neither changed nor removed", { skip: posixOnly }, async (context) => {
  const { root, call } = await formatServer(context, { ...CONFORMING, [PATH]: UNANCHORED });
  const run = await runOf(call, PATH);
  const proposed = await call("propose_migration", repair(run));
  assert.ok(proposed.value?.migration, proposed.text);
  const outside = await outsideFolder(context);
  await rename(path.join(root, "docs/requirements"), path.join(outside, "requirements"));
  await symlink(path.join(outside, "requirements"), path.join(root, "docs/requirements"));
  const finished = (await call("finish_migration_run", { run })).value.run;
  assert.equal(finished.status, "failed", JSON.stringify(finished));
  assert.match(finished.failure.reason, /symbolic link/);
  assert.equal(await readFile(path.join(outside, "requirements/retries.md"), "utf8"), UNANCHORED, "the outside file is kept as it was");
});

test("a Draft source cannot be proposed as Approved through a word or a date found elsewhere in the source", { skip: posixOnly }, async (context) => {
  const source = "# Audit log\n\nStatus: Draft\nCreated: 2026-08-01\nApproved: n/a\n\n## 1\n\nThe system shall record every administrative action.\n";
  const { call } = await formatServer(context, { ...CONFORMING, [AUDIT]: source });
  const run = await runOf(call, AUDIT);
  const result = await call("propose_migration", proposal(run, AUDIT, AUDIT, { content: content({ status: "Approved", approved: "2026-08-01" }) }));
  assert.equal(result.value?.code, "migration_invented", result.text);
  assert.deepEqual(result.value.statements.map((statement) => statement.text).sort(), ["2026-08-01", "Approved"]);
});

test("a content statement cut from a longer source sentence is invented, even with the whole sentence listed as a leftover", { skip: posixOnly }, async (context) => {
  const full = "The system shall record every administrative action only after a person confirms it.";
  const { call } = await formatServer(context, { ...CONFORMING, [AUDIT]: `# Audit log\n\nStatus: Draft\nCreated: 2026-08-01\n\n## 1\n\n${full}\n` });
  const run = await runOf(call, AUDIT);
  const cut = "The system shall record every administrative action";
  const result = await call("propose_migration", proposal(run, AUDIT, AUDIT, { content: content({ requirement: cut }), leftovers: [{ statement: full, home: "Dropped" }] }));
  assert.equal(result.value?.code, "migration_invented", result.text);
  assert.deepEqual(result.value.statements.map((statement) => statement.text), [cut]);
});

test("a target at the source's path in another named scope is read as its own target, not as the source", { skip: posixOnly }, async (context) => {
  const { place, call } = await storeProject(context, { ...CONFORMING, [AUDIT]: content({ status: "Approved", approved: "2026-08-02" }) });
  const repository = await storeRead(call, AUDIT, { scope: "repository" });
  assert.equal(repository.status, "Approved", JSON.stringify(repository));
  await storeFile(place, "artifacts/requirements/audit.md", DRAFT_SOURCE);
  const run = await runOf(call, AUDIT, "workspace");
  const result = await propose(call, proposal(run, { path: AUDIT, scope: "workspace" }, { path: AUDIT, scope: "repository" }, { content: content({ status: "Approved", approved: "2026-08-02" }) }));
  const migration = result.value?.migration;
  assert.ok(migration, result.text);
  assert.deepEqual([labelOf(migration.source), labelOf(migration.target), migration.separateSource], ["workspace", "api", true]);
});

test("a run record whose target or source was changed to leave the project is refused when the run finishes, and nothing outside it is written or removed", { skip: posixOnly }, async (context) => {
  for (const name of ["target", "source"]) {
    const { root, call } = await formatServer(context, { ...CONFORMING, [PATH]: UNANCHORED });
    const run = await runOf(call, PATH);
    const proposed = await call("propose_migration", repair(run));
  assert.ok(proposed.value?.migration, proposed.text);
    const outside = await outsideFolder(context);
    await writeFile(path.join(outside, "victim.md"), DRAFT_SOURCE);
    // A record as another checkout, or a store's remote, could hold it.
    await editRun(path.join(root, ".prism"), run, (record) => {
      const outsidePath = path.relative(root, path.join(outside, "victim.md"));
      record.migrations[0][name].path = outsidePath;
      if (name === "source") record.set.artifacts[0].path = outsidePath;
    });
    const finished = await call("finish_migration_run", { run });
    assert.equal(finished.value?.code, "invalid_input", finished.text);
    assert.equal(await readFile(path.join(outside, "victim.md"), "utf8"), DRAFT_SOURCE);
    assert.equal(await read(root, PATH), UNANCHORED, "nothing is written");
  }
});

test("a run record whose content or target changed after its proposal was checked does not apply", { skip: posixOnly }, async (context) => {
  for (const edit of [
    (record) => { record.migrations[0].content = record.migrations[0].content.replace("Clients give up on the first dropped connection.", "Clients never retry."); },
    (record) => { record.migrations[0].target.path = "docs/requirements/other.md"; record.migrations[0].separateSource = true; }
  ]) {
    const { root, call } = await formatServer(context, { ...CONFORMING, [PATH]: UNANCHORED });
    const run = await runOf(call, PATH);
    const proposed = await call("propose_migration", repair(run));
  assert.ok(proposed.value?.migration, proposed.text);
    await editRun(path.join(root, ".prism"), run, edit);
    const finished = await call("finish_migration_run", { run });
    assert.equal(finished.value?.code, "record_invalid", finished.text);
    assert.equal(await read(root, PATH), UNANCHORED);
    assert.equal(await exists(path.join(root, "docs/requirements/other.md")), false);
  }
});

test("concurrent proposals of one source keep one migration of it in the run", { skip: posixOnly }, async (context) => {
  const { call } = await formatServer(context, { ...CONFORMING, [PATH]: UNANCHORED });
  const run = await runOf(call, PATH);
  const results = await Promise.all([1, 2, 3].map(() => call("propose_migration", repair(run))));
  assert.ok(results.every((result) => result.value?.migration?.id), results.map((result) => result.text).join("\n"));
  assert.equal(new Set(results.map((result) => result.value.migration.id)).size, 1);
  assert.equal((await call("get_migration_run", { run })).value.run.migrations.length, 1);
});

const SCENARIOS = "docs/requirements/retry-scenarios.md";
const FEATURE_TARGET = "docs/Features/F-retry-scenarios.feature";
// A feature file kept under the Requirements path, which breaks the requirement format, migrated into a checkout feature file, with its removal asked and answered.
async function storeSourceAnswered(context, target = FEATURE_TARGET) {
  const { place, root, call } = await storeProject(context, { ...CONFORMING, [SCENARIOS]: FEATURE });
  const source = await storeRead(call, SCENARIOS);
  const run = await runOf(call, SCENARIOS);
  const proposed = await propose(call, { run, type: "feature", source: SCENARIOS, target, content: FEATURE, summary: "Moves the retry scenarios into a feature file.", leftovers: [] });
  const migration = proposed.value?.migration;
  assert.ok(migration, proposed.text);
  assert.equal((await call("finish_migration_run", { run })).value.run.status, "asking");
  const removal = migration.points.find((point) => point.kind === "remove-source");
  await editRun(place.store, run, (record) => {
    record.answers = { [removal.id]: { choice: "remove", value: null, by: { name: "Ada Reviewer" }, at: new Date().toISOString() } };
    record.status = "continuing";
  });
  return { place, root, call, run, source };
}

test("a store source of a checkout target is removed in the store once the checkout target is written", { skip: posixOnly }, async (context) => {
  const { root, call, run } = await storeSourceAnswered(context);
  const finished = (await call("finish_migration_run", { run })).value.run;
  assert.equal(finished.status, "applied", JSON.stringify(finished.failure));
  assert.equal(await read(root, FEATURE_TARGET), FEATURE);
  assert.equal((await call("get_artifact", { path: SCENARIOS })).value?.code, "artifact_not_found");
  assert.equal(entryOf(await checked(call, [FEATURE_TARGET]), FEATURE_TARGET).conforms, true);
});

test("a checkout target that cannot be written fails the run and keeps its store source, leaving no temporary file", { skip: posixOnly }, async (context) => {
  const target = "docs/Features/sub/F-retry-scenarios.feature";
  const { root, call, run, source } = await storeSourceAnswered(context, target);
  // A regular file where the target's folder belongs, so the checkout write fails.
  await writeFile(path.join(root, "docs/Features/sub"), "not a folder\n");
  const finished = (await call("finish_migration_run", { run })).value.run;
  assert.equal(finished.status, "failed");
  assert.doesNotMatch(finished.failure.reason, /EEXIST/);
  assert.equal((await storeRead(call, SCENARIOS)).version, source.version, "the store source is kept");
  assert.deepEqual((await readdir(path.join(root, "docs/Features"))).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left");
});
