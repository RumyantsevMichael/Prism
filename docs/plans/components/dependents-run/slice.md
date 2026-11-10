# Run the dependents' tests when a scope finishes

> Shipped history: initiative `components` shipped on 2026-11-07, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

A finished scope runs its repository's dependents' tests once, records the run, and blocks shipping and the ready to ship state while a dependent is red or unproven.

## Changes

- change `src/server/workflow/components.mjs`: `dependentsOf` and `dependencyOrder` give a scope's transitive dependents of the same repository in run order, skipping dependencies on other repositories' components (§26, §27, §39)
- change `src/server/workflow/verification.mjs`: `VERIFY_SLICE_SCHEMA` takes `dependents`, `verifySlice` dispatches to `dependentsRun`, which checks the scope, resolves and groups the pairs, asks one gate for the pairs not yet allowed, runs them, and records the run on the scope (§25, §26, §27, §28, §29, §39)
- change `src/server/workflow/initiative.mjs`: `fitScopes` and `scopeLeaves` find fit scopes and their leaves, and `getInitiative` returns `dependents` from the scopes' latest dependents' runs (§24, §30)
- change `src/server/workflow/roadmap.mjs`: `applyOperation` refuses `ship` with `dependents_blocked` while a fit scope's dependents have no passing run, after the leaf check, and `deriveInitiative` makes `readyToShip` false with a `dependents_blocked` or declaration diagnostic instead of refusing (§31, §35)
- change `src/server/mcp.mjs`: the `verify_slice` schema and description take `dependents`, and `stateErrorData` passes `waiting` and `scopes` (§25, §31)
- change `dist/server/workflow/components.mjs`, `dist/server/workflow/verification.mjs`, `dist/server/workflow/initiative.mjs`, `dist/server/workflow/roadmap.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `skills/orchestrate/SKILL.md`: `Run each slice` and `Finish or pause` run each finished scope's dependents' run, wait on its approval gate as for a slice, and report a blocked scope to the user before shipping (§25, §28, §29, §31)
- change `skills/workflow/SKILL.md`: `Common terms` add Dependents' run (§24, §26, §31)
- change `docs/user-guide/workflow.md`: `Dependents` explains when the dependents run, how they are approved, and what blocks shipping and the ready to ship state, and that a dependency on another repository's component never runs there (§26, §28, §31, §35, §39)
