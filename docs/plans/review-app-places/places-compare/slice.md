# Compare the places mockup with the demo app

> Shipped history: initiative `review-app-places` shipped on 2026-11-10, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

The comparison renders each scene of the places mockup beside the demo app in the same state and fails on any difference in structure, geometry, or design values.

## Changes

- add `scripts/review-demo/places-compare.mjs`: `outline`, `compareOutlines`, and `main` render each scene of the mockup and of the app at each width and theme, write the pairs, the outlines, and the report, and exit 0, 1, or 2 (§67, §68, §69, §70, §71, §72)
- change `scripts/review-demo/mockup-compare.mjs`: `frameWindow` is shared so both comparisons size a frame to the window and render it the same way (§67)
- change `CONTRIBUTING.md`: the places comparison sits beside the UI kit comparison with its options, its exit codes, and the rule that a slice changing a scene runs it (§67, §69, §72, §73)
