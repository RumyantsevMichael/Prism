# Merge coordination state across machines

## Outcome

A coordination state changed on two machines within one sync window merges by its structure, so the person's changes, agents' writes, and both histories survive without a saved conflict.

## Changes

- change `src/server/workflow/state.mjs`: `mergeCoordinationState`, the part-by-part merge of settings with their person marks, pending gates and answers with each gate's asked context, option consequences, and recommendation kept as asked, history, active work, closed gates, evidence, and the remaining fields, validated and size-checked as a written state is (§25-§28)
- change `src/server/workflow/record-merge.mjs`: the coordination state record path registers `mergeCoordinationState`, and `mergeKeyed` and `mergeOrder` serve its per-id parts (§25, §26)
- change `test/server/record-store-sync.test.mjs`: the line-merge test uses a record kind that still has no structural merge, and a test confirms that a coordination state now merges by structure
- change `dist/server/workflow/state.mjs`, `dist/server/workflow/record-merge.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/shared-records.md`: which concurrent changes to an initiative's coordination state merge and which still keep the upstream version (§26-§28)
- change `docs/ADRs/workflow-records/record-store-git-sync.md`: the coordination state joins the record kinds that merge by structure
