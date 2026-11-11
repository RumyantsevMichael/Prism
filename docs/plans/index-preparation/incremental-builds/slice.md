# Rebuild only what changed

## Outcome

A rebuild copies, parses, and fragments only the changed files.

## Changes

- add `src/server/repository-intelligence/index-mirror.mts`: `updateMirror` reads `mirror.json`, copies the changed snapshot files, removes the missing ones, empties the mirror and `runtime-state` when the manifest cannot be trusted, and returns `changedFiles` and `removedFiles`, and `markIndexed` records `indexed` (§22, §23)
- change `src/server/repository-intelligence/native-semantic-runtime.mts`: `build` uses the kept mirror through `updateMirror` instead of a fresh `snapshot-` folder, passes the change lists, and calls `markIndexed` when structure or the index arrives; `pruneIndexes` keeps `mirror`, `mirror.json`, and `runtime-state` (§6, §22, §23)
- change `src/server/repository-intelligence/repository-unit-types.mts`: `BuildArguments.changedFiles` and `BuildArguments.removedFiles` (§6)
- change `src/native-runtime/graph.mts`: `extractGraph` opens the kept code graph and syncs only the named paths when it has change lists and a usable database, and indexes in full otherwise (§24)
- change `src/native-runtime/worker.mts`, `src/native-runtime/units.mts`, `src/native-runtime/fragments.mts`: `build` reuses the text units, token counts, and fragments of unchanged files from `runtime-state` keyed by file hash and chunker version, and writes the state of the files it derived (§24)
- add `test/native-runtime/incremental-build.test.mjs`: the runtime-side check that an incremental build after adding, changing, and removing files returns the same index as a full build of the same files, which runs after `npm run stage:native` (§24)
- change `dist/server/repository-intelligence/index-mirror.mjs`, `dist/server/repository-intelligence/native-semantic-runtime.mjs`, `dist/native-runtime/graph.mjs`, `dist/native-runtime/worker.mjs`, `dist/native-runtime/units.mjs`, `dist/native-runtime/fragments.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/repository-intelligence.md`: `Search for reusable concepts` explains that each index keeps a private mirror and that a rebuild copies and parses only changed files, and the disk space it takes (§22–§24)
