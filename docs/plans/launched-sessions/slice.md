# Launched sessions from the review app

## Outcome

The person starts, watches, stops and continues an initiative's orchestration as a headless Claude Code or Codex session on their own machine, resumed by Prism when they answer its gates.

## Contract

A **launched session** is a headless host session that Prism started on this machine for one initiative because the person asked for it in the review app.
A **run** is one host process of a launched session: the launch is its first run, and each resume adds one.
The **review app folder** is the folder that `PRISM_REVIEW_APP_DIR` names, or Prism's default review app folder without it.
`<base>` is a checkout's review page base, as the initiative settings design defines it, on the shared review app and on a per-project session server alike.
The module functions below are exported from `dist/server/session/launched-sessions.mjs` and `dist/server/session/launch-confirmation.mjs`, take the environment to read as `env`, and reject with an error whose `code` names the refusal and whose `message` is the sentence the clause gives.

### Hosts and the commands Prism runs

1. The hosts are `claude-code`, labelled `Claude Code`, run through the executable `claude`, and `codex`, labelled `Codex`, run through `codex`.
   `hostAvailability({ env })` resolves to one entry per host in that order, `{ host, label, available, executable, reason }`, where `executable` is the absolute path found in `env.PATH` or `null`, and `reason` is `null` while available and otherwise exactly `<label> was not found: no <executable> executable on PATH.`.
2. A Claude Code launch runs `claude` with exactly the arguments `-p`, `/prism:orchestrate <initiative>`, `--session-id`, `<session id>`, `--output-format`, `stream-json`, `--verbose`, `--permission-mode`, `auto`, `--permission-prompts`, `none`, where `<session id>` is a random version 4 UUID that Prism chooses.
   A Claude Code resume runs the same arguments with `--resume` in place of `--session-id`.
3. A Codex launch runs `codex` with exactly `exec`, `--json`, `-c`, `approval_policy="on-request"`, `-c`, `approvals_reviewer="auto_review"`, `-c`, `sandbox_mode="workspace-write"`, `$prism:orchestrate <initiative>`.
   A Codex resume runs `exec`, `resume`, `--json`, the same three `-c` pairs, `<thread id>`, `$prism:orchestrate <initiative>`.
   The Codex session's `<thread id>` is the `thread_id` of the first `thread.started` event on the host's standard output; until one arrives the session has no host session id.
4. Every run starts in the checkout's real path, with an empty standard input, and with the environment of the process that starts it, except that `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, and `CODEX_THREAD_ID` are removed and `PRISM_LAUNCH` is set to the launch id.
   No argument, variable, or folder comes from the review page except the initiative identifier, which matches the initiative slug rule, and the host.
5. `.codex-mcp.json` lists `PRISM_LAUNCH` under `env_vars`, so Codex passes it to Prism's server.
6. On Windows, Prism finds `<executable>.exe` before `<executable>.cmd` on `PATH`, runs an `.exe` directly, and runs a `.cmd` only when it is an npm command shim, by running Node with the script the shim names; any other `.cmd` makes the host unavailable with the reason `Prism cannot run <path> safely: it is not an npm command shim.`.

### Starting and supervising a launch

7. A launch id is `launch-` followed by 16 lowercase hexadecimal characters.
   Each launched session keeps its record in `<review app folder>/launches/<launch id>/`, and the `launches` folder and every launch folder are readable only by the user on POSIX systems.
   The host session id lives only there: no record store, tool result, history entry, review app event, or log that Prism writes elsewhere contains it, except the `resumeCommand` of the launch views that clauses 14, 32, 33, and 35 give this machine's pages.
8. Each launched session runs under one supervisor process that is detached from the process that started it, in a session of its own on POSIX and without a console window on Windows, and whose command line names its launch folder.
   The supervisor starts each run's host, reads its standard output as JSON lines, keeps the launch record, renews a heartbeat in it at least every 10 seconds, and records each run's end with the host's exit code and signal.
   The supervisor and its host keep running when the process that started them, such as the review app, exits, idles out, is replaced by a newer release, or restarts.
9. `startLaunch({ projectRoot, initiative, host, env })` resolves to `{ launch }`, the launch view of clause 14 in state `running`, once the host process has started.
   It rejects without starting anything with `unknown_host` for a host that clause 1 does not name, `unknown_initiative` for an identifier that breaks the slug rule or names no initiative of the checkout's roadmap or initiative records, `host_unavailable` with clause 1's reason, `launch_running` with the message `A launched session of <initiative> is running on this machine.` while a run of a launched session of the same initiative in the same record store runs on this machine, and `launch_failed` with a message that names the operating system's error when the host could not be started.
   It asks for no confirmation; the action path of clause 32 does.
10. Two checkouts share a record store when Prism resolves both to the same store location on this machine; launched sessions count as the same initiative's only within one record store.
11. A line of host output that is not a JSON object, or is longer than 1 MiB, is ignored.
12. A Claude Code run reports refusals through the `permission_denials` of its `result` event: each entry is a refusal of its `tool_name`, whose reason is the text of the `tool_result` block with the same `tool_use_id`, at most 500 characters, or `<tool> was refused.` without one.
    A Codex run reports a refusal for each `item.completed` event whose item has `status` `declined`, with the item's `type` as the tool and `Codex declined: <command>` as the reason, `<command>` being the item's `command` or, without one, its `type`.
13. A run reports a host error when Claude Code's `result` event has `is_error` true, with the event's `result` text, or when Codex sends `turn.failed`, with its `error.message`.

### Launch views and states

14. `listLaunches({ projectRoot, env, now })` resolves to `{ launches }`, the launch view of every launched session on this machine whose checkout shares the record store of `projectRoot`, the most recently launched first.
    It removes the folder of every launched session whose last run ended more than 14 days before `now`, which defaults to the current time.
    A launch view is exactly `{ id, initiative, host, hostLabel, checkout, launchedAt, runningMs, runs, state, reason, exit, resumeCommand, answerWaits }`:
    - `launchedAt` is the ISO time when the first run started, and `runningMs` is the summed duration of every run, the running one counted until now.
    - `runs` is the number of runs.
    - `exit` is `{ code, signal }` of the last ended run, as the host process reported it, or `null` while the first run runs or when the end was not recorded.
    - `resumeCommand` is `null` while a run runs or while the session has no host session id, and otherwise `{ command, cwd }` with `command` `claude --resume <session id>` or `codex resume <thread id>` and `cwd` the checkout.
    - `answerWaits` is clause 26's flag.
15. `state` is the first of these that holds:
    1. `stopped` with reason `null`, when the last run ended after a stop request of clause 18.
    2. While a run's host process runs under a live supervisor, `waiting` when a gate that clause 23 marks for the session is pending without an answer, and `running` otherwise, each with reason `null`.
    3. `failed`, when the supervisor's process is gone, or its heartbeat is older than 60 seconds, without having recorded the run's end, with reason `Prism stopped supervising this session; its host process may still run.` and `exit` `null`.
    4. `failed`, when the last run exited with a code other than 0, with reason `<label> ended with exit code <code>.`, or by a signal, with reason `<label> ended by signal <signal>.`, each followed by a space and the last non-empty line of the host's standard error, at most 300 characters, when there is one.
    5. `failed`, when the last run reported a host error under clause 13, with reason `<label> reported an error: <text>`.
    6. `waiting`, when a gate that clause 23 marks for the session is pending without an answer, with reason `null`.
    7. `blocked`, when the last run reported a refusal under clause 12, with reason `<label> refused <tool>: <reason>` for its first refusal, followed by ` (and <n> more)` when it reported `<n>` more.
    8. `finished`, with reason `null`, or with clause 26's reason while `answerWaits` is true.
16. Clause 15 decides every state from the launch folder, the supervisor's liveness, and the initiative's coordination state as the page's checkout reads it, so a review app that starts later shows the same state.

### Resuming and stopping

17. `resumeLaunch({ id, env, cause })`, with `cause` `person` or `gate`, starts the next run of the same host with clause 2's or clause 3's resume arguments and clause 4's environment, under a supervisor as clause 8 describes, and resolves to the launch view in state `running`.
    It rejects with `unknown_launch` for an id that names no launch folder, `launch_running` with the message `The session is running.` while one of its runs runs, `launch_running` with clause 9's message while another launched session of the same initiative runs, `no_host_session` with the message `The session never reported its host session id, so it cannot be resumed.`, and `host_unavailable` with clause 1's reason.
18. `stopLaunch({ id, env })` asks the session's supervisor to stop through the launch folder, so any process on this machine can ask, and resolves to the launch view in state `stopped` once the run has ended, at most the grace period and 5 seconds later.
    It rejects with `unknown_launch`, with `launch_not_running` and the message `The session is not running.` while no run runs, and with `supervision_lost` and clause 15's reason while the supervisor is gone.
19. To stop, the supervisor lists the host's descendant processes, asks the host to end, on POSIX with `SIGTERM` and on Windows with `taskkill /PID <pid>` without `/F`, and after the grace period, `PRISM_LAUNCH_STOP_GRACE_MS` milliseconds and 10000 without it, forcibly ends, on POSIX with `SIGKILL` and on Windows with `taskkill /PID <pid> /F`, the host and every listed process that still runs and every descendant of theirs that it then finds, whatever its process group or session.
    A host that ends before the grace period is over ends the stop at once.
    The stop never ends the review app process that `review-app.json` in the review app folder names, its descendants, or any launch supervisor.

### Gates of launched sessions

20. When a process whose environment sets `PRISM_LAUNCH` to the id of a launch folder on this machine asks a gate through the coordination state of that launch's initiative, in a checkout that shares that launch's record store, Prism marks the gate as asked by that launched session in the launch folder only; the gate record in the coordination state is unchanged.
21. When the person applies `gate.answer` in a review app on this machine to a gate that a launched session marked, Prism records the answer's history entry id in that launch folder, and the apply result carries `launch`: `{ id, resumed, reason }`.
    For a gate that no launched session marked, `launch` is `null`.
22. In that case, while none of the session's runs runs and no other launched session of the initiative runs, Prism resumes the session with cause `gate`, without asking for a confirmation, and `launch` is `{ id, resumed: true, reason: null }`.
    While one of its runs runs, the running host receives the answer as it does today and `launch` is `{ id, resumed: false, reason: "The session is running and receives the answer there." }`; when that run then ends with exit code 0 while the answered gate is still pending, the supervisor resumes the session once with cause `gate`.
    While another launched session of the initiative runs, nothing starts and `reason` is `Another launched session of <initiative> is running on this machine.`.
    Each recorded answer causes at most one resume.
23. A gate counts as marked for a session while its mark of clause 20 exists and the gate is pending in the coordination state.
24. A resume refused under clause 17 for a gate answer starts nothing and is returned as `{ id, resumed: false, reason }` with the refusal's message.
25. Only clause 22 and the person's resume action start a run for an answered gate; reading a coordination state never does.
26. While none of its runs runs, a launched session's `answerWaits` is true when a gate that it marked is pending with an answer whose history entry id clause 21 did not record in its launch folder, because the answer came through the record store from another machine; its `finished` or `blocked` state then has the reason `An answer given on another machine waits; resume this session here to continue.` and nothing starts.

### Confirmation outside the page and the launch window

27. `confirmLaunch({ initiative, host, checkout, env, platform, now })` resolves to `{ asked, windowEndsAt }` or rejects, deciding in this order:
    1. While the launch window is open, it resolves `{ asked: false, windowEndsAt }` and shows nothing.
    2. While another confirmation dialog of this machine is open, it rejects with `confirmation_pending` and the message `Another launch is waiting for your confirmation.`.
    3. Within 30 seconds after a dialog was declined or went unanswered, it rejects with `confirmation_cooldown` and the message `You declined a launch moments ago; wait a little before launching again.`.
    4. Where clause 29 finds no dialog, it rejects with `confirmation_unavailable` and the message `This computer cannot show a confirmation outside the browser: <what is missing>.`.
    5. Otherwise it shows clause 29's dialog for at most 120 seconds and resolves `{ asked: true, windowEndsAt }` when the person confirms, or rejects with `confirmation_declined` and `You declined the launch.`, or with `confirmation_timeout` and `Nobody answered the confirmation within 2 minutes.`.
    `platform` defaults to the running platform and `now` to the current time.
28. A confirmation opens the launch window, which ends 30 minutes after the confirmation; a launch inside the window neither asks nor extends it, and its end stops no running session.
    The window is kept as `{ confirmedAt, endsAt }` in `<review app folder>/launches/window.json`, so another process on this machine, such as a newer review app, reads the same window.
29. The dialog's text is exactly `Start a <label> session on this computer that runs Prism's orchestrate skill for the initiative <initiative> in <checkout>? Further launches in the next 30 minutes will start without asking.`, passed as one argument or variable, never through a shell, and its default answer is the refusal:
    - On `linux`, `freebsd`, and `openbsd`, Prism needs `DISPLAY` or `WAYLAND_DISPLAY`, then runs `zenity` with `--question`, `--default-cancel`, `--title=Prism`, `--ok-label=Launch`, `--cancel-label=Cancel`, `--timeout=120`, `--text=<text>`, where exit code 0 confirms, 5 is unanswered, and 1 declines unless its standard error says it failed to open the display; without `zenity` it runs `kdialog` with `--title`, `Prism`, `--yes-label`, `Launch`, `--no-label`, `Cancel`, `--warningyesno`, `<text>`, where 0 confirms and 1 declines, and ends it after 120 seconds as unanswered.
    - On `darwin`, Prism runs `osascript` with `-e`, `on run argv`, `-e`, `display dialog (item 1 of argv) with title "Prism" buttons {"Cancel", "Launch"} default button "Cancel" cancel button "Cancel" with icon caution giving up after 120`, `-e`, `end run`, `<text>`, where exit code 0 with `button returned:Launch` and `gave up:false` in its output confirms, `gave up:true` is unanswered, any other button or an error that contains `(-128)` declines, and any other error makes the dialog unavailable with `osascript failed: <its standard error>`.
    - On `win32`, Prism runs `powershell.exe` with `-NoProfile`, `-NonInteractive`, `-Command`, `$r = (New-Object -ComObject WScript.Shell).Popup($env:PRISM_LAUNCH_CONFIRM_TEXT, 120, 'Prism', 4 + 48 + 256); if ($r -eq 6) { exit 10 } elseif ($r -eq 7) { exit 11 } elseif ($r -eq -1) { exit 12 } else { exit 13 }` and the text in `PRISM_LAUNCH_CONFIRM_TEXT`, where exit code 10 confirms, 11 declines, 12 is unanswered, and any other code makes the dialog unavailable.
30. What is missing, in clause 27's message, is `no graphical display (DISPLAY or WAYLAND_DISPLAY) is set for the review app`, `neither zenity nor kdialog is installed`, `zenity could not open the display <DISPLAY>`, `osascript was not found on PATH`, `powershell.exe was not found on PATH`, `osascript failed: <standard error>`, `PowerShell could not show the dialog`, or, for a platform other than `linux`, `darwin`, `win32`, `freebsd`, and `openbsd`, `Prism has no native dialog for <platform>`.

### Launch, stop, and resume as review app actions

31. An initiative target lists `launch.claude-code` and then `launch.codex` after its six setting actions, each `{ id, label: "Launch with <label>", group: "Launched session", target: "initiative:<initiative>", value: null, fields: [], effect, context: null, recommended: null, available, reason, confirm: null, revision: null }` with `effect` `Starts a headless <label> session on this computer that runs the orchestrate skill for this initiative; you confirm it outside the browser unless you confirmed in the last 30 minutes.`.
    A launch action is unavailable with clause 1's reason while its host is unavailable, and with clause 9's `launch_running` message while a launched session of the initiative runs; a slice target lists no launch action.
32. Applying a launch action checks the write session, the target, the action, the revision, availability, and an empty input as for every action, then confirms through clause 27 with the checkout's real path, then starts through clause 9, and only then records the history entry `{ action, target: "initiative:<initiative>", before: null, after: { launch: <launch id>, host } }` in the initiative's coordination state; the result is `{ applied, actions, launch }` with the launch view.
    A refusal at any step starts nothing and records nothing, and answers its `code` and `message` with status 409, except `invalid_input` with 400, `write_forbidden` with 403, and `launch_failed` with 500.
33. `GET <base>/api/launches` answers 200 with `{ launches }`, clause 14's list for the page's checkout, also to a tab without a write session.
34. A target `launch:<launch id>` exists while clause 14 lists that launch for the page's checkout, and a malformed or absent one answers 404 with `unknown_target`.
    It lists `launch.stop` and then `launch.resume`, each with `group` `Launched session`, `target` `launch:<launch id>`, `value` `null`, `fields` `[]`, `context`, `recommended`, and `confirm` `null`, and `revision` `null`:
    - `launch.stop`, labelled `Stop`, with `effect` `Ends the host process and every process it started.`, is available while one of its runs runs, and otherwise unavailable with `The session is not running.`.
    - `launch.resume`, labelled `Resume`, with `effect` `Starts the host session again headless; you confirm it outside the browser unless you confirmed in the last 30 minutes.`, is unavailable with `The session is running.` while one of its runs runs, and otherwise with clause 17's refusals as reasons.
35. Applying `launch.stop` stops through clause 18 and records `{ action: "launch.stop", target: "launch:<launch id>", before: null, after: "stopped" }`; applying `launch.resume` confirms through clause 27, resumes through clause 17 with cause `person`, and records `{ action: "launch.resume", target: "launch:<launch id>", before: null, after: { launch: <launch id>, run: <run number> } }`; both record in the history of the session's initiative and answer `{ applied, actions, launch }`.
36. Nothing else starts, resumes, or stops a launched session: no Prism MCP tool, hook, or command-line command does, and the action routes keep refusing a request without the page's write session.

### The Launched sessions place

37. The review app has the place `launches`, labelled `Launched sessions`, opened by the address `<base>/review?artifact=launches` and listed among the command palette's places with the detail `Headless sessions on this computer`; it attaches to the shell only through that place reference, its own view module, and the palette entry, so a navigation that lists places can add it without other changes.
38. The place shows a heading `Launched sessions` and one row per launch view of `GET <base>/api/launches`, each an element with the attribute `data-launch="<launch id>"` that shows the initiative's title, linking to its initiative page, the host's label, the launch time, the running time in an element with the attribute `data-running-time` that advances every second while the session runs, the state as `Running`, `Waiting for you`, `Blocked`, `Finished`, `Failed`, or `Stopped`, the reason, the exit status, the `resumeCommand` as code with its folder, and the stop and resume actions of its `launch:` target through the review app's generic action controls.
39. Without launches, the place shows `Nothing launched on this computer yet. Launch an initiative from its page.`; while the place is shown, it reads `GET <base>/api/launches` again every 5 seconds and after each action it applies.
40. The initiative page shows the launch actions through its generic action list, with no code specific to them.

## Assumptions

- Probed: Claude Code 2.1.321 in print mode accepts `--session-id <uuid>`, `--permission-mode auto`, and `--permission-prompts none`, reports the chosen id as `session_id` on every stream event, and gives the id to its MCP servers as `CLAUDE_CODE_SESSION_ID`, together with every variable of its own environment such as `PRISM_LAUNCH` (`probes/run-claude.sh` against the scripted Messages API `probes/fake-messages.mjs`, observed `"session_id":"11111111-2222-4333-8444-555555555555"` and the MCP server's environment `{"PRISM_LAUNCH":"launch-probe","CLAUDE_CODE_SESSION_ID":"11111111-…"}`), so clauses 2, 4, and 20 hold for Claude Code.
- Probed: under `--permission-mode auto` an action that the auto-mode classifier does not allow is refused without a prompt: the host returns a `tool_result` with `is_error` true and the reason text, ends the turn, exits 0, and lists the action in `permission_denials` of the `result` event (same probe, a `Bash` call to `touch` outside the project, observed `"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_1",…}]` and the reason `Auto mode could not evaluate this action and is blocking it for safety…`), so clause 12 reads the host's own reason and a refusal never hangs a run.
- Probed: `claude -p … --resume <id>` continues the same session with its earlier messages and keeps the id, and a second `--session-id` with an id in use fails with exit 1 and `Error: Session ID … is already in use.` (observed six messages in the resumed request and the error text), so clause 2's resume needs no other state.
- Probed: a plugin skill runs from a print-mode prompt: `/probeplug:orchestrate demo-init` loaded that skill's body with its argument (observed `PROBE-SKILL-BODY-MARKER for demo-init` in the first request), so `/prism:orchestrate <initiative>` starts the orchestrate skill.
- Probed: Claude Code runs each Bash command in a process group and session of its own (observed `sleep 601` with process group and session 7679 under host 7635), so a process-group signal alone misses them; on `SIGTERM` the host ends them and its MCP servers itself and exits 143, while after `SIGKILL` the command survives (`probes/tree-probe.mjs`), so clause 19 lists descendants first and kills each.
- Probed: in print mode a Bash command run in the background keeps the host process alive after the `result` event until it ends (observed the run hold until the probe's timeout), so a gate wait that Claude Code moved to the background keeps the run alive, and clause 15 shows it `waiting` rather than ended.
- Probed: Codex 0.167.0 `exec --json` names its thread in the first `thread.started` event, the thread id is the session id of `codex exec resume`, and `--approve-for-me` sets `approval_policy` `on-request`, `approvals_reviewer` `auto_review`, and the `workspace-write` sandbox (`probes/run-codex.sh` against `probes/fake-responses.mjs`, observed the rollout's `turn_context`), while `codex exec resume` without options falls back to `approval_policy` `never` and a `read-only` sandbox and with clause 3's three `-c` pairs records the same policy as the launch, so clause 3 passes the pairs on both and never relies on the resumed session keeping its policy.
- Probed: a Codex action that its automatic review refuses ends as `item.completed` of type `command_execution` with `status` `declined`, its reason going only to the model, and the turn completes and the process exits 0 (observed for `touch /etc/prism-probe-outside` with escalation), so clause 12's Codex reason is the declined command.
- Probed: Codex passes a variable to an MCP server only when the server lists it under `env_vars` (observed `PRISM_LAUNCH` present with `env_vars = ["PRISM_LAUNCH"]` and `null` without), so clause 5 is needed for clause 20.
- Probed: Codex runs commands under its sandbox in sessions of their own, and on `SIGTERM` to the `codex` process the sandbox and its command end (`probes/codex-tree.mjs`, observed `sleep 601` gone after the signal).
- Probed: a Codex prompt `$prism:orchestrate demo` attaches the installed Prism plugin's orchestrate skill to the request (observed `<skill><name>prism:orchestrate</name>…` with the skill's text in the request), so clause 3's prompt starts the skill.
- Probed: the review app that a launched session's Prism server starts runs in a session of its own and outlives the host, while it is a descendant of the host until the server ends (observed the review app with its own session and parent 1 after the Codex run ended), so clause 19 excludes the process that `review-app.json` names.
- Probed: on Linux, zenity 4.0.1 under Xvfb exits 0 for Launch, 1 for Cancel and Escape, 5 on its timeout, and 143 when killed; with `--default-cancel` the Enter key cancels; without a reachable display it also exits 1 but writes `Failed to open display` to standard error (`probes/native-confirm.sh`), so clause 29 tells the missing display from a refusal by that text and checks `DISPLAY` and `WAYLAND_DISPLAY` first.
- Probed: this Linux container has no graphical display and no dialog program until one is installed, so a machine like it refuses every launch under clause 27's fourth step, which is the observable fallback that requirement §8 asks for.
- Unprobed: kdialog's `--warningyesno` makes No its default answer and exits 0 for Yes and 1 for No; where it differs, a dialog Prism cannot read ends as unanswered after 120 seconds and starts nothing.
- Unprobed: on macOS, `osascript` started by a detached review app can show `display dialog` and answers as clause 29 says; where macOS refuses, the error makes the dialog unavailable with osascript's own message, so a launch is refused with that reason rather than confirmed.
- Unprobed: on Windows, `WScript.Shell.Popup` from a hidden PowerShell started by the detached review app shows a dialog on the person's desktop and returns 6, 7, or -1 as documented; any other result makes the dialog unavailable, so nothing starts.
- Unprobed: on Windows, `taskkill` ends the host's descendants as clause 19 says and npm writes Codex's `.cmd` shim in the form clause 6 reads; a shim Prism cannot read leaves the host unavailable with the reason, and a stop that leaves a process running is a defect to report against requirement §11.
- Unprobed: a process with the same operating-system user, such as an agent that drives the desktop, can answer the native dialog or write the launch window file; the product owner accepted this limit for every same-user process in the review app actions decision, and the dialog only keeps browser-side credentials from starting a launch.

## Slices

| Slug | Outcome | Component | Requirements | Depends on | Frozen tests | Review |
| --- | --- | --- | --- | --- | --- | --- |
| `launch-supervisor` | Prism starts, supervises, and resumes a headless Claude Code or Codex session for an initiative from a module call, and reads its state, reason, exit status, and terminal command from the host's stream and exit, keeping the host session id on this machine. | `prism/prism` | `launched-sessions.md§1`, `§2`, `§3`, `§4`, `§10`, `§14`, `§15`, `§16`, `§17`, `§18`, `§19` | | `test/server/fixtures/launched-sessions.mjs`, `test/server/launched-sessions.test.mjs` | required: spawns host processes with an environment and arguments that only fixed values and a checked identifier may reach |
| `launch-stop` | A stop ends a launched session's host and every process it started, also outside its process group, while the review app and other sessions keep running. | `prism/prism` | `launched-sessions.md§11` | `launch-supervisor` | `test/server/launch-stop.test.mjs` | required: kills processes, where a wrong process list ends the person's other work |
| `launch-confirmation` | A launch needs a confirmation in a native dialog of the operating system, which opens a 30-minute launch window, and is refused where no native dialog exists. | `prism/prism` | `launched-sessions.md§5`, `§6`, `§7`, `§8` | | `test/server/launch-confirmation.test.mjs` | required: the only consent outside the page that keeps a page credential from starting a session |
| `launch-actions` | The review app launches, stops, and resumes sessions as recorded actions behind the native confirmation, lists them for the page, and resumes the session that asked a gate when the person answers it on this machine. | `prism/prism` | `launched-sessions.md§1`, `§2`, `§3`, `§4`, `§9`, `§12`, `§13`, `§19`; `review-app-actions.md§15` | `launch-stop`, `launch-confirmation` | `test/server/launch-actions.test.mjs` | required: the action path that turns a page request into a running process |
| `launches-place` | The person sees every launched session of this computer with its state, running time, reason, and terminal command in the Launched sessions place, and stops or resumes it there. | `prism/prism` | `launched-sessions.md§10`, `§11`, `§14` | `launch-actions` | `test/server/launches-place-browser.test.mjs`, `docs/Features/F-launched-sessions.feature` | none |

The overview is [overview.puml](overview.puml), the decision is [launched-sessions.md](../../ADRs/workflow-records/launched-sessions.md), and the probes are under [probes](probes/).

### Clause coverage

| Clauses | Frozen tests |
| --- | --- |
| 1 | `launched-sessions.test.mjs`, `launch-actions.test.mjs` |
| 2, 3, 4, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17 | `launched-sessions.test.mjs` |
| 5, 20, 21, 22, 23, 24, 25, 26, 31, 32, 33, 34, 35, 36 | `launch-actions.test.mjs` |
| 18, 19 | `launch-stop.test.mjs`, `launch-actions.test.mjs` |
| 27, 28, 29, 30 | `launch-confirmation.test.mjs`, `launch-actions.test.mjs` |
| 37, 38, 39, 40 | `launches-place-browser.test.mjs`, `F-launched-sessions.feature` |
| 6, 10 | none: Windows shims are unprobed here, and a second checkout of one store is covered only through clause 14's filter |
