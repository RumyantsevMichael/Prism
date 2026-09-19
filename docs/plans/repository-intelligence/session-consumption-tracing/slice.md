# Trace pre-edit session consumption

## Outcome

Prism records privacy-bounded local events and summarizes repository context consumed before the first confirmed successful edit.

## Requirements

- [Record allowlisted session events](../../../requirements/session-consumption-tracing.md#1)
- [Identify the first successful edit](../../../requirements/session-consumption-tracing.md#2)
- [Summarize pre-edit repository consumption](../../../requirements/session-consumption-tracing.md#3)
- [Isolate and limit traces](../../../requirements/session-consumption-tracing.md#4)
- [Isolate root execution observations](../../../requirements/session-consumption-tracing.md#5)
- [Bound aggregate trace retention](../../../requirements/session-consumption-tracing.md#6)
- [Mark approximate rendered-token observations](../../../requirements/session-consumption-tracing.md#7)
- [Resolve traces by session correlation key](../../../requirements/session-consumption-tracing.md#8)
- [Prove host behavior and stable project identity](../../../requirements/session-consumption-tracing.md#9)
- [Order observations by occurrence](../../../requirements/session-consumption-tracing.md#10)
- [Protect trace storage authority](../../../requirements/session-consumption-tracing.md#11)

## Contract decisions

Contract: `validateSessionTraceEvent` in `server/session-trace.mjs`
Consumers: hook recorders, `server/session-trace-store.mjs`, and trace tests
Verification: `node --test server/test/session-trace.test.mjs server/test/session-instrumentation.test.mjs`

Contract: `summarize_session_consumption` MCP tool
Consumers: later calibration and repository intelligence evaluation
Verification: `node --test server/test/mcp.test.mjs`

Contract: `server/session-trace-behavior-registry.json`
Consumers: Codex hook normalization and rendered-token observation
Verification: `node --test server/test/session-trace-behavior.test.mjs server/test/session-instrumentation.test.mjs`

## Invariants

- Collection remains local and requires enabled host hooks.
- Stored events never contain prompts, source, command text, model output, credentials, or transcripts.
- Duplicate event identifiers are idempotent.
- Host event phases remain distinct when they share one host tool identifier.
- A failed mutation attempt does not create `first_edit`.
- A confirmed successful mutation creates `first_edit` at most once.
- A Codex edit closes the pre-edit window only when a root-correlated exact registry profile proves the `PostToolUse` lifecycle for the exact `apply_patch` tool name.
- The initial registry supports only Codex `0.147.0` and `0.155.0-alpha.9.2` with provider `openai` and records tagged upstream source provenance.
- Unknown Codex versions and unknown hosts cannot prove a successful edit through response fields.
- Codex subagent action details never enter the root execution trace.
- Codex compatibility path variables do not override a correlated Codex transcript.
- Codex-specific markers without a root-correlated transcript fail closed.
- Claude uses canonical `CLAUDE_PROJECT_DIR`, and Codex uses the canonical correlated transcript project root.
- Failed root canonicalization produces no hashed trace identity.
- Exact tool allowlists replace suffix matching, and available edit paths resolve beneath the canonical project.
- Approximate Codex response counts accept only documented bounded strings, retain only the numeric result, and reduce coverage.
- Object and oversized response shapes produce a missing-token coverage gap without serialization.
- Event time with stable tie breakers determines the persisted order and first-edit boundary.
- A dependent approximate or unproved observation is skipped when its required coverage gap cannot be stored first.
- Overlapping source ranges are deduplicated before token totals are reported.
- Unsupported observation paths reduce coverage instead of producing a false exact zero.
- Malformed or oversized events do not block the host action.
- Trace cleanup removes expired traces and stale owned temporary files, counts active owned temporary files, and deterministically evicts the oldest eligible trace under the aggregate byte quota.
- Trace directories and records reject symbolic links and multiply linked files with no-follow opens where available.
- Trace cleanup and commit use token-owned locks that reclaim only confirmed dead owners and fence a writer that loses ownership.
- MCP reads match the validated session correlation key and canonical project identity.

## Delivery order

1. Implement the canonical JavaScript event validator and bounded authority-safe local store.
2. Implement deterministic chronological pre-edit summary derivation.
3. Add host-hook normalization with stable roots and the exact trace behavior registry.
4. Expose the read-only summary through MCP.
5. Update user guidance without presenting traces as calibrated predictions.

The code view is [session-consumption-tracing.puml](session-consumption-tracing.puml).
