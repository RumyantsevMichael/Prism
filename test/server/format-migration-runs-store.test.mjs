import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { labelOf, storeRead } from "./fixtures/artifact-formats-store.mjs";
import { AUDIT, AUDIT_SOURCE, LOG_ADR, LOG_ADR_SOURCE, auditProposal, logAdrContent, readRun, runFor, runStore } from "./fixtures/format-migration-runs.mjs";

// Format migration runs of store artifacts: applied through the store's writes as a commit of their own, keeping recorded statuses,
// with the migrated text as a decided artifact's accepted version attributed to the run.

const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const TERMS = "docs/requirements/terms.md";
const TERMS_TEXT = "# Payment terms\n\nTerms used by the payments team.\n\n| Term | Definition |\n| --- | --- |\n| Backoff | The wait between two attempts. |\n";
const storeGit = (place, ...args) => execFileSync("git", args, { cwd: place.store, encoding: "utf8" });

test("clauses 1, 3, 16, 17, 19, 21: an applied run writes a store requirement through the store, keeps its recorded status, makes the migrated text its accepted version, and commits it on its own", async (context) => {
  const { place, call } = await runStore(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED }, { gitStore: true });
  const run = await runFor(call, PATHS.requirements);
  const record = await readRun(call, run);
  assert.equal(labelOf(record.set), "api", "the set belongs to the scope that holds its artifacts");
  assert.deepEqual(record.set.artifacts.map((artifact) => [artifact.path, labelOf(artifact)]), [[PATHS.requirements, "api"]]);
  const proposed = await call("propose_migration", { run, type: "requirements", source: PATHS.requirements, target: PATHS.requirements, content: REQUIREMENT, summary: "Adds the anchor of section 2.", leftovers: [] });
  assert.equal(proposed.refused, false, proposed.text);
  assert.equal((await call("finish_migration_run", { run })).refused, false);
  assert.equal((await readRun(call, run)).status, "applied");
  const after = await storeRead(call, PATHS.requirements);
  assert.equal(after.content, REQUIREMENT);
  assert.equal(after.status, "Approved", "the recorded status stays");
  assert.equal(after.acceptedVersion, after.version, "the migrated text is the accepted version");
  assert.equal(after.changedSinceAccepted, false);
  assert.equal(after.acceptedFrom?.migration, run, "the accepted version is attributed to the run");
  const subjects = storeGit(place, "log", "--format=%s").split("\n");
  assert.ok(subjects.includes(`prism: format migration ${run}`), subjects.join("\n"));
  const commit = storeGit(place, "log", "--format=%H", "--grep", `prism: format migration ${run}`).trim().split("\n")[0];
  const files = storeGit(place, "show", "--name-only", "--format=", commit).split("\n").filter(Boolean);
  assert.ok(files.length > 0 && files.every((file) => file.includes("retries")), `the run's commit holds only its own artifact's files: ${files.join(", ")}`);
});

test("clauses 11, 16: a migration of an Accepted ADR that needs values its source never gave asks about each one", async (context) => {
  const { call } = await runStore(context, { ...CONFORMING, [LOG_ADR]: LOG_ADR_SOURCE });
  const run = await runFor(call, LOG_ADR);
  const content = logAdrContent();
  const probe = await call("propose_migration", { run, type: "adr", source: LOG_ADR, target: LOG_ADR, content, summary: "Brings the decision into the ADR format.", leftovers: [] });
  assert.equal(probe.value?.code, "migration_unsettled", probe.text);
  const asked = probe.value.points.map((point) => ({ point, recommendation: "Ask the decision's owner." }));
  const proposed = await call("propose_migration", { run, type: "adr", source: LOG_ADR, target: LOG_ADR, content, summary: "Brings the decision into the ADR format.", leftovers: [], asked });
  assert.equal(proposed.refused, false, proposed.text);
  assert.deepEqual(proposed.value.migration.points.map((point) => point.field).sort(), ["Alternatives", "Mechanism", "Rationale"]);
  await call("finish_migration_run", { run });
  const record = await readRun(call, run);
  assert.equal(record.status, "asking");
  assert.equal((await storeRead(call, LOG_ADR)).content, LOG_ADR_SOURCE, "nothing applies before the answers");
});

test("clauses 11, 26: an unknown point of an Accepted ADR does not allow unknown, while one of a Draft requirement file does", async (context) => {
  const { call } = await runStore(context, { ...CONFORMING, [LOG_ADR]: LOG_ADR_SOURCE, [AUDIT]: AUDIT_SOURCE });
  const run = await runFor(call, LOG_ADR);
  const base = { run, type: "adr", source: LOG_ADR, target: LOG_ADR, content: logAdrContent(), summary: "Brings the decision into the ADR format.", leftovers: [] };
  const probe = await call("propose_migration", base);
  const asked = probe.value.points.map((point) => ({ point, recommendation: "Ask the decision's owner." }));
  const proposed = await call("propose_migration", { ...base, asked });
  assert.equal(proposed.refused, false, proposed.text);
  assert.ok(proposed.value.migration.points.every((point) => point.kind === "unknown" && point.allowsUnknown === false), JSON.stringify(proposed.value.migration.points));
  await call("finish_migration_run", { run });
  const record = await readRun(call, run);
  assert.equal(record.status, "asking");
  assert.ok(record.question.points.every((point) => point.allowsUnknown === false), JSON.stringify(record.question.points));
  const draftRun = await runFor(call, AUDIT);
  const draft = await call("propose_migration", auditProposal(draftRun));
  assert.equal(draft.value?.code, "migration_unsettled", draft.text);
  assert.ok(draft.value.points.every((point) => point.kind === "unknown" && point.allowsUnknown === true), JSON.stringify(draft.value.points));
});

test("clauses 11, 12: a separate source's removal is a point the run must ask about", async (context) => {
  const { call } = await runStore(context, { ...CONFORMING, [TERMS]: TERMS_TEXT });
  const run = await runFor(call, TERMS);
  const glossary = (await storeRead(call, PATHS.glossary)).content;
  const content = `${glossary}\n<a id="backoff"></a>\n## Backoff\n\nThe wait between two attempts.\n\nSource: migration\n`;
  const leftover = { statement: "Terms used by the payments team.", home: "Dropped: the glossary keeps its own purpose." };
  const base = { run, type: "glossary", source: TERMS, target: PATHS.glossary, content, summary: "Moves the payments team's one term into the glossary.", leftovers: [leftover], settled: [{ point: { kind: "leftover", statement: leftover.statement }, reason: "The glossary already states its purpose." }] };
  const unasked = await call("propose_migration", base);
  assert.equal(unasked.value?.code, "migration_unsettled", unasked.text);
  assert.ok(unasked.value.points.some((point) => point.kind === "remove-source"), JSON.stringify(unasked.value.points));
  const proposed = await call("propose_migration", { ...base, asked: [{ point: { kind: "remove-source" }, recommendation: "Remove it, since its one term now lives in the glossary." }] });
  assert.equal(proposed.refused, false, proposed.text);
  const migration = proposed.value.migration;
  assert.equal(migration.separateSource, true);
  assert.deepEqual(migration.points.map((point) => [point.kind, point.settled ? "settled" : "asked"]).sort(), [["leftover", "settled"], ["remove-source", "asked"]]);
});
