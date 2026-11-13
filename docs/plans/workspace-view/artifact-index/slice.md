# Agents read every scope

## Changes
- add `src/server/workflow/artifact-index.mjs`, `dist/server/workflow/artifact-index.mjs`: `artifactIndex`, the entries of every scope folder with location, kind, version, and bytes, refreshed at each store sync, each artifact write, and after 60 seconds, reading only changed files (§26, §33).
- change `src/server/workflow/store-artifacts.mjs`, `dist/server/workflow/store-artifacts.mjs`: listings of every scope from the index with `location`, `indexedAt`, and paths through the reading checkout's configured folders, the `label` and `location` inputs, `scope_unknown`, `artifact_ambiguous` across every scope, and `scope_not_writable` for changes outside the writer's own scopes, with the tool descriptions saying so (§26-§33).
- change `src/server/workflow/record-store.mjs`, `dist/server/workflow/record-store.mjs`: `seenScopes` lists every repository and component scope folder of the store beside the checkout's own (§26).
- change `src/server/workflow/record-store-sync.mjs`, `dist/server/workflow/record-store-sync.mjs`: a sync that changed artifacts refreshes the index (§33).
- change `skills/workflow/SKILL.md`: agents read every scope and name another one by its label (§28, §30).
