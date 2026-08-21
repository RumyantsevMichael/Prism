---
name: review
description: "Audit a Prism slice before implementation or review completed code against approved intent, behavior, boundaries, and security."
---

# Review a slice

Run in a fresh context that does not inherit the authoring context.
Use the mode supplied by orchestration: `design-audit` before implementation or `implementation-review` after verification.
Do not edit code or artifacts except the supplied slice `findings.md` file.

Read `.prism/workflow.md` and project instructions.
Read [review-format.md](references/review-format.md) before creating the findings file or reporting.
Use the findings section for `findings.md` and the result section for the compact response.
Leave the findings section empty when no findings exist.
Read or create the complete slice `findings.md` file before the review.
Read the requirements, relevant ADRs, tests, feature files, diagrams, declared contracts, and mode-specific paths.
Use code as the source for implementation detail.

Use the findings file as the source of truth.
Assign a stable ID to each new root defect and reuse it when the same defect returns.
Write new findings with status `OPEN`.
Append evidence and review history without deleting earlier history.
Mark an implementer's `FIXED` finding `VERIFIED` when its closing condition passes, or `REOPENED` when it fails.
The delivery context may set `IN PROGRESS` and `FIXED`.
The review context may set `OPEN`, `VERIFIED`, and `REOPENED`.
`OPEN` means that a reviewer found a defect without a complete correction.
`IN PROGRESS` means that the delivery context started the correction.
`FIXED` means that the delivery context applied the correction with evidence.
`VERIFIED` means that a reviewer confirmed the closing condition.
`REOPENED` means that a reviewer found that the closing condition still fails.

For each changed boundary, record exactly one of these forms:

```text
Contract: <canonical path>
Consumers: <production code or verification>
Verification: <exact command>
```

```text
Contract: NO CONTRACT NEEDED
Reason: <specific reason>
```

Check that every declared contract has a real consumer.
Do not create a contract when no production code, generated code, or verification consumes it.
Do not create a contract when an existing production type or schema governs the boundary.
Do not accept a description such as `private session contract` without a canonical path and consumer.
Do not store a final contract in a slice directory.

Report only actionable findings with an affected path and failure condition.
Return `CLEAN` only when no actionable finding remains.

## Design-audit mode

Read the accepted slice record, recorded design artifacts, diagrams, bounded code surfaces, and planned verification paths.

Check every applicable item:

1. Map each requirement to one planned behavior and one observable verification path.
2. Check ownership, inputs, outputs, state, errors, recovery, compatibility, migration, and operations.
3. Check lifecycle, cancellation, deadlines, cleanup, retries, resource ownership, and authority changes.
4. Check concurrency, ordering, replay identity, quotas, and atomicity when applicable.
5. Check changed boundaries, contract decisions, consumers, and verification commands.
6. Check security boundaries and planned normal, failure, recovery, compatibility, and security tests.
7. Check that artifacts and diagrams preserve the decisions implementation must follow.

Require every contract decision to pass the consumer check before returning `CLEAN`.
Include the findings path, design artifact paths, contract decisions, and verification command in the compact result.

## Implementation-review mode

Read the completed diff, verification status, test paths, and exact commands.
When a lane focus is supplied, review it exhaustively and do not repeat another lane's focus.
Do not rerun the full test suite or configured verification commands.

Check every applicable item:

1. Check every requirement without added product behavior.
2. Check tests through the user-visible or system surface.
3. Check feature files against verified behavior and requirement intent.
4. Check correctness, errors, state transitions, compatibility, migration, and integration.
5. Check lifecycle, concurrency, ordering, replay, quotas, atomicity, and idempotency.
6. Check public, process, network, storage, IPC, hosted-execution, and security boundaries.
7. Check unrelated edits, generated files, temporary files, and stale documentation.

When the security surface is non-empty, inspect secrets, untrusted inputs, authorization, privilege, network access, storage, and IPC as applicable.
When the security surface is `none`, verify that classification and record that the security audit was skipped.
Run a focused probe only when it can confirm or reject a suspected defect.
Include the lane, focus, coverage, findings path, finding IDs, and status in the compact result.

Do not restate the implementation.
Do not praise successful work.
Do not create requirements or architectural decisions during review.
