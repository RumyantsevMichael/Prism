# Shell on the kit

## Changes
- change `src/server/review/public/review.html`: the top bar, sidebar, status bar, side panel, evidence drawer, palette, banners, store dialog, and toast are kit elements, and the page loads `styles/shell.css` (§59, §60, §62).
- change `src/server/review/public/review.js`: tabs, trees, menus, dialogs, and banners through kit events, and `aria-busy` on `#artifact` while a view loads (§59, §60, §61).
- change `src/server/review/public/views/side-panel.js`, `src/server/review/public/views/palette.js`, `src/server/review/public/views/connection.js`, `src/server/review/public/views/record-store.js`, `src/server/review/public/views/indexing.js`, `src/server/review/public/views/missing-tab.js`, `src/server/review/public/views/attention-signal.js`, `src/server/review/public/views/entities.js`, `src/server/review/public/views/registry.js`: render kit elements and tips instead of their own controls and titles (§60, §61, §62).
- add `src/server/review/public/styles/shell.css`: the shell's layout from tokens (§62).
- change `src/server/review/public/review.css`: the shell's rules move to the kit and `styles/shell.css` (§62).
- change `scripts/review-demo/layout-check.mjs`: waits for `aria-busy="false"` and opens overlays through kit roles (§54, §59).
- change `test/server/review-server.test.mjs`: the page markup it reads follows the kit's top bar.
- change `dist/server/review/public`: regenerated output.
