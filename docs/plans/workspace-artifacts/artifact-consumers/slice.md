# Prism's own artifacts in the store

## Changes
- change `src/server/workflow/record-store.mjs`, `dist/server/workflow/record-store.mjs`: `readArtifactText` and `writeArtifactText`, which read and write a slice folder's files through `resolveArtifactFile`, writing a generated view in the scope that holds its folder (§22).
- change `src/server/workflow/initiative.mjs`, `dist/server/workflow/initiative.mjs`: reads `slice.md` for the Changes check, unfrozen split evidence, and design text through the store, refuses frozen tests that are artifact paths with `frozen_test_in_store`, and writes `initiative.md` there (§19, §22).
- change `src/server/workflow/slice-design.mjs`, `dist/server/workflow/slice-design.mjs`: `measureContract` measures `slice.md` from the store (§22).
- change `src/server/workflow/diagram-check.mjs`, `dist/server/workflow/diagram-check.mjs`: lists and parses PlantUML files of a slice folder in the store (§22).
- change `src/server/workflow/design-view.mjs`, `dist/server/workflow/design-view.mjs`: reads `slice.md` from the store (§22).
- change `src/server/workflow/state.mjs`, `dist/server/workflow/state.mjs`: `checkpointPause` writes `recovery.md` in the store (§22).
- change `src/server/workflow/projection.mjs`, `dist/server/workflow/projection.mjs`, `src/server/workflow/roadmap.mjs`, `dist/server/workflow/roadmap.mjs`: generated views are written through the artifact resolver (§22).
- change `src/server/review/review-ledger.mts`, `dist/server/review/review-ledger.mjs`: writes `review.md` in the store (§22).
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: `listArtifacts` lists the seen store artifacts, `/api/index` adds `artifactScopes`, and `/api/artifact` serves store bytes (§23).
- change `src/server/review/workspace-model.mjs`, `dist/server/review/workspace-model.mjs`: libraries, slice files, and the glossary read store artifacts (§23).
