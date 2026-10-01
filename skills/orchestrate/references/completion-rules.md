# Integration and completion rules

The integrated tree must match the preserved reviewed result, including conflicts and affected dependencies.
Changed reviewed behavior or uncertain equivalence requires affected review before confirmation.
Each split ancestor whose final unfinished descendant is this leaf needs review of preserved lanes.
Ancestor findings retain their reporting lane and route to the affected worker or unresolved decision without reactivating the parent.
Aggregate completion remains blocked until every preserved lane is `CLEAN`.
The final gate requires [visual review](../../workflow/references/visual-review.md) and correctness confirmation under [run settings](run-settings.md).
Proposed ADRs become Accepted only after governed behavior is verified and confirmed across relevant children.
Superseded originals link under project rules.
Commit and push settings apply only to slice-owned changes and preserve unrelated changes.
The `done` map transition uses `write-map` after every completion gate passes.
The active resume entry is removed with `update_coordination_state` and the current revision from `get_coordination_state`.

If confirmed behavior changes, repeat affected verification, review, and confirmation.
Coordination cleanup follows durable graduation and the `shipped` transition.
