# Coverage of calls into libraries

## Outcome

A file whose unresolved references all point outside the indexed source counts as covered.

## Changes

- add `src/server/repository-intelligence/structural-coverage.mts`: `structuralCoverage` computes `fileCoverage` from `unresolvedByFile`, the index's code units, `syntaxCoverage`, and its diagnostics (§29)
- change `src/server/repository-intelligence/index-store.mts`: `LocalIndexStore.save` replaces an index's `fileCoverage` with `structuralCoverage` when it carries `unresolvedByFile`, before the index and its pointer coverage are written (§29)
- change `src/server/repository-intelligence/repository-unit-types.mts`: `IndexMetadata.unresolvedByFile` (§28)
- change `src/native-runtime/graph.mts`, `src/native-runtime/worker.mts`: `extractGraph` collects every unresolved reference by file with its kind, and `build` reports `unresolvedByFile` (§28)
- add `test/native-runtime/unresolved-by-file.test.mjs`: the runtime-side check that `unresolvedByFile` holds a library call, a package import, and a relative import of a small project, which runs after `npm run stage:native` (§28)
- change `dist/server/repository-intelligence/structural-coverage.mjs`, `dist/server/repository-intelligence/index-store.mjs`, `dist/native-runtime/graph.mjs`, `dist/native-runtime/worker.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/repository-intelligence.md`: `Search for reusable concepts` explains that a call into a library no longer makes a file uncovered, and which unresolved references still do (§29)
