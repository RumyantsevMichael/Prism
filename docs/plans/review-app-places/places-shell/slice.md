# The rail of places and the shell around it

> Shipped history: initiative `review-app-places` shipped on 2026-11-10, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

A rail switches five places, the sidebar shows only the current place and keeps it while pages change, the sidebar collapses to the rail, the drawer holds both on narrow windows, the trail names the place, and every kept feature and page still works.

## Changes

- add `src/server/review/public/kit/elements/prism-rail.js`, `dist/server/review/public/kit/elements/prism-rail.js`: `PrismRail` lays out the place buttons and the collapse toggle as a labeled navigation (§1, §2, §14, §65)
- add `src/server/review/public/kit/elements/prism-rail-item.js`, `dist/server/review/public/kit/elements/prism-rail-item.js`: `PrismRailItem` is one place button with its icon, its pressed state, its tooltip, and its count badge (§2, §3, §4, §65)
- add `src/server/review/public/kit/elements/prism-place-head.js`, `dist/server/review/public/kit/elements/prism-place-head.js`: `PrismPlaceHead` shows a place's title and subtitle above its sidebar (§1, §5, §65)
- change `src/server/review/public/kit/kit.js`, `dist/server/review/public/kit/kit.js`: `KIT_ELEMENTS` lists the three new elements (§65)
- change `src/server/review/public/kit/catalog.js`, `dist/server/review/public/kit/catalog.js`: `SPECIMENS` shows each new element in every state with a long title and an unbroken name (§65)
- change `src/server/review/public/review.html`, `dist/server/review/public/review.html`: the shell holds the rail beside the sidebar and the drawer holds both (§2, §14, §22, §23)
- change `src/server/review/public/review.js`, `dist/server/review/public/review.js`: `renderNavigation` draws the rail and only the current place's sidebar, `choosePlace` keeps the place across pages and in the address, and the collapse and drawer follow the rail (§1, §5, §6, §7, §8, §9, §10, §11, §12, §13, §14, §15, §16, §17, §22, §23, §24, §25, §26)
- add `src/server/review/public/views/places.js`, `dist/server/review/public/views/places.js`: `PLACES` and `placeOf` name each place, its icon, its head, and the place a page belongs to (§1, §18, §19)
- change `src/server/review/public/views/page-bar.js`, `dist/server/review/public/views/page-bar.js`: the trail's first crumb names the page's place and chooses it (§20, §21)
- change `src/server/review/public/styles/shell.css`, `dist/server/review/public/styles/shell.css`: the shell's grid places the rail, the sidebar, and the main island at each width without styling the kit elements (§2, §14, §22, §66)
- change `src/server/review/workspace-model.mjs`, `dist/server/review/workspace-model.mjs`: `entityContext` gives each page its `place` and its trail's place crumb, and `computeNavigation` adds `places` (§18, §19, §20)
- change `test/server/review-shell-browser.test.mjs`, `test/server/review-tabs-browser.test.mjs`, `test/server/review-shell-navigation-browser.test.mjs`, `test/server/review-shell-history-leave-browser.test.mjs`, `test/server/review-shared-stream-browser.test.mjs`, `test/server/review-kit-containers-browser.test.mjs`, `test/server/review-kit-everywhere-browser.test.mjs`, `test/server/review-entities.test.mjs`: `navigate` steps reach pages through the places, keeping every test's title and assertions (§27, §28, §29)
- change `docs/user-guide/review-browser.md`: the navigation section describes the rail, the places, the collapse, and the drawer (§1, §14, §22)
- change `docs/ADRs/review-ui-kit/navigate-by-places.md`: `Status` stays Proposed until the slice lands, when it becomes Accepted (§1)
