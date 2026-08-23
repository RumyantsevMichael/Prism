---
name: implement
description: "Implement one fitted outcome slice through failing tests, working code, durable artifacts, fresh review, and final correctness confirmation."
argument-hint: '[initiative/slice]'
---

# Implement a fitted slice

Do not delegate implementation to a fresh worker.

Read `.prism/workflow.md` and applicable project instructions.
Use the accepted requirements, relevant ADRs, tests, design context, and compact slice record when present.
Inspect only files required for the accepted design and verification.
When orchestration provides a slice findings path, read the complete file before implementation and before every correction.
When no path is supplied, use `<configured plans>/<initiative>/<slice>/findings.md` when the slice has a plan.
Read [the review format](../review/references/review-format.md) before changing finding statuses.
Edit only finding status and implementer evidence in that file.

Create `recovery.md` in the initiative plan only when the context must pause or be replaced.
Delete that recovery record after the slice completes.

## 1. Bind acceptance to executable tests

Use the executable slice test selected during design when one exists.
Create one only when design did not create one.
Use the feature file created during design when one exists.
Do not create a replacement feature file from verified code.
Reuse the project test structure and fixtures.
Follow the contract decision recorded by `design`.
When the decision names a canonical contract, bind that contract to its production or verification consumer before the consumer changes.
When the decision says `NO CONTRACT NEEDED`, do not create a contract.
Do not create a new contract when an existing production type or schema governs the boundary.

## 2. Prove the red checkpoint

Bind the design-created feature steps through `write-step-definitions` when a BDD harness exists.
Run the design-created executable slice test or the bound feature before production behavior changes when the harness supports a red checkpoint.
Do not weaken or replace a design-created test without returning to the `design` fit checkpoint.
Run the exact test command.
Confirm that it fails because the required behavior is absent.
Stop and repair the test when it fails for setup, syntax, or an unrelated defect.

Record only the command, exit status, and expected failure reason.
Do not store full test output unless a separate log is necessary for recovery.
Exempt a documentation-only slice and state the reason.

## 3. Implement the slice

Implement the complete observable outcome across every required layer.
Keep the changed path safe and complete.
Do not defer a necessary layer to another slice.
Do not broaden the accepted outcome.

Replace any shape-only scaffold created during design with complete behavior before verification.

Make private helper, local data-structure, and similar code-level choices in code and tests.
When a requirement is missing or must change, return `BLOCKED` with the exact user question.
Do not edit requirements without explicit user approval.
When implementation requires a new consequential architectural decision, return `BLOCKED` with the exact decision needed.
Do not create or revise an ADR without the user or orchestrator response.
When exploration proves that the slice does not fit, return to the `design` fit checkpoint before more edits.
When a finding has status `OPEN` or `REOPENED`, mark it `IN PROGRESS` before the correction and `FIXED` with evidence after the correction.
Do not mark a finding `VERIFIED` from the delivery context.

## 4. Verify the code

Run the focused test, affected integration tests, and configured verification commands.
Run one exact end-to-end scenario through the surface selected during design.
Inspect the complete diff for unrelated edits, generated files, debug output, and missing documentation.
Remove generated caches and temporary files from the change.

Treat an unavailable required verification path as unfinished work.
Do not replace cross-process or cross-surface proof with an in-process test.

## 5. Run the author preflight

Before `READY FOR REVIEW`, trace every Approved requirement to changed behavior, executable tests, and verification evidence.
Check normal, failure, recovery, lifecycle, compatibility, security, and operational behavior for every changed path.
Read every `OPEN`, `IN PROGRESS`, and `REOPENED` finding in the slice findings file.
Do not return for review while an addressed finding lacks `FIXED` status and closure evidence.
Do not erase, rewrite, or duplicate earlier finding history.

## 6. Update durable artifacts

Preserve the design-created feature files as the acceptance specification.
Do not rewrite feature scenarios to match implementation.
When a BDD harness exists, keep `write-step-definitions` bound to the feature's observable assertions and run the acceptance command.
Return to `design` when verified behavior conflicts with a feature scenario or intended behavior changes.

Update user guidance when observable behavior changed.
Update an operator runbook when operations changed.
Create or update a diagram only after code establishes the structure.
Make the diagram explain the implemented system rather than prescribe implementation.

Do not duplicate code structure in prose.
Do not add a durable reference to the initiative plan or slice name.

## 7. Prepare fresh review

Prepare the diff base, code paths, requirements, tests, feature files, relevant ADRs, and security surface.
Do not create a prose design summary for the reviewer.

Return `READY FOR REVIEW` with changed artifact and diagram paths, the findings path, the verification status, and one contract decision for every changed boundary.
Repeat each contract path with its consumers and exact verification command, or repeat the specific `NO CONTRACT NEEDED` reason.
Use this exact form for each executable contract:

```text
Contract: <canonical path>
Consumers: <production code or verification>
Verification: <exact command>
```

Use this exact form when no executable contract is needed:

```text
Contract: NO CONTRACT NEEDED
Reason: <specific reason>
```

The orchestrator starts the fresh reviewer with the findings path and returns the updated finding IDs to this task.
When this task receives findings, read the complete file, fix all unresolved entries in one batch, and rerun affected verification.
Return `READY FOR RE-REVIEW` after the fix batch with the same contract declarations and updated finding evidence.

Do not change slice status, roadmap status, ADR status, or plan lifecycle.
Do not propose a commit.
