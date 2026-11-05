# Apply actions through one registry

## Outcome

The review app lists and applies revision-checked actions from one transport-independent registry, with the seven initiative settings, gate answers, and each component's index rebuild as its actions, and records each with its author in history.

## Changes

- add `src/server/workflow/actions.mjs`: `listActionTargets`, `listActions`, `applyAction`, the action definitions of the seven settings, `gate.answer`, and `index.rebuild`, target parsing with index targets from the checkout's components, input checks, the author from the serving checkout's Git identity and label, and `ActionError`; it imports no HTTP module (§1-§11, §13-§16, §18-§23, §29-§32)
- add `src/server/workflow/index-history.mjs`: the checkout's index history file in Prism's application folder, written privately under its lock and kept to the newest 200 entries in history order (§21, §23)
- change `src/server/workflow/state.mjs`: `history` and `personSettings` become managed keys that only a registry write changes, history entries are validated and inserted in time and id order, a gate answer may hold `by` and `entry`, and one locked write applies a setting or a gate answer with its history entry (§16, §19, §21, §22, §24, §30)
- change `src/server/review/review-server.mjs`: `createProjectReview` routes `api/actions`, `api/actions/targets`, and `api/actions/apply` onto the registry with an indexer built from `rebuildIndex` and its indexing status, removes `api/gates/answer` and `api/indexing/rebuild`, and `startReviewServer` passes `rebuildIndex(projectRoot, component)` through (§2, §5, §12-§15, §17, §33)
- change `src/server/review/review-app-server.mjs`: each checkout's page passes its own indexer to its project review (§33)
- change `src/server/review/workspace-model.mjs`: `answerGate` gives way to the registry, and the entity cache is dropped after an applied action (§17, §30)
- change `src/server/review/workspace-identity.mjs`: `checkoutLabel`, the `<repository>/<branch> on <host>` label that history entries record, shared with the claim label's host rule (§20)
- change `src/server/review/public/review.js`, `src/server/review/public/views/indexing.js`: the gate answer form and the rebuild control send `api/actions/apply` with the revision they read, the rebuild naming its index target (§17, §31)
- change `test/server/review-entities.test.mjs`, `test/server/review-app.test.mjs`, `test/server/index-rebuild.test.mjs`: existing tests answer gates and rebuild through the apply route
- add `dist/server/workflow/actions.mjs`, `dist/server/workflow/index-history.mjs`: the generated copies of the new modules
- change `dist/server/workflow/state.mjs`, `dist/server/review/review-server.mjs`, `dist/server/review/review-app-server.mjs`, `dist/server/review/workspace-model.mjs`, `dist/server/review/workspace-identity.mjs`, `dist/server/review/public/review.js`, `dist/server/review/public/views/indexing.js`: the generated runtime of the changed sources
- change `skills/workflow/SKILL.md`: **Common terms** gains `Review app action` and `Action history`, naming the author as a claim and the index history as the checkout's own, and `User gate record` names the answer as an action
- change `docs/user-guide/review-browser.md`: what each setting changes and when it takes effect, that every change in the page is recorded with the Git identity and checkout it came from, and that each checkout rebuilds its own components' indexes (§8, §19-§23, §31, §32)
- change `docs/ADRs/workflow-records/review-app-actions.md`, `docs/ADRs/workflow-records/user-gates-and-browser-answers.md`: correct either Proposed ADR where the implementation shows it wrong
