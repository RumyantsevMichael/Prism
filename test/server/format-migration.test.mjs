import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFORMING, GLOSSARY, PATHS, checked, entryOf, formatServer, read, write } from "./fixtures/artifact-formats.mjs";
import { waitFor } from "./fixtures/format-migration-runs.mjs";

// A format migration inside its run accounts for every source statement, keeps decisions and the target's entries, settles or asks each point,
// and applies once the run finishes, with the person's answers to what it asked.

const TERMS = "docs/requirements/terms.md";
const TERMS_TEXT = `# Payment terms

Terms used by the payments team.

| Term | Definition |
| --- | --- |
| Backoff | The wait between two attempts. |

Always write backoff as one word.
`;
const BACKOFF = `<a id="backoff"></a>\n## Backoff\n\nThe wait between two attempts.\n\nSource: migration\n`;
const MIGRATED_GLOSSARY = `${GLOSSARY}\n${BACKOFF}`;
const LEFTOVERS = [
  { statement: "Terms used by the payments team.", home: "Dropped: the glossary keeps its own purpose." },
  { statement: "Always write backoff as one word.", home: "The project instructions, as a writing rule." }
];
const settledLeftovers = (leftovers = LEFTOVERS) => leftovers.map((leftover) => ({ point: { kind: "leftover", statement: leftover.statement }, reason: "The glossary states its own purpose, and a writing rule belongs to no term." }));
const REMOVE = { point: { kind: "remove-source" }, recommendation: "Remove it, since its one term now lives in the glossary." };
const glossaryProposal = (run, extra = {}) => ({ run, type: "glossary", source: TERMS, target: PATHS.glossary, content: MIGRATED_GLOSSARY, summary: "Moves the one term of the payments team's list into the glossary and lists its writing rule for the project instructions.", leftovers: LEFTOVERS, settled: settledLeftovers(), asked: [REMOVE], ...extra });

const AUDIT = "docs/requirements/audit.md";
const AUDIT_SOURCE = "# Audit log\n\nStatus: Approved\nCreated: 2026-08-01\nApproved: 2026-08-02\n\n## 1\n\nThe system shall record every administrative action.\n";
const auditContent = ({ status = "Approved", created = "2026-08-01", anchor = "1" } = {}) => `# Audit log

Status: ${status}
Created: ${created}
Approved: 2026-08-02

## Problem

unknown

## Goals

unknown

## Non-goals

unknown

## Design questions

unknown

<a id="${anchor}"></a>
## ${anchor}. Record administrative actions

Pattern: unknown

Disposition: Active

Requirement: The system shall record every administrative action.

Rationale: unknown

Related: n/a
`;
const auditProposal = (run, content = auditContent()) => ({ run, type: "requirements", source: AUDIT, target: AUDIT, content, summary: "Adds the format's sections and fields around the one obligation and marks the values the file never gave as unknown.", leftovers: [] });

async function project(context, files = { [TERMS]: TERMS_TEXT, [AUDIT]: AUDIT_SOURCE }) {
  const server = await formatServer(context, { ...CONFORMING, ...files });
  const run = (await waitFor(async () => entryOf(await checked(server.call, [Object.keys(files)[0]]), Object.keys(files)[0])?.migration ?? null, { what: "the run of the requirements set" })).run;
  return { ...server, run };
}

// A proposal whose only refusal is its unanswered unknown points, proposed again with each asked.
async function propose(call, args) {
  let result = await call("propose_migration", args);
  if (result.value?.code === "migration_unsettled" && result.value.points.every((point) => point.kind === "unknown")) {
    result = await call("propose_migration", { ...args, asked: [...(args.asked ?? []), ...result.value.points.map((point) => ({ point, recommendation: "Leave it unknown until the team decides." }))] });
  }
  return { ...result, migration: result.value?.migration ?? null };
}

// The person's answers to a run's question, as the review app records them, with the run continuing.
async function answer(root, run, answers) {
  const file = path.join(root, ".prism", "format-migrations", `${run}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  const at = new Date().toISOString();
  record.answers = Object.fromEntries(Object.entries(answers).map(([point, value]) => [point, { ...value, by: { name: "Ada Reviewer" }, at }]));
  record.status = "continuing";
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

const exists = (root, file) => stat(path.join(root, file)).then(() => true, () => false);

test("clauses 9, 14: a proposal that places every statement returns a proposed migration with its diff, leftovers, points, and unknowns, which the run lists", async (context) => {
  const { call, run } = await project(context);
  const { migration, text } = await propose(call, glossaryProposal(run));
  assert.ok(migration, text);
  assert.match(migration.id, /^migration-[0-9a-f]+$/);
  assert.deepEqual([migration.run, migration.type, migration.separateSource, migration.status], [run, "glossary", true, "proposed"]);
  assert.deepEqual([migration.source, migration.target], [{ path: TERMS, scope: null }, { path: PATHS.glossary, scope: null }], "a project without a store names checkout files with no scope");
  assert.deepEqual(migration.leftovers, LEFTOVERS);
  assert.deepEqual(migration.unknowns, []);
  assert.deepEqual(migration.conflicts, []);
  assert.deepEqual(migration.points.map((point) => [point.kind, point.settled ? "settled" : "asked"]), [["leftover", "settled"], ["leftover", "settled"], ["remove-source", "asked"]]);
  assert.match(migration.diff, /^\+## Backoff$/m);
  assert.match(migration.diff, /^-\| Backoff \| The wait between two attempts\. \|$/m);
  assert.match(migration.targetDiff, /^\+## Backoff$/m);
  assert.ok(Date.parse(migration.proposedAt) <= Date.now());
  const listed = (await call("get_migration_run", { run })).value.run;
  assert.deepEqual(listed.migrations.map((item) => item.id), [migration.id]);
  assert.equal(listed.migrations[0].content, undefined, "a reader never gets the content that only applying needs");
  const again = (await propose(call, glossaryProposal(run))).migration;
  assert.equal(again.id, migration.id, "a proposal of the same source replaces the earlier one and keeps its id");
  assert.deepEqual(again.points.map((point) => point.id), migration.points.map((point) => point.id), "and each point's id");
});

test("clauses 29, 30: a source statement that is placed nowhere refuses the proposal and is listed", async (context) => {
  const { call, run } = await project(context);
  const refused = await propose(call, glossaryProposal(run, { leftovers: [LEFTOVERS[0]], settled: settledLeftovers([LEFTOVERS[0]]) }));
  assert.equal(refused.value?.code, "migration_unaccounted", refused.text);
  assert.deepEqual(refused.value.statements.map((statement) => statement.text), ["Always write backoff as one word."]);
  assert.equal(refused.value.statements[0].line, TERMS_TEXT.split("\n").indexOf("Always write backoff as one word.") + 1);
});

test("clause 31: a statement that neither the source nor the target holds refuses the proposal as invented", async (context) => {
  const { call, run } = await project(context);
  const refused = await propose(call, glossaryProposal(run, { content: MIGRATED_GLOSSARY.replace("The wait between two attempts.\n", "The wait between two attempts.\nBackoff grows with each attempt.\n") }));
  assert.equal(refused.value?.code, "migration_invented", refused.text);
  assert.deepEqual(refused.value.statements.map((statement) => statement.text), ["Backoff grows with each attempt."]);
});

test("clause 31: a date from the source's Git history, here its commit on 2026-03-14, is not invented, and another date is", async (context) => {
  const undated = AUDIT_SOURCE.replace("Created: 2026-08-01\n", "");
  const { call, run } = await project(context, { [AUDIT]: undated });
  assert.equal((await propose(call, auditProposal(run, auditContent({ created: "2026-03-14" })))).migration?.status, "proposed");
  const other = await project(context, { [AUDIT]: undated });
  const refused = await propose(other.call, auditProposal(other.run, auditContent({ created: "2026-01-01" })));
  assert.equal(refused.value?.code, "migration_invented", refused.text);
});

test("clauses 11, 12: unknown values the source never gave are points the proposal must ask about, and settling one is refused", async (context) => {
  const { call, run } = await project(context);
  const bare = await call("propose_migration", auditProposal(run));
  assert.equal(bare.value?.code, "migration_unsettled", bare.text);
  assert.deepEqual(bare.value.points.map((point) => point.field).sort(), ["Design questions", "Goals", "Non-goals", "Pattern", "Problem", "Rationale"]);
  assert.ok(bare.value.points.every((point) => point.allowsUnknown === false), "an Approved target needs every value");
  const settled = await call("propose_migration", { ...auditProposal(run), settled: [{ point: bare.value.points[0], reason: "It is unknown." }], asked: bare.value.points.map((point) => ({ point, recommendation: "Ask the owner." })) });
  assert.equal(settled.value?.code, "migration_unsettled", "a derived point under settled is never settled");
  const { migration, text } = await propose(call, auditProposal(run));
  assert.ok(migration, text);
  assert.equal(migration.separateSource, false);
  assert.equal(migration.targetDiff, null);
  assert.deepEqual(migration.unknowns.map((item) => item.field).sort(), ["Design questions", "Goals", "Non-goals", "Pattern", "Problem", "Rationale"]);
});

test("clause 14: content that breaks its format other than through unknown values refuses the proposal and names the target", async (context) => {
  const { call, run } = await project(context);
  const refused = await propose(call, auditProposal(run, auditContent().replace("## Problem\n\nunknown\n\n", "")));
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  assert.equal(refused.value.artifacts[0].path, AUDIT);
});

test("clause 33: migrating an Approved file keeps its status, dates, and identities", async (context) => {
  const { call, run } = await project(context, { [AUDIT]: AUDIT_SOURCE.replace("## 1\n", "<a id=\"7\"></a>\n## 7\n") });
  const status = await propose(call, auditProposal(run, auditContent({ status: "Draft", anchor: "7" }).replace("Approved: 2026-08-02", "Approved: n/a")));
  assert.equal(status.value?.code, "migration_changes_decision", status.text);
  assert.deepEqual(status.value.changed.map((change) => change.field).sort(), ["Approved", "Status"]);
  const identity = await propose(call, auditProposal(run, auditContent({ anchor: "1" })));
  assert.equal(identity.value?.code, "migration_changes_decision", identity.text);
  assert.deepEqual(identity.value.changed.map((change) => [change.before, change.after]), [["7", null]]);
  assert.equal((await propose(call, auditProposal(run, auditContent({ anchor: "7" })))).migration?.status, "proposed");
});

test("clauses 11, 34: content that rewrites the target's entry is refused, and a listed conflict keeps the target's entry and is a point to ask", async (context) => {
  const conflicting = TERMS_TEXT.replace("| Backoff | The wait between two attempts. |", "| Backoff | The wait between two attempts. |\n| Retry deadline | The longest a request may wait. |");
  const { call, run } = await project(context, { [TERMS]: conflicting });
  const theirs = `<a id="retry-deadline"></a>\n## Retry deadline\n\nThe longest a request may wait.\n\nSource: migration\n`;
  const overwritten = MIGRATED_GLOSSARY.replace(/<a id="retry-deadline"><\/a>[\s\S]*?(?=<a id="attempt-timeout">)/, `${theirs}\n`);
  const refused = await propose(call, glossaryProposal(run, { content: overwritten }));
  assert.equal(refused.value?.code, "migration_conflict", refused.text);
  assert.match(refused.text, /retry-deadline/);
  const unasked = await propose(call, glossaryProposal(run, { conflicts: [{ entry: "retry-deadline", content: theirs }] }));
  assert.equal(unasked.value?.code, "migration_unsettled", unasked.text);
  assert.deepEqual(unasked.value.points, [{ kind: "conflict", entry: "retry-deadline" }]);
  const { migration, text } = await propose(call, glossaryProposal(run, { conflicts: [{ entry: "retry-deadline", content: theirs }], asked: [REMOVE, { point: { kind: "conflict", entry: "retry-deadline" }, recommendation: "Keep the glossary's definition." }] }));
  assert.ok(migration, text);
  assert.deepEqual(migration.conflicts.map((conflict) => conflict.entry), ["retry-deadline"]);
  assert.match(migration.conflicts[0].target, /The total time a request may spend/);
  assert.match(migration.conflicts[0].source, /The longest a request may wait\./);
});

test("clause 10: a second source that the same run would migrate into the same target is refused", async (context) => {
  const OTHER = "docs/requirements/more-terms.md";
  const { call, run } = await project(context, { [TERMS]: TERMS_TEXT, [OTHER]: TERMS_TEXT.replace("# Payment terms", "# More payment terms") });
  assert.ok((await propose(call, glossaryProposal(run))).migration);
  const refused = await propose(call, glossaryProposal(run, { source: OTHER }));
  assert.equal(refused.value?.code, "migration_pending", refused.text);
});

test("clauses 16, 17, 20, 22: a run that asked applies with the person's answers once it continues: the source is removed, the chosen entry kept, and the migration is a decided source", async (context) => {
  const conflicting = TERMS_TEXT.replace("| Backoff | The wait between two attempts. |", "| Backoff | The wait between two attempts. |\n| Retry deadline | The longest a request may wait. |");
  const { root, call, run } = await project(context, { [TERMS]: conflicting });
  const theirs = `<a id="retry-deadline"></a>\n## Retry deadline\n\nThe longest a request may wait.\n\nSource: migration\n`;
  const { migration, text } = await propose(call, glossaryProposal(run, { conflicts: [{ entry: "retry-deadline", content: theirs }], asked: [REMOVE, { point: { kind: "conflict", entry: "retry-deadline" }, recommendation: "Keep the glossary's definition." }] }));
  assert.ok(migration, text);
  assert.equal((await call("finish_migration_run", { run })).value.run.status, "asking");
  assert.equal(await read(root, PATHS.glossary), GLOSSARY, "nothing applies before the answers");
  const point = (kind) => migration.points.find((item) => item.kind === kind).id;
  await answer(root, run, { [point("remove-source")]: { choice: "remove", value: null }, [point("conflict")]: { choice: "source", value: null } });
  const finished = (await call("finish_migration_run", { run })).value.run;
  assert.equal(finished.status, "applied", JSON.stringify(finished.failure));
  assert.equal(await exists(root, TERMS), false, "the source the person chose to remove is gone");
  const glossary = await read(root, PATHS.glossary);
  assert.match(glossary, /The longest a request may wait\./);
  assert.doesNotMatch(glossary, /The total time a request may spend/);
  assert.match(glossary, new RegExp(`^Source: migration ${migration.id}$`, "m"), "the term's source names the migration");
  assert.deepEqual(finished.result[0].answered.map((item) => item.choice).sort(), ["remove", "source"]);
  const entry = entryOf(await checked(call, [PATHS.glossary]), PATHS.glossary);
  assert.deepEqual(entry.findings, [], "a migration whose run applied is a decided source");
});

test("clause 16: a run that asked once and still holds an unanswered point fails when it finishes again", async (context) => {
  const { root, call, run } = await project(context, { [TERMS]: TERMS_TEXT });
  assert.ok((await propose(call, glossaryProposal(run))).migration);
  assert.equal((await call("finish_migration_run", { run })).value.run.status, "asking");
  await answer(root, run, {});
  const finished = (await call("finish_migration_run", { run })).value.run;
  assert.equal(finished.status, "failed");
  assert.equal(finished.failure.reason, "The run asked again after the person answered.");
  assert.equal(await read(root, PATHS.glossary), GLOSSARY);
  assert.equal(await exists(root, TERMS), true);
  await write(root, TERMS, TERMS_TEXT);
});
