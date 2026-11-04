# Run the dependents' tests when a scope finishes

## Outcome

A finished scope runs its repository's dependents' tests once, reports other repositories' dependents it did not run, records the run, and blocks shipping and the ready to ship state while a dependent is red or unproven.

## Changes

- change `src/server/workflow/components.mjs`: `dependentsOf`, `dependencyOrder`, and `otherRepositoryDependents` give a scope's transitive dependents of the same repository in run order and find the components of other repositories that depend on them, transitively within each other repository (§26, §27, §39)
- change `src/server/workflow/verification.mjs`: `VERIFY_SLICE_SCHEMA` takes `dependents`, `verifySlice` dispatches to `dependentsRun`, which checks the scope, resolves and groups the pairs, asks one gate for the pairs not yet allowed, runs them, and records the run on the scope with `otherRepositories` (§25, §26, §27, §28, §29, §39)
- change `src/server/workflow/machine-checkouts.mjs`: `checkoutsOfStore` lists this machine's checkouts of a store's other repositories, read-only, and the store's registered repositories that none of them covers (§39)
- change `src/server/workflow/initiative.mjs`: `fitScopes` and `scopeLeaves` find fit scopes and their leaves, and `getInitiative` returns `dependents` from the scopes' latest dependents' runs (§24, §30)
- change `src/server/workflow/roadmap.mjs`: `applyOperation` refuses `ship` with `dependents_blocked` while a fit scope's dependents have no passing run, after the leaf check, and `deriveInitiative` makes `readyToShip` false with a `dependents_blocked` or declaration diagnostic instead of refusing (§31, §35)
- change `src/server/mcp.mjs`: the `verify_slice` schema and description take `dependents`, and `stateErrorData` passes `waiting` and `scopes` (§25, §31)
- change `dist/server/workflow/components.mjs`, `dist/server/workflow/machine-checkouts.mjs`, `dist/server/workflow/verification.mjs`, `dist/server/workflow/initiative.mjs`, `dist/server/workflow/roadmap.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `skills/orchestrate/SKILL.md`: `Run each slice` and `Finish or pause` run each finished scope's dependents' run, wait on its approval gate as for a slice, report a blocked scope to the user before shipping, and report the other repositories' dependents it did not run as not run, never as a failure (§25, §28, §29, §31, §39)
- change `skills/workflow/SKILL.md`: `Common terms` add Dependents' run (§24, §26, §31)
- change `docs/user-guide/workflow.md`: `Dependents` explains when the dependents run, how they are approved, and what blocks shipping and the ready to ship state, and how dependents in other repositories are reported (§26, §28, §31, §35, §39)
