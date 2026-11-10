# Show deferred findings in the review browser

## Outcome

The review browser shows deferred findings apart and the review loop gate's summary.

## Changes

- change `src/server/review/workspace-model.mjs`: `reviewSummary` counts `DEFERRED` apart from unresolved findings and lists each deferred finding with its severity, title, gate, and follow-up (§26, §27)
- change `src/server/review/public/views/review-ledger.js`: the `DEFERRED` board column after `VERIFIED`, its badge tone, the deferral in the finding detail, and the deferred stat (§26, §29)
- change `src/server/review/public/views/slice.js`: the review card's deferred stat and list of deferred findings, from kit elements only (§27, §29)
- change `src/server/review/public/styles/record-views.css`, `src/server/review/public/styles/workflow-views.css`: the board lays out a sixth column and the review card its deferred list, from tokens only (§26, §27, §29)
- change `dist/server/review/workspace-model.mjs`, `dist/server/review/public/views/review-ledger.js`, `dist/server/review/public/views/slice.js`, `dist/server/review/public/styles/record-views.css`, `dist/server/review/public/styles/workflow-views.css`: the generated runtime of the changed sources
