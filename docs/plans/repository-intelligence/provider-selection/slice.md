# Select repository intelligence providers

## Outcome

Prism plans repository context through a native provider and zero or one selected external contributor, with read-only discovery and explicit provenance.

## Requirements

- [Provide a native baseline](../../../requirements/repository-intelligence-providers.md#1)
- [Discover registered providers safely](../../../requirements/repository-intelligence-providers.md#2)
- [Select and compose providers](../../../requirements/repository-intelligence-providers.md#3)
- [Preserve uncertainty](../../../requirements/repository-intelligence-providers.md#4)
- [Use CodeGraph without managing its index](../../../requirements/repository-intelligence-providers.md#5)

## Contract decisions

Contract: `server/repository-intelligence.mjs`
Consumers: all repository intelligence providers and the composite provider
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/native-repository-intelligence.test.mjs server/test/codegraph-provider.test.mjs server/test/composite-repository-intelligence.test.mjs`

Contract: `server/repository-intelligence-providers.mjs`
Consumers: `server/mcp.mjs` and provider discovery tests
Verification: `node --test server/test/repository-intelligence-providers.test.mjs server/test/mcp.test.mjs`

## Invariants

- Native is always present and owns every final source read.
- Discovery probes only registered descriptors and never manages an external index.
- Provider identifiers and availability records are deterministic.
- Automatic selection uses at most one healthy external contributor.
- Explicit external selection never silently substitutes another external provider.
- Automatic external failure retries at most once with native only.
- Rank fusion uses provider result positions and stable tie breakers.
- Missing required evidence prevents a numeric estimate that could support `FIT`.

## Delivery order

1. Implement and test the native provider.
2. Implement and test the CodeGraph adapter.
3. Implement and test provider discovery and composition.
4. Connect discovery and selection to the MCP tools.
5. Update user guidance and workflow prompts.

The code view is [provider-selection.puml](provider-selection.puml).
