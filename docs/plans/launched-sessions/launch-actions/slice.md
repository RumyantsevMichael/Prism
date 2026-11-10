# Launch, stop, and resume from the review app

## Outcome

The review app launches, stops, and resumes sessions as recorded actions behind the native confirmation, lists them for the page, and resumes the session that asked a gate when the person answers it on this machine.

## Changes

- change `src/server/workflow/actions.mjs`: `launch.claude-code` and `launch.codex` on initiative targets, `launch:<launch id>` targets with `launch.stop` and `launch.resume`, the confirmation step before a launch or a person's resume, history entries that name the launch id and never the host session id, and the `launch` field of a `gate.answer` result that records the answer and resumes the session that marked the gate (§21, §22, §24, §31, §32, §34, §35)
- change `src/server/workflow/state.mjs`: an ask from a process whose `PRISM_LAUNCH` names a launch of this machine for the same initiative and store marks the gate in that launch folder after the write succeeds (§20)
- change `src/server/session/launch-records.mjs`: gate marks and recorded answer ids in the launch folder, the `waiting` state, and `answerWaits` with its reason (§15, §20, §23, §26)
- change `src/server/session/launch-supervisor.mjs`: after a run that exits 0, one resume with cause `gate` for each answer recorded during the run whose gate is still pending (§22, §25)
- change `.codex-mcp.json`: `env_vars` lists `PRISM_LAUNCH`, so a launched Codex session's Prism server reads it (§5)
- change `src/server/review/review-server.mjs`: `GET api/launches`, and the status codes of the launch refusals (§32, §33)
- change `dist/server/workflow/actions.mjs`, `dist/server/workflow/state.mjs`, `dist/server/session/launch-records.mjs`, `dist/server/session/launch-supervisor.mjs`, `dist/server/review/review-server.mjs`: the generated runtime of the changed sources
- change `docs/ADRs/workflow-records/launched-sessions.md`: correct the Proposed ADR where the implementation shows it wrong
