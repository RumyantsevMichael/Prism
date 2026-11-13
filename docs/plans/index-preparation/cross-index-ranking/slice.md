# Ranking a search across indexes

> Shipped history: initiative `index-preparation` shipped on 2026-11-12, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

A search across several indexes ranks with lexical and vector evidence.

## Changes

- add `src/native-runtime/fusion.mts`: `fusionWeights`, the identifier rule and weights that rank one index, shared by the runtime and the merge (§30)
- change `src/native-runtime/worker.mts`: `query` takes its weights from `fusionWeights` (§30)
- change `src/server/repository-intelligence/component-indexes.mts`: `searchComponents` takes the query and merges several answers by the fused ranking of clause 30, keeping containers after the result they follow (§30)
- change `src/server/repository-intelligence/semantic-native-provider.mts`: `searchComponentIndexes` and `ComponentRepositoryIntelligence.semanticSearch` pass the query to `searchComponents`, and the search description in `NATIVE_INTELLIGENCE_TOOLS` says how results of several components are ranked (§30)
- change `test/server/component-search-merge.test.mjs`: its expectations follow the fused ranking instead of similarity alone (§30)
- change `dist/native-runtime/fusion.mjs`, `dist/native-runtime/worker.mjs`, `dist/server/repository-intelligence/component-indexes.mjs`, `dist/server/repository-intelligence/semantic-native-provider.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/repository-intelligence.md`: `Index a repository per component` explains the merged ranking across components (§30)
