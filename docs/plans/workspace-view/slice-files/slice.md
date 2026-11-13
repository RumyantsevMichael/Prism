# A slice's files after verification

## Changes
- add `src/server/review/slice-files.mjs`, `dist/server/review/slice-files.mjs`: `sliceFiles`, the latest passing run's files at the verified or ship commit from the code clone, each file's state, and the message when neither commit is there or code content is off (§54-§56).
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: `/api/slice-files`, and `presence` on a slice entity from its runs and claim (§54-§57).
- change `src/server/review/workspace-model.mjs`, `dist/server/review/workspace-model.mjs`: `presence` from the latest run whose commit no branch holds or whose checkout was dirty, and from the live implementation claim (§57).
- change `src/server/review/code-clones.mjs`, `dist/server/review/code-clones.mjs`: `reachable`, whether a commit is on a branch of the clone, and file reads by commit only for such commits (§54, §57).
- change `src/server/review/public/views/entities.js`, `dist/server/review/public/views/entities.js`, `src/server/review/public/styles/workflow-views.css`, `dist/server/review/public/styles/workflow-views.css`: the slice page's files with their states and the presence lines, built from kit elements (§54-§57).
- change `docs/user-guide/review-browser.md`: a slice's files, "same as verified" and "changed after verification", and presence (§54-§57).
