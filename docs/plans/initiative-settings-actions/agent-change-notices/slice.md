# Agents act on the person's changes

## Outcome

Running agents learn of the person's changes once per session from Prism's tool results and gate waits, keep the person's settings over their own, and apply the review policy at design acceptance.

## Changes

- add `src/server/workflow/change-notices.mjs`: `takePersonChanges`, which reads an initiative's history, compares it with what this session was shown, kept per session in the private plugin data folder, and formats the notice (§36-§39)
- change `src/server/mcp.mjs`: every successful tool call that names an initiative gains `personChanges` and the notice text, beside the existing record notes (§37, §38)
- change `src/server/workflow/gate-wait.mjs`, `src/server/workflow/gate-wait-requests.mjs`, `src/hooks/wait-for-gate-answers.mjs`: a wait ends with `changed` on a history entry newer than its start, and the Stop hook blocks the stop with the notice (§40)
- change `src/server/workflow/state.mjs`: an agent write keeps each setting that `personSettings` marks and returns `keptSettings` (§41)
- change `src/server/workflow/initiative.mjs`: `claim` and `set_status` results carry `settings`, and `accept_proposal` and `accept_design` set review marks from the `review` setting (§42, §43)
- change `dist/server/mcp.mjs`, `dist/server/workflow/gate-wait.mjs`, `dist/server/workflow/gate-wait-requests.mjs`, `dist/hooks/wait-for-gate-answers.mjs`, `dist/server/workflow/state.mjs`, `dist/server/workflow/initiative.mjs`: the generated runtime of the changed sources
- add `dist/server/workflow/change-notices.mjs`: the generated copy of the new module
- change `skills/orchestrate/SKILL.md`: one line in **Settings** to act on `personChanges`, a `changed` wait, and `keptSettings` before the next step, and the review mark rule now applied by Prism (§44)
- change `skills/workflow/SKILL.md`: **Common terms** gains `Person change notice`, and `Review mark` names the `review` setting at acceptance
- change `docs/user-guide/workflow.md`: when a running agent sees a change made in the page, and that an agent keeps the person's settings (§37, §40, §41)
