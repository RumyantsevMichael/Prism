# Apply actions through one registry

## Outcome

The review app lists and applies revision-checked actions from one transport-independent registry, with the seven initiative settings, gate answers, and the index rebuild as its actions, and records each in history.

## Changes

- add `src/server/workflow/actions.mjs`: `listActions`, `applyAction`, the action definitions of the seven settings, `gate.answer`, and `index.rebuild`, target parsing, input checks, and `ActionError`; it imports no HTTP module (§1-§9, §11-§17, §19-§21)
- change `src/server/workflow/state.mjs`: `history` and `personSettings` become managed keys that only a registry write changes, with one locked write that applies a setting or a gate answer and appends its history entry (§14, §16-§18, §20)
- change `src/server/workflow/record-store.mjs`: the project history record kind at `.prism/history.json` beside the roadmap record (§17)
- change `src/server/review/review-server.mjs`: `createProjectReview` routes `api/actions` and `api/actions/apply` onto the registry and removes `api/gates/answer` and `api/indexing/rebuild`, and `startReviewServer` passes `rebuildIndex` through (§2, §10-§13, §15, §21)
- change `src/server/review/workspace-model.mjs`: `answerGate` gives way to the registry, and the entity cache is dropped after an applied action (§15, §20)
- change `src/server/review/public/review.js`, `src/server/review/public/views/indexing.js`: the gate answer form and the rebuild button send `api/actions/apply` with the revision they read (§15)
- change `test/server/review-entities.test.mjs`, `test/server/review-app.test.mjs`, `test/server/index-rebuild.test.mjs`: existing tests answer gates and rebuild through the apply route
- add `dist/server/workflow/actions.mjs`: the generated copy of the new module
- change `dist/server/workflow/state.mjs`, `dist/server/workflow/record-store.mjs`, `dist/server/review/review-server.mjs`, `dist/server/review/workspace-model.mjs`, `dist/server/review/public/review.js`, `dist/server/review/public/views/indexing.js`: the generated runtime of the changed sources
- change `skills/workflow/SKILL.md`: **Common terms** gains `Review app action` and `Action history`, and `User gate record` names the answer as an action
- change `docs/user-guide/review-browser.md`: what each setting changes and when it takes effect, and that every change in the page is recorded (§6, §16, §17)
- change `docs/ADRs/workflow-records/review-app-actions.md`, `docs/ADRs/workflow-records/user-gates-and-browser-answers.md`: correct either Proposed ADR where the implementation shows it wrong
