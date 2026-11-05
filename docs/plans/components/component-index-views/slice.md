# Background preparation and the review browser per component

## Outcome

Background preparation, the review browser's index status and rebuild, and its code places work per component.

## Changes

- change `src/server/repository-intelligence/background-preparation.mts`: `startBackgroundPreparation` and `startIndexRebuild` take an optional `runtime`, and in a repository with components prepare only the components that clauses 26 and 27 name, nothing for an invalid declaration, and the rebuild retries a component that reached a native limit (§25, §26, §27)
- change `src/server/repository-intelligence/index-status.mts`: `readIndexingStatus` combines every component's pointer and progress records into one state with `components` and the running component in `progress`, and `readPublishedUnits` merges every component's latest units sidecar (§28, §29)
- change `src/server/review/review-server.mjs`: `indexingStatus` starts the rebuild of clause 27 when a component's index is stale (§27)
- change `src/server/review/public/views/indexing.js`: the index panel names the component of the running build (§28)
- change `dist/server/repository-intelligence/background-preparation.mjs`, `dist/server/repository-intelligence/index-status.mjs`, `dist/server/review/review-server.mjs`, `dist/server/review/public/views/indexing.js`: the generated runtime of the changed sources
- change `docs/user-guide/review-browser.md`: `Index status` describes the combined state, the running component, and that code places come from the components with an index (§28, §29)
- change `docs/user-guide/repository-intelligence.md`: `Watch an index build in the review browser` explains background preparation and the rebuild per component (§26, §27, §28)
