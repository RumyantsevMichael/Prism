---
name: design
description: "Design an initiative or one part of it: write one frozen contract with probed assumptions, failing acceptance tests, and a plan of the slices that implement it, or split a scope too large for one contract into parts."
argument-hint: '[initiative/slice]'
sdm: "0.3"
---

# Design a contract

Design does the quality work of the [workflow](../workflow/SKILL.md).
It designs one contract scope: the root slice of an initiative, or a part that an earlier design split off.
Implementers later work from its output in fresh sessions, and they are judged on correct behavior, not on passing its tests, so a contract or suite that is easy to pass but misses required behavior is a design defect.

## 1. Prepare

1. Read `.prism/workflow.md`, the project instructions, and the glossary.
2. Read the scope's title, outcome, and requirement assignment through `get_initiative`.
3. Read the assigned Approved requirements, relevant ADRs, and the parent's `slice.md` when the scope has a parent.
4. Explore the code where the required behavior enters the system and every part it must change, until a fit decision is supported.
5. When existing concepts overlap the required behavior, use `refactor` in analysis mode before deciding to add a new one.

## 2. Decide fit

- Return `FIT` when one contract can fix the whole observable interface of the scope now, with settled architecture.
- Return `SPLIT` only with [split evidence](../workflow/SKILL.md#common-terms), which Prism checks: `contract_size` with the files that Prism measured when it refused the fit proposal as `contract_too_large`, `unfrozen` with an Unprobed assumption quoted from **Assumptions** that only one part's delivery can settle and that part, or `user_gate` when the person asked for the split in design feedback, which takes effect when the person approves it at the gate.
- Return `BLOCKED` when a requirement, decision, or external fact that no probe can establish prevents a sound design.

## 3. Write a fit design

1. Write the scope folder's `slice.md` with the sections in the [contract example](#contract-example).
2. In **Contract**, fix everything a user or caller observes that the requirements leave open, one list item per clause: commands, arguments and flags, fields and types, identifiers, error cases, ordering, and stream or lifecycle behavior.
3. In **Assumptions**, list every contract clause that depends on behavior outside the new code, such as a framework, library, runtime, or input shape nobody planned for.
4. For each assumption, do one of the following and record which:
   - Probe it with a small experiment against the real system and record the command and what you observed.
   - When it cannot be probed, write the contract so that an uncovered case produces a clear error or a documented observable fallback, never a silent wrong result.
5. Plan the slices that implement the contract, each small enough for one fresh implementation session, in dependency order.
6. Write acceptance tests in the project's test location, black-box through the starting surface, with one test per contract clause, covering error, edge, and interaction cases as well as the main path.
   Give each slice its own new test files, so that each file belongs to exactly one slice; Prism keeps a slice's test files out of the work tree until the slice starts.
7. Run the tests and confirm they build and fail because the behavior is absent, not because of setup defects.
8. In **Slices**, list each slice with its slug, title, outcome, requirement references, dependencies, frozen test files, and review recommendation.
9. For each slice, write `slice.md` in its slice folder, the folder named by its slug in the initiative's plans folder, with the sections in the [slice example](#slice-example).
   In **Changes**, list each file you expect to add, change, or remove, starting with `add`, `change`, or `remove` and the path in backticks, then the functions, types, or modules it adds or whose interface it changes, and a few words on why.
10. Write the [diagrams](#4-diagrams).
11. Recommend review `required` for a slice when an independent implementation review pays off, such as for authentication, authorization, secrets, untrusted input, or data loss risk, and `none` otherwise.
12. When the project keeps Gherkin feature files, use `write-feature` for the scenarios and list them as frozen tests.
13. When production code, generated code, or verification consumes a changed boundary, use `write-contracts` after reusing governing types or schemas.
14. Use `write-adr` for each settled architectural decision that outlives the initiative.
15. Commit the design when commits are on.

- Don't
  - Implement production behavior.
  - Write tests that assert private helpers or internal structure.
  - Write in **Changes** the code to insert; it names where the code changes, not how.

When the plan has one slice, the scope itself is that slice: put **Changes** in the scope's `slice.md` and write no slice folder.

### Contract example

```markdown
# Signed reports

## Contract
1. `report download <id>` writes the report bytes to stdout and exits 0.
2. An unknown id exits 2 with `error: no report <id>` on stderr and writes nothing to stdout.
3. `report audit` lists one line per download: `<time> <id> <user>`.

## Assumptions
- Probed: the storage client returns `None` for a missing key (`cargo test probe_missing_key`, observed `None`).
- Unprobed: report sizes above 2 GiB; the command refuses them with `error: report too large`.

## Slices
| Slug | Outcome | Requirements | Depends on | Frozen tests | Review |
| --- | --- | --- | --- | --- | --- |
| `download` | Users download a report by id. | `reports.md§1` | | `tests/report_download.rs` | none |
| `audit` | Operators list downloads. | `reports.md§2` | `download` | `tests/report_audit.rs` | required: exposes user names |
```

### Slice example

```markdown
# Download reports

## Changes
- add `src/report/source.rs`: `ReportSource`, also used by `audit`.
- change `src/storage/client.rs`: `get` streams instead of buffering.
- change `src/cli/report.rs`: `download` subcommand.
```

## 4. Diagrams

Diagrams are for the person at the design gate.
Write PlantUML source only: Prism parses each `.puml` file when the design is accepted and reports a syntax error or a view with more than 30 elements as text.

1. In the scope folder, write `overview.puml`: the slices as packages, the interfaces they share, and their dependency order.
2. In each slice folder, write `code.puml`: the units that **Changes** names and how they depend on each other.
3. When a view exceeds 30 elements, split it into views a person can read.
4. When `update_design_view` or acceptance reports a diagram problem, fix the source.

- Don't
  - Render a diagram or look at a rendered image.

## 5. Write a split

1. Group the required behavior into parts that each deliver observable behavior through a starting surface and can take one contract.
2. Give each part a unique slug, a capability title, a one-sentence outcome, and its requirement references, so that the parts together cover the scope's assignment exactly.
3. Order the parts by dependency.
4. In the scope's `slice.md`, fix the interfaces between the parts that more than one part relies on, and keep the **Assumptions** that the evidence quotes.
5. When the evidence is `contract_size`, keep the measured files in place; each part's design reuses or removes them.

- Don't
  - Write contracts or tests for the parts; each part is designed when it is next.

## 6. Propose the result

1. Read the initiative's revision with `get_initiative`, and call `update_initiative` with one `propose_design` operation for the scope:
   - `FIT`: a `split` of the scope into its planned slices, their `set_dependencies` operations, and an `accept_design` operation per slice with its frozen tests and review recommendation; for a one-slice plan, only `accept_design` on the scope.
   - `SPLIT`: a `split` into the parts with the evidence, and their `set_dependencies` operations.
2. When Prism refuses the proposal, fix the design and propose again; on `revision_conflict`, read the revision again.
3. Return `PROPOSED` with the scope's `slice.md` path, the failing test result from step 7 of section 3, and open questions, or `BLOCKED` with the exact question or missing fact.

## 7. Revise a design

- When orchestration returns a design question, a failed design gate, an implementer's contract defect, or changed dependencies:
  1. Read the feedback, the current contract, and the frozen tests that orchestration put back in the work tree.
  2. Repeat the affected parts of sections 3 and 4 for the slices that have not finished, keeping the planned slices and their slugs.
  3. When the revision needs other slices, return `BLOCKED` with the slices it needs.
  4. Propose the result through section 6 with every unfinished slice of the scope.

A frozen test changes only through a revised design that orchestration accepts again.
