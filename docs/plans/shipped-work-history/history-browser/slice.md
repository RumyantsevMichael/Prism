# Label shipped history in the review browser

> Shipped history: initiative `shipped-work-history` shipped on 2026-11-10, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

The review browser labels a shipped initiative, its slices, and its slice documents as history, names a document changed after ship, and shows every action on them as unavailable.

## Changes

- change `src/server/review/workspace-model.mjs`: `loadEntity` adds `shippedHistory` with its `label` to the initiative and slice data, and `entityContext` adds it with the document's own `changedAfterShip` for a slice document of a shipped initiative (§16, §17)
- add `src/server/review/public/views/shipped-history.js`: `shippedHistoryHtml`, the label and the changed-after-ship line (§18)
- change `src/server/review/public/views/initiative.js`, `src/server/review/public/views/slice.js`, `src/server/review/public/views/preview.js`: each page renders `shippedHistoryHtml` above its content (§18)
- change `src/server/review/public/review.css`: the label's style from the existing notice tokens (§18)
- change `src/server/workflow/actions.mjs`: `readTarget` reads the target initiative's shipped decision, and `view` makes every initiative, slice, and gate action unavailable with the shipped reason, which `check` then refuses with `action_unavailable` (§19)
- add `dist/server/review/public/views/shipped-history.js`: the generated copy of the new view
- change `dist/server/review/workspace-model.mjs`, `dist/server/review/public/views/initiative.js`, `dist/server/review/public/views/slice.js`, `dist/server/review/public/views/preview.js`, `dist/server/review/public/review.css`, `dist/server/workflow/actions.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/review-browser.md`: the shipped history label, the changed-after-ship line, and why actions on shipped work are unavailable (§16, §17, §19)
