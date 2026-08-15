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

Create `recovery.md` in the initiative plan only when the context must pause or be replaced.
Delete that recovery record after the slice completes.

## 1. Bind acceptance to executable tests

Choose the smallest executable test that starts through the surface selected during design and proves the observable outcome.
Reuse the project test structure and fixtures.
Use `write-contracts` only when implementation or verification will consume an executable boundary artifact.

## 2. Prove the red checkpoint

Add or bind the executable acceptance test before production behavior changes.
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

Make private helper, local data-structure, and similar code-level choices in code and tests.
When a requirement is missing or must change, return `BLOCKED` with the exact user question.
Do not edit requirements without explicit user approval.
When implementation requires a new consequential architectural decision, return `BLOCKED` with the exact decision needed.
Do not create or revise an ADR without the user or orchestrator response.
When exploration proves that the slice does not fit, return to the `design` fit checkpoint before more edits.

## 4. Verify the code

Run the focused test, affected integration tests, and configured verification commands.
Run one exact end-to-end scenario through the surface selected during design.
Inspect the complete diff for unrelated edits, generated files, debug output, and missing documentation.
Remove generated caches and temporary files from the change.

Treat an unavailable required verification path as unfinished work.
Do not replace cross-process or cross-surface proof with an in-process test.

## 5. Update durable artifacts

Update feature files from verified behavior after implementation.
Link each new or changed Rule to its Approved requirement.
When a BDD harness exists, use `write-step-definitions` to bind the feature to executable assertions.

Update user guidance when observable behavior changed.
Update an operator runbook when operations changed.
Create or update a diagram only after code establishes the structure.
Make the diagram explain the implemented system rather than prescribe implementation.

Do not duplicate code structure in prose.
Do not add a durable reference to the initiative plan or slice name.

## 6. Prepare fresh review

Prepare the diff base, code paths, requirements, tests, feature files, relevant ADRs, and security surface.
Do not create a prose design summary for the reviewer.

Return `READY FOR REVIEW` with paths and the verification status.
The orchestrator starts the fresh reviewer and returns its complete finding list to this task.
When this task receives findings, fix them in one batch and rerun affected verification.
Return `READY FOR RE-REVIEW` after the fix batch.

Do not change slice status, roadmap status, ADR status, or plan lifecycle.
Do not propose a commit.
