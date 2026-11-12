# Label each slice's component in the review browser

> Shipped history: initiative `components` shipped on 2026-11-07, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

The review browser labels each slice that records a component with its identity.

## Changes

- add `src/server/review/public/views/components.js`: `componentChip`, the label of a slice's component identity (§34, §36)
- change `src/server/review/public/views/initiative.js`: `tree` and `boardCard` show the label (§34)
- change `src/server/review/public/views/slice.js`: `render` shows the label on the slice page (§34)
- change `src/server/review/public/review.css`: `.component-chip` styles the label beside the other chips (§34)
- change `src/server/review/workspace-model.mjs`: the slice entity carries the record's `component` when the page needs it (§34)
- add `dist/server/review/public/views/components.js`: the generated copy of the new view
- change `dist/server/review/public/views/initiative.js`, `dist/server/review/public/views/slice.js`, `dist/server/review/public/review.css`, `dist/server/review/workspace-model.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/review-browser.md`: the component label on slices (§34)
