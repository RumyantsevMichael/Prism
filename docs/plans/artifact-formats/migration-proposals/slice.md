# Migration proposals

## Changes

- add `src/server/workflow/statements.mjs`: `splitStatements` and `normalizeStatement`, the statements of a Markdown or Gherkin text with their lines (§29).
- add `src/server/workflow/migrations.mjs`: `proposeMigration`, `getMigration`, `answerMigration`, and `applyMigration`, with statement accounting, invention, decision, conflict, pending, and staleness checks, the diffs, and the migration records (§28, §30–§37, §39, §41).
- change `src/server/workflow/record-store.mjs`: the record key for migrations, synced like the other workspace records (§36).
- change `src/server/workflow/actions.mjs`: the target `migration:<id>` and the action `migration.answer` with its decision, conflict, removal, and note fields (§39).
- change `src/server/workflow/gate-wait.mjs`, `src/hooks/wait-for-gate-answers.mjs`: waiting on a migration's answer, in the background and after the turn (§40).
- change `src/server/workflow/artifact-check.mjs`: a `migration <id>` source is decided when that migration was applied (§8, §41).
- change `src/server/mcp.mjs`: the `propose_migration`, `get_migration`, and `apply_migration` tools, and `migration` on `wait_for_user_gate` (§28, §37, §40, §41).
- change `docs/user-guide/workflow.md`: how a migration is proposed, answered, and applied (§28–§41).
