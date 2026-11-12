# Workspace switcher tests follow the places rail

## Outcome

The workspace switcher's acceptance tests check the places rail that every page now has, so the suite passes again.

## Defect

The places redesign on `main` replaced the sidebar's `<prism-tree id="nav-places">` with `<prism-rail id="rail" label="Places">`.
The done slice `workspace-switcher` checks its clauses 8, 10, and 61 of the initiative contract by matching `id="nav-places"` and `<prism-tree id="nav-places"`, so those three tests fail although the pages still carry the places navigation those clauses require.
The initiative contract's clauses 8, 10, and 61 speak of the places navigation and name no element, so their wording stands.

## Contract
1. `GET /w/<w>/` of a listed workspace answers `200` with the review page, which holds the places rail `<prism-rail id="rail" label="Places">` and no `nav-places` element.
2. `GET /` while the app lists no workspace answers `200` with the review page in its no-workspace state, which holds the same places rail and no `nav-places` element.
3. The workspace page holds the places rail and the review app UI kit guard reports nothing.
4. `test/server/workspace-view-switcher.test.mjs` checks the places navigation of the initiative contract's clauses 8, 10, and 61 by the places rail and names no `nav-places` element.

## Assumptions
- Probed: the current review page serves `<prism-rail id="rail" label="Places">` from `src/server/review/public/review.html` for both the workspace page and the no-workspace page; in a scratch copy of the suite with only the three `nav-places` patterns changed to `/<prism-rail id="rail" label="Places"/`, all three tests passed.

## Changes
- change `test/server/workspace-view-switcher.test.mjs`: the clause 8, 10, and 61 tests match the places rail `<prism-rail id="rail" label="Places"` instead of the removed `nav-places` tree; this is the frozen test of the done slice `workspace-switcher`, which only this fix changes, and nothing else in the file changes (§4).
