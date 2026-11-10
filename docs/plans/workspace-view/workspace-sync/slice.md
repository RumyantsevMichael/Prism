# Keep an open workspace in sync

## Changes
- add `src/server/review/workspace-sync.mjs`, `dist/server/review/workspace-sync.mjs`: `watchWorkspace`, the fetch timer that a connected page starts and the last page's disconnect stops, the doubling wait after a failure, and the sync state with its times and Git's reason without credentials (§22-§24).
- change `src/server/review/review-app-server.mjs`, `dist/server/review/review-app-server.mjs`: `workspaceFetchMs` and `workspaceFetchMaxMs`, and each workspace review's events stream driving its watch (§22).
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: `/api/index` holds `sync`, and a workspace without a registered checkout applies actions to its store clone, whose record writes schedule the store sync (§24, §25).
- change `src/server/workflow/record-store.mjs`, `dist/server/workflow/record-store.mjs`: a record store opened from a managed clone without a checkout, with sync on (§25).
- change `src/server/review/public/review.js`, `dist/server/review/public/review.js`: the status bar shows when the workspace last synced and why it is unreachable, built from kit elements (§24).
- change `docs/user-guide/review-browser.md`: how an open workspace syncs and what an unreachable store shows (§22-§25).
