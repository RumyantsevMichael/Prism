# Touched by my work and Changed this week

Touched by my work shows the records behind the open slice and why, and Changed this week lists this week's record changes or says plainly why it cannot.

## Changes

- add `src/server/review/record-changes.mjs`, `dist/server/review/record-changes.mjs`: `recordChanges` reads this week's commits and uncommitted changes of the record files through Git, or says why it cannot (§61, §62, §63, §64)
- add `src/server/review/touched-records.mjs`, `dist/server/review/touched-records.mjs`: `touchedRecords` reads a slice's cited sections, links, clause terms, Changes lines, and verified changes (§56, §57, §58, §60)
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: `GET /api/touched` and `GET /api/changed` answer them (§60, §64)
- change `src/server/review/workspace-model.mjs`, `dist/server/review/workspace-model.mjs`: `computeNavigation` gives the entry points their counts, with none for Changed this week when history is unavailable (§49, §63)
- change `src/server/review/public/review.js`, `dist/server/review/public/review.js`: `lastSlice` remembers the slice last selected since the page loaded (§54)
- add `src/server/review/public/views/knowledge.js`, `dist/server/review/public/views/knowledge.js`: `renderTouched` and `renderChanged` show both pages, their groups, and their empty and unavailable states (§55, §58, §59, §61, §63)
- change `docs/user-guide/review-browser.md`: Touched by my work and Changed this week are described with where each list comes from (§55, §61, §63)
