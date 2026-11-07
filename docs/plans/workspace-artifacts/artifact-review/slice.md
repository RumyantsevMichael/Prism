# Review artifacts in the browser

## Changes
- add `src/server/workflow/artifact-comments.mjs`, `dist/server/workflow/artifact-comments.mjs`: `addComment` and `listComments`, one file per comment under `artifact-comments/<location>/`, read oldest first (§40, §42).
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: `/api/artifact` adds `artifact` with scope, version, accepted version, `changed`, and comments, and `POST /api/artifact/comments` checks origin, content type, artifact, text, and author (§39-§41).
- add `src/server/review/public/views/artifact-review.js`, `dist/server/review/public/views/artifact-review.js`: the scope label, the diff against the accepted version through `diffHtml`, and the comment list and form (§39, §42).
- change `src/server/review/public/views/preview.js`, `dist/server/review/public/views/preview.js`, `src/server/review/public/review.css`, `dist/server/review/public/review.css`: an artifact page shows the review view above its content (§39).
- change `src/server/workflow/store-artifacts.mjs`, `dist/server/workflow/store-artifacts.mjs`: `get_artifact` returns `comments` (§42).
