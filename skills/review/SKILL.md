---
name: review
description: "Audit an atomic Prism design before implementation or review verified code and corrections in an independent context."
sdm: "0.3"
---

# Review a slice

A [fresh review context](../workflow/SKILL.md#common-terms) receives artifacts and evidence without the delivery conversation.
`design-audit` checks implementability before production behavior exists.
`implementation-review` checks verified code against Approved intent.
Each review writes only its assigned lane findings file, except permitted implementation review probes.

## Prepare

1. Read `.prism/workflow.md`, project instructions, and [review-format.md](references/review-format.md).
2. Read the assigned mode, reporting slice, lane focus, findings path, and applicable review base.
3. Read or create the complete assigned findings file.
4. Read the requirements, relevant ADRs, tests, feature files, diagrams, contract decisions, and verification evidence for the lane.
5. If code or correction evidence is outdated, request the current result before deciding findings or closure.
6. Review the assigned scope through the applicable mode below.

## Contracts

Every changed boundary has one contract decision in these forms:

```text
Contract: <canonical path>
Consumers: <production code or verification>
Verification: <exact command>
```

```text
Contract: NO CONTRACT NEEDED
Reason: <specific reason>
```

- Check that each declaration names a canonical artifact, consumers, and verification command, or justifies no contract.
- Check that an existing governing type or schema has no duplicate contract.
- Reject final contracts stored in slice directories.

Design can name a planned production consumer whose behavior is still absent.
Missing planned behavior alone is not a design finding when the red checkpoint reaches the starting surface.
Implementation review requires actual consumption and its verification evidence.

## Review the assigned mode

- Check applicable ownership, inputs, outputs, state, failure, recovery, compatibility, migration, integration, security, and operations.
- Check applicable lifecycle, cancellation, deadlines, cleanup, retries, resource ownership, and authority changes.
- Check applicable concurrency, ordering, replay identity, quotas, atomicity, and idempotency.
- For `design-audit`:
  1. Trace every assigned requirement to planned behavior and an observable verification path.
  2. Check that boundaries, consequential decisions, consumers, and verification support one safe, complete atomic outcome.
  3. Check the shared concerns against diagrams and ADRs.
  4. Check feature scenarios for requirement links, meaningful boundary cases, and domain language without implementation detail.
  5. Check the red checkpoint reaches the starting surface and fails for missing behavior, or has a documentation-only exemption.
  6. Record defects in fit, design, requirements, or verification as findings.
  7. Route implementation-only gaps to delivery without opening design findings.
- For `implementation-review`:
  1. Read the complete diff against the supplied review base and recorded verification results.
  2. Trace assigned requirements and architectural constraints through changed code and observable tests.
  3. Reject product behavior outside Approved intent.
  4. Check feature scenarios against Approved intent and verified behavior.
  5. Check the shared concerns against changed code and tests.
  6. Inspect changed trust boundaries for untrusted inputs, secrets, authorization, privilege, storage, network access, and IPC.
  7. If the declared security surface is `none`, verify that classification and record the security audit exemption.
  8. Check unrelated edits, generated files, temporary files, and stale user or operator guidance.
  9. When a concrete finding needs executable proof:
     1. Add one minimal regression probe in the canonical test location through a public or system surface.
     2. Base assertions on requirements, ADRs, features, contracts, or verified behavior.
     3. Use existing fixtures or local setup without changing existing tests, fixtures, helpers, dependencies, or harness configuration.
     4. Record the probe path, command, and expected failure in the `OPEN` finding.

Review may run focused probes and records their results or why execution was unavailable.
Implementation review does not rerun the full suite or configured verification commands.
Delivery owns probe corrections and preserves or promotes verified coverage.

## Record findings and corrections

A finding identifies an actionable defect, its affected path, evidence, failure condition, and reviewer-verifiable closing condition.
The reporting lane retains cross-slice evidence and records its escalation target.

1. For each new defect, append an `OPEN` finding using the review format.
2. For each earlier finding, inspect its current evidence and closing condition without deleting history.
3. For each `FIXED` finding:
   1. Check the implementer evidence and affected artifacts.
   2. If closure evidence is insufficient, retain `FIXED` and report the missing evidence.
   3. If the closing condition passes, mark it `VERIFIED`.
   4. If the closing condition fails, mark it `REOPENED` with the remaining failure evidence.
4. If a previously `VERIFIED` defect returns, reuse its ID with `REOPENED` status.
5. Append status and review history for each finding change.

Delivery owns `IN PROGRESS` and `FIXED`, while reviewers own `OPEN`, `VERIFIED`, and `REOPENED`.
Only `VERIFIED` findings are resolved.

## Return the result

1. Update the lane result using the review format, including scope, coverage, findings, artifact paths, and verification evidence.
2. Include the contract decisions and design red checkpoint or exemption when applicable.
3. Return `CLEAN` only when no actionable finding remains, otherwise return `FINDINGS` with unresolved IDs and the lane path.

An expected design red checkpoint does not prevent `CLEAN`.
The result contains actionable evidence without an implementation summary or praise.
