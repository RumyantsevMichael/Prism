import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONFORMING, GLOSSARY, PATHS, checked, entryOf, formatServer, read, write } from "./fixtures/artifact-formats.mjs";
import { isolatedEnv } from "./fixtures/isolated-env.mjs";
import { defer } from "./fixtures/teardown.mjs";

// A migration accounts for every source statement, keeps decisions and the target's entries, and applies only after a person accepts it.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-migration-data-")));
process.env.PLUGIN_DATA = privateData;
process.env.PRISM_REVIEW_APP_DIR = path.join(privateData, "app");
delete process.env.CLAUDE_PLUGIN_DATA;
const { applyAction, listActions } = await import("../../dist/server/workflow/actions.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const TERMS = "docs/notes/terms.md";
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
const glossaryProposal = (extra = {}) => ({ type: "glossary", source: TERMS, target: PATHS.glossary, content: MIGRATED_GLOSSARY, summary: "Moves the one term of the payments team's list into the glossary and lists its writing rule for the project instructions.", leftovers: LEFTOVERS, ...extra });

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
const auditProposal = (content = auditContent()) => ({ type: "requirements", source: AUDIT, target: AUDIT, content, summary: "Adds the format's sections and fields around the one obligation and marks the values the file never gave as unknown.", leftovers: [] });

async function project(context, files = {}) {
  return formatServer(context, { ...CONFORMING, [TERMS]: TERMS_TEXT, [AUDIT]: AUDIT_SOURCE, ...files });
}

async function propose(call, args) {
  const result = await call("propose_migration", args);
  return { ...result, migration: result.value?.migration ?? null };
}

async function answer(root, id, input) {
  const listed = await listActions({ projectRoot: root, target: `migration:${id}` });
  const action = listed.actions.find((entry) => entry.id === "migration.answer");
  assert.ok(action, "the migration lists its answer action");
  return applyAction({ projectRoot: root, target: `migration:${id}`, action: "migration.answer", input, revision: action.revision, confirmed: true });
}

const exists = (root, file) => stat(path.join(root, file)).then(() => true, () => false);

test("clauses 28, 36, 37, 48: a proposal that places every statement returns a pending migration with its diff, leftovers, and unknowns", async (context) => {
  const { call } = await project(context);
  const { migration, text } = await propose(call, glossaryProposal());
  assert.ok(migration, text);
  assert.match(migration.id, /^migration-[0-9a-f]+$/);
  assert.deepEqual([migration.type, migration.separateSource, migration.status], ["glossary", true, "pending"]);
  assert.deepEqual([migration.source, migration.target], [{ path: TERMS, scope: null }, { path: PATHS.glossary, scope: null }], "a project without a store names checkout files with no scope");
  assert.deepEqual(migration.leftovers, LEFTOVERS);
  assert.deepEqual(migration.unknowns, []);
  assert.deepEqual(migration.conflicts, []);
  assert.match(migration.diff, /^\+## Backoff$/m);
  assert.match(migration.diff, /^-\| Backoff \| The wait between two attempts\. \|$/m);
  assert.match(migration.targetDiff, /^\+## Backoff$/m);
  assert.ok(Date.parse(migration.proposedAt) <= Date.now());
  const read = await call("get_migration", { id: migration.id });
  assert.deepEqual([read.value.migration.id, read.value.migration.answer, read.value.migration.appliedAt], [migration.id, null, null]);
  assert.equal((await call("get_migration", { id: "migration-00000000" })).value?.code, "migration_unknown");
});

test("clauses 29, 30: a source statement that is placed nowhere refuses the proposal and is listed", async (context) => {
  const { call } = await project(context);
  const refused = await propose(call, glossaryProposal({ leftovers: [LEFTOVERS[0]] }));
  assert.equal(refused.value?.code, "migration_unaccounted", refused.text);
  assert.deepEqual(refused.value.statements.map((statement) => statement.text), ["Always write backoff as one word."]);
  assert.equal(refused.value.statements[0].line, TERMS_TEXT.split("\n").indexOf("Always write backoff as one word.") + 1);
});

test("clause 31: a statement that neither the source nor the target holds refuses the proposal as invented", async (context) => {
  const { call } = await project(context);
  const refused = await propose(call, glossaryProposal({ content: MIGRATED_GLOSSARY.replace("The wait between two attempts.\n", "The wait between two attempts.\nBackoff grows with each attempt.\n") }));
  assert.equal(refused.value?.code, "migration_invented", refused.text);
  assert.deepEqual(refused.value.statements.map((statement) => statement.text), ["Backoff grows with each attempt."]);
});

test("clause 31: a date from the source's Git history, here its commit on 2026-03-14, is not invented, and another date is", async (context) => {
  const undated = AUDIT_SOURCE.replace("Created: 2026-08-01\n", "");
  const { call } = await project(context, { [AUDIT]: undated });
  assert.equal((await propose(call, auditProposal(auditContent({ created: "2026-03-14" })))).migration?.status, "pending");
  const other = await project(context, { [AUDIT]: undated });
  const refused = await propose(other.call, auditProposal(auditContent({ created: "2026-01-01" })));
  assert.equal(refused.value?.code, "migration_invented", refused.text);
});

test("clauses 10, 36: unknown values the source never gave are listed with the migration", async (context) => {
  const { call } = await project(context);
  const { migration, text } = await propose(call, auditProposal());
  assert.ok(migration, text);
  assert.equal(migration.separateSource, false);
  assert.equal(migration.targetDiff, null);
  assert.deepEqual(migration.unknowns.map((item) => item.field).sort(), ["Design questions", "Goals", "Non-goals", "Pattern", "Problem", "Rationale"]);
});

test("clause 32: content that breaks its format refuses the proposal and names the target", async (context) => {
  const { call } = await project(context);
  const refused = await propose(call, auditProposal(auditContent().replace("## Problem\n\nunknown\n\n", "")));
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  assert.equal(refused.value.artifacts[0].path, AUDIT);
});

test("clause 33: migrating an Approved file keeps its status, dates, and identities", async (context) => {
  const { call } = await project(context, { [AUDIT]: AUDIT_SOURCE.replace("## 1\n", "<a id=\"7\"></a>\n## 7\n") });
  const status = await propose(call, auditProposal(auditContent({ status: "Draft", anchor: "7" }).replace("Approved: 2026-08-02", "Approved: n/a")));
  assert.equal(status.value?.code, "migration_changes_decision", status.text);
  assert.deepEqual(status.value.changed.map((change) => change.field).sort(), ["Approved", "Status"]);
  const identity = await propose(call, auditProposal(auditContent({ anchor: "1" })));
  assert.equal(identity.value?.code, "migration_changes_decision", identity.text);
  assert.deepEqual(identity.value.changed.map((change) => [change.before, change.after]), [["7", null]]);
  assert.equal((await propose(call, auditProposal(auditContent({ anchor: "7" })))).migration?.status, "pending");
});

test("clause 34: content that rewrites the target's entry is refused, and a listed conflict keeps the target's entry", async (context) => {
  const conflicting = TERMS_TEXT.replace("| Backoff | The wait between two attempts. |", "| Backoff | The wait between two attempts. |\n| Retry deadline | The longest a request may wait. |");
  const { call } = await project(context, { [TERMS]: conflicting });
  const theirs = `<a id="retry-deadline"></a>\n## Retry deadline\n\nThe longest a request may wait.\n\nSource: migration\n`;
  const overwritten = MIGRATED_GLOSSARY.replace(/<a id="retry-deadline"><\/a>[\s\S]*?(?=<a id="attempt-timeout">)/, `${theirs}\n`);
  const refused = await propose(call, glossaryProposal({ content: overwritten }));
  assert.equal(refused.value?.code, "migration_conflict", refused.text);
  assert.match(refused.text, /retry-deadline/);
  const { migration, text } = await propose(call, glossaryProposal({ conflicts: [{ entry: "retry-deadline", content: theirs }] }));
  assert.ok(migration, text);
  assert.deepEqual(migration.conflicts.map((conflict) => conflict.entry), ["retry-deadline"]);
  assert.match(migration.conflicts[0].target, /The total time a request may spend/);
  assert.match(migration.conflicts[0].source, /The longest a request may wait\./);
});

test("clause 35: a second proposal for a target with a pending migration is refused", async (context) => {
  const { call } = await project(context);
  assert.ok((await propose(call, glossaryProposal())).migration);
  assert.equal((await propose(call, glossaryProposal())).value?.code, "migration_pending");
});

test("clauses 39, 41: a migration applies only after acceptance, records who accepted it, keeps the source unless its removal was accepted, and applies once", async (context) => {
  const { root, call } = await project(context);
  const { migration } = await propose(call, glossaryProposal());
  assert.equal((await call("apply_migration", { id: migration.id })).value?.code, "migration_not_accepted");
  await answer(root, migration.id, { decision: "accept", removeSource: "off" });
  await assert.rejects(answer(root, migration.id, { decision: "decline" }), (error) => error.code === "already_answered" || /already/.test(error.message));
  const applied = await call("apply_migration", { id: migration.id });
  assert.equal(applied.value?.code ?? null, null, applied.text);
  assert.deepEqual([applied.value.written, applied.value.removed], [[{ path: PATHS.glossary, scope: null }], []]);
  assert.equal(applied.value.acceptedBy.name, "Ada Reviewer");
  assert.ok(Date.parse(applied.value.acceptedAt) <= Date.now());
  const glossary = await read(root, PATHS.glossary);
  assert.match(glossary, new RegExp(`^Source: migration ${migration.id}$`, "m"), "the term's source names the migration");
  assert.equal(await exists(root, TERMS), true, "the source stays without an accepted removal");
  const entry = entryOf(await checked(call, [PATHS.glossary]), PATHS.glossary);
  assert.deepEqual(entry.findings, [], "an applied migration is a decided source");
  assert.equal((await call("apply_migration", { id: migration.id })).value?.code, "migration_applied");
  const after = (await call("get_migration", { id: migration.id })).value.migration;
  assert.equal(after.answer.decision, "accept");
  assert.equal(after.answer.by.name, "Ada Reviewer");
  assert.ok(after.appliedAt);
});

test("clause 41: an accepted removal removes a separate source, and a chosen source entry replaces the target's", async (context) => {
  const conflicting = TERMS_TEXT.replace("| Backoff | The wait between two attempts. |", "| Backoff | The wait between two attempts. |\n| Retry deadline | The longest a request may wait. |");
  const { root, call } = await project(context, { [TERMS]: conflicting });
  const theirs = `<a id="retry-deadline"></a>\n## Retry deadline\n\nThe longest a request may wait.\n\nSource: migration\n`;
  const { migration, text } = await propose(call, glossaryProposal({ conflicts: [{ entry: "retry-deadline", content: theirs }] }));
  assert.ok(migration, text);
  await answer(root, migration.id, { decision: "accept", removeSource: "on", "conflict:retry-deadline": "source" });
  const applied = await call("apply_migration", { id: migration.id });
  assert.deepEqual([applied.value.written, applied.value.removed], [[{ path: PATHS.glossary, scope: null }], [{ path: TERMS, scope: null }]]);
  assert.equal(await exists(root, TERMS), false);
  const glossary = await read(root, PATHS.glossary);
  assert.match(glossary, /The longest a request may wait\./);
  assert.doesNotMatch(glossary, /The total time a request may spend/);
});

test("clause 41: a declined migration and one whose source changed since the proposal do not apply", async (context) => {
  const { root, call } = await project(context);
  const declined = (await propose(call, auditProposal())).migration;
  await answer(root, declined.id, { decision: "decline" });
  assert.equal((await call("apply_migration", { id: declined.id })).value?.code, "migration_not_accepted");
  assert.equal(await read(root, AUDIT), AUDIT_SOURCE);
  const { migration } = await propose(call, glossaryProposal());
  await answer(root, migration.id, { decision: "accept" });
  await write(root, TERMS, `${TERMS_TEXT}\nA later line.\n`);
  const stale = await call("apply_migration", { id: migration.id });
  assert.equal(stale.value?.code, "migration_stale", stale.text);
  assert.match(stale.text, /docs\/notes\/terms\.md/);
  assert.equal(await read(root, PATHS.glossary), GLOSSARY, "nothing is written");
});

test("clause 40: wait_for_user_gate returns a migration's answer once the person answers", { timeout: 60000 }, async (context) => {
  const { root, call } = await project(context);
  const { migration } = await propose(call, glossaryProposal());
  const server = spawn(process.execPath, [fileURLToPath(new URL("../../dist/server/mcp.mjs", import.meta.url))], { cwd: root, env: isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_REVIEW_APP_DIR: path.join(privateData, "app"), PLUGIN_DATA: privateData, PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./fixtures/native-manifest-unavailable.json", import.meta.url)), PRISM_GATE_WAIT_HEARTBEAT_MS: "200", PRISM_GATE_WAIT_SETTLE_MS: "600", CLAUDE_PROJECT_DIR: root }), stdio: ["pipe", "pipe", "pipe"] });
  server.stderr.resume();
  defer(context, async () => {
    if (server.exitCode === null) {
      server.stdin.end();
      await new Promise((resolve) => server.once("exit", resolve));
    }
  });
  const responses = new Map();
  readline.createInterface({ input: server.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) responses.get(message.id)?.(message);
  });
  const request = (id, method, params) => new Promise((resolve) => {
    responses.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.296" } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const waiting = request(2, "tools/call", { name: "wait_for_user_gate", arguments: { projectRoot: root, migration: migration.id, maxWaitMinutes: 1 }, _meta: { progressToken: "wait-2" } });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await answer(root, migration.id, { decision: "accept" });
  const result = (await waiting).result?.structuredContent;
  assert.equal(result?.status, "answered", JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes("\"accept\""), true, "the answer carries the decision");
});
