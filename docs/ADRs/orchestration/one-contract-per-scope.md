# Design one contract per scope and coordinate slices through server records

Status: Proposed
Created: 2026-10-29

## Requirements

No Approved requirement governs this decision yet.
It follows [Complete a designed slice on a recorded verification run](../workflow-records/slice-verification-runs.md) and [Show a fitted design as examples and planned changes at the design gate](../workflow-records/design-view.md).

## Problem

In the October 2026 Nushell runs, the frozen contract set delivery quality, while designing each slice just in time and reviewing every slice added cost without adding quality.
The orchestrator's context peaked near 970,000 tokens because tool results returned whole records and run output, and because it kept coordination bookkeeping, git commands, and file hashes by hand.
Agents also spent many turns rendering design diagrams and looking at the images, although only the person at the design gate reads them.

## Decision

Design MUST write one contract per scope, where a scope is the root slice or a part that a split design created, with its assumption probes, its frozen tests, and a plan of the slices that implement it.
A scope too large for one contract MUST split into parts that each get their own contract when they are next.
Each frozen test file MUST belong to one unfinished slice.
Accepting the design of a slice that has not started MUST stage its frozen tests: the server keeps them in the slice's records and takes them out of the work tree, and starting the slice MUST put them back.
A passing verification run MUST complete a slice whose review mark is `none`.
A slice MUST be reviewed only when the user marks it or the run's `review` setting selects it.
`update_initiative` MUST return an acknowledgement of the touched slices, and `verify_slice` MUST return the verdict, failing test names, and the path of a full output log kept outside the project.
Design MUST write diagrams as PlantUML source only, an overview per contract and a code view per slice, and accepting a design MUST refuse a diagram that does not parse or shows more than 30 elements.

## Rationale

One contract per scope keeps the gain that the benchmark attributed to the contract while paying for one design session instead of one per slice.
Staging keeps the test command of an earlier slice from running, and in compiled languages failing to build, the tests of later slices.
Inferring completion and returning brief results removes the bookkeeping that filled the orchestrator's context, without weakening the verification gate.
The server's parse check gives the designer the only feedback it needs from a diagram, and readability stays with the person who reads it.

## Alternatives

Verifying once per initiative was rejected because a slice could not complete on its own evidence.
A per-slice test command template was rejected because test runners select tests in incompatible ways, and a template is easy to get subtly wrong.
Rendering diagrams for the agent was rejected because its cost repeated on every revision and the agent's judgment of readability did not replace the person's.

## Consequences

A slice's frozen tests are absent from the work tree until the slice starts, so a design revision first puts them back with `restore_tests` and accepts each unfinished slice again.
A frozen test file that existed before the design goes back to its earlier committed content while the slice is staged.
The orchestrator starts each slice with one `set_status` call and no longer records active operations by hand.
The diagram check runs the vendored PlantUML runtime in a worker thread with a minimal DOM, which measures text by length, so element counts and syntax errors are exact while layout is not computed faithfully.

## Mechanism

The staged tests of a slice are a slice record with each file's content and the content it had before the design.
The initiative update writes that record, writes the initiative record, and only then takes the files out of the work tree.
Verification refuses a staged slice and, after a passing run of a slice marked `none`, records `done` through the same completion gate as before.
Run output is written to a log under the plugin data directory, and the brief result reads failing test names from cargo, Node, TAP, pytest, Go, Jest, and Vitest output.
The diagram check parses every `.puml` file in the slice's folder and its ancestors' folders and counts entities, packages, participants, and links in the drawn SVG.

## Decision Log
