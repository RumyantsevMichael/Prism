---
name: review
description: "Audit a Prism slice before implementation or review completed code against approved intent, behavior, boundaries, and security."
sdm: "0.3"
---

# Review a slice

- Run in a fresh context that does not inherit the authoring context.
- Use the mode supplied by orchestration.
- Use `design-audit` before implementation or `implementation-review` after verification.

- Don't
  - During `design-audit`, edit any file other than `findings.md`.
  - Edit production code, existing tests, requirements, ADRs, feature files, fixtures, helpers, harness configuration, or dependencies.
  - Add tests during `design-audit`.
- Do
  - During `design-audit`, edit only `findings.md`.
  - During `implementation-review`, add a minimal finding-scoped regression test only when a concrete finding needs executable proof.

1. Read `.prism/workflow.md` and project instructions.
2. Read [review-format.md](references/review-format.md) before creating the findings file or reporting.
3. Read or create the complete slice `findings.md` before the review.
4. Use its findings section for `findings.md` and its result section for the compact response.
5. Read the requirements, relevant ADRs, executable slice tests, feature files, diagrams, declared contracts, and mode-specific paths.
6. Use code as the source for implementation detail.

## Findings

The findings file is the source of truth.
The delivery context may set `IN PROGRESS` and `FIXED`.
The review context may set `OPEN`, `VERIFIED`, and `REOPENED`.
`OPEN` means that a reviewer found a defect without a complete correction.
`IN PROGRESS` means that the delivery context started the correction.
`FIXED` means that the delivery context applied the correction with evidence.
`VERIFIED` means that a reviewer confirmed the closing condition.
`REOPENED` means that a reviewer found that the closing condition still fails.

- Assign a stable ID to each new root defect.
- Reuse the ID when the same defect returns.
- Write new findings with status `OPEN`.
- Append evidence and review history without deleting earlier history.
- Mark an implementer's `FIXED` finding `VERIFIED` when its closing condition passes.
- Mark an implementer's `FIXED` finding `REOPENED` when its closing condition fails.
- Report only actionable findings with an affected path and failure condition.
- After the review, leave the findings section empty when no findings exist.
- Return `CLEAN` only when no actionable finding remains.

## Contracts

Every changed boundary shall use exactly one of the following contract decision forms.

```text
Contract: <canonical path>
Consumers: <production code or verification>
Verification: <exact command>
```

```text
Contract: NO CONTRACT NEEDED
Reason: <specific reason>
```

- Do
  - Check that every declared contract has a real consumer.
- Don't
  - Create a contract when no production code, generated code, or verification consumes it.
  - Create a contract when an existing production type or schema governs the boundary.
  - Accept a description such as `private session contract` without a canonical path and consumer.
  - Store a final contract in a slice directory.

## Design-audit mode

### 1. Prepare

1. Read the accepted slice record, bounded code surfaces, and planned verification paths.

### 2. Audit

1. Check each applicable item:
   - Map each requirement to one planned behavior and one observable verification path.
   - Check ownership, inputs, outputs, state, errors, recovery, compatibility, migration, and operations.
   - Check lifecycle, cancellation, deadlines, cleanup, retries, resource ownership, and authority changes.
   - When applicable, check concurrency, ordering, replay identity, quotas, and atomicity.
   - Check changed boundaries, contract decisions, consumers, and verification commands.
   - Check security boundaries and planned normal, failure, recovery, compatibility, and security tests.
   - Check that feature files cover planned behavior, link to requirements, and contain no implementation details.
   - Check that ADRs preserve architectural decisions and that executable tests and contracts enforce selected boundaries.

### 3. Assemble the result

1. Require every contract decision to pass the consumer check before returning `CLEAN`.
2. Include the findings path, ADR paths, executable test paths, review probe paths, feature file paths, and diagram paths in the compact result.
3. Include every contract decision in the compact result.
4. For each executable contract, use this exact form in the compact result.

```text
Contract: <canonical path>
Consumers: <production code or verification>
Verification: <exact command>
```

5. When no executable contract is needed, use this exact form in the compact result.

```text
Contract: NO CONTRACT NEEDED
Reason: <specific reason>
```

6. Include the verification command in the compact result.

## Implementation-review mode

The review context does not rerun the full test suite or configured verification commands.
Implementation owns each review probe fix and preserves or promotes the probe after verification.

### 1. Prepare

1. Read the completed diff, verification status, test paths, and exact commands.

### 2. Audit

1. When orchestration supplies a lane focus, review it exhaustively without repeating another lane's focus.
2. Check each applicable item:
   - Check every requirement without accepting added product behavior.
   - Check tests through the user-visible or system surface.
   - Check feature files against requirement intent and verified behavior.
   - Check correctness, errors, state transitions, compatibility, migration, and integration.
   - Check lifecycle, concurrency, ordering, replay, quotas, atomicity, and idempotency.
   - Check public, process, network, storage, IPC, hosted-execution, and security boundaries.
   - Check unrelated edits, generated files, temporary files, and stale documentation.
   - When the security surface is non-empty, inspect applicable secrets, untrusted inputs, authorization, privilege, network access, storage, and IPC.
   - When the security surface is `none`, verify that classification and record that the security audit was skipped.
   - When a concrete finding needs executable proof:
     1. Add one minimal review probe through the public or system surface.
     2. Base the probe on approved intent, an ADR, a feature, a contract, or verified behavior.
     3. Put the probe in the canonical test location.
     4. Use existing fixtures or local setup.
     5. Record the probe path, command, and expected failure in the finding.
     6. Leave the finding `OPEN`.

### 3. Assemble the result

1. Include the lane, focus, coverage, findings path, finding IDs, review probe paths, and status in the compact result.

## Reporting boundaries

- Don't
  - Restate the implementation.
  - Praise successful work.
  - Create requirements or architectural decisions during review.
