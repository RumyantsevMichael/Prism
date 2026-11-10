# No styling around the kit

> Shipped history: initiative `review-app-ui-kit` shipped on 2026-11-09, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Changes
- remove `src/server/review/public/review.css`, `dist/server/review/public/review.css`: every rule now lives in the kit or an area stylesheet (clause 82).
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: `/review.css` is no longer served (clause 82).
- change `src/server/review/public/review.html`, `src/server/review/public/kit/kit.css`, `src/server/review/public/styles/shell.css`, `src/server/review/public/styles/workflow-views.css`, `src/server/review/public/styles/record-views.css`: remaining findings, theme special cases, file names, and layout problems are resolved (clauses 7, 8, 62, 69, 71, 82).
- change `test/server/review-stylesheet.test.mjs`: the brace check covers every stylesheet under `kit/` and `styles/`.
- change `scripts/review-demo/layout-check.mjs`: any leftover legacy selectors are replaced by roles (clause 62).
- change `CONTRIBUTING.md`: the kit rules for contributors, the guard command, and the catalog in the UI change checklist.
- change `dist/server/review/public`: regenerated output.
