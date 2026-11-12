# Accept ADRs when an initiative ships

## Changes
- change `src/server/workflow/roadmap.mjs`, `dist/server/workflow/roadmap.mjs`: `ship` takes `afterGate`, refuses with `ship_unconfirmed` without an approved `correctness` gate where a store is configured, and returns `acceptedAdrs` (§43, §44).
- change `src/server/workflow/artifact-status.mjs`, `dist/server/workflow/artifact-status.mjs`: `acceptAtShip`, which finds the ADRs that the initiative's `slice.md` files link, rewrites each Proposed one, and records `acceptance` with the gate and the verified commits (§44).
- change `src/server/workflow/store-artifacts.mjs`, `dist/server/workflow/store-artifacts.mjs`: `get_artifact` returns `acceptance` (§44).
