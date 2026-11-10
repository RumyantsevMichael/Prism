# Fix done work inside its initiative

> Shipped history: initiative `shipped-work-history` shipped on 2026-11-10, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

A defect in done work joins its unshipped initiative as a fix slice that leaves the done slice's records untouched and holds ship until it is done.

## Changes

- change `src/server/workflow/initiative-graph.mjs`: `analyzeInitiative` keeps a slice's `fixes`, treats a fix slice as a leaf below the slice it fixes for leaves, counts, design candidates, completion, and dependencies, leaves fix slices out of split and coverage checks, lists them under `children`, and returns `fixes` (§25, §26)
- change `src/server/workflow/initiative.mjs`: the `report_defect` operation and the `add_fix` proposal operation with their schemas, `claim` and `propose_design` on a done scope, `accept_proposal` adding the fix slice, `set_status` refusing a done slice with `slice_done`, `split` refusing a fix slice, `validateRecord` and `canonicalRecord` for `defects` and `fixes`, `scopeLeaves` and `proposalOutside` counting fix slices, `derived` with `unfinishedFixes` and `readyToShip`, the `initiative.md` view of defects and fixes, and the `update_initiative` description (§20, §21, §22, §23, §24, §25, §27, §28)
- change `src/server/workflow/roadmap.mjs`: `ship` refuses unfinished fixes with `fixes_unfinished` after open work and before the leaf check, and `deriveItem` reports them as a diagnostic (§27)
- change `src/server/mcp.mjs`: `stateErrorData` passes a refusal's `fixes` (§27)
- change `test/server/initiative-record.test.mjs`: existing tests that set a done slice back to another status take the fix route or start from a slice that is not done
- change `dist/server/workflow/initiative-graph.mjs`, `dist/server/workflow/initiative.mjs`, `dist/server/workflow/roadmap.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/workflow.md`: the **Defects** section gains reporting a defect on a done slice, the fix slice, how it holds ship, and that a done slice stays done (§20, §22, §23, §27, §28)
