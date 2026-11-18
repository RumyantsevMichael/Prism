import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFORMING, FEATURE, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { AUDIT, AUDIT_SOURCE, auditContent, auditProposal, entryFor, readRun, runCheckout, runFor, waitFor } from "./fixtures/format-migration-runs.mjs";

// Prism starts one format migration run per set of nonconforming artifacts, applies it without a person when nothing is lost or invented,
// asks once otherwise, leaves a checkout's migration uncommitted, and applies nothing from a run that fails.

// A requirement file whose only break is a numbered section without its anchor, which a migration in place mends without asking.
const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const repairProposal = (run, extra = {}) => ({ run, type: "requirements", source: PATHS.requirements, target: PATHS.requirements, content: REQUIREMENT, summary: "Adds the anchor of section 2.", leftovers: [], ...extra });
const status = (root) => execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });

test("clauses 1, 2, 3, 6, 7, 8: a check starts one run for a new set, which get_migration_run and check_artifacts name", async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED });
  const run = await runFor(call, PATHS.requirements);
  assert.match(run, /^run-[0-9a-f]{16}$/);
  const record = await readRun(call, run);
  assert.equal(record.id, run);
  assert.deepEqual([record.set.type, record.set.scope, record.set.formatVersion], ["requirements", null, 1]);
  assert.deepEqual(record.set.artifacts.map((artifact) => [artifact.path, artifact.scope]), [[PATHS.requirements, null]]);
  assert.match(record.set.artifacts[0].version, /^sha256:[0-9a-f]{64}$/);
  assert.ok(record.set.artifacts[0].findings.some((finding) => finding.rule === "requirements.numbering"), "the set carries each artifact's findings");
  assert.equal(record.cause, "findings");
  assert.ok(["starting", "running"].includes(record.status), record.status);
  assert.equal(typeof record.startedAt, "string");
  assert.deepEqual([record.migrations, record.question, record.answers, record.result, record.failure], [[], null, null, null, null]);
  const entry = await entryFor(call, PATHS.requirements);
  assert.deepEqual(Object.keys(entry.migration).sort(), ["reason", "run", "status"]);
  assert.equal(entry.migration.run, run);
  for (const other of [PATHS.adr, PATHS.glossary, PATHS.feature]) assert.equal((await entryFor(call, other)).migration, null, `${other} conforms, so no run holds it`);
});

test("clauses 1, 2: checking again starts no second run of a set, a changed file starts a new one, and a feature file is never migrated", async (context) => {
  const brokenFeature = FEATURE.replace("    Example: A request past its deadline is not retried\n", "");
  const { root, call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED, [PATHS.feature]: brokenFeature });
  const first = await runFor(call, PATHS.requirements);
  await call("check_artifacts", {});
  await call("check_artifacts", { paths: [PATHS.requirements] });
  assert.equal((await entryFor(call, PATHS.requirements)).migration.run, first, "the same set keeps its one run");
  const feature = await entryFor(call, PATHS.feature);
  assert.equal(feature.conforms, false);
  assert.equal(feature.migration, null, "no run holds a feature file");
  await writeFile(path.join(root, PATHS.requirements), `${UNANCHORED}\n`);
  const second = await waitFor(async () => {
    const migration = (await entryFor(call, PATHS.requirements)).migration;
    return migration && migration.run !== first ? migration.run : null;
  }, { what: "a new run for the changed file" });
  assert.notEqual(second, first);
});

test("clauses 9, 14, 15, 16, 17, 20: a proposal that keeps every statement in corresponding sections applies when the run finishes, and the checkout change stays uncommitted", async (context) => {
  const { root, call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED });
  const run = await runFor(call, PATHS.requirements);
  const proposed = await call("propose_migration", repairProposal(run));
  assert.equal(proposed.refused, false, proposed.text);
  const migration = proposed.value.migration;
  assert.match(migration.id, /^migration-[0-9a-f]+$/);
  assert.equal(migration.run, run);
  assert.equal(migration.status, "proposed");
  assert.deepEqual(migration.points, [], "nothing is left to settle or ask");
  assert.match(migration.diff, /^\+<a id="2"><\/a>$/m);
  assert.equal(status(root), "", "proposing writes nothing");
  const finished = await call("finish_migration_run", { run });
  assert.equal(finished.refused, false, finished.text);
  const record = await readRun(call, run);
  assert.equal(record.status, "applied");
  assert.equal(typeof record.endedAt, "string");
  assert.equal(await readFile(path.join(root, PATHS.requirements), "utf8"), REQUIREMENT);
  assert.equal(status(root).trim(), `M ${PATHS.requirements}`, "the migration is left in the working tree, uncommitted");
  assert.equal(record.result.length, 1);
  assert.deepEqual(Object.keys(record.result[0]).sort(), ["answered", "diff", "migration", "settled", "source", "summary", "target"]);
  assert.equal(record.result[0].migration, migration.id);
  assert.equal(record.result[0].summary, "Adds the anchor of section 2.");
  const entry = await entryFor(call, PATHS.requirements);
  assert.equal(entry.conforms, true);
  assert.equal(entry.migration, null, "no run holds the artifact at its new version");
});

test("clauses 11, 12, 14, 16: unknown values are points the run asks about once, with a recommendation each, and the run then waits", async (context) => {
  const { root, call } = await runCheckout(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE });
  const run = await runFor(call, AUDIT);
  const bare = await call("propose_migration", auditProposal(run));
  assert.equal(bare.value?.code, "migration_unsettled", bare.text);
  assert.ok(bare.value.points.every((point) => point.kind === "unknown"), JSON.stringify(bare.value.points));
  const unknowns = bare.value.points;
  const settledUnknown = await call("propose_migration", auditProposal(run, { settled: [{ point: unknowns[0], reason: "It is unknown." }] }));
  assert.equal(settledUnknown.value?.code, "migration_unsettled", "an unknown value is always asked, never settled");
  const asked = unknowns.map((point) => ({ point, recommendation: "Leave it unknown until the team decides." }));
  const proposed = await call("propose_migration", auditProposal(run, { asked }));
  assert.equal(proposed.refused, false, proposed.text);
  const points = proposed.value.migration.points;
  assert.ok(points.length >= 6, "Pattern, Rationale, and the three empty sections are unknown");
  for (const point of points) {
    assert.match(point.id, /^p\d+$/);
    assert.equal(point.kind, "unknown");
    assert.equal(point.settled, null);
    assert.equal(point.asked.recommendation, "Leave it unknown until the team decides.");
  }
  const finished = await call("finish_migration_run", { run });
  assert.equal(finished.refused, false, finished.text);
  const record = await readRun(call, run);
  assert.equal(record.status, "asking");
  assert.equal(record.question.points.length, points.length);
  assert.equal(typeof record.question.askedAt, "string");
  assert.equal(await readFile(path.join(root, AUDIT), "utf8"), AUDIT_SOURCE, "nothing applies before the person answers");
  const again = await call("propose_migration", auditProposal(run, { asked }));
  assert.equal(again.value?.code, "migration_run_closed", "a waiting run takes no proposal");
});

test("clauses 9, 10, 12, 13: proposals outside the run's set, unsettled leftovers, and statements moved between sections that do not correspond are refused", async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [AUDIT]: AUDIT_SOURCE });
  const run = await runFor(call, AUDIT);
  assert.equal((await call("propose_migration", auditProposal("run-0000000000000000"))).value?.code, "migration_run_unknown");
  const outside = await call("propose_migration", { ...auditProposal(run), source: PATHS.requirements, target: PATHS.requirements, content: REQUIREMENT });
  assert.equal(outside.value?.code, "invalid_input", "a conforming file is no artifact of the run's set");
  const moved = auditContent({ problem: "unknown" }).replace("## Goals\n\nunknown", "## Goals\n\nAdministrators change settings that nobody can trace.");
  const misplaced = await call("propose_migration", auditProposal(run, { content: moved }));
  assert.equal(misplaced.value?.code, "migration_misplaced", misplaced.text);
  assert.deepEqual(misplaced.value.statements.map((statement) => [statement.text, statement.from, statement.to]), [["Administrators change settings that nobody can trace.", "Context", "Goals"]]);
  const dropped = auditContent({ problem: "unknown" });
  const leftover = await call("propose_migration", auditProposal(run, { content: dropped, leftovers: [{ statement: "Administrators change settings that nobody can trace.", home: "The project's README." }] }));
  assert.equal(leftover.value?.code, "migration_unsettled", "a leftover's home must be settled or asked");
  assert.ok(leftover.value.points.some((point) => point.kind === "leftover" && point.statement === "Administrators change settings that nobody can trace."));
});

test("clauses 15, 23: a run finishes only once each artifact of its set is proposed, and a failed run applies nothing and takes no further call", async (context) => {
  const { root, call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED });
  const run = await runFor(call, PATHS.requirements);
  const early = await call("finish_migration_run", { run });
  assert.equal(early.value?.code, "migration_run_incomplete", early.text);
  assert.deepEqual(early.value.artifacts.map((artifact) => artifact.path), [PATHS.requirements]);
  assert.equal((await call("propose_migration", repairProposal(run))).refused, false);
  const failed = await call("fail_migration_run", { run, reason: "The section numbers are ambiguous." });
  assert.equal(failed.refused, false, failed.text);
  const record = await readRun(call, run);
  assert.equal(record.status, "failed");
  assert.equal(record.failure.reason, "The section numbers are ambiguous.");
  assert.equal(await readFile(path.join(root, PATHS.requirements), "utf8"), UNANCHORED);
  assert.equal((await call("finish_migration_run", { run })).value?.code, "migration_run_closed");
  assert.equal((await call("fail_migration_run", { run, reason: "Again." })).value?.code, "migration_run_closed");
  assert.equal((await call("get_migration_run", { run: "run-0000000000000000" })).value?.code, "migration_run_unknown");
});

test("clause 18: a source that changed since its proposal fails the run and changes nothing", async (context) => {
  const { root, call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED });
  const run = await runFor(call, PATHS.requirements);
  assert.equal((await call("propose_migration", repairProposal(run))).refused, false);
  const changed = UNANCHORED.replace("Clients give up on the first dropped connection.", "Clients give up on the first dropped connection, every time.");
  await writeFile(path.join(root, PATHS.requirements), changed);
  await call("finish_migration_run", { run });
  const record = await readRun(call, run);
  assert.equal(record.status, "failed");
  assert.ok(record.failure.reason.includes(PATHS.requirements), record.failure.reason);
  assert.equal(await readFile(path.join(root, PATHS.requirements), "utf8"), changed);
});

test("clause 5: a run is no roadmap entry, initiative, or slice", async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED });
  await runFor(call, PATHS.requirements);
  const roadmap = await call("get_roadmap", {});
  assert.deepEqual(roadmap.value?.record?.initiatives ?? [], []);
  assert.equal(JSON.stringify(roadmap.value ?? {}).includes("run-"), false);
});

test("clause 24: the person's accept-and-apply tools of a single migration no longer exist", async (context) => {
  const { call } = await runCheckout(context);
  for (const name of ["get_migration", "apply_migration"]) {
    const called = await call(name, { id: "migration-00000000" });
    assert.equal(called.refused, true, `${name} is refused`);
    assert.match(called.text, /unknown tool|not found|no tool/i, called.text);
  }
  const wait = await call("wait_for_user_gate", { migration: "migration-00000000" });
  assert.equal(wait.refused, true, "wait_for_user_gate takes no migration");
});
