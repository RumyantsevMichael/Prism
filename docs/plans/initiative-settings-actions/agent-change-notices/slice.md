# Agents act on the person's changes

## Outcome

Running agents learn of the person's changes and who made them once per session, from this machine or through store sync, in Prism's tool results and gate waits, keep the person's settings over their own, and apply the review policy at design acceptance.

## Changes

- add `src/server/workflow/change-notices.mjs`: `takePersonChanges`, which reads an initiative's history, compares its entry ids with the ids this session was shown, kept per session and initiative in the private plugin data folder, and formats the notice with each author (§49-§52)
- change `src/server/mcp.mjs`: every successful tool call that names an initiative gains `personChanges` and the notice text, beside the existing record notes (§50, §51)
- change `src/server/workflow/gate-wait.mjs`, `src/server/workflow/gate-wait-requests.mjs`, `src/hooks/wait-for-gate-answers.mjs`: a wait ends with `changed` on a history entry whose id was absent at its start, including one a store sync brought, and the Stop hook blocks the stop with the notice (§53)
- change `src/server/workflow/state.mjs`: an agent write keeps each setting that `personSettings` marks and returns `keptSettings` (§54)
- change `src/server/workflow/initiative.mjs`: `claim` and `set_status` results carry `settings`, and `accept_proposal` and `accept_design` set review marks from the `review` setting (§55, §56)
- change `dist/server/mcp.mjs`, `dist/server/workflow/gate-wait.mjs`, `dist/server/workflow/gate-wait-requests.mjs`, `dist/hooks/wait-for-gate-answers.mjs`, `dist/server/workflow/state.mjs`, `dist/server/workflow/initiative.mjs`: the generated runtime of the changed sources
- add `dist/server/workflow/change-notices.mjs`: the generated copy of the new module
- change `skills/orchestrate/SKILL.md`: one line in **Settings** to act on `personChanges`, a `changed` wait, and `keptSettings` before the next step, and the review mark rule now applied by Prism, and naming the author when it reports a change (§57)
- change `skills/workflow/SKILL.md`: **Common terms** gains `Person change notice`, and `Review mark` names the `review` setting at acceptance
- change `docs/user-guide/workflow.md`: when a running agent sees a change made in the page, and that an agent keeps the person's settings, and that a change made on another machine reaches agents after the store syncs (§50, §53, §54)
