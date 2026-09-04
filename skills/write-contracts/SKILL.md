---
name: write-contracts
description: "Create or update an executable boundary contract only when production code, generated code, or verification consumes it."
argument-hint: '[boundary]'
sdm: "0.3"
---

# Write an executable contract

An [executable contract](../workflow/SKILL.md#common-terms) must have a consumer in production code, generated code, or verification.
The contract must govern an externally consumed or compatibility-sensitive boundary.
The contract must not be prose or a second representation of an implementation detail.

## 1. Prepare

1. If `.prism/workflow.md` exists, read it first.
2. If `.prism/workflow.md` is absent, use the default behavior in this skill and applicable project instructions.
3. Read the applicable Approved requirements.
4. Read the relevant ADRs.
5. Read the intended consuming code and tests.

## 2. Prove that a contract is necessary

The following artifacts are valid contract forms.

| Form | Valid artifact |
| --- | --- |
| API | An OpenAPI document |
| Data | A JSON Schema |
| Protocol or database | A protocol or database schema |
| Code | An importable interface or type definition |
| Test | A test double imported by implementation tests |
| Compatibility | A compatibility test that governs an otherwise implicit boundary |

When an existing production type or schema governs the boundary, a separate contract must not duplicate it.

## 3. Put it where consumers use it

The contract must use the project's canonical source, API, schema, or test path.
The final contract must not use a slice directory.

- Follow existing generation and ownership conventions.
- When the format supports comments or metadata, link requirements for obligations.
- When the format supports comments or metadata, link ADRs for consequential decisions.

## 4. Bind consumption

1. When no executable consumer remains:
   1. Remove the contract.
2. Otherwise:
   1. Add or update the production import, generator, validator, or compatibility test that consumes the contract.
3. Run the exact verification command.

- Don't
  - Add production behavior only to create a contract.

## 5. Result

- For an executable contract, report exactly this block.

```text
Contract: <canonical path>
Consumers: <production code or verification>
Verification: <exact command>
```

- When no executable contract is necessary, report exactly this block.

```text
Contract: NO CONTRACT NEEDED
Reason: <specific reason>
```

- Return to the calling phase after the result.
