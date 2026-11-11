# Stop launched sessions

## Outcome

A stop interrupts a launched session's turn through the host's own interrupt, lets the host exit by itself, and forcibly ends only the host process when it still runs after the grace period.

## Changes

- change `src/server/session/launch-hosts.mjs`: the Claude Code interrupt line with a fresh request id and the Codex `turn/interrupt` request for the run's thread and turn (§19)
- change `src/server/session/launch-supervisor.mjs`: on a stop request that names its run, sends the host's interrupt, or closes the input at once for a Codex run that has not sent `turn/start`, closes the input when the host answers, and when the host still runs after the grace period counted from the request ends the host process alone, with `SIGKILL` on POSIX and `taskkill /PID <pid> /F` without `/T` on Windows (§8, §19)
- change `src/server/session/launched-sessions.mjs`: `stopLaunch` writes the stop request for the running run and waits for the stopped view, refusing an unknown launch, one that is not running, and one whose supervisor is gone (§18)
- change `src/server/session/launch-records.mjs`: the run's stop request and stop time, read by clause 15's `stopped` state with reason `null`, which a run that ended before the request does not take (§15, §18)
- remove `src/server/session/process-tree.mjs`, `dist/server/session/process-tree.mjs`, `test/server/process-tree.test.mjs`: the process listings, containment, tree and marker matching, and exclusions that no clause uses any more (§8, §19)
- change `test/server/launch-stop-review.test.mjs`: the slice's own stop tests follow the interrupt and the revised stub hosts (§15, §18, §19)
- change `dist/server/session/launch-hosts.mjs`, `dist/server/session/launch-supervisor.mjs`, `dist/server/session/launched-sessions.mjs`, `dist/server/session/launch-records.mjs`: the generated runtime of the changed sources
