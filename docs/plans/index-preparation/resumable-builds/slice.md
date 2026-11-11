# Builds that run until they stall and resume from saved work

## Outcome

A build runs while it makes progress, stops as stalled when it makes none, and a later build reuses every embedding it saved.

## Changes

- add `src/server/repository-intelligence/embedding-store.mts`: `appendEmbeddings`, `readEmbeddings`, and `replaceEmbeddings` over the fixed-size records of `embeddings.bin`, skipping a short final record, an invalid key, and a non-finite value (§2, §11–§13)
- change `src/server/repository-intelligence/index-store.mts`, `src/server/repository-intelligence/index-store-thread.mts`: `LocalIndexStore.build` appends each `vectors` value to the location's embedding store and strips `vectors` before it forwards progress, reads the store into `previousEmbeddings` beside the previous index's embeddings, and `save` rewrites the store to the saved index; `IndexStore.stop` stops the build helper of the thread or of the in-process store (§2–§4, §11–§14)
- change `src/server/repository-intelligence/native-helper.mts`: `Helper.request` applies the 30 minute operation limit to `search` only (§7)
- change `src/server/repository-intelligence/native-semantic-runtime.mts`: `NativeSemanticRuntime` takes `stallMs`, reads `PRISM_INDEX_STALL_MINUTES`, runs a stall watchdog per running job that `report` resets only on progress, and fails a stalled job with the `stalled` failure, diagnostic, and progress record without remembering it as limited (§4, §8–§10)
- change `src/server/repository-intelligence/repository-unit-types.mts`: `Progress.vectors`, `ComponentFailure.phase`, and `Diagnostic.phase` (§2, §10)
- change `src/native-runtime/embeddings.mts`, `src/native-runtime/worker.mts`: `embedFragments` reports each batch's `vectors` with its embedding progress (§2)
- add `test/native-runtime/embedding-progress.test.mjs`: the runtime-side check that each embedding progress value carries the vectors of its batch, which `node --liftoff-only --test test/native-runtime/*.test.mjs` runs after `npm run stage:native` (§2)
- change `src/server/repository-intelligence/semantic-native-provider.mts`: `NATIVE_INTELLIGENCE_TOOLS` descriptions of the search and status tools say that a build has no total time limit, stops as `stalled` after the stall period without progress, and resumes from saved embeddings (§7, §10)
- change `dist/server/repository-intelligence/embedding-store.mjs`, `dist/server/repository-intelligence/index-store.mjs`, `dist/server/repository-intelligence/index-store-thread.mjs`, `dist/server/repository-intelligence/native-helper.mjs`, `dist/server/repository-intelligence/native-semantic-runtime.mjs`, `dist/server/repository-intelligence/semantic-native-provider.mjs`, `dist/native-runtime/embeddings.mjs`, `dist/native-runtime/worker.mjs`: the generated runtime of the changed sources, from `npm run build:native`
- change `docs/user-guide/repository-intelligence.md`: the native limits replace 30 minutes of preparation with the stall period and `PRISM_INDEX_STALL_MINUTES`, and `Search for reusable concepts` explains the `stalled` failure and resuming from saved embeddings (§7, §9, §10, §12)
