# Kit controls, catalog, and Appearance menu

## Changes
- add `src/server/review/public/kit/elements/prism-button.js`, `src/server/review/public/kit/elements/prism-button.css`: shadow-DOM button with variants, sizes, pressed, and label (clauses 29, 24).
- add `src/server/review/public/kit/elements/prism-icon.js`, `src/server/review/public/kit/elements/prism-icon.css`: the icon set in the current text color, with the back, forward, menu, panel, link, and agent glyphs (clause 30).
- add `src/server/review/public/kit/elements/prism-chip.js`, `src/server/review/public/kit/elements/prism-chip.css`, `src/server/review/public/kit/elements/prism-badge.js`, `src/server/review/public/kit/elements/prism-badge.css`: static, link, and button chips and badges with tones (clauses 31, 32).
- add `src/server/review/public/kit/elements/prism-tabs.js`, `src/server/review/public/kit/elements/prism-tab.js`, `src/server/review/public/kit/elements/prism-tab.css`: sub-tabs with roving focus, one selection, and a scrolling strip (clauses 33, 34).
- add `src/server/review/public/kit/elements/prism-menu.js`, `src/server/review/public/kit/elements/prism-menu-group.js`, `src/server/review/public/kit/elements/prism-menu-item.js`, `src/server/review/public/kit/elements/prism-menu-item.css`: glass menu anchored to its button with keyboard, choice, and placement (clauses 35, 36, 56).
- add `src/server/review/public/kit/elements/prism-tooltip.js`, `src/server/review/public/kit/elements/prism-tooltip.css`, `src/server/review/public/kit/shorten.js`: the glass document tooltip and the shared shortening observer that sets `shortened` and the Tab stop (clauses 37, 38, 56).
- add `src/server/review/public/kit/elements/prism-field.js`, `src/server/review/public/kit/elements/prism-option.js`, `src/server/review/public/kit/elements/prism-choice.js`, `src/server/review/public/kit/elements/prism-choice-option.js`: light-DOM fields and radio groups that create native controls, with `data-indicator` on a drawn radio (clauses 22, 39, 40).
- change `src/server/review/public/kit/kit.js`: registers the controls, adopts each shadow stylesheet once with a linked-sheet fallback, and adds the tooltip (clauses 27, 28).
- change `src/server/review/public/kit/kit.css`: light-DOM control styles, field boundaries on glass, and space reserved for undefined elements (clauses 20, 21, 22, 23, 24).
- add `src/server/review/public/kit/catalog.html`, `src/server/review/public/kit/catalog.js`, `src/server/review/public/kit/catalog.css`: the catalog with the design values entry, one entry per registered element, and its toolbar (clauses 57, 58, 59).
- change `src/server/review/public/review.html`, `src/server/review/public/review.js`: the Appearance button and menu at the end of the status bar (clauses 25, 26).
- add `scripts/review-demo/layout-audit.mjs`: `checkCatalog` and the page audit shared with the layout check (clause 60).
- change `scripts/review-demo/layout-check.mjs`: checks the catalog at each viewport and theme, takes `--catalog <url>`, and prints catalog problems (clause 61).
- change `dist/server/review/public/kit`, `dist/server/review/public/review.html`, `dist/server/review/public/review.js`: regenerated output.
- change `CONTRIBUTING.md`: the catalog's address and how to add a kit element and its catalog entry.
