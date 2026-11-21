import assert from "node:assert/strict";
import test from "node:test";
import { CONFORMING, reference } from "./fixtures/artifact-formats.mjs";
import { readRun, runCheckout, runFor } from "./fixtures/format-migration-runs.mjs";

// A format migration moves the statements of an artifact written with Prism's earlier templates into the sections of its format:
// an ADR's Problem Statement, Goals, and Non-Goals into its Problem, and each dated Decision Log entry into its Decision Log.
// The requirement templates never renamed a section, so only the ADR format declares these.
// Every host here is a stub on a PATH that holds no real Claude Code or Codex.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const { corresponds } = await import("../../dist/server/workflow/artifact-formats.mjs");

const DECLARED_ADR = [
  "- `## Requirements`: `## Drivers`, `## Decision drivers`",
  "- `## Problem`: `## Context`, `## Background`, `## Problem Statement`, `## Goals`, `## Non-Goals`",
  "- `## Decision`: `## Outcome`",
  "- `## Rationale`: `## Reasons`, `## Justification`",
  "- `## Alternatives`: `## Options considered`, `## Considered options`",
  "- `## Consequences`: `## Implications`",
  "- `## Decision Log`: `## History`, `## Status history`, `## Decision Log — <date> <title>`"
];
const DECLARED_REQUIREMENTS = [
  "- `## Problem`: `## Context`, `## Background`, `## Motivation`",
  "- `## Goals`: `## Objectives`",
  "- `## Non-goals`: `## Out of scope`",
  "- `## Design questions`: `## Open questions`, `## Questions`"
];

const declared = async (type) => (await reference(type)).split(/^## Corresponding sections\s*$/m)[1].split(/^## /m)[0].split("\n").filter((line) => line.startsWith("- "));

// An Accepted ADR in the shape of Prism's earlier ADR template, with one dated Decision Log entry.
const OLD_ADR = "docs/ADRs/audit/log.md";
const OLD_SOURCE = `# Keep an audit log

Status: Accepted
Created: 2026-08-03

## Problem Statement

Settings change without a trace.

## Goals

- Trace every administrative action to its administrator.

## Non-Goals

- Trace what a user who is no administrator does.

## Decision

Every administrative action MUST be logged.

## Mechanism

The server appends one line per action to the log.

## Rationale

A log is the cheapest record that survives a restart.

## Consequences

The log grows with every action.

## Decision Log

## Decision Log — 2026-08-20  Name the log's owner

The operations team owns the log.
`;
const migrated = ({ problem = ["Settings change without a trace.", "", "- Trace every administrative action to its administrator.", "", "- Trace what a user who is no administrator does."], decision = ["Every administrative action MUST be logged."] } = {}) => `# Keep an audit log

Status: Accepted
Created: 2026-08-03

## Requirements

n/a

## Problem

${problem.join("\n")}

## Decision

${decision.join("\n")}

## Rationale

A log is the cheapest record that survives a restart.

## Alternatives

unknown

## Consequences

The log grows with every action.

## Mechanism

The server appends one line per action to the log.

## Decision Log

### 2026-08-20 Name the log's owner

The operations team owns the log.
`;
const proposal = (run, content, extra = {}) => ({ run, type: "adr", source: OLD_ADR, target: OLD_ADR, content, summary: "Moves the earlier template's sections into the format's sections and marks the alternatives that the ADR never gave as unknown.", leftovers: [], ...extra });

test("clause 1: the ADR format declares the earlier template's Problem Statement, Goals, Non-Goals, and dated Decision Log entries as corresponding sections", async () => {
  assert.deepEqual(await declared("adr"), DECLARED_ADR);
  assert.deepEqual(await declared("requirements"), DECLARED_REQUIREMENTS, "the requirement templates renamed no section");
});

test("clause 2: corresponds maps the earlier ADR template's sections to the format's, and nothing else to them", () => {
  for (const heading of ["Problem Statement", "Goals", "Non-Goals", "problem statement", "Non-goals"]) assert.equal(corresponds("adr", heading, "Problem"), true, heading);
  for (const heading of ["Decision Log — 2026-08-20  Name the log's owner", "Decision Log - 2026-08-20 Name the log's owner", "Decision Log — 2026-08-20"]) assert.equal(corresponds("adr", heading, "Decision Log"), true, heading);
  assert.equal(corresponds("adr", "Problem Statement", "Decision"), false);
  assert.equal(corresponds("adr", "Goals", "Rationale"), false);
  assert.equal(corresponds("adr", "Decision Log — 2026-08-20  Name the log's owner", "Problem"), false);
  assert.equal(corresponds("adr", "Decision Log — someday", "Decision Log"), false, "an entry heading names its date");
  assert.equal(corresponds("adr", "Decision Log — 2026-08-20", "Decision"), false);
  assert.equal(corresponds("requirements", "Non-Goals", "Non-goals"), true, "a requirement heading differs from the format's only in case");
  assert.equal(corresponds("requirements", "Problem Statement", "Problem"), false, "the requirement templates never had a Problem Statement");
});

test("clause 3: a migration of an ADR in the earlier template's shape moves its statements into the format's sections and is refused only for what the person must answer", { skip: posixOnly }, async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [OLD_ADR]: OLD_SOURCE });
  const run = await runFor(call, OLD_ADR);
  const bare = await call("propose_migration", proposal(run, migrated()));
  assert.equal(bare.value?.code, "migration_unsettled", bare.text);
  assert.deepEqual(bare.value.points.map((point) => [point.kind, point.field]), [["unknown", "Alternatives"]]);
  const asked = bare.value.points.map((point) => ({ point, recommendation: "No alternative was recorded when the decision was made." }));
  const proposed = await call("propose_migration", proposal(run, migrated(), { asked }));
  assert.equal(proposed.refused, false, proposed.text);
  assert.equal(proposed.value.migration.status, "proposed");
  assert.equal((await readRun(call, run)).status, "running", "the run goes on");
});

test("clause 3: a statement of the earlier template's Goals that moves to the Decision is still misplaced", { skip: posixOnly }, async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [OLD_ADR]: OLD_SOURCE });
  const run = await runFor(call, OLD_ADR);
  const content = migrated({ problem: ["Settings change without a trace.", "", "- Trace what a user who is no administrator does."], decision: ["Every administrative action MUST be logged.", "", "- Trace every administrative action to its administrator."] });
  const refused = await call("propose_migration", proposal(run, content));
  assert.equal(refused.value?.code, "migration_misplaced", refused.text);
  assert.deepEqual(refused.value.statements.map((statement) => [statement.text, statement.from, statement.to]), [["Trace every administrative action to its administrator.", "Goals", "Decision"]]);
});
