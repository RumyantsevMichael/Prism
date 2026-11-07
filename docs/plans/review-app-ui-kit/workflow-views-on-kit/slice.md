# Workflow views on the kit

## Changes
- change `src/server/review/public/views/util.js`: `card`, `evidenceChip`, `artifactChip`, and the other shared helpers return kit panels and chips (§61, §62).
- change `src/server/review/public/views/attention.js`: gates use kit panels, choices, fields, and buttons (§61, §62).
- change `src/server/review/public/views/roadmap.js`, `src/server/review/public/views/initiative.js`, `src/server/review/public/views/slice.js`, `src/server/review/public/views/library.js`: boards, cards, badges, disclosures, and tabs are kit elements (§61, §62).
- change `src/server/review/public/views/claims.js`, `src/server/review/public/views/components.js`, `src/server/review/public/views/run-totals.js`, `src/server/review/public/views/code-location.js`: chips, stats, and links are kit elements (§61, §62).
- add `src/server/review/public/styles/workflow-views.css`: the workflow views' layout from tokens (§62).
- change `src/server/review/public/review.css`, `src/server/review/public/review.html`: the workflow views' rules move out, and the page loads `styles/workflow-views.css` (§62).
- change `test/server/component-label.test.mjs`, `test/server/slice-claims.test.mjs`, `test/server/run-totals-browser.test.mjs`, `test/server/code-links.test.mjs`: their markup patterns follow the kit chips and stats while asserting the same text and data.
- change `dist/server/review/public`: regenerated output.
