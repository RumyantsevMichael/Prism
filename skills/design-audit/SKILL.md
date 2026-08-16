---
name: design-audit
description: "Audit a fitted slice before implementation for complete requirements, design decisions, boundaries, contracts, security, and verification coverage."
---

# Audit a fitted slice

Do not edit requirements, ADRs, design artifacts, code, or tests.

Read `.prism/workflow.md` and project instructions first.
Read the approved requirements, relevant ADRs, the accepted slice record, recorded design artifacts, diagrams, and planned verification paths.
Read the bounded code surfaces named by `design`.
Use targeted exploration and stop when you can trace every requirement to a planned behavior, boundary, test, and verification command.

## Audit order

1. Check that every applicable requirement has one planned behavior and one observable verification path.
2. Check that the design names ownership, inputs, outputs, state, errors, recovery, compatibility, migration, and operational behavior.
3. Check lifecycle interactions, including cancellation, deadlines, cleanup, retries, nested requests, resource ownership, and authority changes when applicable.
4. Check concurrency, ordering, replay identity, quotas, and atomicity when the slice has concurrent or repeatable operations.
5. Check every changed boundary and confirm that its contract decision has a canonical path, production or verification consumer, and exact verification command.
6. Check security boundaries for secrets, untrusted input, authentication, authorization, privilege, network access, storage, IPC, and hosted execution when applicable.
7. Check that planned tests reach the user or system surface and cover normal, failure, recovery, compatibility, and security behavior.
8. Check that recorded diagrams and artifacts explain the decisions that implementation must preserve.

Review all applicable checks and interactions before reporting findings.
Continue after each finding and report the complete actionable finding set in one result.
Do not create a new contract when an existing production type or schema governs the boundary.
Do not create a contract when no production code, generated code, or verification consumes it.
Do not store the final contract in a slice directory.
Reject a description such as `private session contract` without a canonical path and consumer.

## Contract result

For each boundary, record exactly one of these forms:

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
Check that the consumer uses the contract at the boundary.
Check that the verification command can run the consumer.

## Result

Report every actionable finding with severity, evidence, affected path, and closing condition.
Report exactly `Artifacts: <recorded design artifact and diagram paths>` for visual review.
Return `CLEAN` only when the audit finds no actionable finding and every contract decision passes the consumer check.
Return `FINDINGS` with the complete finding list when any issue remains.
Do not report hypothetical issues without an affected path and failure condition.
Do not create new requirements or ADRs during the audit.
