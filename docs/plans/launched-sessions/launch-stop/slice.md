# Stop launched sessions

## Outcome

A stop ends a launched session's host and every process it started, also outside its process group, while the review app and other sessions keep running.

## Changes

- add `src/server/session/process-tree.mjs`: the descendants of a process from the platform's process list, `ps` on POSIX and `Get-CimInstance Win32_Process` through PowerShell on Windows, the polite and forced ends of clause 19, and the exclusion of the review app that `review-app.json` names, its descendants, and launch supervisors (§19)
- change `src/server/session/launch-supervisor.mjs`: the supervisor watches its launch folder for a stop request, lists the host's descendants, ends them after the grace period from `PRISM_LAUNCH_STOP_GRACE_MS`, and records the run's end with the stop (§18, §19)
- change `src/server/session/launched-sessions.mjs`: `stopLaunch` writes the stop request and waits for the stopped view, refusing an unknown launch, one that is not running, and one whose supervisor is gone (§18)
- change `src/server/session/launch-records.mjs`: the stop request and its time in the launch record, read by clause 15's `stopped` state (§15, §18)
- add `dist/server/session/process-tree.mjs`: the generated copy of the new module
- change `dist/server/session/launch-supervisor.mjs`, `dist/server/session/launched-sessions.mjs`, `dist/server/session/launch-records.mjs`: the generated runtime of the changed sources
