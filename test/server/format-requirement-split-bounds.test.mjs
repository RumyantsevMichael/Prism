import assert from "node:assert/strict";
import test from "node:test";
import { requirementsIn } from "../../dist/server/workflow/artifact-formats.mjs";
import { CONFORMING } from "./fixtures/artifact-formats.mjs";
import { runCheckout, runFor } from "./fixtures/format-migration-runs.mjs";

// The bounds of a requirement split: requirements.shall counts sentences, not periods, and propose_migration accepts a split only when
// the split section keeps its number, title, and first requirement, and only a split-out section may take a pattern the source never states.
// Every host here is a stub on a PATH that holds no real Claude Code or Codex.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

test("requirements.shall counts sentences that say shall, not abbreviations, code spans, or quoted endings", () => {
  const count = (value) => requirementsIn(value).length;
  assert.equal(count("When a request exceeds its total retry deadline, the client shall stop retrying. The client shall report the request as timed out."), 2);
  assert.equal(count("The client shall retry, e.g. after a pause, and shall log it."), 1);
  assert.equal(count("The client shall retry, i.e. once, and shall log it."), 1);
  assert.equal(count("The client shall use `a. shall` text."), 1);
  assert.equal(count('The client shall print "done." The client shall exit.'), 2);
  assert.equal(count("The client shall exit (code 0.) The client shall log it."), 2);
  assert.equal(count("The client shall wait 1.5 s. The client shall log."), 2);
  assert.equal(count("The client shall log errors, etc. The client shall exit."), 2);
  assert.equal(count("The client SHALL retry. This keeps connections free."), 1);
});

const BOUNDS = "docs/requirements/bounds.md";
const header = (status, approved) => `# Request bounds

Status: ${status}
Created: 2026-09-02
Approved: ${approved}

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
const section = (number, title, pattern, requirements, related = "[bounds.md§2](#2)", rationale = RATIONALE) => `
<a id="${number}"></a>
## ${number}. ${title}

Pattern: ${pattern}

Disposition: Active

${requirements.map((text) => `Requirement: ${text}`).join("\n\n")}

${rationale}

Related: ${related}
`;
const second = (number = 2) => section(number, "Report a timeout", "State-driven", ["While a request is timed out, the client shall report it as timed out."], "n/a", "Rationale: A caller must tell a timeout from a refusal.");
const START = "When a request starts, the client shall start its deadline timer.";
const CAP = "The client shall cap each attempt at ten seconds.";
const APPROVED = header("Approved", "2026-09-04");
const DRAFT = header("Draft", "n/a");
const SOURCE = (head) => head + section(1, "Bound each request", "Event-driven", [START, CAP]) + second();

async function propose(context, source, content) {
  const { call } = await runCheckout(context, { ...CONFORMING, [BOUNDS]: source });
  const run = await runFor(call, BOUNDS);
  return call("propose_migration", { run, type: "requirements", source: BOUNDS, target: BOUNDS, content, summary: "Splits the first section's requirements.", leftovers: [] });
}

test("a split that moves a section's first requirement out of it into a new section is misplaced", { skip: posixOnly }, async (context) => {
  const content = APPROVED + section(1, "Bound each request", "Event-driven", [CAP]) + second() + section(3, "Bound each request", "Event-driven", [START], "[bounds.md§1](#1), [bounds.md§2](#2)");
  const refused = await propose(context, SOURCE(APPROVED), content);
  assert.equal(refused.value?.code, "migration_misplaced", refused.text);
  assert.ok(refused.value.statements.some((statement) => statement.text === START), refused.text);
});

test("a section renumbered under its own title into a number the source does not use is misplaced", { skip: posixOnly }, async (context) => {
  const content = DRAFT + section(1, "Bound each request", "Event-driven", [START]) + second(3) + section(4, "Bound each request", "Ubiquitous", [CAP], "[bounds.md§1](#1), [bounds.md§3](#3)");
  const refused = await propose(context, SOURCE(DRAFT), content);
  assert.equal(refused.value?.code, "migration_misplaced", refused.text);
  assert.ok(refused.value.statements.some((statement) => statement.from === "2. Report a timeout" && statement.to === "3. Report a timeout"), refused.text);
});

test("a pattern the source never states in a section whose number the source uses is invented", { skip: posixOnly }, async (context) => {
  const content = APPROVED + section(1, "Bound each request", "Optional feature", [START]) + second() + section(3, "Bound each request", "Event-driven", [CAP], "[bounds.md§1](#1), [bounds.md§2](#2)");
  const refused = await propose(context, SOURCE(APPROVED), content);
  assert.equal(refused.value?.code, "migration_invented", refused.text);
  assert.match(refused.text, /Optional feature/);
});

test("a split that keeps the section's number, title, pattern, and first requirement passes", { skip: posixOnly }, async (context) => {
  const content = APPROVED + section(1, "Bound each request", "Event-driven", [START]) + second() + section(3, "Bound each request", "Ubiquitous", [CAP], "[bounds.md§1](#1), [bounds.md§2](#2)");
  const proposed = await propose(context, SOURCE(APPROVED), content);
  assert.equal(proposed.refused, false, proposed.text);
});
