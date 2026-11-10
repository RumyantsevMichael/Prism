# Supervise launched sessions

## Outcome

Prism starts, supervises, and resumes a headless Claude Code or Codex session for an initiative from a module call, and reads its state, reason, exit status, and terminal command from the host's stream and exit, keeping the host session id on this machine.

## Changes

- add `src/server/session/launch-hosts.mjs`: the two host definitions, `hostAvailability` with PATH lookup and Windows npm shim reading, the launch and resume arguments, the environment with host session variables removed and `PRISM_LAUNCH` set, and the stream readers that turn Claude Code and Codex events into the host session id, refusals, and host errors (§1-§4, §6, §11-§13)
- add `src/server/session/launch-records.mjs`: launch ids, the private `launches` folder and each launch folder, the launch record with its runs and heartbeat written atomically by its supervisor, store matching, the 14-day removal, and the launch view with clause 15's states other than `waiting` (§7, §10, §14-§16)
- add `src/server/session/launch-supervisor.mjs`: the detached supervisor entry that starts one run's host, reads its output, renews the heartbeat, and records the run's end; it names its launch folder on its command line (§8, §11-§13)
- add `src/server/session/launched-sessions.mjs`: `hostAvailability`, `startLaunch`, `listLaunches`, and `resumeLaunch`, starting each run under a detached supervisor and refusing a second running session of an initiative (§1, §7-§10, §14, §17)
- add `dist/server/session/launch-hosts.mjs`, `dist/server/session/launch-records.mjs`, `dist/server/session/launch-supervisor.mjs`, `dist/server/session/launched-sessions.mjs`: the generated copies of the new modules
