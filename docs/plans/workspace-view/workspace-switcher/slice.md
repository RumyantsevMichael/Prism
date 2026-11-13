# Workspaces in the switcher

## Changes
- add `src/server/review/workspaces.mjs`, `dist/server/review/workspaces.mjs`: `listWorkspaces`, the workspaces of the registered checkouts and added workspaces by store identity, their ids, names, repositories from the store's registrations, and the checkouts on this machine from the registrations and the machine's checkout list (§4-§7).
- change `src/server/review/review-app-server.mjs`, `dist/server/review/review-app-server.mjs`: `GET /api/workspaces`, the `/w/<w>/` routes served by one review per workspace, the `308` from `/p/<project id>/` with the `artifact` query moved to `store:<location>`, the root redirect or no-workspace page, the root present without `projectRoot`, and the root write-session exchange (§4-§11).
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: a review created for a workspace, whose session tabs keep store identities for store artifacts and whose index names its workspace (§8, §12).
- change `src/server/review/workspace-identity.mjs`, `dist/server/review/workspace-identity.mjs`: the workspace label from the store identity and the roadmap name (§7).
- change `src/server/cli.mjs`, `dist/server/cli.mjs`, `src/server/review/review-server-pool.mjs`, `dist/server/review/review-server-pool.mjs`: `prism review --workspaces` opens the app's root with a write grant (§11).
- change `src/server/review/public/review.js`, `dist/server/review/public/review.js`, `src/server/review/public/review.html`, `dist/server/review/public/review.html`, `src/server/review/public/styles/shell.css`, `dist/server/review/public/styles/shell.css`: the switcher lists workspaces with their repositories and checkouts as information, and the no-workspace state, built from kit elements (§6, §10, §61).
- change `skills/workflow/SKILL.md`: the **Workspace** term (§13).
- change `docs/user-guide/review-browser.md`: the switcher lists workspaces, and old links open their workspace (§4-§12).
