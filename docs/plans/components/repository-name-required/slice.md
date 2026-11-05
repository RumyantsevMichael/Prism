# Refuse a checkout that names a store but no repository

## Outcome

A checkout that names a store but no repository is refused, while a checkout without a store works as before.

## Changes

- change `src/server/workflow/repository-names.mjs`: `checkName` refuses a checkout without a name with `repository_name_missing` and the proposed name, and `REPOSITORY_REFUSALS` lists it (§32)
- change `src/server/workflow/record-store.mjs`: `checkedRepository` no longer collects unnamed checkouts, and `collectUnnamedCheckouts` goes (§32, §33)
- change `src/server/mcp.mjs`: the unnamed checkout warning goes from tool results (§32)
- change `dist/server/workflow/repository-names.mjs`, `dist/server/workflow/record-store.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `test/server/fixtures/repository-checkouts.mjs`, `test/server/repository-names.test.mjs`, `test/server/repository-names-review.test.mjs`, `test/server/repository-names-correctness-review.test.mjs`, `test/server/machine-checkouts.test.mjs`: tests of unnamed checkouts expect the refusal, and fixtures name the repository where a test needs a working store (§32)
- change `test/server/external-record-store.test.mjs`, `test/server/record-store-sync.test.mjs`, `test/server/remote-record-store.test.mjs`, `test/server/slice-claims.test.mjs`, `test/server/code-links.test.mjs`, `test/server/prism-call-target.test.mjs`, `scripts/host-smoke.mjs`: configurations that name a store also name the repository (§32)
- change `docs/user-guide/workflow.md`, `docs/user-guide/shared-records.md`: a store needs a `Repository` line, and a checkout without one is refused with the line to add (§32, §33)
