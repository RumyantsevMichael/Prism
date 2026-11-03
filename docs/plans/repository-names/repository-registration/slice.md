# Register repository names

## Outcome

A named checkout registers its name and remote in its store, a clash is refused with the remotes and a free name, a moved repository keeps its name, and an unnamed checkout keeps working with a warning.

## Changes

- add `src/server/workflow/repository-names.mjs`: the name check that accepts, registers, or refuses a checkout, the remote comparison, the proposed name, the registration file, and `repositoryId`, moved here so the check and record store share it without an import cycle (§1-§13, §15, §16).
- change `src/server/workflow/workflow-config.mjs`: `workspace.repository` beside `workspace.store` (§1).
- change `src/server/workflow/record-store.mjs`: every record operation runs the name check before migration, housekeeping, or record access, re-exports `repositoryId`, queues the unnamed warning for the tool result, and `forgetMigrations` also forgets cached checks (§8, §13, §16, §19, §20).
- change `src/server/workflow/verification.mjs`: `checkoutOf` records the accepted name as `repository` (§18).
- change `src/server/mcp.mjs`: `stateErrorData` passes every `repository_` record store code with `proposed`, and `withRecordNotes` adds the unnamed warning once per result (§13, §17).
- change `src/server/review/workspace-model.mjs`, `src/server/review/review-server.mjs`: a refused checkout hides records as an unavailable store does (§14).
- change `dist/server/workflow/repository-names.mjs`, `dist/server/workflow/workflow-config.mjs`, `dist/server/workflow/record-store.mjs`, `dist/server/workflow/verification.mjs`, `dist/server/mcp.mjs`, `dist/server/review/workspace-model.mjs`, `dist/server/review/review-server.mjs`: regenerated output of the sources above.
- change `docs/user-guide/shared-records.md`, `docs/user-guide/workflow.md`: the `Repository` line, its rules, the warning, and the three refusals.

The code view is [code.puml](code.puml).
