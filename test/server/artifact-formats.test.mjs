import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mcp } from "./fixtures/shipped-work.mjs";
import { defer } from "./fixtures/teardown.mjs";
import { ADR, CONFORMING, FEATURE, PATHS, REFERENCES, REQUIREMENT, TYPES, checked, entryOf, exampleOf, formatServer, listedRules, reference, rulesOf, write } from "./fixtures/artifact-formats.mjs";

// The requirement, ADR, and feature formats: their references, their examples, and what check_artifacts reports, through the MCP server.

const OWN_TYPES = ["requirements", "adr", "feature"];
const RULES = {
  requirements: ["requirements.dates", "requirements.disposition", "requirements.fields", "requirements.header", "requirements.links", "requirements.numbering", "requirements.pattern", "requirements.sections", "requirements.status", "requirements.text", "requirements.title"],
  adr: ["adr.dates", "adr.header", "adr.requirements", "adr.sections", "adr.status", "adr.text", "adr.title"],
  feature: ["feature.examples", "feature.header", "feature.requirement", "feature.rules", "feature.steps", "feature.text"]
};

async function single(context, file, text) {
  const { call } = await formatServer(context, { ...CONFORMING, [file]: text });
  return entryOf(await checked(call, [file]), file);
}

test("clauses 1, 13: check_artifacts names the four formats in order with their versions and references", async (context) => {
  const { call } = await formatServer(context);
  const value = await checked(call);
  assert.deepEqual(value.formats.map((format) => format.type), TYPES);
  for (const format of value.formats) {
    assert.ok(Number.isInteger(format.version) && format.version >= 1, format.type);
    assert.equal(format.reference, REFERENCES[format.type]);
  }
});

test("clauses 2, 3: each reference states its version and example path, lists exactly the rules the check reports, and holds one example", async () => {
  for (const type of OWN_TYPES) {
    const source = await reference(type);
    assert.ok(source, `${REFERENCES[type]} exists`);
    assert.match(source, /^Format version: \d+\s*$/m, type);
    assert.match(source, /^## Defaults\s*$/m, type);
    const example = exampleOf(source);
    assert.equal(example.fences, 2, `${type}: the example is the only fenced block under ## Example`);
    assert.ok(example.text && example.path, type);
    assert.deepEqual(listedRules(source), RULES[type], `${type} lists exactly its rule ids`);
  }
});

test("clauses 11, 13: without paths every artifact of the configured folders is checked, ordered by type and path, and README files are skipped", async (context) => {
  const { call } = await formatServer(context, { ...CONFORMING, "docs/requirements/README.md": "Read me.\n", "docs/requirements/a/nested.md": REQUIREMENT, "docs/notes/other.md": "# Notes\n" });
  const value = await checked(call);
  assert.deepEqual(value.artifacts.map((entry) => [entry.type, entry.path]), [
    ["requirements", "docs/requirements/a/nested.md"],
    ["requirements", PATHS.requirements],
    ["adr", PATHS.adr],
    ["glossary", PATHS.glossary],
    ["feature", PATHS.feature]
  ]);
  for (const entry of value.artifacts) {
    assert.equal(entry.conforms, true, entry.path);
    assert.equal(entry.earlierFormat, null);
    assert.equal(entry.legacy, null);
    assert.ok(Number.isInteger(entry.version));
  }
});

test("clause 12: a path outside every configured folder or missing is refused by name", async (context) => {
  const { root, call } = await formatServer(context);
  await write(root, "docs/notes/other.md", "# Notes\n");
  const outside = await call("check_artifacts", { paths: ["docs/notes/other.md"] });
  assert.equal(outside.value?.code, "artifact_type_unknown", outside.text);
  assert.match(outside.text, /docs\/notes\/other\.md/);
  const missing = await call("check_artifacts", { paths: ["docs/requirements/gone.md"] });
  assert.equal(missing.value?.code, "artifact_missing", missing.text);
  assert.match(missing.text, /docs\/requirements\/gone\.md/);
});

test("clause 5: a requirement file reports each rule it breaks with a line", async (context) => {
  const broken = REQUIREMENT
    .replace("Status: Approved", "Status: Accepted")
    .replace("Created: 2026-09-02", "Created: 2 September")
    .replace("## Non-goals\n\n- Retrying requests that the server refused.\n\n", "")
    .replace("Pattern: Event-driven\n\nDisposition: Active", "Pattern: Sometimes\n\nDisposition: Maybe")
    .replace("Related: [retries.md§2](#2)", "Related: see section two")
    .replace("<a id=\"2\"></a>\n## 2.", "<a id=\"3\"></a>\n## 2.");
  const entry = await single(context, PATHS.requirements, broken);
  assert.equal(entry.conforms, false);
  assert.deepEqual(rulesOf(entry), ["requirements.dates", "requirements.disposition", "requirements.links", "requirements.numbering", "requirements.pattern", "requirements.sections", "requirements.status"]);
  for (const finding of entry.findings) {
    assert.ok(finding.line === null || Number.isInteger(finding.line), finding.rule);
    assert.ok(finding.message.length > 0, finding.rule);
  }
  assert.equal(entry.findings.find((finding) => finding.rule === "requirements.pattern").line, broken.split("\n").indexOf("Pattern: Sometimes") + 1);
});

test("clause 5: a title, header, or field order break is reported, and a missing field section is named", async (context) => {
  const entry = await single(context, PATHS.requirements, REQUIREMENT.replace("# Request retries\n", "Request retries\n").replace("Created: 2026-09-02\nApproved: 2026-09-04", "Approved: 2026-09-04\nCreated: 2026-09-02").replace("Rationale: Most drops last less than a second.\n\n", ""));
  assert.deepEqual(rulesOf(entry), ["requirements.fields", "requirements.header", "requirements.title"]);
});

test("clause 5: Prism's own requirement files written to the template conform", async (context) => {
  const own = await realpath(path.join(import.meta.dirname, "../../docs/requirements/artifact-formats.md"));
  const text = await (await import("node:fs/promises")).readFile(own, "utf8");
  const entry = await single(context, "docs/requirements/artifact-formats.md", text);
  assert.deepEqual(entry.findings, []);
});

test("clause 6: an ADR reports a missing section, an unknown status, and a requirement link that is not a relative .md link", async (context) => {
  const broken = ADR.replace("Status: Accepted", "Status: Superseded").replace("## Alternatives\n\nA fixed number of attempts was rejected because attempts vary in length.\n\n", "").replace("- [retries.md§1](../../requirements/retries.md#1)", "- [the retries requirement](https://example.invalid/retries)");
  const entry = await single(context, PATHS.adr, broken);
  assert.deepEqual(rulesOf(entry), ["adr.requirements", "adr.sections", "adr.status"]);
  const declined = await single(context, PATHS.adr, ADR.replace("Status: Accepted", "Status: Declined").replace("- [retries.md§1](../../requirements/retries.md#1)", "n/a"));
  assert.deepEqual(declined.findings, []);
});

test("clauses 5, 6: the shapes that Prism's templates before the formats produced conform, and other breaks still do not", async (context) => {
  const supersedes = REQUIREMENT
    .replace("Disposition: Active\n\nRequirement: When a request exceeds", "Disposition: Active\n\nSupersedes: [retries.md§2](#2)\n\nRequirement: When a request exceeds")
    .replace("Related: n/a\n", "Supersedes: [retries.md§1](#1)\n\nRelated: [Stop at the total deadline](#1).\n");
  assert.deepEqual((await single(context, PATHS.requirements, supersedes)).findings, [], "Supersedes: anywhere after Disposition:, and a period after the last Related link");
  const twice = REQUIREMENT.replace("Related: n/a\n", "Supersedes: [retries.md§1](#1)\n\nRelated: n/a\n\nSupersedes: [retries.md§1](#1)\n");
  assert.deepEqual(rulesOf(await single(context, PATHS.requirements, twice)), ["requirements.fields"], "a second Supersedes: line");
  const early = REQUIREMENT.replace("Pattern: Event-driven\n\nDisposition: Active\n\nRequirement: When a request exceeds", "Supersedes: [retries.md§2](#2)\n\nPattern: Event-driven\n\nDisposition: Active\n\nRequirement: When a request exceeds");
  assert.deepEqual(rulesOf(await single(context, PATHS.requirements, early)), ["requirements.fields"], "Supersedes: before Disposition:");
  const trailing = REQUIREMENT.replace("Related: [retries.md§2](#2)", "Related: [retries.md§2](#2) and the transport");
  assert.deepEqual(rulesOf(await single(context, PATHS.requirements, trailing)), ["requirements.links"], "text after the last Related link other than a period");
  const prose = ADR
    .replace("- [retries.md§1](../../requirements/retries.md#1)", "[Stop at the total deadline](../../requirements/retries.md#1) requires a bound on retries.\nThe [retries requirements](../../requirements/retries.md) hold the rest.")
    .replace("## Decision Log\n\nn/a\n", "## Decision Log\n");
  assert.deepEqual((await single(context, PATHS.adr, prose)).findings, [], "prose with relative .md links in Requirements, and an empty Decision Log");
  const none = ADR.replace("- [retries.md§1](../../requirements/retries.md#1)", "No Approved requirement governs this decision yet.");
  assert.deepEqual((await single(context, PATHS.adr, none)).findings, [], "a Requirements section that says in prose that no requirement governs the decision");
  const emptyProblem = ADR.replace("## Problem\n\nRetries without a bound can hold a connection forever.\n", "## Problem\n");
  assert.deepEqual(rulesOf(await single(context, PATHS.adr, emptyProblem)), ["adr.sections"], "an empty section other than the Decision Log");
  const emptyRequirements = ADR.replace("- [retries.md§1](../../requirements/retries.md#1)\n", "");
  assert.deepEqual(rulesOf(await single(context, PATHS.adr, emptyRequirements)), ["adr.sections"], "an empty Requirements section");
});

test("clause 7: a feature reports an example outside a rule, a rule without a requirement link, and an example with two whens", async (context) => {
  const broken = `Feature: Request retries

  Example: A stray example
    Given a request
    When it fails
    Then it is reported

  Rule: Retries stop at the total deadline

    Example: Two actions
      Given a request whose total deadline has elapsed
      When its attempt fails
      When it is sent again
      Then the client reports the failure
`;
  const entry = await single(context, PATHS.feature, broken);
  assert.deepEqual(rulesOf(entry), ["feature.requirement", "feature.rules", "feature.steps"]);
  const header = await single(context, PATHS.feature, FEATURE.replace("Feature: Request retries", "Capability: Request retries"));
  assert.deepEqual(rulesOf(header), ["feature.header"]);
});

test("clause 10: unknown fills a required value and is listed, but never a title, status, or identity", async (context) => {
  const withUnknown = REQUIREMENT.replace("Created: 2026-09-02", "Created: unknown").replace("Rationale: A request that retries forever holds a connection that other requests need.", "Rationale: unknown");
  const entry = await single(context, PATHS.requirements, withUnknown);
  assert.deepEqual(entry.findings, []);
  assert.deepEqual(entry.unknowns.map((item) => item.field).sort(), ["Created", "Rationale"]);
  const lines = withUnknown.split("\n");
  assert.deepEqual(entry.unknowns.map((item) => item.line).sort((a, b) => a - b), [lines.indexOf("Created: unknown") + 1, lines.indexOf("Rationale: unknown") + 1]);
  const status = await single(context, PATHS.requirements, REQUIREMENT.replace("Status: Approved", "Status: unknown"));
  assert.deepEqual(rulesOf(status), ["requirements.status"]);
});

test("clause 5: a file that is not UTF-8 text breaks the text rule", async (context) => {
  const { root, call } = await formatServer(context);
  await (await import("node:fs/promises")).writeFile(path.join(root, "docs/requirements/binary.md"), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
  const entry = entryOf(await checked(call, ["docs/requirements/binary.md"]), "docs/requirements/binary.md");
  assert.deepEqual(rulesOf(entry), ["requirements.text"]);
});

test("clauses 14, 15: an artifact that breaks the current version but conforms to an earlier one names that version", async () => {
  const { checkArtifactText } = await import("../../dist/server/workflow/artifact-formats.mjs");
  const needs = (word) => (text) => text.includes(word) ? [] : [{ rule: `requirements.${word}`, line: null, message: `Missing ${word}.` }];
  const formats = [
    { type: "requirements", version: 1, check: needs("alpha") },
    { type: "requirements", version: 2, check: needs("beta") },
    { type: "requirements", version: 3, check: needs("gamma") }
  ];
  assert.deepEqual(checkArtifactText("requirements", "alpha beta gamma", { formats }), { conforms: true, findings: [], earlierFormat: null });
  const earlier = checkArtifactText("requirements", "alpha beta", { formats });
  assert.equal(earlier.conforms, false);
  assert.deepEqual(earlier.findings.map((finding) => finding.rule), ["requirements.gamma"]);
  assert.deepEqual(earlier.earlierFormat, { version: 2 });
  assert.deepEqual(checkArtifactText("requirements", "alpha", { formats }).earlierFormat, { version: 1 });
  assert.equal(checkArtifactText("requirements", "nothing", { formats }).earlierFormat, null);
  assert.equal(checkArtifactText("requirements", REQUIREMENT).conforms, true, "Prism's own formats are the default");
});

test("clause 11: a configuration that turns a path off skips its artifacts", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-formats-off-")));
  defer(context, () => rm(root, { recursive: true, force: true }));
  await write(root, ".prism/workflow.md", "## Paths\n- Requirements: docs/requirements/\n- ADRs: n/a\n- Feature files: n/a\n- Glossary: n/a\n");
  for (const [file, text] of Object.entries(CONFORMING)) await write(root, file, text);
  const call = await mcp(context, root);
  const value = await checked(call);
  assert.deepEqual(value.artifacts.map((entry) => entry.path), [PATHS.requirements]);
});
