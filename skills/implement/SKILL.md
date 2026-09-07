---
name: implement
description: "Implement or correct one audited atomic slice, verify its behavior, and return evidence for independent review."
argument-hint: '[initiative/slice]'
sdm: "0.3"
---

# Implement an audited slice

The same [delivery context](../workflow/SKILL.md#common-terms) owns design, implementation, and corrections unless orchestration replaces it.
Orchestration owns review dispatch, lifecycle changes, ADR acceptance, commits, and correctness confirmation.

## 1. Prepare

1. Read `.prism/workflow.md` and applicable project instructions.
2. Read the Approved requirements, audited design result, relevant ADRs, contract decisions, tests, feature files, and slice diagrams.
3. Confirm orchestration cleared the implementation gate and supplied the current workspace and review base.
4. If required design evidence is missing or invalid, return to `design` before production edits.
5. If orchestration supplies no findings path, use `<configured plans>/<initiative>/<slice>/design-audit/findings.md` when it exists.
6. Read every supplied or fallback findings file completely.
7. Select the entry path:
   - For initial implementation, complete section 2 before section 6.
   - For returned findings, follow section 6.
   - For integrated-result verification, compare the reviewed result with the integrated tree before section 6.

## 2. Establish executable acceptance

- If the slice changes only documentation, record its red-checkpoint exemption.
- Otherwise:
  1. Reuse the design-created tests and feature files.
  2. When features are not specification-only, use `write-step-definitions` to bind their observable assertions.
  3. Follow each design contract decision, binding canonical contracts to their consumers before changing those consumers.
  4. Run the selected acceptance command before production behavior changes.
  5. Confirm failure at the starting surface because required behavior is absent.
  6. If setup causes failure, repair the test setup before repeating the command.
  7. If an unrelated production defect prevents the checkpoint, return the blocker.
  8. Record the exact command, exit status, and expected failure reason.

Specification-only feature files do not require a new BDD harness.
Weakening or replacing design acceptance requires renewed design and its gates.

## 3. Implement the outcome

1. Implement the complete observable outcome across every required layer.
2. Replace all shape-only scaffolds with complete behavior before verification.
3. Keep private helpers and local data structures in code and tests.

- If a requirement is missing or must change, return `BLOCKED` with the exact user question.
- If a new consequential architectural decision is needed, return `BLOCKED` with that decision for orchestration.
- If the outcome exceeds atomic fit or contradicts acceptance, preserve the work and return to `design` through orchestration.

Implementation does not edit requirements without user approval or revise ADRs without a user or orchestrator response.

## 4. Verify and update artifacts

1. Verify the slice:
   - For documentation-only changes:
     1. Run the design-selected documentation checks and applicable configured validators.
     2. Check changed links, examples, and procedures against verified behavior.
   - Otherwise:
     1. Run focused tests, affected integration tests, and configured verification commands.
     2. Run the design-selected end-to-end scenario through its actual surface.
     3. When features are not specification-only, run the configured acceptance command with every feature step bound.
2. Trace each Approved requirement to changed behavior or documentation, its assertions or checks, and observed verification evidence.
3. Check applicable failure, recovery, lifecycle, compatibility, security, and operational cases against the design and findings.
4. Inspect the complete diff for unrelated edits, temporary files, generated caches, and stale documentation.
5. Remove task-generated temporary files and caches from the change.
6. Use `write-user-docs` for changed user behavior and required operator procedures.
7. Update slice-folder diagram source against verified code, removing obsolete relationships and resolved proposed markers.

In-process tests do not replace required cross-process or cross-surface proof.
Feature scenarios retain their approved intent, and durable documentation does not cite coordination records or slice identities.

## 5. Return review evidence

1. Return `READY FOR REVIEW`, or `READY FOR RE-REVIEW` after corrections, only when required verification passes.
2. Include the review base, changed paths, requirement links, ADRs, tests, features, diagrams, and security surface or `none`.
3. Include every [contract decision](../review/SKILL.md#contracts) and exact verification command with its result.
4. When findings exist, include each lane path and corrected IDs with closure evidence.
5. For integration verification, report conflict resolutions, changed behavior, and uncertain equivalence for review routing.

If verification or correction cannot finish, the result states the blocker and unfinished work instead of readiness.
The result contains evidence paths, not a prose design summary.

## 6. Correct review findings

1. Read [review-format.md](../review/references/review-format.md) and every assigned lane file completely before correction.
2. For each `OPEN`, `REOPENED`, or `IN PROGRESS` finding assigned to implementation:
   1. Mark it `IN PROGRESS`.
   2. If a review probe exists, run it before correction and preserve its asserted behavior.
   3. Correct the defect within the audited design, using section 3 for scope or decision changes.
   4. Run affected verification, including the probe.
   5. Record closure evidence and mark the finding `FIXED` only when its closing condition passes.
3. For initial implementation, complete the remaining outcome through section 3.
4. Complete sections 4 and 5 after correcting all actionable findings.

Delivery changes only finding status and implementer evidence, with additions to status history.
Only a fresh reviewer can mark `VERIFIED` or `REOPENED`.
Verified probes remain in the canonical test location unless delivery promotes them into equivalent existing coverage.

## 7. Preserve interrupted work

- Before a pause or replacement, write `<configured plans>/<initiative>/<slice>/recovery.md` with phase, workspace, evidence, unfinished work, and next action.
- Return the recovery path to orchestration.
- After a replacement resumes, read that record before selecting the entry path in section 1.
