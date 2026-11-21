import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ADR, CONFORMING, FEATURE, GLOSSARY, PATHS, REFERENCES, REQUIREMENT, TYPES, checked, entryOf, formatServer, listedRules, reference, rulesOf, write } from "./fixtures/artifact-formats.mjs";

// Unknown values only in undecided artifacts, the rules and corresponding sections that each reference declares, and the format findings that skills report.

const { corresponds } = await import("../../dist/server/workflow/artifact-formats.mjs");

const DRAFT = REQUIREMENT.replace("Status: Approved", "Status: Draft").replace("Approved: 2026-09-04", "Approved: n/a");
const withRationale = (text) => text.replace("Rationale: A request that retries forever holds a connection that other requests need.", "Rationale: unknown");
const PROPOSED = ADR.replace("Status: Accepted", "Status: Proposed");
const withMechanism = (text) => text.replace("The client starts a deadline timer with the first attempt.", "unknown");

async function single(context, file, text) {
  const { call } = await formatServer(context, { ...CONFORMING, [file]: text });
  return entryOf(await checked(call, [file]), file);
}

test("clauses 1, 3: an unknown value is a finding in an Approved requirement file, an Accepted ADR, and a glossary, and none in a Draft or a Proposed ADR", async (context) => {
  const approved = await single(context, PATHS.requirements, withRationale(REQUIREMENT));
  assert.equal(approved.conforms, false);
  const finding = approved.findings.find((item) => item.rule === "requirements.unknown");
  assert.ok(finding, JSON.stringify(approved.findings));
  assert.equal(finding.message, "Rationale is unknown, which only a Draft requirement file or a Proposed ADR may leave.");
  assert.deepEqual(approved.unknowns.map((item) => item.field), ["Rationale"], "the value is still listed as unknown");
  const draft = await single(context, PATHS.requirements, withRationale(DRAFT));
  assert.equal(draft.conforms, true, JSON.stringify(draft.findings));
  assert.deepEqual(draft.unknowns.map((item) => item.field), ["Rationale"]);
  assert.deepEqual(rulesOf(await single(context, PATHS.adr, withMechanism(ADR))), ["adr.unknown"]);
  assert.equal((await single(context, PATHS.adr, withMechanism(PROPOSED))).conforms, true);
  const glossary = GLOSSARY.replace("The time one attempt may take before the client counts it as failed.", "unknown");
  assert.ok(rulesOf(await single(context, PATHS.glossary, glossary)).includes("glossary.unknown"));
  const status = await single(context, PATHS.requirements, DRAFT.replace("Status: Draft", "Status: unknown"));
  assert.ok(rulesOf(status).includes("requirements.status"), "a status is never unknown, even in a draft");
});

test("clause 4: each reference lists its unknown and reported rules", async () => {
  for (const type of TYPES) {
    const rules = listedRules(await reference(type));
    assert.ok(rules.includes(`${type}.unknown`), `${REFERENCES[type]} lists ${type}.unknown`);
    assert.ok(rules.includes(`${type}.reported`), `${REFERENCES[type]} lists ${type}.reported`);
  }
});

const DECLARED = {
  requirements: ["- `## Problem`: `## Context`, `## Background`, `## Motivation`", "- `## Goals`: `## Objectives`", "- `## Non-goals`: `## Out of scope`", "- `## Design questions`: `## Open questions`, `## Questions`"],
  adr: ["- `## Requirements`: `## Drivers`, `## Decision drivers`", "- `## Problem`: `## Context`, `## Background`, `## Problem Statement`, `## Goals`, `## Non-Goals`", "- `## Decision`: `## Outcome`", "- `## Rationale`: `## Reasons`, `## Justification`", "- `## Alternatives`: `## Options considered`, `## Considered options`", "- `## Consequences`: `## Implications`", "- `## Decision Log`: `## History`, `## Status history`, `## Decision Log — <date> <title>`"],
  glossary: ["- `## <term>`: `### <term>`, `<term>` as a table row's first cell, `<term>` as a list item's leading name"],
  feature: ["- n/a"]
};

test("clause 5: each reference declares its corresponding sections between its defaults and its example", async () => {
  for (const type of TYPES) {
    const source = await reference(type);
    const headings = [...source.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    const at = headings.indexOf("Corresponding sections");
    assert.ok(at > headings.indexOf("Defaults") && at < headings.indexOf("Example"), `${type}: ${headings.join(", ")}`);
    const section = source.split(/^## Corresponding sections\s*$/m)[1].split(/^## /m)[0];
    const lines = section.split("\n").filter((line) => line.startsWith("- "));
    assert.deepEqual(lines, DECLARED[type], type);
  }
});

test("clause 6: corresponds accepts equal headings, declared pairs, numbered sections, and glossary rows, and nothing else", () => {
  assert.equal(corresponds("requirements", "Context", "Problem"), true);
  assert.equal(corresponds("requirements", "problem", "Problem"), true, "headings compare without case");
  assert.equal(corresponds("requirements", "3", "3. Record actions"), true);
  assert.equal(corresponds("requirements", "3. Old title", "3. Record actions"), true);
  assert.equal(corresponds("requirements", "3", "4. Record actions"), false);
  assert.equal(corresponds("requirements", "Context", "Goals"), false);
  assert.equal(corresponds("requirements", null, null), true);
  assert.equal(corresponds("requirements", null, "Problem"), false);
  assert.equal(corresponds("adr", "Context", "Problem"), true);
  assert.equal(corresponds("adr", "History", "Decision Log"), true);
  assert.equal(corresponds("adr", "Context", "Decision"), false);
  assert.equal(corresponds("glossary", "Backoff", "Backoff"), true, "a table row's first cell names its term");
  assert.equal(corresponds("glossary", "Backoff", "Retry deadline"), false);
});

test("clauses 12, 13, 14: report_format_finding records a break the check does not see, and check_artifacts lists it until the file changes", async (context) => {
  const { root, call } = await formatServer(context);
  const reported = await call("report_format_finding", { artifact: PATHS.requirements, message: "Section 1's rationale restates its requirement.", line: 32 });
  assert.equal(reported.error, null, reported.text);
  assert.ok(!reported.result?.isError, reported.text);
  const finding = reported.value.finding;
  assert.deepEqual([finding.path, finding.scope, finding.type, finding.rule, finding.line, finding.message], [PATHS.requirements, null, "requirements", "requirements.reported", 32, "Section 1's rationale restates its requirement."]);
  assert.match(finding.version, /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof finding.reportedAt, "string");
  const again = await call("report_format_finding", { artifact: PATHS.requirements, message: "Section 1's rationale restates its requirement.", line: 32 });
  assert.equal(again.value.finding.reportedAt, finding.reportedAt, "the same report returns the first finding");
  const entry = entryOf(await checked(call, [PATHS.requirements]), PATHS.requirements);
  assert.equal(entry.conforms, false);
  assert.deepEqual(entry.findings, [{ rule: "requirements.reported", line: 32, message: "Section 1's rationale restates its requirement." }]);
  const unlined = await call("report_format_finding", { artifact: PATHS.feature, message: "The rule restates its example." });
  assert.equal(unlined.value.finding.line, null);
  assert.ok(entryOf(await checked(call, [PATHS.feature]), PATHS.feature).findings.some((item) => item.rule === "feature.reported" && item.line === null));
  await write(root, PATHS.requirements, `${REQUIREMENT}\n`);
  const changed = entryOf(await checked(call, [PATHS.requirements]), PATHS.requirements);
  assert.equal(changed.conforms, true, "a changed file drops the findings reported on its earlier version");
});

test("clause 12: report_format_finding refuses what check_artifacts refuses and malformed input", async (context) => {
  const { call } = await formatServer(context);
  const code = async (args) => (await call("report_format_finding", args)).value?.code;
  assert.equal(await code({ artifact: "src/index.js", message: "Not an artifact." }), "artifact_type_unknown");
  assert.equal(await code({ artifact: "docs/requirements/missing.md", message: "Missing." }), "artifact_missing");
  assert.equal(await code({ artifact: { path: PATHS.requirements, scope: "workspace" }, message: "No store." }), "scope_invalid");
  assert.equal(await code({ artifact: PATHS.requirements, message: "" }), "invalid_input");
  assert.equal(await code({ artifact: PATHS.requirements, message: "Two\nlines." }), "invalid_input");
  assert.equal(await code({ artifact: PATHS.requirements, message: "x".repeat(501) }), "invalid_input");
  assert.equal(await code({ artifact: PATHS.requirements, message: "Bad line.", line: 0 }), "invalid_input");
});

test("clauses 15, 16: reported findings live under .prism/format-findings/ without a store, and the tool says it never changes the artifact", async (context) => {
  const { root, call } = await formatServer(context, { ...CONFORMING, [PATHS.feature]: FEATURE });
  const before = await readFile(path.join(root, PATHS.requirements), "utf8");
  await call("report_format_finding", { artifact: PATHS.requirements, message: "<b>markup</b> stays text." });
  assert.ok((await readdir(path.join(root, ".prism/format-findings"))).length >= 1);
  assert.equal(await readFile(path.join(root, PATHS.requirements), "utf8"), before, "the artifact is unchanged");
  const listed = await call("check_artifacts", {});
  assert.ok(listed.value.artifacts.some((artifact) => artifact.findings.some((item) => item.message === "<b>markup</b> stays text.")), "the message is kept as given");
});
