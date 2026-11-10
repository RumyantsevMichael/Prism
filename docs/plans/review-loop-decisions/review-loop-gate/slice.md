# Ask the review loop decision

## Outcome

Prism asks the review loop decision with a summary, applicable options, and a rule-based recommendation, and carries out a return to design.

## Changes

- change `src/server/review/review-ledger.mts`: `assertReviewMayContinue` records or names the review loop gate through `updateCoordinationState` with its question, options, context, and recommendation, refuses with the new message, and refuses an `afterGate` that chose another option, and the `return_to_design` operation (§12-§25)
- change `src/server/workflow/verification.mjs`: `reportContractDefects` is exported so the review ledger blocks the slice the same way (§23)
- change `src/server/conservation/conservation-tools.mts`: the `update_review` description names the review loop gate, its options, and `return_to_design` (§12, §22)
- change `dist/server/review/review-ledger.mjs`, `dist/server/workflow/verification.mjs`, `dist/server/conservation/conservation-tools.mjs`: the generated runtime of the changed sources
