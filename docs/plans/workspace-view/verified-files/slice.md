# Verified files by blob hash

## Changes
- change `src/server/workflow/verification.mjs`, `dist/server/workflow/verification.mjs`: run records hold `files`, `filesFrom`, and `filesTruncated` from the start content and the tested content, and `checkout.host` (§51, §52).
- change `src/server/workflow/git-objects.mjs`, `dist/server/workflow/git-objects.mjs`: `changedBlobs`, the paths and blobs that differ between two trees (§51).
- change `src/server/workflow/roadmap.mjs`, `dist/server/workflow/roadmap.mjs`: a ship records `slices` in its decision after fetching `origin` and finding the oldest default-branch commit that holds every verified blob, and its result lists `noShipCommit` (§53).
- change `docs/user-guide/workflow.md`: what a run records about a slice's files, and what ship records (§51-§53).
