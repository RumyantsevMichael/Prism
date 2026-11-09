# The History and Roadmap places

History lists shipped and superseded work by date, and the Roadmap place switches the page's views and jumps to lanes.

## Changes

- change `src/server/review/workspace-model.mjs`, `dist/server/review/workspace-model.mjs`: `computeNavigation` adds `places.history` from the roadmap's decisions, newest first (§47, §48)
- change `src/server/review/public/review.js`, `dist/server/review/public/review.js`: `renderHistoryPlace` lists each decision with its date, its muted mark, and what superseded it, and `renderRoadmapPlace` holds the view choice and the lane links (§44, §45, §46, §47)
- change `src/server/review/public/views/roadmap.js`, `dist/server/review/public/views/roadmap.js`: `render` takes its view from the place's sidebar and no longer draws Board, List, and Graph in the page head, keeps the swim-lane board, reads the `lane` parameter, and scrolls the lane into view each time (§44, §45, §46)
- change `src/server/review/public/views/initiative.js`, `dist/server/review/public/views/initiative.js`: `render` says on a superseded initiative's page what superseded it, when, and why (§47)
- change `docs/user-guide/review-browser.md`: History and the Roadmap place's views and lanes are described (§44, §47)
