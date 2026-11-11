# Scoped calls ahead of unrelated builds

## Outcome

A call that needs a missing component pauses an unrelated build, and a waiting component names what it waits behind.

## Changes

- change `src/server/repository-intelligence/native-semantic-runtime.mts`: `enqueue` pauses the running job when a needed component has no stored index and is not the running one, `pause` stops the build through the store, records no failure, and queues the job after the needed ones, a run that ends because of its pause leaves the job waiting, and `status`, `componentStatus`, and `prepareComponents` give `waitingFor` (§20, §21)
- change `src/server/repository-intelligence/index-progress.mts`: `lockHolder` reads the preparation id of another session's live progress record in a storage directory (§21)
- change `src/server/repository-intelligence/repository-unit-types.mts`: `ComponentState.waitingFor` and `Preparation.waitingFor` (§21)
- change `src/server/repository-intelligence/component-indexes.mts`: `componentStates` copies `waitingFor` onto waiting entries (§21)
- change `test/server/component-index-preparation.test.mjs`: its clause 5 test expects a call that needs the root component, which has no index, to pause the running net build instead of waiting behind it (§20)
- change `src/server/repository-intelligence/semantic-native-provider.mts`: the `NATIVE_INTELLIGENCE_TOOLS` status and search descriptions explain pausing and `waitingFor` (§20, §21)
- change `dist/server/repository-intelligence/native-semantic-runtime.mjs`, `dist/server/repository-intelligence/index-progress.mjs`, `dist/server/repository-intelligence/component-indexes.mjs`, `dist/server/repository-intelligence/semantic-native-provider.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/repository-intelligence.md`: `Index a repository per component` replaces "the running build always finishes" with pausing for a component without an index, and explains `waitingFor` (§20, §21)
