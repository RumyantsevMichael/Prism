# The History and Roadmap places

History lists shipped and superseded work by date, and the Roadmap place switches the page's views and jumps to lanes.

## Changes

- change `src/server/review/workspace-model.mjs`, `dist/server/review/workspace-model.mjs`: `computeNavigation` adds `places.history` from the roadmap's decisions, newest first (§47, §48)
- change `src/server/review/public/review.js`, `dist/server/review/public/review.js`: `renderHistoryPlace` lists each decision with its date and mark, and `renderRoadmapPlace` holds the view choice and the lane links (§44, §45, §46, §47)
- change `src/server/review/public/views/roadmap.js`, `dist/server/review/public/views/roadmap.js`: `renderRoadmap` reads the `lane` parameter, scrolls the lane into view each time, and announces its view so the sidebar follows (§45, §46)
- change `docs/user-guide/review-browser.md`: History and the Roadmap place's views and lanes are described (§44, §47)
