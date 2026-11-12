# Prism's own artifacts in the store

## Changes
- change `src/server/workflow/record-store.mjs`, `dist/server/workflow/record-store.mjs`: `readArtifactText` and `writeArtifactText`, which read and write a slice folder's files through `resolveArtifactFile`, writing a generated view in the scope that holds its folder (§22).
- change `src/server/workflow/initiative.mjs`, `dist/server/workflow/initiative.mjs`: reads `slice.md` for the Changes check, unfrozen split evidence, and design text through the store, refuses frozen tests that are artifact paths with `frozen_test_in_store`, writes `initiative.md` there, and with a store refuses slugs beginning with `-` or `_` and the design of such a slice with `artifact_name_invalid`, slugs whose plan folder collides in letter case with another initiative's or slice's plan folder or a stored artifact path with `artifact_name_conflict`, and slugs whose plan folder location with `/initiative.md` exceeds 120 characters with `artifact_path_too_long` (§19, §22).
- change `src/server/workflow/slice-design.mjs`, `dist/server/workflow/slice-design.mjs`: `measureContract` measures `slice.md` from the store (§22).
- change `src/server/workflow/diagram-check.mjs`, `dist/server/workflow/diagram-check.mjs`: lists and parses PlantUML files of a slice folder in the store (§22).
- change `src/server/workflow/design-view.mjs`, `dist/server/workflow/design-view.mjs`: reads `slice.md` from the store (§22).
- change `src/server/workflow/state.mjs`, `dist/server/workflow/state.mjs`: `checkpointPause` writes `recovery.md` in the store (§22).
- change `src/server/workflow/projection.mjs`, `dist/server/workflow/projection.mjs`, `src/server/workflow/roadmap.mjs`, `dist/server/workflow/roadmap.mjs`: generated views are written through the artifact resolver (§22).
- change `src/server/review/review-ledger.mts`, `dist/server/review/review-ledger.mjs`: writes `review.md` in the store (§22).
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: `listArtifacts` lists the seen store artifacts, `/api/index` adds `artifactScopes`, `/api/artifact` serves store bytes, and an unavailable store or refused repository name lists, searches, and serves no checkout copy of an artifact (§23).
- change `src/server/review/workspace-model.mjs`, `dist/server/review/workspace-model.mjs`: libraries, slice files, and the glossary read store artifacts and show no checkout copy when the store is refused (§23).
