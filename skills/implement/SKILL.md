---
name: implement
description: "Implement one fitted outcome slice through failing tests, working code, durable artifacts, fresh review, and final correctness confirmation."
argument-hint: '[initiative/slice]'
sdm: "0.3"
---

# Implement a fitted slice

The delivery context owns implementation and does not delegate it to a fresh worker.

1. Read `.prism/workflow.md` and applicable project instructions.
2. Use the accepted requirements, relevant ADRs, tests, design context, and compact slice record when present.
3. Inspect only files required for the accepted design and verification.
4. When orchestration supplies a findings path, read the complete file before implementation and every correction.
5. When no path is supplied and the slice has initiative state, use `<configured plans>/<initiative>/<slice>/findings.md`.
6. Read [the review format](../review/references/review-format.md) before changing finding statuses.

- Do
  - Edit only finding status and implementer evidence in the findings file.
  - When the context must pause or be replaced:
    1. Create `<configured plans>/<initiative>/<slice>/recovery.md` with the current phase, workspace, evidence, unfinished work, and next action.
    2. Return its exact path for orchestration to reference from the active context.
    3. After the slice completes, delete only that recovery record through orchestration.

## 1. Bind acceptance to executable tests

1. Use the executable slice test selected during design when one exists.
2. Create an executable slice test only when design did not create one.
3. Use the feature file created during design when one exists.
4. Reuse the project test structure and fixtures.
5. Follow the contract decision recorded by `design`.
6. When the decision names a canonical contract, bind it to its production or verification consumer before that consumer changes.

- Don't
  - Create a replacement feature file from verified code.
  - Create a contract when the decision says `NO CONTRACT NEEDED`.
  - Create a new contract when an existing production type or schema governs the boundary.

## 2. Prove the red checkpoint

1. When a BDD harness exists, bind the design-created feature steps through `write-step-definitions`.
2. When the harness supports a red checkpoint, run the design-created test or bound feature before production behavior changes.
3. Before correcting an unresolved finding with a review probe, run that probe.
4. Run the exact test command.
5. Confirm that the test fails because the required behavior is absent.
6. When the test fails from setup, syntax, or an unrelated defect, stop and repair the test.
7. Record only the command, exit status, and expected failure reason.

- Do
  - For a documentation-only slice, exempt the red checkpoint and state the reason.
- Don't
  - Weaken or replace a design-created test without returning to the `design` fit checkpoint.
  - Store full test output unless a separate recovery log is necessary.

## 3. Implement the slice

The changed path remains safe and complete.
The implementation does not defer a necessary layer or broaden the accepted outcome.

1. Implement the complete observable outcome across every required layer.
2. Before verification, replace every shape-only scaffold with complete behavior.
3. Make private helper, local data structure, and similar code-level choices in code and tests.

- When a requirement is missing or must change, return `BLOCKED` with the exact user question.
- When implementation needs a new consequential architectural decision, return `BLOCKED` with the exact decision needed.
- When exploration proves that the slice does not fit, return to the `design` fit checkpoint before more edits.
- Before that return, preserve existing work and identify its code, artifacts, and unresolved findings for design.
- When orchestration requests integration verification, compare the preserved reviewed result with the integrated tree and run affected verification.
- Report changed behavior, uncertain equivalence, conflict resolutions, and verification results for fresh review routing.
- For each `OPEN` or `REOPENED` finding:
  1. Mark the finding `IN PROGRESS`.
  2. Preserve the asserted behavior of its review probe.
  3. Correct the finding.
  4. Mark the finding `FIXED` and add evidence.

- Don't
  - Edit requirements without explicit user approval.
  - Create or revise an ADR without the user or orchestrator response.
  - Mark a finding `VERIFIED` from the delivery context.

## 4. Verify the code

An unavailable required verification path is unfinished work.
An in-process test cannot replace cross-process or cross-surface proof.

1. Run the focused test, affected integration tests, and configured verification commands.
2. Run one exact end-to-end scenario through the surface selected during design.
3. Inspect the complete diff for unrelated edits, generated files, debug output, and missing documentation.
4. Remove generated caches and temporary files from the change.

## 5. Run the author preflight

1. Before `READY FOR REVIEW`, trace every Approved requirement to changed behavior, executable tests, and verification evidence.
2. Check normal, failure, recovery, lifecycle, compatibility, security, and operational behavior for every changed path.
3. Read every `OPEN`, `IN PROGRESS`, and `REOPENED` finding in the findings file.
4. Confirm that every addressed finding has `FIXED` status and closure evidence before review.

- Don't
  - Return for review while an addressed finding lacks `FIXED` status and closure evidence.
  - Erase, rewrite, or duplicate earlier finding history.

## 6. Update durable artifacts

Diagrams explain the implemented system and do not prescribe implementation.

1. Preserve the design-created feature files as the acceptance specification.
2. When a BDD harness exists, keep `write-step-definitions` bound to the feature's observable assertions.
3. When a BDD harness exists, run the acceptance command.
4. When verified behavior conflicts with a feature scenario or intended behavior changes, return to `design`.
5. When observable behavior changed, update user guidance.
6. When operations changed, update an operator runbook.
7. After code establishes the structure, create or update a diagram when needed.
8. Make each diagram explain the implemented system.

- Don't
  - Rewrite feature scenarios to match implementation.
  - Duplicate code structure in prose.
  - Add a durable reference to the initiative coordination record or slice name.

## 7. Prepare fresh review

1. Prepare the diff base, code paths, requirements, tests, feature files, relevant ADRs, and security surface.
2. Include one contract decision for every changed boundary.
3. For each executable contract, repeat its path, consumers, and exact verification command in this exact form.

```text
Contract: <canonical path>
Consumers: <production code or verification>
Verification: <exact command>
```

4. When no executable contract is needed, repeat the specific reason in this exact form.

```text
Contract: NO CONTRACT NEEDED
Reason: <specific reason>
```

5. Return `READY FOR REVIEW` with changed artifact paths, diagram paths, the findings path, and verification status.

The orchestrator starts the fresh reviewer with the findings path and returns updated finding IDs to this task.

6. When this task receives findings, read the complete findings file.
7. Fix all unresolved entries in one batch.
8. Rerun affected verification.
9. Return `READY FOR RE-REVIEW` with the same contract declarations and updated finding evidence.

- Don't
  - Create a prose design summary for the reviewer.
  - Change slice status, roadmap status, ADR status, or initiative lifecycle.
  - Propose a commit.
