# Record, document, source, and diagram views on the kit

> Shipped history: initiative `review-app-ui-kit` shipped on 2026-11-09, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Changes
- change `src/server/review/public/views/change-map.js`, `src/server/review/public/views/review-ledger.js`, `src/server/review/public/views/coordination-state.js`: cards, filters, badges, and disclosures are kit elements, and each record is titled by its kind and slice rather than its file (clauses 69, 81, 82).
- change `src/server/review/public/views/evidence.js`, `src/server/review/public/views/graph.js`: the drawer is a kit dialog, meters and zoom tools are kit elements, and graph colors read tokens (clauses 8, 45, 81, 82).
- change `src/server/review/public/views/json-tree.js`, `src/server/review/public/views/json-view.js`: the JSON tree is a kit tree, and the view names the record by title and kind (clauses 69, 82).
- change `src/server/review/public/views/markdown.js`, `src/server/review/public/views/preview.js`, `src/server/review/public/views/line-diff.js`, `src/server/review/public/views/highlight.js`: documents render in `prism-doc`, code and diffs in `prism-code` with syntax and diff tokens, link titles become tips, previews use kit panels, and source previews mark their path `data-code-subject` (clauses 8, 51, 69, 81).
- add `src/server/review/public/kit/plantuml-defaults.js`: `PLANTUML_RUNTIME` and the frozen `PLANTUML_DEFAULTS` table of the vendored runtime's default colors (clause 63).
- add `src/server/review/public/kit/diagram-theme.js`: `themeDiagram`, the recoloring of default colors to diagram tokens with the ground of each text and the lift of authored text and line colors (clause 64).
- change `src/server/review/public/review.js`: `drawPlantUml` keeps each drawn SVG text, renderers recolor a copy with `themeDiagram` on the paper sheet once drawn and on every theme change, and the diagram card is titled by the diagram's title (clauses 65, 69).
- add `src/server/review/public/styles/record-views.css`: the record views' layout from tokens (clause 82).
- change `src/server/review/public/review.css`, `src/server/review/public/review.html`: the record views' rules move out, and the page loads `styles/record-views.css` (clauses 4, 82).
- change `test/server/review-markdown.test.mjs`: its markup patterns follow `prism-doc` while asserting the same links and anchors.
- change `dist/server/review/public`: regenerated output.
