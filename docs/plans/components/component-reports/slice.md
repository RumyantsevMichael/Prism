# Report and plan across component indexes

## Outcome

The structural reports and `plan_repository_context` read the components they select as one union and name the components they left out.

## Changes

- change `src/server/repository-intelligence/component-indexes.mts`: `unionIndex` combines the included components' units, edges, references, coverage, diagnostics, and file contents into one index view, and the component provider's `neighbors` expands the graph within it (§9, §18, §20)
- change `src/server/repository-intelligence/semantic-native-provider.mts`: `preparedAnalysis` and the six report functions read the selected components through `unionIndex`, add `components` and the `components_missing` diagnostic, and `retainResult` records `components`, `snapshot`, and `indexRevision` (§9, §10, §12, §18, §19)
- change `src/server/repository-intelligence/semantic-native-provider.mts`: `prepareNativeProvider` selects every component for a context plan, and the component provider's `search` merges candidates as `searchComponents` does and reports `components_missing` without estimate eligibility while a component is missing (§20)
- change `src/server/conservation/conservation-types.mts`: `AnalysisReceipt` holds `components` (§19)
- change `src/server/mcp.mjs`: the descriptions of the six reports say that `filters.paths` selects the components a report reads, so groups keep members and importers only in those components (§9)
- change `dist/server/repository-intelligence/component-indexes.mjs`, `dist/server/repository-intelligence/semantic-native-provider.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/repository-intelligence.md`: the report sections say that a path scope selects the components a report reads, and `Analysis receipts` names the recorded components (§9, §18, §19)
