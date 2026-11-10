# The Work place

> Shipped history: initiative `review-app-places` shipped on 2026-11-10, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

Work lists only designed, unshipped work grouped by state, with a short slice list and a filter.

## Changes

- change `src/server/review/public/review.js`, `dist/server/review/public/review.js`: `renderWorkPlace` groups initiatives by state, shortens each slice list, and filters by title (§30, §31, §32, §33, §34, §35)
- change `src/server/review/workspace-model.mjs`, `dist/server/review/workspace-model.mjs`: `computeNavigation` gives `places.work` each designed, unshipped initiative with its group and ordered slices (§30, §31, §32, §48)
- change `docs/user-guide/review-browser.md`: the Work place's groups, short list, and filter are described (§30, §32, §35)
