# Resolve active session capacity

## Outcome

Prism resolves target capacity from allowlisted facts for the same active host session without asking callers to repeat known identity fields.

## Requirements

- [Capture allowlisted active-session facts](../../../requirements/active-session-capacity.md#1)
- [Resolve same-session capacity](../../../requirements/active-session-capacity.md#2)
- [Reject unproved active-session capacity](../../../requirements/active-session-capacity.md#3)
- [Bound local fact retention](../../../requirements/active-session-capacity.md#4)
- [Resolve supported session capacity](../../../requirements/session-fit.md#1)
- [Reject unsupported capacity combinations](../../../requirements/session-fit.md#2)

## Contract decisions

Contract: `server/host-session-facts.mjs` through `validateHostSessionFacts`
Consumers: host hook recorders, `server/host-session-facts.mjs`, and active-capacity tests
Verification: `node --test server/test/host-session-facts.test.mjs`

Contract: `resolve_session_capacity` MCP tool
Consumers: design and orchestration skills
Verification: `node --test server/test/session-capacity.test.mjs server/test/mcp.test.mjs`

## Invariants

- Session identity is selected as one block and is never mixed across sessions.
- The hook hashes the raw session identifier locally and emits only the SHA-256 correlation key as bounded additional context.
- Active MCP inputs require the correlation key and never use private request metadata.
- The bounded first transcript `session_meta` record supplies correlated Codex version and provider identity.
- Transcript paths and content are never persisted or emitted.
- Stored facts contain only allowlisted identity and capacity fields.
- User configuration is advisory only and never establishes effective active-session capacity.
- Complete explicit overrides take precedence over complete direct same-session facts.
- Partial active override objects are rejected before host facts are read.
- Registry defaults never prove an active threshold when an active override may exist.
- Complete active overrides recover an identity-matched unsupported record only with explicit total-scope attestation.
- A stored `body_after_prefix` scope cannot be contradicted by active input.
- Missing, stale, ambiguous, or insufficient facts return `UNSUPPORTED` with a stable reason code.
- Fact cleanup removes records older than 30 days and evicts by modification time and file name before storage exceeds 16 MiB.
- Fact storage resolves beneath the canonical plugin data directory and rejects symbolic-link directories and records.
- Fact-retention lock owners carry unique tokens and cannot release a successor after stale takeover.
- Hook failures do not block the host action.
- Existing explicit session input remains compatible.

## Delivery order

1. Implement bounded fact normalization and atomic digest-keyed local storage.
2. Add the bounded Codex transcript classifier, host adapter, and hook command.
3. Emit the correlation key through bounded hook additional context.
4. Add conservative active-session resolution to the capacity module.
5. Expose correlation-keyed capacity, fit, and consumption tools through MCP.
6. Update user guidance and workflow prompts.

The code view is [active-session-capacity.puml](active-session-capacity.puml).
