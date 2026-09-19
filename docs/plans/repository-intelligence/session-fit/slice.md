# Evaluate repository context fit

## Outcome

Prism resolves supported target-session capacity and classifies a complete repository context estimate through one read-only public tool.

## Requirements

- [Resolve supported session capacity](../../../requirements/session-fit.md#1)
- [Reject unsupported capacity combinations](../../../requirements/session-fit.md#2)
- [Classify repository context fit](../../../requirements/session-fit.md#3)
- [Accept an adjustable implementation reserve](../../../requirements/session-fit.md#4)

## Contract decision

Contract: `server/session-capacity-registry.json`
Consumers: `server/session-capacity.mjs` and `server/test/session-capacity.test.mjs`
Verification: `node --test server/test/session-capacity.test.mjs`

## Registry invariants

- The schema version equals `1`.
- Every profile identifier is unique.
- Every match contains one nonempty harness, harness version, provider, and model list.
- A model alias resolves to one canonical model in the same profile.
- No alias shadows a canonical model.
- One session tuple matches at most one profile.
- Capacity values are positive safe integers, except the implementation reserve can be zero.
- The usable-context percentage and automatic-compaction percentage are separate registry fields.
- The default compaction threshold equals 90 percent of the raw context window, not the 95 percent usable input window, and does not exceed the context window.
- Production code validates the complete registry before it resolves a session.

## Public input invariants

- Session identity fields are nonempty strings and contain no unknown properties.
- Capacity overrides are positive safe integers and contain no unknown properties.
- Session costs are nonnegative safe integers and contain no unknown properties.
- Token estimates contain only `lower`, `expected`, and `upper`.
- Token estimates are either all `null` or ordered nonnegative safe integers.
- Invalid input returns an MCP error and never returns a fit classification.

## Result provenance

- Every effective value has one provenance object under `contextWindow`, `compactionThreshold`, or `implementationReserve`.
- Registry provenance contains `source`, `profileId`, `registrySource`, `sourceVersion`, `verifiedAt`, and `field`.
- Compaction-threshold registry provenance also contains `derivation`.
- Explicit provenance contains `source: explicit-input` and the exact `input` field path.
- A context-window override does not change a registered compaction threshold unless the caller also overrides the threshold.
