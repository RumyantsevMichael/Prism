# Write only from the page Prism opened

> Shipped history: initiative `initiative-settings-actions` shipped on 2026-11-08, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

Only a tab that Prism opened can apply actions, through a one-time grant exchanged for a per-tab write session that no agent-visible surface reveals, on the shared app and the per-project session server.

## Changes

- add `src/server/review/write-sessions.mjs`: `createWriteSessions`, which issues grants, exchanges them for tokens, keeps only token digests, checks the `X-Prism-Write` header, and loads and saves the digests of the shared app (§34-§38)
- change `src/server/review/review-server.mjs`: `createProjectReview` takes the server's write sessions, serves `api/write-session`, refuses apply without a write session, reports `writable`, counts writable viewer streams, and `startReviewServer` opens its browser with a grant in the fragment (§34-§37, §40)
- change `src/server/review/review-app-server.mjs`: one write session store for every checkout's page, `writeGrant` in the `present` answer that opens a browser, digests saved in the private app directory and accepted only after a handoff that reuses the viewer credential, and open decisions that count writable viewers (§35, §36, §38, §40)
- change `src/server/review/review-server-pool.mjs`: the presenting process and `prism review` open the URL with the grant fragment and return the URL without it (§35, §38)
- change `src/server/review/review-app-protocol.schema.json`: the `writeGrant` field of the `present` answer (§35)
- change `src/server/review/public/review.js`: the page exchanges a fragment grant once, keeps the token in session storage, removes the fragment without a history entry, and sends `X-Prism-Write` on apply and `write` on the viewer stream (§36, §40)
- change `test/server/review-entities.test.mjs`, `test/server/review-app.test.mjs`, `test/server/index-rebuild.test.mjs`: existing tests take a write session before they apply, and the opened URL carries a fragment
- add `dist/server/review/write-sessions.mjs`: the generated copy of the new module
- change `dist/server/review/review-server.mjs`, `dist/server/review/review-app-server.mjs`, `dist/server/review/review-server-pool.mjs`, `dist/server/review/review-app-protocol.schema.json`, `dist/server/review/public/review.js`: the generated runtime of the changed sources
- change `skills/workflow/SKILL.md`: **Common terms** gains `Write session`
- change `CONTRIBUTING.md`: the review page's write session, not its URL, is the credential for recording an answer
- change `docs/user-guide/review-browser.md`: which tabs can change things, why a tab opened from a link the agent gave is read-only, and how to get a writable tab (§36, §39)
- change `docs/ADRs/workflow-records/review-app-actions.md`, `docs/ADRs/plantuml-review/shared-review-app.md`: correct the Proposed ADR where the implementation shows it wrong, and add a dated Decision Log entry to the Accepted ADR for the write session that a handoff keeps
