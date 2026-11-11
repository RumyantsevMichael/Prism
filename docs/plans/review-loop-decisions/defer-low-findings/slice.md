# Defer low findings

> Shipped history: initiative `review-loop-decisions` shipped on 2026-11-11, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

The coordinator accepts a wave with low findings deferred by the user's gate, each with a follow-up, and Prism reads them back apart.

## Changes

- change `src/server/workflow/state.mjs`: the `resolve` gate operation takes `choice` and the closed gate keeps it, and `validateClosed` accepts it (§1)
- change `src/server/review/review-ledger.mts`: the `DEFERRED` status and `deferral` on findings in the record schema, `accept_wave` with `gate` and `deferrals`, the gate check shared with the review loop slice, `deferral_refused` problems, lane digests that stay current across a deferral, deferred findings counted as resolved, refusals of `set_finding_status` and `revise_finding` on them, `deferred` on `get_review`, and the deferral line in `review.md` (§2-§9, §11)
- change `src/server/workflow/initiative.mjs`: `derived.deferredFindings` read from each slice's review record, and the `get_initiative` description (§10)
- change `src/server/conservation/conservation-tools.mts`: the `get_review` and `update_review` descriptions name deferrals, `DEFERRED`, and `deferred` (§2, §9)
- change `src/server/mcp.mjs`: `deferral_refused` passes its `problems` in the error data, and the `update_coordination_state` description names `resolve` with `choice` (§1, §4)
- change `dist/server/workflow/state.mjs`, `dist/server/review/review-ledger.mjs`, `dist/server/workflow/initiative.mjs`, `dist/server/conservation/conservation-tools.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
