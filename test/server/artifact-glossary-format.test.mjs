import assert from "node:assert/strict";
import test from "node:test";
import { ADR, CONFORMING, GLOSSARY, PATHS, REFERENCES, REQUIREMENT, checked, entryOf, exampleOf, formatServer, listedRules, reference, rulesOf } from "./fixtures/artifact-formats.mjs";

// The glossary format: a stable identity, a standalone definition, and a decided source for every term, through check_artifacts.

const RULES = ["glossary.definition", "glossary.fields", "glossary.identity", "glossary.purpose", "glossary.source", "glossary.source-decided", "glossary.source-withdrawn", "glossary.text", "glossary.title"];

async function glossaryEntry(context, glossary, extra = {}) {
  const { call } = await formatServer(context, { ...CONFORMING, [PATHS.glossary]: glossary, ...extra });
  return entryOf(await checked(call, [PATHS.glossary]), PATHS.glossary);
}

const term = (id, name, definition, fields) => `<a id="${id}"></a>\n## ${name}\n\n${definition}\n\n${fields}\n`;
const withTerm = (entry) => `${GLOSSARY}\n${entry}`;

test("clauses 2, 3: the glossary reference states its version and example path, lists exactly its rules, and holds one example", async () => {
  const source = await reference("glossary");
  assert.ok(source, `${REFERENCES.glossary} exists`);
  assert.match(source, /^Format version: \d+\s*$/m);
  assert.match(source, /^## Defaults\s*$/m);
  const example = exampleOf(source);
  assert.equal(example.fences, 2, "the example is the only fenced block under ## Example");
  assert.ok(example.text && example.path);
  assert.deepEqual(listedRules(source), RULES);
});

test("clause 4: the four examples, written at their example paths, conform with no unknown value", async (context) => {
  const files = {};
  for (const type of ["requirements", "adr", "glossary", "feature"]) {
    const source = await reference(type);
    assert.ok(source, `${REFERENCES[type]} exists`);
    const example = exampleOf(source);
    files[example.path] = example.text;
  }
  const { call } = await formatServer(context, files);
  const value = await checked(call);
  for (const file of Object.keys(files)) {
    const entry = entryOf(value, file);
    assert.ok(entry, `${file} is checked`);
    assert.deepEqual(entry.findings, [], file);
    assert.deepEqual(entry.unknowns, [], file);
  }
});

test("clause 8: a glossary with linked sources, an alias, and a distinction conforms", async (context) => {
  const entry = await glossaryEntry(context, GLOSSARY);
  assert.equal(entry.type, "glossary");
  assert.deepEqual(entry.findings, []);
  assert.equal(entry.conforms, true);
});

test("clause 8: a term without an identity anchor, or with a repeated or malformed one, breaks the identity rule", async (context) => {
  const missing = await glossaryEntry(context, `${GLOSSARY}\n## Backoff\n\nThe wait between two attempts.\n\nSource: [retries.md§1](requirements/retries.md#1)\n`);
  assert.deepEqual(rulesOf(missing), ["glossary.identity"]);
  const repeated = await glossaryEntry(context, withTerm(term("retry-deadline", "Deadline", "The end of a retry sequence.", "Source: [retries.md§1](requirements/retries.md#1)")));
  assert.deepEqual(rulesOf(repeated), ["glossary.identity"]);
  const malformed = await glossaryEntry(context, withTerm(term("Back_Off", "Backoff", "The wait between two attempts.", "Source: [retries.md§1](requirements/retries.md#1)")));
  assert.deepEqual(rulesOf(malformed), ["glossary.identity"]);
});

test("clause 8: a definition whose first sentence leans on another breaks the definition rule", async (context) => {
  for (const definition of ["It is the wait between two attempts.", "See attempt timeout.", "The wait between two attempts"]) {
    const entry = await glossaryEntry(context, withTerm(term("backoff", "Backoff", definition, "Source: [retries.md§1](requirements/retries.md#1)")));
    assert.deepEqual(rulesOf(entry), ["glossary.definition"], definition);
  }
});

test("clause 8: a term without a source, with stray text, or with a distinction to an unknown term breaks the fields rule", async (context) => {
  const noSource = await glossaryEntry(context, withTerm(term("backoff", "Backoff", "The wait between two attempts.", "Aliases: delay")));
  assert.deepEqual(rulesOf(noSource), ["glossary.fields"]);
  const stray = await glossaryEntry(context, withTerm(term("backoff", "Backoff", "The wait between two attempts.", "Source: [retries.md§1](requirements/retries.md#1)\nUse it only in client code.")));
  assert.deepEqual(rulesOf(stray), ["glossary.fields"]);
  const distinction = await glossaryEntry(context, withTerm(term("backoff", "Backoff", "The wait between two attempts.", "Source: [retries.md§1](requirements/retries.md#1)\nNot to be confused with: [Jitter](#jitter): jitter varies the wait.")));
  assert.deepEqual(rulesOf(distinction), ["glossary.fields"]);
});

test("clause 8: a source that is neither a link nor a migration breaks the source rule", async (context) => {
  const entry = await glossaryEntry(context, withTerm(term("backoff", "Backoff", "The wait between two attempts.", "Source: the retries meeting")));
  assert.deepEqual(rulesOf(entry), ["glossary.source"]);
});

test("clauses 8, 9: a Draft requirement, a Proposed ADR, a missing file, and an unknown migration are not decided sources", async (context) => {
  const draft = REQUIREMENT.replace("Status: Approved", "Status: Draft").replace("Approved: 2026-09-04", "Approved: n/a");
  const entry = await glossaryEntry(context, withTerm(term("backoff", "Backoff", "The wait between two attempts.", "Source: [draft.md§1](requirements/draft.md#1), [Proposed](ADRs/retries/proposed.md), [gone.md§1](requirements/gone.md#1), migration migration-0123abcd")), {
    "docs/requirements/draft.md": draft,
    "docs/ADRs/retries/proposed.md": ADR.replace("Status: Accepted", "Status: Proposed")
  });
  assert.deepEqual(rulesOf(entry), ["glossary.source-decided"]);
  const message = entry.findings.map((finding) => finding.message).join("\n");
  for (const part of ["requirements/draft.md#1", "Draft", "ADRs/retries/proposed.md", "Proposed", "requirements/gone.md#1", "missing", "migration-0123abcd"]) assert.match(message, new RegExp(part.replace(/[.#/]/g, "\\$&")), part);
});

test("clauses 8, 9: a term whose every source is withdrawn or superseded is reported with every source named", async (context) => {
  const superseded = ADR.replace("Status: Accepted", "Status: Superseded by [Newer](newer.md)");
  const entry = await glossaryEntry(context, withTerm(term("drop-retry", "Drop retry", "A retry after a dropped connection.", "Source: [retries.md§2](requirements/retries.md#2), [Old decision](ADRs/retries/old.md)")), { "docs/ADRs/retries/old.md": superseded });
  assert.deepEqual(rulesOf(entry), ["glossary.source-withdrawn"]);
  const message = entry.findings.find((finding) => finding.rule === "glossary.source-withdrawn").message;
  assert.match(message, /requirements\/retries\.md#2/);
  assert.match(message, /ADRs\/retries\/old\.md/);
  const stillInForce = await glossaryEntry(context, withTerm(term("drop-retry", "Drop retry", "A retry after a dropped connection.", "Source: [retries.md§2](requirements/retries.md#2), [retries.md§1](requirements/retries.md#1)")));
  assert.deepEqual(stillInForce.findings, [], "one source in force keeps the term");
});

test("clause 8: a glossary without a title or a purpose breaks those rules", async (context) => {
  const entry = await glossaryEntry(context, GLOSSARY.replace("# Glossary\n\nTerms used across the payments client.\n\n", "Glossary\n\n"));
  assert.deepEqual(rulesOf(entry), ["glossary.purpose", "glossary.title"]);
});
