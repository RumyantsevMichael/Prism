# Workflow views on the kit

> Shipped history: initiative `review-app-ui-kit` shipped on 2026-11-09, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Changes
- change `src/server/review/public/views/util.js`: `card`, `evidenceChip`, `artifactChip`, and the other shared helpers return kit panels and chips, and name records by title and kind (clauses 69, 81, 82).
- change `src/server/review/public/views/attention.js`: gates use kit panels, choices, fields, and buttons, name the claim holder who is waiting, list what to inspect by title and kind, and the Watch group lists live and expired claims (clauses 67, 69, 80, 81, 82).
- change `src/server/review/public/views/roadmap.js`: initiative cards show their avatar stack, the working count, and the expired claim count (clauses 67, 82).
- change `src/server/review/public/views/slice.js`: the page actions `Copy link` and `Side panel`, the lifecycle stepper from the slice's status, design, verification, and review, the claim strip, and the sub-tabs `Design`, `Diagram`, `Verification`, `Review ledger`, `Change map`, and `Files`, with empty states for absent records and the Changes list marked `data-code-subject` (clauses 67, 69, 77, 79, 82).
- change `src/server/review/public/views/initiative.js`, `src/server/review/public/views/library.js`: boards, cards, badges, disclosures, and claims are kit elements, and library entries show titles and kinds (clauses 67, 69, 82).
- change `src/server/review/public/views/claims.js`: the claim chip becomes `prism-claim` fed from `claimOf` and `coveringClaim` (clauses 66, 67).
- change `src/server/review/public/views/components.js`, `src/server/review/public/views/run-totals.js`, `src/server/review/public/views/code-location.js`: chips, stats, and links are kit elements, and code locations are marked `data-code-subject` (clauses 69, 82).
- add `src/server/review/public/styles/workflow-views.css`: the workflow views' layout from tokens (clause 82).
- change `src/server/review/public/review.css`, `src/server/review/public/review.html`: the workflow views' rules move out, and the page loads `styles/workflow-views.css` (clauses 4, 82).
- change `test/server/component-label.test.mjs`, `test/server/slice-claims.test.mjs`, `test/server/run-totals-browser.test.mjs`, `test/server/code-links.test.mjs`: their markup patterns follow the kit chips, claims, and stats while asserting the same text and data.
- change `dist/server/review/public`: regenerated output.
