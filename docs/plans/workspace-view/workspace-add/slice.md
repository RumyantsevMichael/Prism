# Add a workspace from its store URL

## Changes
- add `src/server/review/added-workspaces.mjs`, `dist/server/review/added-workspaces.mjs`: `addWorkspace`, the credential check, the clone into the managed folder without a terminal prompt, the empty-store confirmation, the root-commit match of an SSH alias, and the list of added workspaces in the app folder; `removeWorkspace`, which deletes the clone only when no checkout on this machine names the store and nothing is unpushed (§14-§21).
- change `src/server/workflow/record-store-remote.mjs`, `dist/server/workflow/record-store-remote.mjs`: a clone entry point for a store URL without a checkout, reporting `clone_failed`, `clone_folder_taken`, and `store_empty` with Git's reason without credentials (§16-§18).
- change `src/server/workflow/remote-url.mjs`, `dist/server/workflow/remote-url.mjs`: `credentialsIn`, which finds user information in an HTTP URL and a password in SSH user information (§15).
- change `src/server/review/review-app-server.mjs`, `dist/server/review/review-app-server.mjs`: `POST /api/workspaces` and `DELETE /api/workspaces/<w>` with the write session and origin checks, and added workspaces that the recent-use limit never drops (§14, §20, §21).
- change `src/server/review/workspaces.mjs`, `dist/server/review/workspaces.mjs`: added workspaces join the listing with `added` and their URLs (§14, §19, §20).
- change `src/server/review/public/review.js`, `dist/server/review/public/review.js`, `src/server/review/public/styles/shell.css`, `dist/server/review/public/styles/shell.css`: the Add workspace and Remove workspace forms with the empty-store confirmation, built from kit elements (§14, §18, §21).
- change `docs/user-guide/review-browser.md`: adding a workspace from its store URL, which URLs are refused, and what removing keeps (§14-§21).
