# Slice review

Mode: implementation-review
Initiative: repository-intelligence
Slice: session-fit
Lane: implementation-review
Reporting slice: session-fit
Findings: docs/plans/repository-intelligence/session-fit/implementation-review/findings.md
Last updated: 2026-09-19T17:43:21Z
Review wave: session-fit-implementation-final-review-1

The findings file is authoritative for its reporting slice and lane.

## Findings

### F-001: Threshold derivation loses integer precision

- Status: VERIFIED
- Severity: medium
- Source: implementation-review
- Lane: implementation-review
- Reporting slice: session-fit
- Escalation target: session-fit
- First reported: session-fit-implementation-review-1
- Aliases: NONE
- Affected path: `server/session-capacity.mjs:107` and `server/test/session-capacity.test.mjs`
- Evidence: The registry contract permits every positive safe integer for `contextWindowTokens`.
- Evidence: The threshold check multiplies that value by a percentage as a JavaScript `number` before division.
- Evidence: The intermediate product can exceed the safe integer range and change the derived threshold.
- Evidence: A context window of `9007199254740933` at `3` percent has an exact floor of `270215977642227`.
- Evidence: The current calculation returns `270215977642228`, and `validateCapacityRegistry` accepts that incorrect threshold.
- Failure condition: A registry can pass validation when its threshold differs from the documented exact integer derivation.
- Condition to close: Calculate the derived threshold without an unsafe numeric intermediate.
- Condition to close: Add a registry test that rejects the observed off-by-one threshold at the safe-integer boundary.
- Review probe: NONE because the assigned review permits writes only to this findings file.
- Implementer evidence: `server/session-capacity.mjs` now derives the threshold with `BigInt` multiplication and division before converting the safe result to `number`.
- Implementer evidence: `server/test/session-capacity.test.mjs` accepts the exact safe-integer boundary threshold and rejects the previously accepted off-by-one value.
- Status history:
  - session-fit-implementation-review-1: OPEN
  - session-fit-implementation-correction-1: IN PROGRESS.
  - session-fit-implementation-correction-1: FIXED.
  - session-fit-implementation-final-review-1: VERIFIED.
- Review history:
  - session-fit-implementation-review-1: OPEN. A read-only Node probe showed that the validator accepts the incorrect threshold.
  - session-fit-implementation-resolution-1: FIXED candidate reviewed. BigInt removes the unsafe intermediate, and the boundary regression accepts the exact floor and rejects the old value.
  - session-fit-implementation-resolution-1: The focused capacity suite passes 16 of 16 tests, and the candidate is ready for fresh final review.
  - session-fit-implementation-final-review-1: VERIFIED. Independent inspection and execution confirm exact BigInt derivation and rejection of the former off-by-one threshold.

## Result

Lane: implementation-review
Reporting slice: session-fit
Review focus: Exact tuple matching, registry validation, capacity arithmetic, unsupported and null behavior, override precedence, integer overflow, provenance, MCP trust, traceability, and stale guidance.
Coverage: The session capacity registry, resolver, fit evaluator, public MCP tool, focused tests, workflow contracts, skills, user guide, requirements, ADR, feature, diagram, and design audit.
Findings: docs/plans/repository-intelligence/session-fit/implementation-review/findings.md
Finding IDs: F-001
ADRs: docs/ADRs/repository-intelligence/provider-independent-context-planning.md
Executable tests: server/test/session-capacity.test.mjs, server/test/mcp.test.mjs, and server/test/workflow-contract.test.mjs
Review probes: NONE because the assigned review permits writes only to this findings file.
Feature files: docs/Features/F-session-fit.feature
Other artifacts: docs/requirements/session-fit.md, docs/plans/repository-intelligence/session-fit/slice.md, and docs/plans/repository-intelligence/session-fit/session-fit.puml
Contracts: `server/session-capacity-registry.json` is consumed by `server/session-capacity.mjs` and verified by `node --test server/test/session-capacity.test.mjs`.
Diagrams: docs/plans/repository-intelligence/session-fit/session-fit.puml
Red checkpoint: NONE
Verification: `node --test server/test/session-capacity.test.mjs` passes 16 of 16 tests.
Verification: The resolution exchange reran `node --test server/test/session-capacity.test.mjs` after the correction and passed 16 of 16 tests.
Verification: The fresh final review reran `node --test server/test/session-capacity.test.mjs` and passed 16 of 16 tests.
Verification: An independent boundary command accepted `270215977642227` and rejected `270215977642228` for a safe-integer context window at 3 percent.
Verification: The focused MCP command passes 3 of 3 matching tests.
Verification: The fresh final review reran the focused MCP command and passed 3 of 3 matching tests.
Verification: The fresh final review ran the repository-context workflow contract test and passed 1 of 1 matching tests.
Verification: The supplied full `npm test` evidence passes 117 of 117 tests outside the sandbox.
Verification: The supplied `npm run validate:sdm` evidence passes with no warnings.
Verification: The fresh final review reran `npm run validate:sdm` and passed with no warnings.
Verification: The supplied `claude plugin validate . --strict` evidence passes.
Verification: The fresh final review reran `claude plugin validate . --strict` and passed.
Verification: The supplied benchmark selfcheck passes every oracle outside the sandbox.
Verification: The supplied `git diff --check` and Node syntax evidence passes.
Verification: `codex debug models --bundled` matches all seven registered models at 272000 tokens and 95 percent for Codex CLI 0.147.0.
Security: The public tool is read-only and validates untrusted nested input before arithmetic.
Security: No file, network, secret, authorization, privilege, storage, or IPC operation is added by session-fit behavior.
Status: CLEAN
