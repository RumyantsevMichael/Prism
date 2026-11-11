# Supervise launched sessions

## Outcome

Prism starts, supervises, and resumes a headless Claude Code or Codex session for an initiative from a module call, and reads its state, reason, exit status, and terminal command from the host's stream and exit, keeping the host session id on this machine.

## Changes

- add `src/server/session/launch-hosts.mjs`: the two host definitions, `hostAvailability` with PATH lookup and Windows npm shim reading, the Claude Code arguments and its stream-json prompt line, the Codex app-server requests of a launch and a resume with the fixed policy, the environment with host session variables removed and `PRISM_LAUNCH` set, and the readers that turn Claude Code events and Codex notifications and answers into the host session id, the run's turn, background tasks, refusals, host errors, and the end of the turn (§1-§4, §6, §11-§13)
- add `src/server/session/launch-records.mjs`: launch ids, the private `launches` folder and each launch folder, the launch record with its runs and heartbeat written atomically by its supervisor, store matching, the 14-day removal, and the launch view with clause 15's states other than `waiting`, a reported host error before an exit code (§7, §10, §14-§16)
- add `src/server/session/launch-supervisor.mjs`: the detached supervisor entry that starts one run's host with its standard input held, writes the Claude Code prompt or drives the Codex app-server through `initialize`, the thread start or resume, and `turn/start`, answers every Codex request with clause 3's error, closes the input once the turn and the host's reported background tasks are over, reads the output, renews the heartbeat, and records the run's end; it names its launch folder on its command line (§2, §3, §8, §11-§13)
- add `src/server/session/launched-sessions.mjs`: `hostAvailability`, `startLaunch`, `listLaunches`, and `resumeLaunch`, starting each run under a detached supervisor and refusing a second running session of an initiative (§1, §7-§10, §14, §17)
- add `dist/server/session/launch-hosts.mjs`, `dist/server/session/launch-records.mjs`, `dist/server/session/launch-supervisor.mjs`, `dist/server/session/launched-sessions.mjs`: the generated copies of the new modules
- change `test/server/launch-hosts.test.mjs`, `test/server/launch-supervisor-review.test.mjs`: the slice's own tests follow the stream-json and app-server forms and the revised stub hosts (§2, §3, §12, §13)
