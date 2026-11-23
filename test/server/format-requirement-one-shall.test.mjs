import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONFORMING, PATHS, REQUIREMENT, checked, entryOf, formatServer, listedRules, reference, rulesOf } from "./fixtures/artifact-formats.mjs";
import { readRun, runCheckout, runFor } from "./fixtures/format-migration-runs.mjs";

// Each numbered section of a requirement file states one EARS requirement: a Requirement line holds at most one sentence with shall,
// which version 2 of the requirement format checks, and a format migration splits a section that holds several requirements
// into the section and new numbered sections at the end instead of merging them.
// Every host here is a stub on a PATH that holds no real Claude Code or Codex.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const skill = (name) => readFile(path.join(ROOT, "skills", name, "SKILL.md"), "utf8");
const body = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, "");

const TWO_SHALLS = "When a request exceeds its total retry deadline, the client shall stop retrying. The client shall report the request as timed out.";
const withRequirement = (text) => REQUIREMENT.replace("Requirement: When a request exceeds its total retry deadline, the client shall stop retrying.", `Requirement: ${text}`);

test("clause 1: the requirement format is version 2 and lists requirements.shall, while the other formats stay at version 1", async () => {
  const source = await reference("requirements");
  assert.match(source, /^Format version: 2$/m);
  assert.ok(listedRules(source).includes("requirements.shall"), "the reference lists the rule");
  assert.match(source, /^- `requirements\.shall`: .*\bRequirement:.*\bshall\b/m);
  for (const type of ["adr", "glossary", "feature"]) assert.match(await reference(type), /^Format version: 1$/m, type);
});

test("clause 2: a Requirement line with two sentences that say shall is a requirements.shall finding at its line, and one sentence with shall twice is none", async (context) => {
  const broken = withRequirement(TWO_SHALLS);
  const compound = withRequirement("When a request exceeds its total retry deadline, the client shall stop retrying and shall report the request as timed out.");
  const plain = withRequirement("When a request exceeds its total retry deadline, the client shall stop retrying. This keeps connections free.");
  const files = { ...CONFORMING, [PATHS.requirements]: broken, "docs/requirements/compound.md": compound.replace("# Request retries", "# Compound retries"), "docs/requirements/plain.md": plain.replace("# Request retries", "# Plain retries") };
  const { call } = await formatServer(context, files);
  const value = await checked(call, [PATHS.requirements, "docs/requirements/compound.md", "docs/requirements/plain.md"]);
  const entry = entryOf(value, PATHS.requirements);
  assert.deepEqual(rulesOf(entry), ["requirements.shall"]);
  const finding = entry.findings.find((item) => item.rule === "requirements.shall");
  assert.equal(finding.line, broken.split("\n").indexOf(`Requirement: ${TWO_SHALLS}`) + 1);
  assert.equal(finding.message, "Section 1 states 2 requirements in one Requirement line; give each its own numbered section.");
  assert.deepEqual(rulesOf(entryOf(value, "docs/requirements/compound.md")), [], "one sentence is one requirement");
  assert.deepEqual(rulesOf(entryOf(value, "docs/requirements/plain.md")), [], "a sentence without shall states no requirement");
});

test("clause 3: a file that conforms to version 1 and breaks only requirements.shall reports version 1 as its earlier format, and its run records version 2 and the cause format-update", { skip: posixOnly }, async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: withRequirement(TWO_SHALLS) });
  const entry = entryOf(await checked(call, [PATHS.requirements]), PATHS.requirements);
  assert.deepEqual(entry.earlierFormat, { version: 1 });
  const record = await readRun(call, await runFor(call, PATHS.requirements));
  assert.deepEqual([record.set.formatVersion, record.cause], [2, "format-update"]);
});

// A requirement file whose first section holds three requirements on three Requirement lines, as Prism's earlier files sometimes did.
const BOUNDS = "docs/requirements/bounds.md";
const header = `# Request bounds

Status: Approved
Created: 2026-09-02
Approved: 2026-09-04

## Problem

Clients wait on requests that will never finish.

## Goals

- Bound every request in time.

## Non-goals

- Bounding the server's own work.

## Design questions

- n/a
`;
const RATIONALE = "Rationale: A request without a bound holds a connection that other requests need.";
const first = (requirements) => `
<a id="1"></a>
## 1. Bound each request

Pattern: Event-driven

Disposition: Active

${requirements.map((text) => `Requirement: ${text}`).join("\n\n")}

${RATIONALE}

Related: [bounds.md§2](#2)
`;
const second = `
<a id="2"></a>
## 2. Report a timeout

Pattern: State-driven

Disposition: Active

Requirement: While a request is timed out, the client shall report it as timed out.

Rationale: A caller must tell a timeout from a refusal.

Related: n/a
`;
const START = "When a request starts, the client shall start its deadline timer.";
const CAP = "The client shall cap each attempt at ten seconds.";
const STOP = "If the deadline passes, then the client shall stop retrying.";
const SOURCE = header + first([START, CAP, STOP]) + second;
const added = (number, title, pattern, requirement) => `
<a id="${number}"></a>
## ${number}. ${title}

Pattern: ${pattern}

Disposition: Active

Requirement: ${requirement}

${RATIONALE}

Related: [bounds.md§1](#1), [bounds.md§2](#2)
`;
const SPLIT = header + first([START]) + second + added(3, "Bound each request", "Ubiquitous", CAP) + added(4, "Bound each request", "Unwanted behavior", STOP);
const proposal = (run, content) => ({ run, type: "requirements", source: BOUNDS, target: BOUNDS, content, summary: "Splits the first section's three requirements into the section and two new numbered sections at the end.", leftovers: [] });

test("clauses 4, 5: a split that keeps the section's first requirement and appends each other one as a numbered section with the section's title, its own pattern, and the section's rationale passes propose_migration", { skip: posixOnly }, async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [BOUNDS]: SOURCE });
  const run = await runFor(call, BOUNDS);
  const proposed = await call("propose_migration", proposal(run, SPLIT));
  assert.equal(proposed.refused, false, proposed.text);
  assert.equal(proposed.value.migration.status, "proposed");
});

test("clause 5: a merge of the section's requirements into one Requirement line is refused as nonconforming with requirements.shall", { skip: posixOnly }, async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [BOUNDS]: SOURCE });
  const run = await runFor(call, BOUNDS);
  const merged = header + first([`${START} ${CAP} ${STOP}`]) + second;
  const refused = await call("propose_migration", proposal(run, merged));
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  assert.match(refused.text, /requirements\.shall/);
});

test("clause 5: a requirement moved into a new section under another section's title is still misplaced", { skip: posixOnly }, async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [BOUNDS]: SOURCE });
  const run = await runFor(call, BOUNDS);
  const retitled = header + first([START]) + second + added(3, "Report a timeout", "Ubiquitous", CAP) + added(4, "Bound each request", "Unwanted behavior", STOP);
  const misplaced = await call("propose_migration", proposal(run, retitled));
  assert.equal(misplaced.value?.code, "migration_misplaced", misplaced.text);
  assert.deepEqual(misplaced.value.statements.map((statement) => [statement.text, statement.from, statement.to]), [[CAP, "1. Bound each request", "3. Report a timeout"]]);
});

test("clause 4: migrate-artifact splits a section that holds several requirements into new numbered sections at the end and never merges them", async () => {
  const text = body(await skill("migrate-artifact"));
  const sentences = text.split("\n");
  assert.ok(sentences.some((line) => /more than one requirement|several requirements/i.test(line) && /new numbered section/i.test(line) && /\bend\b|after the (file's )?last/i.test(line)), "it appends each further requirement as a new numbered section at the end");
  assert.ok(sentences.some((line) => /title/i.test(line) && /Pattern/.test(line) && /Rationale/.test(line) && /Related/.test(line)), "it says what each new section takes");
  assert.ok(sentences.some((line) => /\bmerge\b/i.test(line) && /\b(never|not)\b/i.test(line)), "it never merges requirements into one line");
  assert.ok(sentences.some((line) => /renumber/i.test(line) && /\b(never|not)\b/i.test(line)), "it keeps every number and anchor");
});
