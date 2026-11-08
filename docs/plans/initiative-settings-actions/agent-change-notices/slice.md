# Agents act on the person's changes

## Outcome

Running agents learn of the person's changes and who made them once per session, from this machine or through store sync, in Prism's tool results and gate waits, keep the person's settings over their own, and apply the review policy at design acceptance.

## Changes

- add `src/hooks/record-call-agent.mjs`: the PreToolUse hook entry that records, per session and `tool_use_id`, the `agent_id` of a Claude Code tool use of a Prism tool, never refusing or delaying it, and removes records older than one day (§49, §52)
- change `hooks/hooks.json`: a PreToolUse entry with a matcher for Prism's own tools runs `record-call-agent.mjs` (§49)
- add `src/server/workflow/call-agent.mjs`: `callAgent`, the agent of a call from the Codex turn metadata or the hook's record, and the coordinator of each initiative per session, kept in Prism's private app directory and moved by a successful `claim` or `set_status` `in-progress` (§49, §52)
- add `src/server/workflow/change-notices.mjs`: `takePersonChanges`, which shows the coordinator the entries its session has not been shown, keeps the shown ids per session and initiative in Prism's private app directory under a lock that every server process of the session honors, and writes each line with control characters escaped (§50-§53)
- change `src/server/mcp.mjs`: a successful call that names an initiative gains `personChanges` and the notice text only for the coordinator, after the call's own claims apply, and a kept setting adds its text block (§49, §50, §51, §54)
- change `src/server/workflow/gate-wait.mjs`, `src/server/workflow/gate-wait-requests.mjs`, `src/hooks/wait-for-gate-answers.mjs`: a coordinator's wait ends with `changed` on an entry absent at its start that no other result of the session showed, taking it in the same step, including one a store sync brought; another agent's wait ends only on answers; a wait that returns answers, whichever agent waited, counts their history entries as shown; a recorded wait keeps whether its agent coordinated, and the Stop hook blocks the stop with the notice (§53)
- change `src/server/workflow/state.mjs`: an agent write keeps each setting that `personSettings` marks and returns `keptSettings` (§54)
- change `src/server/workflow/initiative.mjs`: `claim` and `set_status` results carry `settings`, and `accept_proposal` and `accept_design` set review marks from the `review` setting (§55, §56)
- change `dist/server/mcp.mjs`, `dist/server/workflow/gate-wait.mjs`, `dist/server/workflow/gate-wait-requests.mjs`, `dist/hooks/wait-for-gate-answers.mjs`, `dist/server/workflow/state.mjs`, `dist/server/workflow/initiative.mjs`: the generated runtime of the changed sources
- add `dist/server/workflow/change-notices.mjs`, `dist/server/workflow/call-agent.mjs`, `dist/hooks/record-call-agent.mjs`: the generated copies of the new modules
- change `skills/orchestrate/SKILL.md`: one line in **Settings** to act on `personChanges`, a `changed` wait, and `keptSettings` before the next step, and the review mark rule now applied by Prism, and naming the author when it reports a change (§57)
- change `skills/workflow/SKILL.md`: **Common terms** gains `Person change notice`, shown once per session to the initiative's coordinator, the `Orchestrator` entry says that it is the coordinator from its first claim, and `Review mark` names the `review` setting at acceptance (§49, §50)
- change `docs/user-guide/workflow.md`: the agent that coordinates the initiative sees a change made in the page on its next Prism call, its sub-agents keep the settings they started with, an agent keeps the person's settings, and a change made on another machine reaches agents after the store syncs (§49, §50, §53, §54)
