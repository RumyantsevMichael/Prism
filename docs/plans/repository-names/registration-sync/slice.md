# Confirm registrations across machines

## Outcome

Two machines that register one name at once end with one registration, and an unreachable remote withdraws the registration.

## Changes

- change `src/server/workflow/record-store-sync.mjs`: registration files count as record files, so a both-sided change keeps the upstream version, and saved registrations stay out of sync status conflicts and saved-conflict notes (§21).
- change `src/server/workflow/repository-names.mjs`: a new registration in a synced store waits for a sync and checks the checkout again, and a failed sync withdraws it with `repository_unconfirmed` (§22-§25).
- change `dist/server/workflow/record-store-sync.mjs`, `dist/server/workflow/repository-names.mjs`: regenerated output of the sources above.
- change `docs/user-guide/shared-records.md`: how a synced store settles two registrations of one name, and `repository_unconfirmed`.

The code view is [code.puml](code.puml).
