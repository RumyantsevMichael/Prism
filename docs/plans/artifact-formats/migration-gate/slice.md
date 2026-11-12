# Migration gate

## Changes

- change `src/server/review/workspace-model.mjs`: the `migration` question item on Attention and the `migration:<id>` entity with the summary, diffs, leftovers, unknowns, conflicts, and removal choice (§38).
- change `src/server/review/review-server.mjs`: `migration:<id>` opens through the review link and `present_review` (§38).
- add `src/server/review/public/views/migration.js`: the migration page built from kit elements, with the existing line diff view and the `migration.answer` action form (§38, §39).
- change `src/server/review/public/views/entities.js`, `src/server/review/public/views/attention.js`: the migration page's entry and the question row that links it (§38).
- change `src/server/review/public/styles/workflow-views.css`: the layout of the migration page's kit elements (§38).
- change `docs/user-guide/review-browser.md`: answering a migration in the review browser (§38, §39).
