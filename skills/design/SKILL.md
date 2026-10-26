---
name: design
description: "Design a slice of an initiative: decide whether it fits one implementation, then write its frozen contract, probed assumptions, and failing acceptance tests, or split it into smaller child slices."
argument-hint: '[initiative/slice]'
sdm: "0.3"
---

# Design a slice

Design does the quality work of the [workflow](../workflow/SKILL.md).
Implementers later work from its output in fresh sessions, and they are judged on correct behavior, not on passing its tests, so a contract or suite that is easy to pass but misses required behavior is a design defect.

## 1. Prepare

1. Read `.prism/workflow.md`, the project instructions, and the glossary.
2. Read the slice's title, outcome, and requirement assignment through `get_initiative`.
3. Read the assigned Approved requirements, relevant ADRs, and the parent slice's `slice.md` when the slice has a parent.
4. Explore the code where the required behavior enters the system and every part it must change, until a fit decision is supported.
5. When existing concepts overlap the required behavior, use `refactor` in analysis mode before deciding to add a new one.

## 2. Decide fit

- Return `FIT` when one design can fix the whole observable interface of the slice now, with settled architecture.
- Return `SPLIT` when the scope is too large or too uncertain to fix one interface for it now, such as work of several weeks.
- Return `BLOCKED` when a requirement, decision, or external fact that no probe can establish prevents a sound design.

A `FIT` slice can still need several implementation steps; steps share one frozen contract and suite, while `SPLIT` children are designed later on their own.
When `resolve_session_capacity` is available, judge step size against the implementer model's context window.

## 3. Write a fit design

1. Write the slice folder's `slice.md` with the sections in the [design example](#design-example).
2. In **Contract**, fix everything a user or caller observes that the requirements leave open, one list item per clause: commands, arguments and flags, fields and types, identifiers, error cases, ordering, and stream or lifecycle behavior.
3. In **Assumptions**, list every contract clause that depends on behavior outside the new code, such as a framework, library, runtime, or input shape nobody planned for.
4. For each assumption, do one of the following and record which:
   - Probe it with a small experiment against the real system and record the command and what you observed.
   - When it cannot be probed, write the contract so that an uncovered case produces a clear error or a documented observable fallback, never a silent wrong result.
5. Write acceptance tests in the project's test location, black-box through the starting surface, with one test per contract clause, covering error, edge, and interaction cases as well as the main path.
6. Run the tests and confirm they build and fail because the behavior is absent, not because of setup defects.
7. When the slice needs more than one implementation session, list ordered **Steps**, each with what it delivers, the acceptance tests it must turn green, and the shared internal interfaces later steps rely on.
8. In **Changes**, list each file you expect to add, change, or remove, starting with `add`, `change`, or `remove` and the path in backticks, then the functions, types, or modules it adds or whose interface it changes, and a few words on why.
9. In **Review**, recommend `required` when an independent implementation review pays off, such as for authentication, authorization, secrets, untrusted input, or data loss risk, and `none` otherwise.
10. When the project keeps Gherkin feature files, use `write-feature` for the slice's scenarios and list them as frozen tests.
11. When production code, generated code, or verification consumes a changed boundary, use `write-contracts` after reusing governing types or schemas.
12. Use `write-adr` for each settled architectural decision that outlives the slice.

- Don't
  - Implement production behavior.
  - Write tests that assert private helpers or internal structure.
  - Write in **Changes** the code to insert; it names where the code changes, not how.

### Design example

```markdown
# Download signed reports

## Contract
- `report download <id>` writes the report bytes to stdout and exits 0.
- An unknown id exits 2 with `error: no report <id>` on stderr and writes nothing to stdout.

## Assumptions
- Probed: the storage client returns `None` for a missing key (`cargo test probe_missing_key`, observed `None`).
- Unprobed: report sizes above 2 GiB; the command refuses them with `error: report too large`.

## Steps
1. Storage lookup and the error cases; turns green `download_unknown_id`.
2. Streaming output; turns green `download_writes_bytes`; relies on `ReportSource` from step 1.

## Changes
- add `src/report/source.rs`: `ReportSource`, shared by both steps.
- change `src/storage/client.rs`: `get` streams instead of buffering.
- change `src/cli/report.rs`: `download` subcommand.

## Review
none: no new trust boundary.

## Frozen tests
- `tests/report_download.rs`
```

## 4. Write a split

1. Group the required behavior into child outcomes that each deliver observable behavior through a starting surface.
2. Give each child a unique slug, a capability title, a one-sentence outcome, and its requirement references, so that the children together cover the parent's assignment exactly.
3. Order the children by dependency.
4. In the parent's `slice.md`, fix the interfaces between the children that more than one child relies on.

- Don't
  - Write contracts or tests for the children; each child is designed when it is next.

## 5. Return the result

- Return exactly one status with its evidence:
  - `FIT`: the `slice.md` path, the frozen test paths, the test command run in step 6 of section 3 with its failing result, the step count, and the review recommendation.
  - `SPLIT`: each child's slug, title, outcome, requirement references, and dependencies, and the parent `slice.md` path.
  - `BLOCKED`: the exact question or missing fact.

## 6. Revise a design

- When orchestration returns a design question, a failed design gate, or an implementer's contract defect:
  1. Read the feedback and the current design.
  2. Repeat the affected parts of sections 2 to 4.
  3. Return the result through section 5.

A frozen test changes only through a revised design that orchestration accepts again.
