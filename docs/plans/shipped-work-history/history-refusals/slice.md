# Refuse changes to shipped history

## Outcome

Every Prism tool refuses to change a shipped initiative's state and keeps its records.

## Changes

- change `src/server/workflow/shipped-history.mjs`: `refuseShipped`, which throws `ShippedHistoryError` for a shipped initiative and returns otherwise (§13, §15)
- change `src/server/workflow/initiative.mjs`: `updateInitiative` refuses every operation of a shipped initiative, `remove_records` included, before its revision and claim checks, while `remove_records` of a superseded initiative still removes its records, and the `update_initiative` description says so (§13, §14, §15)
- change `src/server/workflow/state.mjs`: `updateCoordinationState` and `checkpointPause` refuse a shipped initiative before any write, the recovery note included (§13)
- change `src/server/review/review-ledger.mts`: `updateReview` refuses a slice of a shipped initiative (§13)
- change `src/server/workflow/verification.mjs`: `verifySlice` refuses a shipped initiative before approval, contract defects, or a dependents' run (§13)
- change `src/server/workflow/design-view.mjs`: `updateDesignView` refuses a slice of a shipped initiative (§13)
- change `src/server/conservation/change-map.mjs`: `updateChangeMap` refuses a slice of a shipped initiative (§13)
- change `src/server/mcp.mjs`: `stateErrorData` maps `ShippedHistoryError` from every tool to `initiative_shipped` with `initiative` and `shippedAt` (§13, §15)
- change `test/server/initiative-record.test.mjs`, `test/server/roadmap-record.test.mjs`: existing tests that change or remove an initiative after it ships do so before it ships or for a superseded initiative
- change `dist/server/workflow/shipped-history.mjs`, `dist/server/workflow/initiative.mjs`, `dist/server/workflow/state.mjs`, `dist/server/review/review-ledger.mjs`, `dist/server/workflow/verification.mjs`, `dist/server/workflow/design-view.mjs`, `dist/server/conservation/change-map.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/workflow.md`: a shipped initiative's records stay and refuse every change, and new work on it starts a new initiative; the cleanup of refs no longer waits for `remove_records` of a shipped initiative (§13, §14)
