# Search across component indexes

## Outcome

`search_repository_concepts` answers path-scoped queries from the matching components and merges unscoped ones across prepared components, naming those it left out.

## Changes

- change `src/server/repository-intelligence/component-indexes.mts`: `searchComponents` searches each included component with the call's filters and limit, keeps one component's order, merges several by `cosineSimilarity` with ties in component order and index order, renumbers `fusedRank`, and adds `component` to each result (§14, §15, §16)
- change `src/server/repository-intelligence/semantic-native-provider.mts`: `searchRepositoryConcepts` uses `searchComponents`, falls back to lexical results over the selected components' files when none is included and none is waiting or preparing, and records `components`, `snapshot`, and `indexRevision` in its receipt (§12, §14, §17, §19)
- change `src/server/conservation/conservation-types.mts`: `SearchReceipt` holds `components` (§19)
- change `dist/server/repository-intelligence/component-indexes.mjs`, `dist/server/repository-intelligence/semantic-native-provider.mjs`: the generated runtime of the changed sources
- change `skills/refactor/references/analysis.md`: a discovery result with `status` `partial` names the components it left out in `components_missing`, which the analysis reports as uncovered or waits for (§11, §12)
- change `docs/user-guide/repository-intelligence.md`: `Search for reusable concepts` explains how results from several components are merged and ranked and that each result names its component (§14, §15, §16, §17)
