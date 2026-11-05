# Index retained baselines per component

## Outcome

A retained baseline is indexed per component, reusing equal live indexes, and its analysis is the union of its components.

## Changes

- change `src/server/conservation/conservation-store.mts`: `source` gives the retained files' content fingerprint per component the same way the live scan does, so `componentSources` can split a baseline (§3, §22)
- change `src/server/conservation/conservation-analysis.mts`: `prepareAnalysis` prepares every component of the baseline, answers `preparing` while one waits or prepares, and `retainAnalysis` retains the union with a failed component's files uncovered and the `components_missing` diagnostic (§24)
- change `src/server/repository-intelligence/semantic-native-provider.mts`: a call with `snapshotId` splits the baseline into components, and `searchRepositoryConcepts` retains the analysis only when every component of the baseline is selected and included (§22, §23)
- change `dist/server/conservation/conservation-store.mjs`, `dist/server/conservation/conservation-analysis.mjs`, `dist/server/repository-intelligence/semantic-native-provider.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/artifact-conservation.md`: a baseline in a repository with components is indexed per component, reuses unchanged components' indexes, and records a failed component's files as not covered (§22, §24)
