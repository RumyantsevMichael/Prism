# Record, document, and source views on the kit

## Changes
- change `src/server/review/public/views/change-map.js`, `src/server/review/public/views/review-ledger.js`, `src/server/review/public/views/coordination-state.js`: cards, filters, badges, and disclosures are kit elements (§61, §62).
- change `src/server/review/public/views/evidence.js`, `src/server/review/public/views/graph.js`: the drawer, meters, and zoom tools are kit elements, and graph colors read tokens (§7, §61, §62).
- change `src/server/review/public/views/json-tree.js`, `src/server/review/public/views/json-view.js`: the JSON tree is a kit tree (§61, §62).
- change `src/server/review/public/views/markdown.js`, `src/server/review/public/views/preview.js`, `src/server/review/public/views/line-diff.js`, `src/server/review/public/views/highlight.js`: documents render in `prism-doc`, code and diffs in `prism-code` with syntax and diff tokens, link titles become tips, and previews use kit panels (§7, §49, §58, §61).
- add `src/server/review/public/styles/record-views.css`: the record views' layout from tokens (§62).
- change `src/server/review/public/review.css`, `src/server/review/public/review.html`: the record views' rules move out, and the page loads `styles/record-views.css` (§62).
- change `test/server/review-markdown.test.mjs`: its markup patterns follow `prism-doc` while asserting the same links and anchors.
- change `dist/server/review/public`: regenerated output.
