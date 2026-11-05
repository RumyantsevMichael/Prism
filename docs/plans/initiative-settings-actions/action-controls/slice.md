# Generic action controls in the review page

## Outcome

The initiative and slice pages render every action generically as compact keyboard-reachable controls with confirmation and stale handling, read-only tabs say why, and every tab's Attention page shows applied actions as they happen.

## Changes

- add `src/server/review/public/views/actions.js`: `actionFormState` and the generic renderer that draws an action listing with the existing segmented group, text input, card, and status pill components, opens the confirmation dialog, and handles refusals (§27, §29-§32)
- change `src/server/review/public/views/initiative.js`, `src/server/review/public/views/slice.js`: the `Initiative settings` card on the initiative page and on every slice page, naming the initiative (§29)
- change `src/server/review/public/views/attention.js`: `Recent changes` from `recentChanges`, updated by `action` events (§35)
- change `src/server/review/public/views/palette.js`, `src/server/review/public/review.js`: the shown target's actions as palette entries, the modal confirmation dialog, the read-only notice, and the `action` event listener (§27, §31, §33, §34)
- change `src/server/review/public/review.html`: the confirmation dialog element beside the existing dialogs (§31)
- change `src/server/review/public/review.css`: only the layout that places the existing components in the settings card, with no new control styles (§29)
- change `src/server/review/review-server.mjs`: an applied action notifies every viewer stream of its project with an `action` event (§34)
- change `src/server/review/workspace-model.mjs`: the Attention entity's `recentChanges` from every initiative's history and the project history (§35)
- add `dist/server/review/public/views/actions.js`: the generated copy of the new view
- change `dist/server/review/public/views/initiative.js`, `dist/server/review/public/views/slice.js`, `dist/server/review/public/views/attention.js`, `dist/server/review/public/views/palette.js`, `dist/server/review/public/review.js`, `dist/server/review/public/review.html`, `dist/server/review/public/review.css`, `dist/server/review/review-server.mjs`, `dist/server/review/workspace-model.mjs`: the generated runtime of the changed sources
- change `scripts/review-demo/seed.mjs`: the demo records applied actions so Attention shows `Recent changes`
- change `docs/user-guide/review-browser.md`: the settings card, the confirmation, the palette entries, and `Recent changes` (§29-§35)
