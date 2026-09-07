---
name: write-contracts
description: "Create or update an executable boundary contract only when production code, generated code, or verification consumes it."
argument-hint: '[boundary]'
sdm: "0.3"
---

# Write an executable contract

An [executable contract](../workflow/SKILL.md#common-terms) governs an externally consumed or compatibility-sensitive boundary through code or verification.
Valid forms include schemas, importable types, consumed test doubles, and compatibility tests.
Prose and duplicate representations of implementation details are not contracts.

## 1. Select the contract

1. If `.prism/workflow.md` exists, read it first.
2. Read applicable Approved requirements, ADRs, and the boundary's consuming code and tests.
3. Check existing and required production, generation, and verification consumers.
4. If no consumer needs the contract:
   1. Remove any obsolete contract.
   2. After removal, run affected verification.
   3. Return through [Return the decision](#3-return-the-decision).
5. Otherwise:
   1. Reuse an existing governing type or schema.
   2. When none exists, select the canonical source, API, schema, or test path using existing ownership and generation conventions.

Final contracts do not belong in slice folders.

## 2. Bind and verify

1. Create or update the selected contract only after atomic fit.
2. When the format permits, link requirements for obligations and ADRs for decisions.
3. Bind the contract through an import, generator, validator, or compatibility test.
4. Run the exact verification command.

Production behavior must not be added merely to create a contract.
An expected behavioral failure can remain at the design red checkpoint, but the contract must have an executable consumer.

## 3. Return the decision

1. If verification exposes contract or setup defects, return `BLOCKED` with the cause, command, and evidence to the caller.
   - Stop this skill.
2. Return the applicable block unchanged:

   ```text
   Contract: <canonical path>
   Consumers: <production, generation, or verification paths>
   Verification: <exact command>
   ```

   ```text
   Contract: NO CONTRACT NEEDED
   Reason: <specific reason>
   ```
3. After the block, report verification results and any removed path.
4. Return to the calling phase.
