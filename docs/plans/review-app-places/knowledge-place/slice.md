# The Knowledge place and its search

Knowledge shows search and entry points instead of lists, finds records of every kind, and lists diagrams by name.

## Changes

- change `src/server/review/workspace-model.mjs`, `dist/server/review/workspace-model.mjs`: `loadDiagrams` lists every diagram by name and owner, `searchRecords` matches every word typed, and `parseEntityRef` reads the Knowledge refs (§49, §51, §53)
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: `GET /api/records/search` answers the grouped matches (§53)
- change `src/server/review/public/review.js`, `dist/server/review/public/review.js`: `renderKnowledgePlace` shows the search field, Start from, and Browse by kind, and replaces them with grouped results while the field holds two or more characters (§49, §50, §52)
- change `src/server/review/public/views/library.js`, `dist/server/review/public/views/library.js`: `renderDiagrams` lists the diagrams page (§51)
- change `docs/user-guide/review-browser.md`: the Knowledge place, its search, and the diagrams page are described (§49, §51, §52)
