# Stop launched sessions

## Outcome

A stop ends a launched session's host and every process it started, also outside its process group, while the review app and other sessions keep running.

## Changes

- add `src/server/session/process-tree.mjs`: platform process listings, process-tree and launch-marker matching, job membership, safe exclusions, and polite and forced process ends (§19)
- change `src/server/session/launch-supervisor.mjs`: the supervisor holds Linux runs as a child subreaper or Windows runs in a job object, records whether containment is active, and falls back to process-tree and environment-marker matching where available (§8, §19)
- change `src/server/session/launched-sessions.mjs`: `stopLaunch` writes the stop request and waits for the stopped view, refusing an unknown launch, one that is not running, and one whose supervisor is gone (§18)
- change `src/server/session/launch-records.mjs`: the run's containment status, stop request, and stop time, read by clause 15's `stopped` state (§8, §15, §18)
- add `test/server/launch-stop-containment.test.mjs`: Linux real-process containment tests with shell and sleep, plus Windows and macOS helper tests with stubbed process listings (§8, §15, §19)
- add `dist/server/session/process-tree.mjs`: the generated copy of the new module
- change `dist/server/session/launch-supervisor.mjs`, `dist/server/session/launched-sessions.mjs`, `dist/server/session/launch-records.mjs`: the generated runtime of the changed sources
