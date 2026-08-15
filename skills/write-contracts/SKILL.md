---
name: write-contracts
description: "Create or update an executable boundary contract only when production code, generated code, or verification consumes it."
argument-hint: '[boundary]'
---

# Write an executable contract

Create a contract only when code or verification consumes it.
Do not create a prose contract.
Do not create a second representation of an implementation detail.

Read `.prism/workflow.md`, Approved requirements, relevant ADRs, and the consuming code and tests.

## 1. Prove that a contract is necessary

Use a contract for an externally consumed or compatibility-sensitive boundary.
Valid forms include:

- an OpenAPI document.
- a JSON Schema.
- a protocol or database schema.
- an importable interface or type definition.
- a test double imported by implementation tests.
- a compatibility test that governs an otherwise implicit boundary.

Do not create a separate contract when an existing production type or schema already governs the boundary.

## 2. Put it where consumers use it

Use the project's canonical source, API, schema, or test path.
Follow existing generation and ownership conventions.
Link requirements for obligations and ADRs for consequential decisions when the format supports comments or metadata.

## 3. Bind consumption

Add or update the production import, generator, validator, or compatibility test that consumes the contract.
Run the exact verification command.
Remove the contract when no executable consumer remains.

## Result

Report the contract path, every consumer, and the verification command.
If no executable contract is necessary, return `NO CONTRACT NEEDED` and continue implementation.
