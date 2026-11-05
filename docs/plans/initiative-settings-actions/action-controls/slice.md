# Generic action controls in the review page

## Outcome

The initiative, slice, and index pages render every action generically as compact keyboard-reachable controls with confirmation and stale handling, read-only tabs say why, and every tab of the workspace's checkouts shows applied actions and their authors as they happen.

## Changes

- add `src/server/review/public/views/actions.js`: `actionFormState` and the generic renderer that draws an action listing with the existing segmented group, text input, card, and status pill components, opens the confirmation dialog, and handles refusals (§39, §41, §43-§45)
- change `src/server/review/public/views/initiative.js`, `src/server/review/public/views/slice.js`: the `Initiative settings` card on the initiative page and on every slice page, naming the initiative (§41)
- change `src/server/review/public/views/indexing.js`: one rebuild control per index target through the generic renderer, labeled with its component and state (§42)
- change `src/server/review/public/views/attention.js`: `Recent changes` from `recentChanges` with each author and checkout, updated by `action` events (§48)
- change `src/server/review/public/views/palette.js`, `src/server/review/public/review.js`: the shown target's actions as palette entries, the modal confirmation dialog, the read-only notice, and the `action` event listener (§39, §44, §46, §47)
- change `src/server/review/public/review.html`: the confirmation dialog element beside the existing dialogs (§44)
- change `src/server/review/public/review.css`: only the layout that places the existing components in the settings card, with no new control styles (§41)
- change `src/server/review/review-server.mjs`: an applied action notifies its page's viewer streams with an `action` event, and reports it to the app for the other pages (§47)
- change `src/server/review/review-app-server.mjs`: an initiative, slice, or gate action reaches the viewer streams of every checkout's page whose records resolve to the same record store, and an index action only its own page's (§47)
- change `src/server/review/workspace-model.mjs`: the Attention entity's `recentChanges` from every initiative's history of the page's records and the checkout's index history, in history order (§48)
- add `dist/server/review/public/views/actions.js`: the generated copy of the new view
- change `dist/server/review/public/views/initiative.js`, `dist/server/review/public/views/slice.js`, `dist/server/review/public/views/attention.js`, `dist/server/review/public/views/indexing.js`, `dist/server/review/review-app-server.mjs`, `dist/server/review/public/views/palette.js`, `dist/server/review/public/review.js`, `dist/server/review/public/review.html`, `dist/server/review/public/review.css`, `dist/server/review/review-server.mjs`, `dist/server/review/workspace-model.mjs`: the generated runtime of the changed sources
- change `scripts/review-demo/seed.mjs`: the demo records applied actions so Attention shows `Recent changes`
- change `docs/user-guide/review-browser.md`: the settings card, the confirmation, the palette entries, the index controls, and `Recent changes` with authors, which show every checkout's changes to shared records but only this checkout's index rebuilds (§41-§48)
