# Kit controls, catalog, and Appearance menu

## Changes
- add `src/server/review/public/kit/elements/prism-button.js`, `src/server/review/public/kit/elements/prism-button.css`: shadow-DOM button with variants, pressed, and label (§28).
- add `src/server/review/public/kit/elements/prism-icon.js`, `src/server/review/public/kit/elements/prism-icon.css`: the icon set in the current text color (§29).
- add `src/server/review/public/kit/elements/prism-chip.js`, `src/server/review/public/kit/elements/prism-chip.css`, `src/server/review/public/kit/elements/prism-badge.js`, `src/server/review/public/kit/elements/prism-badge.css`: static, link, and button chips and badges with tones (§30, §31).
- add `src/server/review/public/kit/elements/prism-tabs.js`, `src/server/review/public/kit/elements/prism-tab.js`, `src/server/review/public/kit/elements/prism-tab.css`: tablist with roving focus, selection, closing, and a scrolling strip (§32, §33).
- add `src/server/review/public/kit/elements/prism-menu.js`, `src/server/review/public/kit/elements/prism-menu-group.js`, `src/server/review/public/kit/elements/prism-menu-item.js`, `src/server/review/public/kit/elements/prism-menu-item.css`: menu anchored to its button with keyboard, choice, and placement (§34, §35).
- add `src/server/review/public/kit/elements/prism-tooltip.js`, `src/server/review/public/kit/elements/prism-tooltip.css`, `src/server/review/public/kit/shorten.js`: the document tooltip and the shared shortening observer that sets `shortened` and the Tab stop (§36, §37).
- add `src/server/review/public/kit/elements/prism-field.js`, `src/server/review/public/kit/elements/prism-option.js`, `src/server/review/public/kit/elements/prism-choice.js`, `src/server/review/public/kit/elements/prism-choice-option.js`: light-DOM fields and radio groups that create native controls (§38, §39).
- change `src/server/review/public/kit/kit.js`: registers the controls, adopts each shadow stylesheet once with a linked-sheet fallback, and adds the tooltip (§26, §27).
- change `src/server/review/public/kit/kit.css`: light-DOM control styles and space reserved for undefined elements (§19, §20, §21, §22, §23).
- add `src/server/review/public/kit/catalog.html`, `src/server/review/public/kit/catalog.js`, `src/server/review/public/kit/catalog.css`: the catalog with the design values entry, one entry per registered element, and its toolbar (§50, §51, §52).
- change `src/server/review/public/review.html`, `src/server/review/public/review.js`: the Appearance button and menu at the end of the status bar (§24, §25).
- add `scripts/review-demo/layout-audit.mjs`: `checkCatalog` and the page audit shared with the layout check (§53).
- change `scripts/review-demo/layout-check.mjs`: checks the catalog at each viewport and theme and prints catalog problems (§54).
- change `dist/server/review/public/kit`, `dist/server/review/public/review.html`, `dist/server/review/public/review.js`: regenerated output.
- change `CONTRIBUTING.md`: the catalog's address and how to add a kit element and its catalog entry.
