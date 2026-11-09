# Review artifacts in the browser

## Changes
- add `src/server/workflow/artifact-comments.mjs`, `dist/server/workflow/artifact-comments.mjs`: `addComment` and `listComments`, one file per comment under `artifact-comments/<location>/` holding its history entry's id, read oldest first (§40, §42).
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: `/api/artifact` adds `artifact` with scope, version, accepted version, `changed`, and comments, `POST /api/artifact/comments` is removed, and the apply route returns 409 for `author_unknown` (§39-§41).
- change `src/server/workflow/actions.mjs`, `dist/server/workflow/actions.mjs`: the `artifact:<scope label>:<path>` target kind, resolved in the scopes the checkout sees, and its `artifact.comment` action with the `line` and `text` fields, the artifact's version as its revision, the line check, and the `author_unknown` refusal, which stores the comment through `addComment` with its history entry (§40, §41).
- add `src/server/review/public/views/artifact-review.js`, `dist/server/review/public/views/artifact-review.js`: the scope label, the diff against the accepted version through `diffHtml`, and the comment list and a form that applies the `artifact.comment` action with the page's write session (§39-§42).
- change `src/server/review/public/views/preview.js`, `dist/server/review/public/views/preview.js`, `src/server/review/public/review.css`, `dist/server/review/public/review.css`: an artifact page shows the review view above its content (§39).
- change `src/server/workflow/store-artifacts.mjs`, `dist/server/workflow/store-artifacts.mjs`: `get_artifact` returns `comments` (§42).
