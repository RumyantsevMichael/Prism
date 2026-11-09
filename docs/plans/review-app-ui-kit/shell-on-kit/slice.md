# Shell on the kit

## Changes
- change `src/server/review/public/review.html`: the top bar with the mark, project menu, search button, Who's working button, and Navigation button; one sidebar of kit trees; the main island with `#page-bar` and `#artifact`; the side panel island; the status bar; the command palette, drawer, banners, store dialog, and toast as kit elements; no tab strip; and the page loads `styles/shell.css` (clauses 75, 77, 78, 82).
- change `src/server/review/public/review.js`: pages instead of open tabs, opened through the browser history, the page bar's Back, Forward, and breadcrumbs, Alt+arrow keys, the drawer below 1100px, trees, menus, dialogs, and banners through kit events, and `aria-busy` on `#artifact` while a view loads (clauses 74, 75, 76, 77, 81).
- add `src/server/review/public/views/page-bar.js`: the page bar's history buttons, breadcrumb trail of titles, and the page's own actions (clauses 69, 76).
- add `src/server/review/public/views/claim-index.js`: gathers each listed initiative's live and expired claims from the initiative data the server already returns, for the sidebar, the palette, the top bar, and the views (clauses 66, 67).
- add `src/server/review/public/views/presence.js`: the Who's working button with up to three breathing avatars and its popover listing live and then expired claims (clauses 67, 68).
- change `src/server/review/public/views/palette.js`: the command palette as a glass dialog with kinded results, slice holders, the Files group marked `data-code-subject`, and a preview pane above 720px (clauses 69, 78).
- change `src/server/review/public/views/side-panel.js`, `src/server/review/public/views/connection.js`, `src/server/review/public/views/record-store.js`, `src/server/review/public/views/indexing.js`, `src/server/review/public/views/missing-tab.js`, `src/server/review/public/views/attention-signal.js`: render kit elements and tips instead of their own controls and titles, and name records by title and kind, with the status bar saying `Shared store` instead of a path (clauses 69, 81, 82).
- change `src/server/review/public/views/entities.js`, `src/server/review/public/views/registry.js`: sidebar trees end each claimed slice's item with its claim, and entity titles and kinds replace file names in the shell (clauses 67, 69).
- add `src/server/review/public/styles/shell.css`: the canvas, the island gap, the three widths, and the shell's layout from tokens (clauses 75, 77, 82).
- change `src/server/review/public/review.css`: the shell's rules move to the kit and `styles/shell.css` (clause 82).
- change `scripts/review-demo/layout-check.mjs`: waits for `aria-busy="false"` and opens overlays, the drawer, and Who's working through kit roles (clauses 61, 74).
- change `test/server/review-server.test.mjs`: the page markup it reads follows the kit's top bar.
- change `dist/server/review/public`: regenerated output.
