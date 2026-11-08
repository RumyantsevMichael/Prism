# Merge coordination state across machines

## Outcome

A coordination state changed on two machines within one sync window merges by its structure, so the person's changes, agents' writes, and both histories survive without a saved conflict.

## Changes

- change `src/server/workflow/state.mjs`: `mergeCoordinationState`, the part-by-part merge of settings with their person marks, pending gates and answers with each gate's asked context, option consequences, and recommendation kept as asked, history, active work, closed gates, evidence, and the remaining fields, validated and fitted to 1 MiB as a written state is, keeping dropped history entries and closed gates of the base dropped; the serializer that every coordination state writer shares drops the oldest history entries other than the one the write adds, and then the oldest closed gates, until the state fits 1 MiB, and refuses with `artifact_too_large` only when what it cannot drop exceeds it (§21, §25-§28)
- change `src/server/workflow/record-merge.mjs`: the coordination state record path registers `mergeCoordinationState`, and `mergeKeyed` and `mergeOrder` serve its per-id parts (§25, §26)
- change `test/server/record-store-sync.test.mjs`: the line-merge test uses a record kind that still has no structural merge, and a test confirms that a coordination state now merges by structure
- change `dist/server/workflow/state.mjs`, `dist/server/workflow/record-merge.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/shared-records.md`: which concurrent changes to an initiative's coordination state merge and which still keep the upstream version, and that the oldest history entries and closed gates give way to keep the state within 1 MiB (§21, §26-§28)
- change `docs/ADRs/workflow-records/record-store-git-sync.md`: the coordination state joins the record kinds that merge by structure, and its writers and merge fit it to 1 MiB by dropping the oldest history entries and closed gates (§21, §27)
- change `test/server/coordination-state-size.test.mjs`: the size tests drop history and closed gates before refusing (§21)
