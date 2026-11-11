# Structure before embeddings

## Outcome

Structural callers answer from a published structure while embeddings fill, and concept search answers lexically and says so.

## Changes

- change `src/server/repository-intelligence/index-store.mts`, `src/server/repository-intelligence/index-store-thread.mts`: `LocalIndexStore.build` takes a structure callback that receives the `structure` progress value's index, which it never forwards as progress, and a `saveStructure` operation writes a structure-only index with its units sidecar (§1, §3, §15)
- change `src/server/repository-intelligence/index-files.mts`: `writeIndex` writes an index whose fragments carry no embedding (§15)
- change `src/server/repository-intelligence/native-semantic-runtime.mts`: `build` stores the structure stage and writes the pointers with `stage`, `Job` and `Preparation` carry the published `structure`, a stored structure-only generation loads as structure without ending the job, and `status` and `componentStatus` give `stage` (§15–§17)
- change `src/server/repository-intelligence/repository-unit-types.mts`: `PreparedIndex.stage`, `Preparation.structure`, `ComponentState.embeddings`, and `SearchArguments.mode` (§5, §15, §18)
- change `src/server/repository-intelligence/component-indexes.mts`: `componentStates` includes a component whose structure is published and marks it `embeddings: "pending"` for a search, and `componentResult` keeps that mark (§16, §18)
- change `src/server/repository-intelligence/semantic-native-provider.mts`: `preparedAnalysis` and `componentAnalysis` read the published structure, `searchRepositoryConcepts` and `searchComponentIndexes` search a structure-only index with `mode: "lexical"` and add the `embeddings_pending` diagnostic and capabilities, and `prepareNativeProvider` for a context plan keeps waiting for a complete index (§16, §18, §19)
- change `src/server/conservation/conservation-analysis.mts`: `prepareAnalysis` and `prepareComponentAnalysis` retain an analysis from a published structure (§16)
- change `src/server/repository-intelligence/index-status.mts`: `readPublishedUnits` and `readIndexingStatus` read a pointer with `stage` and report it (§16, §17)
- change `src/native-runtime/worker.mts`: `build` reports `structure` after planning fragments, and `query` answers `mode: "lexical"` from fragment text, building its database without vectors for an index without embeddings (§1, §5)
- add `test/native-runtime/structure-stage.test.mjs`: the runtime-side checks of the `structure` report and of a lexical search of an index without embeddings, which run after `npm run stage:native` (§1, §5)
- change `src/server/repository-intelligence/semantic-native-provider.mts`: the `NATIVE_INTELLIGENCE_TOOLS` descriptions of the structural reports, the search, and the status tools explain answers from structure, `stage`, `embeddings_pending`, and `embeddings` (§16–§18)
- change `dist/server/repository-intelligence/index-store.mjs`, `dist/server/repository-intelligence/index-store-thread.mjs`, `dist/server/repository-intelligence/index-files.mjs`, `dist/server/repository-intelligence/native-semantic-runtime.mjs`, `dist/server/repository-intelligence/component-indexes.mjs`, `dist/server/repository-intelligence/semantic-native-provider.mjs`, `dist/server/conservation/conservation-analysis.mjs`, `dist/server/repository-intelligence/index-status.mjs`, `dist/native-runtime/worker.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/repository-intelligence.md`: `Search for reusable concepts` and the report sections explain that structure answers first, the `stage` field, lexical answers while embeddings fill with `embeddings_pending`, and that a context plan still waits (§15–§19)
