# Show a fitted design as examples and planned changes at the design gate

Status: Proposed
Created: 2026-10-26

## Requirements

No Approved requirement governs this decision yet.
It follows [Derive a designed slice's change map from its verified result](derived-change-maps.md), which left planned changes to a later decision.

## Problem

The person who runs the agents accepts or rejects each fitted design at the design gate.
The design's contract and acceptance tests decide what the implementation is held to, but `slice.md` prose is slow to check and can be ambiguous, and reading every test is slower still.
The agent-written change map that once showed planned changes before implementation cost many tool calls and did not improve delivery quality in the October 2026 benchmark runs.

## Decision

A fitted design MUST list its expected changes in a `Changes` section of `slice.md`, one line per file with `add`, `change`, or `remove`, the path, and the units it adds or whose interface it changes.
When the design gate waits for the user, an example writer on a small model MUST write one example per frozen test from the contract and the test files only, through `update_design_view`.
The server MUST refuse an example that cites a clause the contract does not have, a test name that its file does not contain, or, once the design is accepted, a file that is not a frozen test.
The server MUST record the digests of the contract and of each cited test file, and the review browser MUST mark the examples as stale when either changed.
The review browser MUST show the clauses that no example cites as gaps.
After a passing verification run, the review browser MUST compare the planned changes with the derived change map, file by file and unit by unit, and MUST NOT gate on the difference.

## Rationale

Examples grouped under contract clauses keep the contract's structure and stay short for a suite of dozens of tests.
Only the wording of an example needs a model, and the server checks every citation, so the view cannot claim a clause or a test that the design does not hold.
Files with the units they add or change match what other agent planners record, such as the files and locations of Codex ExecPlans, while leaving out the code to insert, so the design stays a contract rather than a script.
Comparing planned with actual changes points the person and a reviewer at the files to inspect first without asking implementers for bookkeeping.

## Alternatives

A Given, When, Then table and verbatim transcripts were rejected as the default format because they grow long and repeat setup past about twenty tests.
Having the server call a model itself was rejected because not every host supports sampling.
Gating on planned versus actual changes was rejected because the plan is a forecast, and a correct implementation often touches one more helper.

## Consequences

Each design that waits for the user costs one small-model read of its contract and tests, and one more for each revision.
A wrong paraphrase is the main risk, and no deterministic check catches it, so each example links to its test.
A clause missing from the contract stays invisible in the view, since the view only restates the contract and the tests.
Designs written before this change have no `Changes` section, and their slice pages show no planned changes.

## Mechanism

The design view is a slice record that `update_design_view` replaces as a whole.
The slice page reads the contract and `Changes` from `slice.md` on each load, so a revised design shows its new clauses and changes immediately.

## Decision Log
