# Workspace search and checkout actions

## Changes
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: a workspace's `/api/search` over every scope's artifacts from the index and over ready component indexes of this machine's checkouts, with `leftOut` (§58, §59).
- change `src/server/review/workspaces.mjs`, `dist/server/review/workspaces.mjs`: `knownComponents`, from this machine's checkouts, code clones, and component scope folders, with each repository's root component (§59).
- change `src/server/workflow/actions.mjs`, `dist/server/workflow/actions.mjs`: index targets of a workspace only for repositories with a checkout on this machine (§60).
- change `src/server/review/public/views/palette.js`, `dist/server/review/public/views/palette.js`, `src/server/review/public/views/library.js`, `dist/server/review/public/views/library.js`: search results by scope and the left-out components, built from kit elements (§58).
- change `docs/user-guide/review-browser.md`: what Knowledge search covers and leaves out, and where an index rebuild is offered (§58-§60).
