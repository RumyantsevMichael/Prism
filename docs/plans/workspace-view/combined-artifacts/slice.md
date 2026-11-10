# Every scope in the app

## Changes
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: a workspace's `/api/index` lists every scope's artifacts as `store:<location>` with `artifactScopes`, `scopes`, the `scopes` filter, and `notes`, `/api/artifact?ref=` reads them with `links` and `unresolvedLinks`, and a store-only workspace serves both from its clone (§34-§37, §39).
- add `src/server/review/artifact-links.mjs`, `dist/server/review/artifact-links.mjs`: `resolveLinks`, against the store location and then through checkout paths, of the same scope or else the workspace scope (§37).
- change `src/server/workflow/actions.mjs`, `dist/server/workflow/actions.mjs`: the `artifact:<label>:<location below the scope folder>` target of a workspace page, with its author from the store clone's Git identity (§40).
- change `src/server/review/public/views/library.js`, `dist/server/review/public/views/library.js`, `src/server/review/public/views/preview.js`, `dist/server/review/public/views/preview.js`, `src/server/review/public/views/artifact-review.js`, `dist/server/review/public/views/artifact-review.js`, `src/server/review/public/views/markdown.js`, `dist/server/review/public/views/markdown.js`, `src/server/review/public/styles/record-views.css`, `dist/server/review/public/styles/record-views.css`: scope labels, the scope filter kept in the URL, links to store identities, and unresolved links, built from kit elements (§35, §38).
- change `docs/user-guide/review-browser.md`: every scope in one view, the scope filter, and unresolved links (§34-§40).
