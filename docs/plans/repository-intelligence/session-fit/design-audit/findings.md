# Slice review

Mode: design-audit
Initiative: repository-intelligence
Slice: session-fit
Lane: design-audit
Reporting slice: session-fit
Findings: docs/plans/repository-intelligence/session-fit/design-audit/findings.md
Last updated: 2026-09-19T17:23:56Z
Review wave: session-fit-design-rereview-3

The findings file is authoritative for its reporting slice and lane.

## Findings

### F-001: The registry contract lacks validation and a contract decision

- Status: VERIFIED
- Severity: high
- Source: design-audit
- Lane: design-audit
- Reporting slice: session-fit
- Escalation target: session-fit
- First reported: session-fit-design-audit-1
- Aliases: NONE
- Affected path: `docs/plans/repository-intelligence/session-fit/slice.md`, `server/session-capacity-registry.json`, and `server/test/session-capacity.test.mjs`
- Evidence: The slice has no contract decision for the executable registry.
- Evidence: The registry duplicates a percentage, a derived threshold, and derivation text without defined consistency checks.
- Evidence: The tests do not prove that production code consumes this registry.
- Evidence: The tests do not reject unsupported schema versions, duplicate matches, invalid aliases, or inconsistent capacity facts.
- Failure condition: Invalid or ambiguous bundled data can produce a supported result without a deterministic contract failure.
- Condition to close: Declare the registry contract, its consumers, and its exact verification command in the slice.
- Condition to close: Define registry field rules and deterministic rejection for malformed, ambiguous, or inconsistent data.
- Condition to close: Add red tests that consume the canonical registry and cover its validation rules.
- Review probe: NONE
- Implementer evidence: The slice declares the registry contract, field invariants, consumers, and verification command.
- Implementer evidence: Red tests consume the canonical registry and reject unsupported schema versions, duplicate tuple matches, invalid aliases, and inconsistent thresholds.
- Status history:
  - session-fit-design-audit-1: OPEN
  - session-fit-design-correction-1: IN PROGRESS
  - session-fit-design-correction-1: FIXED
  - session-fit-design-rereview-1: VERIFIED
- Review history:
  - session-fit-design-audit-1: OPEN. The executable registry has no declared or verified contract.
  - session-fit-design-correction-1: FIXED. The contract decision and red validation coverage now define deterministic registry rejection.
  - session-fit-design-rereview-1: VERIFIED. The slice declares the canonical registry, production and test consumers, exact verification command, invariants, and red validation cases for malformed or ambiguous data.

### F-002: Exact version matching is not verified

- Status: VERIFIED
- Severity: high
- Source: design-audit
- Lane: design-audit
- Reporting slice: session-fit
- Escalation target: session-fit
- First reported: session-fit-design-audit-1
- Aliases: NONE
- Affected path: `server/session-capacity-registry.json` and `server/test/session-capacity.test.mjs`
- Evidence: The supported test uses the registered tuple, and the unsupported test changes only the model.
- Evidence: No test rejects a mismatched harness, harness version, or provider.
- Evidence: The registry defines a model alias, but no test defines its canonicalization or profile boundary.
- Failure condition: An implementation can ignore the harness version or another match dimension and still pass the red tests.
- Condition to close: Add red tests that reject each mismatched tuple dimension without complete explicit capacity.
- Condition to close: Define and test alias resolution only inside an otherwise exact profile match.
- Condition to close: Reject ambiguous matches instead of selecting an entry by registry order.
- Review probe: NONE
- Implementer evidence: Red tests reject mismatched harnesses, harness versions, providers, and models and constrain aliases to exact profiles.
- Implementer evidence: Registry validation rejects ambiguous tuple matches.
- Status history:
  - session-fit-design-audit-1: OPEN
  - session-fit-design-correction-1: IN PROGRESS
  - session-fit-design-correction-1: FIXED
  - session-fit-design-rereview-1: VERIFIED
- Review history:
  - session-fit-design-audit-1: OPEN. Requirement 2 lacks exact tuple verification.
  - session-fit-design-correction-1: FIXED. Exact tuple dimensions, alias scope, and ambiguous matches now have red coverage.
  - session-fit-design-rereview-1: VERIFIED. Red tests reject each mismatched tuple dimension, limit aliases to exact profiles, and reject duplicate tuple matches.

### F-003: The public input contract can classify malformed values

- Status: VERIFIED
- Severity: high
- Source: design-audit
- Lane: design-audit
- Reporting slice: session-fit
- Escalation target: session-fit
- First reported: session-fit-design-audit-1
- Aliases: NONE
- Affected path: `docs/plans/repository-intelligence/session-fit/slice.md`, `server/test/session-capacity.test.mjs`, and `server/test/mcp.test.mjs`
- Evidence: The tests reject one excessive threshold and one negative reserve only.
- Evidence: They do not define positive safe integers for capacity or nonnegative safe integers for costs and estimates.
- Evidence: They do not reject unordered estimate bounds, mixed null bounds, missing costs, fractions, or unknown nested properties.
- Evidence: The MCP schema test checks only the session object's `additionalProperties` rule.
- Failure condition: Untrusted MCP input can produce arithmetic with invalid numbers or an incorrect fit classification.
- Condition to close: Define the complete nested input schema and arithmetic invariants in the slice.
- Condition to close: Add unit tests for malformed capacity, costs, estimate bounds, and equality boundaries.
- Condition to close: Add a public MCP rejection test that proves invalid input cannot reach fit classification.
- Review probe: NONE
- Implementer evidence: The slice defines safe-integer, unknown-property, completeness, and estimate-order invariants.
- Implementer evidence: Unit tests cover malformed nested inputs and equality boundaries, and the MCP test rejects a negative reserve without a result.
- Status history:
  - session-fit-design-audit-1: OPEN
  - session-fit-design-correction-1: IN PROGRESS
  - session-fit-design-correction-1: FIXED
  - session-fit-design-rereview-1: VERIFIED
- Review history:
  - session-fit-design-audit-1: OPEN. The read-only public boundary still accepts safety-critical arithmetic inputs.
  - session-fit-design-correction-1: FIXED. The planned public contract now rejects malformed arithmetic and unknown nested properties before classification.
  - session-fit-design-rereview-1: VERIFIED. The slice defines the nested numeric invariants, unit tests cover malformed inputs and equality boundaries, and the MCP test requires rejection without a result.

### F-004: Capacity provenance is not inspectable enough

- Status: VERIFIED
- Severity: medium
- Source: design-audit
- Lane: design-audit
- Reporting slice: session-fit
- Escalation target: session-fit
- First reported: session-fit-design-audit-1
- Aliases: NONE
- Affected path: `server/session-capacity-registry.json` and `server/test/session-capacity.test.mjs`
- Evidence: The tests assert only `registry` source labels for the context window and compaction threshold.
- Evidence: They do not require the profile identifier, source version, verification date, or threshold derivation in the result.
- Evidence: They do not require provenance for the registry reserve or for mixed registry and explicit values.
- Failure condition: A caller cannot inspect which registry fact or override produced every effective value.
- Condition to close: Define per-value provenance for the context window, threshold, and implementation reserve.
- Condition to close: Preserve the profile and registry source metadata for each registry-derived value.
- Condition to close: Add tests for registry, explicit, and mixed provenance results.
- Review probe: NONE
- Implementer evidence: Red tests require profile identifiers, registry source metadata, verification dates, derivations, and per-value explicit or registry provenance.
- Implementer evidence: The slice now defines complete registry, explicit, and derived provenance result fields.
- Implementer evidence: The registry records Codex capacity facts separately from the Prism implementation-reserve policy.
- Implementer evidence: Red tests require complete metadata for the context window, compaction threshold, implementation reserve, and mixed override results.
- Implementer evidence: The slice now limits the first release to registry and explicit provenance and defines that a context-window override does not derive a new threshold.
- Implementer evidence: The mixed-provenance test requires the complete registry context-window object and complete explicit threshold and reserve objects.
- Evidence: The slice still defines no result-provenance fields or required metadata for each source class.
- Evidence: The corrected registry test requires complete source metadata only for `provenance.contextWindow`.
- Evidence: The threshold assertions require only `profileId` and `derivation`, and the reserve assertion requires only `profileId`.
- Evidence: The mixed-provenance test requires only the source class for each value.
- Failure condition: An implementation can omit registry source, source version, verification date, or source class from threshold and reserve provenance while all corrected tests pass.
- Evidence: The mixed-provenance test checks only `registrySource` for its registry-derived context window.
- Evidence: The slice declares a derived provenance shape, but no test defines its trigger or asserts its complete result.
- Failure condition: The evaluator can omit required registry metadata in mixed results or never implement the declared derived result while all red tests pass.
- Condition to close: Assert the complete registry provenance object in the mixed result.
- Condition to close: Define when derived provenance applies and add one exact derived-provenance result assertion.
- Status history:
  - session-fit-design-audit-1: OPEN
  - session-fit-design-correction-1: IN PROGRESS
  - session-fit-design-correction-1: FIXED
  - session-fit-design-rereview-1: REOPENED
  - session-fit-design-correction-2: IN PROGRESS
  - session-fit-design-correction-2: FIXED
  - session-fit-design-rereview-2: REOPENED
  - session-fit-design-correction-3: IN PROGRESS
  - session-fit-design-correction-3: FIXED
  - session-fit-design-rereview-3: VERIFIED
- Review history:
  - session-fit-design-audit-1: OPEN. The planned result can identify a source class without the supporting capacity fact.
  - session-fit-design-correction-1: FIXED. Per-value provenance now covers registry, explicit, and mixed results.
  - session-fit-design-rereview-1: REOPENED. The tests do not require complete registry metadata for the threshold and reserve values.
  - session-fit-design-correction-2: FIXED. The result contract and red tests now require complete per-value provenance for registry and explicit sources.
  - session-fit-design-rereview-2: REOPENED. The mixed assertion is still partial, and the declared derived provenance has no executable case.
  - session-fit-design-correction-3: FIXED. The unused derived source class was removed and mixed provenance now has exact per-value assertions.
  - session-fit-design-rereview-3: VERIFIED. The mixed test asserts complete registry and explicit provenance objects, and the design defines no unused derived provenance source class.

## Result

Lane: design-audit
Reporting slice: session-fit
Review focus: Registry contract, exact matching, provenance, override validation, security boundaries, and public MCP acceptance.
Coverage: Requirements 1 through 4, the governing ADR, feature scenarios, diagram, registry, unit tests, and MCP tests.
Findings: docs/plans/repository-intelligence/session-fit/design-audit/findings.md
Finding IDs: F-001, F-002, F-003, F-004
ADRs: docs/ADRs/repository-intelligence/provider-independent-context-planning.md
Executable tests: server/test/session-capacity.test.mjs and server/test/mcp.test.mjs
Review probes: NONE
Feature files: docs/Features/F-session-fit.feature
Other artifacts: docs/plans/repository-intelligence/session-fit/slice.md and docs/plans/repository-intelligence/session-fit/session-fit.puml
Contracts: `server/session-capacity-registry.json` is consumed by `server/session-capacity.mjs` and verified by `node --test server/test/session-capacity.test.mjs`.
Diagrams: docs/plans/repository-intelligence/session-fit/session-fit.puml
Red checkpoint: `node --test server/test/session-capacity.test.mjs` exits 1 because registry validation, capacity resolution, and fit evaluation are unimplemented.
Verification: `node --test --test-name-pattern='declares the project root|evaluates repository fit|rejects invalid repository fit input' server/test/mcp.test.mjs` exits 1 because the public tool is absent.
Verification: `codex --version` reports `codex-cli 0.147.0`, and the bundled model catalog confirms the registered models use a 272000-token window with a 95-percent effective limit.
Verification: The mixed-provenance test uses exact object equality for registry context-window provenance and explicit threshold and reserve provenance.
Verification: The result contract defines only registry and explicit provenance source classes, while threshold derivation remains registry metadata.
Verification: F-001 through F-003 remain verified against the current contract, exact-match tests, input invariants, and public rejection tests.
Security: The planned tool is read-only and performs no file, network, secret, authorization, or IPC operations.
Security: Its untrusted numeric MCP input requires the validation in F-003.
Status: CLEAN
